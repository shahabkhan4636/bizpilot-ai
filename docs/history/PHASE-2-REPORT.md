# BizPilot AI — Phase 2 report

**Date:** 9 August 2026 · **Scope:** the four items you picked ("all 4") plus a defect hunt with every fix verified by
executing it.

---

## 1. What was done in this phase

| # | Item you asked for | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Postgres / Supabase RLS adapter | **Half: policies proven on a real Postgres engine; driver not wired** | `tests/rls.postgres.test.ts` — 12 assertions executed on PGlite (real Postgres) |
| 2 | GitHub + deploy with env wiring | **Repo published; Vercel deploy prepared but not executed** | <https://github.com/shahabkhan4636/bizpilot-ai> |
| 3a | Billing invoice list | **Done** | Invoice rows built from verified `invoice.*` webhook payloads |
| 3b | Email team invites | **Done** | `org_invites`, `/invite/<token>`, seat limits, single-use tokens |
| 3c | Richer automation builder | **Done** | Conditions + ordered steps with per-action fields and live preview |
| 3d | (found while testing) Approval UI | **Done** — this was a real dead end, see §3 | New `/approvals` page with approve/reject |
| 4 | Run the app live | **Done** | Production server on `0.0.0.0:3000`, demo data seeded, all pages fetched over real HTTP |

---

## 2. Item 1 — Row Level Security, proven on a real Postgres engine

`tests/rls.postgres.test.ts` (12 tests, all passing) applies `sql/schema.postgres.sql` to a **real PostgreSQL engine**
(PGlite, running in-process) and then *executes* the policies:

* `auth` shim (`sql/local-postgres-shim.sql`) creates `auth.users`, `auth.uid()` and `auth.role()` so the Supabase
  schema runs unchanged outside Supabase.
* Every assertion runs as a **non-owner role** (`app_user`), because a table owner silently bypasses RLS — the usual
  way RLS suites pass while proving nothing.
* Asserted: cross-tenant `select` returns zero rows (leads, customers, proposals, documents, messages, orgs); every
  cross-tenant `insert` is rejected by a `with check` policy; a workspace owner sees their own rows; `is_super_admin()`
  sees all workspaces; `plans` is readable but not writable by normal users; the new `org_invites` policies behave the
  same way.

**What is still missing (deliberately, honestly):** the *driver*. `src/lib/db.ts` is `better-sqlite3` (synchronous, 304
call sites), and a Postgres driver is asynchronous. Swapping it means awaiting every call site plus dialect fixes
(`count(*)` returns `bigint`, booleans, `::int` casts) — a multi-hour refactor that would risk the working app if rushed.
The README (section 7) lists the three exact steps. **Until then, tenant isolation in the running app comes from
`organization_id` on every query, not from RLS.** The policies themselves are no longer "unverified".

---

## 3. Defects found and fixed in this phase

Each of these was reproduced first, then fixed, then covered by a test.

1. **Queued emails had no way to be approved.** Automations wrote `messages` rows with `status = 'pending_approval'`,
   and no page anywhere listed them — the approval gate was enforced but unreachable, so the email could never be sent.
   *Fixed:* new `/approvals` page (+ nav entry) listing every queued message with recipient, body, approve/reject.
   *Tested:* the Playwright suite builds an automation with an email step, fires it with a real lead, and asserts the
   message appears in `/approvals`.
2. **Approving without the checkbox returned a silent no-op.** Now it returns an explicit refusal, asserted in the same
   test.
3. **"Sent" could be reported when nothing was sent.** With no `RESEND_API_KEY`, approval now stores
   `approved_unsent` and the page carries a persistent banner ("1 approved message not delivered") instead of a
   transient toast. No false "delivered" state anywhere.
4. **An invite could be created but the pending list never refreshed** — the settings page rendered before the insert.
   *Fixed:* `revalidatePath("/settings")`; the e2e test now asserts the list updates.
5. **An invitation for an existing account could hijack it.** Accepting with only the token and a new password would
   have attached the invite to an attacker. *Fixed:* for an existing profile the accept form demands that account's
   current password. Single-use enforcement proven by reopening the link (test asserts "Already accepted").
6. **New tables never reached existing databases.** `src/lib/db.ts` only applied the schema when `plans` was missing, so
   `org_invites` would not exist on a live database. *Fixed:* the schema is entirely `create … if not exists` and is now
   applied on every boot; verified by migrating a deleted DB and asserting the table exists.
