"use server";

import { revalidatePath } from "next/cache";
import { run, get, all } from "@/lib/db";
import { newId } from "@/lib/ids";
import { nowIso } from "@/lib/utils";
import { requireAuth } from "@/lib/auth";
import { audit, logActivity } from "@/lib/audit";
import { checkAiLimit, checkFeature, recordUsage } from "@/lib/plans";
import { recordAiUsage } from "@/lib/ai-usage";
import { sendEmail, isEmailConfigured } from "@/lib/email";
import { generateText, buildContentPrompt, AI_KINDS, AI_KIND_LABEL, type AiKind } from "@/lib/ai";
import { ValidationError, str, optionalStr, oneOf, email as emailField } from "@/lib/validate";
import { rateLimit } from "@/lib/ratelimit";

export type AiState = {
  error?: string;
  notice?: string;
  text?: string;
  messageId?: string;
  method?: "ai" | "not_configured" | "rate_limited" | "provider_error" | "empty";
  kind?: string;
  approved?: boolean;
  /** Present when a generation succeeded: real token counts and priced cost. */
  usage?: { tokens: number; costUsd: number | null } | null;
} | null;

function handle(e: unknown): AiState {
  if (e instanceof ValidationError) return { error: e.message };
  return { error: e instanceof Error ? e.message : "Unexpected error." };
}

export async function generateContentAction(_prev: AiState, form: FormData): Promise<AiState> {
  try {
    const { user, membership } = await requireAuth();
    const orgId = membership.organization_id;

    const feature = checkFeature(orgId, "ai_assistant");
    if (!feature.allowed) return { error: feature.reason ?? "The AI assistant is not included in your plan." };

    const limit = checkAiLimit(orgId);
    if (!limit.allowed) return { error: limit.reason ?? "AI generation limit reached." };

    const rl = rateLimit(`ai:${orgId}`, 30, 60);
    if (!rl.allowed) return { error: `Slow down a little — try again in ${rl.resetInSeconds}s.` };

    const kind = oneOf(form.get("kind"), "Content type", AI_KINDS, "sales_email") as AiKind;
    const tone = optionalStr(form.get("tone"), 40) || "professional";
    const language = optionalStr(form.get("language"), 40) || "English";
    const objective = optionalStr(form.get("objective"), 200) || "";
    const services = optionalStr(form.get("services"), 400) || "";
    const pricing = optionalStr(form.get("pricing"), 200) || "";
    const extra = optionalStr(form.get("extra"), 1000) || "";
    const customerName = optionalStr(form.get("customer_name"), 120) || "";
    const customerCompany = optionalStr(form.get("customer_company"), 120) || "";
    const customerNotes = optionalStr(form.get("customer_notes"), 600) || "";
    const leadId = optionalStr(form.get("lead_id"), 60) || null;

    if (leadId && !get("select id from leads where id = ? and organization_id = ?", [leadId, orgId])) {
      return { error: "That lead does not belong to this workspace." };
    }

    const org = get<{ name: string }>("select name from organizations where id = ?", [orgId]);
    const brief = {
      kind,
      businessName: org?.name ?? "our business",
      services,
      tone,
      language,
      objective,
      customerName,
      customerCompany,
      customerNotes,
      pricing,
      extra,
    };
    const { system, prompt } = buildContentPrompt(brief);
    const result = await generateText({ system, prompt });

    // A failed generation is never replaced by invented text.
    const body = result.ok
      ? result.text.trim()
      : `AI generation is unavailable: ${result.message}\n\nThis draft was not generated. Configure AI_API_KEY (and optionally AI_MODEL / AI_BASE_URL) to enable generation, or write the message manually below and save it.`;

    const messageId = newId();
    run(
      `insert into messages (id, organization_id, lead_id, customer_id, direction, channel, subject, body, status, created_at)
       values (?,?,?,?,?,?,?,?,?,?)`,
      [messageId, orgId, leadId, null, "outbound", "ai_draft", AI_KIND_LABEL[kind], body, "draft", nowIso()]
    );

    let usage: { tokens: number; costUsd: number | null } | null = null;
    if (result.ok) {
      recordUsage(orgId, "ai_generation");
      // Tokens come from the provider's own usage object; cost from configured prices.
      usage = recordAiUsage({
        organizationId: orgId,
        provider: result.provider,
        model: result.model,
        promptTokens: result.usage?.promptTokens ?? 0,
        completionTokens: result.usage?.completionTokens ?? 0,
      });
    }
    logActivity({
      organizationId: orgId, actorId: user.id, entityType: "message", entityId: messageId,
      action: result.ok ? "ai.generated" : "ai.failed",
      summary: result.ok ? `Generated ${AI_KIND_LABEL[kind]}` : `AI generation failed (${result.code})`,
    });

    revalidatePath("/ai-assistant");
    return {
      text: body,
      messageId,
      method: result.ok ? "ai" : result.code,
      kind: AI_KIND_LABEL[kind],
      usage,
      notice: result.ok ? undefined : `Provider state: ${result.code}`,
      error: result.ok ? undefined : result.message,
    };
  } catch (e) {
    return handle(e);
  }
}

