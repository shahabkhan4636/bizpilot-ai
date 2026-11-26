# Phase 3 — Security & Multi-Tenant Isolation · Report

Date: 2026-08-09 · Engine: PostgreSQL 17 (primary) + SQLite (dev/fallback) · Node 20

## 1. What this phase had to prove

1. Five roles exist and behave differently: **owner, admin, manager, member, viewer**.
2. Customer A can never reach Customer B's leads, proposals, documents, automation logs,
   analytics or settings — by URL, by ID guessing, or by calling a server action directly.
3. Every mutation is checked **server-side**; the UI hiding a button is a convenience, never
   the control.
4. Denials are honest: a refused write explains itself instead of leaking a stack trace or
   silently "succeeding".

## 2. What was built

| Area | Where | Notes |
| --- | --- | --- |
| Permission catalogue | `src/lib/permissions.ts` | 5 roles × 24 permissions, single `GRANTS` table, `can()`, `permissionsFor()`, `isReadOnly()`, `canManageWorkspace()`, `canManageTeam()`, `canEditOwnedRecord()` |
| Action guard | `src/lib/authz.ts` | `requirePermission()` throws `ForbiddenError`; `forbiddenRedirect()` for void actions |
| Server-side gating | 29 call sites in `src/lib/actions/*` | every write, delete, export, AI call, team and settings action |
| Row-level security | `sql/rls.postgres.sql` | 26 tables, 83 policies, verified on a live cluster |
| Denial page | `src/app/forbidden/page.tsx` | names the role, the missing permission, and confirms nothing changed |
| Read-only UI | leads, proposals, documents, app shell | `ctx.can(...)` hides create/import/upload affordances |
| Notifications | `src/lib/notifications.ts` | 10 types, scoped per user and per organisation |
| Email verification | `src/lib/email-verification.ts` | 48 h, single-use, sha256 at rest, one live token per user |
| Account deletion | `src/lib/actions/account.ts` | password + typed confirmation, owner-blocked while teammates exist |
| Security headers | `next.config.ts` | CSP, HSTS, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy |

### Permission matrix (as enforced)

| Permission | owner | admin | manager | member | viewer |
| --- | :-: | :-: | :-: | :-: | :-: |
| 8 read permissions (`lead:read`, `customer:read`, `proposal:read`, `document:read`, `automation:read`, `analytics:read`, `ai:read`, `billing:read`) | ✅ | ✅ | ✅ | ✅ | ✅ |
| lead / customer write + delete | ✅ | ✅ | ✅ | write | — |
| `proposal:write` / `proposal:delete` | ✅ | ✅ | ✅ | — | — |
| `document:upload` / `document:delete` | ✅ | ✅ | ✅ | upload | — |
| `automation:manage` | ✅ | ✅ | ✅ | — | — |
| `approval:act` | ✅ | ✅ | ✅ | — | — |
| `ai:generate` | ✅ | ✅ | ✅ | ✅ | — |
| `export:data` | ✅ | ✅ | ✅ | ✅ | — |
| `team:manage` | ✅ | ✅ | — | — | — |
| `settings:workspace` | ✅ | ✅ | — | — | — |
| `billing:manage` | ✅ | ✅ | — | — | — |
| `workspace:delete` | ✅ | — | — | — | — |

Unknown role ⇒ deny (fail closed). `owner` is never assignable through the UI or the actions,
is immutable, and cannot be removed or self-removed.

## 3. Bugs found and fixed during verification (not theoretical)

1. **`org_invites.role` rejected `manager`/`viewer`.** Migration 001 pinned the invite CHECK to
   (`owner`,`admin`,`member`) while migration 003 only widened `organization_members`. Inviting a
   viewer failed with a raw Postgres constraint error surfaced in the UI. Fixed by **migration 004**
   (Postgres in-place constraint swap, SQLite table rebuild), both with `.down` files.
   *Found by:* the new viewer e2e journey.
2. **`computeTotals` broke the production build.** It was exported from a `"use server"` module,
   and those may only export async functions — `next build` failed. Moved to
   `src/lib/proposal-math.ts` (pure) and imported from both the action and the tests.
3. **A `?` placeholder miscount in the proposal insert (25 vs 24).** Added
   `assertPlaceholders()` to the Postgres bridge so a mismatch reports both numbers and the first
   120 characters of the statement instead of an opaque protocol error.
4. **Test resets wiped `schema_migrations`**, so the next run believed every migration was pending.
   Both the e2e reset and `resetDatabaseForTests()` now preserve `plans` and `schema_migrations`.
5. **Boot schema was not idempotent.** `alter table … add column` in the generated snapshot threw
   `duplicate column name` on the second boot and failed `next build`. The snapshot is now applied
   statement-by-statement, ignoring only "already applied" errors; comment lines are stripped
   before splitting so a leading `--` cannot silently drop the statement that follows.
6. **Void server actions returned an error state** (`Promise<void>`), and refusing at the guard threw
   a 500. They now redirect to `/forbidden` with the permission name.
7. **Viewers still saw write affordances:** the header "New lead" button, the leads Import button,
   the empty-state "Import CSV", the proposals "New proposal" button and the documents upload card.

## 4. Verification executed (real, not asserted)

```
npx tsc --noEmit                 clean (0 errors, strict)
npx eslint .                     0 errors, 0 warnings
npx vitest run                   100 passed | 10 skipped (6 files)
npx playwright test (postgres)   18 passed
npx playwright test (sqlite)     18 passed
```

Live checks against `next start`:

```
GET /login       → 200 + CSP, HSTS, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy
GET /api/readiness → 200 {"ready":true,"engine":"sqlite","checks":{"schema":{"ok":true},"migrations":{"ok":true}},...}
GET /forbidden (unauthenticated) → 307 → /login
```

Live database checks on PostgreSQL 17:

```
pg_constraint org_invites_role_check → CHECK (role = ANY ('owner','admin','manager','member','viewer'))
schema_migrations → 001, 002, 003, 004 applied
```

Cross-tenant and role journeys covered by e2e: invitation → join, tenant isolation (workspace B
cannot see workspace A records), viewer read-only (UI + server), settings/billing/admin guards,
notification scoping, `?new=1` deep link refused for a viewer.

## 5. Journeys map (master-prompt QA list)

| Journey | Status | Where |
| --- | --- | --- |
| A — signup → onboarding → first lead | ✅ | `e2e/app.spec.ts` signup + lead creation |
| B — AI assistant & approvals | ✅ (live AI **BLOCKED**, correctly reported in UI) | AI page + approvals |
| C — proposal → share link → client accept | ✅ | "proposal creation, PDF export, share link and client acceptance" |
| D — team invite & role change | ✅ | invitation flow |
| E — billing | ⚠️ UI + entitlement enforcement ✅, live Stripe **BLOCKED** | billing page test |
| F — cross-tenant denial | ✅ | tenant isolation + viewer test |
| G — plan-limit block | ✅ | unit + e2e lead-limit path |

## 6. Blocked on credentials (documented, not faked)

Stripe (`STRIPE_*`), Resend (`RESEND_API_KEY`, `EMAIL_FROM`), AI (`AI_API_KEY`, `AI_MODEL`,
`AI_BASE_URL`), Dropbox (`DROPBOX_APP_*`), production `DATABASE_URL`, Vercel. Each surface shows a
"not configured" state and `/api/readiness` lists it under `warnings` — no surface pretends to work.
