import { beforeEach, describe, expect, it } from "vitest";
import {
  buildWebhookUrl,
  checkCooldown,
  emergencyNumbers,
  escapeXml,
  isPublicHttpsUrl,
  normalizePhone,
  resetCooldownsForTests,
  twilioConfigured,
  twimlHangup,
  twimlPrompt,
  voiceSecret,
} from "@/lib/care/voice";
import {
  askPortal,
  buildPortalContext,
  executePortalAction,
  linkPortalSession,
  parsePortalDictation,
  voiceOpening,
} from "@/lib/care/portalBrain";
import { createPatient, getPatient, listMessages, listPatients } from "@/lib/care/repo";
import { getSeedPatient } from "@/lib/care/seedPatients";
import { resetDriverForTests } from "@/lib/care/store";

const PATIENT = getSeedPatient("pt_0001")!;

beforeEach(() => {
  resetDriverForTests();
  resetCooldownsForTests();
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_FROM_NUMBER;
  delete process.env.CARE_VOICE_SECRET;
  delete process.env.CARE_EMERGENCY_PHONE;
  delete process.env.CARE_VOICE_BASE_URL;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_MODEL;
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
});

describe("phone normalisation", () => {
  it("normalises E.164, bare Indian numbers and formatted input", () => {
    expect(normalizePhone("+919849130407")).toBe("+919849130407");
    expect(normalizePhone("9849130407")).toBe("+919849130407");
    expect(normalizePhone(" 98491-30407 ")).toBe("+919849130407");
    expect(normalizePhone("+1 (202) 555-0123")).toBe("+12025550123");
  });

  it("rejects empty and too-short input", () => {
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone("12345")).toBeNull();
  });

  it("splits, normalises and dedupes emergency numbers with a default", () => {
    expect(emergencyNumbers()).toEqual(["+919849130407"]);

    process.env.CARE_EMERGENCY_PHONE = "9849130407, +12025550123; 9849130407";
    expect(emergencyNumbers()).toEqual(["+919849130407", "+12025550123"]);
  });

  it("reports configuration honestly", () => {
    expect(twilioConfigured()).toBe(false);
    process.env.TWILIO_ACCOUNT_SID = "AC123";
    process.env.TWILIO_AUTH_TOKEN = "token";
    process.env.TWILIO_FROM_NUMBER = "12025550123";
    expect(twilioConfigured()).toBe(true);
  });
});

describe("TwiML", () => {
  it("escapes XML-significant characters", () => {
    expect(escapeXml(`<a> & "b" 'c'`)).toBe("&lt;a&gt; &amp; &quot;b&quot; &apos;c&apos;");
  });

  it("speaks a prompt, listens, then hangs up when nobody answers", () => {
    const xml = twimlPrompt("Hello <nurse> & team", "https://x.test/voice?session=AB12&turn=1");
    expect(xml).toContain(`<Say voice="Polly.Aditi" language="en-IN">Hello &lt;nurse&gt; &amp; team</Say>`);
    expect(xml).toContain(`<Gather input="speech"`);
    expect(xml).toContain(`method="POST" action="https://x.test/voice?session=AB12&amp;turn=1"`);
    expect(xml).toContain("<Hangup/>");
    expect(xml.startsWith("<?xml")).toBe(true);
  });

  it("closes a call with a spoken goodbye", () => {
    const xml = twimlHangup("Bye");
    expect(xml).toContain(">Bye</Say>");
    expect(xml.endsWith("<Hangup/></Response>")).toBe(true);
  });

  it("only accepts a public HTTPS webhook base", () => {
    expect(isPublicHttpsUrl("https://carespeak.vercel.app")).toBe(true);
    expect(isPublicHttpsUrl("https://example.trycloudflare.com")).toBe(true);
    expect(isPublicHttpsUrl("http://example.com")).toBe(false);
    expect(isPublicHttpsUrl("https://localhost:3000")).toBe(false);
    expect(isPublicHttpsUrl("https://192.168.1.20")).toBe(false);
    expect(isPublicHttpsUrl("not a url")).toBe(false);
  });

  it("builds the webhook URL and appends an optional secret", () => {
    const plain = buildWebhookUrl("https://care.test/", "AB12", 3);
    expect(plain).toBe("https://care.test/api/care/voice?session=AB12&turn=3");
    expect(voiceSecret()).toBe("");

    process.env.CARE_VOICE_SECRET = "s3cret";
    expect(voiceSecret()).toBe("s3cret");
    const signed = buildWebhookUrl("https://care.test", "AB12", 0);
    expect(signed).toContain("k=s3cret");
  });
});

