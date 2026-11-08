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
  set(key: string, value: unknown): Promise<unknown>;
  rpush(key: string, ...values: unknown[]): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<unknown[]>;
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

class RedisDriver implements KVDriver {
  readonly name = "redis" as const;
  readonly persistent = true;
  constructor(private redis: RedisLike) {}

  async getDoc(key: string) {
    return (await this.redis.get(key)) ?? null;
  }
  async setDoc(key: string, value: unknown) {
    await this.redis.set(key, value);
  }
  async appendList(key: string, value: unknown, cap = 5000) {
    const len = await this.redis.rpush(key, value);
    if (len > cap) await this.redis.ltrim(key, len - cap, -1);
    return len;
  }
  async getList(key: string, from = 0) {
    return this.redis.lrange(key, from, -1);
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
  events: (id: string) => `care:session:${id}:events`,
  transcript: (id: string) => `care:session:${id}:transcript`,
  signal: (id: string, to: string) => `care:session:${id}:signal:${to}`,
  report: (id: string) => `care:report:${id}`,
  reportIndex: "care:report:index",
  audit: "care:audit",
  patient: (id: string) => `care:patient:${id}`,
  patientIndex: "care:patient:index",
  patientSeeded: "care:patient:seeded",
  tasks: "care:tasks",
  messages: "care:messages",
  record: (id: string) => `care:record:${id}`,
  recordIndex: "care:records",
  sessionLink: (session: string) => `care:sessionlink:${session}`,
  sessionUnlinked: (session: string) => `care:sessionunlinked:${session}`,
  aiCache: (hash: string) => `care:ai:cache:${hash}`,
  aiCacheIndex: "care:ai:cache:index",
  seed: "care:seed:v1",
  login: (hash: string) => `care:login:${hash}`,
  joinToken: (hash: string) => `care:jointoken:${hash}`,
  participant: (hash: string) => `care:participant:${hash}`,
};

export { K as CareKeys };
