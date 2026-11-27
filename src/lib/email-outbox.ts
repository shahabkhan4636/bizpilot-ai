import { all, get, run } from "./db";
import { newId } from "./ids";
import { nowIso } from "./utils";
import { isEmailConfigured, sendEmail, type EmailResult } from "./email";
import { logger } from "./logger";

/**
 * The outbox: every transactional email is written to the database first, then
 * dispatched. Nothing is ever "sent" without a row saying so.
 *
 * Why this exists — the failure this replaces:
 *
 *   A password reset with no `RESEND_API_KEY` used to be reported as "not
 *   configured" and then thrown away. The user could not get back into their
 *   account and there was no record to act on. Now the message is `queued`, it
 *   survives, and the moment the key appears it can be dispatched.
 *
 * Rules encoded here:
 *
 *  - `not_configured` does **not** burn a retry. A missing key is a deployment
 *    state, not a delivery failure; the row waits instead of being abandoned.
 *  - A real provider error burns one attempt and schedules the next: 5 minutes,
 *    then 30 minutes, then 2 hours. After the third failure the row is `failed`
 *    and shows up on `/admin/email` for a human decision.
 *  - `sending` is written before the HTTP call, so a crash mid-send is visible
 *    rather than looking untouched.
 */

/** Retry schedule in minutes: three retries after the first attempt. */
export const RETRY_DELAYS_MINUTES = [5, 30, 120] as const;
/** How many retries are allowed (one per entry above). */
export const MAX_RETRIES = RETRY_DELAYS_MINUTES.length;
/** Total tries, including the first one. The row is `failed` after this many. */
export const MAX_TOTAL_ATTEMPTS = MAX_RETRIES + 1;
/** Kept for callers that only care about the retry count. */
export const MAX_ATTEMPTS = MAX_RETRIES;

export type EmailKind =
  | "password_reset"
  | "verify_email"
  | "invite"
  | "account_email"
  | "automation"
  | "platform_payment"
  | "test"
  | "other";

export type OutboxRow = {
  id: string;
  organization_id: string | null;
  to_email: string;
  subject: string;
  body_text: string;
  kind: string;
  status: "queued" | "sending" | "sent" | "failed";
  attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  provider_message_id: string | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
};

export type QueueInput = {
  to: string;
  subject: string;
  text: string;
  kind?: EmailKind;
  organizationId?: string | null;
};

