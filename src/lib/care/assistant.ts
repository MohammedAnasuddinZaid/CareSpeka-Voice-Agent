/**
 * Nurse-facing care assistant.
 *
 * A deterministic question-answering engine over the authorised patient record.
 * It is the guaranteed path: it needs no model, no network and no GPU, and it
 * never invents clinical facts. The nurse's browser may additionally run WebLLM
 * for freer phrasing, grounded on `buildContextText(...)` from this module, but
 * the answers below are what the demo falls back to and what the tests cover.
 *
 * It handles:
 *   - per-patient: overview, conditions, medications, allergies, observations,
 *     care plan, last call recap, tasks, messages, escalation status
 *   - cross-patient: who needs attention / follow-up, list of patients
 *   - dictation: "send a message to <patient> saying <text>"
 */
import type {
  CareReport,
  CareSession,
  CareTask,
  CareTranscriptEntry,
  ClinicalPatient,
  PatientMessage,
} from "./types";

export interface PatientContext {
  patient: ClinicalPatient;
  lastSession?: CareSession | null;
  lastTranscript: CareTranscriptEntry[];
  lastReport?: CareReport | null;
  openTasks: CareTask[];
  messages: PatientMessage[];
}

export interface AssistantContext {
  focused?: PatientContext | null;
  patients: PatientContext[];
}

export type AssistantAction =
  | { type: "send_message"; patientId: string; patientName: string; text: string }
  | { type: "start_call"; patientId: string; patientName: string };

