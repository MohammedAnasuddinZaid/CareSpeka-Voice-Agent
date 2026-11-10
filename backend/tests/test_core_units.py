"""Deterministic unit tests for the VoiceLink core (no models, no network).

These cover the pure helpers that guard clinical safety and spoken output:
input validation, text sanitisation, emergency detection, prompt construction,
speech normalisation, the escalation policy and the state machines.  Nothing
here loads a model, opens a socket or places a call.
"""
from __future__ import annotations

import numpy as np
import pytest

from app import escalation, prompts, secrets_store, security
from app.config import Settings, _bool_env, _float_env, _int_env
from app.escalation import CANONICAL_CONFIRMATION
from app.security import ValidationError
from app.telephony.models import (
    CallState,
    EscalationSeverity,
    EscalationState,
    FamilyRequestState,
    MessageState,
    TransitionResult,
    can_transition_call,
    is_call_terminal,
    severity_at_least,
    transition_call,
    transition_escalation,
    transition_family_request,
    transition_message,
)
from app.tts import StreamingTTSChunker, normalize_for_speech, split_sentences


# ---------------------------------------------------------------------------
# security: extension / dial validation
# ---------------------------------------------------------------------------
def test_normalize_extension_strips_and_uppercases():
    assert security.normalize_extension("  cs-1001 ") == "CS-1001"
    assert security.normalize_extension("CS 1001") == "CS1001"
    assert security.normalize_extension(None) == ""


def test_validate_dial_accepts_only_the_agent_extension():
    target = security.validate_dial("cs-1001", "cs-0000")
    assert target.caller == "CS-1001"
    assert target.callee == "CS-0000"


@pytest.mark.parametrize(
    "caller,callee,code,status",
    [
        ("", "CS-0000", "invalid_caller", 400),
        ("nope", "CS-0000", "invalid_caller", 400),
        ("CS-1001", "", "invalid_callee", 400),
        ("CS-1001", "CS-2002", "callee_not_available", 409),
    ],
)
def test_validate_dial_rejections(caller, callee, code, status):
    with pytest.raises(ValidationError) as exc:
        security.validate_dial(caller, callee)
    assert exc.value.code == code
    assert exc.value.status_code == status


# ---------------------------------------------------------------------------
# security: text sanitisation
# ---------------------------------------------------------------------------
def test_guard_user_text_strips_controls_and_collapses_whitespace():
    assert security.guard_user_text("hello\x00\x07   world") == "hello world"
    assert security.guard_user_text("") == ""


def test_guard_user_text_truncates_on_a_word_boundary():
    text = "word " * 400
    out = security.guard_user_text(text, limit=20)
    assert out.endswith("...")
    assert len(out) <= 23


def test_clean_assistant_text_removes_urls_markdown_and_emoji():
    dirty = "See **https://evil.example/x** now 😀\nnext line"
    clean = security.clean_assistant_text(dirty)
    assert "http" not in clean
    assert "*" not in clean
    assert "😀" not in clean
    assert "\n" not in clean
    assert clean == "See now next line"


def test_clean_assistant_text_truncation_ends_with_a_period():
    out = security.clean_assistant_text("a b c d e f g h", limit=5)
    assert out.endswith(".")
    assert "  " not in out


def test_trim_for_call_limits_sentences_and_words():
    text = "One two three. Four five six. Seven eight nine."
    assert security.trim_for_call(text) == "One two three. Four five six."

    # A single very long sentence is cut to the word budget and closed with a full stop.
    long = " ".join(f"w{i}" for i in range(120))
    trimmed = security.trim_for_call(long, max_words=5)
    assert trimmed == "w0 w1 w2 w3 w4."
    assert security.trim_for_call("") == ""


# ---------------------------------------------------------------------------
# security: emergency detection
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "text,category",
    [
        ("I have crushing chest pain", "cardiac"),
        ("I cannot breathe properly", "breathing"),
        ("my face is drooping and I have slurred speech", "stroke"),
        ("there is severe bleeding that won't stop bleeding", "bleeding"),
        ("she has passed out and is unresponsive", "consciousness"),
        ("I want to die", "self_harm"),
    ],
)
def test_detect_emergency_categories(text, category):
    assert security.detect_emergency(text) == category


def test_detect_emergency_respects_negation():
    assert security.detect_emergency("no chest pain today") is None
    assert security.detect_emergency("I do not have chest pain") is None
    assert security.detect_emergency("I never had a stroke") is None
    # ...but a genuine mention after a negation elsewhere still fires.
    assert security.detect_emergency("I am fine, but now I have chest pain") == "cardiac"


