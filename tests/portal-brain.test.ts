import { beforeEach, describe, expect, it } from "vitest";
import {
  analyzeSignals,
  alertPortal,
  askPortal,
  buildPortalContext,
  linkPortalSession,
  metricsBucket,
  rulesAlertLine,
  severityRank,
  worstSeverity,
} from "@/lib/care/portalBrain";
import {
  addRecord,
  buildRecordContext,
  createSession,
  deleteRecord,
  getRecord,
  getSessionLink,
  linkSessionToPatient,
  listRecords,
  RECORD_MAX_CHARS,
} from "@/lib/care/repo";
import { getSeedPatient } from "@/lib/care/seedPatients";
import { resetDriverForTests } from "@/lib/care/store";
import { getSessionStore } from "@/lib/server/store";

beforeEach(() => {
  resetDriverForTests();
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_MODEL;
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
});

describe("signal analysis", () => {
  it("reports nothing when there are no readings", () => {
    expect(analyzeSignals(null)).toEqual([]);
    expect(analyzeSignals(undefined, null)).toEqual([]);
    expect(worstSeverity([])).toBe("ok");
  });

  it("flags the published alertness floor and grades it", () => {
    const warning = analyzeSignals({ alertnessScore: 20 });
    expect(warning.map((f) => f.key)).toContain("low_alertness");
    expect(warning[0].severity).toBe("warning");

    const critical = analyzeSignals({ alertnessScore: 10 });
    expect(critical[0].severity).toBe("critical");
    expect(critical[0].reading).toBe("10%");
  });

  it("flags blink rate, eye closure and movement", () => {
    const keys = analyzeSignals({
      blinkRate: 3,
      eyeClosureDuration: 4200,
      movementActivity: 0.01,
    }).map((f) => f.key);
    expect(keys).toEqual(expect.arrayContaining(["low_blink", "eye_closure", "low_movement"]));

    const longClosure = analyzeSignals({ eyeClosureDuration: 12_000 })[0];
    expect(longClosure.severity).toBe("critical");
    expect(longClosure.reading).toBe("12.0s");
  });

  it("flags wearable emergencies without inventing values", () => {
    const findings = analyzeSignals(null, {
      deviceId: "esp32-1",
      sosActive: true,
      spo2: 88,
      heartRate: 160,
      temperature: 39.2,
      receivedAt: Date.now(),
    });
    expect(findings.map((f) => f.key)).toEqual(expect.arrayContaining(["sos", "spo2", "heart_rate", "temperature"]));
    expect(findings.every((f) => f.severity === "critical")).toBe(true);
    // sorted worst-first
    expect(severityRank(findings[0].severity)).toBe(3);
  });

  it("worstSeverity returns the most severe finding", () => {
    const findings = analyzeSignals({
      alertnessScore: 10, // critical
      blinkRate: 3, // watch
    });
    expect(worstSeverity(findings)).toBe("critical");
  });
});

describe("metrics bucket", () => {
  it("is stable under small sensor jitter", () => {
    const a = metricsBucket({ alertnessScore: 18.2, blinkRate: 6.1, eyeClosureDuration: 4200, movementActivity: 0.051 });
    const b = metricsBucket({ alertnessScore: 17.8, blinkRate: 6.3, eyeClosureDuration: 4300, movementActivity: 0.052 });
    expect(a).toBe(b);
  });

  it("distinguishes materially different states", () => {
    const a = metricsBucket({ alertnessScore: 80 });
    const b = metricsBucket({ alertnessScore: 10 });
    expect(a).not.toBe(b);
    expect(metricsBucket(null)).toBe("none");
  });
});

describe("rules alert line", () => {
  it("is empty when nothing crosses a threshold", () => {
    expect(rulesAlertLine(getSeedPatient("pt_0001")!, [])).toBe("");
  });

  it("names the patient and the worst reading", () => {
    const patient = getSeedPatient("pt_0001")!;
    const findings = analyzeSignals({ alertnessScore: 12, blinkRate: 1 });
    const line = rulesAlertLine(patient, findings);
    expect(line).toContain(patient.displayName);
    expect(line).toContain("alertness");
    expect(line).toContain("12%");
    expect(line).toContain("blink rate");
  });
});

