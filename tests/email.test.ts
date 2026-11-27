import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { all, get, resetDatabaseForTests } from "@/lib/db";
import { emailFromAddress, isEmailConfigured, sendEmail } from "@/lib/email";
import {
  MAX_RETRIES,
  MAX_TOTAL_ATTEMPTS,
  RETRY_DELAYS_MINUTES,
  attemptDelivery,
  deliverEmail,
  dispatchQueuedEmails,
  listOutbox,
  outboxCounts,
  queueEmail,
} from "@/lib/email-outbox";

/**
 * Phase 2 — transactional email.
 *
 * Two things must never regress:
 *  1. An email is never reported as sent unless the provider accepted it.
 *  2. A message that cannot be sent is **stored**, not dropped, and a missing API
 *     key waits for configuration instead of burning its retries.
 *
 * The transport is stubbed at `fetch` — the same seam production uses — and the
 * outbox state machine runs against the real database.
 */

const ORIGINAL_ENV = {
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  RESEND_FROM_EMAIL: process.env.RESEND_FROM_EMAIL,
  EMAIL_FROM: process.env.EMAIL_FROM,
  EMAIL_API_URL: process.env.EMAIL_API_URL,
};

function clearEmailEnv() {
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_FROM_EMAIL;
  delete process.env.EMAIL_FROM;
  delete process.env.EMAIL_API_URL;
}

beforeEach(() => {
  resetDatabaseForTests();
  clearEmailEnv();
  vi.unstubAllGlobals();
});

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.unstubAllGlobals();
});

function stubFetch(handler: (body: Record<string, unknown>) => { status?: number; json?: unknown; text?: string }) {
  const calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ url, body, headers: init.headers as Record<string, string> });
    const result = handler(body);
    const status = result.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => result.json ?? { id: "resend_msg_1" },
      text: async () => result.text ?? "",
    } as Response;
  });
  return calls;
}

/* --------------------------------------------------------------- from address */

describe("from address", () => {
  it("uses RESEND_FROM_EMAIL when it is set", () => {
    process.env.RESEND_FROM_EMAIL = "BizPilot <hello@bizpilot.pk>";
    process.env.EMAIL_FROM = "Legacy <old@example.com>";
    expect(emailFromAddress()).toBe("BizPilot <hello@bizpilot.pk>");
  });

  it("falls back to EMAIL_FROM for existing deployments, then to a neutral default", () => {
    process.env.EMAIL_FROM = "Legacy <old@example.com>";
    expect(emailFromAddress()).toBe("Legacy <old@example.com>");
    delete process.env.EMAIL_FROM;
    // A neutral default: never an owner's real address baked into the source.
    expect(emailFromAddress()).toBe("BizPilot AI <no-reply@example.com>");
  });

  it("sends with the configured from address, not a hardcoded one", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.RESEND_FROM_EMAIL = "Shahab Khan <hello@bizpilot.pk>";
    const calls = stubFetch(() => ({ json: { id: "msg_from_check" } }));

    const result = await sendEmail({ to: "customer@example.com", subject: "Hi", text: "Body" });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.from).toBe("Shahab Khan <hello@bizpilot.pk>");
    expect(calls[0]!.body.to).toEqual(["customer@example.com"]);
    expect(calls[0]!.headers.authorization).toBe("Bearer re_test_key");
  });
});

/* ------------------------------------------------------------- not configured */

