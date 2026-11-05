"""Provider-independent telephony layer for VoiceLink.

The package is deliberately split so the rest of the application never talks to a
specific carrier API directly:

* :mod:`app.telephony.numbers`   - E.164 normalisation, validation and masking.
* :mod:`app.telephony.models`    - persistent state machines and value objects.
* :mod:`app.telephony.base`      - the provider interface every adapter implements.
* :mod:`app.telephony.audio`     - telephony codec / sample-rate conversion.
* :mod:`app.telephony.mock`      - deterministic provider used by tests and offline demos.
* :mod:`app.telephony.exotel`    - real Exotel adapter (India).
* :mod:`app.telephony.twilio`    - real Twilio adapter.
* :mod:`app.telephony.registry`  - chooses the configured provider.
* :mod:`app.telephony.webhooks`  - signature verification, replay and idempotency.
* :mod:`app.telephony.service`   - durable call / message / escalation orchestration.
* :mod:`app.telephony.bridge`    - bidirectional audio bridge to the local AI pipeline.
* :mod:`app.telephony.router`    - FastAPI webhook and media-stream endpoints.
"""
from __future__ import annotations

__all__ = [
    "numbers",
    "models",
    "base",
    "audio",
    "registry",
    "webhooks",
    "service",
]
