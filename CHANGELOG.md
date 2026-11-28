# Changelog

Every entry states what changed, why, and the test evidence. Phases follow the
platform-owner build-out plan (`PHASE-0-SETUP.md`).

---

## Phase 6 — deploy runbook and post-deploy smoke test (2026-08-09)

**What changed**

- **`DEPLOY-ADMIN.md`** (new, root): the owner-facing launch runbook — Supabase
  **Session pooler** (the IPv4 problem that silently blocks a Vercel deploy of the direct
  connection), the exact environment table, migrate → deploy → smoke order, a 10-minute
  day-1 checklist (sign up as `ADMIN_EMAIL`, enter payout numbers, decide the Founding
  offer, verify `/billing/platform`), the Vercel cron reality (Hobby = daily, `vercel.pro.json`
  = every 10 min), a symptom → first-move incident table, rollback for both deploy and
  migration, the support tools with the safety rule built into each, security hygiene, and
  an explicit "what is still not possible" table.
- **`scripts/smoke.mjs`** + `npm run smoke`: nine real checks against a live deployment —
  site renders, login renders, **strict CSP with a nonce and no `'unsafe-inline'` for
  scripts**, `/api/readiness` is `ready: true`, anonymous `/admin` never leaks panel
  content, `/billing/platform` never exposes payout details without a session, the email
  cron refuses an unauthenticated request, an unsigned payment webhook is refused, unknown
  routes 404. `--list` previews without touching the network; exit `0` pass / `1` fail /
  `2` no URL. Verified **9/9 against a real production build** locally, and the failure
  path exits **1** against a dead port (proven, not assumed).
- **`.env.example`**: added the variables the app reads but the file never listed
  (`SESSION_SECRET`, `LOG_LEVEL`, `SUPPORT_EMAIL`, `DROPBOX_DOWNLOAD_URL`, plus commented
  `BIZPILOT_DB_FILE` / `BIZPILOT_PG_WORKER`) and a note that production must use the
  Supabase **Session pooler** string.
- **`tests/deploy-docs.test.ts`** (new, 9 tests): fails the build if the code reads an
  environment variable that is documented in neither `.env.example` nor `DEPLOY-ADMIN.md`
  (verified by temporarily deleting `SESSION_SECRET` from both — the test failed, then
  passed after restoring); checks the runbook still covers the owner-critical steps, still
  states what is blocked, and contains **no wallet number, IBAN, Resend key or Stripe key**;
  and exercises the smoke CLI (`--list`, usage exit code, `package.json` wiring).
- `README.md` and `docs/DEPLOYMENT.md` link the new runbook; README's script table gained
  `npm run smoke` and the stale test counts were corrected.

**Why**

Everything built in Phases 1–5 is useless if the owner cannot get it onto a domain without
guessing. The runbook is the difference between "the code is ready" and "the product is
live", and the smoke script is how a deploy is judged instead of assumed.

**Test evidence**

- `npx vitest run` → **352 passed / 10 skipped (362 tests, 22 files)** (was 343/10; +9).
- `npx playwright test` → **34 passed** on SQLite **and** **34 passed** on Postgres.
- `node scripts/smoke.mjs http://127.0.0.1:3210` against a real `next start` production
  build → **9/9 passed**; against a closed port → **0/9, exit 1**.
- `npm run verify` → typecheck, lint, unit tests, schema snapshot, build: **all gates green**.

---

## Phase 5 — admin workspaces, users, payments, suspension and impersonation (2026-08-09)

**What changed**

- Migration `012_admin_impersonation` (applied to `data/bizpilot.db`, `data/e2e.db`, both
  local Postgres databases and Supabase production — 12 migrations, 37 tables):
  `organizations.suspension_reason` + `suspended_by`, and `impersonation_sessions`.
- **New admin pages:** `/admin/workspaces` (server-side search, plan/status filters,
  pagination, owner + Founding badges), `/admin/workspaces/[id]` (members, plan,
  Founding Member controls, danger zone, recent audit trail), `/admin/users`
  (verification state, last sign-in, workspaces per account) and `/admin/payments`
  (three tabs: platform claims, workspace payments, refunds).
- **Suspend/restore with a mandatory reason** (`src/lib/admin/workspaces.ts`): the
  reason is stored on the row, audited, the owner is notified in-app **and** emailed
  through the outbox. `requireAuth` now `redirect("/suspended")` instead of throwing,
  so a suspended customer sees a page explaining what happened and why instead of a 500.
  The platform owner's own workspace is refused — locking yourself out of your own
  product through the support tool is an outage, not a mistake.