def test_detect_emergency_empty_text():
    assert security.detect_emergency("") is None


def test_emergency_reply_differs_for_self_harm():
    assert "112" in security.emergency_reply("cardiac")
    assert security.emergency_reply("self_harm") == security.SELF_HARM_REPLY
    assert "crisis helpline" in security.emergency_reply("self_harm")


# ---------------------------------------------------------------------------
# security: origin and service URL guards
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "origin",
    [
        None,
        "",
        "http://localhost:3000",
        "https://127.0.0.1:3443",
        "http://[::1]:8000",
        "http://192.168.0.4:3000",
        "https://10.1.2.3",
        "https://172.16.0.1",
    ],
)
def test_is_local_origin_accepts_local(origin):
    assert security.is_local_origin(origin) is True


@pytest.mark.parametrize(
    "origin",
    [
        "null",
        "http://example.com",
        "https://8.8.8.8",
        "https://172.32.0.1",
        "ftp://127.0.0.1",
        "http://localhost.evil.com",
    ],
)
def test_is_local_origin_rejects_remote(origin):
    assert security.is_local_origin(origin) is False


def test_assert_local_service_url_allows_private_hosts_only():
    security.assert_local_service_url("http://127.0.0.1:11434")
    security.assert_local_service_url("https://localhost:3443")
    security.assert_local_service_url("http://10.0.0.9:8000")
    with pytest.raises(ValueError):
        security.assert_local_service_url("http://8.8.8.8")
    with pytest.raises(ValueError):
        security.assert_local_service_url("ftp://127.0.0.1")
    with pytest.raises(ValueError):
        security.assert_local_service_url("not-a-url")


# ---------------------------------------------------------------------------
# prompts
# ---------------------------------------------------------------------------
def test_system_prompt_includes_patient_context_and_demo_marker():
    prompt = prompts.system_prompt(
        {
            "display_name": "Asha Rao",
            "age": 71,
            "room": "Ward B / Bed 2",
            "primary_concern": "heart failure follow-up",
            "notes": "On furosemide.",
        },
        demo_mode=True,
    )
    assert "Asha Rao" in prompt
    assert "synthetic demo patient" in prompt
    assert "furosemide" in prompt.lower()
    assert "Never diagnose" in prompt
    assert "call 112" in prompt


def test_system_prompt_without_patient():
    prompt = prompts.system_prompt(None, demo_mode=False)
    assert "No patient record is loaded" in prompt
    assert "synthetic" not in prompt


def test_greeting_uses_first_name_or_generic():
    assert prompts.greeting({"display_name": "Asha Rao"}).startswith("Hi Asha,")
    assert prompts.greeting(None).startswith("Hi, this is")
    assert prompts.AGENT_NAME in prompts.greeting(None)


def test_unavailable_reply_is_honest():
    reply = prompts.unavailable_reply()
    assert "language model" in reply
    assert "not available" in reply


def test_build_messages_order_and_history_trimming():
    history = [
        {"role": "assistant", "text": "hi"},
        {"role": "user", "text": "hello"},
    ]
    messages = prompts.build_messages({"display_name": "Asha Rao"}, True, history, "how are you?")
    assert messages[0]["role"] == "system"
    assert messages[-1] == {"role": "user", "content": "how are you?"}
    assert messages[1] == {"role": "assistant", "content": "hi"}
    assert messages[2] == {"role": "user", "content": "hello"}


def test_build_messages_caps_history_length():
    history = [{"role": "user", "text": f"m{i}"} for i in range(prompts.MAX_HISTORY_MESSAGES + 10)]
    messages = prompts.build_messages(None, False, history, "final?")
    # system + at most MAX_HISTORY_MESSAGES history + the final user turn
    assert len(messages) <= prompts.MAX_HISTORY_MESSAGES + 2


def test_build_messages_drops_empty_history_entries():
    history = [{"role": "user", "text": "   "}, {"role": "user", "text": "kept"}]
    messages = prompts.build_messages(None, False, history, "q")
    assert {"role": "user", "content": "kept"} in messages
    assert all(entry["content"].strip() for entry in messages)


