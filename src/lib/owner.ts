/**
 * Who is the platform owner (super-admin)?
 *
 * One rule, one place: the account whose email equals `ADMIN_EMAIL` is the
 * platform owner. Nothing is hardcoded — no address, no name — and when
 * `ADMIN_EMAIL` is empty **nobody** is a super-admin, which is the safe default for
 * a self-hosted or a copy of the database.
 *
 * Why the environment is the source of truth rather than the
 * `profiles.is_super_admin` column: that column is a snapshot written at sign-up
 * time. If you change `ADMIN_EMAIL` later (or restore someone else's database), a
 * stale flag would keep an old account in the admin panel forever. The column is
 * still kept in sync and still exported on the session, but every gate below reads
 * the email, so revoking access is a one-variable change.
 */

export type SuperAdminCandidate = {
  email: string;
  is_super_admin?: number | boolean | null;
};

/** The configured owner address, normalised, or null when unset. */
export function superAdminEmail(): string | null {
  const raw = (process.env.ADMIN_EMAIL ?? "").trim().toLowerCase();
  return raw.length > 0 ? raw : null;
}

/**
 * True only for the configured owner address.
 *
 * No `ADMIN_EMAIL` → false for everybody (admin routes 404 rather than 500), and a
 * database flag on some other address cannot promote anyone.
 */
export function isSuperAdminEmail(email: string | null | undefined): boolean {
  const configured = superAdminEmail();
  if (!configured) return false;
  if (!email) return false;
  return email.trim().toLowerCase() === configured;
}

export function isSuperAdmin(user: SuperAdminCandidate | null | undefined): boolean {
  if (!user) return false;
  return isSuperAdminEmail(user.email);
}

/**
 * The value stored on the session/profile row.
 *
 * Derived from the email so the sidebar, the admin link and any other
 * presentation code cannot disagree with the actual gate.
 */
export function superAdminFlag(email: string | null | undefined): 0 | 1 {
  return isSuperAdminEmail(email) ? 1 : 0;
}
