/**
 * Token + id helpers for the Web Voice Call — Demo. Server-only.
 *
 * Join tokens and participant tokens are high-entropy random strings. Only their
 * SHA-256 hash is ever persisted; the raw value exists only in the URL / client
 * memory. This mirrors the existing VoiceLink auth style.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/** 32-byte URL-safe token for QR joins and participant identity. */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Six-digit human-typeable joining code (not a secret by itself). */
export function newJoinCode(): string {
  return String(randomInt(100000, 1000000));
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

/** Constant-time compare for equal-length hex digests. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
}

export function isoNow(): string {
  return new Date().toISOString();
}

export function minutesFromNow(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

export function isExpired(iso: string | undefined | null): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t <= Date.now();
}
