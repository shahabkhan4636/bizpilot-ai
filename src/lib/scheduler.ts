import { all, get, run } from "@/lib/db";
import { nowIso } from "@/lib/utils";
import { dispatchTrigger, type ExecutionResult } from "@/lib/automations";

/**
 * The clock side of the automation engine.
 *
 * Event triggers fire from the code path that changed the record. Two things
 * cannot work that way — "run this every N minutes" and "the follow-up date has
 * passed" — because nothing happens at the moment they become true. Both are
 * handled here and driven by `GET/POST /api/cron/automations`, which is
 * authenticated with `CRON_SECRET` and therefore safe to point a scheduler at
 * (Vercel Cron sends the same bearer token).
 *
 * Guarantees:
 *  - due automations are advanced with a conditional update, so two overlapping
 *    cron runs cannot both dispatch the same automation for the same window;
 *  - overdue lead follow-ups are de-duplicated per lead per due date, so a lead
 *    that stays overdue does not fire an automation every single run;
 *  - one failing automation never stops the rest of the run.
 */

export type ScheduleRunSummary = {
  ranAt: string;
  scheduled: { automationId: string; automationName: string; status: string; reason?: string }[];
  overdueFollowups: { leadId: string; automations: number; status: string }[];
  dryRun: boolean;
};

type ScheduledAutomation = {
  id: string;
  organization_id: string;
  name: string;
  schedule_interval_minutes: number;
  next_run_at: string | null;
};

const MIN_INTERVAL_MINUTES = 5;

/** Advance `next_run_at` only if nobody else already did — a real compare-and-set. */
function claimAutomation(automation: ScheduledAutomation, now: Date): boolean {
  const next = new Date(now.getTime() + Math.max(MIN_INTERVAL_MINUTES, automation.schedule_interval_minutes) * 60_000);
  const current = automation.next_run_at;
  // `? is null` or `= ?` keeps the update from firing twice for the same window.
  const result = run(
    current === null
      ? "update automations set next_run_at = ?, last_run_at = ?, updated_at = ? where id = ? and next_run_at is null"
      : "update automations set next_run_at = ?, last_run_at = ?, updated_at = ? where id = ? and next_run_at = ?",
    current === null ? [next.toISOString(), nowIso(), nowIso(), automation.id] : [next.toISOString(), nowIso(), nowIso(), automation.id, current]
  );
  return result.changes > 0;
}

function summarize(results: ExecutionResult[]) {
  return results.map((r) => ({ automationId: r.automationId, automationName: r.automationName, status: r.status, reason: r.reason }));
}

/** Fires every `schedule.tick` automation whose `next_run_at` has passed. */
export async function runDueScheduledAutomations(now = new Date(), options: { dryRun?: boolean } = {}) {
  const due = all<ScheduledAutomation>(
    `select id, organization_id, name, schedule_interval_minutes, next_run_at
       from automations
      where trigger_type = 'schedule.tick' and is_active = 1
        and schedule_interval_minutes is not null
        and (next_run_at is null or next_run_at <= ?)
      order by next_run_at asc
      limit 50`,
    [now.toISOString()]
  );

  const ran: ScheduleRunSummary["scheduled"] = [];
  for (const automation of due) {
    if (!options.dryRun && !claimAutomation(automation, now)) {
      ran.push({ automationId: automation.id, automationName: automation.name, status: "skipped", reason: "claimed by another run" });
      continue;
    }
    const results = await dispatchTrigger(
      automation.organization_id,
      "schedule.tick",
      {
        type: "schedule",
        id: automation.id,
        // One execution per scheduled window: the bucket changes when the
        // automation runs again, which is what allows the next run at all.
        dedupeSuffix: now.toISOString().slice(0, 16),
        data: { automation_name: automation.name },
      },
      { dryRun: options.dryRun, automationId: automation.id }
    );
    ran.push(...summarize(results));
  }
  return ran;
}

/**
 * Fires `followup.overdue` for leads whose follow-up date has passed.
 *
 * The entity id is the lead and the dedupe suffix is the due date, so an
 * automation runs once per lead when its follow-up becomes overdue — not on every
 * scheduler tick for as long as the lead stays open.
 */
export async function runOverdueFollowups(now = new Date(), options: { dryRun?: boolean } = {}) {
  const candidateTriggers = all<{ organization_id: string }>(
    "select distinct organization_id from automations where trigger_type = 'followup.overdue' and is_active = 1"
  );
  if (candidateTriggers.length === 0) return [];

  const leads = all<{
    id: string;
    organization_id: string;
    name: string;
    email: string | null;
    company: string | null;
    status: string;
    next_follow_up_at: string;
    value_cents: number;
  }>(
    `select id, organization_id, name, email, company, status, next_follow_up_at, value_cents
       from leads
      where deleted_at is null
        and next_follow_up_at is not null and next_follow_up_at <= ?
        and status not in ('won', 'lost')
      order by next_follow_up_at asc
      limit 200`,
    [now.toISOString()]
  );

  const run: ScheduleRunSummary["overdueFollowups"] = [];
  for (const lead of leads) {
    const results = await dispatchTrigger(
      lead.organization_id,
      "followup.overdue",
      {
        type: "lead",
        id: lead.id,
        dedupeSuffix: lead.next_follow_up_at.slice(0, 10),
        data: {
          name: lead.name,
          email: lead.email,
          company: lead.company,
          status: lead.status,
          value_cents: lead.value_cents,
          next_follow_up_at: lead.next_follow_up_at,
        },
      },
      { dryRun: options.dryRun }
    );
    if (results.length === 0) continue;
    run.push({
      leadId: lead.id,
      automations: results.length,
      status: results.some((r) => r.status === "failed") ? "failed" : results.some((r) => r.status === "succeeded") ? "succeeded" : "skipped",
    });
  }
  return run;
}

/** Everything the cron endpoint does, in one call. */
export async function runScheduler(options: { dryRun?: boolean; now?: Date } = {}): Promise<ScheduleRunSummary> {
  const now = options.now ?? new Date();
  const scheduled = await runDueScheduledAutomations(now, options);
  const overdueFollowups = await runOverdueFollowups(now, options);
  return { ranAt: now.toISOString(), scheduled, overdueFollowups, dryRun: Boolean(options.dryRun) };
}

/** Next few scheduled runs, for the automations page. */
export function upcomingScheduledRuns(organizationId: string, limit = 5) {
  return all<{ id: string; name: string; next_run_at: string | null; schedule_interval_minutes: number; is_active: number }>(
    `select id, name, next_run_at, schedule_interval_minutes, is_active
       from automations
      where organization_id = ? and trigger_type = 'schedule.tick'
      order by next_run_at asc
      limit ?`,
    [organizationId, limit]
  );
}

/** How many overdue follow-ups exist right now — used for the page's empty state. */
export function overdueFollowupCount(organizationId: string, now = new Date()): number {
  return Number(
    get<{ c: number }>(
      `select count(*) as c from leads
        where organization_id = ? and deleted_at is null and next_follow_up_at is not null
          and next_follow_up_at <= ? and status not in ('won', 'lost')`,
      [organizationId, now.toISOString()]
    )?.c ?? 0
  );
}
