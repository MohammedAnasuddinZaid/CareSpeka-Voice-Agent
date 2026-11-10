import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/alertSounds", () => ({ playAlertSound: vi.fn() }));

import { playAlertSound } from "@/lib/alertSounds";
import { subscribeUiLanguage } from "@/lib/i18n";
import {
  VoiceAlert,
  getDescription,
  getSavedLanguage,
  loadTTSConfig,
  saveLanguage,
  saveTTSConfig,
} from "@/lib/tts";
import { LANGUAGE_DESCRIPTIONS } from "@/types";

const alertSound = vi.mocked(playAlertSound);

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, String(v));
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

interface Utterance {
  text: string;
  lang: string;
  rate: number;
  pitch: number;
  volume: number;
  voice: unknown;
  onstart?: () => void;
  onend?: () => void;
  onerror?: () => void;
}

const voiceList = [
  { name: "Samantha", lang: "en-US" },
  { name: "Daniel", lang: "en-GB" },
];

const spoken: Utterance[] = [];
const synth = {
  getVoices: () => voiceList,
  speak: (u: Utterance) => {
    spoken.push(u);
    u.onstart?.();
    u.onend?.();
  },
  cancel: vi.fn(),
  resume: vi.fn(),
  onvoiceschanged: null as null | (() => void),
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

function install(initial: Record<string, string> = {}) {
  const storage = memoryStorage(initial);
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", { localStorage: storage, speechSynthesis: synth });
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
  vi.stubGlobal("navigator", { onLine: true });
  return storage;
}

/** Let the single-flight pump finish its awaits. */
async function settle(): Promise<void> {
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
}

beforeEach(() => {
  spoken.length = 0;
  synth.cancel.mockClear();
  synth.resume.mockClear();
  alertSound.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("language persistence", () => {
  it("defaults to English without a window", () => {
    expect(getSavedLanguage()).toBe("en-US");
    expect(() => saveLanguage("hi-IN")).not.toThrow();
  });

  it("restores a saved supported language", () => {
    install({ carespeak_language: "hi-IN" });
    expect(getSavedLanguage()).toBe("hi-IN");
  });

  it("ignores an unsupported stored value", () => {
    install({ carespeak_language: "xx-XX" });
    expect(getSavedLanguage()).toBe("en-US");
  });

  it("saves the chosen language", () => {
    const storage = install();
    saveLanguage("ta-IN");
    expect(storage.getItem("carespeak_language")).toBe("ta-IN");
  });

  it("survives a storage exception", () => {
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => undefined,
      clear: () => undefined,
      key: () => null,
      length: 0,
    } as unknown as Storage;
    vi.stubGlobal("localStorage", throwing);
    vi.stubGlobal("window", { localStorage: throwing });
    expect(getSavedLanguage()).toBe("en-US");
    expect(() => saveLanguage("hi-IN")).not.toThrow();
  });
});

describe("tts config", () => {
  it("returns documented defaults without a window", () => {
    expect(loadTTSConfig()).toEqual({
      enabled: true,
      rate: 0.85,
      pitch: 1,
      volume: 1,
      language: "en-US",
    });
    expect(() => saveTTSConfig({ enabled: false, rate: 1, pitch: 1, volume: 1, language: "en-US" })).not.toThrow();
  });

  it("merges a stored partial config over the defaults", () => {
    install({ carespeak_tts_config: JSON.stringify({ rate: 1.1, enabled: false }) });
    expect(loadTTSConfig()).toEqual({
      enabled: false,
      rate: 1.1,
      pitch: 1,
      volume: 1,
      language: "en-US",
    });
  });

  it("falls back to defaults for corrupt stored JSON", () => {
    install({ carespeak_tts_config: "not json" });
    expect(loadTTSConfig().rate).toBe(0.85);
  });

  it("returns a fresh object each time so callers cannot mutate defaults", () => {
    install();
    const first = loadTTSConfig();
    first.rate = 9.9;
    expect(loadTTSConfig().rate).toBe(0.85);
  });

  it("persists a full config", () => {
    const storage = install();
    const cfg = { enabled: false, rate: 0.5, pitch: 1.2, volume: 0.7, language: "bn-IN" as const };
    saveTTSConfig(cfg);
    expect(JSON.parse(storage.getItem("carespeak_tts_config")!)).toEqual(cfg);
  });
});

describe("getDescription", () => {
  it("returns the recorded English description", () => {
    expect(getDescription("HELP", "en-US")).toBe(LANGUAGE_DESCRIPTIONS["en-US"].HELP);
  });

  it("localises the description", () => {
    const hindi = getDescription("HELP", "hi-IN");
    expect(hindi).toBe(LANGUAGE_DESCRIPTIONS["hi-IN"].HELP);
    expect(hindi).not.toBe(LANGUAGE_DESCRIPTIONS["en-US"].HELP);
  });

  it("falls back to English for an unknown language", () => {
    expect(getDescription("HELP", "xx-XX" as never)).toBe(LANGUAGE_DESCRIPTIONS["en-US"].HELP);
  });

  it("returns the raw name for an unknown gesture", () => {
    expect(getDescription("SOMETHING", "en-US")).toBe("SOMETHING");
    expect(getDescription("SOMETHING", "hi-IN")).toBe("SOMETHING");
  });
});

describe("VoiceAlert configuration", () => {
  it("adopts the saved language on construction", () => {
    install({ carespeak_language: "bn-IN" });
    expect(new VoiceAlert().getLanguage()).toBe("bn-IN");
  });

  it("persists enabled and disabled state", () => {
    const storage = install();
    const alert = new VoiceAlert();
    alert.setEnabled(false);
    expect(storage.getItem("carespeak_tts_config")).toContain('"enabled":false');
  });

  it("persists a language change, notifies the UI and greets", async () => {
    const storage = install();
    const alert = new VoiceAlert();
    const notified = vi.fn();
    const unsubscribe = subscribeUiLanguage(notified);

    alert.setLanguage("hi-IN");
    expect(alert.getLanguage()).toBe("hi-IN");
    expect(storage.getItem("carespeak_language")).toBe("hi-IN");
    expect(storage.getItem("carespeak_tts_config")).toContain('"language":"hi-IN"');
    expect(notified).toHaveBeenCalledTimes(1);

    await settle();
    const greeting = spoken.find((u) => u.lang === "hi-IN");
    expect(greeting).toBeDefined();
    expect(greeting!.text).not.toBe("Hello, this is CareSpeak. How can I help you?");
    unsubscribe();
  });
});

describe("VoiceAlert speaking", () => {
  it("announces a gesture with its description and alert tone", async () => {
    install();
    const alert = new VoiceAlert();
    alert.speak("HELP");

    await settle();
    expect(alertSound).toHaveBeenCalledWith("HELP");
    expect(spoken).toHaveLength(1);
    expect(spoken[0].text).toBe(LANGUAGE_DESCRIPTIONS["en-US"].HELP);
    expect(spoken[0].lang).toBe("en-US");
    expect(spoken[0].voice).toMatchObject({ name: "Samantha" });
    expect(synth.resume).toHaveBeenCalled();
  });

  it("does not play a tone for a non-alert gesture", async () => {
    install();
    new VoiceAlert().speak("WATER");
    await settle();
    expect(alertSound).not.toHaveBeenCalled();
    expect(spoken).toHaveLength(1);
    expect(spoken[0].text).toBe(LANGUAGE_DESCRIPTIONS["en-US"].WATER);
  });

  it("honours the sound toggle while still speaking", async () => {
    install();
    const alert = new VoiceAlert();
    alert.setSoundEnabled(false);
    alert.speak("EMERGENCY");
    await settle();
    expect(alertSound).not.toHaveBeenCalled();
    expect(spoken).toHaveLength(1);
  });

  it("is completely silent when disabled", async () => {
    install();
    const alert = new VoiceAlert();
    alert.setEnabled(false);
    alert.speak("HELP");
    alert.speakDirect("hello");
    alert.replay("HELP");
    await settle();
    expect(spoken).toHaveLength(0);
    expect(alertSound).not.toHaveBeenCalled();
  });

  it("applies the documented rate and volume", async () => {
    install({ carespeak_tts_config: JSON.stringify({ rate: 0.6, pitch: 1.3, volume: 0.4 }) });
    new VoiceAlert().speak("YES");
    await settle();
    expect(spoken[0]).toMatchObject({ rate: 0.6, pitch: 1.3, volume: 0.4 });
  });

  it("speaks direct text as-is", async () => {
    install();
    new VoiceAlert().speakDirect("Please wait a moment.");
    await settle();
    expect(spoken[0].text).toBe("Please wait a moment.");
  });

  it("ignores empty text", async () => {
    install();
    const alert = new VoiceAlert();
    alert.speakDirect("   ");
    await settle();
    expect(spoken).toHaveLength(0);
  });

  it("replays a localised gesture description", async () => {
    install();
    new VoiceAlert().replay("HELP");
    await settle();
    expect(spoken[0].text).toBe(LANGUAGE_DESCRIPTIONS["en-US"].HELP);
  });

  it("replays unknown text verbatim", async () => {
    install();
    new VoiceAlert().replay("This is a raw sentence.");
    await settle();
    expect(spoken[0].text).toBe("This is a raw sentence.");
  });
});

describe("VoiceAlert cooldown", () => {
  it("suppresses a repeat of the same gesture inside the window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    install();
    const alert = new VoiceAlert(4000);

    alert.speak("HELP");
    alert.speak("HELP");
    await settle();
    expect(spoken).toHaveLength(1);

    vi.setSystemTime(1_003_999);
    alert.speak("HELP");
    await settle();
    expect(spoken).toHaveLength(1);

    vi.setSystemTime(1_004_000);
    alert.speak("HELP");
    await settle();
    expect(spoken).toHaveLength(2);
  });

  it("lets a different gesture speak immediately", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    install();
    const alert = new VoiceAlert(4000);
    alert.speak("HELP");
    alert.speak("YES");
    await settle();
    expect(spoken).toHaveLength(2);
  });

  it("never suppresses EMERGENCY", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    install();
    const alert = new VoiceAlert(60_000);
    alert.speak("EMERGENCY");
    alert.speak("EMERGENCY");
    await settle();
    expect(spoken).toHaveLength(2);
    expect(alertSound).toHaveBeenCalledTimes(2);
  });

  it("clears one gesture or all gestures on reset", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    install();
    const alert = new VoiceAlert(60_000);
    alert.speak("HELP");
    alert.speak("YES");
    await settle();

    alert.resetGesture("HELP");
    alert.speak("HELP");
    await settle();
    expect(spoken).toHaveLength(3);

    alert.resetGesture();
    alert.speak("YES");
    await settle();
    expect(spoken).toHaveLength(4);
  });
});

