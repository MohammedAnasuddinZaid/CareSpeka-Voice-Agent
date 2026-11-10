import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuditEvent,
  auditToCsv,
  clearAuditLog,
  loadAuditLog,
  recordAudit,
} from "@/lib/auditTrail";

const KEY = "carespeak_audit_log";

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  const store = {
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
  return { store, map };
}

function install(initial: Record<string, string> = {}) {
  const { store, map } = memoryStorage(initial);
  vi.stubGlobal("window", { localStorage: store });
  vi.stubGlobal("localStorage", store);
  return map;
}

function throwingStorage(): Storage {
  return {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
    removeItem: () => {
      throw new Error("denied");
    },
    clear: () => undefined,
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

function event(partial: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: "aud_1",
    at: 1_700_000_000_000,
    kind: "auto_escalate",
    detail: "Auto-escalated HELP — repeated calls",
    ...partial,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("server rendering", () => {
  it("returns an empty log without a window", () => {
    expect(loadAuditLog()).toEqual([]);
  });

  it("returns the event without throwing when it cannot persist", () => {
    const event = recordAudit("alarm_state", "Siren muted");
    expect(event.kind).toBe("alarm_state");
    expect(event.detail).toBe("Siren muted");
    expect(event.at).toBe(1_700_000_000_000);
  });
});

describe("recordAudit", () => {
  it("persists a new event at the front with a prefixed unique id", () => {
    const map = install();
    const event = recordAudit("trajectory_alert", "Deterioration forecast crossed the warning band");

    expect(event.id).toMatch(/^aud_\d+_[a-z0-9]+$/);
    expect(map.get(KEY)).toBe(JSON.stringify([event]));

    const second = recordAudit("alarm_state", "Siren armed");
    const stored = JSON.parse(map.get(KEY)!) as AuditEvent[];
    expect(stored.map((e) => e.id)).toEqual([second.id, event.id]);
  });

  it("only includes sessionId and citation when supplied", () => {
    install();
    const bare = recordAudit("alarm_state", "Muted");
    expect(bare).not.toHaveProperty("sessionId");
    expect(bare).not.toHaveProperty("citation");

    const full = recordAudit("auto_escalate", "Escalated", {
      sessionId: "AB12CD",
      citation: { docId: "CS-ADVISORY", section: "help-frequency" },
    });
    expect(full.sessionId).toBe("AB12CD");
    expect(full.citation).toEqual({ docId: "CS-ADVISORY", section: "help-frequency" });
  });

  it("ignores an empty sessionId and keeps the record clean", () => {
    install();
    expect(recordAudit("alarm_state", "Muted", { sessionId: "" })).not.toHaveProperty("sessionId");
  });

  it("caps the stored trail at 300 newest events", () => {
    const map = install();
    for (let i = 0; i < 305; i += 1) recordAudit("pairing_scan", `scan-${i}`);

    const stored = JSON.parse(map.get(KEY)!) as AuditEvent[];
    expect(stored).toHaveLength(300);
    expect(stored[0].detail).toBe("scan-304");
    expect(stored[299].detail).toBe("scan-5");
  });

  it("never throws when storage is failing", () => {
    vi.stubGlobal("window", { localStorage: throwingStorage() });
    vi.stubGlobal("localStorage", throwingStorage());
    expect(() => recordAudit("alarm_state", "Muted")).not.toThrow();
    expect(loadAuditLog()).toEqual([]);
  });
});

describe("loadAuditLog validation", () => {
  it("returns [] for missing or corrupt storage", () => {
    install();
    expect(loadAuditLog()).toEqual([]);

    const map = install({ [KEY]: "{not json" });
    expect(loadAuditLog()).toEqual([]);
    expect(map.has(KEY)).toBe(true);
  });

  it("returns [] instead of a non-array JSON value", () => {
    for (const value of ["null", "42", '"text"', "{}"]) {
      install({ [KEY]: value });
      const log = loadAuditLog();
      expect(Array.isArray(log)).toBe(true);
      expect(log).toEqual([]);
    }
  });

  it("drops malformed entries but keeps valid ones", () => {
    const good = event();
    install({
      [KEY]: JSON.stringify([good, null, "junk", 7, { id: "missing-fields" }]),
    });
    expect(loadAuditLog()).toEqual([good]);
  });
});

describe("clearAuditLog", () => {
  it("removes the trail", () => {
    const map = install();
    recordAudit("alarm_state", "Muted");
    expect(map.has(KEY)).toBe(true);
    clearAuditLog();
    expect(map.has(KEY)).toBe(false);
  });

  it("is safe without a window or with failing storage", () => {
    expect(() => clearAuditLog()).not.toThrow();
    vi.stubGlobal("window", { localStorage: throwingStorage() });
    vi.stubGlobal("localStorage", throwingStorage());
    expect(() => clearAuditLog()).not.toThrow();
  });
});

describe("auditToCsv", () => {
  it("emits a header and one quoted row per event", () => {
    const csv = auditToCsv([
      event({ id: "aud_1", kind: "auto_escalate", detail: "Escalated", sessionId: "AB12CD" }),
      event({ id: "aud_2", kind: "pairing_scan", detail: "Linked" }),
    ]);
    const lines = csv.split("\n");

    expect(lines[0]).toBe("id,time_iso,kind,detail,session,citation");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe(
      `"aud_1","2023-11-14T22:13:20.000Z","Auto-escalation","Escalated","AB12CD",""`
    );
    expect(lines[2]).toContain(`"QR pairing"`);
    expect(lines[2].endsWith(`,""`)).toBe(true);
  });

  it("renders the citation short form plus its full passage", () => {
    const csv = auditToCsv([
      event({ citation: { docId: "RCP-NEWS2", section: "spo2-scale1" } }),
    ]);
    expect(csv).toContain("RCP-NEWS2§spo2-scale1");
    // The corpus writes "SpO₂" with a subscript two.
    expect(csv).toContain("SpO\u2082 (Scale 1) parameter");
  });

  it("neutralises spreadsheet formula injection in every cell", () => {
    const csv = auditToCsv([
      event({ id: "=1+1", detail: "@SUM(A1)", sessionId: "+42" }),
    ]);
    const row = csv.split("\n")[1];
    expect(row).toContain(`"'=1+1"`);
    expect(row).toContain(`"'@SUM(A1)"`);
    expect(row).toContain(`"'+42"`);
    expect(row).not.toMatch(/(^|,)"=/);
  });

  it("doubles embedded quotes so the CSV stays parseable", () => {
    const csv = auditToCsv([event({ detail: 'Said "help" loudly' })]);
    expect(csv).toContain(`"Said ""help"" loudly"`);
  });

  it("falls back to the bare citation for an unknown document", () => {
    const csv = auditToCsv([
      event({ citation: { docId: "UNKNOWN-DOC", section: "s1" } }),
    ]);
    // Unknown docs have no passage, so the cell carries only the short form.
    expect(csv).toContain("UNKNOWN-DOC§s1");
    expect(csv.trimEnd().endsWith(`"`)).toBe(true);
  });

  it("returns just the header for an empty trail", () => {
    expect(auditToCsv([])).toBe("id,time_iso,kind,detail,session,citation");
  });
});