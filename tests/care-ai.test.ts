import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CareLLM,
  SpeechCapture,
  Transcriber,
  careSystemPrompt,
  speak,
  speechSynthesisAvailable,
  stopSpeaking,
  webgpuAvailable,
} from "@/lib/care/browserAI";

interface FrameOptions {
  threshold?: number;
  silenceMs?: number;
  minSpeechMs?: number;
  maxUtteranceMs?: number;
}

/** Drives the private energy-VAD frame handler without an AudioContext. */
function capture(opts: FrameOptions = {}) {
  const starts: number[] = [];
  const ends: Array<{ length: number; durationMs: number }> = [];
  const capture = new SpeechCapture({
    threshold: opts.threshold,
    silenceMs: opts.silenceMs,
    minSpeechMs: opts.minSpeechMs,
    maxUtteranceMs: opts.maxUtteranceMs,
    onSpeechStart: () => starts.push(starts.length + 1),
    onSpeechEnd: (audio, durationMs) => ends.push({ length: audio.length, durationMs }),
  });
  const frame = (amplitude: number, samples = 1600) =>
    (capture as unknown as { onFrame: (f: Float32Array) => void }).onFrame(
      new Float32Array(samples).fill(amplitude)
    );
  return { capture, frame, starts, ends };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("capability detection", () => {
  it("reports WebGPU only when navigator.gpu is present", () => {
    expect(webgpuAvailable()).toBe(false);
    vi.stubGlobal("navigator", { gpu: {} });
    expect(webgpuAvailable()).toBe(true);
  });

  it("reports speech synthesis only in a window that has it", () => {
    expect(speechSynthesisAvailable()).toBe(false);
    vi.stubGlobal("window", {});
    expect(speechSynthesisAvailable()).toBe(false);
    vi.stubGlobal("window", { speechSynthesis: { cancel: () => undefined } });
    expect(speechSynthesisAvailable()).toBe(true);
    expect(() => stopSpeaking()).not.toThrow();
  });
});

describe("on-device VAD segmentation", () => {
  it("starts on a loud frame and only once", () => {
    const { frame, starts, ends } = capture();
    frame(0.5);
    frame(0.5);
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(0);
  });

  it("emits the whole utterance after the silence window", () => {
    const { frame, starts, ends } = capture();
    frame(0.5);
    frame(0.5);
    for (let i = 0; i < 7; i += 1) frame(0.0); // 700 ms of silence at 1600 samples/frame
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    // 2 loud + 7 quiet frames = 9 × 1600 samples = 900 ms.
    expect(ends[0]).toEqual({ length: 9 * 1600, durationMs: 900 });
  });

  it("honours a custom threshold and silence window", () => {
    const { frame, ends } = capture({ threshold: 0.4, silenceMs: 200 });
    frame(0.2); // below threshold, ignored
    expect(ends).toHaveLength(0);
    frame(0.5);
    frame(0.0);
    frame(0.0); // 200 ms → flush
    expect(ends).toHaveLength(1);
    expect(ends[0].length).toBe(3 * 1600);
  });

  it("cuts a very long utterance at the maximum duration", () => {
    const { frame, ends } = capture({ maxUtteranceMs: 200 });
    frame(0.5);
    frame(0.5); // 200 ms reached
    expect(ends).toHaveLength(1);
    expect(ends[0]).toEqual({ length: 2 * 1600, durationMs: 200 });
  });

  it("clears the buffer when capture is deactivated", () => {
    const { capture: cap, frame, ends } = capture();
    frame(0.5);
    cap.setActive(false);
    frame(0.0);
    frame(0.0);
    expect(ends).toHaveLength(0);
    // A later loud frame starts a fresh utterance.
    frame(0.5);
    expect(ends).toHaveLength(0);
  });
});

describe("on-device model guards", () => {
  it("refuses to transcribe before Whisper is loaded", async () => {
    const t = new Transcriber();
    expect(t.status).toBe("idle");
    await expect(t.transcribe(new Float32Array(10))).rejects.toThrow("Whisper is not loaded");
  });

  it("refuses to chat before WebLLM is loaded", async () => {
    const llm = new CareLLM();
    expect(llm.status).toBe("idle");
    await expect(llm.chat("system", [], "hi")).rejects.toThrow("WebLLM is not loaded");
  });

  it("marks WebLLM unsupported without WebGPU instead of downloading a model", async () => {
    const llm = new CareLLM();
    await expect(llm.load()).rejects.toThrow("WebGPU is not available");
    expect(llm.status).toBe("unsupported");
  });
});

describe("spoken replies", () => {
  it("calls onEnd immediately when synthesis is unavailable", () => {
    let ended = 0;
    const cancel = speak("Hello", { onEnd: () => (ended += 1) });
    expect(ended).toBe(1);
    expect(typeof cancel).toBe("function");
    expect(() => cancel()).not.toThrow();
  });

  it("calls onEnd for an empty string too", () => {
    let ended = 0;
    speak("   ", { onEnd: () => (ended += 1) });
    expect(ended).toBe(1);
  });

  function installSynthesis() {
    const spoken: Array<{ text: string; onstart?: () => void; onend?: () => void }> = [];
    const synth = {
      getVoices: () => [{ name: "Samantha", lang: "en-US" }],
      speak: (u: { text: string; onstart?: () => void; onend?: () => void }) => {
        spoken.push(u);
        u.onstart?.();
        u.onend?.();
      },
      cancel: vi.fn(),
      resume: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    class FakeUtterance {
      text: string;
      lang = "";
      rate = 1;
      pitch = 1;
      volume = 1;
      voice: unknown = null;
      onstart?: () => void;
      onend?: () => void;
      onerror?: () => void;
      constructor(text: string) {
        this.text = text;
      }
    }
    vi.stubGlobal("window", {
      speechSynthesis: synth,
      setTimeout: (fn: () => void, ms?: number) => globalThis.setTimeout(fn, ms),
      clearTimeout: (id: number) => globalThis.clearTimeout(id),
    });
    vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
    return spoken;
  }

  it("speaks the text and reports start and end", async () => {
    vi.useFakeTimers();
    const spoken = installSynthesis();
    let started = 0;
    let ended = 0;
    const cancel = speak("Hello there.", {
      onStart: () => (started += 1),
      onEnd: () => (ended += 1),
    });
    await vi.runAllTimersAsync();
    expect(started).toBe(1);
    expect(ended).toBe(1);
    expect(spoken).toHaveLength(1);
    expect(spoken[0].text).toBe("Hello there.");
    expect(() => cancel()).not.toThrow();
  });

  it("splits a long answer into several utterances", async () => {
    vi.useFakeTimers();
    const spoken = installSynthesis();
    const text = Array.from({ length: 8 }, (_, i) => `Sentence number ${i} with some words.`).join(" ");
    speak(text);
    await vi.runAllTimersAsync();
    expect(spoken.length).toBeGreaterThan(1);
    expect(spoken.map((u) => u.text).join(" ")).toContain("Sentence number 0");
  });

  it("does not speak after it is cancelled", async () => {
    vi.useFakeTimers();
    const spoken = installSynthesis();
    let ended = 0;
    const cancel = speak("Hello there.", { onEnd: () => (ended += 1) });
    cancel();
    await vi.runAllTimersAsync();
    expect(spoken).toHaveLength(0);
    expect(ended).toBe(0);
  });
});

describe("careSystemPrompt", () => {
  const full = {
    displayName: "Asha Rao",
    age: 71,
    conditions: [{ name: "Hypertension" }, { name: "Type 2 diabetes" }],
    medications: [{ name: "Metformin", dose: "500 mg" }, { name: "Amlodipine" }],
    allergies: [{ substance: "Penicillin" }],
    carePlan: "Monitor blood pressure twice daily.",
  };

  it("describes the patient, conditions, medications and allergies", () => {
    const prompt = careSystemPrompt(full);
    expect(prompt).toContain("CareSpeak");
    expect(prompt).toContain("NOT a doctor");
    expect(prompt).toContain("Asha Rao");
    expect(prompt).toContain("age 71");
    expect(prompt).toContain("Hypertension, Type 2 diabetes");
    expect(prompt).toContain("Metformin 500 mg, Amlodipine");
    expect(prompt).toContain("Allergies: Penicillin.");
    expect(prompt).toContain("Care plan: Monitor blood pressure twice daily.");
    expect(prompt).toContain("red-flag symptom");
    expect(prompt).toContain("emergency services");
  });

  it("falls back to honest empty values and omits a missing care plan", () => {
    const prompt = careSystemPrompt({
      displayName: "Ravi",
      age: null,
      conditions: [],
      medications: [],
      allergies: [],
    });
    expect(prompt).toContain("age unknown");
    expect(prompt).toContain("Active conditions: none recorded.");
    expect(prompt).toContain("Medications: none recorded.");
    expect(prompt).toContain("Allergies: none recorded.");
    expect(prompt).not.toContain("Care plan:");
  });
});
