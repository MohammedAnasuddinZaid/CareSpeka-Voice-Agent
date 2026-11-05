# Zero-Cost Policy — CareSpeak VoiceLink

CareSpeak VoiceLink was built under a hard **₹0 budget**. This document states
exactly what that means, what was used instead, and what is genuinely impossible
at zero cost so nobody is misled.

## Rules that were followed

1. **No paid API, ever.** No OpenAI, Anthropic, Google Gemini, ElevenLabs,
   Deepgram, Azure, AWS, Twilio, or any metered endpoint is called at runtime.
2. **No cloud inference.** The LLM, speech recognition, speech synthesis and VAD
   run on this computer.
3. **No billing accounts or trials.** Nothing was signed up for, and no credit
   card or free-trial quota is involved.
4. **No API keys.** The backend requires no key. A supplied Gemini/OpenRouter key
   is not read, not stored and not committed; any such key should be revoked by
   its owner.
5. **No hosting, database or telephony service.** Storage is a local SQLite file.
   The "phone line" is the PC's own Wi-Fi network.
6. **No telemetry.** The backend does not phone home. Browser telemetry that
   ships with Next.js is not enabled for VoiceLink.

## What runs locally, and under which license

| Component | Role | License | Cost |
|---|---|---|---|
| whisper.cpp (`b5454`, CPU build) | Speech → text | MIT | ₹0 |
| `ggml-base.en.bin` | Whisper base English weights | MIT | ₹0 |
| Ollama 0.40.9 | Local model runtime | MIT | ₹0 |
| `qwen2.5:3b` | Reply generation | Apache-2.0 | ₹0 |
| sherpa-onnx 2.0.1 | Speech synthesis runtime | Apache-2.0 | ₹0 |
| VITS-LJS (`vits-ljs.onnx`) | Voice model, LJSpeech (public-domain audio) | Apache-2.0 model card | ₹0 |
| Silero VAD (`silero_vad.onnx`) | Voice activity detection | MIT | ₹0 |
| FastAPI / uvicorn / httpx / numpy | Backend | MIT / BSD-3 | ₹0 |
| onnxruntime | ONNX execution | MIT | ₹0 |
| Next.js / React | Frontend | MIT | ₹0 |
| OpenSSL (from Git for Windows) | Local CA and certificate | Apache-2.0 | ₹0 |

Internet access is used **only during `setup.ps1`** to download those free
packages and models. After setup the full stack runs offline. The downloaded
files stay on this PC and are git-ignored.

## The honest limit: real telephone (PSTN) calls

A call to a mobile or landline number cannot be made for ₹0. PSTN termination is
a paid carrier service; every route to it (SIP trunk, Twilio, Plivo, Exotel, or a
SIM gateway) costs money or requires a billing account, and mobile carriers
themselves block free automated calling.

**What VoiceLink does instead, and it is real:** two devices on the same private
Wi-Fi network can call each other through the browser. The PC runs the AI, the
phone connects over HTTPS/WSS to the LAN gateway, the phone's microphone is used
for real, and the AI's voice is played back on the phone. That is genuine,
working, two-way voice calling — just not over the public telephone network.

If PSTN calling is ever required, it must be funded and implemented as a separate
paid integration. It is deliberately out of scope here rather than faked.

## What would cost money later (all optional)

| Upgrade | Why it costs | Needed? |
|---|---|---|
| PSTN/SIP trunk for real phone numbers | Carrier per-minute fees | Only if you must dial real phones |
| Public cloud hosting/domain | Hosting fees, TLS | No — LAN is enough |
| Larger models (e.g. qwen2.5:7b) | More GPU/CPU, but still ₹0 in software | No |
| Commercial voice cloning | Paid license | No — VITS-LJS is licensed for this use |

None of these is used, installed, or required by the current code.
