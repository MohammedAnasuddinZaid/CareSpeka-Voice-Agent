"""Test configuration.

The environment is configured *before* any ``app.*`` import so the frozen
``Settings`` object picks up an isolated database, an isolated secrets file and
the deterministic mock provider.  Tests never touch the developer's real
VoiceLink database or secrets.
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

_TMP = Path(tempfile.mkdtemp(prefix="voicelink-tests-"))

os.environ.setdefault("VOICELINK_DB_PATH", str(_TMP / "test.db"))
os.environ.setdefault("VOICELINK_SECRETS_PATH", str(_TMP / "provider_secrets.json"))
os.environ.setdefault("TELEPHONY_PROVIDER", "mock")
os.environ.setdefault("VOICELINK_REQUIRE_AUTH", "1")
os.environ.setdefault("VOICELINK_SEED_DEMO_USERS", "1")
os.environ.setdefault("VOICELINK_LOG_TRANSCRIPTS", "0")
os.environ.setdefault("VOICELINK_LLM_WARMUP", "0")
os.environ.setdefault("VOICELINK_QUIET_HOURS", "0")
os.environ.setdefault("PUBLIC_BASE_URL", "")
os.environ.setdefault("TELEPHONY_WEBHOOK_BASE_URL", "")

import pytest  # noqa: E402


@pytest.fixture(scope="session", autouse=True)
def _prepare_database():
    from app import database

    database.init_db()
    yield


@pytest.fixture()
def clean_db():
    """Fresh platform tables for tests that must not leak state."""
    from app import database

    database.init_db()
    return database
