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
| Security headers | `next.config.ts` | HSTS, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy |
| CSP with a nonce | `src/middleware.ts` | per-request nonce + `'strict-dynamic'`; **no `'unsafe-inline'` for scripts** |
| Request id | `src/middleware.ts` | correlates a user-visible error digest with its server log line |

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

## 3b. CSP hardening (after the first pass)

The first pass shipped `script-src 'self' 'unsafe-inline'`, which is only marginally better than no
CSP. It is now a nonce policy issued per request by `src/middleware.ts`:

```
script-src 'self' 'nonce-<per request>' 'strict-dynamic'; style-src 'self' 'unsafe-inline'
```

Three things had to be fixed to make that true rather than nominal:

1. **Static pages carried scripts without the nonce.** `/`, `/pricing`, `/login` were prerendered, and
   a cached page cannot hold a fresh nonce. The root layout now reads the request nonce from
   `headers()`, which opts every route into dynamic rendering — the documented cost of a nonce
   policy, and the reason the policy is uniform instead of allowlisting routes.
2. **The theme bootstrap was inline without a nonce** and would have been blocked, causing a flash of
   the wrong theme on every first paint. It moved from a client component into the root layout so it
   can carry the nonce, with the script body living in `src/lib/theme.ts`.
3. **A serial-suite landmine:** the e2e file deleted the SQLite database at import time, while the
   web server that Playwright had already started held it open. That leaves the tests reading a
   fresh, empty file ("no such table: organization_members"). Tests now truncate in place.

Verified: `/`, `/pricing`, `/login`, `/signup`, `/p/[token]`, `/forgot-password` all render with
**0 scripts missing a nonce**, client-side navigation across six routes works, the theme toggle
flips `documentElement`, and the browser reports **no CSP violations** (asserted in the e2e suite).

## 4. Verification executed (real, not asserted)

```
npx tsc --noEmit                 clean (0 errors, strict)
npx eslint .                     0 errors, 0 warnings
npx vitest run                   100 passed | 10 skipped (6 files)
npx playwright test (postgres)   19 passed
npx playwright test (sqlite)     19 passed
npm run verify                   all gates green in one command
```

Live checks against `next start`:

