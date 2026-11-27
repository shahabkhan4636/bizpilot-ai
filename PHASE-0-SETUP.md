# PHASE 0 — SETUP & IMPACT ANALYSIS

**Status: waiting for your approval. No production code has been written or changed.**
This document was produced from a read-only inspection of the codebase at commit
`a1111f2` plus your answers to the Phase-0 questions.

---

## 1. Confirmed decisions (your answers)

| # | Question | Your answer | Consequence |
| --- | --- | --- | --- |
| 1 | Pricing | **Hybrid** — catalogue stays (Rs 8,200–83,800), plus **Founding Member**: first 10 customers locked at **Rs 1,500/month forever**, with a counter | New table for locked prices + offer display in `/pricing` and `/billing`. **No** plan-catalogue rewrite, so no repricing migration |
| 2 | Super-admin | **Keep** `shahabkhanprofessional@gmail.com` | `ADMIN_EMAIL` unchanged in Vercel |
| 3 | Resend | You will put `RESEND_API_KEY` in **Vercel env**; I read it via the connector and send a real test email | I never see it in chat; a real send is the proof |
| 4 | Platform payment numbers | I build **`/admin/platform-payments`**; **you** enter the numbers there | No numbers in source, no numbers in chat |
| 5 | Owner workspace | **Unlimited access** + visible in the admin workspace list marked **“platform owner”** | Enforcement-layer bypass + badge in `/admin` |
| 6 | Impersonation | **Yes, read-only** | Session flag + banner + audit entries; every write blocked while impersonating |

### Values in play (secrets redacted)

| Item | Value | Where |
| --- | --- | --- |
| Super-admin email | `shah…@gmail.com` (full value in Vercel `ADMIN_EMAIL`) | Vercel env ✅ already set |
| Super-admin display name | **MISSING — need from you** (suggested: “Shahab Khan”) | `profiles.full_name` at signup |
| Vercel project | `bizpilot-ai` / `prj_Yjg54ublYIGrnKFvYLRPsev78rdJ` / `team_u76Q3u7Qi14nCDxdQ0eQ2XNq` | — |
| Vercel env currently set | `ADMIN_EMAIL` (plain), `CRON_SECRET` (sensitive) — **verified just now via API** | `RESEND_API_KEY` **not yet present** |
| Resend API key | **MISSING — you will add to Vercel** (`RESEND_API_KEY`) | env |
| Resend from-address | **MISSING — need from you** (`onboarding@resend.dev` for testing, or your domain) | env |
| Resend domain verified? | **UNKNOWN — need from you** | Resend dashboard |
| Platform SadaPay / JazzCash / EasyPaisa / IBAN | **MISSING by design** — you enter them in `/admin/platform-payments` after Phase 3 | DB `platform_settings` |
| Supabase `DATABASE_URL` (Session pooler) | **MISSING** — I verified from this machine that both pooler clusters answer `tenant not found`, so I cannot derive it | Vercel env |
| Vercel plan | **UNKNOWN — need from you** (Hobby forbids commercial use; Pro $20/mo needed before charging) | Vercel billing |

---

## 2. Current implementation status (evidence, not assumptions)

### 2.1 Super-admin — **partially built, two gaps**

| Finding | Evidence |
| --- | --- |
| `profiles.is_super_admin` column exists; set at signup **only** for the exact `ADMIN_EMAIL` | `src/lib/actions/auth.ts:65-71` |
| Server-side guard exists | `src/lib/auth.ts:60` `requireSuperAdmin()` |
| **Gap 1 — guard redirects instead of 404**: `redirect("/dashboard?error=forbidden")` | `src/lib/auth.ts:62` |
| **Gap 2 — no `isSuperAdmin(user)` helper**; code reads `user.is_super_admin` inline in ~10 places | `grep` across `src/app/**` |
| **Gap 3 — flag is set once at signup**; if `ADMIN_EMAIL` changes later, the existing profile keeps the old flag | `src/lib/actions/auth.ts:66` |
| Existing e2e **asserts the redirect** (`waitForURL("**/dashboard")`) — so Phase 1’s 404 **conflicts with an existing test** | `e2e/app.spec.ts:298-300` |