# ---------------------------------------------------------------------------
# tts text helpers
# ---------------------------------------------------------------------------
def test_normalize_for_speech_expands_tokens():
    spoken = normalize_for_speech("CareSpeak VoiceLink on CS-1001, call 112.")
    assert "Care Speak" in spoken
    assert "Voice Link" in spoken
    assert "C S 1 0 0 1" in spoken
    assert "one one two" in spoken


def test_normalize_for_speech_punctuation_and_stage_directions():
    assert normalize_for_speech("BP is high") == "blood pressure is high."
    assert normalize_for_speech("(smiling) hello there") == "hello there."
    assert normalize_for_speech("A & B + C @ D") == "A and B plus C at D."
    assert normalize_for_speech("Dr. Rao will call") == "Doctor Rao will call."


def test_normalize_for_speech_always_terminates():
    assert normalize_for_speech("hello") .endswith(".")
    assert normalize_for_speech("hello!").endswith("!")


def test_split_sentences_handles_abbreviations():
    assert split_sentences("Dr. Smith arrived. He left.") == ["Dr. Smith arrived.", "He left."]
    assert split_sentences("") == []
    assert split_sentences("One. Two! Three?") == ["One.", "Two!", "Three?"]


def test_streaming_chunker_emits_complete_sentences():
    chunker = StreamingTTSChunker(max_chars=60, min_chars=4)
    ready = chunker.push("Hello there friend. How are ")
    assert ready == ["Hello there friend."]
    assert chunker.flush() == ["How are"]


def test_streaming_chunker_respects_min_chars():
    chunker = StreamingTTSChunker(min_chars=10)
    assert chunker.push("Hi. ") == []
    assert chunker.flush() == ["Hi."]


def test_streaming_chunker_splits_overlong_buffer():
    chunker = StreamingTTSChunker(max_chars=20, min_chars=4)
    ready = chunker.push("alpha beta gamma delta epsilon")
    assert ready  # the buffer was split on a space
    assert all(len(part) <= 20 for part in ready)


# ---------------------------------------------------------------------------
# escalation policy
# ---------------------------------------------------------------------------
def test_escalation_emergency_takes_precedence_over_urgent():
    decision = escalation.classify("I fell down and now have chest pain")
    assert decision.severity == EscalationSeverity.EMERGENCY
    assert decision.category == "cardiac"


@pytest.mark.parametrize(
    "text,category",
    [
        ("my pain is getting really bad", "severe_pain"),
        ("I just fell down", "fall"),
        ("I have a high fever", "high_fever"),
        ("I cannot walk at all", "cannot_walk"),
        ("I am very dizzy", "very_dizzy"),
    ],
)
def test_escalation_urgent_categories(text, category):
    decision = escalation.classify(text)
    assert decision.severity == EscalationSeverity.URGENT
    assert decision.category == category


@pytest.mark.parametrize(
    "text,category",
    [
        ("I forgot to take my tablets", "missed_medication"),
        ("I have a rash", "side_effect"),
        ("something feels wrong", "worry"),
    ],
)
def test_escalation_follow_up_categories(text, category):
    decision = escalation.classify(text)
    assert decision.severity == EscalationSeverity.FOLLOW_UP
    assert decision.category == category


def test_escalation_ignores_unknown_llm_labels():
    decision = escalation.classify("I feel a bit strange", llm_hint="catastrophe")
    assert decision.severity == EscalationSeverity.ROUTINE
    # A routine hint never raises severity.
    assert escalation.classify("all good", llm_hint="routine").severity == EscalationSeverity.ROUTINE


def test_escalation_llm_hint_requires_confirmation_and_carries_question():
    decision = escalation.classify("I feel odd", llm_hint="emergency")
    assert decision.severity == EscalationSeverity.EMERGENCY
    assert decision.requires_confirmation is True
    assert decision.confirmation_question == CANONICAL_CONFIRMATION
    assert decision.source == "llm_hint"


def test_escalation_confirmation_is_a_noop_for_rule_decisions():
    rule = escalation.classify("chest pain")
    assert escalation.apply_confirmation(rule, False) is rule


def test_escalation_confirmation_denial_downgrades_to_routine():
    hint = escalation.classify("I am not sure", llm_hint="urgent")
    denied = escalation.apply_confirmation(hint, False)
    assert denied.severity == EscalationSeverity.ROUTINE
    assert denied.requires_confirmation is False


def test_escalation_decision_serialises():
    payload = escalation.classify("chest pain").to_dict()
    assert payload["severity"] == "emergency"
    assert payload["source"] == "rules"
    assert payload["requires_confirmation"] is False


