import { get, run } from "./db";
import { nowIso } from "./utils";

/**
 * Fixed-window rate limiter backed by SQLite.
 * Used for auth endpoints, AI calls and public endpoints.
 * In multi-instance production swap the store for Redis/Upstash — the API stays.
 */
export type RateResult = { allowed: boolean; remaining: number; resetInSeconds: number };

export function rateLimit(key: string, limit: number, windowSeconds: number): RateResult {
  const now = Date.now();
  const row = get<{ count: number; window_start: string }>("select count, window_start from rate_limits where key = ?", [key]);

  if (!row) {
    run("insert into rate_limits (key, count, window_start) values (?,?,?)", [key, 1, nowIso()]);
    return { allowed: true, remaining: limit - 1, resetInSeconds: windowSeconds };
  }

  const windowStart = new Date(row.window_start).getTime();
  const elapsed = (now - windowStart) / 1000;

  if (elapsed >= windowSeconds) {
    run("update rate_limits set count = 1, window_start = ? where key = ?", [nowIso(), key]);
    return { allowed: true, remaining: limit - 1, resetInSeconds: windowSeconds };
  }

  if (row.count >= limit) {
    return { allowed: false, remaining: 0, resetInSeconds: Math.ceil(windowSeconds - elapsed) };
  }

  run("update rate_limits set count = count + 1 where key = ?", [key]);
  return { allowed: true, remaining: limit - row.count - 1, resetInSeconds: Math.ceil(windowSeconds - elapsed) };
}
