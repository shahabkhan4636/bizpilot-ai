import { createHash } from "node:crypto";
import { get, run } from "./db";
import { newId, newToken } from "./ids";
import { addDays, nowIso } from "./utils";

/**
 * Email verification.
 *
 * A new account is usable immediately (SMB users hate waiting on a mail server),
 * but it is marked unverified and the UI keeps prompting until the address is
 * proven. Tokens are single-use, hashed at rest and expire in 48 hours.
 */

const TTL_HOURS = 48;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function issueVerificationToken(userId: string, email: string): { token: string; expiresAt: string } {
  // Only one live token per account: re-issuing invalidates the previous link.
  run("delete from email_verifications where user_id = ? and used_at is null", [userId]);
  const token = newToken(32);
  const expiresAt = addDays(TTL_HOURS / 24).toISOString();
  run(
    `insert into email_verifications (id, user_id, email, token_hash, expires_at, created_at)
     values (?,?,?,?,?,?)`,
    [newId(), userId, email.toLowerCase(), sha256(token), expiresAt, nowIso()]
  );
  return { token, expiresAt };
}

export type VerificationResult =
  | { ok: true; email: string }
  | { ok: false; reason: "invalid" | "expired" | "used" };

export function consumeVerificationToken(token: string): VerificationResult {
  if (!token) return { ok: false, reason: "invalid" };
  const row = get<{ id: string; user_id: string; email: string; expires_at: string; used_at: string | null }>(
    "select id, user_id, email, expires_at, used_at from email_verifications where token_hash = ?",
    [sha256(token)]
  );
  if (!row) return { ok: false, reason: "invalid" };
  if (row.used_at) return { ok: false, reason: "used" };
  if (new Date(row.expires_at) < new Date()) return { ok: false, reason: "expired" };

  const now = nowIso();
  run("update email_verifications set used_at = ? where id = ?", [now, row.id]);
  run("update profiles set email_verified_at = ?, updated_at = ? where id = ?", [now, now, row.user_id]);
  return { ok: true, email: row.email };
}

export function isEmailVerified(userId: string): boolean {
  const row = get<{ email_verified_at: string | null }>("select email_verified_at from profiles where id = ?", [userId]);
  return Boolean(row?.email_verified_at);
}