7. **Seat limits were not enforced on invitations.** Now counts members **plus** unaccepted invites against
   `member_limit`, with a message that names the plan and the limit.
8. **Automation builder had no per-action configuration** and read parallel form arrays (fragile). *Fixed:* JSON
   payloads (`conditions_json`, `steps_json`) validated server-side against an allow-list of fields, operators and
   actions; the old parallel-array form still works.
9. **Builder inputs were unlabelled** (no `htmlFor`/`aria-label`) — an accessibility defect, and the reason the e2e test
   could not find them. *Fixed:* every dynamic input got an explicit accessible name.
10. **Billing page claimed a "payment events" log only** — invoices were listed as an unbuilt limitation. *Fixed:* real
    invoice rows parsed from stored, signature-verified payloads, with honest empty states.

---

## 4. Verification (all executed in this session, not asserted)

| Gate | Command | Result |
| --- | --- | --- |
| Types | `npx tsc --noEmit` | clean (0 errors) |
| Lint | `npx eslint .` | clean (0 errors, 0 warnings) |
| Unit / integration / webhook / RLS | `npm test` | **72 passed** (4 files: 27 unit, 19 integration, 14 webhook, 12 Postgres RLS) |
| Production build | `npm run build` | success, **38 routes** |
| Browser e2e (Chromium, production server) | `npx playwright test` | **15 passed** (1.1 min) |
| Live server pages (real HTTP, real session) | `curl` against `0.0.0.0:3000` | 13 routes fetched; all 200 except `/admin` → 307 for a non-super-admin (correct) |
| Super-admin panel | `curl` with an admin session | `/admin` → 200 (77 KB) |
| Lead capture API | `curl POST /api/leads/capture` | `401` without a key, `201` with key + workspace slug |
| Postgres RLS | `npx vitest run tests/rls.postgres.test.ts` | **12 passed** on a real Postgres engine |

New e2e coverage added this phase:

* **invitation flow** — owner invites, the app hands back a real `/invite/<token>` link (no email provider), a clean
  browser context accepts it, creates the account, lands in the workspace, the link is then single-use, and the owner
  sees the member and the seat count.
* **automation builder** — 1 condition + 3 steps built in the UI, saved, fired by creating a real lead, the run is
  recorded, and the queued email waits in `/approvals` (refuses to send without the tick, then reports honestly that
  nothing was sent).
* **billing honesty** — with no Stripe keys the page says so and shows no invented invoice.

---

## 5. Item 2 — GitHub and deployment

* **Repository (live):** <https://github.com/shahabkhan4636/bizpilot-ai> — public, `main`, 118 tracked files, no
  `node_modules` / `.next` / `data` / `.env` committed.
* **Not deployed.** Deploying to Vercel/Netlify today would put the SQLite file on an ephemeral filesystem: the site
  would load and then lose data, which is exactly the "looks deployed but is broken" outcome you told me to avoid.
  A real deploy needs a durable `DATABASE_URL`, i.e. item 1's driver work. The exact commands are in README §12; the
  only thing missing is a Vercel token (not present in this environment) and the Postgres driver.

---

## 6. Live preview

`npx next start -H 0.0.0.0 -p 3000` is running against the seeded development database.

| Account | Email | Password | Notes |
| --- | --- | --- | --- |
| Demo workspace | `demo@bizpilot.local` | `BizPilotDemo123` | Starter trial + labelled sample leads |
| Super admin | `shahabkhanprofessional@gmail.com` | `BizPilotAdmin123` | `/admin` panel access |

Both are development-only credentials on a local database. Change them before any deployment.

---

## 7. Still required to go live (unchanged by this phase)

1. **Postgres driver** (item 1 above) — the only structural gap left.
2. **Third-party credentials**, none of which exist in this sandbox: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
   `STRIPE_PRICE_*`, `AI_API_KEY`, `RESEND_API_KEY` + `EMAIL_FROM`, `DROPBOX_APP_*`, `DATABASE_URL`, `LEAD_CAPTURE_KEY`.
   Every one of these paths is verified against its *missing-credential* behaviour, never against the live service.
3. **Rotate the tokens you pasted earlier.** The GitHub token (`ghp_a5a6…`) and the Netlify token (`nfp_7CWU…`) have
   been used in this workspace and are still valid; revoke them at <https://github.com/settings/tokens> and
   <https://app.netlify.com/user/applications> when you are done with them. The GitHub token is currently embedded in
   this repository's `.git/config` on this machine only (that file is never committed).
