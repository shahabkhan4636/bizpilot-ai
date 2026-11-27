"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { run, get, all, tx } from "@/lib/db";
import { newId, newShareToken } from "@/lib/ids";
import { addDays, nowIso } from "@/lib/utils";
import { requireAuth } from "@/lib/auth";
import { forbiddenRedirect, requirePermission } from "@/lib/authz";
import { audit, logActivity } from "@/lib/audit";
import { checkDocumentLimit, checkFeature } from "@/lib/plans";
import { ValidationError, str, optionalStr } from "@/lib/validate";
import { dispatchTrigger } from "@/lib/automations";
import { computeTotals } from "@/lib/proposal-math";
import { notify } from "@/lib/notifications";
import { safeParse } from "@/lib/plans";

export type ProposalState = { error?: string; notice?: string } | null;

function handle(e: unknown): ProposalState {
  if (e instanceof ValidationError) return { error: e.message };
  return { error: e instanceof Error ? e.message : "Unexpected error." };
}

type ItemInput = { description: string; quantity: number; unit_price_cents: number; amount_cents: number };

function parseItems(form: FormData): ItemInput[] {
  const descriptions = form.getAll("item_description").map((v) => String(v).trim());
  const quantities = form.getAll("item_quantity").map((v) => String(v));
  const prices = form.getAll("item_price").map((v) => String(v));

  const items: ItemInput[] = [];
  descriptions.forEach((description, i) => {
    if (!description) return;
    const quantity = Number(quantities[i] ?? 1);
    const unit = Math.round(Number(prices[i] ?? 0) * 100);
    if (!Number.isFinite(quantity) || quantity <= 0) throw new ValidationError(`Line ${i + 1}: quantity must be greater than zero.`);
    if (!Number.isFinite(unit) || unit < 0) throw new ValidationError(`Line ${i + 1}: price must be zero or more.`);
    items.push({
      description,
      quantity,
      unit_price_cents: unit,
      amount_cents: Math.round(quantity * unit),
    });
  });
  if (items.length === 0) throw new ValidationError("Add at least one line item.");
  return items;
}

/**
 * Server-side read of the discount controls. Anything non-numeric is treated as
 * zero rather than being trusted, and the values are clamped.
 */
function readDiscount(form: FormData): { percent: number; cents: number } {
  const percent = Math.min(100, Math.max(0, Number(form.get("discount_percent") ?? 0) || 0));
  const cents = Math.max(0, Math.round((Number(form.get("discount_amount") ?? 0) || 0) * 100));
  return { percent, cents };
}

/** How long a public share link stays valid. 0 or empty means never expires. */
function readShareDays(form: FormData): number {
  const raw = Number(form.get("share_expiry_days") ?? 30);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(365, Math.round(raw));
}

