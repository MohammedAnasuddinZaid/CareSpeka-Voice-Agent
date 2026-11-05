# Performance Report — CareSpeak VoiceLink

All numbers below were **measured on this machine**, not estimated. Every figure
comes either from a direct timing script against the real local models or from the
`metrics` object the backend attaches to each finished turn.

## Test conditions

| Item | Value |
|---|---|
| Machine | Dell G15 5530, i5-13450HX (10C/16T), 16 GB RAM, RTX 3050 6 GB |
| Compute used | **CPU only** — the GPU was ~87% occupied by another process (`llama-server.exe`, 5319/6144 MiB) |
| ASR | whisper.cpp `b5454` CPU build, `ggml-base.en.bin` |
| LLM | Ollama 0.40.9, `qwen2.5:3b`, warm |
| TTS | sherpa-onnx 2.0.1, VITS-LJS, 4 threads, 22.05 kHz |
| VAD | Silero ONNX, 256-sample windows |
| OS | Windows 11 build 26200 |

Because the CPU was shared with other work, latency varied a lot between runs.
Best/median/worst are reported rather than a single flattering number.

## 1. Speech recognition (whisper base.en, CPU)

Synthesised sentences were fed through the same code path the live call uses.

| Spoken | Heard | Latency |
|---|---|---|
| "I feel dizzy when I stand up." | correct | 621 ms |
| "My headache started this morning." | "My headaches started this morning." | 462 ms |
| "Should I take my medicine with food?" | correct | 448 ms |
| (live call, VAD-segmented) | correct | 481 ms |
| (live call, VAD-segmented) | correct | 492 ms |
| (barge-in follow-up) | "Stop, please. I need to ask about" | 468 ms |

- **Best 448 ms · median ~475 ms · worst 621 ms** for 2–3 second utterances.
- Accuracy: 4/6 exactly verbatim, 2/6 with a trivial inflection/plural difference.
- The barge-in line is short because the test stopped speaking; it is a test
  artifact, not an accuracy limit.

## 2. Text-to-speech (sherpa-onnx VITS-LJS, CPU, 4 threads)

Real-time factor (RTF) = synthesis time ÷ audio duration; lower is better.

| Sentence | Synthesis | Audio | RTF |
|---|---|---|---|
| "How are you feeling today, Asha?" | 362 ms | 2115 ms | **0.171** |
| "Please tell me more about when the dizziness started." | 518 ms | 3079 ms | **0.168** |
| "You should contact your nurse if the symptoms get worse." | 1356 ms | 3460 ms | 0.392 |

- Model load: **791–814 ms** once; self-test: **103 ms**.
- **Best RTF 0.168 · typical ~0.17 · worst 0.392** (the worst run collided with
  LLM work on the same CPU).
- Even the worst case is ~2.5× faster than real time, so TTS never becomes the
  bottleneck of a turn.

## 3. Language model (Ollama qwen2.5:3b, CPU, warm)

Two streaming calls with identical short prompts:

| Run | First token | Total | Tokens | Throughput |
|---|---|---|---|---|
| 1 | 245 ms | 1141 ms | 22 | 19.3 tok/s |
| 2 | **63 ms** | 966 ms | 22 | 22.8 tok/s |

- Warm-up call reported **143 ms** when the model was already resident; the very
  first cold start after boot was 3.7 s (health warm-up) to 4.6–5.2 s.
- **Best first token 63 ms · median ~150 ms · worst (cold) ~4.6–5.2 s.**
- Ollama reported `size_vram: 0` throughout: pure CPU inference.

## 4. End-to-end turns

Values from the backend's per-turn `metrics` during live WebSocket calls. "First
audio" is from the user finishing their turn to the first spoken audio chunk.

| Scenario | ASR | First token | TTS first | **First audio** | Notes |
|---|---|---|---|---|---|
| Typed turn, heavy CPU load | — | 3313 ms | 1446 ms | 5884 ms | Other CPU work running |
| Typed turn, heavy CPU load (repeat) | — | 3360 ms | — | 6865 ms | Other CPU work running |
| Spoken turn (VAD + whisper) | 481 ms | 723 ms | 476 ms | **1499 ms** | Engine warm |
| Spoken turn (repeat) | 492 ms | — | — | 2485 ms | Engine warm |
| Typed turn, lighter load | 123–197 ms (token) | — | 1231 ms | ~2.2–4.9 s | See note |

- **Best first audio ~1.5 s · typical 2.5–6 s · worst ~6.9 s** on this
  CPU-only, contended machine.
- The gap between typed and spoken turns is mostly LLM first-token time, which
  swings with CPU contention; ASR itself is consistently under 0.7 s.
- The reply is streamed sentence by sentence, so the user hears the first
  sentence while the rest is still being generated.

## 5. Barge-in (interruption)

Verified over a live WebSocket by speaking over Aria while she was replying:

- VAD fired `speech_start` with `barge_in: true` at probability **0.776**.
- The in-flight turn was cancelled, the app emitted `interrupted`
  (`reason: barge_in`) and returned to `LISTENING`.
- The interrupting sentence was transcribed (ASR **468 ms**) and answered in a
  new turn.

## 6. Health and startup

| Check | Measured |
|---|---|
| Backend `/health` with `refresh=true`, all checks true | ready |
| TTS model load during health | 814 ms |
| TTS self-test | 103 ms |
| LLM warm-up | 143 ms warm / 3651 ms cold |
| whisper server auto-start | starts on first use, then reused |

`health-check.ps1` is functional, not decorative: it reads the same live checks
(SQLite read/write, Ollama tags + model, whisper binary/model/server, TTS
load/self-test, VAD load).

## 7. Honest caveats

- **CPU-only.** No GPU numbers are claimed; the GPU was busy and was left alone.
  With CUDA whisper and GPU Ollama, first-audio time would drop, but that was not
  measured here and is not promised.
- **High variance.** This laptop was also running other heavy work, hence the
  4× spread on LLM first-token time. On an idle machine the good-case numbers in
  each table are the realistic expectation.
- **No synthetic benchmarks.** Every table above is wall-clock timing of the real
  local models on real text or real synthesized speech.
- **No medical claim.** Latency is measured for a demo care assistant; it is not
  a clinical SLA.