- **Impersonation** (`src/lib/impersonation.ts`): the admin's session is *never*
  replaced (a second cookie points at a row), **read-only by default**, write mode needs
  the typed word `IMPERSONATE`, every write is audited as `impersonated_write: true`
  and notifies the workspace owner once per session, sessions expire after 60 minutes,
  only the admin who started one can use it, and the platform owner's own account can
  never be impersonated.
- Enforcement lives in the authorisation layer: `requirePermission` refuses every
  non-read permission under read-only impersonation (so a future action is covered
  without being remembered) and records the write under write mode.
  `READ_ONLY_PERMISSIONS` + `isWritePermission` are exported from `permissions.ts` for
  exactly this, and the UI hides write affordances from the same rule.
- One path per decision: the quick "Suspend" button in the `/admin` table and the old
  `suspendOrganizationAction` were replaced by a link to the workspace record (a reason
  is now unavoidable), and plan assignment delegates to `applyWorkspacePlan`.

**Why**

This is the part that makes the platform runnable by one person: see who is on which
plan, get a customer unstuck, and look at their screen when a bug report says "it's
broken" — without ever becoming able to change their data silently.

**Bugs found and fixed in this phase**

1. **A "use server" file exported a string** (`IMPERSONATION_CONFIRMATION_WORD`), which
   crashed `/admin/platform-payments` at runtime — caught by the Phase 3 e2e test still
   passing in the suite. Constants moved to `impersonation-shared.ts`.
2. **The banner pulled `better-sqlite3` into the browser bundle** (client component
   importing the DB-backed module) — the build failed; fixed by the same shared module.
3. **Two `currentUser()` functions existed** — the one in `auth.ts` read the raw session
   and ignored impersonation, so "view as customer" silently showed the owner their own
   dashboard. Found by the new e2e test; `auth.currentUser` now delegates to the
   impersonation-aware resolver.
4. **Confirmation messages vanished after a successful suspend** (`revalidatePath` drops
   form state) — same class of bug as Phase 3; fixed with `?done=suspended|restored|plan`.

**Test evidence**

- `npx vitest run` → **343 passed / 10 skipped (353 tests, 21 files)** (was 305/10;
  +22 `tests/impersonation.test.ts`, +16 `tests/admin-workspaces.test.ts`).
- `npx playwright test` → **34 passed** on SQLite **and** **34 passed** on Postgres
  (3 new admin journeys: admin-only pages, suspend → customer blocked → restore,
  impersonation read-only → typed confirmation → real write → audited → exit).
- `npm run verify` → typecheck, lint, unit tests, schema snapshot, build: **all gates green**.

---

## Phase 4 — the platform owner's workspace is unlimited (2026-08-09)

**What changed**

- `src/lib/limits.ts` — `UNLIMITED` (`Number.POSITIVE_INFINITY`), `isUnlimited`,
  `limitLabel` ("Unlimited" instead of ∞), `usageLabel`. `Infinity` rather than a big
  constant on purpose: `used >= Infinity` is always false, so no caller can exceed it
  by accident and no one has to know a magic number.
- `isPlatformOwnerWorkspace(organizationId)` in `src/lib/plans.ts` — the workspace
  where the **`ADMIN_EMAIL` account is a member with role `owner`**. Read from data,
  never from a flag.
- `getEffectivePlan` applies it **last**, after the catalogue and after the Founding
  Member seat override: every numeric limit becomes `UNLIMITED`, every feature
  (`ALL_FEATURES`) is on, and `plan.isPlatformOwner = true`. So the enforcement layer
  itself changes — `checkLeadLimit`, `checkAiLimit`, `checkDocumentLimit`,
  `checkAutomationLimit`, `checkFeature` and the seat check in `invites.ts` all inherit
  the rule. No button was hidden to fake this.
- `subscriptionIsUsable` is true for the owner's workspace: the vendor does not have
  to buy their own product to keep paid features working.
- Presentation: `limitLabel`/`usageLabel` now render "Unlimited" on the dashboard,
  `/leads`, `/leads/import`, `/ai-assistant`, the AI workspace and `/billing`.
- Badges: the sidebar and topbar show **Platform owner** for the `ADMIN_EMAIL`
  account, and the `/admin` workspace list marks the owner's workspace (plan column
  reads `unlimited` / `never billed`) so a workspace that is never billed is visibly
  intentional rather than a bug.

