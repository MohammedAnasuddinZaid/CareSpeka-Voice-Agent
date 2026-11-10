/**
 * Persistent store for the Web Voice Call — Demo.
 *
 * Vercel Functions do not share memory between invocations or regions, so all
 * session state, events, transcripts, signalling and reports are persisted
 * through this module. Three interchangeable drivers:
 *
 *  - `redis`  : Upstash Redis over REST. Required on Vercel. Cross-instance safe
 *               (append-only lists for events/transcripts/signalling).
 *  - `file`   : a single JSON document under CARE_DATA_DIR. Local dev only.
 *  - `memory` : process-local. Tests + last-resort fallback (NOT multi-device).
 *
 * The driver selection is reported honestly to the UI so nobody mistakes a
 * non-persistent fallback for a working deployment.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { getRedis } from "@/lib/redis";

export type DriverName = "redis" | "file" | "memory";

export interface KVDriver {
  readonly name: DriverName;
  readonly persistent: boolean;
  getDoc(key: string): Promise<unknown | null>;
  setDoc(key: string, value: unknown): Promise<void>;
  /** Set only when the key is absent. Returns true when this call wrote it. */
  setDocIfAbsent(key: string, value: unknown): Promise<boolean>;
  /** Atomically add to a numeric counter and return the new value. */
  incr(key: string, by?: number): Promise<number>;
  /**
   * Atomically read-modify-write one document. The mutator must be synchronous
   * and return `null` to abort without writing (used for compare-and-set).
   */
  mutateDoc<T>(key: string, mutate: (current: T | null) => T | null): Promise<T | null>;
  appendList(key: string, value: unknown, cap?: number): Promise<number>;
  getList(key: string, from?: number): Promise<unknown[]>;
  setList(key: string, values: unknown[]): Promise<void>;
  del(key: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// memory driver
// ---------------------------------------------------------------------------

class MemoryDriver implements KVDriver {
  readonly name = "memory" as const;
  readonly persistent = false;
  private docs = new Map<string, unknown>();
  private lists = new Map<string, unknown[]>();

  async getDoc(key: string) {
    return this.docs.get(key) ?? null;
  }
  async setDoc(key: string, value: unknown) {
    this.docs.set(key, value);
  }
  async setDocIfAbsent(key: string, value: unknown) {
    if (this.docs.has(key) || this.lists.has(key)) return false;
    this.docs.set(key, value);
    return true;
  }
  async incr(key: string, by = 1) {
    const current = Number(this.docs.get(key) ?? 0);
    const next = (Number.isFinite(current) ? current : 0) + by;
    this.docs.set(key, next);
    return next;
  }
  async mutateDoc<T>(key: string, mutate: (current: T | null) => T | null): Promise<T | null> {
    // JavaScript runs this critical section without yielding: read, mutate and
    // write happen in one tick, so concurrent requests cannot interleave.
    const current = (this.docs.get(key) ?? null) as T | null;
    const next = mutate(current);
    if (next === null) return null;
    this.docs.set(key, next);
    return next;
  }
  async appendList(key: string, value: unknown, cap = 5000) {
    const list = this.lists.get(key) ?? [];
    list.push(value);
    if (list.length > cap) list.splice(0, list.length - cap);
    this.lists.set(key, list);
    return list.length;
  }
  async getList(key: string, from = 0) {
    return (this.lists.get(key) ?? []).slice(from);
  }
  async setList(key: string, values: unknown[]) {
    this.lists.set(key, [...values]);
  }
  async del(key: string) {
    this.docs.delete(key);
    this.lists.delete(key);
  }
}

// ---------------------------------------------------------------------------
// file driver (single JSON document, serialised writes)
// ---------------------------------------------------------------------------

interface FileShape {
  docs: Record<string, unknown>;
  lists: Record<string, unknown[]>;
}

function resolveDataDir(): string {
  const fromEnv = process.env.CARE_DATA_DIR;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  // Local dev: keep artifacts beside the project, never on a network share.
  return path.join(process.cwd(), ".care-data");
}

class FileDriver implements KVDriver {
  readonly name = "file" as const;
  readonly persistent = true;
  private file: string;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(dir: string) {
    this.file = path.join(dir, "care-store.json");
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async read(): Promise<FileShape> {
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as Partial<FileShape>;
      return { docs: parsed.docs ?? {}, lists: parsed.lists ?? {} };
    } catch {
      return { docs: {}, lists: {} };
    }
  }

  private async write(data: FileShape): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data), "utf8");
    await fs.rename(tmp, this.file);
  }

  async getDoc(key: string) {
    return this.run(async () => (await this.read()).docs[key] ?? null);
  }
  async setDoc(key: string, value: unknown) {
    await this.run(async () => {
      const data = await this.read();
      data.docs[key] = value;
      await this.write(data);
    });
  }
  async setDocIfAbsent(key: string, value: unknown) {
    return this.run(async () => {
      const data = await this.read();
      if (key in data.docs || key in data.lists) return false;
      data.docs[key] = value;
      await this.write(data);
      return true;
    });
  }
  async incr(key: string, by = 1) {
    return this.run(async () => {
      const data = await this.read();
      const current = Number(data.docs[key] ?? 0);
      const next = (Number.isFinite(current) ? current : 0) + by;
      data.docs[key] = next;
      await this.write(data);
      return next;
    });
  }
  async mutateDoc<T>(key: string, mutate: (current: T | null) => T | null): Promise<T | null> {
    return this.run(async () => {
      const data = await this.read();
      const current = (data.docs[key] ?? null) as T | null;
      const next = mutate(current);
      if (next === null) return null;
      data.docs[key] = next;
      await this.write(data);
      return next;
    });
  }
  async appendList(key: string, value: unknown, cap = 5000) {
    return this.run(async () => {
      const data = await this.read();
      const list = data.lists[key] ?? [];
      list.push(value);
      if (list.length > cap) list.splice(0, list.length - cap);
      data.lists[key] = list;
      await this.write(data);
      return list.length;
    });
  }
  async getList(key: string, from = 0) {
    return this.run(async () => ((await this.read()).lists[key] ?? []).slice(from));
  }
  async setList(key: string, values: unknown[]) {
    await this.run(async () => {
      const data = await this.read();
      data.lists[key] = [...values];
      await this.write(data);
    });
  }
  async del(key: string) {
    await this.run(async () => {
      const data = await this.read();
      delete data.docs[key];
      delete data.lists[key];
      await this.write(data);
    });
  }
}

