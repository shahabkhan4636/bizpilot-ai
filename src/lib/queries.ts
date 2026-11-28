import { all } from "./db";
import { safeParse } from "./plans";
import type { TriggerType } from "./automation-meta";

/**
 * Read-only queries shared by pages.
 *
 * These used to live in the `"use server"` action modules, which was a quiet
 * security problem rather than a style one: **every export of a `"use server"`
 * file is a callable server-action endpoint**, and these helpers take the tenant id
 * as an *argument*. Nothing checked that the caller belonged to that tenant, so the
 * contract "a customer can never read another customer's records" rested on an
 * attacker not knowing a workspace id (they do know their own) and not being able to
 * reach the endpoint.
 *
 * They are plain functions in a normal module now: the page has already established
 * the tenant with `loadAppContext()`/`requireAuth()` before calling them, and there
 * is no endpoint left to call. Anything that mutates or authorises stays in
 * `src/lib/actions/*`.
 */

export async function listMembers(organizationId: string) {
  return all<{ user_id: string; email: string; full_name: string | null; role: string }>(
    `select m.user_id, p.email, p.full_name, m.role
       from organization_members m join profiles p on p.id = m.user_id
      where m.organization_id = ? order by p.full_name asc`,
    [organizationId]
  );
}

export async function recentDrafts(organizationId: string, limit = 12) {
  return all<{ id: string; subject: string | null; body: string; status: string; created_at: string; sent_at: string | null }>(
    `select id, subject, body, status, created_at, sent_at from messages
      where organization_id = ? order by created_at desc limit ?`,
    [organizationId, limit]
  );
}

export async function proposalVersions(organizationId: string, proposalId: string) {
  return all<{ id: string; summary: string | null; created_at: string; metadata: string }>(
    `select id, summary, created_at, metadata from activities
      where organization_id = ? and entity_type = 'proposal' and entity_id = ? and action = 'proposal.version_created'
      order by created_at desc`,
    [organizationId, proposalId]
  ).map((r) => ({ ...r, meta: safeParse<{ version?: number; total_cents?: number }>(r.metadata, {}) }));
}

export async function listAutomationsWithStats(organizationId: string) {
  return all<{
    id: string; name: string; description: string | null; trigger_type: TriggerType; is_active: number;
    run_limit_per_day: number; last_run_at: string | null; created_at: string;
    steps: number; runs: number; failures: number;
  }>(
    `select a.id, a.name, a.description, a.trigger_type, a.is_active, a.run_limit_per_day, a.last_run_at, a.created_at,
            (select count(*) from automation_steps s where s.automation_id = a.id) as steps,
            (select count(*) from automation_executions e where e.automation_id = a.id) as runs,
            (select count(*) from automation_executions e where e.automation_id = a.id and e.status = 'failed') as failures
       from automations a where a.organization_id = ? order by a.created_at desc`,
    [organizationId]
  );
}

export async function listLocalPaymentData(orgId: string) {
  return {
    methods: all<{ id: string; kind: string; label: string | null; account_title: string; account_number: string; payment_link: string | null; instructions: string | null; is_active: number }>(
      "select id, kind, label, account_title, account_number, payment_link, instructions, is_active from local_payment_methods where organization_id = ? order by created_at",
      [orgId]
    ),
    requests: all<{ id: string; plan_code: string; billing_cycle: string; amount_cents: number; currency: string; reference: string | null; payer_note: string | null; status: string; submitted_at: string; reviewed_at: string | null; review_note: string | null; gateway_provider: string | null; gateway_payment_id: string | null; paid_at: string | null }>(
      `select id, plan_code, billing_cycle, amount_cents, currency, reference, payer_note, status,
              submitted_at, reviewed_at, review_note, gateway_provider, gateway_payment_id, paid_at
         from local_payment_requests where organization_id = ? order by submitted_at desc limit 25`,
      [orgId]
    ),
    refunds: all<{ id: string; request_id: string; amount_cents: number; reason: string | null; created_at: string }>(
      "select id, request_id, amount_cents, reason, created_at from payment_refunds where organization_id = ? order by created_at desc limit 25",
      [orgId]
    ),
  };
}