### 2.2 Email (Resend) — **client is real, naming differs, one gap**

| Finding | Evidence |
| --- | --- |
| Real HTTP client with honest `not_configured` result | `src/lib/email.ts:15-47` |
| From-address comes from **`EMAIL_FROM`**, not `RESEND_FROM_EMAIL` | `src/lib/email.ts:27` |
| `.env.example` documents `RESEND_API_KEY` + `EMAIL_FROM` | `.env.example:51-52` |
| Callers: password reset, verification, invite, account email change, AI email step | `actions/auth.ts:156`, `account.ts:40`, `invites.ts:86`, `ai.ts:185` |
| **Gap — there is no outbox/queue table.** When unconfigured the caller reports “email not configured” to the UI (truthful) but the message is **not** persisted for later delivery. Your prompt assumed a queue exists; it does not | `grep` for outbox/queue → none |
| Only the **automation email step** is gated by human approval (approvals queue), not by email configuration | `src/lib/actions/ai.ts:174` |

### 2.3 Payments — **two different worlds; the platform side does not exist yet**

| Finding | Evidence |
| --- | --- |
| `/billing/local` is **workspace-scoped**: each organisation stores *its own* wallets so *its* clients can pay *it* | `sql/migrations/008_local_payments.up.sql`, `src/app/billing/local/page.tsx` |
| `/billing` (platform subscription) shows **Stripe**, honestly disabled, plus a link to `/billing/local` | `src/app/billing/page.tsx:103-121` |
| **There is no platform-level payout configuration and no platform payment claims** — `grep platform_settings` → nothing | — |
| Approving a claim today activates the *workspace’s own* plan and is done by that workspace’s owner (`billing:manage`) | `src/lib/actions/local-payments.ts` → `approveLocalPaymentRequest` |
| Consequence: a **customer paying the platform** has no path at all. This is Option A work | — |

### 2.4 Plan limits — **no owner bypass**

| Finding | Evidence |
| --- | --- |
| Limits are **organisation-scoped**: `checkLeadLimit(organizationId)`, `checkAiLimit`, `checkDocumentLimit`, `checkAutomationLimit`, `checkFeature` | `src/lib/plans.ts:124-180` |
| Catalogue today: Starter 2,900¢/100 leads/1 member · Professional 7,900¢/1,000/3 · Business 14,900¢/5,000/10 · Agency 29,900¢/25,000/50 (USD cents) | seeded `plans` table (read from the live dev DB) |
| **No super-admin / owner bypass anywhere** | `grep Infinity` → none in `plans.ts` |
| Enforcement happens in server actions (`lead:write`, `member:invite`, …), which is the correct layer for Phase 4 | `src/lib/actions/*.ts` |

### 2.5 Admin surface — **one page, three actions; no sub-pages**

| Finding | Evidence |
| --- | --- |
| Pages: **only** `src/app/admin/page.tsx` (sections: integration status, plans & pricing, workspaces, audit log, webhook deliveries) | `find src/app/admin` |
| Actions: `updatePlanAction`, `suspendOrganizationAction`, `setOrganizationPlanAction` — **no reason field, no unsuspend-by-id page, no user suspend** | `src/lib/actions/admin.ts:18,54,73` |
| Your prompt assumed `/admin/workspaces`, `/admin/workspaces/[id]`, `/admin/users` exist — **they do not**, so Phase 5 is new construction plus tests | — |
| `audit_logs` exists and is written by every sensitive action | `src/lib/audit.ts` |

### 2.6 Test baseline (measured, not remembered)

| Gate | Now |
| --- | --- |
| `npx tsc --noEmit` | clean |
| `npx eslint .` | 0 / 0 |
| `npx vitest run` | **221 passed / 10 skipped** (13 files) |
| `npx playwright test` (SQLite) | **25 / 25** |
| `DATABASE_URL=… BIZPILOT_ENGINE=postgres npx playwright test` | **25 / 25** |