describe("call cooldown", () => {
  it("allows one dial per window and reports the wait", async () => {
    const first = await checkCooldown("SESS:demo", 20_000);
    expect(first.allowed).toBe(true);

    const second = await checkCooldown("SESS:demo", 20_000);
    expect(second.allowed).toBe(false);
    expect(second.retryAfterMs).toBeGreaterThan(0);
    expect(second.retryAfterMs).toBeLessThanOrEqual(20_000);

    const other = await checkCooldown("SESS:emergency", 20_000);
    expect(other.allowed).toBe(true);

    resetCooldownsForTests();
    expect((await checkCooldown("SESS:demo", 20_000)).allowed).toBe(true);
  });
});

describe("portal dictation", () => {
  it("extracts the message for the linked patient", () => {
    expect(parsePortalDictation("send a message to Anita saying please drink water", PATIENT)).toEqual({
      text: "please drink water",
    });
    expect(parsePortalDictation("Tell Anita to take her tablets", PATIENT)).toEqual({
      text: "take her tablets",
    });
    expect(parsePortalDictation("send the patient a message saying take your pills", PATIENT)).toEqual({
      text: "take your pills",
    });
    expect(parsePortalDictation("Send Anita a note that she should rest", PATIENT)).toEqual({
      text: "she should rest",
    });
    expect(parsePortalDictation("dictate to Anita: take your tablets", PATIENT)).toEqual({
      text: "take your tablets",
    });
  });

  it("never treats a question as a dictation", () => {
    expect(parsePortalDictation("tell me about Anita", PATIENT)).toBeNull();
    expect(parsePortalDictation("what medications is Anita on?", PATIENT)).toBeNull();
    expect(parsePortalDictation("who is on this bed?", PATIENT)).toBeNull();
  });

  it("returns null when there is nothing to say", () => {
    expect(parsePortalDictation("send a message to Anita", PATIENT)).toBeNull();
    expect(parsePortalDictation("send", PATIENT)).toBeNull();
  });

  it("askPortal surfaces the action and never caches a dictation", async () => {
    await linkPortalSession("DICT01", PATIENT.id);

    const first = await askPortal("DICT01", "send a message to Anita saying take your tablets");
    expect(first.intent).toBe("send_message");
    expect(first.action).toEqual({
      type: "send_message",
      patientId: PATIENT.id,
      patientName: PATIENT.displayName,
      text: "take your tablets",
    });

    const second = await askPortal("DICT01", "send a message to Anita saying take your tablets");
    expect(second.cached).toBe(false);
    expect(second.action?.type === "send_message" ? second.action.text : null).toBe("take your tablets");
  });

  it("executes the action as a real, persisted patient message", async () => {
    await linkPortalSession("DICT02", PATIENT.id);
    const res = await askPortal("DICT02", "send a message to Anita saying please sit up");
    expect(res.action).toBeTruthy();

    const stored = await executePortalAction(res.action!, {
      role: "nurse",
      userId: "u1",
      displayName: "Nurse Demo",
    });
    expect(stored?.messageId).toBeTruthy();

    const messages = await listMessages(PATIENT.id);
    expect(messages[0]?.text).toBe("please sit up");
    expect(messages[0]?.createdBy).toBe("Nurse Demo");

    // A non-message action is a no-op rather than an error.
    const ignored = await executePortalAction({
      type: "start_call",
      patientId: PATIENT.id,
      patientName: PATIENT.displayName,
    });
    expect(ignored).toBeNull();
  });
});

describe("voice opening", () => {
  it("names the patient and reports the live situation", async () => {
    await linkPortalSession("VOICE01", PATIENT.id);
    const ctx = await buildPortalContext("VOICE01");
    const line = voiceOpening(ctx);
    expect(line).toContain(PATIENT.displayName);
    expect(line.length).toBeGreaterThan(60);
  });

  it("is honest when no patient is linked", async () => {
    const ctx = await buildPortalContext("VOICE02");
    expect(voiceOpening(ctx).toLowerCase()).toContain("no patient is linked");
  });
});

describe("creating a patient", () => {
  it("stores a real, empty patient record that can be listed and fetched", async () => {
    const created = await createPatient({
      displayName: "  Ravi Kumar ",
      age: 54,
      sex: "male",
      room: "Ward B / Bed 7",
      primaryConcern: "Post-op follow-up",
    });

    expect(created.displayName).toBe("Ravi Kumar");
    expect(created.synthetic).toBe(false);
    expect(created.conditions).toEqual([]);
    expect(created.medications).toEqual([]);
    expect(created.allergies).toEqual([]);

    const all = await listPatients();
    expect(all.some((p) => p.id === created.id)).toBe(true);

    const fetched = await getPatient(created.id);
    expect(fetched?.displayName).toBe("Ravi Kumar");
    expect(fetched?.room).toBe("Ward B / Bed 7");
  });

  it("falls back to a safe name when the display name is blank", async () => {
    const created = await createPatient({ displayName: "   " });
    expect(created.displayName).toBe("Unnamed patient");
  });
});