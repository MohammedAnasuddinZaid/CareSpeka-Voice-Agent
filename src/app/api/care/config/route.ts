import { ok } from "@/lib/care/http";
import { getStoreInfo } from "@/lib/care/repo";

export const dynamic = "force-dynamic";

/**
 * Public runtime config for the browser. No secrets are exposed here: TURN
 * credentials are short-lived/rotatable and are only present when the operator
 * has explicitly configured a relay.
 */
export async function GET() {
  const store = await getStoreInfo();

  const iceServers: RTCIceServer[] = [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  ];

  const turnUrl = process.env.CARE_TURN_URL;
  if (turnUrl) {
    iceServers.push({
      urls: turnUrl.split(",").map((u) => u.trim()),
      username: process.env.CARE_TURN_USERNAME || undefined,
      credential: process.env.CARE_TURN_CREDENTIAL || undefined,
    });
  }

  return ok({
    mode: "web-voice-demo",
    modeLabel: "Web Voice Call — Demo",
    store,
    webrtc: {
      iceServers,
      turnConfigured: Boolean(turnUrl),
    },
    ai: {
      asrModel: process.env.CARE_ASR_MODEL || "Xenova/whisper-tiny.en",
      llmModel: process.env.CARE_LLM_MODEL || "Llama-3.2-1B-Instruct-q4f16_1-MLC",
      ttsEngine: process.env.CARE_TTS_ENGINE || "browser-speech-synthesis",
    },
    limits: {
      maxSessionMinutes: Number(process.env.CARE_MAX_SESSION_MINUTES || "30"),
      joinTtlMinutes: Number(process.env.CARE_JOIN_TTL_MINUTES || "30"),
      signalPollMs: Number(process.env.CARE_SIGNAL_POLL_MS || "1200"),
    },
  });
}
