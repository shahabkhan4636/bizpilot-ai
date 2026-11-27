"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createHash } from "node:crypto";
import { run, get } from "@/lib/db";
import { newId, newToken } from "@/lib/ids";
import { addDays, nowIso, slugify } from "@/lib/utils";
import { hashPassword, verifyPassword, passwordProblems } from "@/lib/password";
import { createSession, setSessionCookie, clearSessionCookie } from "@/lib/session";
import { audit } from "@/lib/audit";
import { rateLimit, LOGIN_LIMIT, LOGIN_WINDOW_SECONDS, SIGNUP_LIMIT, SIGNUP_WINDOW_SECONDS } from "@/lib/ratelimit";
import { sendEmail, isEmailConfigured } from "@/lib/email";
import { ValidationError, str, email as emailField } from "@/lib/validate";
import { DEFAULT_PLAN_CODE } from "@/lib/plans";

export type ActionState = { error?: string; notice?: string; fieldErrors?: Record<string, string> } | null;

async function clientKey(prefix: string): Promise<string> {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  return `${prefix}:${ip}`;
}

function sha256(v: string) {
  return createHash("sha256").update(v).digest("hex");
}

function fail(e: unknown): ActionState {
  if (e instanceof ValidationError) return { error: e.message };
  if (e instanceof Error && e.message === "NEXT_REDIRECT") throw e;
  return { error: e instanceof Error ? e.message : "Something went wrong. Please try again." };
}

/* ------------------------------------------------------------------ signup */

export async function signupAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  let createdUserId: string | null = null;
  try {
    const limit = rateLimit(await clientKey("signup"), SIGNUP_LIMIT, SIGNUP_WINDOW_SECONDS);
    if (!limit.allowed) return { error: `Too many sign-up attempts. Try again in ${Math.ceil(limit.resetInSeconds / 60)} minutes.` };

    const fullName = str(form.get("fullName"), "Full name", { min: 2, max: 120 });
    const emailRaw = emailField(form.get("email"));
    const password = String(form.get("password") ?? "");
    const companyName = str(form.get("companyName"), "Company name", { min: 2, max: 120 });
    const country = (form.get("country") as string) || "US";

    const problems = passwordProblems(password);
    if (problems.length) throw new ValidationError(problems.join(" "));

    const email = emailRaw.toLowerCase();
    const existing = get<{ id: string }>("select id from profiles where lower(email) = ?", [email]);
    if (existing) throw new ValidationError("An account with this email already exists. Try logging in instead.");

    const now = nowIso();
    const userId = newId();
    const orgId = newId();
    const hash = await hashPassword(password);

    let slug = slugify(companyName) || "workspace";
    if (get("select id from organizations where slug = ?", [slug])) slug = `${slug}-${newToken(3).toLowerCase()}`;

    // Bootstrap super-admin: only the exact address in ADMIN_EMAIL.
    const adminEmail = (process.env.ADMIN_EMAIL ?? "").trim().toLowerCase();
    const isSuperAdmin = adminEmail.length > 0 && email === adminEmail ? 1 : 0;

    run(
      "insert into profiles (id, email, password_hash, full_name, is_super_admin, created_at, updated_at) values (?,?,?,?,?,?,?)",
      [userId, email, hash, fullName, isSuperAdmin, now, now]
    );
    createdUserId = userId;

    run(
      "insert into organizations (id, name, slug, country, created_at, updated_at) values (?,?,?,?,?,?)",
      [orgId, companyName, slug, country, now, now]
    );
    run(
      "insert into organization_members (id, organization_id, user_id, role, created_at) values (?,?,?,?,?)",
      [newId(), orgId, userId, "owner", now]
    );
    run(
      `insert into subscriptions (id, organization_id, plan_code, status, billing_cycle, trial_ends_at, created_at, updated_at)
       values (?,?,?,?,?,?,?,?)`,
      [newId(), orgId, DEFAULT_PLAN_CODE, "trialing", "monthly", addDays(14).toISOString(), now, now]
    );

    const session = createSession(userId);
    await setSessionCookie(session.token, session.expiresAt);
    audit({ organizationId: orgId, actorId: userId, action: "auth.signup", targetType: "organization", targetId: orgId });
  } catch (e) {
    // Roll back a half-created account so the email is not left unusable.
    if (createdUserId) run("delete from profiles where id = ?", [createdUserId]);
    return fail(e);
  }
  redirect("/onboarding");
}

/* ------------------------------------------------------------------- login */

