# BizPilot AI

An AI-assisted business operating system for small teams: lead capture → qualification → proposals → follow-ups →
customer records → documents → analytics → automation, in one Next.js application.

Built to be deployed and sold. Every number in the UI is a live database aggregate; there is no seeded dashboard, no
invented customer list and no fabricated social proof anywhere in the marketing pages.

---

## 1. What actually works today

| Area | Status |
| --- | --- |
| Marketing site (home, features, pricing, help, privacy, terms) | Working, prices read from the `plans` table |
| Sign-up, login, logout, password reset, 30-day sessions | Working, scrypt hashes, rate limited |
| Onboarding | Working |
| Dashboard | Live metrics + empty states for new workspaces |
| Leads: create, edit, status, owner, notes, follow-up, search, filter, sort, pagination | Working |
| CSV import (validated per row) and CSV export of the filtered view | Working |
| AI lead scoring | AI when a key is set, transparent rule-based fallback otherwise (labelled) |
| Customers: create, edit, delete, convert from lead, linked proposals/documents | Working |
| AI sales assistant (9 content types, tone/language/objective/pricing, edit, save, regenerate) | Working; requires `AI_API_KEY` for real generation |
| Approval gate before any external send | Enforced server-side; nothing sends without an explicit checkbox |
| `/approvals` queue | Every message an automation or the assistant queues is listed, with approve/reject and an honest "approved, unsent" state |
| Team invitations | Real `org_invites` rows, 7-day single-use tokens, seat limits per plan, email send or link hand-over when no provider is configured |
| Automation builder | Client-side builder: trigger, N conditions, N ordered steps with per-action fields, live pipeline preview, server-side validation |
| Proposals: line items, tax, versions, share link, client accept/decline, PDF | Working |
| Client portal `/p/<token>` | Working, token-scoped |
| Documents upload (10 MB cap, type allow-list) | Local disk by default, Dropbox when tokens are set |
| Automations: 8 triggers, 7 actions, conditions, daily run limit, idempotency, logs, retry, dry-run test | Working |
| Analytics | Live funnel, source, owner and 6-month trend |
| Billing: plan display, usage, invoices from verified webhook payloads, Checkout, portal, cancel | Working; needs Stripe keys |
| Stripe webhooks | Signature verified, deduped, subscription state machine |
| Admin panel (super-admin only): plan editor, workspaces, suspend, audit log, webhook log | Working |
| Public lead capture API `/api/leads/capture` | Working when `LEAD_CAPTURE_KEY` is set |
| Emails | Requires `RESEND_API_KEY`; without it the app says so and stores the message as approved-but-unsent |
| Two engines, one API | **SQLite** by default; **PostgreSQL 17** automatically when `DATABASE_URL` is set. Same queries, same helpers — see section 7 |
| Row level security | migration `005_row_level_security` (generated from `sql/rls.postgres.sql`): 83 policies on all 26 tables, **proven twice** — 12 assertions on PGlite and 10 more on a live PostgreSQL 17 server from a non-owner role |

**Honest limitations you must know before selling this:**

1. Both engines are wired: leave `DATABASE_URL` empty and the app uses a local SQLite file; set it and the app runs
   on PostgreSQL with the same code path (`src/lib/pg-sync.ts` keeps the synchronous query API on top of a worker-owned
   `pg` connection). The full suite — 82 tests and 15 browser tests — has been executed green on **PostgreSQL 17.12**,
   not just on SQLite.
2. The application connects to Postgres with the **table-owner** role, so its own queries bypass RLS, exactly like
   Supabase's service role. The 83 RLS policies are what protects every other connection (an anon key, psql, an
   analytics user); they are asserted from a non-owner role in `tests/rls.live.test.ts`. Keep the app's credentials
   server-side.
3. No payment provider, AI provider, email provider or Dropbox credentials were available while building, so those paths
   were verified against their failure modes (signature rejection, `not_configured` states, unit tests) but **not**
   against the live third-party service. Configure the keys and re-run the checklist in section 9 before charging anyone.
4. There is no queue worker. Automation steps run inline on the request that fired the trigger. That is fine at SMB
   volume; move `dispatchTrigger` to a queue (Inngest, QStash, cron) before high traffic.
5. A synchronous query blocks the Node process for its duration — true on both engines (better-sqlite3 is synchronous
   too). Invisible at SMB volume; for high concurrency, move hot paths to async queries.