```
GET /login       → 200 + nonce CSP, HSTS, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy
GET /login       → every <script> carries the request nonce (0 without it)
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

## 7. Second verification pass — what re-running the blocked items found

The provider integrations (Stripe, Resend, AI, Dropbox) were marked BLOCKED for want of credentials.
They cannot be *live*-verified here, but the client contracts can be verified against a real HTTP
double, and doing that meant first making the endpoints configurable
(`EMAIL_API_URL`, `DROPBOX_CONTENT_URL`, `AI_BASE_URL`, all documented in `.env.example`).

`tests/providers.test.ts` — 15 cases against a real local HTTP server, not a mocked `fetch`:

| Case | Expected behaviour | Result |
| --- | --- | --- |
| AI 200 with `usage` | model, provider and the provider's own token counts returned | ✅ |
| AI 500 then 200 | retried, second attempt wins | ✅ |
| AI 429 twice | `rate_limited` after exactly `AI_MAX_ATTEMPTS` | ✅ |
| AI 401 | **not** retried, message keeps `401` + provider text | ✅ |
| AI empty content | `empty`, never success | ✅ |
| AI non-JSON body | `provider_error` | ✅ |
| AI no key | `not_configured`, zero network calls | ✅ |
| AI score `187` | clamped to 100, `method: "ai"` | ✅ |
| AI prose instead of JSON | falls back to the rule-based score | ✅ |
| Email 200 | provider message id returned | ✅ |
| Email 422 | `provider_error` with status + reason — never a false "sent" | ✅ |
| Email no key | `not_configured`, zero network calls | ✅ |
| Email transport failure | `provider_error`, never throws | ✅ |
| Dropbox 200 | stored path returned | ✅ |
| Dropbox 409 | provider error surfaced, not swallowed | ✅ |

Two features the master prompt asks for were genuinely missing and are now implemented:

- **Retries with backoff** (`AI_MAX_ATTEMPTS`, `AI_RETRY_BASE_MS`, `Retry-After` honoured), retrying
  only 429/5xx — a 4xx is a misconfiguration and is returned immediately.
- **Token + cost tracking** (`src/lib/ai-usage.ts`): tokens come from the provider's `usage` object,
  cost from `AI_PRICE_INPUT_PER_MTOK` / `AI_PRICE_OUTPUT_PER_MTOK`, surfaced on the AI page and
  aggregated per model per month. When prices are unset the cost is reported as "not priced", never
  as a confident $0.00, and `/api/readiness` warns about it.

### The bug this pass really found

Running the **from-scratch** path (`create database` → `npm run db:migrate`) produced
**0 RLS policies**: the 83 policies lived only in `sql/rls.postgres.sql`, applied by the docker/pg
helper scripts, so any deployment built by following the docs would have had *no row-level
security* while every existing dev database looked fine. Fixed by making RLS migration **005**,
generated from that same file with `--check` drift detection, plus a `.down` that drops every policy
and a documented SQLite no-op. Verified: fresh DB → 28 tables, 26 RLS tables, 83 policies, 5
migrations; `--down 1` → 0 policies; re-`up` → 83 again; an already-policy'd database accepts 005
idempotently.

Three more defects surfaced by the same run:

1. **`npm run db:migrate` left the plan catalogue empty** → the first signup failed with
   `FOREIGN KEY constraint failed` because `subscriptions.plan_code` references `plans(code)`. The
   runner now applies the idempotent plan seed and prints the count; CI asserts `plans >= 4`.
2. **The snapshot baseline recorded only one migration.** `recordMigrationsAsApplied` asked "does the
   table have any row?" *inside* the insert loop, so migration 001 was written and 002–005 were
   skipped, leaving every other migration permanently "pending".
3. **Baselined databases reported phantom drift** (`checksum snapshot → …`). The `snapshot` sentinel
   is now treated as "no per-file checksum", not as edited history.

Finally, `tests/ai-usage.test.ts` (5 cases) pins the accounting: pricing maths, unpriced-is-not-zero,
per-model totals, and that one workspace can never read another's spend.

## 8. Third pass — the two features that were documented but not built

Re-reading the master prompt against the code (not against my notes) turned up two things that
existed on paper only:

### a) Scheduled triggers — missing entirely

Every trigger was an *event*; nothing could fire on a clock, and the advertised
`followup.overdue` trigger was in the builder's dropdown but **never dispatched by anything**. A user
could create that automation and wait forever.

Implemented (`src/lib/scheduler.ts`, `GET|POST /api/cron/automations`, `vercel.json` cron at
`*/10 * * * *`):

- new `schedule.tick` trigger with a per-automation interval (5 min … 30 days), set in the builder;
- the scheduler claims each due automation with a conditional `update … where next_run_at = ?`, so two
  overlapping runs cannot both fire it, and advances `next_run_at` in the same statement;
- `followup.overdue` now genuinely fires: leads past `next_follow_up_at`, not `won`/`lost`, with the
  due *date* as the dedupe suffix — so a lead that stays overdue nudges once, not on every tick;
- the route is authenticated with `CRON_SECRET` and **returns 503 rather than running
  unauthenticated**, because it can send email and call AI for every workspace; `?dryRun=1` reports
  without changing anything;
- the automations page shows the next scheduled run, the overdue count, and warns when `CRON_SECRET`
  is missing instead of silently doing nothing.

Tests: `tests/scheduler.test.ts` (9) + `tests/cron.test.ts` (5) — fires once per window, fires again
in the next window, paused automations do not fire, dry run writes nothing, the daily run limit
applies, overdue de-duplicates per due date, closed leads are ignored, one workspace's tick never
touches another's leads, 503/401/200 on the route, and `x-cron-secret` accepted.

### b) Dropbox OAuth — a dead documented path

The README told you to add the redirect URI `/api/integrations/dropbox/callback` and exchange a code
yourself; that route did not exist, and storage used one global `DROPBOX_ACCESS_TOKEN`, meaning every
customer's files landed in one Dropbox account.

Implemented:

- `src/lib/integrations.ts` — HMAC-signed, 10-minute `state`; code exchange with a refresh token;
  `dropboxAccessTokenFor(orgId)` that refreshes when the token is about to expire; per-workspace
  credential storage in the new `integration_credentials` table (migration 006);
- `/api/integrations/dropbox/start` and `/callback` — both require a session and
  `settings:workspace`, reject a state signed for a different workspace/user, and put the real reason
  in the redirect (`exchange_failed&reason=…`) instead of a generic error;
- uploads now prefer the workspace's own connection, fall back to the deployment token, and finally to
  local disk; the documents page says which is active and shows a **Connect Dropbox** button only to
  owners/admins when the app keys exist.

Tests: `tests/integrations.test.ts` (13) against a real HTTP double — state round trip, tampered state
rejected, expiry, authorize URL asks for `offline`, exchange success/failure/not-configured,
per-workspace isolation, reconnect updates instead of duplicating, expired-token refresh, disconnect.

### Also fixed here

The e2e suite's last test failed on its 21st login: login is rate limited to 20 per 10 minutes **by
design**, so the test now signs up its own user instead of leaning on the limiter's budget.

## 9. Hostile-input audit pass (2026-08-09, after `32601ac`)

The instruction was to stop claiming the project is finished and stress it instead. Every item below was
reproduced with an executed probe **before** being changed, and re-run afterwards. No item is a
"would be nice": each one is a behaviour that was wrong, missing or misleading.

### 9.1 Bugs found by probing, and fixed

| # | What was wrong | How it was proved | Fix |
| --- | --- | --- | --- |
| 1 | **CSV formula injection.** `toCsv` escaped delimiters but not leading `= + - @ TAB CR`, so a lead named `=HYPERLINK("http://evil","click")` executed when the customer opened `/api/leads/export` in Excel/Sheets | probe printed the raw payload, unquoted, in the export | `escapeCsvField` prefixes such values with `'` and quotes them; regression tests cover all five characters |
| 2 | **Excel CSVs imported with broken headers.** A UTF-8 BOM made the first header `"\ufeffname"`, so header matching silently failed and the importer fell back to positional guessing | probe: `parseCsv("\uFEFFname,email…")` → `"\ufeffname"` | BOM stripped in `parseCsv` *and* defensively per header in `mapImportRows` |
| 3 | **`money()` accepted hex and scientific notation** — `"0x10"` became $16.00, `"1e3"` became $1,000.00 | probe printed `1600` and `100000` | shape check `^\d+(\.\d+)?$` after removing `$`, `,`, spaces; hex/exponent/junk now raise `ValidationError` |
| 4 | **Documents could be uploaded and listed but never opened.** There was no download route at all; the file was unreachable | `grep` for any route under `documents` returned only the page; the table had a Delete button and nothing else | `GET /api/documents/[id]/download` — session + `document:read` + workspace-scoped lookup (another tenant's id is 404, not 403), `Content-Disposition` attachment with RFC 5987 filename, `nosniff`, `no-store`, audited, 409 when the Dropbox link is gone, 410 when the local file is missing |
| 5 | **Proposal acceptance was racy and the signatory was lost.** Two submits both "succeeded"; the client's name existed only in the activity log, never on the row | code read + the accept update had no status guard | conditional update (`where status in ('sent','draft','expired')`); second attempt returns a notice. Migration `007` adds `accepted_by_name` / `rejected_reason`, both now shown in the UI |
| 6 | **Declines were a dead end.** The reason was not stored and no `proposal.rejected` trigger existed, so "client said no → create a follow-up" was impossible | trigger catalogue lacked the event; reason only in a log line | `proposal.rejected` added to `TRIGGERS`, decline persists the reason, notifies and dispatches the trigger |
| 7 | **"Convert lead to customer" existed as a server action nothing called** — the CRM flow was unreachable from the UI, and a double submit would have created two customers | dead-export sweep; the action had no `customer_id` guard | wired to the lead detail page (`Convert to customer` → `View customer`), made idempotent, fires `customer.created`, revalidates |
| 8 | **Connecting Dropbox was possible, disconnecting was not** — `deleteCredential` was only reachable from tests | dead-export sweep | `disconnectDropboxAction` (owner/admin only, audited) plus a Disconnect button and an explanatory note on `/documents` |
| 9 | **The rate limiter was read-then-write**, so a concurrent burst could pass more requests than the limit — the exact case a login limiter exists for | code read of `rateLimit()`; no transaction between the count read and the increment | single atomic `insert … on conflict do update … returning`; one statement, correct on SQLite *and* Postgres (verified by running the e2e suite on both engines) |
| 10 | **Auth ceilings were hardcoded**, so an office behind one NAT address could not raise them without a code change | probe: the 11th signup in the e2e run was refused by the app, not by the test | `LOGIN_RATE_LIMIT`, `LOGIN_RATE_WINDOW_SECONDS`, `SIGNUP_RATE_LIMIT`, `SIGNUP_RATE_WINDOW_SECONDS`; invalid values fall back to the documented defaults instead of disabling the control |
| 11 | **`/api/readiness` reported "1 applied" on a 7-migration SQLite database** — it counted the existence of the `schema_migrations` *table* | probe against the real route | counts rows, and additionally probes for the newest columns (`automations.schedule_interval_minutes`, `integration_credentials.provider`, `proposals.accepted_by_name`) so a half-migrated database fails the probe instead of throwing `no such column` at a customer |
| 12 | **The lead capture endpoint trusted clients for size, compared the shared key with `!==`**, and coerced any JSON into an object (an array or `null` became one field named `0`) | probe: `[1,2,3]` and `null` produced a lead-shaped payload; no size ceiling existed | 64 KB ceiling enforced on the bytes *and* the declared length (413), constant-time `secureCompare` on SHA-256 digests, non-object JSON rejected with 400, empty key rejected without comparing it |
| 13 | **Upload type checking trusted `file.type`**, which a client can leave empty to skip the allowlist entirely; the Dropbox path used the raw client filename, so `../..` could write outside the workspace folder | code read of `uploadDocumentAction` | type derived from the extension allowlist (the declared MIME is only cross-checked), single-segment `sanitizeFileName` used for local storage *and* the Dropbox path |
| 14 | **`?page=` was unbounded** — a hand-edited URL asked for a deep offset and left the user on "Page 999 of 3" with no way back | code read | page clamped to the real page count, absolute ceiling 10,000 |
| 15 | **`scripts/migrate.mjs` died with a raw `SqliteError: duplicate column name`** when run against an existing database | ran it against `data/bizpilot.db` | detects an existing schema and refuses with the two correct commands (`db:migrate`, `db:migrate:status`), exit 1 |
| 16 | **Dead code**: `newSessionId`, `formatDateTime`, `initials`, `htmlEscape`, `defaultProvider`, `assertCanEditOwned`, `requireAdmin` | sweep for exports referenced nowhere in `src/`, `tests/`, `e2e/` or `scripts/` | deleted; lint is clean |

Confirmed **not** bugs, after checking the code rather than assuming: `parseCsv` returning `string[][]`
is by design (mapping happens in `mapImportRows`); `str("  ")` returning `""` is correct (it trims, and
the field was not `required`); `money("")` returning `0` matches the "blank optional amount" form
contract; `renderPdf` turning non-Latin-1 text into `?` is documented WinAnsi behaviour — the output is
a valid PDF, so the limitation is stated in the docs instead of "fixed" into broken bytes.

### 9.2 Tests added in this pass

| File | Tests | What they pin down |
| --- | --- | --- |
| `tests/hardening.test.ts` | 23 | CSV formula neutralisation, BOM/CRLF/quoted-newline import, strict `money`, PDF escaping and degradation, upload-path containment, rate-limiter accounting (incl. burst), env-configurable limits with safe fallback, readiness schema probe |
| `tests/webhook.test.ts` (+5) | 19 total | oversized body → 413 even with a lying `content-length`, non-object JSON → 400, missing key → 401, key prefixes rejected |
| `e2e/app.spec.ts` (+3) | 23 total | document download round-trips byte-for-byte with a unicode name; another workspace gets 404 and a signed-out visitor 401; a proposal cannot be double-accepted and a decline stores its reason; a lead converts to a customer exactly once |

### 9.3 Executed verification for this pass

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` | clean |
| `npx eslint .` | 0 errors, 0 warnings |
| `npx vitest run` | **175 passed, 10 skipped** (13 files) |
| `node scripts/build-schema.mjs --check` | matches 7 migrations; RLS file in sync |
| `npm run db:migrate` (SQLite, then both Postgres databases) | 007 applied · 7 total on each |
| `node scripts/migrate.mjs` on an existing DB / on a fresh file | refuses with guidance (exit 1) / bootstraps (exit 0) |
| `npm run verify` | typecheck, lint, unit, schema, build — all green |
| `npx playwright test` | **23/23 on SQLite** |
| `DATABASE_URL=… BIZPILOT_ENGINE=postgres npx playwright test` | **23/23 on PostgreSQL** |

### 9.4 Still not verified (no credentials on this machine)

Live Stripe charges, Resend delivery, real AI generation, a real Dropbox OAuth round-trip, and a Vercel
deployment remain **BLOCKED**, exactly as listed in `PROJECT_STATUS.md`. Their code paths are exercised
against local HTTP doubles and by the tests above, but "tested against a double" is not "proven in
production" and this report does not claim otherwise.