// ---------------------------------------------------------------------------
// redis driver (Upstash REST)
// ---------------------------------------------------------------------------

interface RedisLike {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, opts?: { nx?: boolean; px?: number }): Promise<unknown>;
  incrby(key: string, by: number): Promise<number>;
  rpush(key: string, ...values: unknown[]): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<unknown[]>;
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class RedisDriver implements KVDriver {
  readonly name = "redis" as const;
  readonly persistent = true;
  constructor(private redis: RedisLike) {}

  async getDoc(key: string) {
    try {
      return (await this.redis.get(key)) ?? null;
    } catch {
      // A malformed value or a transient REST failure must not take the whole
      // request down; callers treat this as "missing" and regenerate state.
      return null;
    }
  }
  async setDoc(key: string, value: unknown) {
    await this.redis.set(key, value);
  }
  async setDocIfAbsent(key: string, value: unknown) {
    const res = await this.redis.set(key, value, { nx: true });
    return res !== null && res !== undefined;
  }
  async incr(key: string, by = 1) {
    return this.redis.incrby(key, by);
  }
  async mutateDoc<T>(key: string, mutate: (current: T | null) => T | null): Promise<T | null> {
    // Upstash REST has no WATCH/MULTI transaction primitive exposed through the
    // driver interface, so guard the read-modify-write with a short-lived
    // distributed lock. The mutation itself runs in well under a millisecond.
    const lockKey = `${key}:__mutate_lock`;
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let locked = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const got = await this.redis.set(lockKey, token, { nx: true, px: 5000 });
      if (got !== null && got !== undefined) {
        locked = true;
        break;
      }
      await sleep(10 + Math.min(attempt, 20) * 3);
    }
    if (!locked) throw new Error("Care store is busy; please retry.");
    try {
      const current = (await this.redis.get(key)) as T | null;
      const next = mutate(current);
      if (next === null) return null;
      await this.redis.set(key, next);
      return next;
    } finally {
      try {
        if ((await this.redis.get(lockKey)) === token) await this.redis.del(lockKey);
      } catch {
        // The lock expires on its own (5s) if the release call fails.
      }
    }
  }
  async appendList(key: string, value: unknown, cap = 5000) {
    const len = await this.redis.rpush(key, value);
    if (len > cap) await this.redis.ltrim(key, len - cap, -1);
    return len;
  }
  async getList(key: string, from = 0) {
    try {
      const list = await this.redis.lrange(key, from, -1);
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }
  async setList(key: string, values: unknown[]) {
    await this.redis.del(key);
    if (values.length) await this.redis.rpush(key, ...values);
  }
  async del(key: string) {
    await this.redis.del(key);
  }
}