---

## 2. Requirements

- Node.js 20 or newer
- npm 10 or newer
- A build toolchain for `better-sqlite3` (prebuilt binaries are downloaded automatically on most platforms)

## 3. Quick start (no credentials needed)

```bash
npm install
cp .env.example .env.local       # optional for local runs; leave keys empty
npm run db:migrate               # creates data/bizpilot.db and seeds the four plans
npm run seed                     # creates one account and prints its password
npm run dev                      # http://localhost:3000
```

`npm run seed` creates **one** account. It does not populate a demo pipeline unless you pass `--demo`:

```bash
npm run seed -- --demo                     # adds three clearly-labelled demo leads
npm run seed -- --email you@x.com --password 'Something123' --name 'Your Name'
```

To get an admin panel, set `ADMIN_EMAIL` in `.env.local` **before** signing up with that address, or run
`ADMIN_EMAIL=you@x.com npm run seed -- --email you@x.com`. The matching account is flagged `is_super_admin`.

## 4. Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` / `npm start` | Production build / serve |
| `npm run typecheck` | `tsc --noEmit` (strict) |
| `npm run lint` | ESLint 9 flat config (Next + React hooks + TS rules) |
| `npm test` | Vitest: unit + integration (100 tests) |
| `npm run test:e2e` | Playwright against a production build on port 3100 (19 journeys) |
| `npm run db:migrate` | Apply pending migrations; `--status`, `--down N`, `--to ID`, `--baseline` |
| `npm run db:schema` | Regenerate `sql/schema.sqlite.sql`; `--check` fails if it is stale |
| `npm run db:backup` | Verified backup (`pg_dump` / `VACUUM INTO`) → gzipped file |
| `npm run db:restore` | Restore a backup, with destructive-command guardrails |
| `npm run seed` | Create/reset the first account |

### Documentation index

| Doc | Read it when |
| --- | --- |
| `PROJECT_STATUS.md` | picking the work back up — current state, decisions, what is blocked |
| `docs/DEFINITION-OF-DONE.md` | deciding whether something is actually finished |
| `docs/DEPLOYMENT.md` | deploying, configuring providers, rolling back |
| `docs/DATABASE.md` | migrations, engines, RLS, `--baseline` |
| `docs/BACKUP-AND-RESTORE.md` | taking or restoring a backup |
| `docs/TROUBLESHOOTING.md` | something is broken and `/api/readiness` is the first clue |
| `PHASE-REPORT.md`, `PHASE-2-REPORT.md`, `PHASE-3-REPORT.md` | the audit trail of what changed, and what each phase proved |

## 5. Environment variables

Names only — see `.env.example` for the full annotated list.

| Variable | Needed for |
| --- | --- |
| `NEXT_PUBLIC_APP_URL` | Absolute URLs in share links, PDFs and Stripe redirects |
| `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Postgres mode (see section 7) |
| `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL` | Real AI generation (any OpenAI-compatible endpoint) |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Checkout, portal, webhooks |
| `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_PROFESSIONAL`, `STRIPE_PRICE_BUSINESS`, `STRIPE_PRICE_AGENCY` | One price ID per plan; the annual ID is the same value with an `_annual` suffix |
| `RESEND_API_KEY`, `EMAIL_FROM` | Sending approved email |
| `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REDIRECT_URI`, `DROPBOX_ACCESS_TOKEN` | Storing files in Dropbox instead of local disk |
| `ADMIN_EMAIL` | Which account becomes super-admin |
| `LEAD_CAPTURE_KEY` | Enables the public lead capture endpoint |
| `BIZPILOT_DB_FILE` | Overrides the SQLite file path (tests use this) |

Nothing is hardcoded: every secret is read from the environment at request time, and the UI reports the real
configuration state instead of pretending an integration is live.

## 6. Stripe setup

1. Create four products in Stripe (or one product with four prices) and copy the price IDs into the env vars above.
   Create annual prices too and store them as `<monthly id>_annual`.
2. Add the webhook endpoint: `https://your-domain.com/api/stripe/webhook`.
3. Subscribe it to: `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_succeeded`,
   `invoice.payment_failed`.
4. Copy the signing secret (`whsec_…`) into `STRIPE_WEBHOOK_SECRET`.
5. Test locally:

   ```bash
   stripe listen --forward-to localhost:3000/api/stripe/webhook
   # then run a test checkout from /billing
   ```

