import { redirect } from "next/navigation";
import { get } from "./db";
import { getUserBySessionToken, readSessionToken, type SessionUser } from "./session";

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

export async function currentUser(): Promise<SessionUser | null> {
  const token = await readSessionToken();
  return getUserBySessionToken(token);
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
    throw new Error("This workspace has been suspended. Please contact support.");
  }
  return { user, membership };
}

export async function requireSuperAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (!user.is_super_admin) redirect("/dashboard?error=forbidden");
  return user;
}

export function isAdmin(role: string): boolean {
  return role === "owner" || role === "admin";
}

