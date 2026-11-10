import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { playAlertSound } from "@/lib/alertSounds";
import { isAlarmMuted, setAlarmMuted, startAlarm, stopAlarm } from "@/lib/nurseAlarm";

interface FrequencyLike {
  value: number;
  calls: Array<[string, number, number, number?]>;
  setValueAtTime: (v: number, t: number) => void;
  linearRampToValueAtTime: (v: number, t: number) => void;
  exponentialRampToValueAtTime: (v: number, t: number) => void;
  setTargetAtTime: (v: number, t: number, c: number) => void;
}

interface ParamsLike {
  value: number;
  calls: Array<[string, number, number, number?]>;
  setValueAtTime: (v: number, t: number) => void;
  linearRampToValueAtTime: (v: number, t: number) => void;
  exponentialRampToValueAtTime: (v: number, t: number) => void;
  setTargetAtTime: (v: number, t: number, c: number) => void;
}

function param(): ParamsLike {
  return {
    value: 0,
    calls: [],
    setValueAtTime(v, t) {
      this.calls.push(["set", v, t]);
    },
    linearRampToValueAtTime(v, t) {
      this.calls.push(["linear", v, t]);
    },
    exponentialRampToValueAtTime(v, t) {
      this.calls.push(["exp", v, t]);
    },
    setTargetAtTime(v, t, c) {
      this.calls.push(["target", v, t, c]);
    },
  };
}

function frequencyParam(): FrequencyLike {
  return {
    value: 0,
    calls: [],
    setValueAtTime(v, t) {
      this.calls.push(["set", v, t]);
    },
    linearRampToValueAtTime(v, t) {
      this.calls.push(["linear", v, t]);
    },
    exponentialRampToValueAtTime(v, t) {
      this.calls.push(["exp", v, t]);
    },
    setTargetAtTime(v, t, c) {
      this.calls.push(["target", v, t, c]);
    },
  };
}

