import { run } from "./db";
import { newId } from "./ids";
import { nowIso } from "./utils";

export type AuditInput = {
  organizationId?: string | null;
  actorId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
};

/** Append-only audit trail. Never store secrets or full request bodies here. */
export function audit(input: AuditInput): void {
  try {
    run(
      `insert into audit_logs (id, organization_id, actor_id, action, target_type, target_id, ip, user_agent, metadata, created_at)
       values (?,?,?,?,?,?,?,?,?,?)`,
      [
        newId(),
        input.organizationId ?? null,
        input.actorId ?? null,
        input.action,
        input.targetType ?? null,
        input.targetId ?? null,
        input.ip ?? null,
        input.userAgent ?? null,
        JSON.stringify(input.metadata ?? {}),
        nowIso(),
      ]
    );
  } catch {
    // Auditing must never break the primary operation.
  }
}

export function logActivity(input: {
  organizationId: string;
  actorId?: string | null;
  entityType: string;
  entityId?: string | null;
  action: string;
  summary?: string;
  metadata?: Record<string, unknown>;
}): void {
  try {
    run(
      `insert into activities (id, organization_id, actor_id, entity_type, entity_id, action, summary, metadata, created_at)
       values (?,?,?,?,?,?,?,?,?)`,
      [
        newId(),
        input.organizationId,
        input.actorId ?? null,
        input.entityType,
        input.entityId ?? null,
        input.action,
        input.summary ?? null,
        JSON.stringify(input.metadata ?? {}),
        nowIso(),
      ]
    );
  } catch {
    /* non-fatal */
  }
}