describe("inserted records", () => {
  it("stores, lists and deletes records per patient", async () => {
    const one = await addRecord({
      patientId: "pt_0001",
      title: "  Discharge summary  ",
      source: "Hospital",
      text: "  Furosemide 40mg OD. Penicillin allergy.  ",
    });
    expect(one.title).toBe("Discharge summary");
    expect(one.text).toBe("Furosemide 40mg OD. Penicillin allergy.");
    expect(one.chars).toBe(one.text.length);

    const two = await addRecord({ patientId: "pt_0001", title: "Lab report", text: "Na 138" });
    await addRecord({ patientId: "pt_0002", title: "Other patient", text: "ignore" });

    const forOne = await listRecords("pt_0001");
    expect(forOne.map((r) => r.id)).toEqual([two.id, one.id]); // newest first
    expect((await listRecords()).length).toBe(3);

    expect((await getRecord(one.id))?.title).toBe("Discharge summary");
    expect(await deleteRecord(one.id)).toBe(true);
    expect(await getRecord(one.id)).toBeNull();
    expect((await listRecords("pt_0001")).map((r) => r.id)).toEqual([two.id]);
    expect(await deleteRecord("missing")).toBe(false);
  });

  it("caps title and body length", async () => {
    const record = await addRecord({
      patientId: "pt_0001",
      title: "x".repeat(400),
      text: "y".repeat(RECORD_MAX_CHARS + 500),
    });
    expect(record.title.length).toBe(160);
    expect(record.chars).toBe(RECORD_MAX_CHARS);
  });

  it("builds a bounded, labelled context newest-first", async () => {
    await addRecord({ patientId: "pt_0001", title: "Older", text: "a".repeat(100) });
    await addRecord({ patientId: "pt_0001", title: "Newer", source: "Lab", text: "b".repeat(100) });

    const ctx = await buildRecordContext("pt_0001");
    expect(ctx.used.map((r) => r.title)).toEqual(["Newer", "Older"]);
    expect(ctx.text).toContain("### Newer (Lab)");
    expect(ctx.omitted).toBe(0);

    const tiny = await buildRecordContext("pt_0001", 150);
    expect(tiny.used.length).toBeLessThan(2);
    expect(tiny.omitted).toBeGreaterThan(0);
    expect(tiny.text.length).toBeLessThanOrEqual(200);
  });
});

describe("session linking", () => {
  it("links a session to a real patient and rejects an unknown one", async () => {
    expect(await linkPortalSession("LINK01", "nope")).toBeNull();
    expect(await getSessionLink("LINK01")).toBeNull();

    const link = await linkPortalSession("LINK01", "pt_0001", "Nurse Demo");
    expect(link?.patientId).toBe("pt_0001");
    expect((await getSessionLink("LINK01"))?.linkedBy).toBe("Nurse Demo");

    // direct repo helper stays consistent
    await linkSessionToPatient("LINK02", "pt_0002");
    expect((await getSessionLink("LINK02"))?.patientId).toBe("pt_0002");
  });
});

describe("portal context + answering", () => {
  it("is honest when no patient is linked", async () => {
    const ctx = await buildPortalContext("EMPTY1");
    expect(ctx.patient).toBeNull();
    expect(ctx.records).toEqual([]);
    expect(ctx.findings).toEqual([]);

    const answer = await askPortal("EMPTY1", "who is this?");
    expect(answer.engine).toBe("rules");
    expect(answer.patientId).toBeNull();
    expect(answer.answer.toLowerCase()).toContain("no patient is linked");
  });

  it("uses the session's own patient before the nurse links one", async () => {
    const { session } = await createSession({
      patientId: "pt_0001",
      nurseId: "nurse.demo",
      nurseName: "Nurse Demo",
    });
    // API routes normalise ids to uppercase; the row itself is lowercase.
    const ctx = await buildPortalContext(session.id.toUpperCase());
    expect(ctx.patient?.id).toBe("pt_0001");
    expect(ctx.link?.patientId).toBe("pt_0001");
    expect(ctx.suggestedQuestions.length).toBeGreaterThan(0);
    expect((await askPortal(session.id.toUpperCase(), "who is this?")).patientId).toBe("pt_0001");
  });

  it("reads live metrics from the session store and reports them", async () => {    await linkSessionToPatient("LIVE01", "pt_0001");
    const store = await getSessionStore();
    await store.setMetrics("LIVE01", "cam1", { alertnessScore: 12, blinkRate: 1, movementActivity: 0.01 });

    const ctx = await buildPortalContext("LIVE01");
    expect(ctx.patient?.id).toBe("pt_0001");
    expect(ctx.worst).toBe("critical");
    expect(ctx.findings.map((f) => f.key)).toContain("low_alertness");

    const alert = await alertPortal("LIVE01");
    expect(alert.line.length).toBeGreaterThan(0);
    expect(alert.severity).toBe("critical");
    expect(alert.engine).toBe("rules"); // no key configured in tests
    expect(alert.findings.length).toBeGreaterThan(0);
  });

  it("answers structured record questions deterministically and caches them", async () => {
    await linkSessionToPatient("ASK01", "pt_0001");
    const patient = getSeedPatient("pt_0001")!;

    const first = await askPortal("ASK01", `What medications is ${patient.displayName} on?`);
    expect(first.engine).toBe("rules");
    expect(first.patientId).toBe("pt_0001");
    expect(first.answer.length).toBeGreaterThan(0);

    const second = await askPortal("ASK01", `What medications is ${patient.displayName} on?`);
    expect(second.cached).toBe(true);
    expect(second.answer).toBe(first.answer);
  });

  it("returns an empty alert when every reading is inside its threshold", async () => {
    await linkSessionToPatient("CALM01", "pt_0001");
    const store = await getSessionStore();
    await store.setMetrics("CALM01", "cam1", { alertnessScore: 90, blinkRate: 15, eyeClosureDuration: 300, movementActivity: 0.4 });

    const alert = await alertPortal("CALM01");
    expect(alert.line).toBe("");
    expect(alert.severity).toBe("ok");
  });
});