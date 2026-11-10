/**
 * QR pairing registry — per-session unique pairing tokens + scan tracking.
 *
 * Every patient console generates a cryptographically-random pairing token and
 * bakes it into its QR code (`?session=X&pair=TOKEN`), so each bed's QR is
 * UNIQUE even though the dashboard origin is shared. When any device scans the
 * code, it reports back here with its IP + user-agent; the patient console (and
 * the ward board) can then see exactly which device is linked to which bed.
 *
 * Storage is in-memory with a 24h TTL: pairing metadata is ephemeral by design
 * (the session ID itself remains the sync key). Bounded per session — a ward
 * of busy beds can't grow this without limit.
 */
import { PairScanInfo } from "@/types";
import { CareKeys as K, getDriver } from "@/lib/care/store";

const SCAN_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SCANS_PER_SESSION = 20;
const MAX_SESSIONS = 2000;

interface PairRecord {
  token: string;
  registeredAt: number;
  scans: PairScanInfo[];
}

interface StoredPair {
  token: string;
  registeredAt: number;
}

/** Pairing keys are case-insensitive: API routes uppercase, QR pages do not. */
function norm(session: string): string {
  return session.trim().toUpperCase();
}

function asStoredPair(value: unknown): StoredPair | null {
  if (!value || typeof value !== "object") return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.token !== "string" || !rec.token || rec.token.length > 64) return null;
  return { token: rec.token, registeredAt: typeof rec.registeredAt === "number" ? rec.registeredAt : Date.now() };
}

const g = globalThis as unknown as { __carespeakPairing?: Map<string, PairRecord> };
const registry: Map<string, PairRecord> = (g.__carespeakPairing ??= new Map());

function prune(): void {
  const cutoff = Date.now() - SCAN_TTL_MS;
  for (const [session, rec] of registry) {
    if (rec.registeredAt < cutoff && rec.scans.every((s) => s.at < cutoff)) {
      registry.delete(session);
      continue;
    }
    rec.scans = rec.scans.filter((s) => s.at >= cutoff);
  }
  // hard cap so junk sessions can't balloon memory
  while (registry.size > MAX_SESSIONS) {
    const oldest = registry.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    registry.delete(oldest);
  }
}

/** Patient console calls this on mount: registers (or re-affirms) its token. */
export function registerPairToken(session: string, token: string): boolean {
  const key = norm(session);
  if (!key || !token || token.length > 64) return false;
  prune();
  const existing = registry.get(key);
  if (existing) {
    existing.registeredAt = Date.now();
    return existing.token === token;
  }
  registry.set(key, { token, registeredAt: Date.now(), scans: [] });
  return true;
}

/** Replace the current token — old QR links stop registering scans instantly. */
export function rotatePairToken(session: string, token?: string): string | null {
  const key = norm(session);
  const rec = registry.get(key);
  if (!rec) return null;
  const next = token && token.length <= 64 ? token : crypto.randomUUID().replace(/-/g, "");
  rec.token = next;
  rec.registeredAt = Date.now();
  return next;
}

export function verifyPairToken(session: string, token: string): boolean {
  const rec = registry.get(norm(session));
  return !!rec && !!token && rec.token === token;
}

/** Whether this session has ever registered a pairing token. */
export function hasRegistration(session: string): boolean {
  return registry.has(norm(session));
}

// ---------------------------------------------------------------------------
// durable layer (survives serverless instance recycling)
// ---------------------------------------------------------------------------

/**
 * Persist the pairing token alongside the care store. The in-memory registry
 * remains the fast path and keeps the ephemeral scan log, but authentication
 * must not depend on hitting the same serverless instance that handled the
 * original registration.
 */
export async function registerPairTokenPersistent(session: string, token: string): Promise<boolean> {
  const key = norm(session);
  if (!key || !token || token.length > 64) return false;
  try {
    const d = await getDriver();
    const existing = asStoredPair(await d.getDoc(K.pair(key)));
    if (existing && existing.token !== token) return false;
    await d.setDoc(K.pair(key), { token, registeredAt: Date.now() });
    registerPairToken(key, token);
    return true;
  } catch {
    // Storage unavailable: keep the previous single-instance behaviour rather
    // than locking the patient console out entirely.
    return registerPairToken(key, token);
  }
}

export async function verifyPairTokenPersistent(session: string, token: string): Promise<boolean> {
  const key = norm(session);
  if (!key || !token) return false;
  if (verifyPairToken(key, token)) return true;
  try {
    const d = await getDriver();
    const stored = asStoredPair(await d.getDoc(K.pair(key)));
    if (!stored || stored.token !== token) return false;
    registerPairToken(key, token); // warm the in-process fast path
    return true;
  } catch {
    return false;
  }
}

export async function rotatePairTokenPersistent(
  session: string,
  token?: string
): Promise<string | null> {
  const key = norm(session);
  if (!key) return null;
  const hadRegistration = hasRegistration(key);
  let exists = hadRegistration;
  try {
    const d = await getDriver();
    if (!exists) exists = asStoredPair(await d.getDoc(K.pair(key))) !== null;
    if (!exists) return null;
    const next = token && token.length <= 64 ? token : crypto.randomUUID().replace(/-/g, "");
    await d.setDoc(K.pair(key), { token: next, registeredAt: Date.now() });
    rotatePairToken(key, next);
    return next;
  } catch {
    const next = rotatePairToken(key, token);
    return next;
  }
}

export async function hasRegistrationPersistent(session: string): Promise<boolean> {
  const key = norm(session);
  if (hasRegistration(key)) return true;
  try {
    const d = await getDriver();
    return asStoredPair(await d.getDoc(K.pair(key))) !== null;
  } catch {
    return false;
  }
}

function clientIp(headers: Headers): string {
  const fwd = headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  return headers.get("x-real-ip")?.trim() || headers.get("cf-connecting-ip")?.trim() || "local";
}

/** A scanning device reports itself. Requires the token from the QR itself,
 *  so arbitrary third parties can't poison a bed's scan log. */
export function recordScan(
  session: string,
  token: string,
  role: string,
  userAgent: string | null,
  headers: Headers
): PairScanInfo | null {
  const key = norm(session);
  if (!verifyPairToken(key, token)) return null;
  const scan: PairScanInfo = {
    at: Date.now(),
    ip: clientIp(headers),
    device: (userAgent ?? "unknown").replace(/[^\w ./()+-]/g, "").slice(0, 80),
    role: role.slice(0, 16),
  };
  const rec = registry.get(key)!;
  rec.scans.unshift(scan);
  if (rec.scans.length > MAX_SCANS_PER_SESSION) rec.scans.length = MAX_SCANS_PER_SESSION;
  return scan;
}

export function getScans(session: string): PairScanInfo[] {
  return registry.get(norm(session))?.scans ?? [];
}

/** Compact summary for ward tiles / patient consoles. */
export function getPairSummary(session: string): {
  linkedDevices: number;
  lastScanAt: number | null;
  lastScanIp: string | null;
} {
  const scans = getScans(session);
  return {
    linkedDevices: new Set(scans.map((s) => s.ip)).size,
    lastScanAt: scans[0]?.at ?? null,
    lastScanIp: scans[0]?.ip ?? null,
  };
}