The webhook handler verifies the `Stripe-Signature` header (HMAC-SHA256 over `timestamp.body`, 5-minute tolerance),
stores each event id once, and only then mutates the local subscription. **No access is ever granted from a success
page** — `/billing?checkout=returned` explicitly says the change is pending until the webhook lands.

## 7. Database engines: SQLite and PostgreSQL

One query API, two engines. `src/lib/db.ts` exposes `all / get / run / tx / exec / count`, and picks the engine from the
environment:

| `DATABASE_URL` | Engine | Use |
| --- | --- | --- |
| empty | SQLite (`better-sqlite3`), `data/bizpilot.db` | local development, the demo |
| set | PostgreSQL (any host: Supabase, RDS, docker-compose, Neon) | production |

### How the sync API survives on an async driver

`pg` is asynchronous, but 300+ call sites were written against a synchronous API. Rather than rewrite them,
`src/lib/pg-sync.ts` owns a worker thread (`scripts/pg-worker.mjs`) that holds the real connection, and blocks the caller
on a `SharedArrayBuffer` via `Atomics.wait` until the rows are back. Queries do the following automatically:

* `?` placeholders → `$1…$n`
* `LIKE` → `ILIKE` (SQLite's `LIKE` is case-insensitive; Postgres's is not — search behaves identically on both)
* `bigint` / `numeric` → JavaScript numbers, so `count(*)` is a number on both engines

`sql/schema.sqlite.sql` is written as portable SQL (no `PRAGMA`, no SQLite-only functions, foreign keys declared after
their targets) and is applied **unchanged** to both engines, so the two deployments cannot drift.

### Setting up a Postgres deployment

```bash
export DATABASE_URL="postgres://user:pass@host:5432/bizpilot"
npm run db:migrate:pg      # schema + plan seed + 83 RLS policies
npm run db:seed:pg -- --demo --email you@company.com --password 'StrongPass123'
npm run build && npm start
curl localhost:3000/api/health   # {"ok":true,"engine":"postgres","tables":26,...}
```

Docker (app + Postgres 17, healthcheck-gated):

```bash
cp .env.example .env        # fill in what you have
docker compose up -d --build
docker compose exec app node scripts/seed.mjs --postgres --demo
```

### Proving it, instead of assuming it

```bash
npm run test:postgres       # typecheck → lint → migrate → 82 tests → build → 15 browser tests, all on Postgres
```

Verified in this repository, on PostgreSQL 17.12:

* `tests/integration.test.ts` (19) — leads, plan limits, automations, usage metering, real writes
* `tests/webhook.test.ts` (14) — Stripe signature verification and idempotency against the Postgres tables
* `tests/rls.postgres.test.ts` (12) — the Supabase-shaped policies, executed on PGlite
* `tests/rls.live.test.ts` (10) — the shipped policies, executed on a live server as a **non-owner** role: cross-tenant
  reads return nothing, cross-tenant writes throw `row-level security policy`, super-admin sees all, `plans` is readable
  but not writable
* `npx playwright test` (15) — the whole UI, including proposal PDF and client acceptance, on Postgres

### Roles

* **app** (owner of the tables): full access, bypasses RLS by design — same trust level as Supabase `service_role`.
  Keep its credentials server-side only.
* **anything else** (anon key, psql, BI tool): sees only rows in workspaces where
  `organization_members.user_id = auth.uid()`; set the caller with
  `select set_config('request.jwt.claim.sub', '<profile id>', true);`

## 8. Dropbox setup

1. Create an app at <https://www.dropbox.com/developers/apps> with **App folder** or **Full Dropbox** access and the
   `files.content.write` + `files.content.read` scopes.
2. Add the redirect URI `<NEXT_PUBLIC_APP_URL>/api/integrations/dropbox/callback`.
3. Exchange the authorisation code for a token and put the long-lived token in `DROPBOX_ACCESS_TOKEN`.
4. `DROPBOX_APP_KEY` + `DROPBOX_APP_SECRET` must also be present; files then upload to `/<organisation-id>/<filename>`
   and the row records `storage_provider = 'dropbox'`. If an upload fails, the file stays on local disk and the UI says
   so.

Files live in Dropbox; every record (lead, customer, proposal, invoice-like totals) stays in Postgres/SQLite.

## 9. QA checklist (run before selling)

