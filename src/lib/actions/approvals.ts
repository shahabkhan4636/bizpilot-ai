"use server";

import { revalidatePath } from "next/cache";
import { get, run } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { sendEmail, isEmailConfigured } from "@/lib/email";
import { nowIso } from "@/lib/utils";
import { checkAiLimit } from "@/lib/plans";

export type ApprovalState = { error?: string; notice?: string } | null;

/**
 * Sends a message that an automation (or the AI assistant) queued for approval.
 * The row must already exist in this workspace — a browser cannot invent one.
 */
export async function approveQueuedMessageAction(_prev: ApprovalState, form: FormData): Promise<ApprovalState> {
  const { user, membership } = await requireAuth();
  const orgId = membership.organization_id;
  const messageId = String(form.get("message_id") ?? "");
  if (form.get("approved") !== "on") {
    return { error: "Tick the approval box first — nothing is sent without an explicit human approval." };
  }

  const message = get<{ id: string; status: string; subject: string | null; body: string; lead_id: string | null; customer_id: string | null }>(
    "select id, status, subject, body, lead_id, customer_id from messages where id = ? and organization_id = ?",
    [messageId, orgId]
  );
  if (!message) return { error: "That message is not in this workspace." };
  if (message.status === "sent") return { error: "This message has already been sent." };
  if (message.status === "rejected") return { error: "This message was rejected. Queue a new one instead." };

  const recipient = message.lead_id
    ? get<{ email: string | null }>("select email from leads where id = ? and organization_id = ?", [message.lead_id, orgId])?.email
    : message.customer_id
      ? get<{ email: string | null }>("select email from customers where id = ? and organization_id = ?", [message.customer_id, orgId])?.email
      : null;
  if (!recipient) {
    return { error: "This record has no email address, so the message cannot be sent. Add one and try again." };
  }

  if (!isEmailConfigured()) {
    run("update messages set status = 'approved_unsent', approved_by = ? where id = ? and organization_id = ?", [user.id, messageId, orgId]);
    audit({ organizationId: orgId, actorId: user.id, action: "message.approved_unsent", targetType: "message", targetId: messageId });
    revalidatePath("/approvals");
    return {
      error:
        "Approved and saved, but no email was sent because RESEND_API_KEY is not configured. Nothing is faked as delivered.",
    };
  }

  const limit = checkAiLimit(orgId);
  if (!limit.allowed) return { error: limit.reason ?? "You have reached the limit of your plan." };

  const sent = await sendEmail({
    to: recipient,
    subject: message.subject ?? "A message from us",
    text: message.body,
  });
  if (!sent.ok) {
    run("update messages set status = 'failed' where id = ? and organization_id = ?", [messageId, orgId]);
    audit({ organizationId: orgId, actorId: user.id, action: "message.send_failed", targetType: "message", targetId: messageId });
    revalidatePath("/approvals");
    return { error: `The email provider rejected the message: ${sent.message}` };
  }

  run("update messages set status = 'sent', approved_by = ?, provider_message_id = ?, sent_at = ? where id = ? and organization_id = ?", [
    user.id, sent.id, nowIso(), messageId, orgId,
  ]);
  audit({ organizationId: orgId, actorId: user.id, action: "message.sent", targetType: "message", targetId: messageId });
  revalidatePath("/approvals");
  return { notice: "Sent." };
}

export async function rejectQueuedMessageAction(form: FormData): Promise<void> {
  const { user, membership } = await requireAuth();
  const messageId = String(form.get("message_id") ?? "");
  run("update messages set status = 'rejected', approved_by = ? where id = ? and organization_id = ? and status <> 'sent'", [
    user.id, messageId, membership.organization_id,
  ]);
  audit({ organizationId: membership.organization_id, actorId: user.id, action: "message.rejected", targetType: "message", targetId: messageId });
  revalidatePath("/approvals");
}
