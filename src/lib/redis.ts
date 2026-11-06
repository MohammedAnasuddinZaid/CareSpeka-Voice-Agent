/**
 * Shared Upstash Redis client.
 *
 * Server-only. Reads `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`
 * from the environment and lazily builds a single client per process.
 *
 * The client is only constructed on first use, so a deployment without Upstash
 * configured still builds and runs — the Web Voice Call store then falls back
 * to its local file driver (or memory on Vercel) and reports that honestly in
 * the UI.
 *
 * Docs: https://upstash.com/docs/redis/overall/getstarted
 */
import { Redis } from "@upstash/redis";

let client: Redis | null = null;

/** True when both Upstash REST variables are present. */
export function isRedisConfigured(): boolean {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

/**
 * Returns the shared client, creating it on first call.
 * Throws a clear error when the environment is not configured.
 */
export function getRedis(): Redis {
  if (client) return client;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error(
      "Upstash Redis is not configured: set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN."
    );
  }

  client = new Redis({ url, token });
  return client;
}

/** Test hook: drop the cached client so the next call re-reads the environment. */
export function resetRedisForTests(): void {
  client = null;
}