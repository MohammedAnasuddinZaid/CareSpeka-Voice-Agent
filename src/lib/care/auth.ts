/**
 * Auth for the Web Voice Call — Demo. Server-only.
 *
 * Nurse authentication is a signed-cookie session backed by the persistent store
 * (so it works across Vercel instances). Patient authorisation is a short-lived
 * participant token minted at join time. No credentials or secrets are ever sent
 * to the browser beyond opaque tokens.
 *
 * Credentials come from environment variables. For the hackathon a demo nurse is
 * available by default (see DEMO_CREDENTIALS_WARNING); change the env vars before
 * any real use.
 */
import type { NextRequest } from "next/server";
import { hashToken, newToken, safeEqual } from "./crypto";
import { delLogin, getLogin, putLogin, type LoginRecord } from "./repo";

export const NURSE_COOKIE = "care_session";
export const PARTICIPANT_HEADER = "x-care-participant";

const SESSION_MINUTES = 8 * 60;

export const DEMO_CREDENTIALS_WARNING =
  "Using built-in demo credentials (nurse.demo). Set CARE_NURSE_USER / CARE_NURSE_PASS before real use.";

interface Credential {
  userId: string;
  username: string;
  password: string;
  displayName: string;
  role: "admin" | "nurse";
}

function credentials(): Credential[] {
  const nurseUser = process.env.CARE_NURSE_USER || "nurse.demo";
  const nursePass = process.env.CARE_NURSE_PASS || "nurse.demo";
  const list: Credential[] = [
    {
      userId: "nurse_1",
      username: nurseUser,
      password: nursePass,
      displayName: process.env.CARE_NURSE_NAME || "Nurse Demo",
      role: "nurse",
    },
  ];
  if (process.env.CARE_ADMIN_USER && process.env.CARE_ADMIN_PASS) {
    list.push({
      userId: "admin_1",
      username: process.env.CARE_ADMIN_USER,
      password: process.env.CARE_ADMIN_PASS,
      displayName: "Administrator",
      role: "admin",
    });
  }
  return list;
}

export interface LoginOutcome {
  token: string;
  record: LoginRecord;
}

export async function login(username: string, password: string): Promise<LoginOutcome | null> {
  const match = credentials().find((c) => c.username.toLowerCase() === username.trim().toLowerCase());
  if (!match) return null;
  if (!safeEqual(hashToken(password), hashToken(match.password))) return null;
  const token = newToken();
  const record: LoginRecord = {
    userId: match.userId,
    username: match.username,
    displayName: match.displayName,
    role: match.role,
    expiresAt: new Date(Date.now() + SESSION_MINUTES * 60_000).toISOString(),
  };
  await putLogin(hashToken(token), record);
  return { token, record };
}

export async function logout(token: string | null | undefined): Promise<void> {
  if (token) await delLogin(hashToken(token));
}

function cookieValue(req: NextRequest, name: string): string | null {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) {
      const value = v.join("=");
      // A malformed percent escape in a cookie must not throw a 500 from every
      // route that reads the nurse session.
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
  }
  return null;
}

export async function nurseFromRequest(req: NextRequest): Promise<LoginRecord | null> {
  const token = cookieValue(req, NURSE_COOKIE);
  if (!token) return null;
  return getLogin(hashToken(token));
}

export interface ParticipantAuth {
  sessionId: string;
  role: "patient";
}

export async function participantFromRequest(req: NextRequest): Promise<string | null> {
  const header = req.headers.get(PARTICIPANT_HEADER);
  if (header) return header.trim();
  const auth = req.headers.get("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return null;
}

export function buildSessionCookie(token: string): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${NURSE_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${
    SESSION_MINUTES * 60
  }${secure}`;
}

export function clearSessionCookie(): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${NURSE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}