---

## 3. Planned architecture (needs your approval before code)

### 3.1 Platform vs workspace payments — kept deliberately separate

```
CUSTOMER PAYS THE PLATFORM (new, Phase 3)
  /billing  ──▶ sees platform_settings numbers (your SadaPay/JazzCash/EasyPaisa/IBAN)
            ──▶ submits platform_payment_claims row (org, plan, cycle, Rs, reference)
            ──▶ YOU approve in /admin/payments  ──▶ org's plan activates (audited)

CUSTOMER'S OWN CLIENT PAYS THE CUSTOMER (existing, unchanged)
  /billing/local ──▶ workspace's own wallets
                 ──▶ local_payment_requests row
                 ──▶ workspace owner approves ──▶ that workspace's plan activates
```

Same approval *code path* (`approveLocalPaymentRequest` in
`src/lib/payments/approve.ts`) so the two can never disagree about what
“activating a plan” means — but **separate tables, separate pages, separate permissions**.

### 3.2 New schema (migration 010)

| Table | Columns (plain) | Why |
| --- | --- | --- |
| `platform_settings` | `id` (single row `'default'`), `sadapay_number`, `jazzcash_number`, `easypaisa_number`, `bank_iban`, `bank_name`, `account_holder_name`, `default_method`, `instructions`, `updated_at`, `updated_by` | Owner’s payout details, DB-configured, never in source |
| `platform_payment_claims` | `id`, `organization_id`, `plan_code`, `billing_cycle`, `amount_cents`, `currency` (`PKR`), `method_kind`, `reference`, `payer_note`, `status` (`pending/approved/rejected/cancelled`), `submitted_by`, `submitted_at`, `reviewed_by`, `reviewed_at`, `review_note`, `gateway_provider`, `gateway_payment_id`, `paid_at` | The claim, separate from `local_payment_requests` |
| `founding_memberships` | `id`, `organization_id` **unique**, `locked_price_cents`, `note`, `granted_by`, `granted_at` | Founding Member: price locked forever, counter = `count(*)`, **never a drifted counter column** |

### 3.3 Founding Member — my proposal (please confirm)

- `platform_settings.founding_member_price_cents` default **150000 (Rs 1,500)** and
  `founding_member_slots` default **10**.
- While `count(founding_memberships) < slots`, `/pricing` and `/billing` show
  “Founding Member — Rs 1,500/month, locked for life (7 of 10 left)”.
- When a claim is **approved** for a workspace with no `founding_memberships` row
  and slots remain, a row is inserted with `locked_price_cents` = Rs 1,500.
- Their renewal amount is read from `founding_memberships.locked_price_cents`,
  **not** from `plans.price_monthly_cents` — that is what “locked forever” means.
- The plan *limits* stay the catalogue’s Starter limits unless you tell me
  otherwise. **Question 3 below.**

### 3.4 Owner unlimited (Phase 4)

`isPlatformOwner(ctx)` = `user.is_super_admin === 1` **or** `lower(email) === lower(ADMIN_EMAIL)`.
The five `check*Limit` functions return `{ ok: true, limit: Infinity, ... }` for that
organisation, and the enforcement stays in the actions. Regular users unchanged.
Badge in `/admin` workspace list: **platform owner**.

### 3.5 Impersonation, read-only (Phase 5)

- `POST /admin/impersonate` (super-admin only) sets `impersonating_org_id` on the
  session row + `impersonating_admin_id`; a banner renders on every page:
  “You are viewing as <workspace> · Exit”.
- Every **write** path checks `session.impersonating_org_id` and refuses with a clear
  error; only reads are allowed. Audit rows: `impersonation.started`, `impersonation.ended`.
- No password/session swap: the admin keeps their own identity, the app just widens
  their read scope. That is why it can be read-only safely.

---

## 4. Files that will change (1-line reason each)

