import { cookies } from "next/headers";
import { newId, newToken } from "./ids";
import { addDays, nowIso } from "./utils";
import { run, get } from "./db";

const COOKIE_NAME = "bizpilot_session";
const SESSION_DAYS = 30;

export type SessionUser = {
  id: string;
  email: string;
  full_name: string | null;
  is_super_admin: number;
  onboarded_at: string | null;
};

export function createSession(userId: string): { token: string; expiresAt: string } {
  // Token is stored server-side only as an id; the cookie holds an opaque value
  // that maps to a session row (no user data in the cookie).
  const token = newToken(32);
  const expiresAt = addDays(SESSION_DAYS).toISOString();
  run(
    "insert into sessions (id, user_id, expires_at, created_at) values (?, ?, ?, ?)",
    [token, userId, expiresAt, nowIso()]
  );
  return { token, expiresAt };
}

export async function setSessionCookie(token: string, expiresAt: string) {
  const store = await cookies();
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: new Date(expiresAt),
  });
}

export async function clearSessionCookie() {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (token) run("delete from sessions where id = ?", [token]);
  store.delete(COOKIE_NAME);
}

export async function readSessionToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(COOKIE_NAME)?.value ?? null;
}

export function getUserBySessionToken(token: string | null): SessionUser | null {
  if (!token) return null;
  const row = get<SessionUser & { expires_at: string }>(
    `select p.id, p.email, p.full_name, p.is_super_admin, p.onboarded_at, s.expires_at
       from sessions s join profiles p on p.id = s.user_id
      where s.id = ?`,
    [token]
  );
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    run("delete from sessions where id = ?", [token]);
    return null;
  }
  return {
    id: row.id,
    email: row.email,
    full_name: row.full_name,
    is_super_admin: row.is_super_admin,
    onboarded_at: row.onboarded_at,
  };
}

export function newSessionId(): string {
  return newId();
}