**Why**

Two opposite failures were possible, so both are tested: (a) the owner being blocked
by their own product's plan engine mid-demo, and (b) unlimited limits leaking to a
paying customer. Being *invited into* a customer's workspace as admin or viewer must
not give that customer free seats and free AI — hence the role check — and an unset
`ADMIN_EMAIL` gives unlimited to **nobody**, which is the safe default.

**Test evidence**

- `npx vitest run` → **305 passed / 10 skipped (315 tests, 19 files)** (was 291/10;
  +14 in `tests/platform-owner-unlimited.test.ts`).
- `npx playwright test` → **31 passed** on SQLite **and** **31 passed** on Postgres
  (new case: "the platform owner's own workspace is unlimited and badged, and a
  customer's is not" — it asserts the customer sees a numeric limit and **no** badge).
- `npm run verify` → typecheck, lint, unit tests, schema snapshot, build: **all gates green**.

---

## Phase 3 — platform payments & Founding Member (2026-08-09)

**What changed**

- New migration `011_platform_payments` (applied to all four databases: `data/bizpilot.db`,
  `data/e2e.db`, Postgres `bizpilot`, Postgres `bizpilot_ci`): `platform_settings` (one row —
  payout numbers, default method, instructions, `demo_mode`, Founding price/slots/seats),
  `platform_payment_claims` (status, amount in paisa, method, transaction ID, `self_approved`,
  `founding_member`) and `founding_memberships` (unique per workspace, `locked_price_cents`,
  `member_limit`, `source auto|manual`).
- `src/lib/platform-payments.ts` — pure rules: settings validation, which payout methods a
  customer may see, slot counting, and `resolveClaimAmountCents` (a Founding Member is quoted
  the **locked** price, everyone else the rupee conversion of the catalogue).
- `src/lib/platform-payments-server.ts` — the transactional half: save settings (audited, and the
  audit records *which* methods exist, not the numbers), submit a claim, approve/reject a claim,
  grant/revoke a Founding membership, `quoteForClaim`.
- **The amount is computed on the server.** A claim's price never comes from the form, so a
  customer cannot edit what they owe.
- **Founding Member = Starter limits + 3 seats, price locked forever.** Granted automatically when
  a founding-priced claim is approved, or manually from the admin page. Renewals read
  `founding_memberships.locked_price_cents`; `getEffectivePlan` applies the locked seat count, so a
  later catalogue price change can never raise an existing member's price (there is a test for
  exactly this).
- **Slots are counted, never trusted:** `count(*) from founding_memberships`. Past the limit the
  next customer is quoted the ordinary catalogue price.
- **Self-approval is allowed and recorded** (`self_approved: true` in the claim row *and* the audit
  metadata) — a one-person platform still has to be able to run its own product, but the trail
  never pretends the approval was independent.