Automated today: `npx tsc --noEmit`, `npm run lint`, `npm test` (72 tests), `npx playwright test` (15 browser tests
against a production build, including the invitation flow, the automation builder running on a real lead, and the
approval gate).

```bash
npm run typecheck && npm run lint && npm test && npm run build && npm run test:e2e
```

With credentials configured you must additionally verify by hand:

1. Stripe test checkout for each plan, monthly and annual; confirm the plan changes only after the webhook arrives.
2. Portal session, cancel-at-period-end, and a failed payment (`4000 0000 0000 0341`) marking the subscription past due.
3. AI generation with a real key, plus the limit message when the monthly quota is exhausted.
4. Resend delivery of an approved message; confirm the row becomes `sent` with a provider message id.
5. Dropbox upload; confirm `storage_provider = 'dropbox'` and the file appears in the app folder.
6. Lead capture from a real browser form with CORS from your marketing domain.

## 10. Architecture

```
src/
  app/                 routes: marketing, auth, dashboard, leads, customers, proposals, documents,
                       automations, analytics, billing, settings, admin, help, legal, /p/[token]
  app/api/             leads export, lead capture, proposal PDF, Stripe webhook
  components/          ui primitives (shadcn-style, hand-written) + feature components
  lib/
    db.ts              data layer (SQLite now, Postgres adapter pending)
    auth.ts session.ts identity + guards used by every page and action
    plans.ts           plan limits, usage metering, feature gates
    automations.ts     trigger engine with idempotency + step logs
    ai.ts              provider abstraction + rule-based scoring fallback
    stripe.ts          dependency-free Stripe REST client + signature verification
    pdf.ts             dependency-free PDF writer (used for proposals)
    storage.ts         local + Dropbox file storage
  lib/actions/         server actions (auth, leads, customers, proposals, ai, documents,
                       automations, billing, settings, admin)
sql/                   schema.postgres.sql, schema.sqlite.sql, seed_plans.sql
tests/                 vitest unit + integration + route tests
e2e/                   playwright suite
scripts/               migrate.mjs, seed.mjs
```

Design decisions worth knowing:

- **Server actions for all mutations.** Every action re-authenticates, re-checks the plan limit and scopes queries to the
  caller's organisation. Hiding a button is never the control.
- **One approval gate.** `approveAndSendAction` is the only path that sends email, and it refuses to run without the
  checkbox. Automation `send_email` steps are stored as `pending_approval`.
- **Client-owned acceptance.** `setProposalStatusAction` rejects `accepted`/`rejected`; only the token-scoped public
  action can set them.
- **Deterministic PDFs.** No headless browser: `src/lib/pdf.ts` writes a valid PDF 1.4 file, verified by parsing it back
  in the unit tests.
- **Failure is a feature.** Missing credentials produce `not_configured` states in the UI and non-2xx responses from the
  API, never fabricated success.

## 11. Design system

Tailwind CSS v4 with an `@theme` block in `src/app/globals.css`. Components are hand-written shadcn-style primitives
(`src/components/ui/`) so the build has no CLI or network dependency. Dark mode uses a `.dark` class with a
pre-paint script to avoid a flash. Icons come from `lucide-react`.

## 12. Deployment

**Docker (recommended, verified):** `docker compose up -d --build` runs the app and PostgreSQL 17 together, applies the
schema, and healthchecks `/api/health`.

**Vercel / Netlify / Fly:** import the repository, set `DATABASE_URL` to a hosted Postgres (Supabase, Neon, RDS) plus the
variables from section 5, run `npm run db:migrate:pg` once against that database, and deploy. The build reads the plan
catalogue, so the database must be reachable at build time.

**Self-hosted:** `npm ci && npm run build && npm start`. Put the SQLite file (`data/`) and `data/uploads` on a persistent
volume, and back them up.

**GitHub:** this repository is already published at <https://github.com/shahabkhan4636/bizpilot-ai>.

Full runbook, including post-deploy verification and rollback: **`docs/DEPLOYMENT.md`**.

**Vercel (shortest path once Postgres is wired):**

```bash
npm i -g vercel
vercel link            # pick the repo
vercel env add DATABASE_URL production
vercel env add STRIPE_SECRET_KEY production   # ...repeat for section 5
vercel --prod
```

Never commit `.env.local`, `data/`, or `node_modules/` — they are already in `.gitignore`.

## 13. Legal

`/privacy` and `/terms` contain working templates, not legal advice. Have them reviewed before taking payment.
