/**
 * Impersonation constants, safe for both the server and the browser bundle.
 *
 * Kept in their own module because the banner is a client component: importing
 * `@/lib/impersonation` there would drag `better-sqlite3` into the browser build
 * (which is exactly how this blew up once), while duplicating the confirmation word
 * in the UI would let the two drift apart.
 */

export const IMPERSONATION_COOKIE = "bizpilot_impersonate";
export const IMPERSONATION_MINUTES = 60;
export const IMPERSONATION_CONFIRM_WORD = "IMPERSONATE";

export type ImpersonationMode = "read_only" | "write";