export interface AssistantResult {
  answer: string;
  intent: string;
  engine: "care-assistant";
  patientId?: string;
  action?: AssistantAction;
  suggestedQuestions: string[];
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function rel(iso?: string | null): string {
  if (!iso) return "at an unknown time";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "recently";
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function list(items: string[]): string {
  if (!items.length) return "";
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function firstName(p: ClinicalPatient): string {
  return p.displayName.split(" ")[0];
}

function medicationLine(c: PatientContext): string {
  const p = c.patient;
  const meds = p.medications.filter((m) => m.status === "active");
  if (!meds.length) return `${p.displayName} has no active medications recorded.`;
  return `${p.displayName} is on ${list(
    meds.map((m) => `${m.name}${m.dose ? ` ${m.dose}` : ""}${m.frequency ? ` ${m.frequency}` : ""}`)
  )}.`;
}

function allergyLine(c: PatientContext): string {
  const p = c.patient;
  if (!p.allergies.length) return `${p.displayName} has no recorded allergies.`;
  return `${p.displayName} has ${p.allergies.length === 1 ? "one recorded allergy" : `${p.allergies.length} recorded allergies`}: ${list(
    p.allergies.map((a) => `${a.substance}${a.reaction ? ` (${a.reaction})` : ""}${a.severity ? `, ${a.severity}` : ""}`)
  )}.`;
}

function conditionLine(c: PatientContext): string {
  const active = c.patient.conditions.filter((x) => x.status === "active");
  const resolved = c.patient.conditions.filter((x) => x.status !== "active");
  const parts: string[] = [];
  parts.push(
    active.length
      ? `${c.patient.displayName}'s active conditions are ${list(active.map((x) => `${x.name}${x.code ? ` (${x.code})` : ""}`))}.`
      : `${c.patient.displayName} has no active conditions recorded.`
  );
  if (resolved.length) parts.push(`History also includes ${list(resolved.map((x) => x.name))}.`);
  return parts.join(" ");
}

function observationLine(c: PatientContext): string {
  const obs = c.patient.observations;
  if (!obs.length) return `${c.patient.displayName} has no observations recorded.`;
  const byLabel = new Map<string, typeof obs>();
  for (const o of obs) {
    const arr = byLabel.get(o.label) ?? [];
    arr.push(o);
    byLabel.set(o.label, arr);
  }
  const parts: string[] = [];
  for (const [label, series] of byLabel) {
    const sorted = [...series].sort((a, b) => a.at.localeCompare(b.at));
    const latest = sorted[sorted.length - 1];
    let trend = "";
    if (sorted.length >= 2) {
      const prev = sorted[sorted.length - 2];
      if (typeof latest.value === "number" && typeof prev.value === "number" && latest.value !== prev.value) {
        const dir = latest.value > prev.value ? "up" : "down";
        trend = `, ${dir} from ${prev.value}${latest.unit ? ` ${latest.unit}` : ""}`;
      }
    }
    parts.push(`${label} ${latest.value}${latest.unit ? ` ${latest.unit}` : ""}${trend} (${rel(latest.at)})`);
  }
  return `Latest recorded observations for ${c.patient.displayName}: ${list(parts)}.`;
}

function recapLine(c: PatientContext): string {
  if (!c.lastSession) return `There is no recorded call with ${c.patient.displayName} yet.`;
  const patientLines = c.lastTranscript.filter((t) => t.role === "patient").map((t) => t.text);
  const agentLines = c.lastTranscript.filter((t) => t.role === "agent");
  const parts: string[] = [];
  parts.push(`The last call with ${c.patient.displayName} was ${rel(c.lastSession.createdAt)}.`);
  if (patientLines.length) parts.push(`They said: ${list(patientLines.slice(0, 3).map((t) => `"${t}"`))}.`);
  else parts.push("There were no patient statements recorded.");
  if (c.lastSession.escalated) parts.push("The session was escalated for nurse review.");
  if (c.lastReport) {
    parts.push(
      c.lastReport.status === "approved"
        ? `The report was reviewed and approved by ${c.lastReport.reviewedBy ?? "the nurse"}.`
        : "The report is still a draft and needs review."
    );
    const symptoms = c.lastReport.sections.patientReportedSymptoms.map((s) => s.text);
    if (symptoms.length) parts.push(`Reported symptoms were ${list(symptoms)}.`);
  }
  const followUp = c.lastReport?.sections.suggestedFollowUp ?? [];
  if (followUp.length) parts.push(`Suggested follow-up: ${followUp[0]}`);
  if (agentLines.length === 0 && patientLines.length === 0) parts.push("No transcript is available for that call.");
  return parts.join(" ");
}

function taskLine(c: PatientContext): string {
  if (!c.openTasks.length) return `${c.patient.displayName} has no open follow-up tasks.`;
  return `Open follow-up for ${c.patient.displayName}: ${list(c.openTasks.map((t) => t.title))}.`;
}

function messageLine(c: PatientContext): string {
  if (!c.messages.length) return `No messages have been sent to ${c.patient.displayName}.`;
  const latest = c.messages[0];
  return `The most recent message to ${c.patient.displayName} was sent ${rel(latest.createdAt)}: "${latest.text}"${
    c.messages.length > 1 ? ` There are ${c.messages.length} messages in total.` : ""
  }`;
}

function overviewLine(c: PatientContext): string {
  const p = c.patient;
  const parts = [
    `${p.displayName} is ${p.age != null ? `${p.age} years old` : "of unknown age"}${
      p.sex ? `, ${p.sex}` : ""
    }${p.room ? `, in ${p.room}` : ""}.`,
  ];
  if (p.primaryConcern) parts.push(`Reason for care: ${p.primaryConcern}.`);
  parts.push(conditionLine(c));
  parts.push(allergyLine(c));
  parts.push(medicationLine(c));
  if (p.observations.length) parts.push(observationLine(c));
  if (p.carePlan) parts.push(`Care plan: ${p.carePlan}`);
  if (c.lastSession) parts.push(`Last contact was ${rel(c.lastSession.createdAt)}${c.lastSession.escalated ? " and was escalated" : ""}.`);
  if (c.openTasks.length) parts.push(taskLine(c));
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// intent detection
// ---------------------------------------------------------------------------

const RE = {
  meds: /medic|medicine|medication|tablet|drug|prescription|taking|dose/i,
  allergies: /allerg/i,
  conditions: /condition|diagnos|history|medical background|problems?|comorbid/i,
  observations: /vital|observation|blood pressure|\bbp\b|weight|glucose|sugar|heart rate|\bpulse\b|oxygen|saturation|peak flow|reading|vitals/i,
  recap: /last (call|session|conversation|c time)|what did .* say|recap|summar(y|ise|ize) (of )?(the )?(last )?(call|session)|conversation|transcript/i,
  tasks: /task|follow.?up|to.?do|outstanding|pending/i,
  plan: /care plan|plan of care|management plan/i,
  messages: /message|messaged|sent|told|texted/i,
  escalations: /escalat|red.?flag|urgent|concern|attention|at risk|deteriorat/i,
  who: /who (needs|has|is|are|should)|which patients?|anyone|everyone|all patients|my patients|list (the )?patients|patient list/i,
  summary: /summar|overview|tell me about|profile|details|who is|background|everything|status/i,
  startCall: /start (a )?(call|session)|call (them|him|her)|begin (a )?call/i,
};

function findPatientByName(question: string, patients: PatientContext[]): PatientContext | null {
  const q = question.toLowerCase();
  // Longest name first so "Anita Sharma" wins over "Anita".
  const candidates = patients
    .flatMap((c) => [
      { c, name: c.patient.displayName.toLowerCase() },
      { c, name: firstName(c.patient).toLowerCase() },
    ])
    .filter((x) => x.name.length >= 3)
    .sort((a, b) => b.name.length - a.name.length);
  for (const { c, name } of candidates) {
    if (new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(q)) return c;
  }
  return null;
}

/** Parses "send a message to X saying Y" / "tell X that Y" / "message X: Y". */
function parseMessageRequest(
  question: string,
  patients: PatientContext[]
): { target: PatientContext; text: string } | { error: string } | null {
  // "tell me about X" / "tell us X" are questions, not dictation.
  if (/^\s*(?:please\s+)?(?:can you\s+)?tell\s+(?:me|us)\b/i.test(question)) return null;
  const m = question.match(
    /^\s*(?:please\s+)?(?:can you\s+)?(?:send\s+(?:a\s+)?(?:message|note)\s+to|send|message|tell|text)\s+(.+)$/i
  );
  if (!m) return null;
  const rest = m[1].trim();
  const target = findPatientByName(rest, patients);
  if (!target) {
    const names = list(patients.map((c) => c.patient.displayName));
    return { error: `I could not tell which patient that message is for. Your patients are ${names}. Try "send a message to ${patients[0]?.patient.displayName ?? "Anita Sharma"} saying ..."` };
  }
  const nameForms = [target.patient.displayName, firstName(target.patient)].sort((a, b) => b.length - a.length);
  let remainder = rest;
  for (const form of nameForms) {
    if (remainder.toLowerCase().startsWith(form.toLowerCase())) {
      remainder = remainder.slice(form.length);
      break;
    }
  }
  const text = remainder
    .replace(/^\s*(?:saying|that|to say|:|-|,)\s*/i, "")
    .replace(/^["']|["']$/g, "")
    .trim();
  if (!text) {
    return { error: `What would you like me to say to ${target.patient.displayName}? For example: "send a message to ${target.patient.displayName} saying please weigh yourself tomorrow morning."` };
  }
  return { target, text };
}

// ---------------------------------------------------------------------------
// answer
// ---------------------------------------------------------------------------

export function suggestedQuestions(ctx: AssistantContext): string[] {
  const c = ctx.focused;
  const base = [
    "Who needs follow-up today?",
    "Which patients were escalated?",
  ];
  if (!c) return base;
  const name = firstName(c.patient);
  return [
    `Summarise ${name}`,
    `What medications is ${name} on?`,
    `Any allergies for ${name}?`,
    `What did ${name} say in the last call?`,
    `What are ${name}'s latest observations?`,
    ...base,
  ];
}

export function answerQuestion(question: string, ctx: AssistantContext): AssistantResult {
  const q = question.trim();
  const suggestions = suggestedQuestions(ctx);

  if (!q) {
    return {
      answer: "Ask me about any patient — their medications, allergies, observations, last call, follow-up tasks, or tell me to send them a message.",
      intent: "empty",
      engine: "care-assistant",
      suggestedQuestions: suggestions,
    };
  }

  // 1) Dictation: send a message.
  const msgReq = parseMessageRequest(q, ctx.patients);
  if (msgReq) {
    if ("error" in msgReq) {
      return { answer: msgReq.error, intent: "send_message_unresolved", engine: "care-assistant", suggestedQuestions: suggestions };
    }
    return {
      answer: `I'll send that to ${msgReq.target.patient.displayName}: "${msgReq.text}". It will appear on their joining page.`,
      intent: "send_message",
      engine: "care-assistant",
      patientId: msgReq.target.patient.id,
      action: {
        type: "send_message",
        patientId: msgReq.target.patient.id,
        patientName: msgReq.target.patient.displayName,
        text: msgReq.text,
      },
      suggestedQuestions: suggestions,
    };
  }

  // 2) Cross-patient questions.
  const namesPatient = findPatientByName(q, ctx.patients);
  const focused = namesPatient ?? ctx.focused ?? null;

  if (RE.who.test(q) && !namesPatient) {
    return { answer: crossPatientAnswer(q, ctx), intent: "cross_patient", engine: "care-assistant", suggestedQuestions: suggestions };
  }

  if (!focused) {
    const names = list(ctx.patients.map((c) => `${c.patient.displayName} (${c.patient.primaryConcern ?? "care follow-up"})`));
    return {
      answer: `Which patient do you mean? You can ask me about any of: ${names}.`,
      intent: "need_patient",
      engine: "care-assistant",
      suggestedQuestions: suggestions,
    };
  }

  const p = focused.patient;

  if (RE.startCall.test(q)) {
    return {
      answer: `I can start a Web Voice Call with ${p.displayName}. Use the Start voice call button, or I can open it for you.`,
      intent: "start_call",
      engine: "care-assistant",
      patientId: p.id,
      action: { type: "start_call", patientId: p.id, patientName: p.displayName },
      suggestedQuestions: suggestions,
    };
  }

  if (RE.allergies.test(q)) {
    return { answer: allergyLine(focused), intent: "allergies", engine: "care-assistant", patientId: p.id, suggestedQuestions: suggestions };
  }
  if (RE.meds.test(q)) {
    return { answer: medicationLine(focused), intent: "medications", engine: "care-assistant", patientId: p.id, suggestedQuestions: suggestions };
  }
  if (RE.conditions.test(q)) {
    return { answer: conditionLine(focused), intent: "conditions", engine: "care-assistant", patientId: p.id, suggestedQuestions: suggestions };
  }
  if (RE.observations.test(q)) {
    return { answer: observationLine(focused), intent: "observations", engine: "care-assistant", patientId: p.id, suggestedQuestions: suggestions };
  }
  if (RE.recap.test(q)) {
    return { answer: recapLine(focused), intent: "last_session", engine: "care-assistant", patientId: p.id, suggestedQuestions: suggestions };
  }
  if (RE.tasks.test(q)) {
    return { answer: taskLine(focused), intent: "tasks", engine: "care-assistant", patientId: p.id, suggestedQuestions: suggestions };
  }
  if (RE.plan.test(q)) {
    return {
      answer: p.carePlan
        ? `${p.displayName}'s care plan: ${p.carePlan}`
        : `${p.displayName} has no care plan recorded.`,
      intent: "care_plan",
      engine: "care-assistant",
      patientId: p.id,
      suggestedQuestions: suggestions,
    };
  }
  if (RE.messages.test(q)) {
    return { answer: messageLine(focused), intent: "messages", engine: "care-assistant", patientId: p.id, suggestedQuestions: suggestions };
  }
  if (RE.escalations.test(q)) {
    return {
      answer: focused.lastSession?.escalated
        ? `Yes — ${p.displayName}'s last session was escalated. ${recapLine(focused)}`
        : `${p.displayName} has no escalation recorded. ${focused.openTasks.length ? taskLine(focused) : "There are no open follow-up tasks."}`,
      intent: "escalations",
      engine: "care-assistant",
      patientId: p.id,
      suggestedQuestions: suggestions,
    };
  }

  // 3) Default: a complete, grounded overview.
  return {
    answer: overviewLine(focused),
    intent: "overview",
    engine: "care-assistant",
    patientId: p.id,
    suggestedQuestions: suggestions,
  };
}

function crossPatientAnswer(question: string, ctx: AssistantContext): string {
  const wantsEscalations = RE.escalations.test(question);
  const wantsTasks = RE.tasks.test(question);
  const escalated = ctx.patients.filter((c) => c.lastSession?.escalated);
  const withTasks = ctx.patients.filter((c) => c.openTasks.length > 0);

  if (wantsEscalations && escalated.length) {
    return `These patients need attention: ${list(
      escalated.map((c) => {
        const reason = c.lastReport?.sections.escalations?.[0] ?? c.lastReport?.sections.patientReportedSymptoms?.[0]?.text;
        return `${c.patient.displayName}${reason ? ` — ${reason}` : ""} (last contact ${rel(c.lastSession?.createdAt)})`;
      })
    )}.`;
  }
  if (wantsTasks && withTasks.length) {
    return `Open follow-up: ${list(
      withTasks.map((c) => `${c.patient.displayName} — ${c.openTasks.map((t) => t.title).join("; ")}`)
    )}.`;
  }

  // General "who needs attention / my patients" answer.
  const parts: string[] = [];
  if (escalated.length) {
    parts.push(`Escalated: ${list(escalated.map((c) => c.patient.displayName))}.`);
  }
  if (withTasks.length) {
    parts.push(`Open follow-up: ${list(withTasks.map((c) => c.patient.displayName))}.`);
  }
  const overview = list(
    ctx.patients.map(
      (c) =>
        `${c.patient.displayName} (${c.patient.primaryConcern ?? "care follow-up"}${
          c.lastSession ? `, last contact ${rel(c.lastSession.createdAt)}` : ""
        })`
    )
  );
  parts.push(`Your patients are ${overview}.`);
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// optional LLM grounding text
// ---------------------------------------------------------------------------

/** A compact, complete text context for an optional in-browser LLM. */
export function buildContextText(ctx: AssistantContext): string {
  const blocks = ctx.patients.map((c) => {
    const p = c.patient;
    const lines: string[] = [];
    lines.push(`PATIENT: ${p.displayName} (id ${p.id})`);
    lines.push(`Age: ${p.age ?? "unknown"}; Sex: ${p.sex ?? "unknown"}; Room: ${p.room ?? "unknown"}; Language: ${p.language}`);
    lines.push(`Primary concern: ${p.primaryConcern ?? "none recorded"}`);
    lines.push(`Care plan: ${p.carePlan ?? "none recorded"}`);
    lines.push(
      `Conditions: ${p.conditions.map((x) => `${x.name} [${x.status}]${x.code ? ` (${x.code})` : ""}`).join("; ") || "none"}`
    );
    lines.push(
      `Medications: ${p.medications.map((m) => `${m.name} ${m.dose ?? ""} ${m.frequency ?? ""} [${m.status}]`).join("; ") || "none"}`
    );
    lines.push(
      `Allergies: ${p.allergies.map((a) => `${a.substance} (${a.reaction ?? "reaction unknown"}, ${a.severity})`).join("; ") || "none"}`
    );
    lines.push(
      `Observations: ${p.observations.map((o) => `${o.label} ${o.value}${o.unit ?? ""} at ${o.at}`).join("; ") || "none"}`
    );
    lines.push(
      `Previous encounters: ${p.encounters.map((e) => `${e.kind} ${e.at}: ${e.summary}`).join(" | ") || "none"}`
    );
    if (c.lastSession) {
      lines.push(`Last session: ${c.lastSession.status} at ${c.lastSession.createdAt}; escalated=${c.lastSession.escalated}`);
      lines.push(
        `Last transcript: ${c.lastTranscript.map((t) => `${t.role}: ${t.text}`).join(" | ") || "none"}`
      );
      if (c.lastReport) {
        lines.push(
          `Last report (${c.lastReport.status}): symptoms=${c.lastReport.sections.patientReportedSymptoms
            .map((s) => s.text)
            .join(", ")}; follow-up=${c.lastReport.sections.suggestedFollowUp.join(", ")}`
        );
      }
    }
    lines.push(`Open tasks: ${c.openTasks.map((t) => t.title).join("; ") || "none"}`);
    lines.push(`Messages: ${c.messages.map((m) => `${m.createdAt}: ${m.text}`).join(" | ") || "none"}`);
    return lines.join("\n");
  });
  return blocks.join("\n\n");
}

/** The system prompt used when the browser LLM is available. */
export function assistantSystemPrompt(): string {
  return [
    "You are CareSpeak, a care-coordination assistant for a nurse.",
    "Answer ONLY from the patient context provided. Never diagnose, prescribe, or invent facts, vitals, medications, or history.",
    "If the context does not contain the answer, say so plainly and suggest what the nurse could check.",
    "Be concise and spoken-friendly (under 80 words). Use the patient's name.",
    "When asked to send a message, repeat the message text you understood.",
  ].join("\n");
}