export async function createProposalAction(_prev: ProposalState, form: FormData): Promise<ProposalState> {
  try {
    await requirePermission("proposal:write");
  } catch (e) {
    return handle(e);
  }
  let id = "";
  try {
    const { user, membership } = await requireAuth();
    const orgId = membership.organization_id;

    const feature = checkFeature(orgId, "proposals");
    if (!feature.allowed) return { error: feature.reason ?? "Proposals are not included in your plan." };
    const docLimit = checkDocumentLimit(orgId);
    if (!docLimit.allowed) return { error: docLimit.reason ?? "Document limit reached." };

    const title = str(form.get("title"), "Proposal title", { min: 3, max: 160 });
    const clientName = str(form.get("client_name"), "Client name", { min: 2, max: 120 });
    const clientEmail = optionalStr(form.get("client_email"), 160) || null;
    const summary = optionalStr(form.get("summary"), 4000) || null;
    const scope = optionalStr(form.get("scope"), 8000) || null;
    const terms = optionalStr(form.get("terms"), 4000) || null;
    const currency = (optionalStr(form.get("currency"), 8) || "USD").toUpperCase();
    const taxPercent = Math.min(100, Math.max(0, Number(form.get("tax_percent") ?? 0) || 0));
    const items = parseItems(form);
    const discount = readDiscount(form);
    const shareDays = readShareDays(form);
    const { subtotal, discount: discountCents, tax, total } = computeTotals(items, taxPercent, discount);

    const customerId = optionalStr(form.get("customer_id"), 60) || null;
    const leadId = optionalStr(form.get("lead_id"), 60) || null;
    if (customerId && !get("select id from customers where id = ? and organization_id = ?", [customerId, orgId])) {
      throw new ValidationError("That customer does not belong to this workspace.");
    }
    if (leadId && !get("select id from leads where id = ? and organization_id = ?", [leadId, orgId])) {
      throw new ValidationError("That lead does not belong to this workspace.");
    }

    id = newId();
    const now = nowIso();
    tx(() => {
      run(
        `insert into proposals (id, organization_id, customer_id, lead_id, created_by, title, client_name, client_email,
            summary, scope, terms, currency, subtotal_cents, discount_cents, discount_percent, tax_cents, total_cents,
            status, share_token, share_expires_at, version, expires_at, created_at, updated_at)
         values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, orgId, customerId, leadId, user.id, title, clientName, clientEmail, summary, scope, terms, currency,
         subtotal, discountCents, Math.round(Number(discount.percent ?? 0)), tax, total,
         "draft", newShareToken(), addDays(shareDays).toISOString(), 1, addDays(30).toISOString(), now, now]
      );
      items.forEach((item, index) => {
        run(
          `insert into proposal_items (id, organization_id, proposal_id, description, quantity, unit_price_cents, amount_cents, sort_order)
           values (?,?,?,?,?,?,?,?)`,
          [newId(), orgId, id, item.description, item.quantity, item.unit_price_cents, item.amount_cents, index]
        );
      });
    });

    logActivity({ organizationId: orgId, actorId: user.id, entityType: "proposal", entityId: id, action: "proposal.created", summary: `Proposal "${title}" created for ${clientName}` });
    audit({ organizationId: orgId, actorId: user.id, action: "proposal.create", targetType: "proposal", targetId: id });
  } catch (e) {
    return handle(e);
  }
  revalidatePath("/proposals");
  redirect(`/proposals/${id}`);
}

export async function updateProposalAction(_prev: ProposalState, form: FormData): Promise<ProposalState> {
  try {
    try {
      await requirePermission("proposal:write");
    } catch (e) {
      return handle(e);
    }
    const { user, membership } = await requireAuth();
    const orgId = membership.organization_id;
    const id = str(form.get("proposal_id"), "Proposal", { min: 4 });
    const existing = get<{ version: number; status: string; title: string; total_cents: number }>(
      "select version, status, title, total_cents from proposals where id = ? and organization_id = ?",
      [id, orgId]
    );
    if (!existing) return { error: "Proposal not found in this workspace." };
    if (existing.status === "accepted") {
      return { error: "This proposal has been accepted by the client and can no longer be edited. Create a new version instead." };
    }

    const title = str(form.get("title"), "Proposal title", { min: 3, max: 160 });
    const clientName = str(form.get("client_name"), "Client name", { min: 2, max: 120 });
    const taxPercent = Math.min(100, Math.max(0, Number(form.get("tax_percent") ?? 0) || 0));
    const items = parseItems(form);
    const discount = readDiscount(form);
    const shareDays = readShareDays(form);
    const { subtotal, discount: discountCents, tax, total } = computeTotals(items, taxPercent, discount);

    const now = nowIso();
    tx(() => {
      run(
        `update proposals set title = ?, client_name = ?, client_email = ?, summary = ?, scope = ?, terms = ?,
            currency = ?, subtotal_cents = ?, discount_cents = ?, discount_percent = ?, tax_cents = ?, total_cents = ?,
            share_expires_at = coalesce(?, share_expires_at), version = version + 1, updated_at = ?
          where id = ? and organization_id = ?`,
        [title, clientName, optionalStr(form.get("client_email"), 160) || null,
         optionalStr(form.get("summary"), 4000) || null, optionalStr(form.get("scope"), 8000) || null,
         optionalStr(form.get("terms"), 4000) || null, (optionalStr(form.get("currency"), 8) || "USD").toUpperCase(),
         subtotal, discountCents, Math.round(Number(discount.percent ?? 0)), tax, total,
         shareDays > 0 ? addDays(shareDays).toISOString() : null, now, id, orgId]
      );
      run("delete from proposal_items where proposal_id = ? and organization_id = ?", [id, orgId]);
      items.forEach((item, index) => {
        run(
          `insert into proposal_items (id, organization_id, proposal_id, description, quantity, unit_price_cents, amount_cents, sort_order)
           values (?,?,?,?,?,?,?,?)`,
          [newId(), orgId, id, item.description, item.quantity, item.unit_price_cents, item.amount_cents, index]
        );
      });
    });

    // Version history snapshot lives in the append-only activity log.
    logActivity({
      organizationId: orgId, actorId: user.id, entityType: "proposal", entityId: id, action: "proposal.version_created",
      summary: `Version ${existing.version + 1} of "${title}" saved`,
      metadata: { version: existing.version + 1, previous_total_cents: existing.total_cents, total_cents: total, items },
    });
    audit({ organizationId: orgId, actorId: user.id, action: "proposal.update", targetType: "proposal", targetId: id });
  } catch (e) {
    return handle(e);
  }
  revalidatePath("/proposals");
  return { notice: "Proposal saved as a new version." };
}

export async function sendProposalAction(_prev: ProposalState, form: FormData): Promise<ProposalState> {
  try {
    try {
      await requirePermission("proposal:write");
    } catch (e) {
      return handle(e);
    }
    const { user, membership } = await requireAuth();
    const orgId = membership.organization_id;
    const id = str(form.get("proposal_id"), "Proposal", { min: 4 });
    const proposal = get<{ id: string; status: string; share_token: string | null; title: string; client_email: string | null }>(
      "select id, status, share_token, title, client_email from proposals where id = ? and organization_id = ?",
      [id, orgId]
    );
    if (!proposal) return { error: "Proposal not found in this workspace." };
    if (proposal.status === "accepted") return { error: "That proposal is already accepted." };

    const token = proposal.share_token ?? newShareToken();
    run(
      "update proposals set status = 'sent', share_token = ?, updated_at = ? where id = ? and organization_id = ?",
      [token, nowIso(), id, orgId]
    );
    logActivity({ organizationId: orgId, actorId: user.id, entityType: "proposal", entityId: id, action: "proposal.sent", summary: `Share link created for "${proposal.title}"` });
    audit({ organizationId: orgId, actorId: user.id, action: "proposal.send", targetType: "proposal", targetId: id });

    if (proposal.client_email) {
      run(
        "insert into messages (id, organization_id, lead_id, customer_id, direction, channel, subject, body, status, created_at) values (?,?,?,?,?,?,?,?,?,?)",
        [newId(), orgId, null, null, "outbound", "email", `Proposal: ${proposal.title}`,
         `A share link for this proposal is ready: /p/${token}`, "pending_approval", nowIso()]
      );
    }
  } catch (e) {
    return handle(e);
  }
  revalidatePath("/proposals");
  return { notice: "Proposal marked as sent. The share link is ready below — sending email still requires approval." };
}

export async function setProposalStatusAction(_prev: ProposalState, form: FormData): Promise<ProposalState> {
  try {
    try {
      await requirePermission("proposal:write");
    } catch (e) {
      return handle(e);
    }
    const { user, membership } = await requireAuth();
    const orgId = membership.organization_id;
    const id = str(form.get("proposal_id"), "Proposal", { min: 4 });
    const status = str(form.get("status"), "Status", { min: 4 });
    if (!["draft", "sent", "expired"].includes(status)) {
      return { error: "Accepted and rejected states can only be set by the client from the share link — never by staff." };
    }
    run("update proposals set status = ?, updated_at = ? where id = ? and organization_id = ?", [status, nowIso(), id, orgId]);
    audit({ organizationId: orgId, actorId: user.id, action: "proposal.status", targetType: "proposal", targetId: id, metadata: { status } });
  } catch (e) {
    return handle(e);
  }
  revalidatePath("/proposals");
  return { notice: "Status updated." };
}

export async function deleteProposalAction(form: FormData): Promise<void> {
  try {
    await requirePermission("proposal:delete");
  } catch {
    forbiddenRedirect("proposal:delete");
  }
  const { user, membership } = await requireAuth();
  const orgId = membership.organization_id;
  const id = String(form.get("proposal_id") ?? "");
  run("delete from proposal_items where proposal_id = ? and organization_id = ?", [id, orgId]);
  run("delete from proposals where id = ? and organization_id = ?", [id, orgId]);
  audit({ organizationId: orgId, actorId: user.id, action: "proposal.delete", targetType: "proposal", targetId: id });
  revalidatePath("/proposals");
  redirect("/proposals");
}

/* -------------------------------------------------- public (token) actions */

/** Client accepts. Only reachable with a valid, unexpired share token. */
export async function acceptProposalAction(_prev: ProposalState, form: FormData): Promise<ProposalState> {
  try {
    const token = String(form.get("token") ?? "");
    const name = str(form.get("accepted_by"), "Your name", { min: 2, max: 120 });
    const proposal = get<{ id: string; organization_id: string; status: string; expires_at: string | null; title: string }>(
      "select id, organization_id, status, expires_at, title from proposals where share_token = ?",
      [token]
    );
    if (!proposal) return { error: "This link is not valid." };
    if (proposal.status === "accepted") return { notice: "This proposal was already accepted. Thank you!" };
    if (proposal.status === "rejected") return { error: "This proposal was already declined." };
    if (proposal.expires_at && new Date(proposal.expires_at) < new Date()) return { error: "This proposal link has expired." };
    const linkExpiry = get<{ share_expires_at: string | null }>(
      "select share_expires_at from proposals where id = ?",
      [proposal.id]
    )?.share_expires_at;
    if (linkExpiry && new Date(linkExpiry) < new Date()) {
      return { error: "This share link has expired. Ask the sender to issue a new link." };
    }

    const now = nowIso();
    // Conditional on the current status: two clicks (or a double-submitted form)
    // must not both "succeed" and overwrite the first signatory's name.
    const changed = run(
      `update proposals set status = 'accepted', accepted_at = ?, accepted_by_name = ?, updated_at = ?
        where id = ? and status in ('sent','draft','expired')`,
      [now, name, now, proposal.id]
    );
    if (changed.changes === 0) {
      return { notice: "This proposal has already been answered. Thank you!" };
    }
    logActivity({
      organizationId: proposal.organization_id, actorId: null, entityType: "proposal", entityId: proposal.id,
      action: "proposal.accepted", summary: `Client "${name}" accepted "${proposal.title}"`,
    });
    audit({ organizationId: proposal.organization_id, action: "proposal.accepted_public", targetType: "proposal", targetId: proposal.id, metadata: { name } });
    notify({
      organizationId: proposal.organization_id,
      type: "proposal.accepted",
      level: "success",
      title: `Proposal accepted: ${proposal.title}`,
      body: `${name} accepted the proposal.`,
      href: `/proposals/${proposal.id}`,
    });
    try {
      await dispatchTrigger(proposal.organization_id, "proposal.accepted", {
        type: "proposal", id: proposal.id, data: { id: proposal.id, accepted_by: name },
      });
    } catch { /* non-fatal */ }
  } catch (e) {
    return handle(e);
  }
  revalidatePath("/proposals");
  return { notice: "Thank you — your acceptance has been recorded." };
}

export async function declineProposalAction(_prev: ProposalState, form: FormData): Promise<ProposalState> {
  try {
    const token = String(form.get("token") ?? "");
    const reason = optionalStr(form.get("reason"), 500) || null;
    const proposal = get<{ id: string; organization_id: string; status: string; title: string }>(
      "select id, organization_id, status, title from proposals where share_token = ?",
      [token]
    );
    if (!proposal) return { error: "This link is not valid." };
    if (proposal.status === "accepted") return { error: "This proposal was already accepted — contact us if that was a mistake." };

    const now = nowIso();
    const changed = run(
      `update proposals set status = 'rejected', rejected_at = ?, rejected_reason = ?, updated_at = ?
        where id = ? and status in ('sent','draft','expired')`,
      [now, reason, now, proposal.id]
    );
    if (changed.changes === 0) return { error: "This proposal has already been answered." };
    logActivity({
      organizationId: proposal.organization_id, actorId: null, entityType: "proposal", entityId: proposal.id,
      action: "proposal.rejected", summary: `Proposal declined${reason ? `: ${reason}` : ""}`,
    });
    audit({ organizationId: proposal.organization_id, action: "proposal.rejected_public", targetType: "proposal", targetId: proposal.id, metadata: { reason } });
    notify({
      organizationId: proposal.organization_id,
      type: "proposal.declined",
      level: "warning",
      title: `Proposal declined: ${proposal.title}`,
      body: reason ? `Reason: ${reason}` : "No reason given.",
      href: `/proposals/${proposal.id}`,
    });
    try {
      await dispatchTrigger(proposal.organization_id, "proposal.rejected", {
        type: "proposal", id: proposal.id, data: { id: proposal.id, reason: reason ?? "" },
      });
    } catch { /* non-fatal */ }
  } catch (e) {
    return handle(e);
  }
  revalidatePath("/proposals");
  return { notice: "Your response has been recorded. Thank you for letting us know." };
}

/** Reads version history snapshots recorded on each edit. */
export async function proposalVersions(organizationId: string, proposalId: string) {
  return all<{ id: string; summary: string | null; created_at: string; metadata: string }>(
    `select id, summary, created_at, metadata from activities
      where organization_id = ? and entity_type = 'proposal' and entity_id = ? and action = 'proposal.version_created'
      order by created_at desc`,
    [organizationId, proposalId]
  ).map((r) => ({ ...r, meta: safeParse<{ version?: number; total_cents?: number }>(r.metadata, {}) }));
}
