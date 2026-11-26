"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { run, get } from "@/lib/db";
import { newId } from "@/lib/ids";
import { nowIso } from "@/lib/utils";
import { requireAuth } from "@/lib/auth";
import { forbiddenRedirect, requirePermission } from "@/lib/authz";
import { audit, logActivity } from "@/lib/audit";
import { ValidationError, str, email as emailField, optionalStr } from "@/lib/validate";
import { dispatchTrigger } from "@/lib/automations";

export type CustomerState = { error?: string; notice?: string } | null;

function handle(e: unknown): CustomerState {
  if (e instanceof ValidationError) return { error: e.message };
  return { error: e instanceof Error ? e.message : "Unexpected error." };
}

export async function createCustomerAction(_prev: CustomerState, form: FormData): Promise<CustomerState> {
  try {
    await requirePermission("customer:write");
  } catch (e) {
    return handle(e);
  }
  let id = "";
  try {
    const { user, membership } = await requireAuth();
    const orgId = membership.organization_id;
    const name = str(form.get("name"), "Customer name", { min: 2, max: 120 });
    const emailRaw = form.get("email");
    const email = emailRaw && String(emailRaw).trim() ? emailField(emailRaw, "Email", false) : null;
    const phone = optionalStr(form.get("phone"), 40) || null;
    const company = optionalStr(form.get("company"), 120) || null;
    const address = optionalStr(form.get("address"), 300) || null;
    const notes = optionalStr(form.get("notes"), 4000) || null;

    const dup = email ? get<{ id: string }>("select id from customers where organization_id = ? and lower(email) = ?", [orgId, email.toLowerCase()]) : null;
    if (dup) throw new ValidationError("A customer with that email already exists in this workspace.");

    id = newId();
    const now = nowIso();
    run(
      `insert into customers (id, organization_id, name, email, phone, company, address, notes, created_at, updated_at)
       values (?,?,?,?,?,?,?,?,?,?)`,
      [id, orgId, name, email, phone, company, address, notes, now, now]
    );
    logActivity({ organizationId: orgId, actorId: user.id, entityType: "customer", entityId: id, action: "customer.created", summary: `Customer "${name}" created` });
    audit({ organizationId: orgId, actorId: user.id, action: "customer.create", targetType: "customer", targetId: id });
    try {
      await dispatchTrigger(orgId, "customer.created", { type: "customer", id, data: { id, name, email, company } }, { actorId: user.id });
    } catch { /* non-fatal */ }
  } catch (e) {
    return handle(e);
  }
  revalidatePath("/customers");
  redirect(`/customers/${id}`);
}

export async function updateCustomerAction(_prev: CustomerState, form: FormData): Promise<CustomerState> {
  try {
    try {
      await requirePermission("customer:write");
    } catch (e) {
      return handle(e);
    }
    const { user, membership } = await requireAuth();
    const orgId = membership.organization_id;
    const id = str(form.get("customer_id"), "Customer", { min: 4 });
    const existing = get("select id from customers where id = ? and organization_id = ? and deleted_at is null", [id, orgId]);
    if (!existing) return { error: "Customer not found in this workspace." };

    const name = str(form.get("name"), "Customer name", { min: 2, max: 120 });
    const emailRaw = form.get("email");
    const email = emailRaw && String(emailRaw).trim() ? emailField(emailRaw, "Email", false) : null;
    run(
      "update customers set name = ?, email = ?, phone = ?, company = ?, address = ?, notes = ?, updated_at = ? where id = ? and organization_id = ?",
      [name, email, optionalStr(form.get("phone"), 40) || null, optionalStr(form.get("company"), 120) || null,
       optionalStr(form.get("address"), 300) || null, optionalStr(form.get("notes"), 4000) || null, nowIso(), id, orgId]
    );
    audit({ organizationId: orgId, actorId: user.id, action: "customer.update", targetType: "customer", targetId: id });
  } catch (e) {
    return handle(e);
  }
  revalidatePath("/customers");
  return { notice: "Customer saved." };
}

export async function deleteCustomerAction(form: FormData): Promise<void> {
  try {
    await requirePermission("customer:delete");
  } catch {
    forbiddenRedirect("customer:delete");
  }
  const { user, membership } = await requireAuth();
  const orgId = membership.organization_id;
  const id = String(form.get("customer_id") ?? "");
  run("update customers set deleted_at = ?, updated_at = ? where id = ? and organization_id = ?", [nowIso(), nowIso(), id, orgId]);
  audit({ organizationId: orgId, actorId: user.id, action: "customer.delete", targetType: "customer", targetId: id });
  revalidatePath("/customers");
  redirect("/customers");
}

/** Converts a lead into a customer record and links the two. */
export async function convertLeadToCustomerAction(form: FormData): Promise<void> {
  try {
    await requirePermission("customer:write");
  } catch {
    forbiddenRedirect("customer:write");
  }
  const { user, membership } = await requireAuth();
  const orgId = membership.organization_id;
  const leadId = String(form.get("lead_id") ?? "");
  const lead = get<{ id: string; name: string; email: string | null; phone: string | null; company: string | null; notes: string | null; value_cents: number }>(
    "select id, name, email, phone, company, notes, value_cents from leads where id = ? and organization_id = ? and deleted_at is null",
    [leadId, orgId]
  );
  if (!lead) redirect("/leads");

  const customerId = newId();
  const now = nowIso();
  run(
    `insert into customers (id, organization_id, name, email, phone, company, notes, lifetime_value_cents, created_at, updated_at)
     values (?,?,?,?,?,?,?,?,?,?)`,
    [customerId, orgId, lead.name, lead.email, lead.phone, lead.company, lead.notes, 0, now, now]
  );
  run("update leads set customer_id = ?, status = 'won', updated_at = ? where id = ? and organization_id = ?", [customerId, now, leadId, orgId]);
  logActivity({ organizationId: orgId, actorId: user.id, entityType: "customer", entityId: customerId, action: "customer.created_from_lead", summary: `Converted lead "${lead.name}" to a customer` });
  audit({ organizationId: orgId, actorId: user.id, action: "customer.convert_lead", targetType: "customer", targetId: customerId, metadata: { leadId } });
  revalidatePath("/customers");
  redirect(`/customers/${customerId}`);
}
