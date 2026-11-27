import { get } from "./db";
import { nowIso } from "./utils";

/**
 * Fixed-window rate limiter backed by the `rate_limits` table.
 *
 * The increment is a single atomic statement. The previous read-then-write pair
 * let two concurrent requests both observe "under the limit" and both proceed, so
 * a burst could exceed the limit by however many requests arrived together — the
 * exact situation a login limiter exists to stop. `on conflict … do update` is
 * supported by both SQLite and Postgres, and the returned row is the post-update
 * state, so the decision is made from one consistent read.
 *
 * In multi-instance production swap the store for Redis/Upstash — the API stays.
 */
export type RateResult = { allowed: boolean; remaining: number; resetInSeconds: number };

export function rateLimit(key: string, limit: number, windowSeconds: number): RateResult {
  const now = Date.now();
  // Older than this and the window has rolled over.
  const cutoff = new Date(now - windowSeconds * 1000).toISOString();

  const row = get<{ count: number; window_start: string }>(
    `insert into rate_limits (key, count, window_start) values (?, 1, ?)
     on conflict (key) do update set
       count = case when rate_limits.window_start <= ? then 1 else rate_limits.count + 1 end,
       window_start = case when rate_limits.window_start <= ? then ? else rate_limits.window_start end
     returning count, window_start`,
    [key, nowIso(), cutoff, cutoff, nowIso()]
  );

  const count = row?.count ?? 1;
  const windowStart = row?.window_start ? new Date(row.window_start).getTime() : now;
  const elapsed = Math.max(0, (now - windowStart) / 1000);
  const resetInSeconds = Math.max(1, Math.ceil(windowSeconds - elapsed));

  if (count > limit) return { allowed: false, remaining: 0, resetInSeconds };
  return { allowed: true, remaining: Math.max(0, limit - count), resetInSeconds };
}

/**
 * Reads a positive integer from the environment.
 *
 * Limits belong to the deployment, not the source: a busy office behind one NAT
 * address legitimately needs a higher signup ceiling than a small one, and hard
 * coding it means the only fix is a code change. An invalid value falls back to
 * the documented default rather than silently disabling the control.
 */
function intFromEnv(name: string, fallback: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export const LOGIN_LIMIT = intFromEnv("LOGIN_RATE_LIMIT", 20);
export const LOGIN_WINDOW_SECONDS = intFromEnv("LOGIN_RATE_WINDOW_SECONDS", 600);
export const SIGNUP_LIMIT = intFromEnv("SIGNUP_RATE_LIMIT", 10);
export const SIGNUP_WINDOW_SECONDS = intFromEnv("SIGNUP_RATE_WINDOW_SECONDS", 3600);