interface FakeOsc {
  type: string;
  frequency: FrequencyLike;
  connect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

interface FakeGain {
  gain: ParamsLike;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

/**
 * One shared fake audio graph for the whole file: both modules memoise their
 * AudioContext at module scope, so a fresh object per test would be ignored.
 * Counters are reset in `beforeEach`.
 */
const rec = {
  constructors: 0,
  resumes: 0,
  oscillators: [] as FakeOsc[],
  gains: [] as FakeGain[],
  state: "running" as AudioContextState,
};

const fakeCtx = {
  get state() {
    return rec.state;
  },
  currentTime: 10,
  destination: { label: "destination" },
  createOscillator() {
    const osc: FakeOsc = {
      type: "",
      frequency: frequencyParam(),
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      disconnect: vi.fn(),
    };
    rec.oscillators.push(osc);
    return osc;
  },
  createGain() {
    const gain: FakeGain = { gain: param(), connect: vi.fn(), disconnect: vi.fn() };
    rec.gains.push(gain);
    return gain;
  },
  resume() {
    rec.resumes += 1;
    return Promise.resolve();
  },
};

class FakeAudioContext {
  constructor() {
    rec.constructors += 1;
    return fakeCtx as unknown as FakeAudioContext;
  }
}

class ThrowingAudioContext {
  constructor() {
    rec.constructors += 1;
    throw new Error("audio blocked");
  }
}

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

function install(options: {
  audio?: typeof AudioContext | null;
  storage?: Storage;
  withWindow?: boolean;
} = {}) {
  if (options.withWindow === false) return;
  const win: Record<string, unknown> = {};
  if (options.audio) win.AudioContext = options.audio;
  if (options.storage) {
    win.localStorage = options.storage;
    vi.stubGlobal("localStorage", options.storage);
  }
  vi.stubGlobal("window", win);
}

beforeEach(() => {
  // Both modules memoise their graph at module scope; clear any siren left by a
  // previous case before resetting the recorder.
  vi.useRealTimers();
  stopAlarm();
  rec.constructors = 0;
  rec.resumes = 0;
  rec.oscillators = [];
  rec.gains = [];
  rec.state = "running";
});

afterEach(() => {
  stopAlarm();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("playAlertSound", () => {
  it("stays silent instead of throwing when the AudioContext constructor fails", () => {
    install({ audio: ThrowingAudioContext as unknown as typeof AudioContext });
    expect(() => playAlertSound("HELP")).not.toThrow();
    expect(rec.oscillators).toHaveLength(0);
  });

  it("is a no-op without a window", () => {
    expect(() => playAlertSound("HELP")).not.toThrow();
    expect(rec.constructors).toBe(0);
  });

  it("is a no-op when the browser has no Web Audio at all", () => {
    install({ audio: null });
    expect(() => playAlertSound("HELP")).not.toThrow();
    expect(rec.constructors).toBe(0);
  });

  it("plays the HELP tone with a rising sweep", () => {
    install({ audio: FakeAudioContext as unknown as typeof AudioContext });
    playAlertSound("HELP");

    expect(rec.oscillators).toHaveLength(1);
    const [osc] = rec.oscillators;
    expect(osc.type).toBe("sawtooth");
    expect(osc.frequency.calls).toEqual([
      ["set", 660, 10],
      ["set", 660, 10],
      ["linear", 990, 10.3],
    ]);
    expect(rec.gains[0].gain.calls).toEqual([
      ["set", 0.2, 10],
      ["exp", 0.001, 10.3],
    ]);
    expect(osc.start).toHaveBeenCalledWith(10);
    expect(osc.stop).toHaveBeenCalledWith(10.3);
    expect(osc.connect).toHaveBeenCalledWith(rec.gains[0]);
    expect(rec.gains[0].connect).toHaveBeenCalledWith(fakeCtx.destination);
  });

  it("plays the three-chirp EMERGENCY pattern", () => {
    install({ audio: FakeAudioContext as unknown as typeof AudioContext });
    playAlertSound("EMERGENCY");

    // One main tone plus three square chirps.
    expect(rec.oscillators).toHaveLength(4);
    expect(rec.oscillators[0].type).toBe("sawtooth");
    expect(rec.oscillators[0].frequency.calls).toEqual([
      ["set", 330, 10],
      ["set", 330, 10],
      ["linear", 495, 10.5],
    ]);
    expect(rec.gains[0].gain.calls).toEqual([
      ["set", 0.3, 10],
      ["linear", 0, 10.5],
    ]);

    const chirps = rec.oscillators.slice(1);
    expect(chirps.map((o) => o.type)).toEqual(["square", "square", "square"]);
    expect(chirps.map((o) => o.frequency.calls[0])).toEqual([
      ["set", 440, 10],
      ["set", 550, 10.3],
      ["set", 660, 10.6],
    ]);
    expect(chirps.map((o) => o.start.mock.calls[0][0])).toEqual([10, 10.3, 10.6]);
    expect(chirps.map((o) => o.stop.mock.calls[0][0])).toEqual([10.25, 10.55, 10.85]);
    for (const chirp of chirps) expect(chirp.connect).toHaveBeenCalled();
  });

  it("falls back to the EMERGENCY tone for an unknown gesture", () => {
    install({ audio: FakeAudioContext as unknown as typeof AudioContext });
    playAlertSound("SOMETHING_NEW");

    const [osc] = rec.oscillators;
    expect(osc.type).toBe("sawtooth");
    // Unknown names take the gentle (non-emergency) envelope path.
    expect(osc.frequency.calls).toEqual([["set", 330, 10]]);
    expect(rec.gains[0].gain.calls).toEqual([
      ["set", 0.2, 10],
      ["exp", 0.001, 10.5],
    ]);
  });

  it("resumes a suspended context and reuses it for later tones", () => {
    rec.state = "suspended";
    install({ audio: FakeAudioContext as unknown as typeof AudioContext });
    const before = rec.constructors;
    playAlertSound("YES");
    playAlertSound("HELP");

    expect(rec.resumes).toBeGreaterThanOrEqual(1);
    // The context is memoised: no constructor call after the first ever use.
    expect(rec.constructors).toBe(before);
  });
});

describe("alarm mute preference", () => {
  it("reads and writes the persisted flag", () => {
    const storage = memoryStorage();
    install({ storage });
    expect(isAlarmMuted()).toBe(false);
    setAlarmMuted(true);
    expect(isAlarmMuted()).toBe(true);
    expect(storage.getItem("carespeak_alarm_muted")).toBe("1");
    setAlarmMuted(false);
    expect(isAlarmMuted()).toBe(false);
    expect(storage.getItem("carespeak_alarm_muted")).toBe("0");
  });

  it("defaults to unmuted without a window or with failing storage", () => {
    expect(isAlarmMuted()).toBe(false);
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
    install({ storage: throwing });
    expect(isAlarmMuted()).toBe(false);
    expect(() => setAlarmMuted(true)).not.toThrow();
  });
});

describe("startAlarm / stopAlarm", () => {
  it("does nothing without a window", () => {
    expect(() => startAlarm()).not.toThrow();
    expect(rec.constructors).toBe(0);
  });

  it("does nothing when the browser has no Web Audio", () => {
    install({ audio: null, storage: memoryStorage() });
    expect(() => startAlarm()).not.toThrow();
    expect(rec.oscillators).toHaveLength(0);
  });

  it("survives an AudioContext constructor failure", () => {
    install({
      audio: ThrowingAudioContext as unknown as typeof AudioContext,
      storage: memoryStorage(),
    });
    expect(() => startAlarm()).not.toThrow();
    expect(rec.oscillators).toHaveLength(0);
  });

  it("does not sound while the nurse has muted alarms", () => {
    install({
      audio: FakeAudioContext as unknown as typeof AudioContext,
      storage: memoryStorage({ carespeak_alarm_muted: "1" }),
    });
    startAlarm();
    expect(rec.constructors).toBe(0);
    expect(rec.oscillators).toHaveLength(0);
  });

  it("starts a 660 Hz square siren and fades it in", () => {
    vi.useFakeTimers();
    install({
      audio: FakeAudioContext as unknown as typeof AudioContext,
      storage: memoryStorage(),
    });
    startAlarm();

    expect(rec.constructors).toBe(1);
    expect(rec.oscillators).toHaveLength(1);
    const [osc] = rec.oscillators;
    expect(osc.type).toBe("square");
    expect(osc.frequency.value).toBe(660);
    expect(osc.start).toHaveBeenCalledTimes(1);
    expect(rec.gains).toHaveLength(1);
    expect(rec.gains[0].gain.value).toBe(0);
    expect(rec.gains[0].gain.calls).toEqual([["linear", 0.06, 10.15]]);
    expect(rec.gains[0].connect).toHaveBeenCalledWith(fakeCtx.destination);
    expect(osc.connect).toHaveBeenCalledWith(rec.gains[0]);

    vi.advanceTimersByTime(450);
    expect(osc.frequency.calls.at(-1)).toEqual(["target", 620, 10, 0.03]);
    expect(rec.gains[0].gain.calls.at(-1)).toEqual(["target", 0.045, 10, 0.05]);

    vi.advanceTimersByTime(450);
    expect(osc.frequency.calls.at(-1)).toEqual(["target", 880, 10, 0.03]);
    expect(rec.gains[0].gain.calls.at(-1)).toEqual(["target", 0.07, 10, 0.05]);
  });

  it("does not stack a second siren when already sounding", () => {
    vi.useFakeTimers();
    install({
      audio: FakeAudioContext as unknown as typeof AudioContext,
      storage: memoryStorage(),
    });
    startAlarm();
    startAlarm();
    expect(rec.oscillators).toHaveLength(1);
    expect(rec.gains).toHaveLength(1);
  });

  it("stops the interval, fades out and releases the audio nodes", () => {
    vi.useFakeTimers();
    install({
      audio: FakeAudioContext as unknown as typeof AudioContext,
      storage: memoryStorage(),
    });
    startAlarm();
    const [osc] = rec.oscillators;
    const [gain] = rec.gains;
    const before = osc.frequency.calls.length;

    stopAlarm();
    expect(gain.gain.calls.at(-1)).toEqual(["target", 0, 10, 0.05]);
    expect(osc.stop).not.toHaveBeenCalled();

    vi.advanceTimersByTime(200);
    expect(osc.stop).toHaveBeenCalledTimes(1);
    expect(osc.disconnect).toHaveBeenCalledTimes(1);
    expect(gain.disconnect).toHaveBeenCalledTimes(1);

    // The siren interval is gone: no further frequency edits.
    vi.advanceTimersByTime(2000);
    expect(osc.frequency.calls.length).toBe(before);
  });

  it("can restart cleanly after a stop", () => {
    vi.useFakeTimers();
    install({
      audio: FakeAudioContext as unknown as typeof AudioContext,
      storage: memoryStorage(),
    });
    startAlarm();
    stopAlarm();
    vi.advanceTimersByTime(250);
    startAlarm();
    expect(rec.oscillators).toHaveLength(2);
    expect(rec.gains).toHaveLength(2);
    expect(rec.oscillators[1].start).toHaveBeenCalledTimes(1);
  });

  it("muting stops a running siren", () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    install({ audio: FakeAudioContext as unknown as typeof AudioContext, storage });
    startAlarm();
    const [osc] = rec.oscillators;
    setAlarmMuted(true);
    vi.advanceTimersByTime(200);
    expect(osc.stop).toHaveBeenCalledTimes(1);
  });

  it("is safe to stop when nothing is running", () => {
    install({ audio: FakeAudioContext as unknown as typeof AudioContext, storage: memoryStorage() });
    expect(() => stopAlarm()).not.toThrow();
  });
});