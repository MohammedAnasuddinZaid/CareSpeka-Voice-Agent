"""Async Ollama client for local, streaming conversation."""
from __future__ import annotations

import asyncio
import json
import time
from typing import AsyncIterator, Optional

import httpx

from app.config import settings


class LLMError(RuntimeError):
    def __init__(self, message: str, code: str = "llm_error") -> None:
        super().__init__(message)
        self.code = code


class OllamaClient:
    def __init__(self) -> None:
        self.base_url = settings.ollama_url.rstrip("/")
        self.model = settings.ollama_model
        self._client: Optional[httpx.AsyncClient] = None
        self._health_cache: tuple[float, dict] = (0.0, {})

    async def _http(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                timeout=httpx.Timeout(
                    settings.ollama_timeout_s, connect=4.0, write=15.0, pool=5.0
                )
            )
        return self._client

    async def _tags(self) -> dict:
        client = await self._http()
        response = await client.get(self.base_url + "/api/tags", timeout=3.0)
        response.raise_for_status()
        return response.json()

    async def health(self, refresh: bool = False) -> dict:
        now = time.monotonic()
        if not refresh and now - self._health_cache[0] < 5.0:
            return self._health_cache[1]
        result = {
            "ok": False,
            "url": self.base_url,
            "model": self.model,
            "model_installed": False,
            "models": [],
            "error": None,
        }
        try:
            tags = await self._tags()
            names = [item.get("name", "") for item in tags.get("models", [])]
            result["models"] = names
            result["model_installed"] = self.model in names
            result["ok"] = bool(result["model_installed"])
            if not result["model_installed"]:
                result["error"] = (
                    f"Ollama is running but model {self.model!r} is not installed. "
                    f"Run: ollama pull {self.model}"
                )
        except Exception as exc:
            result["error"] = f"Ollama is unreachable at {self.base_url}: {exc}"
        self._health_cache = (now, result)
        return result

    async def warmup(self) -> dict:
        """Load the model into memory without blocking application startup."""
        started = time.perf_counter()
        try:
            client = await self._http()
            response = await client.post(
                self.base_url + "/api/chat",
                json={
                    "model": self.model,
                    "messages": [{"role": "user", "content": "Reply with OK."}],
                    "stream": False,
                    "keep_alive": settings.ollama_keep_alive,
                    "options": {"num_predict": 2, "temperature": 0.0},
                },
                timeout=180.0,
            )
            response.raise_for_status()
            return {
                "ok": True,
                "warmup_ms": int((time.perf_counter() - started) * 1000),
            }
        except Exception as exc:
            return {
                "ok": False,
                "warmup_ms": int((time.perf_counter() - started) * 1000),
                "error": str(exc),
            }

    async def stream_chat(
        self,
        messages: list[dict[str, str]],
        cancel_event: Optional[asyncio.Event] = None,
    ) -> AsyncIterator[dict]:
        """Yield {"delta": str} chunks and a final {"done": True, ...} chunk."""
        health = await self.health()
        if not health.get("model_installed"):
            raise LLMError(
                health.get("error") or "Local LLM model is unavailable.",
                "llm_unavailable",
            )
        client = await self._http()
        payload = {
            "model": self.model,
            "messages": messages,
            "stream": True,
            "keep_alive": settings.ollama_keep_alive,
            "options": {
                "temperature": settings.ollama_temperature,
                "top_p": 0.9,
                "num_ctx": settings.ollama_num_ctx,
                "num_predict": settings.ollama_num_predict,
                "repeat_penalty": 1.08,
                "stop": ["\n\n", "\n1.", "\n- ", "\n* ", "\nOptions", "\nHere are"],
            },
        }
        started = time.perf_counter()
        first_token_ms: Optional[int] = None
        text_parts: list[str] = []
        try:
            async with client.stream(
                "POST", self.base_url + "/api/chat", json=payload
            ) as response:
                if response.status_code != 200:
                    body = (await response.aread()).decode("utf-8", "replace")[:300]
                    raise LLMError(
                        f"Ollama returned HTTP {response.status_code}: {body}",
                        "llm_http_error",
                    )
                async for line in response.aiter_lines():
                    if cancel_event is not None and cancel_event.is_set():
                        break
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        data = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if data.get("error"):
                        raise LLMError(str(data["error"]), "llm_error")
                    delta = (
                        data.get("message", {}).get("content")
                        if isinstance(data.get("message"), dict)
                        else None
                    ) or data.get("response", "")
                    if delta:
                        if first_token_ms is None:
                            first_token_ms = int((time.perf_counter() - started) * 1000)
                        text_parts.append(delta)
                        yield {"delta": delta}
                    if data.get("done"):
                        break
        except httpx.TimeoutException as exc:
            raise LLMError(
                "The local language model timed out. It may be loading or the CPU is busy.",
                "llm_timeout",
            ) from exc
        except httpx.HTTPError as exc:
            raise LLMError(f"Could not reach Ollama: {exc}", "llm_unreachable") from exc
        yield {
            "done": True,
            "text": "".join(text_parts),
            "first_token_ms": first_token_ms,
            "total_ms": int((time.perf_counter() - started) * 1000),
        }

    async def generate_once(self, messages: list[dict[str, str]]) -> str:
        chunks: list[str] = []
        async for item in self.stream_chat(messages):
            if item.get("delta"):
                chunks.append(item["delta"])
        return "".join(chunks).strip()

    async def shutdown(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None
