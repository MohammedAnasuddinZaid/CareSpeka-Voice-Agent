import type { NextRequest } from "next/server";
import { buildAssistantContext } from "@/lib/care/assistantContext";
import { answerQuestion } from "@/lib/care/assistant";
import { appendAudit, addMessage } from "@/lib/care/repo";
import { guardNurse, isResponse, ok, readBody } from "@/lib/care/http";

export const dynamic = "force-dynamic";

interface AssistantBody {
  question?: string;
  /** The patient the nurse is currently focused on (optional). */
  patientId?: string;
}

/**
 * The nurse-facing care assistant.
 *
 * A nurse asks a question in natural language ("what medications is Anita on?",
 * "who needs follow-up?", "send Anita a message saying weigh yourself tomorrow")
 * and gets an answer grounded strictly in the stored patient record. Dictation
 * ("send <patient> a message saying <text>") is executed server-side so the
 * message is persisted and shown on the patient's joining page.
 */
export async function POST(req: NextRequest) {
  const nurse = await guardNurse(req);
  if (isResponse(nurse)) return nurse;

  const body = await readBody<AssistantBody>(req);
  const question = (body?.question ?? "").trim().slice(0, 1000);
  const patientId = body?.patientId?.trim() || null;

  const ctx = await buildAssistantContext(patientId);
  const result = answerQuestion(question, ctx);

  // Execute a dictated message so it is not just a promise in the UI.
  if (result.action?.type === "send_message") {
    const { patientId: pid, patientName, text } = result.action;
    const message = await addMessage({ patientId: pid, patientName, text, createdBy: nurse.displayName });
    await appendAudit({
      actorRole: nurse.role,
      actorId: nurse.userId,
      action: "care.message_sent",
      patientId: pid,
      detail: { messageId: message.id, via: "voice-assistant", chars: text.length },
    });
  }

  return ok({
    answer: result.answer,
    intent: result.intent,
    engine: result.engine,
    patientId: result.patientId,
    action: result.action ?? null,
    suggestedQuestions: result.suggestedQuestions,
  });
}