def test_safety_message_never_claims_the_ai_sends_help():
    emergency = escalation.safety_message(EscalationSeverity.EMERGENCY, emergency_number="112")
    assert "112" in emergency
    assert "cannot send help myself" in emergency

    urgent = escalation.safety_message(EscalationSeverity.URGENT)
    assert "care team" in urgent
    assert escalation.safety_message(EscalationSeverity.ROUTINE) == ""


def test_dedupe_key_is_stable_and_specific():
    a = escalation.dedupe_key(1, "cardiac", EscalationSeverity.EMERGENCY, "2026-01-01")
    b = escalation.dedupe_key(1, "cardiac", EscalationSeverity.EMERGENCY, "2026-01-01")
    c = escalation.dedupe_key(1, "cardiac", EscalationSeverity.URGENT, "2026-01-01")
    assert a == b != c
    assert a == "esc:1:cardiac:emergency:2026-01-01"


def test_ack_severity_rank_and_unknown():
    assert escalation.ack_escalation_severity("routine") == 0
    assert escalation.ack_escalation_severity("emergency") == 3
    assert escalation.ack_escalation_severity("nonsense") == 0


# ---------------------------------------------------------------------------
# state machines
# ---------------------------------------------------------------------------
def test_call_transitions_allow_and_deny():
    assert transition_call("created", "queued").ok
    assert not transition_call("completed", "ringing").ok
    # Duplicate terminal events are a no-op, not an error.
    noop = transition_call("completed", "completed")
    assert noop.ok and noop.reason == "noop"


def test_call_transition_result_serialises():
    assert transition_call("created", "queued").to_dict() == {
        "ok": True,
        "previous": "created",
        "current": "queued",
        "reason": None,
    }


def test_can_transition_call_handles_unknown_states():
    assert can_transition_call("created", "queued") is True
    assert can_transition_call("bogus", "queued") is False


def test_message_and_escalation_and_family_transitions():
    assert not transition_message("created", "delivered").ok
    assert transition_message("sent", "delivered").ok
    assert transition_escalation("open", "acknowledged").ok
    assert not transition_escalation("resolved", "open").ok
    assert transition_family_request("pending", "approved").ok
    assert not transition_family_request("denied", "approved").ok


def test_is_call_terminal():
    assert is_call_terminal("completed") is True
    assert is_call_terminal("connected") is False
    # An unrecognised state is treated as terminal so it cannot be mis-advanced.
    assert is_call_terminal("???") is True


def test_severity_at_least():
    assert severity_at_least("emergency", "urgent") is True
    assert severity_at_least("routine", "urgent") is False
    assert severity_at_least("garbage", "urgent") is False


def test_state_enum_values_are_stable():
    assert CallState.DISCONNECTED.value == "disconnected"
    assert MessageState.UNDELIVERED.value == "undelivered"
    assert EscalationState.CANCELLED.value == "cancelled"
    assert FamilyRequestState.FULFILLED.value == "fulfilled"
    assert TransitionResult(True, "a", "b").reason is None


# ---------------------------------------------------------------------------
# config environment helpers
# ---------------------------------------------------------------------------
def test_env_helpers(monkeypatch):
    monkeypatch.setenv("VL_TEST_INT", "not-an-int")
    assert _int_env("VL_TEST_INT", 7) == 7
    monkeypatch.setenv("VL_TEST_INT", "42")
    assert _int_env("VL_TEST_INT", 7) == 42

    monkeypatch.setenv("VL_TEST_FLOAT", "abc")
    assert _float_env("VL_TEST_FLOAT", 1.5) == 1.5
    monkeypatch.setenv("VL_TEST_FLOAT", "2.25")
    assert _float_env("VL_TEST_FLOAT", 1.5) == 2.25

    monkeypatch.setenv("VL_TEST_BOOL", "yes")
    assert _bool_env("VL_TEST_BOOL", False) is True
    monkeypatch.setenv("VL_TEST_BOOL", "0")
    assert _bool_env("VL_TEST_BOOL", True) is False


def test_settings_phone_url_and_backend_helpers():
    local = Settings(lan_ip="127.0.0.1")
    assert local.phone_url == f"https://localhost:{local.gateway_port}/voicelink"
    lan = Settings(lan_ip="192.168.1.5", phone_url_override="")
    assert lan.phone_url == f"https://192.168.1.5:{lan.gateway_port}/voicelink"
    override = Settings(phone_url_override="https://phone.example/voicelink")
    assert override.phone_url == "https://phone.example/voicelink"


