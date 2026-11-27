/**
 * Transactional email via Resend — the transport only.
 *
 * Without RESEND_API_KEY we do not pretend an email was sent: callers receive
 * { ok:false, code:'not_configured' } and the UI shows the real state. Delivery,
 * queueing and retries live in `email-outbox.ts`; this module just talks HTTP.
 */
export type EmailResult =
  | { ok: true; id: string }
  | { ok: false; code: "not_configured" | "provider_error"; message: string };

export function isEmailConfigured(): boolean {
  return (process.env.RESEND_API_KEY ?? "").trim().length > 0;
}

/**
 * The address every email is sent from.
 *
 * `RESEND_FROM_EMAIL` is the documented variable; `EMAIL_FROM` is still honoured so
 * existing deployments keep working, and the neutral default keeps development
 * honest instead of pretending to be a real mailbox. Never hardcode an owner's
 * address here — the deployed value is configuration.
 */
export function emailFromAddress(): string {
  const preferred = (process.env.RESEND_FROM_EMAIL ?? "").trim();
  if (preferred) return preferred;
  const legacy = (process.env.EMAIL_FROM ?? "").trim();
  if (legacy) return legacy;
  return "BizPilot AI <no-reply@example.com>";
}

export async function sendEmail(input: {
  to: string;
  subject: string;
  text: string;
  /** Overrides the configured from-address (used by the admin test-send). */
  from?: string;
}): Promise<EmailResult> {
  const apiKey = process.env.RESEND_API_KEY ?? "";
  if (!apiKey) {
    return { ok: false, code: "not_configured", message: "Email is not configured. Add RESEND_API_KEY to enable sending." };
  }
  try {
    // Overridable so a self-hosted Resend-compatible proxy — and the integration
    // test against a local double — use the same code path as production.
    const endpoint = (process.env.EMAIL_API_URL ?? "https://api.resend.com/emails").trim();
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        from: input.from ?? emailFromAddress(),
        to: [input.to],
        subject: input.subject,
        text: input.text,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { ok: false, code: "provider_error", message: `Resend returned ${res.status}: ${detail.slice(0, 180)}` };
    }
    const data = (await res.json()) as { id?: string };
    return { ok: true, id: data.id ?? "unknown" };
  } catch (error) {
    return { ok: false, code: "provider_error", message: error instanceof Error ? error.message : "Email request failed" };
  }
}