/** Writes a message to the outbox. Returns the row id. */
export function queueEmail(input: QueueInput): string {
  const id = newId();
  const now = nowIso();
  run(
    `insert into email_outbox
       (id, organization_id, to_email, subject, body_text, kind, status, attempts, next_attempt_at, created_at, updated_at)
     values (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      input.organizationId ?? null,
      input.to.trim(),
      input.subject.slice(0, 300),
      input.text,
      input.kind ?? "other",
      "queued",
      0,
      now,
      now,
      now,
    ]
  );
  return id;
}

function nextAttemptIso(attemptsAfterFailure: number, from = new Date()): string | null {
  const minutes = RETRY_DELAYS_MINUTES[attemptsAfterFailure - 1];
  if (minutes === undefined) return null; // no retries left
  return new Date(from.getTime() + minutes * 60_000).toISOString();
}

export type DispatchOutcome =
  | { status: "sent"; providerId: string }
  | { status: "queued"; reason: "not_configured" | "provider_error"; message: string }
  | { status: "failed"; message: string }
  | { status: "skipped"; reason: string };

/**
 * Attempts one outbox row.
 *
 * Exported so the tests can drive the state machine directly and so the cron route
 * can retry a specific row.
 */
export async function attemptDelivery(
  id: string,
  now = new Date(),
  options: { force?: boolean } = {}
): Promise<DispatchOutcome> {
  const row = get<OutboxRow>("select * from email_outbox where id = ?", [id]);
  if (!row) return { status: "skipped", reason: "not_found" };
  if (row.status === "sent") return { status: "skipped", reason: "already_sent" };
  // `force` is a human decision ("the provider is back, retry now"), so it
  // outranks the backoff clock. Without it, a row that is not yet due is skipped —
  // comparing against the same `now` the caller passed in, never the wall clock,
  // so a forced retry cannot be skipped by a millisecond of drift.
  if (!options.force && row.next_attempt_at && new Date(row.next_attempt_at).getTime() > now.getTime()) {
    return { status: "skipped", reason: "not_due" };
  }

  // Deployment not configured: leave the row queued, untouched. Deliberately does
  // not consume an attempt — the email must survive until the key is added.
  if (!isEmailConfigured()) {
    run("update email_outbox set last_error = ?, updated_at = ? where id = ?", [
      "not_configured",
      nowIso(),
      id,
    ]);
    return {
      status: "queued",
      reason: "not_configured",
      message: "Email is not configured. Add RESEND_API_KEY to enable sending.",
    };
  }

  run("update email_outbox set status = 'sending', updated_at = ? where id = ?", [nowIso(), id]);

  const result: EmailResult = await sendEmail({ to: row.to_email, subject: row.subject, text: row.body_text });

  if (result.ok) {
    const sentAt = nowIso();
    run(
      `update email_outbox
          set status = 'sent', provider_message_id = ?, sent_at = ?, next_attempt_at = null,
              last_error = null, updated_at = ?
        where id = ?`,
      [result.id, sentAt, sentAt, id]
    );
    return { status: "sent", providerId: result.id };
  }

  if (result.code === "not_configured") {
    // The key disappeared between the check above and the call (or the provider
    // double reported it): put the row back without burning an attempt.
    run("update email_outbox set status = 'queued', last_error = ?, updated_at = ? where id = ?", [
      "not_configured",
      nowIso(),
      id,
    ]);
    return { status: "queued", reason: "not_configured", message: result.message };
  }

  const attempts = row.attempts + 1;
  const nextAt = nextAttemptIso(attempts, now);
  const exhausted = nextAt === null;
  run(
    `update email_outbox
        set status = ?, attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
      where id = ?`,
    [exhausted ? "failed" : "queued", attempts, nextAt, result.message.slice(0, 500), nowIso(), id]
  );
  logger.warn("email delivery failed", { outboxId: id, attempts, exhausted });

  return exhausted
    ? { status: "failed", message: result.message }
    : { status: "queued", reason: "provider_error", message: result.message };
}

export type DeliverResult = EmailResult & { outboxId: string; queueStatus: DispatchOutcome["status"] };

/**
 * The call sites' entry point: queue, then try once immediately.
 *
 * The returned shape is the same as `sendEmail` so existing UI branches keep
 * working, with `outboxId` added for support ("which row is my email?").
 */
export async function deliverEmail(input: QueueInput): Promise<DeliverResult> {
  const outboxId = queueEmail(input);
  const outcome = await attemptDelivery(outboxId);
  if (outcome.status === "sent") {
    return { ok: true, id: outcome.providerId, outboxId, queueStatus: "sent" };
  }
  if (outcome.status === "skipped") {
    // Already sent — cannot happen for a brand-new row, but never lie about it.
    return { ok: false, code: "provider_error", message: `Skipped: ${outcome.reason}`, outboxId, queueStatus: "skipped" };
  }
  if (outcome.status === "failed") {
    return { ok: false, code: "provider_error", message: outcome.message, outboxId, queueStatus: "failed" };
  }
  if (outcome.status === "queued") {
    return {
      ok: false,
      code: outcome.reason === "not_configured" ? "not_configured" : "provider_error",
      message: outcome.message,
      outboxId,
      queueStatus: "queued",
    };
  }
  return { ok: false, code: "provider_error", message: "Delivery skipped", outboxId, queueStatus: "skipped" };
}

export type DispatchSummary = {
  attempted: number;
  sent: number;
  retried: number;
  failed: number;
  notConfigured: number;
  configured: boolean;
};

/**
 * Works through every due row.
 *
 * Used by `GET /api/cron/email` and by the "retry now" buttons in `/admin/email`.
 * `ids` narrows it to specific rows; `force` ignores `next_attempt_at` (a human
 * asking for a retry outranks the backoff clock).
 */
export async function dispatchQueuedEmails(options: {
  now?: Date;
  limit?: number;
  ids?: string[];
  force?: boolean;
} = {}): Promise<DispatchSummary> {
  const now = options.now ?? new Date();
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 200);

  let rows: OutboxRow[];
  if (options.ids && options.ids.length > 0) {
    rows = all<OutboxRow>(
      `select * from email_outbox where id in (${options.ids.map(() => "?").join(",")}) limit ${limit}`,
      options.ids
    );
  } else if (options.force) {
    rows = all<OutboxRow>(
      "select * from email_outbox where status in ('queued','failed') order by created_at asc limit ?",
      [limit]
    );
  } else {
    rows = all<OutboxRow>(
      `select * from email_outbox
        where status = 'queued' and (next_attempt_at is null or next_attempt_at <= ?)
        order by created_at asc limit ?`,
      [now.toISOString(), limit]
    );
  }

  const summary: DispatchSummary = {
    attempted: rows.length,
    sent: 0,
    retried: 0,
    failed: 0,
    notConfigured: 0,
    configured: isEmailConfigured(),
  };

  for (const row of rows) {
    const outcome = await attemptDelivery(row.id, now, { force: options.force });
    if (outcome.status === "sent") summary.sent += 1;
    else if (outcome.status === "failed") summary.failed += 1;
    else if (outcome.status === "queued" && outcome.reason === "not_configured") summary.notConfigured += 1;
    else if (outcome.status === "queued") summary.retried += 1;
  }

  return summary;
}

export function outboxCounts(): { queued: number; failed: number; sent: number } {
  const row = get<{ queued: number | null; failed: number | null; sent: number | null }>(
    `select sum(case when status = 'queued' then 1 else 0 end) as queued,
            sum(case when status = 'failed' then 1 else 0 end) as failed,
            sum(case when status = 'sent' then 1 else 0 end) as sent
       from email_outbox`
  );
  return {
    queued: Number(row?.queued ?? 0),
    failed: Number(row?.failed ?? 0),
    sent: Number(row?.sent ?? 0),
  };
}

export function listOutbox(options: { status?: "queued" | "failed" | "sent"; limit?: number } = {}): OutboxRow[] {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  if (options.status) {
    return all<OutboxRow>(
      "select * from email_outbox where status = ? order by created_at desc limit ?",
      [options.status, limit]
    );
  }
  return all<OutboxRow>("select * from email_outbox order by created_at desc limit ?", [limit]);
}
