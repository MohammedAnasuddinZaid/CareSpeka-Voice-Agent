import type { DeviceVitals, PatientMetrics } from "@/types";

/** Pick the device with the freshest `lastSeen` instead of an arbitrary one. */
export function newestMetrics(
  map: Record<string, PatientMetrics> | null | undefined
): PatientMetrics | null {
  if (!map) return null;
  const entries = Object.values(map);
  if (entries.length === 0) return null;
  let best = entries[0];
  let bestAt = best?.lastSeen ? Date.parse(best.lastSeen) : -Infinity;
  for (let i = 1; i < entries.length; i += 1) {
    const m = entries[i];
    const at = m?.lastSeen ? Date.parse(m.lastSeen) : -Infinity;
    if (at > bestAt || (at === -Infinity && bestAt === -Infinity)) {
      best = m;
      bestAt = at;
    }
  }
  return best ?? null;
}

export function newestVitals(
  map: Record<string, DeviceVitals> | null | undefined
): DeviceVitals | null {
  if (!map) return null;
  const entries = Object.values(map);
  if (entries.length === 0) return null;
  let best = entries[0];
  let bestAt = best?.receivedAt ?? -Infinity;
  for (let i = 1; i < entries.length; i += 1) {
    const v = entries[i];
    const at = v?.receivedAt ?? -Infinity;
    if (at > bestAt) {
      best = v;
      bestAt = at;
    }
  }
  return best ?? null;
}