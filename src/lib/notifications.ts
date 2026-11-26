import { all, get, run } from "./db";
import { newId } from "./ids";
import { nowIso } from "./utils";

/**
 * Notifications.
 *
 * The `notifications` table has existed since the first migration but nothing
 * read it — a dead feature. This module is the only writer, so notification
 * kinds stay consistent and every entry is deep-linkable.
 *
 * Rules:
 *  • Never notify a user about their own action.
 *  • Never throw: a notification must not break the business operation that
 *    triggered it. Failures are logged, not swallowed silently.
 *  • org-scoped: a notification is only readable inside its workspace.
 */

export const NOTIFICATION_TYPES = [
  "lead.assigned",
  "lead.created",
  "proposal.accepted",
  "proposal.declined",
  "automation.failed",
  "approval.pending",
  "usage.warning",
  "invite.accepted",
  "billing.past_due",
  "system",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export type NotifyInput = {
  organizationId: string;
  /** Recipient. Omit to notify everyone in the workspace except `actorId`. */
  userId?: string | null;
  actorId?: string | null;
  type: NotificationType;
  title: string;
  body?: string | null;
  href?: string | null;
  level?: "info" | "success" | "warning" | "danger";
};

export function notify(input: NotifyInput): void {
  try {
    const recipients = input.userId
      ? [{ user_id: input.userId }]
      : all<{ user_id: string }>(
          "select user_id from organization_members where organization_id = ?",
          [input.organizationId]
        );

    const now = nowIso();
    for (const recipient of recipients) {
      if (input.actorId && recipient.user_id === input.actorId) continue;
      run(
        `insert into notifications (id, organization_id, user_id, title, body, level, type, href, created_at)
         values (?,?,?,?,?,?,?,?,?)`,
        [
          newId(),
          input.organizationId,
          recipient.user_id,
          input.title,
          input.body ?? null,
          input.level ?? "info",
          input.type,
          input.href ?? null,
          now,
        ]
      );
    }
  } catch (error) {
    // Never break the caller. But never hide it either.
    console.error("[notifications] failed to write notification", {
      type: input.type,
      organizationId: input.organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export type NotificationRow = {
  id: string;
  title: string;
  body: string | null;
  level: string;
  type: string;
  href: string | null;
  read_at: string | null;
  created_at: string;
};

export function listNotifications(organizationId: string, userId: string, limit = 50): NotificationRow[] {
  return all<NotificationRow>(
    `select id, title, body, level, type, href, read_at, created_at
       from notifications
      where organization_id = ? and user_id = ?
      order by created_at desc
      limit ?`,
    [organizationId, userId, limit]
  );
}

export function unreadCount(organizationId: string, userId: string): number {
  const row = get<{ c: number }>(
    "select count(*) as c from notifications where organization_id = ? and user_id = ? and read_at is null",
    [organizationId, userId]
  );
  return Number(row?.c ?? 0);
}

export function markRead(organizationId: string, userId: string, id: string): void {
  run(
    "update notifications set read_at = ? where id = ? and organization_id = ? and user_id = ? and read_at is null",
    [nowIso(), id, organizationId, userId]
  );
}

export function markAllRead(organizationId: string, userId: string): void {
  run(
    "update notifications set read_at = ? where organization_id = ? and user_id = ? and read_at is null",
    [nowIso(), organizationId, userId]
  );
}
