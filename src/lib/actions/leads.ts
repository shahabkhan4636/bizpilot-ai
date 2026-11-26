"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { run, get, all } from "@/lib/db";
import { newId } from "@/lib/ids";
import { nowIso } from "@/lib/utils";
import { requireAuth } from "@/lib/auth";
import { forbiddenRedirect, requirePermission } from "@/lib/authz";
import { audit, logActivity } from "@/lib/audit";
import { checkLeadLimit, recordUsage } from "@/lib/plans";
import { ValidationError, str, email as emailField, oneOf, optionalStr, money } from "@/lib/validate";
import { LEAD_STATUSES, type LeadStatus, mapImportRows, parseCsv } from "@/lib/csv";
import { scoreLead } from "@/lib/ai";
import { dispatchTrigger } from "@/lib/automations";
import { notify } from "@/lib/notifications";

export type LeadState = { error?: string; notice?: string; ok?: boolean; fieldErrors?: Record<string, string> } | null;

function handle(e: unknown): LeadState {
  if (e instanceof ValidationError) return { error: e.message };
  return { error: e instanceof Error ? e.message : "Unexpected error." };
}

function parseLeadForm(form: FormData, partial: boolean) {
  const out: Record<string, unknown> = {};
  const pick = <T>(key: string, fn: () => T) => {
    const raw = form.get(key);
    if (partial && (raw === null || raw === "")) return;
    out[key] = fn();
  };
  pick("name", () => str(form.get("name"), "Lead name", { min: 2, max: 120 }));
  pick("email", () => {
    const v = form.get("email");
    if (!v || String(v).trim() === "") return null;
    return emailField(v, "Email", false) || null;
  });
  pick("phone", () => optionalStr(form.get("phone"), 40) || null);
  pick("company", () => optionalStr(form.get("company"), 120) || null);
  pick("source", () => optionalStr(form.get("source"), 60) || "manual");
  pick("status", () => oneOf(form.get("status"), "Status", LEAD_STATUSES, "new"));
  pick("value_cents", () => money(form.get("value"), "Value"));
  pick("notes", () => optionalStr(form.get("notes"), 4000) || null);
  pick("next_follow_up_at", () => {
    const v = String(form.get("next_follow_up_at") ?? "").trim();
    if (!v) return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw new ValidationError("Follow-up date is not a valid date.");
    return d.toISOString();
  });
  pick("assigned_to", () => optionalStr(form.get("assigned_to"), 60) || null);
  return out as Record<string, unknown>;
}