### Phase 1 — super-admin identity
- `src/lib/auth.ts` — `requireSuperAdmin()` must `notFound()` instead of redirecting; add `isSuperAdmin(user)`.
- `src/lib/session.ts` — export a typed `is_super_admin` view + helper for owner checks.
- `e2e/app.spec.ts` — **replace** the “/admin redirects” assertion with “/admin → 404” (equivalent, per your rule 3).
- `e2e/admin.spec.ts` — **new**: non-admin → 404; `ADMIN_EMAIL` user → 200.
- `playwright.config.ts` — pass a test `ADMIN_EMAIL` so an admin can be created in e2e.
- `.env.example` — document that a missing `ADMIN_EMAIL` means “no admin exists” (404 everywhere under `/admin`).

### Phase 2 — email
- `src/lib/email.ts` — read `RESEND_FROM_EMAIL` first, fall back to `EMAIL_FROM`, then a neutral default; expose `emailFromAddress()`.
- `src/lib/email-outbox.ts` + migration 010 table `email_outbox` — persist what could not be sent (your prompt requires “never silently fail”; today it fails loudly but forgets).
- `src/lib/actions/{auth,account,invites,ai}.ts` — write to the outbox when `not_configured`, so a reset link is recoverable after the key is added.
- `tests/email.test.ts` — new: `configured=false` without key; `from` uses `RESEND_FROM_EMAIL`; outbox row created on not-configured.
- `.env.example` — add `RESEND_FROM_EMAIL` (name only).

