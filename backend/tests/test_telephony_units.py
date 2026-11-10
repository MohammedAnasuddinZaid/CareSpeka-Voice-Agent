"""Unit tests for the telephony support layer.

Covers number handling, the G.711/resampling audio helpers, webhook parsing,
replay/idempotency guard, the provider interface and the deterministic mock.
No socket is opened and no call is placed.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import struct

import numpy as np
import pytest

from app.telephony import numbers, registry, webhooks
from app.telephony.audio import (
    AI_SAMPLE_RATE,
    FRAME_BYTES,
    AudioFormat,
    alaw_to_pcm16,
    b64_decode,
    b64_encode,
    float_to_pcm16,
    iter_frames,
    mulaw_to_ai_pcm16,
    mulaw_to_pcm16,
    pcm16_to_alaw,
    pcm16_to_float,
    pcm16_to_mulaw,
    resample_pcm16,
    tts_pcm16_to_mulaw,
    wav_pcm16,
)
from app.telephony.base import (
    MODE_CONFIGURED_UNVERIFIED,
    MODE_DISABLED,
    MODE_MOCK,
    CallResult,
    MessageResult,
    ProviderCapabilities,
    ProviderEvent,
    ProviderNotConfigured,
    TelephonyProvider,
)
from app.telephony.exotel import ExotelProvider
from app.telephony.mock import MockProvider
from app.telephony.models import ProviderMode
from app.telephony.twilio import TwilioProvider


# ---------------------------------------------------------------------------
# numbers
# ---------------------------------------------------------------------------
def test_region_calling_code():
    assert numbers.region_calling_code("in") == "91"
    assert numbers.region_calling_code("US") == "1"
    assert numbers.region_calling_code("zz") is None
    assert numbers.region_calling_code(None) is None


def test_normalize_accepts_international_and_local():
    assert numbers.normalize("+919876543210") == "+919876543210"
    assert numbers.normalize("09876543210", "IN") == "+919876543210"
    assert numbers.normalize("00919876543210", "IN") == "+919876543210"


def test_normalize_rejections():
    with pytest.raises(numbers.NumberError) as missing:
        numbers.normalize(None)
    assert missing.value.code == "number_missing"

    with pytest.raises(numbers.NumberError):
        numbers.normalize("   ")

    with pytest.raises(numbers.NumberError) as invalid:
        numbers.normalize("not-a-number", "IN")
    assert invalid.value.code == "invalid_number"


def test_try_normalize_and_is_valid():
    assert numbers.try_normalize("+919876543210") == "+919876543210"
    assert numbers.try_normalize("garbage") is None
    assert numbers.is_valid("+919876543210") is True
    assert numbers.is_valid("12345") is False
    assert numbers.is_valid(None) is False


def test_is_emergency_number():
    assert numbers.is_emergency_number("112") is True
    assert numbers.is_emergency_number("911") is True
    assert numbers.is_emergency_number("+91 112") is False
    assert numbers.is_emergency_number("+919876543210") is False
    assert numbers.is_emergency_number(None) is False


def test_mask_keeps_only_the_last_four_digits():
    masked = numbers.mask("+919876543210")
    assert masked.endswith("3210")
    assert "987654" not in masked
    assert numbers.mask("123") == "***"
    assert numbers.mask("") == ""


def test_country_code_and_redact():
    assert numbers.country_code("+919876543210") == "+91"
    assert numbers.country_code("garbage") == ""
    assert numbers.redact_for_log("+919876543210") == numbers.mask("+919876543210")


# ---------------------------------------------------------------------------
# audio codec helpers
# ---------------------------------------------------------------------------
def test_base64_roundtrip():
    payload = b"\x01\x02\x03\x04"
    assert b64_decode(b64_encode(payload)) == payload
    assert b64_decode(base64.b64encode(payload)) == payload


def test_mulaw_and_alaw_roundtrip_lengths():
    pcm = b"\x10\x20\x30\x40" * 40
    assert len(pcm16_to_mulaw(pcm)) == len(pcm) // 2
    assert len(mulaw_to_pcm16(pcm16_to_mulaw(pcm))) == len(pcm)
    assert len(alaw_to_pcm16(pcm16_to_alaw(pcm))) == len(pcm)


def test_float_pcm_roundtrip_is_close():
    samples = np.linspace(-1.0, 1.0, 800, dtype=np.float32)
    back = pcm16_to_float(float_to_pcm16(samples))
    assert back.size == samples.size
    assert np.max(np.abs(back - samples)) < 1e-3


def test_pcm16_to_float_handles_empty_and_odd_length():
    assert pcm16_to_float(b"").size == 0
    # An odd trailing byte is dropped rather than raising.
    assert pcm16_to_float(b"\x00\x00\x00").size == 1


def test_resample_pcm16_same_rate_is_identity():
    pcm = b"\x00\x01" * 160
    assert resample_pcm16(pcm, 8000, 8000) == pcm
    assert resample_pcm16(b"", 8000, 16000) == b""


def test_resample_pcm16_doubles_sample_count():
    pcm = float_to_pcm16(np.zeros(160, dtype=np.float32))
    out = resample_pcm16(pcm, 8000, 16000)
    assert len(out) == len(pcm) * 2


def test_mulaw_to_ai_pcm16_doubles_bytes():
    mulaw = b"\xff" * 160  # 160 samples at 8 kHz
    out = mulaw_to_ai_pcm16(mulaw)
    assert len(out) == 640  # 320 samples at 16 kHz, 16-bit


def test_tts_pcm16_to_mulaw_resamples_to_8k():
    pcm = float_to_pcm16(np.zeros(AI_SAMPLE_RATE, dtype=np.float32))  # 1 s at 16k
    out = tts_pcm16_to_mulaw(pcm, source_rate=AI_SAMPLE_RATE)
    # 1 second at 8 kHz mu-law = 8000 bytes.
    assert abs(len(out) - 8000) <= 2


def test_iter_frames_pads_the_final_short_frame():
    frames = list(iter_frames(b"\x01\x02\x03", frame_bytes=FRAME_BYTES))
    assert len(frames) == 1
    assert len(frames[0]) == FRAME_BYTES
    assert frames[0][:3] == b"\x01\x02\x03"
    assert list(iter_frames(b"")) == []


def _make_wav(samples: np.ndarray, rate: int = 16000) -> bytes:
    pcm = samples.astype("<i2").tobytes()
    return (
        b"RIFF"
        + struct.pack("<I", 36 + len(pcm))
        + b"WAVE"
        + b"fmt "
        + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16)
        + b"data"
        + struct.pack("<I", len(pcm))
        + pcm
    )


def test_wav_pcm16_extracts_rate_and_data():
    samples = np.arange(100, dtype="<i2")
    rate, pcm = 22050, None
    data = _make_wav(samples, rate)
    pcm, parsed_rate = wav_pcm16(data)
    assert parsed_rate == rate
    assert np.frombuffer(pcm, dtype="<i2").tolist() == samples.tolist()


def test_wav_pcm16_rejects_non_wave():
    with pytest.raises(ValueError):
        wav_pcm16(b"not a wav")
    with pytest.raises(ValueError):
        wav_pcm16(b"RIFF\x00\x00\x00\x00WAVE")  # header only, no data chunk


def test_audio_format_decode_encode_shapes():
    fmt = AudioFormat(encoding="mulaw", sample_rate=8000)
    decoded = fmt.decode_to_ai(b"\xff" * 160)
    assert len(decoded) == 640
    encoded = fmt.encode_from_ai(decoded, 16000)
    assert len(encoded) == 160

    pcm_fmt = AudioFormat(encoding="pcm16", sample_rate=8000)
    # pcm16 passthrough must not multiply the payload.
    out = pcm_fmt.decode_to_ai(b"\x00\x01" * 160)
    assert len(out) == 320 * 2


# ---------------------------------------------------------------------------
# webhooks
# ---------------------------------------------------------------------------
def test_parse_body_json_form_and_bad_input():
    assert webhooks.parse_body("application/json", b'{"a": 1}') == {"a": 1}
    assert webhooks.parse_body("application/json", b"not json") == {}
    assert webhooks.parse_body("application/x-www-form-urlencoded", b"a=1&b=2") == {"a": "1", "b": "2"}
    # Content type missing but the body looks form-encoded.
    assert webhooks.parse_body("", b"CallSid=CA1") == {"CallSid": "CA1"}
    # A bare JSON array is wrapped, not dropped.
    assert webhooks.parse_body("", b"[1,2]") == {"_value": [1, 2]}


def test_replay_guard_bounded_and_idempotent():
    guard = webhooks.ReplayGuard(max_entries=2)
    assert guard.seen("a") is False
    assert guard.seen("a") is True
    assert guard.seen("") is False  # empty ids are never recorded
    guard.seen("b")
    guard.seen("c")  # evicts "a"
    assert guard.seen("a") is False


def test_idempotency_key_and_signature():
    assert webhooks.idempotency_key("call", 1, "x") == webhooks.idempotency_key("call", 1, "x")
    assert webhooks.idempotency_key("call", 2, "x") != webhooks.idempotency_key("call", 1, "x")
    secret = "s3cr3t"
    body = b"hello"
    expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    assert webhooks.signature_for(secret, body) == expected


def test_verify_and_extract_event_with_mock():
    provider = MockProvider()
    # No signature header is accepted by the mock.
    assert provider.verify_webhook({}, b"{}", "https://x") is True
    body = b'{"kind":"call.status","provider_call_id":"pc1","state":"answered"}'
    event = webhooks.extract_event(
        provider, {"content-type": "application/json"}, body, "https://x"
    )
    assert isinstance(event, ProviderEvent)
    assert event.kind == "call.status"
    assert event.provider_call_id == "pc1"
    assert event.state == "answered"
    assert event.event_id  # the mock always yields an id


def test_extract_event_derives_id_from_body_when_provider_omits_it():
    provider = MockProvider()
    # A provider that does not mint its own id must get a stable body-hash id so
    # two retries of the same webhook collapse into one event.
    provider.parse_event = lambda payload, kind_hint=None: ProviderEvent(  # type: ignore[assignment]
        event_id="", kind="call.status", provider="mock", provider_call_id="pc1"
    )
    body = b'{"kind":"call.status"}'
    event = webhooks.extract_event(
        provider, {"content-type": "application/json"}, body, "https://x"
    )
    assert event.event_id == hashlib.sha256(body).hexdigest()


def test_verify_rejects_a_wrong_signature():
    provider = MockProvider()
    with pytest.raises(webhooks.WebhookRejected) as exc:
        webhooks.verify(provider, {"x-mock-signature": "nope"}, b"{}", "https://x")
    assert exc.value.code == "invalid_signature"
    assert exc.value.status_code == 401


# ---------------------------------------------------------------------------
# provider interface
# ---------------------------------------------------------------------------
def test_capabilities_to_dict_roundtrip():
    caps = ProviderCapabilities(outbound_calls=True, sms=True).to_dict()
    assert caps["outbound_calls"] is True
    assert caps["whatsapp"] is False
    assert set(caps) == {
        "outbound_calls",
        "inbound_calls",
        "bidirectional_audio",
        "sms",
        "whatsapp",
        "call_control",
        "recording",
        "message_status_callbacks",
    }


def test_unconfigured_real_provider_operating_modes():
    # A real provider without credentials reports disabled.
    assert ExotelProvider().operating_mode() == MODE_DISABLED
    assert TwilioProvider().operating_mode() == MODE_DISABLED
    assert MockProvider().operating_mode() == MODE_MOCK


def test_configured_real_provider_is_unverified_not_live():
    provider = ExotelProvider(
        api_key="k", api_token="t", account_sid="s",
        caller_id="+918000000000", webhook_secret="ws",
    )
    assert provider.is_configured() is True
    # A configured provider that has never completed a verified call is never
    # reported as "live".
    assert provider.operating_mode() == MODE_CONFIGURED_UNVERIFIED


def test_provider_describe_and_health_shapes():
    provider = MockProvider()
    described = provider.describe()
    assert described["provider"] == "mock"
    assert described["media"]["encoding"] == "mulaw"
    assert set(described["capabilities"]) >= {"outbound_calls", "sms"}
    assert asyncio.run(provider.health())["simulated"] is True


def test_provider_not_configured_exposes_missing_list():
    error = ProviderNotConfigured("exotel", ["EXOTEL_API_KEY", "EXOTEL_API_TOKEN"])
    assert error.provider == "exotel"
    assert error.missing == ["EXOTEL_API_KEY", "EXOTEL_API_TOKEN"]
    assert "EXOTEL_API_KEY" in str(error)


def test_provider_interface_is_abstract():
    with pytest.raises(TypeError):
        TelephonyProvider()  # type: ignore[abstract]


def test_call_and_message_result_defaults():
    call = CallResult(ok=True)
    assert call.mode == ProviderMode.REAL.value
    assert call.accepted is False
    message = MessageResult(ok=True, state="sent")
    assert message.state == "sent"


# ---------------------------------------------------------------------------
# registry
# ---------------------------------------------------------------------------
def test_registry_builds_and_caches_providers():
    registry.reset_cache()
    assert isinstance(registry.build_provider("mock"), MockProvider)
    assert isinstance(registry.build_provider("exotel"), ExotelProvider)
    assert isinstance(registry.build_provider("twilio"), TwilioProvider)
    # Unknown names fall back to the mock.
    assert isinstance(registry.build_provider("nonsense"), MockProvider)
    first = registry.get_provider("mock")
    assert registry.get_provider("mock") is first
    registry.reset_cache()
    assert registry.get_provider("mock") is not first


def test_registry_resolve_name_explicit():
    assert registry.resolve_name("mock") == "mock"
    assert registry.resolve_name("exotel") == "exotel"
    assert registry.resolve_name("twilio") == "twilio"


# ---------------------------------------------------------------------------
# mock provider end to end (deterministic)
# ---------------------------------------------------------------------------
def test_mock_provider_call_and_message_lifecycle():
    provider = MockProvider()

    async def scenario():
        call = await provider.start_outbound_call(
            to_number="+919876543210", from_number=None,
            answer_url="a", stream_url="s", status_url="t",
        )
        status = await provider.get_call_status(call.provider_call_id)
        provider.simulate_answer(call.provider_call_id)
        answered = await provider.get_call_status(call.provider_call_id)
        ended = await provider.end_call(call.provider_call_id)
        missing = await provider.get_call_status("does-not-exist")

        message = await provider.send_message(
            to_number="+919876543210", from_number=None, body="hi",
            channel="sms", status_url="t",
        )
        message_status = await provider.get_message_status(message.provider_message_id)
        return call, status, answered, ended, missing, message, message_status

    call, status, answered, ended, missing, message, message_status = asyncio.run(scenario())
    assert call.ok and call.accepted
    assert call.mode == "mock"
    assert call.state == "ringing"
    assert status["state"] == "ringing"
    assert answered["state"] == "answered"
    assert ended["state"] == "completed"
    assert missing["ok"] is False

    assert message.ok and message.accepted
    assert message.mode == "mock"
    assert message.state == "sent"
    assert message_status["state"] == "sent"
    # The mock is explicit about never delivering.
    assert "not delivered" in message.detail.lower()


def test_mock_parse_event_normalises_payload():
    event = MockProvider().parse_event(
        {"kind": "message.status", "provider_message_id": "m1", "state": "delivered"}
    )
    assert event.kind == "message.status"
    assert event.provider_message_id == "m1"
    assert event.state == "delivered"
    # A hint is used when the payload carries no kind.
    hinted = MockProvider().parse_event({}, kind_hint="media.start")
    assert hinted.kind == "media.start"
