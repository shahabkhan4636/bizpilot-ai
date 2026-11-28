# FINAL HANDOFF SUMMARY — audit pass of 2026-08-09

**This is not a completion claim.** It is an honest statement of what this repository does today, what was
fixed in this pass, what is still missing, and how to check every line of it yourself. Commit `3ceb41e`.
The previous phase report (`PHASE-3-REPORT.md`) is the history; section 9 of it is this pass.

---

## 1. What the project actually is

A multi-tenant SaaS ("BizPilot AI") for small service businesses: leads → customers → proposals →
automations → documents → analytics, with plans/billing, roles, invitations, an audit log and a public
client portal. Next.js 15 (App Router, TypeScript strict), PostgreSQL 17 in production with SQLite as a
local fallback, no external UI or chart libraries, no ORM.

Every number on every page is read from the database. There is no seeded demo data in a real workspace,
no hardcoded chart, no placeholder metric, and no "success" toast for an operation that did not happen.

### Genuinely wired and verified end-to-end (executed in this pass)

| Capability | Proof |
| --- | --- |
| Signup → onboarding → dashboard, login, logout, password reset | Playwright journeys on SQLite **and** Postgres |
| Leads: create, search, filter, sort, paginate, notes, rule-based AI score, delete, CSV export, CSV import | Playwright + `tests/unit.test.ts`, `tests/hardening.test.ts` |
| **Lead → customer conversion** (wired in this pass, idempotent) | `e2e` "converts to a customer exactly once" |
| Proposals: create, line items, tax/discount maths, PDF, share link, client accept/**decline with reason**, version history | Playwright + `tests/unit.test.ts` + migration 007 |
| **Document upload → download** (download route added in this pass) | `e2e` "downloaded back byte-for-byte", 404 for a foreign workspace, 401 signed out |
| Automations: builder, conditions, multi-step runs, approvals queue, scheduled triggers + overdue follow-ups via `/api/cron/automations` | `tests/scheduler.test.ts`, `tests/cron.test.ts`, Playwright |
| Roles/permissions (owner/admin/manager/member/viewer), invitation flow, read-only enforcement server-side | `tests/rbac-notifications.test.ts`, Playwright |
| Tenant isolation in the query layer + Postgres RLS (83 policies) | `tests/rls.postgres.test.ts`, `tests/rls.live.test.ts`, Playwright tenant journey |
| Public lead capture API with rate limiting, plan limits, timing-safe key check | `tests/webhook.test.ts` (19 cases) |
| Notifications, activity log, audit log | `tests/rbac-notifications.test.ts`, Playwright |
| Readiness/liveness probes, backup/restore/verify scripts | `npm run verify`, `/api/readiness`, `db:backup`/`db:restore` |
| Migrations 001–007 on SQLite **and** both Postgres databases, forward and backward | executed in this pass |

### Real but not provable here — no credentials on this machine (BLOCKED)

| Integration | State of the code | What is missing |
| --- | --- | --- |
| Stripe (checkout, portal, webhooks, invoices) | full implementation, signature-verified webhook, 13 tests against a local HTTP double | a live/test `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and four price IDs |
| Resend (transactional email) | real client, honest "not configured" state, approval-gated sends | `RESEND_API_KEY` + a verified sending domain |
| AI generation (drafts, scoring, summaries) | OpenAI-compatible client, retries only on retryable errors, unpriced-cost honesty, token accounting | `AI_API_KEY` (+ price env vars if you want cost shown) |
| Dropbox (per-workspace OAuth + upload/download) | OAuth start/callback, HMAC-signed state, refresh, upload, **download (new)**, disconnect (new) | `DROPBOX_APP_KEY`/`DROPBOX_APP_SECRET`; without them the UI says so and files stay local |
| Scheduled automations in production | endpoint + secret check + dry-run + idempotent claiming | a scheduler (Vercel Cron in `vercel.json`) and `CRON_SECRET` |
| Deployment | builds and runs locally and in the test harness | Vercel/production `DATABASE_URL`; **nothing has been deployed** |

Nothing in the table above is mocked in the codebase: the code paths are real and are exercised against
local HTTP doubles, but "tested against a double" is not "proven against the vendor".

---

## 2. What was fixed in this pass (16 defects, each reproduced first)

Full detail with evidence: `PHASE-3-REPORT.md` §9.1. Summary:

1. CSV **formula injection** on export (`=HYPERLINK(...)` executed in Excel) — neutralised.
2. Excel CSVs imported with a **BOM-broken header** — BOM stripped, header matching restored.
3. `money()` accepted `0x10` → $16.00 and `1e3` → $1,000.00 — now a strict decimal shape.
4. **Documents could not be downloaded at all** — new scoped, audited download route + UI.
5. **Proposal acceptance raced** and the signatory was never stored — conditional update + migration 007.
6. **Declines recorded nothing** and fired no automation — reason stored, `proposal.rejected` trigger added.
7. **"Convert lead to customer" was unreachable** (an action nothing called) — wired, idempotent, fires `customer.created`.
8. **Dropbox could be connected but never disconnected** — new action + button.
9. **Rate limiter was read-then-write** (concurrent bursts exceeded the limit) — one atomic upsert, both engines.
10. **Auth ceilings were hardcoded** — env-configurable, invalid values fall back to safe defaults.
11. **`/api/readiness` counted a table, not migrations**, and never noticed a stale schema — fixed, plus column probes.
12. **Lead capture trusted client size, compared its key with `!==`, accepted arrays** — 64 KB cap, constant-time compare, JSON-object check.
13. **Uploads trusted `file.type`** and used the raw filename as a Dropbox path — extension-derived type, sanitised single segment.
14. **`?page=` was unbounded** — clamped to the real page count.
15. **`scripts/migrate.mjs` dumped a `SqliteError`** on an existing database — now refuses with the correct commands.
16. **Seven dead exports** (`newSessionId`, `formatDateTime`, `initials`, `htmlEscape`, `defaultProvider`, `assertCanEditOwned`, `requireAdmin`) — removed.

---

## 3. Verification you can re-run (exact commands, real numbers)

```bash
cd bizpilot
npx tsc --noEmit                       # clean, strict
npx eslint .                           # 0 errors, 0 warnings
npx vitest run                         # 175 passed, 10 skipped (13 files)
node scripts/build-schema.mjs --check   # schema snapshot matches 7 migrations
npm run db:migrate                      # apply pending; also seeds the plan catalogue
npm run verify                          # typecheck + lint + unit + schema + build → "all gates green"
npx playwright test                     # 23 passed (SQLite)
DATABASE_URL="postgres://…" BIZPILOT_ENGINE=postgres npx playwright test   # 23 passed (Postgres)
```

Both e2e runs were executed against a **production build** (`next build && next start`), not dev mode.

---

## 4. Remaining limitations — no sugarcoating

- **Not deployed.** No Vercel/production `DATABASE_URL` was available, so every "in production" claim is
  inference from a local production build.
- **No live vendor integration was ever exercised** (Stripe, Resend, AI, Dropbox). Their failure modes are
  covered by doubles and by explicit "not configured" states in the UI, which report the exact env var needed.
- **The rate limiter is a database table**, correct for one instance; behind several instances it needs a
  shared store (Redis/Upstash) or it will under-count. The API is written so the store can be swapped.
- **PDF text is WinAnsi**: characters outside Latin-1 (emoji, CJK, some currency glyphs) render as `?`. The
  file is a valid PDF; embedding a Unicode font is the fix and is not done.
- **Local file storage is single-node** (`data/uploads`). Multi-instance deployments must use Dropbox or a
  shared volume; there is no S3 backend.
- **No CI pipeline is committed** (no GitHub Actions workflow). `npm run verify` is the whole gate and is
  meant to be wired into CI as one step.
- **`schema_migrations` has no checksum verification against the generated snapshot** in the `snapshot`
  case, by design (documented in `docs/DATABASE.md`).
- **The Dropbox disconnect button is wired but not clicked by an automated test** — creating a real
  workspace credential requires OAuth credentials that do not exist here. It is the same tested
  `deleteCredential` call plus an audit entry.
- **Backups are not scheduled anywhere.** `npm run db:backup` works; something has to call it.

---

## 5. File / component map (where to look)

```
src/app/                        routes (pages + API). Notable:
  api/documents/[id]/download   secure, workspace-scoped file download   ← new in this pass
  api/leads/capture             public lead intake (size-capped, constant-time key)
  api/cron/automations          scheduler entry point (Bearer CRON_SECRET, ?dryRun=1)
  api/readiness                 schema + provider truth
  p/[token]                     public client portal (accept / decline)
src/lib/
  db.ts                         one query surface for SQLite and Postgres
  pg-sync.ts                    `?` → `$n` rewrite with placeholder/parameter assertion
  auth.ts, authz.ts, permissions.ts, session.ts, ratelimit.ts, crypto.ts
  validate.ts                   str / email / int / money / oneOf (money is strict now)
  csv.ts                        toCsv (formula-safe), parseCsv (BOM-safe), mapImportRows
  pdf.ts                        minimal PDF writer (WinAnsi)
  storage.ts                    local + Dropbox upload/download, sanitizeFileName
  integrations.ts               Dropbox OAuth: state signing, exchange, refresh, credentials
  scheduler.ts, automations.ts, automation-meta.ts   trigger catalogue is the source of truth
  plans.ts, proposal-math.ts, notifications.ts, audit.ts, logger.ts
  actions/*.ts                  server actions = the security boundary
sql/migrations/001…007          the only schema path; sql/schema.sqlite.sql is generated
tests/ (13 files)               unit + integration; tests/hardening.test.ts is this pass
e2e/app.spec.ts                 23 journeys, run on both engines
scripts/                        db-migrate, migrate (bootstrap, refuses on non-empty), build-schema,
                                backup, restore, verify, seed, test-postgres
PHASE-3-REPORT.md §9            this pass, with evidence
PROJECT_STATUS.md               current gate table and decisions
```

## 6. How to run it

```bash
cp .env.example .env        # everything is optional except NEXT_PUBLIC_APP_URL for share links
npm install
npm run db:migrate          # create/migrate the SQLite database and seed the plans
npm run seed                # create the first account interactively
npm run dev                 # http://localhost:3000
```
Postgres instead: set `DATABASE_URL` (+ `BIZPILOT_ENGINE=postgres`), `npm run db:migrate`, `npm run db:seed:pg`.
Check the deployment's honesty at any time: `curl -s localhost:3000/api/readiness | jq`.

---

## Newest round (gateway + refunds + CI)

- **Migration 009** `009_payment_gateway_and_refunds` — applied to SQLite (dev + e2e), both
  local Postgres databases, and Supabase production (`32 tables`, migration rows 001–004,
  006–009; 005 deliberately skipped).
- **`src/lib/payments/`** — `provider.ts` (pure helpers), `sadapay.ts`, `jazzcash.ts`,
  `easypaisa.ts` (signature verification), `registry.ts` (which provider is live),
  `approve.ts` (the single approval path shared by the button and the webhook).
- **`POST /api/payments/webhook/<provider>`** — 404 unknown / 503 unconfigured / 401 bad
  signature / 413 oversized; `webhook_events` idempotency; amount mismatch never approves;
  ambiguous transfer note never guesses.
- **Refunds** — `payment_refunds` + `refundLocalPaymentAction` + UI; full refund cancels access.
- **Transfer-note fix** — `paymentReference` now `BP-<slug8>-<digest4>`; truncation alone let
  two workspaces share a note (money matched to the wrong one). Ambiguity is refused.
- **CI** — `.github/workflows/verify.yml`, `.github/workflows/backup.yml`.
- **Gates at this commit:** `npm run verify` green · `npx vitest run` **221 passed / 10 skipped**
  · Playwright **25/25 SQLite** and **25/25 PostgreSQL**.
- **Still blocked (needs you):** Supabase Session-pooler `DATABASE_URL`, GitHub connection for the
  Vercel deploy, Vercel Pro (commercial use + sub-daily cron), and merchant accounts for live
  gateway verification (SadaBiz / JazzCash merchant / Easypaisa store / Safepay).