describe("provider reporting", () => {
  it("reports configured=false and refuses to pretend when the key is missing", async () => {
    expect(isEmailConfigured()).toBe(false);
    const calls = stubFetch(() => ({ json: { id: "should_not_happen" } }));
    const result = await sendEmail({ to: "someone@example.com", subject: "Hi", text: "Body" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("not_configured");
    expect(calls).toHaveLength(0); // no HTTP call at all
  });

  it("surfaces the provider's own error rather than a generic one", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    stubFetch(() => ({ status: 422, text: "domain is not verified" }));
    const result = await sendEmail({ to: "someone@example.com", subject: "Hi", text: "Body" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("provider_error");
      expect(result.message).toContain("422");
      expect(result.message).toContain("domain is not verified");
    }
  });
});

/* -------------------------------------------------------------------- outbox */

describe("outbox queueing", () => {
  it("stores the message before any send is attempted", () => {
    const id = queueEmail({
      to: "customer@example.com",
      subject: "Reset your password",
      text: "link",
      kind: "password_reset",
    });
    const row = get<{ to_email: string; status: string; attempts: number; kind: string }>(
      "select to_email, status, attempts, kind from email_outbox where id = ?",
      [id]
    );
    expect(row?.to_email).toBe("customer@example.com");
    expect(row?.status).toBe("queued");
    expect(row?.attempts).toBe(0);
    expect(row?.kind).toBe("password_reset");
  });

  it("keeps the message queued when the deployment has no API key, and does not burn an attempt", async () => {
    const result = await deliverEmail({ to: "customer@example.com", subject: "Hi", text: "Body", kind: "invite" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("not_configured");

    const row = get<{ status: string; attempts: number; last_error: string }>(
      "select status, attempts, last_error from email_outbox where id = ?",
      [result.outboxId]
    );
    expect(row?.status).toBe("queued"); // survives until the key exists
    expect(row?.attempts).toBe(0); // a missing key is not a delivery failure
    expect(row?.last_error).toBe("not_configured");
  });

  it("delivers once the key exists — the queue is recoverable, not dead", async () => {
    const queued = await deliverEmail({ to: "customer@example.com", subject: "Reset", text: "link", kind: "password_reset" });
    expect(queued.ok).toBe(false);

    // Someone adds the key, then retries: the original message goes out unchanged.
    process.env.RESEND_API_KEY = "re_test_key";
    const calls = stubFetch(() => ({ json: { id: "msg_recovered" } }));
    const summary = await dispatchQueuedEmails({ force: true });

    expect(summary.sent).toBe(1);
    expect(calls[0]!.body.subject).toBe("Reset");
    const row = get<{ status: string; provider_message_id: string; sent_at: string | null }>(
      "select status, provider_message_id, sent_at from email_outbox where id = ?",
      [queued.outboxId]
    );
    expect(row?.status).toBe("sent");
    expect(row?.provider_message_id).toBe("msg_recovered");
    expect(row?.sent_at).toBeTruthy();
  });
});

describe("retry schedule", () => {
  it("schedules 5, 30 and 120 minutes, then gives up as failed", async () => {
    expect(MAX_RETRIES).toBe(3);
    expect(MAX_TOTAL_ATTEMPTS).toBe(4);
    process.env.RESEND_API_KEY = "re_test_key";
    stubFetch(() => ({ status: 500, text: "provider is down" }));

    const result = await deliverEmail({ to: "customer@example.com", subject: "Hi", text: "Body" });
    const afterFirst = get<{ status: string; attempts: number; next_attempt_at: string }>(
      "select status, attempts, next_attempt_at from email_outbox where id = ?",
      [result.outboxId]
    );
    expect(afterFirst?.status).toBe("queued");
    expect(afterFirst?.attempts).toBe(1);
    const firstDelayMin = Math.round(
      (new Date(afterFirst!.next_attempt_at).getTime() - Date.now()) / 60_000
    );
    expect(firstDelayMin).toBeGreaterThanOrEqual(4);
    expect(firstDelayMin).toBeLessThanOrEqual(RETRY_DELAYS_MINUTES[0]!);

    // Not due yet: the worker must leave it alone.
    const early = await dispatchQueuedEmails();
    expect(early.attempted).toBe(0);
    expect(early.sent).toBe(0);

    // Force past the clock, twice more: 2nd and 3rd failures, with the delays
    // measured from the moment the attempt was made (not from "now").
    const t2 = new Date(Date.now() + 10 * 60_000);
    await attemptDelivery(result.outboxId, t2);
    const afterSecond = get<{ attempts: number; status: string; next_attempt_at: string }>(
      "select attempts, status, next_attempt_at from email_outbox where id = ?",
      [result.outboxId]
    );
    expect(afterSecond?.attempts).toBe(2);
    expect(afterSecond?.status).toBe("queued");
    expect(Math.round((new Date(afterSecond!.next_attempt_at).getTime() - t2.getTime()) / 60_000)).toBe(
      RETRY_DELAYS_MINUTES[1]
    );

    const t3 = new Date(Date.now() + 60 * 60_000);
    const third = await attemptDelivery(result.outboxId, t3);
    expect(third.status).toBe("queued");
    const afterThird = get<{ attempts: number; next_attempt_at: string }>(
      "select attempts, next_attempt_at from email_outbox where id = ?",
      [result.outboxId]
    );
    expect(afterThird?.attempts).toBe(MAX_RETRIES);
    expect(Math.round((new Date(afterThird!.next_attempt_at).getTime() - t3.getTime()) / 60_000)).toBe(
      RETRY_DELAYS_MINUTES[2]
    );

    // Fourth try is the last: no schedule left, so the row needs a human.
    const fourth = await attemptDelivery(result.outboxId, new Date(Date.now() + 5 * 60 * 60_000));
    expect(fourth.status).toBe("failed");
    const afterFourth = get<{ attempts: number; status: string; next_attempt_at: string | null }>(
      "select attempts, status, next_attempt_at from email_outbox where id = ?",
      [result.outboxId]
    );
    expect(afterFourth?.attempts).toBe(MAX_TOTAL_ATTEMPTS);
    expect(afterFourth?.status).toBe("failed");
    expect(afterFourth?.next_attempt_at).toBeNull();

    // A failed row is not picked up by the automatic worker.
    const automatic = await dispatchQueuedEmails();
    expect(automatic.attempted).toBe(0);
    expect(listOutbox({ status: "failed" })).toHaveLength(1);
  });

  it("sends within the same deliverEmail call when the provider works", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    stubFetch(() => ({ json: { id: "msg_ok" } }));
    const result = await deliverEmail({ to: "customer@example.com", subject: "Hi", text: "Body", kind: "verify_email" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.id).toBe("msg_ok");
    expect(outboxCounts()).toEqual({ queued: 0, failed: 0, sent: 1 });
  });
});

describe("outbox reporting", () => {
  it("counts queued, failed and sent rows for the admin page", async () => {
    queueEmail({ to: "a@example.com", subject: "1", text: "x" });
    queueEmail({ to: "b@example.com", subject: "2", text: "x" });
    process.env.RESEND_API_KEY = "re_test_key";
    stubFetch(() => ({ json: { id: "msg_counts" } }));
    await dispatchQueuedEmails();

    expect(outboxCounts()).toEqual({ queued: 0, failed: 0, sent: 2 });
    expect(all<{ id: string }>("select id from email_outbox where status = 'sent'")).toHaveLength(2);
  });

  it("never touches other rows when a specific id is retried", async () => {
    const first = queueEmail({ to: "a@example.com", subject: "1", text: "x" });
    queueEmail({ to: "b@example.com", subject: "2", text: "x" });
    process.env.RESEND_API_KEY = "re_test_key";
    stubFetch(() => ({ json: { id: "msg_one" } }));

    const summary = await dispatchQueuedEmails({ ids: [first], force: true });
    expect(summary.attempted).toBe(1);
    expect(summary.sent).toBe(1);
    expect(
      get<{ status: string }>("select status from email_outbox where id = ?", [first])?.status
    ).toBe("sent");
    expect(all<{ id: string }>("select id from email_outbox where status = 'queued'")).toHaveLength(1);
  });

  it("does not resend a message that was already delivered", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    const calls = stubFetch(() => ({ json: { id: "msg_once" } }));
    const first = await deliverEmail({ to: "a@example.com", subject: "Once", text: "x" });
    expect(first.ok).toBe(true);
    const replay = await dispatchQueuedEmails({ ids: [first.outboxId], force: true });
    expect(replay.attempted).toBe(1);
    expect(replay.sent).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("keeps the row count honest when the database is empty", () => {
    expect(outboxCounts()).toEqual({ queued: 0, failed: 0, sent: 0 });
    expect(listOutbox()).toHaveLength(0);
  });
});
