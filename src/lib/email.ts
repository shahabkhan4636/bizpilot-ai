/**
 * Transactional email via Resend.
 * Without RESEND_API_KEY we do not pretend an email was sent: callers receive
 * { ok:false, code:'not_configured' } and the UI shows the real state.
 */
export type EmailResult =
  | { ok: true; id: string }
  | { ok: false; code: "not_configured" | "provider_error"; message: string };

export function isEmailConfigured(): boolean {
  return (process.env.RESEND_API_KEY ?? "").trim().length > 0;
}

export async function sendEmail(input: { to: string; subject: string; text: string }): Promise<EmailResult> {
  const apiKey = process.env.RESEND_API_KEY ?? "";
  if (!apiKey) {
    return { ok: false, code: "not_configured", message: "Email is not configured. Add RESEND_API_KEY to enable sending." };
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM ?? "BizPilot AI <no-reply@example.com>",
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
