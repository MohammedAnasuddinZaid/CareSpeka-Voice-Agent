"""Deep tests for the streaming Ollama client.

HTTP is served by ``httpx.MockTransport`` with an async handler (the same
pattern as the provider tests), so streaming, cancellation, health caching and
every failure mode are exercised without a running model.
"""
from __future__ import annotations

import asyncio
import functools
import time

import httpx
import pytest

from app.config import settings
from app.llm import LLMError, OllamaClient


def async_test(fn):
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        return asyncio.run(fn(*args, **kwargs))

    return wrapper


class Responder:
    """Routes requests by path to a canned response or a raised exception."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.routes: dict[str, object] = {}

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        handler = self.routes.get(request.url.path)
        if handler is None:
            raise AssertionError(f"unexpected request to {request.url.path}")
        if isinstance(handler, Exception):
            raise handler
        if callable(handler):
            return handler(request)
        return handler

    def hits(self, path: str) -> int:
        return sum(1 for request in self.requests if request.url.path == path)


@pytest.fixture()
def llm_env(monkeypatch):
    responder = Responder()
    real_client = httpx.AsyncClient

    def factory(*args, **kwargs):
        kwargs.pop("transport", None)
        kwargs["transport"] = httpx.MockTransport(responder)
        return real_client(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", factory)
    client = OllamaClient()
    client._health_cache = (time.monotonic(), {"ok": True, "model_installed": True})
    responder.routes["/api/chat"] = httpx.Response(200, text="")
    return client, responder


async def collect(client: OllamaClient, cancel=None, messages=None) -> list[dict]:
    items: list[dict] = []
    async for item in client.stream_chat(
        messages or [{"role": "user", "content": "hello"}], cancel_event=cancel
    ):
        items.append(item)
    return items


# ---------------------------------------------------------------------------
# streaming
# ---------------------------------------------------------------------------
@async_test
async def test_stream_chat_yields_deltas_and_a_done_summary(llm_env):
    client, responder = llm_env
    responder.routes["/api/chat"] = httpx.Response(
        200,
        text=(
            '{"message":{"content":"Hel"}}\n'
            '{"message":{"content":"lo"}}\n'
            '{"done":true}\n'
        ),
    )
    items = await collect(client)
    deltas = [item.get("delta") for item in items if item.get("delta")]
    assert deltas == ["Hel", "lo"]
    final = items[-1]
    assert final["done"] is True
    assert final["text"] == "Hello"
    assert final["first_token_ms"] is not None
    assert final["total_ms"] >= 0

    request = responder.requests[0]
    assert request.method == "POST"
    assert request.url.path == "/api/chat"
    payload = httpx.Response(200, content=request.content).json()
    assert payload["model"] == client.model
    assert payload["stream"] is True
    assert payload["messages"] == [{"role": "user", "content": "hello"}]
    assert payload["options"]["temperature"] == settings.ollama_temperature
    assert "\n\n" in payload["options"]["stop"]


@async_test
async def test_stream_chat_skips_blank_and_malformed_lines(llm_env):
    client, responder = llm_env
    responder.routes["/api/chat"] = httpx.Response(
        200,
        text=(
            "\n"
            '{"message":{"content":"Hi"}}\n'
            "this is not json\n"
            '{"message":{"content":"!"}}\n'
            '{"done":true}\n'
        ),
    )
    items = await collect(client)
    assert [i["delta"] for i in items if i.get("delta")] == ["Hi", "!"]


@async_test
async def test_stream_chat_accepts_the_legacy_response_field(llm_env):
    client, responder = llm_env
    responder.routes["/api/chat"] = httpx.Response(
        200, text='{"response":"Legacy"}\n{"done":true}\n'
    )
    items = await collect(client)
    assert [i["delta"] for i in items if i.get("delta")] == ["Legacy"]
    assert items[-1]["text"] == "Legacy"


@async_test
async def test_stream_chat_reports_an_in_stream_error(llm_env):
    client, responder = llm_env
    responder.routes["/api/chat"] = httpx.Response(
        200, text='{"error":"model crashed"}\n'
    )
    with pytest.raises(LLMError) as exc:
        await collect(client)
    assert exc.value.code == "llm_error"
    assert "model crashed" in str(exc.value)


@async_test
async def test_stream_chat_stops_immediately_when_cancelled(llm_env):
    client, responder = llm_env
    responder.routes["/api/chat"] = httpx.Response(
        200, text='{"message":{"content":"should not be read"}}\n{"done":true}\n'
    )
    cancel = asyncio.Event()
    cancel.set()
    items = await collect(client, cancel=cancel)
    assert len(items) == 1
    assert items[0]["done"] is True
    assert items[0]["text"] == ""
    assert items[0]["first_token_ms"] is None


@async_test
async def test_stream_chat_surfaces_http_errors(llm_env):
    client, responder = llm_env
    responder.routes["/api/chat"] = httpx.Response(500, text="runner exploded")
    with pytest.raises(LLMError) as exc:
        await collect(client)
    assert exc.value.code == "llm_http_error"
    assert "500" in str(exc.value)
    assert "runner exploded" in str(exc.value)


@async_test
async def test_stream_chat_maps_transport_failures(llm_env):
    client, responder = llm_env
    responder.routes["/api/chat"] = httpx.ReadTimeout("slow model")
    with pytest.raises(LLMError) as exc:
        await collect(client)
    assert exc.value.code == "llm_timeout"
    assert "timed out" in str(exc.value)

    responder.routes["/api/chat"] = httpx.ConnectError("no daemon")
    with pytest.raises(LLMError) as exc:
        await collect(client)
    assert exc.value.code == "llm_unreachable"


@async_test
async def test_stream_chat_refuses_when_the_model_is_not_installed(llm_env):
    client, _ = llm_env
    client._health_cache = (
        time.monotonic(),
        {"ok": False, "model_installed": False, "error": "Run: ollama pull qwen"},
    )
    with pytest.raises(LLMError) as exc:
        await collect(client)
    assert exc.value.code == "llm_unavailable"
    assert "ollama pull" in str(exc.value)


@async_test
async def test_generate_once_joins_the_chunks(llm_env):
    client, responder = llm_env
    responder.routes["/api/chat"] = httpx.Response(
        200,
        text='{"message":{"content":" Take "}}\n{"message":{"content":"tablets."}}\n{"done":true}\n',
    )
    assert await client.generate_once([{"role": "user", "content": "?"}]) == "Take tablets."


# ---------------------------------------------------------------------------
# health
# ---------------------------------------------------------------------------
@async_test
async def test_health_reports_an_installed_model(llm_env):
    client, responder = llm_env
    client._health_cache = (0.0, {})
    responder.routes["/api/tags"] = httpx.Response(
        200, json={"models": [{"name": client.model}, {"name": "other"}]}
    )
    health = await client.health()
    assert health["ok"] is True
    assert health["model_installed"] is True
    assert health["models"] == [client.model, "other"]
    assert health["error"] is None


@async_test
async def test_health_names_the_missing_model(llm_env):
    client, responder = llm_env
    client._health_cache = (0.0, {})
    responder.routes["/api/tags"] = httpx.Response(200, json={"models": []})
    health = await client.health()
    assert health["ok"] is False
    assert health["model_installed"] is False
    assert f"ollama pull {client.model}" in health["error"]


@async_test
async def test_health_reports_an_unreachable_daemon(llm_env):
    client, responder = llm_env
    client._health_cache = (0.0, {})
    responder.routes["/api/tags"] = httpx.ConnectError("refused")
    health = await client.health()
    assert health["ok"] is False
    assert health["model_installed"] is False
    assert "unreachable" in health["error"]


@async_test
async def test_health_is_cached_for_five_seconds(llm_env):
    client, responder = llm_env
    client._health_cache = (0.0, {})
    responder.routes["/api/tags"] = httpx.Response(200, json={"models": [{"name": client.model}]})
    first = await client.health()
    second = await client.health()
    assert first is second
    assert responder.hits("/api/tags") == 1

    refreshed = await client.health(refresh=True)
    assert refreshed["ok"] is True
    assert responder.hits("/api/tags") == 2


# ---------------------------------------------------------------------------
# warmup, connection reuse and shutdown
# ---------------------------------------------------------------------------
@async_test
async def test_warmup_reports_success_and_failure(llm_env):
    client, responder = llm_env
    responder.routes["/api/chat"] = httpx.Response(200, json={"message": {"content": "OK"}})
    ok = await client.warmup()
    assert ok["ok"] is True
    assert ok["warmup_ms"] >= 0

    responder.routes["/api/chat"] = httpx.ConnectError("down")
    failed = await client.warmup()
    assert failed["ok"] is False
    assert "down" in failed["error"]


@async_test
async def test_the_http_client_is_reused_until_shutdown(llm_env):
    client, responder = llm_env
    responder.routes["/api/chat"] = httpx.Response(
        200, text='{"message":{"content":"Hi"}}\n{"done":true}\n'
    )
    await collect(client)
    first = client._client
    await collect(client)
    assert client._client is first

    await client.shutdown()
    assert first.is_closed is True
    assert client._client is None

    # A later call starts a fresh client instead of reusing a closed one.
    await collect(client)
    assert client._client is not None and client._client is not first


@async_test
async def test_shutdown_without_a_client_is_safe():
    client = OllamaClient()
    await client.shutdown()
    assert client._client is None