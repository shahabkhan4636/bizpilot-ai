import { redirect } from "next/navigation";
import { requireAuth, type AuthContext } from "./auth";
import { can, isWritePermission, type Permission } from "./permissions";
import { recordImpersonatedWrite } from "./impersonation";

export class ForbiddenError extends Error {
  readonly code = "forbidden";
  constructor(message = "You do not have permission to do that.") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/**
 * Authorisation gate for server actions and routes.
 * Throws `ForbiddenError` (a 403, never a silent no-op) when the role lacks the
 * capability. Call this — not `role === "owner"` — from every mutation.
 */
/**
 * Void server actions cannot return an error state, and throwing surfaces as a
 * 500. Send the request to a page that says exactly what happened instead.
 */
export function forbiddenRedirect(permission?: Permission): never {
  const q = permission ? `?permission=${encodeURIComponent(permission)}` : "";
  redirect(`/forbidden${q}`);
}

export async function requirePermission(permission: Permission, message?: string): Promise<AuthContext> {
  const ctx = await requireAuth();
  if (!can(ctx.membership.role, permission)) {
    throw new ForbiddenError(message ?? `Your role (${ctx.membership.role}) cannot ${permission.replace(":", " ")}.`);
  }

  // Impersonation gate. Enforced here rather than in the pages, so an action added
  // tomorrow is covered without being remembered — the same reason role checks live
  // in this function and not in the UI.
  const impersonation = ctx.user.impersonation;
  if (impersonation && isWritePermission(permission)) {
    if (impersonation.mode !== "write") {
      throw new ForbiddenError(
        "You are viewing this workspace read-only. Switch impersonation to write mode (with confirmation) to make changes."
      );
    }
    // Allowed, but recorded on every call: `impersonated_write: true` + who did it.
    recordImpersonatedWrite({
      sessionId: impersonation.sessionId,
      adminId: impersonation.adminId,
      organizationId: ctx.membership.organization_id,
      targetUserId: ctx.user.id,
      permission,
    });
  }

  return ctx;
}