describe("VoiceAlert fallbacks and stop", () => {
  it("speaks the English fallback when a native voice is missing offline", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    install();
    const alert = new VoiceAlert();
    alert.setLanguage("hi-IN");
    await settle();
    spoken.length = 0;

    alert.speak("HELP");
    await settle();
    // Native Hindi text had no installed voice, so the English description is
    // spoken with an English voice rather than staying silent.
    expect(spoken[0].text).toBe(LANGUAGE_DESCRIPTIONS["en-US"].HELP);
    expect(spoken[0].lang).toBe("en-US");
    expect(spoken[0].voice).toMatchObject({ name: "Samantha" });
  });

  it("uses remote TTS for a missing native voice when online", async () => {
    const played: string[] = [];
    class FakeAudio {
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public src: string) {
        played.push(src);
      }
      play() {
        // Resolve on the next microtask, like a real element.
        void Promise.resolve().then(() => this.onended?.());
        return Promise.resolve();
      }
    }
    vi.stubGlobal("Audio", FakeAudio);
    install();

    const alert = new VoiceAlert();
    alert.setLanguage("hi-IN");
    await settle();
    played.length = 0;
    spoken.length = 0;

    alert.speak("HELP");
    await settle();

    expect(played).toHaveLength(1);
    expect(played[0]).toContain("translate_tts");
    expect(played[0]).toContain("tl=hi");
    expect(played[0]).toContain("ttsspeed=0.9");
    // The remote stream is the answer: no local utterance was queued.
    expect(spoken).toHaveLength(0);
  });

  it("caps remote text at 190 characters", async () => {
    const played: string[] = [];
    class FakeAudio {
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public src: string) {
        played.push(src);
      }
      play() {
        void Promise.resolve().then(() => this.onended?.());
        return Promise.resolve();
      }
    }
    vi.stubGlobal("Audio", FakeAudio);
    install();
    const alert = new VoiceAlert();
    alert.setLanguage("ta-IN");
    await settle();
    played.length = 0;

    alert.speakDirect("x".repeat(500), "ta-IN");
    await settle();
    const q = new URL(played[0]).searchParams.get("q")!;
    expect(q).toHaveLength(190);
  });

  it("stops the queue and cancels synthesis", async () => {
    install();
    const alert = new VoiceAlert();
    alert.speak("YES");
    alert.speak("NO");
    alert.stop();
    await settle();
    expect(synth.cancel).toHaveBeenCalled();
    expect(spoken).toHaveLength(0);
  });
});