- **`demo_mode`** auto-approves the platform owner's *own* claim (flagged, note `demo_mode
  auto-approval`); customer claims still wait. Off by default.
- New pages: `/admin/platform-payments` (payout settings, pending queue with approve/reject and a
  reason the customer reads, Founding Member list, reviewed history) and `/billing/platform`
  (a customer pays **BizPilot**). `/billing/local` — where a customer's own clients pay *them* — is
  untouched; the two flows share nothing but `ensureSubscriptionPlan`.
- `src/lib/payments/approve.ts`: the subscription write moved into exported
  `ensureSubscriptionPlan`, now shared by the local and platform flows. Behaviour is unchanged and
  locked by the new regression suite.
- Confirmation after a review survives the re-render: it lands in the URL
  (`?reviewed=approve|reject`) because `revalidatePath` drops the form's local state.

**Why**

Phase 3 is the part that turns the product into revenue: a Pakistani customer can send rupees to
the owner's own wallet, the owner approves it in one click, and the workspace's plan changes
immediately. The Founding Member offer needed a *database* price lock, not a promise in the copy —
otherwise the first price increase silently breaks the offer.

**Bugs found and fixed in this phase**

1. `resolveClaimAmountCents` mixed rupees and paisa for non-founding claims (a Rs 2,800 plan would
   have been stored as 2,800 paisa = Rs 28). Caught by the unit test, fixed by ×100 before storage.
2. Approving from the admin queue gave no visible confirmation — `revalidatePath` re-rendered the
   page and the form's `useActionState` message vanished. Found by the e2e test; fixed with a
   redirect-based confirmation.

**Test evidence**

- `npx vitest run` → **291 passed / 10 skipped (301 tests, 18 files)** (was 241/10 before this phase;
  +32 in `tests/platform-payments.test.ts`, +18 in `tests/local-payments-regression.test.ts`).
- `npx playwright test` → **30 passed** on SQLite **and** **30 passed** on Postgres (new case:
  "platform payments: owner configures payouts, a customer claims, the owner approves and the plan
  activates").
- `npm run verify` → typecheck, lint, unit tests, schema snapshot, build: **all gates green**.

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

---

## Phase 2 — transactional email + outbox (2026-08-09)

**What changed**

- **`email_outbox`** (migration **010**): every transactional email is written to
  the database *before* it is dispatched. Columns cover `status`
  (`queued`/`sending`/`sent`/`failed`), `attempts`, `next_attempt_at`,
  `last_error`, `provider_message_id`, `kind` and `sent_at`.
- **`src/lib/email-outbox.ts`** — the state machine: `queueEmail`, `deliverEmail`
  (queue + one immediate attempt), `attemptDelivery`, `dispatchQueuedEmails`,
  `outboxCounts`, `listOutbox`.
- **Retry schedule 5 min → 30 min → 2 hours** (`RETRY_DELAYS_MINUTES`), then the
  row is `failed` and needs a human. **A missing `RESEND_API_KEY` never burns an
  attempt**: the message waits in `queued` until the key exists.
- **`RESEND_FROM_EMAIL`** is now the from address for every email;
  `EMAIL_FROM` still works as a fallback; the default is a neutral
  `BizPilot AI <no-reply@example.com>` — no owner address in source.
- All four call sites moved to `deliverEmail`: password reset, email
  verification, org invite, and the approved automation email.
- **`/admin/email`** (super-admin only, 404 otherwise): queued / failed / sent
  counts, the provider's own error per failed row, per-row **Retry**, **Retry
  everything now**, **Delete**, and a **test-send** form whose result is the
  provider's real response.
- **`GET|POST /api/cron/email`** — authenticated retry worker
  (`Authorization: Bearer $CRON_SECRET`, `?dryRun=1` reports without sending),
  wired into `vercel.json` (daily, Hobby-safe) and `vercel.pro.json` (every 10 min).
- Admin actions added: `retryOutboxEmailAction`, `retryAllEmailsAction`,
  `sendTestEmailAction`, `deleteOutboxEmailAction` — all audited.

**Why**

An email that could not be sent used to be reported to the UI and then forgotten.
With no `RESEND_API_KEY`, a password-reset link was lost — the person was told
"not configured" and had no way back in. Now the message is durable, retried on a
schedule, and recoverable the moment the provider is configured.

**Bug found and fixed while building it**

`dispatchQueuedEmails({ force: true })` reset `next_attempt_at` to the wall clock
and then compared it against a `now` captured microseconds earlier, so a forced
retry could be skipped as "not due". `attemptDelivery` now takes `force`
explicitly and the schedule check is bypassed rather than faked in the database.

**Tests**

| Gate | Before | After |
| --- | --- | --- |
| `npx vitest run` | 227 passed / 10 skipped | **241 passed / 10 skipped** |
| `npx playwright test` (SQLite) | 28 passed | **29 passed** |
| `npx playwright test` (Postgres) | 28 passed | **29 passed** |

- New `tests/email.test.ts` (14): from-address precedence; `configured=false` with
  no HTTP call; provider error text preserved; queue-before-send; missing key does
  not burn an attempt; **the queue is recoverable** once the key exists; the exact
  5/30/120-minute schedule and the `failed` end state; not-due rows skipped; a
  single-row retry leaves other rows alone; a delivered message is never resent.
- New e2e (1): `/admin/email` is 404 for a stranger, 200 for the owner, shows the
  honest "not configured" state, and a test send **queues instead of claiming it
  left**, with the row visible and zero attempts burned.

**Env vars**

- Added: `RESEND_FROM_EMAIL` (name only, documented in `.env.example`).
- `RESEND_API_KEY` unchanged; `EMAIL_FROM` retained as a fallback.

**Blocked / not verified yet**

- A **real send** still needs `RESEND_API_KEY` in the deployment. The code path,
  the from address, the retry behaviour and the admin surface are all exercised
  with the transport stubbed at `fetch`; the one thing that is *not* proven is
  Resend accepting a live message from the owner's address. `/admin/email` →
  "Send test email" is the one click that will prove it.
