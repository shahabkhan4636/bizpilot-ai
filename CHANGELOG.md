# Changelog

Every entry states what changed, why, and the test evidence. Phases follow the
platform-owner build-out plan (`PHASE-0-SETUP.md`).

---

## Phase 1 — super-admin identity (2026-08-09)

**What changed**

- The platform owner is now decided in exactly one place: `src/lib/owner.ts`
  (`isSuperAdmin`, `isSuperAdminEmail`, `superAdminFlag`, `superAdminEmail`).
  The rule is *the account whose email equals `ADMIN_EMAIL`*, compared
  case-insensitively after trimming.
- `requireSuperAdmin()` (`src/lib/auth.ts`) now calls `notFound()` instead of
  `redirect("/dashboard?error=forbidden")`, so a non-owner receives a **404** —
  a redirect or a 403 would confirm that an admin area exists.
- `ADMIN_EMAIL` unset ⇒ **nobody** is a super-admin, so every `/admin` route 404s.
  That is the safe failure mode for a self-hosted copy or a restored database.
- The session's `is_super_admin` is now **derived** from the email rule
  (`src/lib/session.ts`) instead of being read from the stored flag, and signup
  writes the flag through the same helper (`src/lib/actions/auth.ts`). A stale
  database flag can no longer keep an old account inside `/admin`, and changing
  `ADMIN_EMAIL` revokes access with a single variable change.
- `/admin` reads the gate **before** any data (`src/app/admin/page.tsx`).

**Why**

The flag was a snapshot written at sign-up, so revoking or transferring ownership
meant editing rows by hand. The env var is the source of truth for a
single-owner product, and the 404 (instead of a redirect) stops leaking that an
admin area exists.

**Tests**

| Gate | Before | After |
| --- | --- | --- |
| `npx vitest run` | 221 passed / 10 skipped | **227 passed / 10 skipped** |
| `npx playwright test` (SQLite) | 25 passed | **28 passed** |
| `npx playwright test` (Postgres) | 25 passed | **28 passed** |

- New `tests/owner.test.ts` (6): unset `ADMIN_EMAIL` ⇒ no owner even with a DB
  flag; case/whitespace insensitive match; stale flag on another address cannot
  promote; missing user; blank variable; flag derives from the rule.
- New `e2e/admin.spec.ts` (3): non-admin ⇒ **404** and no panel words leaked;
  `ADMIN_EMAIL` user ⇒ **200** + panel; owner keeps access after re-login
  (order-independent: tries login first, because the owner's address cannot carry
  a timestamp).
- Changed `e2e/app.spec.ts` guard test: the old assertion expected a redirect to
  `/dashboard`; it now asserts **404**. Same count, intentional behaviour change.

**Env vars**

- No new variables. `ADMIN_EMAIL` is now the single gate (documented in
  `.env.example` as such).

**Not done in this phase (by design)**

- Resend / email outbox → Phase 2
- Platform payment details and claims → Phase 3
- Owner unlimited limits → Phase 4
- `/admin/workspaces`, `/admin/payments`, impersonation → Phase 5
