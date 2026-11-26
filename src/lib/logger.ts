/**
 * Structured logging.
 *
 * One line of JSON per event so logs can be filtered in Vercel, Datadog or
 * `docker logs | jq`. Sensitive values are redacted before they are written:
 * a password, token or API key printed once is a breach that never expires.
 */

/* eslint-disable no-console -- this module is the single console sink */
const REDACT_KEYS = /pass(word)?|token|secret|key|authorization|cookie|session|signature|credential/i;
const REDACT_VALUE = /(sk_live_|sk_test_|whsec_|re_|ghp_|Bearer\s+)[A-Za-z0-9_\-]{6,}/g;

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[deep]";
  if (typeof value === "string") {
    return value.length > 500 ? `${value.slice(0, 500)}…` : value.replace(REDACT_VALUE, (m) => `${m.slice(0, 4)}***`);
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEYS.test(k) ? "***" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

function emit(level: LogLevel, message: string, fields: LogFields = {}): void {
  const line = JSON.stringify({
    level,
    msg: message,
    time: new Date().toISOString(),
    ...(redact(fields) as LogFields),
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (msg: string, fields?: LogFields) => {
    if (process.env.LOG_LEVEL === "debug") emit("debug", msg, fields);
  },
  info: (msg: string, fields?: LogFields) => emit("info", msg, fields),
  warn: (msg: string, fields?: LogFields) => emit("warn", msg, fields),
  error: (msg: string, fields?: LogFields) => emit("error", msg, fields),
};

/** Logs an exception with its context, and returns the user-safe message. */
export function logError(message: string, error: unknown, fields: LogFields = {}): string {
  const safe = error instanceof Error ? error.message : String(error);
  logger.error(message, {
    ...fields,
    error: safe,
    stack: error instanceof Error ? error.stack?.split("\n").slice(0, 4).join(" | ") : undefined,
  });
  return safe;
}