def test_settings_engine_and_path_helpers():
    assert Settings(tts_engine="sherpa").engine_is_sherpa is True
    assert Settings(tts_engine="kokoro").engine_is_sherpa is False
    sherpa = Settings(tts_engine="sherpa")
    assert sherpa.sherpa_model_path.name == "vits-ljs.onnx"
    assert sherpa.sherpa_lexicon_path.name == "lexicon.txt"


# ---------------------------------------------------------------------------
# secrets store
# ---------------------------------------------------------------------------
def test_secrets_store_roundtrip_and_allowlist():
    try:
        stored = secrets_store.set_many({"EXOTEL_API_KEY": "unit-value", "NOT_ALLOWED": "nope"})
        assert stored == {"EXOTEL_API_KEY": "unit-value"}
        assert secrets_store.get("EXOTEL_API_KEY") == "unit-value"
        assert secrets_store.is_set("EXOTEL_API_KEY") is True
        # An unknown key must never be persisted.
        assert secrets_store.get("NOT_ALLOWED") == ""
    finally:
        secrets_store.clear(["EXOTEL_API_KEY"])


def test_secrets_store_empty_value_removes_secret():
    try:
        secrets_store.set_many({"TWILIO_AUTH_TOKEN": "abc"})
        secrets_store.set_many({"TWILIO_AUTH_TOKEN": ""})
        assert secrets_store.get("TWILIO_AUTH_TOKEN") == ""
    finally:
        secrets_store.clear(["TWILIO_AUTH_TOKEN"])


def test_secrets_store_env_wins(monkeypatch):
    try:
        secrets_store.set_many({"EXOTEL_API_TOKEN": "from-file"})
        monkeypatch.setenv("EXOTEL_API_TOKEN", "from-env")
        assert secrets_store.get("EXOTEL_API_TOKEN") == "from-env"
    finally:
        secrets_store.clear(["EXOTEL_API_TOKEN"])


def test_secrets_store_mask():
    assert secrets_store.mask("") == ""
    assert secrets_store.mask("abcd") == "••••"
    masked = secrets_store.mask("supersecretvalue")
    assert masked.startswith("su") and masked.endswith("ue")
    assert "secret" not in masked


def test_secret_status_reports_booleans_only():
    try:
        secrets_store.set_many({"EXOTEL_API_KEY": "k"})
        status = secrets_store.secret_status()
        assert status["EXOTEL_API_KEY"] is True
        assert status["TWILIO_AUTH_TOKEN"] is False
        assert all(isinstance(v, bool) for v in status.values())
    finally:
        secrets_store.clear(["EXOTEL_API_KEY"])


def test_session_secret_is_stable(monkeypatch):
    monkeypatch.delenv("SESSION_SECRET", raising=False)
    try:
        secrets_store.clear(["SESSION_SECRET"])
        first = secrets_store.session_secret()
        second = secrets_store.session_secret()
        assert first and first == second
    finally:
        secrets_store.clear(["SESSION_SECRET"])


# ---------------------------------------------------------------------------
# asr helpers
# ---------------------------------------------------------------------------
def test_wav_bytes_from_float_shape():
    from app.asr import wav_bytes_from_float

    samples = np.zeros(1600, dtype=np.float32)
    wav = wav_bytes_from_float(samples, 16000)
    assert wav[:4] == b"RIFF"
    assert wav[8:12] == b"WAVE"
    # 16-bit mono PCM payload is 2 bytes per sample.
    assert len(wav) > 44


def test_resample_linear_doubles_for_2x():
    from app.asr import resample_linear

    data = np.arange(8000, dtype=np.float32)
    assert resample_linear(data, 8000, 8000) is data or resample_linear(data, 8000, 8000).size == 8000
    out = resample_linear(data, 8000, 16000)
    assert out.size == 16000
    assert resample_linear(np.empty(0, dtype=np.float32), 8000, 16000).size == 0


def test_clean_transcript_removes_annotations():
    from app.asr import clean_transcript

    assert clean_transcript(" [BLANK_AUDIO] hello   world ") == "hello world"
    assert clean_transcript("...[music]") == ""
    assert clean_transcript("") == ""


def test_whisper_health_shape():
    from app.asr import WhisperASR

    health = WhisperASR().health()
    assert set(health) >= {"binary", "backend", "model", "running", "error"}
    assert isinstance(health["model_exists"], bool)