### Phase 3 — platform payments
- `sql/migrations/010_platform_settings_and_claims.up.sql` / `.down.sql` — the three tables above.
- `sql/schema.sqlite.sql` — regenerated snapshot (`npm run db:schema`).
- `src/lib/platform-payments.ts` — pure helpers (validation, PKR amounts, founding-member price resolution).
- `src/lib/actions/platform-payments.ts` — `savePlatformSettingsAction`, `submitPlatformPaymentClaimAction`, `reviewPlatformClaimAction` (super-admin only).
- `src/lib/payments/approve.ts` — extend with `activatePlanForClaim` reuse (no duplicated activation logic).
- `src/app/admin/platform-payments/page.tsx` — owner fills numbers here (your answer #4).
- `src/app/admin/payments/page.tsx` — claim queue with approve/reject.
- `src/app/billing/page.tsx` — show **platform** numbers + submit claim (replacing the dead Stripe CTA, honestly labelled).
- `src/components/billing/platform-payment-forms.tsx` — client forms.
- `tests/platform-payments.test.ts` — new: settings come from `platform_settings`, not workspace config; founding-member price resolution; approval activates the plan once.
- `e2e/app.spec.ts` — two new journeys (see §6).

### Phase 4 — owner unlimited
- `src/lib/plans.ts` — `isPlatformOwnerOrg()` bypass in the five `check*Limit` functions.
- `tests/plans-owner.test.ts` — new: owner org returns `Infinity` on Starter; regular org unchanged.
- `src/app/admin/page.tsx` — “platform owner” badge.

### Phase 5 — grant/revoke + impersonation
- `src/app/admin/workspaces/page.tsx`, `src/app/admin/workspaces/[id]/page.tsx`, `src/app/admin/users/page.tsx` — new pages (today only `/admin`).
- `src/lib/actions/admin.ts` — add `reason` to suspend/plan changes; add `suspendUserAction`, `unsuspendOrganizationAction`.
- `src/app/api/admin/impersonate/route.ts` (or a server action) + `src/components/impersonation-banner.tsx`.
- `src/lib/authz.ts` / write actions — refuse writes while impersonating.
- `e2e/admin.spec.ts` — suspend → login blocked; unsuspend → restored; audit row carries the reason; impersonation banner + write refusal.

### Phase 6 — deployment
- `DEPLOY-ADMIN.md` — new: exact env vars, pooler URL format, verification checklist.

### Docs (every phase)
- `PROJECT-REPORT.md`, `CHANGELOG.md` (new), `PROJECT_STATUS.md`, `docs/DATABASE.md`, `.env.example`.

---

## 5. Blockers and open questions

### BLOCKERS (I cannot finish the phases without these)
1. **`RESEND_API_KEY` in Vercel** — you said you will add it. Until then Phase 2 is code-complete but the “real send” step stays unverified.
2. **Resend from-address + is the domain verified?** — needed for `RESEND_FROM_EMAIL`.
3. **Supabase Session-pooler `DATABASE_URL`** — without it there is no deploy, so Phase 6 cannot be executed by me (I can only write the checklist).
4. **Vercel plan (Hobby/Pro)** — Hobby forbids commercial use; charging customers on Hobby is a policy violation.
5. **Super-admin display name** — needed for audit/UI; suggested “Shahab Khan”.

### QUESTIONS
1. **Founding Member scope:** Rs 1,500 locks the **Starter limits** (100 leads, 1 member)? Or should Founding Members get **Professional limits** at the Rs 1,500 price? (Creates goodwill but costs margin.)
2. **Founding Member eligibility:** should the app *automatically* grant it to the first 10 approved claims, or should **you** grant it per workspace from `/admin/workspaces/[id]`? (Automatic is simpler; manual is safer against abuse — e.g. a test signup taking slot 1.)
3. **Approving your own platform claim:** you are both platform owner and the workspace owner. Should the app prevent you from approving your own claim (proper separation of duties), or allow it and merely audit it? I recommend *allow + audit*, because at 1-person scale blocking it would lock you out.
4. **`email_outbox`:** your prompt says emails must never silently fail. Today they fail *loudly* (the UI says “not configured”) but are not stored. Do you want the outbox table (extra table + retention question), or is the current loud failure acceptable? I recommend the outbox.
5. **Existing `/billing/local`:** confirm it stays exactly as-is for the customer’s own clients (your prompt’s rule “do not break workspace-level”). I read your answer as **yes, unchanged**.
6. **Impersonation write-block granularity:** should read-only mean “no writes at all”, or “writes allowed but flagged in the audit row”? I recommend **no writes at all** — that is what you chose.

---

## 6. Test plan (baseline preserved, additions only)

| Phase | New tests | Existing tests touched |
| --- | --- | --- |
| 1 | `e2e/admin.spec.ts`: non-admin → **404**; `ADMIN_EMAIL` user → **200** | `e2e/app.spec.ts:298` redirect assertion is **replaced** (behaviour intentionally changes; count unchanged) |
| 2 | `tests/email.test.ts` (3): not-configured result, `RESEND_FROM_EMAIL` used as `from`, outbox row written | none |
| 3 | `tests/platform-payments.test.ts` (8+): settings from DB not workspace, PKR amount rules, founding-member price, approve-once, reject path, super-admin-only guard | none |
| 3 | e2e (2): “customer sees the platform’s SadaPay number, not their own”; “super-admin approves a platform claim → plan activates” | none |
| 4 | `tests/plans-owner.test.ts` (3): owner `Infinity` on Starter, regular org unchanged, owner not blocked on any of the five limits | none |
| 5 | e2e (4): suspend → login blocked; unsuspend → restored; audit carries reason; impersonation banner + write refused | none |

Expected end state: **unit ≥ 221 + ~17 new**, **e2e ≥ 25 + ~8 new**, all green on SQLite **and** Postgres. No test deleted, no test skipped.

---

## 7. What I need from you to start Phase 1

1. Approve this document (or tell me what to change).
2. Answer the 6 questions in §5 (or say “your recommendation” and I will take the one I marked).
3. Give the **display name**.
4. Tell me whether `RESEND_API_KEY` is already in Vercel, and the from-address/domain status (Phase 2 only — Phase 1 can start without it).

**Nothing is committed and nothing is broken:** gates at the moment of writing are the baseline in §2.6 (221 / 10 skipped, 25 + 25 e2e).