// ---------------------------------------------------------------------------
// driver selection (singleton per process)
// ---------------------------------------------------------------------------

let cached: KVDriver | null = null;

export async function getDriver(): Promise<KVDriver> {
  if (cached) return cached;
  const forced = (process.env.CARE_STORE ?? "").toLowerCase();

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  const redisConfigured = Boolean(url && token) && forced !== "file" && forced !== "memory";

  if (redisConfigured) {
    try {
      const redis = getRedis() as unknown as RedisLike;
      cached = new RedisDriver(redis);
      return cached;
    } catch {
      // fall through to a non-persistent driver, flagged to the UI.
    }
  }

  if (forced === "memory" || process.env.NODE_ENV === "test") {
    cached = new MemoryDriver();
    return cached;
  }

  // On Vercel the project filesystem is read-only, so a file store cannot work.
  // Without Redis we degrade to memory and the UI reports persistence honestly.
  if (process.env.VERCEL && !process.env.CARE_DATA_DIR) {
    cached = new MemoryDriver();
    return cached;
  }

  cached = new FileDriver(resolveDataDir());
  return cached;
}

/** Test hook: reset the singleton between cases. */
export function resetDriverForTests(): void {
  cached = null;
}

// ---------------------------------------------------------------------------
// typed key namespace
// ---------------------------------------------------------------------------

const K = {
  session: (id: string) => `care:session:${id}`,
  sessionIndex: "care:session:index",
  /** Monotonic event/transcript sequence counter for one session. */
  sessionSeq: (id: string) => `care:session:${id}:seq`,
  events: (id: string) => `care:session:${id}:events`,
  transcript: (id: string) => `care:session:${id}:transcript`,
  signal: (id: string, to: string) => `care:session:${id}:signal:${to}`,
  signalSeq: (id: string, to: string) => `care:session:${id}:signal-seq:${to}`,
  report: (id: string) => `care:report:${id}`,
  reportIndex: "care:report:index",
  audit: "care:audit",
  patient: (id: string) => `care:patient:${id}`,
  patientIndex: "care:patient:index",
  patientSeeded: "care:patient:seeded",
  patientSeedVersion: "care:patient:seed-version",
  patientDeleted: (id: string) => `care:patient:deleted:${id}`,
  tasks: "care:tasks",
  messages: "care:messages",
  record: (id: string) => `care:record:${id}`,
  recordIndex: "care:records",
  recordsSeed: "care:records:seed:v1",
  sessionLink: (session: string) => `care:sessionlink:${session}`,
  sessionUnlinked: (session: string) => `care:sessionunlinked:${session}`,
  aiCache: (hash: string) => `care:ai:cache:${hash}`,
  aiCacheIndex: "care:ai:cache:index",
  seed: "care:seed:v1",
  login: (hash: string) => `care:login:${hash}`,
  joinToken: (hash: string) => `care:jointoken:${hash}`,
  participant: (hash: string) => `care:participant:${hash}`,
  /** Persisted QR pairing token (uppercase session key), survives restarts. */
  pair: (session: string) => `care:pair:${session}`,
};

export { K as CareKeys };
