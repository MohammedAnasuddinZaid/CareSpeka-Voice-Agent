/**
 * Shared helpers for the Web Voice Call — Demo route handlers.
 */
import { NextResponse, type NextRequest } from "next/server";
import { nurseFromRequest } from "./auth";
import type { LoginRecord } from "./repo";

export function ok<T extends object>(data: T, status = 200): NextResponse {
  return NextResponse.json({ ok: true, ...data }, { status, headers: { "Cache-Control": "no-store" } });
}

export function fail(error: string, status = 400, extra: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json({ ok: false, error, ...extra }, { status, headers: { "Cache-Control": "no-store" } });
}

export function unauthorized(message = "Sign in to continue."): NextResponse {
  return fail(message, 401);
}

export async function readBody<T>(req: NextRequest): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

export interface NurseGuard {
  nurse: LoginRecord;
}

/** Returns the signed-in nurse or a 401 response. */
export async function guardNurse(req: NextRequest): Promise<LoginRecord | NextResponse> {
  const nurse = await nurseFromRequest(req);
  if (!nurse) return unauthorized();
  return nurse;
}

export function isResponse(value: unknown): value is NextResponse {
  return value instanceof NextResponse;
}

/** Absolute public base URL, honouring the deployment domain. */
export function publicBaseUrl(req: NextRequest): string {
  const override = process.env.NEXT_PUBLIC_CARESPEAK_URL || process.env.CARESPEAK_PUBLIC_URL;
  if (override) return override.replace(/\/+$/, "");
  const proto = req.headers.get("x-forwarded-proto") || (req.nextUrl.protocol.replace(":", "") || "https");
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
  if (host) return `${proto}://${host}`;
  return req.nextUrl.origin;
}
