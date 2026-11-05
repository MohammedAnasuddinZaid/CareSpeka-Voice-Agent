# Hardware Report — CareSpeak VoiceLink

Measured on the machine VoiceLink was built and tested on. Values were read with
`Get-CimInstance` / `nvidia-smi` on 6 November 2026.

## Machine

| Component | Detected value |
|---|---|
| Model | Dell G15 5530 |
| CPU | 13th Gen Intel Core i5-13450HX, 10 cores / 16 threads, 2.4 GHz base |
| RAM | 15.7 GB usable (16 GB DDR5) |
| GPU | NVIDIA GeForce RTX 3050 6 GB Laptop GPU, 6144 MiB, driver 581.95 |
| Integrated GPU | Intel UHD Graphics, driver 32.0.101.7088 |
| Storage | Local SSD (models ~270 MB, virtualenv, Next.js `node_modules`) |
| OS | Windows 11 Home Single Language, build 26200, 64-bit |
| Node.js | v24.16.0 |
| Python | 3.10.11 (backend virtualenv) |
| Ollama | 0.40.9 |

## How the hardware is used

| Workload | Device | Notes |
|---|---|---|
| Silero VAD | CPU, 1 thread | 256-sample ONNX windows; ~30 MB resident |
| whisper.cpp ASR | CPU by default | `ggml-base.en.bin`; ~1 GB RSS with the server |
| Ollama LLM | CPU by default | `qwen2.5:3b`, memory-mapped weights |
| sherpa-onnx TTS | CPU, 4 threads | VITS-LJS, 22.05 kHz output |
| Web Audio / AudioWorklet | Browser | 16 kHz mono capture and playback |
| FastAPI + SQLite | CPU | I/O only, negligible |

### GPU status during testing

`nvidia-smi` showed **5319 MiB of 6144 MiB already in use by another process**
(`C:\llama-cpp\llama-server.exe`) with only 684 MiB free. VoiceLink therefore ran
**entirely on the CPU**: Ollama reported `size_vram: 0` for `qwen2.5:3b` and
whisper.cpp used the CPU build.

This is the honest configuration behind every number in
[`PERFORMANCE_REPORT.md`](PERFORMANCE_REPORT.md). No user process was stopped to
free the GPU.

To opt into the GPU later (when it is free), set `WHISPER_BACKEND=cuda` in
`.env.voicelink` and place the CUDA whisper.cpp build under
`backend/models/whisper.cpp/cuda/Release/`. The CUDA build also needs the matching
CUDA runtime DLLs; `nvcc` is **not** installed on this machine, so the CUDA build
was not compiled or benchmarked here.

## Capacity

| Resource | Observation |
|---|---|
| Concurrent calls | Server allows 4 (`VOICELINK_MAX_ACTIVE_CALLS`); the real bound is CPU — one call already keeps the CPU busy during a turn |
| Call length | Capped at 30 minutes / 40 turns |
| Disk written per call | Two transcript rows per turn in `backend/data/voicelink.db`; audio is never written to disk |
| Network during a call | Loopback only (desktop) or private LAN only (phone). No internet traffic |
| Network during setup | `setup.ps1` downloads models and packages once |

## Not required

VoiceLink needs no GPU, no cloud instance, no telephony hardware, no SIP trunk,
no separate microphone, and no paid service. A 6 GB laptop GPU is more than
enough when free; the CPU fallback is what was tested.