export async function loginAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const limit = rateLimit(await clientKey("login"), LOGIN_LIMIT, LOGIN_WINDOW_SECONDS);
    if (!limit.allowed) return { error: `Too many login attempts. Try again in ${Math.ceil(limit.resetInSeconds / 60)} minutes.` };

    const email = emailField(form.get("email")).toLowerCase();
    const password = String(form.get("password") ?? "");
    if (!password) throw new ValidationError("Enter your password.");

    const user = get<{ id: string; password_hash: string | null; is_super_admin: number }>(
      "select id, password_hash, is_super_admin from profiles where lower(email) = ?",
      [email]
    );
    // Same message for unknown email and wrong password — no account enumeration.
    const ok = user ? await verifyPassword(password, user.password_hash) : false;
    if (!user || !ok) {
      audit({ action: "auth.login_failed", metadata: { email } });
      return { error: "Email or password is incorrect." };
    }

    const session = createSession(user.id);
    await setSessionCookie(session.token, session.expiresAt);
    audit({ actorId: user.id, action: "auth.login" });
  } catch (e) {
    return fail(e);
  }
  redirect("/dashboard");
}

export async function logoutAction(): Promise<void> {
  await clearSessionCookie();
  redirect("/login");
}

/* ---------------------------------------------------------- password reset */

export async function requestPasswordResetAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const generic = "If an account exists for that email, a reset link has been created.";
  try {
    const limit = rateLimit(await clientKey("reset"), 5, 900);
    if (!limit.allowed) return { error: "Too many reset requests. Please wait a few minutes." };
    const email = emailField(form.get("email")).toLowerCase();

    const user = get<{ id: string; email: string }>("select id, email from profiles where lower(email) = ?", [email]);
    if (!user) return { notice: generic };

    const token = newToken(32);
    run(
      "insert into password_resets (id, user_id, token_hash, expires_at, created_at) values (?,?,?,?,?)",
      [newId(), user.id, sha256(token), addDays(1).toISOString(), nowIso()]
    );
    const base = (await headers()).get("origin") ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    const link = `${base}/reset-password?token=${token}`;

    const sent = await sendEmail({
      to: user.email,
      subject: "Reset your BizPilot AI password",
      text: `Use this link within 24 hours to choose a new password:\n\n${link}\n\nIf you did not request this, ignore this email.`,
    });

    if (sent.ok) return { notice: generic };
    // Email is not configured in this deployment: hand the link over directly rather than
    // claiming an email was sent. This branch is only reachable without RESEND_API_KEY.
    if (!isEmailConfigured()) {
      return {
        notice: generic,
        fieldErrors: { resetLink: link },
      };
    }
    return { error: "Email delivery failed. Please contact support." };
  } catch (e) {
    return fail(e);
  }
}

export async function resetPasswordAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const token = String(form.get("token") ?? "");
    const password = String(form.get("password") ?? "");
    if (!token) throw new ValidationError("Reset link is missing its token.");
    const problems = passwordProblems(password);
    if (problems.length) throw new ValidationError(problems.join(" "));

    const row = get<{ id: string; user_id: string; expires_at: string; used_at: string | null }>(
      "select id, user_id, expires_at, used_at from password_resets where token_hash = ?",
      [sha256(token)]
    );
    if (!row || row.used_at || new Date(row.expires_at) < new Date()) {
      throw new ValidationError("This reset link is invalid or has expired. Request a new one.");
    }

    const hash = await hashPassword(password);
    run("update profiles set password_hash = ?, updated_at = ? where id = ?", [hash, nowIso(), row.user_id]);
    run("update password_resets set used_at = ? where id = ?", [nowIso(), row.id]);
    // Invalidate every existing session for that user.
    run("delete from sessions where user_id = ?", [row.user_id]);
    audit({ actorId: row.user_id, action: "auth.password_reset" });

    const session = createSession(row.user_id);
    await setSessionCookie(session.token, session.expiresAt);
  } catch (e) {
    return fail(e);
  }
  redirect("/dashboard");
}

/* -------------------------------------------------------------- onboarding */

export async function onboardingAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { requireUser, membershipForUser } = await import("@/lib/auth");
    const user = await requireUser();
    const membership = membershipForUser(user.id);
    if (!membership) return { error: "No workspace found for this account." };

    const businessType = str(form.get("businessType"), "Business type", { min: 2, max: 80 });
    const website = (form.get("website") as string) || null;
    const phone = (form.get("phone") as string) || null;
    const timezone = (form.get("timezone") as string) || "UTC";
    const currency = (form.get("currency") as string) || "USD";

    run(
      "update organizations set business_type = ?, website = ?, phone = ?, timezone = ?, currency = ?, updated_at = ? where id = ?",
      [businessType, website, phone, timezone, currency, nowIso(), membership.organization_id]
    );
    run("update profiles set onboarded_at = ?, updated_at = ? where id = ?", [nowIso(), nowIso(), user.id]);
    audit({ organizationId: membership.organization_id, actorId: user.id, action: "org.onboarded" });
  } catch (e) {
    return fail(e);
  }
  redirect("/dashboard");
}
