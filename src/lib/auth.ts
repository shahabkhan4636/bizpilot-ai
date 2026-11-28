import { notFound, redirect } from "next/navigation";
import { get } from "./db";
import { currentUser as resolveCurrentUser, getUserBySessionToken, readSessionToken, type SessionUser } from "./session";
import { isSuperAdmin } from "./owner";
import { activeImpersonation, readImpersonationId } from "./impersonation";

export type Membership = {
  organization_id: string;
  role: "owner" | "admin" | "member";
  organization_name: string;
  organization_slug: string;
  currency: string;
  timezone: string;
  suspended_at: string | null;
};

export type AuthContext = {
  user: SessionUser;
  membership: Membership;
};

/**
 * The acting user for this request — impersonation-aware.
 *
 * Delegates to `session.currentUser()` so there is exactly one place that decides
 * whether the platform owner is currently wearing a customer's hat; an earlier
 * duplicate here read the raw session and silently ignored impersonation.
 */
export async function currentUser(): Promise<SessionUser | null> {
  return resolveCurrentUser();
}

export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) redirect("/login");
  return user;
}

/** Organisation the request is allowed to act on. Throws if none. */
export function membershipForUser(userId: string): Membership | null {
  const row = get<Membership>(
    `select m.organization_id, m.role, o.name as organization_name, o.slug as organization_slug,
            o.currency, o.timezone, o.suspended_at
       from organization_members m
       join organizations o on o.id = m.organization_id
      where m.user_id = ?
      order by m.created_at asc
      limit 1`,
    [userId]
  );
  return row ?? null;
}

/**
 * The single gate used by every authenticated page and server action.
 * Guarantees: user is signed in, belongs to an organisation, org is not suspended.
 */
export async function requireAuth(): Promise<AuthContext> {
  const user = await requireUser();
  const membership = membershipForUser(user.id);
  if (!membership) redirect("/onboarding");
  if (membership.suspended_at) {
    // A redirect to an explanatory page, not a 500: a suspended customer should be
    // told what happened and who to contact, and the reason is stored on the row.
    redirect("/suspended");
  }
  return { user, membership };
}

/**
 * The only gate for `/admin` and everything under it.
 *
 * A signed-in non-owner gets **404, not 403 and not a redirect**: a 403 (or a
 * redirect to a "forbidden" page) confirms that an admin area exists, which is
 * information a stranger has no reason to have. `notFound()` renders the normal
 * "page does not exist" response, so `/admin` is indistinguishable from a URL that
 * was never built.
 *
 * With `ADMIN_EMAIL` unset, `isSuperAdmin()` is false for everyone — an
 * unconfigured deployment has no admin panel at all rather than an unprotected one.
 */
export async function requireSuperAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (!isSuperAdmin(user)) notFound();
  // While impersonating, `user` is the customer, who is never a super-admin — so the
  // admin panel is unreachable mid-impersonation and an admin cannot accidentally
  // perform admin actions "as" a customer.
  return user;
}

/**
 * The platform owner behind the session, even while they are impersonating.
 *
 * `requireSuperAdmin()` deliberately fails during impersonation (the acting user is
 * the customer). The controls that *end* or re-scope an impersonation still have to
 * work, so they ask for the underlying admin explicitly — and the impersonation row
 * must belong to that admin, which is what `activeImpersonation` verifies.
 */
export async function requireSuperAdminSession(): Promise<{
  admin: SessionUser;
  impersonation: Awaited<ReturnType<typeof activeImpersonation>>;
}> {
  const admin = getUserBySessionToken(await readSessionToken());
  if (!admin || !isSuperAdmin(admin)) notFound();
  const impersonation = activeImpersonation({ sessionId: await readImpersonationId(), adminId: admin.id });
  return { admin, impersonation };
}

/** Non-throwing form for callers that want to branch (e.g. rendering a link). */
export function userIsSuperAdmin(user: SessionUser | null | undefined): boolean {
  return isSuperAdmin(user);
}

export function isAdmin(role: string): boolean {
  return role === "owner" || role === "admin";
}