/** Saves edits to a draft. Approving is a separate, explicit step. */
export async function saveDraftAction(_prev: AiState, form: FormData): Promise<AiState> {
  try {
    const { user, membership } = await requireAuth();
    const orgId = membership.organization_id;
    const messageId = str(form.get("message_id"), "Draft", { min: 4 });
    const subject = optionalStr(form.get("subject"), 200) || "Untitled draft";
    const body = str(form.get("body"), "Message body", { min: 1, max: 20000 });

    const draft = get<{ id: string; status: string }>("select id, status from messages where id = ? and organization_id = ?", [messageId, orgId]);
    if (!draft) return { error: "Draft not found in this workspace." };
    if (draft.status === "sent") return { error: "This message has already been sent and cannot be edited." };

    run("update messages set subject = ?, body = ?, status = 'draft' where id = ? and organization_id = ?", [subject, body, messageId, orgId]);
    audit({ organizationId: orgId, actorId: user.id, action: "message.save_draft", targetType: "message", targetId: messageId });
    revalidatePath("/ai-assistant");
    return { notice: "Draft saved.", messageId, text: body };
  } catch (e) {
    return handle(e);
  }
}

/**
 * The approval gate. Nothing leaves the system before this runs, and it
 * refuses to run unless the approver explicitly ticked the box.
 */
export async function approveAndSendAction(_prev: AiState, form: FormData): Promise<AiState> {
  try {
    const { user, membership } = await requireAuth();
    const orgId = membership.organization_id;
    const messageId = str(form.get("message_id"), "Draft", { min: 4 });
    const to = emailField(form.get("to"), "Recipient email");
    const subject = str(form.get("subject"), "Subject", { min: 2, max: 200 });
    const body = str(form.get("body"), "Message body", { min: 1, max: 20000 });
    const approved = form.get("approved") === "on" || form.get("approved") === "true";

    if (!approved) {
      return { error: "Tick the approval checkbox first — nothing is sent without an explicit human approval." };
    }

    const draft = get<{ id: string; status: string; body: string }>(
      "select id, status, body from messages where id = ? and organization_id = ?",
      [messageId, orgId]
    );
    if (!draft) return { error: "Draft not found in this workspace." };
    if (draft.status === "sent") return { error: "This message has already been sent." };

    run("update messages set subject = ?, body = ? where id = ? and organization_id = ?", [subject, body, messageId, orgId]);

    if (!isEmailConfigured()) {
      // Saved as approved-but-unsent, with the real reason. No false "sent" state.
      run("update messages set status = 'approved_unsent', approved_by = ? where id = ? and organization_id = ?", [user.id, messageId, orgId]);
      audit({ organizationId: orgId, actorId: user.id, action: "message.approved_unsent", targetType: "message", targetId: messageId });
      return {
        error:
          "Email delivery is not configured (RESEND_API_KEY missing), so nothing was sent. The approved message is saved and can be copied out manually.",
        text: body,
      };
    }

    const sent = await sendEmail({ to, subject, text: body });
    if (!sent.ok) {
      run("update messages set status = 'failed' where id = ? and organization_id = ?", [messageId, orgId]);
      audit({ organizationId: orgId, actorId: user.id, action: "message.send_failed", targetType: "message", targetId: messageId, metadata: { code: sent.code } });
      return { error: `Sending failed: ${sent.message}` };
    }

    run(
      "update messages set status = 'sent', approved_by = ?, provider_message_id = ?, sent_at = ? where id = ? and organization_id = ?",
      [user.id, sent.id, nowIso(), messageId, orgId]
    );
    logActivity({ organizationId: orgId, actorId: user.id, entityType: "message", entityId: messageId, action: "message.sent", summary: `Approved message sent to ${to}` });
    audit({ organizationId: orgId, actorId: user.id, action: "message.send", targetType: "message", targetId: messageId });
    revalidatePath("/ai-assistant");
    return { notice: `Approved and sent to ${to}.`, messageId, text: body };
  } catch (e) {
    return handle(e);
  }
}

export async function recentDrafts(organizationId: string, limit = 12) {
  return all<{ id: string; subject: string | null; body: string; status: string; created_at: string; sent_at: string | null }>(
    `select id, subject, body, status, created_at, sent_at from messages
      where organization_id = ? order by created_at desc limit ?`,
    [organizationId, limit]
  );
}