export async function createLeadAction(_prev: LeadState, form: FormData): Promise<LeadState> {
  try {
    await requirePermission("lead:write");
  } catch (e) {
    return handle(e);
  }
  let newLeadId = "";
  try {
    const { user, membership } = await requireAuth();
    const orgId = membership.organization_id;

    const limit = checkLeadLimit(orgId);
    if (!limit.allowed) return { error: limit.reason ?? "Lead limit reached." };

    const data = parseLeadForm(form, false);
    const id = newId();
    newLeadId = id;
    const now = nowIso();
    run(
      `insert into leads (id, organization_id, name, email, phone, company, source, status, value_cents, notes,
                          assigned_to, next_follow_up_at, created_at, updated_at)
       values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id, orgId, data.name, data.email ?? null, data.phone ?? null, data.company ?? null,
        data.source ?? "manual", data.status ?? "new", data.value_cents ?? 0, data.notes ?? null,
        (data.assigned_to as string) ?? user.id, (data.next_follow_up_at as string) ?? null, now, now,
      ]
    );
    recordUsage(orgId, "lead");
    if (data.assigned_to && data.assigned_to !== user.id) {
      notify({
        organizationId: orgId,
        userId: data.assigned_to as string,
        actorId: user.id,
        type: "lead.assigned",
        title: `New lead assigned to you: ${data.name}`,
        body: "Created from the dashboard.",
        href: `/leads/${id}`,
      });
    }
    logActivity({
      organizationId: orgId, actorId: user.id, entityType: "lead", entityId: id,
      action: "lead.created", summary: `Lead "${data.name}" created`,
    });
    audit({ organizationId: orgId, actorId: user.id, action: "lead.create", targetType: "lead", targetId: id });

    // Fire the automation trigger. A failing automation must never lose the lead.
    try {
      await dispatchTrigger(orgId, "lead.created", { type: "lead", id, data: { ...data, id } }, { actorId: user.id });
    } catch { /* failures are recorded inside the automation engine */ }
  } catch (e) {
    return handle(e);
  }
  revalidatePath("/leads");
  revalidatePath("/dashboard");
  redirect(`/leads/${newLeadId}`);
}

export async function updateLeadAction(_prev: LeadState, form: FormData): Promise<LeadState> {
  try {
    try {
      await requirePermission("lead:write");
    } catch (e) {
      return handle(e);
    }
    const { user, membership } = await requireAuth();
    const orgId = membership.organization_id;
    const leadId = str(form.get("lead_id"), "Lead", { min: 4 });
    const existing = get<{ id: string; status: string }>(
      "select id, status from leads where id = ? and organization_id = ? and deleted_at is null",
      [leadId, orgId]
    );
    if (!existing) return { error: "Lead not found in this workspace." };

    const data = parseLeadForm(form, true);
    const fields = Object.keys(data);
    if (fields.length === 0) return { notice: "Nothing to update." };

    run(
      `update leads set ${fields.map((f) => `${f} = ?`).join(", ")}, updated_at = ? where id = ? and organization_id = ?`,
      [...fields.map((f) => data[f]), nowIso(), leadId, orgId]
    );

    const changedStatus = typeof data.status === "string" && data.status !== existing.status;
    logActivity({
      organizationId: orgId, actorId: user.id, entityType: "lead", entityId: leadId,
      action: changedStatus ? "lead.status_changed" : "lead.updated",
      summary: changedStatus ? `Status changed to ${data.status}` : "Lead details updated",
      metadata: data,
    });
    audit({ organizationId: orgId, actorId: user.id, action: "lead.update", targetType: "lead", targetId: leadId, metadata: { fields } });

    if (changedStatus) {
      try {
        await dispatchTrigger(
          orgId,
          "lead.status_changed",
          { type: "lead", id: leadId, data: { ...data, id: leadId }, dedupeSuffix: String(data.status) },
          { actorId: user.id }
        );
      } catch { /* non-fatal, already logged */ }
    }
  } catch (e) {
    return handle(e);
  }
  revalidatePath("/leads");
  revalidatePath("/dashboard");
  return { notice: "Lead saved." };
}

export async function deleteLeadAction(form: FormData): Promise<void> {
  try {
    await requirePermission("lead:delete");
  } catch {
    forbiddenRedirect("lead:delete");
  }
  const { user, membership } = await requireAuth();
  const orgId = membership.organization_id;
  const leadId = String(form.get("lead_id") ?? "");
  run("update leads set deleted_at = ?, updated_at = ? where id = ? and organization_id = ?", [nowIso(), nowIso(), leadId, orgId]);
  audit({ organizationId: orgId, actorId: user.id, action: "lead.delete", targetType: "lead", targetId: leadId });
  revalidatePath("/leads");
  redirect("/leads");
}

export async function addNoteAction(_prev: LeadState, form: FormData): Promise<LeadState> {
  try {
    try {
      await requirePermission("lead:write");
    } catch (e) {
      return handle(e);
    }
    const { user, membership } = await requireAuth();
    const orgId = membership.organization_id;
    const leadId = str(form.get("lead_id"), "Lead", { min: 4 });
    const body = str(form.get("body"), "Note", { min: 1, max: 4000 });
    const lead = get("select id from leads where id = ? and organization_id = ?", [leadId, orgId]);
    if (!lead) return { error: "Lead not found in this workspace." };

    run("insert into lead_notes (id, organization_id, lead_id, author_id, body, created_at) values (?,?,?,?,?,?)", [
      newId(), orgId, leadId, user.id, body, nowIso(),
    ]);
    logActivity({ organizationId: orgId, actorId: user.id, entityType: "lead", entityId: leadId, action: "lead.note_added", summary: "Note added" });
  } catch (e) {
    return handle(e);
  }
  revalidatePath("/leads");
  return { notice: "Note added." };
}

/** Scores a single lead with the provider if configured, else rule-based. */
export async function scoreLeadAction(_prev: LeadState, form: FormData): Promise<LeadState> {
  try {
    try {
      await requirePermission("ai:generate");
    } catch (e) {
      return handle(e);
    }
    const { user, membership } = await requireAuth();
    const orgId = membership.organization_id;
    const leadId = str(form.get("lead_id"), "Lead", { min: 4 });
    const lead = get<{
      id: string; name: string; email: string | null; phone: string | null; company: string | null;
      source: string; status: string; value_cents: number; notes: string | null;
    }>("select id, name, email, phone, company, source, status, value_cents, notes from leads where id = ? and organization_id = ? and deleted_at is null", [leadId, orgId]);
    if (!lead) return { error: "Lead not found in this workspace." };

    const result = await scoreLead(lead);
    run(
      "update leads set ai_score = ?, ai_score_reason = ?, ai_next_action = ?, ai_scored_at = ?, updated_at = ? where id = ? and organization_id = ?",
      [result.score, `${result.reason}\n\nApproach: ${result.approach}`, result.nextAction, nowIso(), nowIso(), leadId, orgId]
    );
    if (result.method === "ai") recordUsage(orgId, "ai_generation");
    logActivity({
      organizationId: orgId, actorId: user.id, entityType: "lead", entityId: leadId,
      action: "lead.scored", summary: `Scored ${result.score}/100 (${result.method === "ai" ? "AI" : "rule-based"})`,
    });
    revalidatePath(`/leads/${leadId}`);
    return { notice: `Score updated to ${result.score}/100 (${result.method === "ai" ? "AI model" : "rule-based fallback"}).` };
  } catch (e) {
    return handle(e);
  }
}

export async function assignLeadAction(_prev: LeadState, form: FormData): Promise<LeadState> {
  try {
    try {
      await requirePermission("lead:write");
    } catch (e) {
      return handle(e);
    }
    const { user, membership } = await requireAuth();
    const orgId = membership.organization_id;
    const leadId = str(form.get("lead_id"), "Lead", { min: 4 });
    const assignee = optionalStr(form.get("assigned_to"), 60) || null;
    if (assignee) {
      const member = get("select id from organization_members where organization_id = ? and user_id = ?", [orgId, assignee]);
      if (!member) return { error: "That user is not a member of this workspace." };
    }
    run("update leads set assigned_to = ?, updated_at = ? where id = ? and organization_id = ?", [assignee, nowIso(), leadId, orgId]);
    if (assignee) {
      const lead = get<{ name: string }>("select name from leads where id = ? and organization_id = ?", [leadId, orgId]);
      notify({
        organizationId: orgId,
        userId: assignee,
        actorId: user.id,
        type: "lead.assigned",
        title: `Lead assigned: ${lead?.name ?? "a lead"}`,
        body: "You are now the owner of this lead.",
        href: `/leads/${leadId}`,
      });
    }
    audit({ organizationId: orgId, actorId: user.id, action: "lead.assign", targetType: "lead", targetId: leadId });
    revalidatePath("/leads");
    return { notice: assignee ? "Lead reassigned." : "Lead unassigned." };
  } catch (e) {
    return handle(e);
  }
}

/** Bulk CSV import. Validates every row; reports exactly what was created and skipped. */
export async function importLeadsAction(_prev: LeadState, form: FormData): Promise<LeadState> {
  try {
    try {
      await requirePermission("lead:write");
    } catch (e) {
      return handle(e);
    }
    const { user, membership } = await requireAuth();
    const orgId = membership.organization_id;
    const csvText = String(form.get("csv") ?? "");
    if (!csvText.trim()) throw new ValidationError("Paste CSV content or choose a file first.");

    const parsed = mapImportRows(parseCsv(csvText));
    if (parsed.rows.length === 0) throw new ValidationError("No usable rows found. Each row needs at least a name or an email.");

    const limit = checkLeadLimit(orgId);
    const room = (limit.limit ?? 0) - (limit.used ?? 0);
    if (room <= 0) return { error: limit.reason ?? "Lead limit reached." };

    const rows = parsed.rows.slice(0, room);
    const now = nowIso();
    let created = 0;
    const errors: string[] = [];

    for (const [i, r] of rows.entries()) {
      try {
        const status: LeadStatus = (LEAD_STATUSES as readonly string[]).includes(r.status) ? (r.status as LeadStatus) : "new";
        const cents = Math.max(0, Math.round(Number(String(r.value).replace(/[^0-9.\-]/g, "") || 0) * 100));
        if (r.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(r.email)) {
          errors.push(`Row ${i + 1}: invalid email "${r.email}" — imported without email.`);
        }
        run(
          `insert into leads (id, organization_id, name, email, phone, company, source, status, value_cents, notes, assigned_to, created_at, updated_at)
           values (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            newId(), orgId, r.name || r.email, r.email || null, r.phone || null, r.company || null,
            r.source || "import", status, Number.isFinite(cents) ? cents : 0, r.notes || null, user.id, now, now,
          ]
        );
        created++;
      } catch (rowError) {
        errors.push(`Row ${i + 1}: ${rowError instanceof Error ? rowError.message : "could not import"}`);
      }
    }

    for (let i = 0; i < created; i++) recordUsage(orgId, "lead");
    logActivity({ organizationId: orgId, actorId: user.id, entityType: "lead", action: "lead.imported", summary: `Imported ${created} leads from CSV` });
    audit({ organizationId: orgId, actorId: user.id, action: "lead.import", metadata: { created, skipped: parsed.skipped + (rows.length < parsed.rows.length ? parsed.rows.length - rows.length : 0) } });

    const truncated = parsed.rows.length - rows.length;
    return {
      ok: true,
      notice:
        `Imported ${created} lead${created === 1 ? "" : "s"}.` +
        (parsed.skipped ? ` ${parsed.skipped} row(s) skipped (no name or email).` : "") +
        (truncated > 0 ? ` ${truncated} row(s) not imported — plan limit of ${limit.limit ?? 0} leads reached.` : "") +
        (errors.length ? ` Notes: ${errors.slice(0, 3).join(" ")}` : ""),
    };
  } catch (e) {
    return handle(e);
  }
}

/** Members of the org, for assignment dropdowns. */
export async function listMembers(organizationId: string) {
  return all<{ user_id: string; email: string; full_name: string | null; role: string }>(
    `select m.user_id, p.email, p.full_name, m.role
       from organization_members m join profiles p on p.id = m.user_id
      where m.organization_id = ? order by p.full_name asc`,
    [organizationId]
  );
}
