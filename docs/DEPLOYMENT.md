# Deployment

> Going live as the **platform owner** (super-admin, payment collection, smoke test,
> day-1 checklist, rollback)? Read **`DEPLOY-ADMIN.md`** first — this file is the generic
> provider/hosting reference.

Target: Vercel (app) + a managed PostgreSQL 15+ (Neon, Supabase, RDS). **SQLite is never used in
production** — it is a local-development convenience only, because serverless filesystems are
ephemeral and every request would get a different database.

## 1. Prerequisites

| What | Why |
| --- | --- |
| PostgreSQL 15+ with `DATABASE_URL` | the only supported production engine |
| `NEXT_PUBLIC_APP_URL` | absolute URLs for emails, share links and Stripe redirects |
| Stripe keys | billing (checkout, portal, webhooks) |
| Resend key + verified `EMAIL_FROM` | transactional email |
| AI key + model + base URL | the assistant (any OpenAI-compatible endpoint) |
| Dropbox app key/secret + refresh token | document storage driver |
| `SESSION_SECRET` | cookie signing — generate with `openssl rand -base64 48` |

Everything except `DATABASE_URL` and `SESSION_SECRET` is optional: a missing provider degrades to an
explicit "not configured" state and a `/api/readiness` warning. Nothing fakes a success.

## 2. First deploy

```bash
# 1. Schema. Run from CI or a shell with DATABASE_URL set — never on app boot.
npm ci
npm run db:migrate
node scripts/db-migrate.mjs --status        # expect "N applied · 0 pending"

# 2. Deploy
vercel deploy --prod
```

Migrate **before** the new build serves traffic. Every migration in this repo is additive or a
constraint swap, and each has a `.down` file, so a rollback is `node scripts/db-migrate.mjs --down 1`.

## 3. Environment parity

`.env.example` is the contract. Locally `cp .env.example .env` and fill in what you have; on Vercel
set the same names under Project → Settings → Environment Variables. `NEXT_PUBLIC_*` values are
inlined at build time, so changing one requires a redeploy.

## 4. Post-deploy verification (run these, do not assume)

```bash
curl -s https://YOUR_DOMAIN/api/readiness | jq
#   {"ready":true,...}                     → 200, schema + migrations ok
#   {"ready":false,"checks":{...}}         → 503, one check failed; body says which

curl -sI https://YOUR_DOMAIN/login | grep -i content-security-policy
#   must include a nonce and 'strict-dynamic', and no 'unsafe-inline' for script-src
```

Then in a browser: sign up, create a lead, create a proposal, open its share link in a private
window and accept it. Those four steps exercise the database, the RLS policies, the session, and the
public token path.

## 5. Stripe

1. Create the products/prices, put their ids in `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_PROFESSIONAL`,
   `STRIPE_PRICE_ENTERPRISE`.
2. Add a webhook endpoint at `https://YOUR_DOMAIN/api/stripe/webhook` for
   `checkout.session.completed`, `customer.subscription.created|updated|deleted`,
   `invoice.payment_failed`, `invoice.payment_succeeded`. Copy the signing secret into
   `STRIPE_WEBHOOK_SECRET`.
3. The handler verifies the signature, stores the event id in `webhook_events` **before** acting (so
   duplicate, delayed and out-of-order deliveries are idempotent), and never trusts the browser's
   success redirect for entitlement. Plans are only ever granted server-side from a verified event.

## 6. Rollback

| Situation | Action |
| --- | --- |
| Bad deploy, schema unchanged | Vercel → Deployments → promote the previous build |
| Bad migration | `node scripts/db-migrate.mjs --down 1`, then redeploy the previous build |
| Data loss / corruption | restore the newest backup, see `docs/BACKUP-AND-RESTORE.md` |

## 7. Everything blocked on credentials

Live Stripe, Resend, AI, Dropbox and the Vercel deploy itself are **unverified** in this workspace
because the keys are absent. `PROJECT_STATUS.md` keeps the list. Do not mark them done until the
checks in section 4 return real data.


### Vercel plan, cron frequency and the one thing that blocks a deploy

`vercel.json` ships a **daily** cron (`0 7 * * *`) on purpose. Vercel's Hobby plan rejects any
sub-daily schedule at deploy time ("Hobby accounts are limited to daily Cron Jobs"), so a `*/10`
expression fails the deployment outright instead of merely running less often — the worst outcome,
because it looks like a code problem.

| Plan | Cron | Commercial use |
| --- | --- | --- |
| Hobby (free) | one invocation per day, timing only guaranteed inside the hour | **not permitted** by Vercel's fair-use guidelines |
| Pro ($20/mo) | any expression, e.g. `*/10 * * * *` | permitted |

If you are going to charge customers, you need Pro anyway. On Pro, promote the faster schedule:

```bash
cp vercel.pro.json vercel.json && git commit -am "run the scheduler every 10 minutes" && git push
```

Alternative that keeps Hobby (non-commercial projects only): leave the daily cron in place and point an
external scheduler (cron-job.org, Better Stack, a VPS crontab) at
`https://<your-domain>/api/cron/automations` every 10 minutes with `Authorization: Bearer $CRON_SECRET`
— the route does not care who calls it, only that the secret matches.

## 8. Scheduler (time-based automations)

Event triggers fire immediately from the code path that changed the record. Two trigger types cannot:
**"on a schedule"** and **"follow-up overdue"**. They are driven by one authenticated route:

```bash
# what Vercel Cron sends when CRON_SECRET is set
curl -H "Authorization: Bearer $CRON_SECRET" https://YOUR_DOMAIN/api/cron/automations
# dry run: reports what would run, changes nothing
curl -H "Authorization: Bearer $CRON_SECRET" "https://YOUR_DOMAIN/api/cron/automations?dryRun=1"
```

- Set `CRON_SECRET` (`openssl rand -base64 32`). **Without it the route returns 503 instead of running
  unauthenticated** — it can dispatch emails and AI calls for every workspace, so it must never be open.
- `vercel.json` registers `*/10 * * * *`. Any other host: point a crontab at the same URL.
- A wrong or missing token is a `401`. The `x-cron-secret` header is also accepted for schedulers that
  cannot set an `Authorization` header.
- Each due automation is claimed with a conditional update, so two overlapping runs cannot both fire
  it, and overdue follow-ups de-duplicate per lead per due date.
- `/automations` shows the next scheduled run and the overdue count, and warns on the page when
  `CRON_SECRET` is missing rather than leaving silent non-firing automations.
- `/api/readiness` reports `providers.scheduler`.

## 9. Verified Vercel + Supabase deployment (2026-08-09)

This is the deployment that is actually running, with the four things that cost real time. Every one of
them is a platform fact, not an app bug — expect them again on any serverless host.

**Use the pooler host, never the direct host.** Supabase's direct host
(`db.<project-ref>.supabase.co`) publishes an **AAAA record only**, and Vercel Functions have no IPv6
egress, so the driver reports `getaddrinfo ENOTFOUND` and the sync bridge waits out its deadline.
`DATABASE_URL` must point at the pooler:

```
postgresql://bizpilot_app.<project-ref>:<password>@aws-2-<region>.pooler.supabase.com:5432/postgres?sslmode=require
```

The shard number is project-specific: for this project `aws-0` and `aws-1` answer
`tenant/user not found`, and `aws-2` works. Copy the exact host from
Supabase → **Connect → Session pooler** instead of guessing it.

**Pooler TLS does not chain to a public root.** `pg-connection-string` turns `sslmode=require` into
`ssl: {}`, and Node then verifies the chain — "self-signed certificate in certificate chain". libpq's
`require` means *encrypt, do not verify*, so `scripts/pg-worker.mjs` applies that explicitly and still
honours `sslmode=verify-ca` / `verify-full` as written.

**Ship the worker and `pg`.** The Postgres engine opens its connection in a worker thread
(`scripts/pg-worker.mjs`), and that worker requires `pg` at runtime — invisible to file tracing. A static
side-effect import of `pg` in `src/lib/pg-sync.ts` (with `pg` kept in `serverExternalPackages`) makes the
tracer walk the whole graph; without it the worker dies on `Cannot find module 'xtend/mutable'` and every
request hangs until the bridge times out. `next.config.ts` also pins the worker file with
`outputFileTracingIncludes`.

**The bridge must reconnect.** Vercel freezes the process between requests and the pooler drops the idle
socket. `scripts/pg-worker.mjs` now bounds queries (20s), keeps the socket alive, reconnects on a dead
connection and retries once outside a transaction, and treats `init` as idempotent.

**Least-privilege database role.** The app connects as `bizpilot_app` (created with `login`,
`bypassrls`, and `select/insert/update/delete` on `public` plus sequence grants) rather than the
`postgres` superuser. Recreate it with:

```sql
create role bizpilot_app login password '<password>' bypassrls;
grant connect on database postgres to bizpilot_app;
grant usage on schema public to bizpilot_app;
grant select, insert, update, delete on all tables in schema public to bizpilot_app;
grant usage, select on all sequences in schema public to bizpilot_app;
grant execute on all functions in schema public to bizpilot_app;
alter default privileges in schema public grant select, insert, update, delete on tables to bizpilot_app;
alter default privileges in schema public grant usage, select on sequences to bizpilot_app;
```

Other notes from the same deploy:

- `engines.node` is pinned to `22.x`: `better-sqlite3` 11.x has no prebuilt binary for Node 26.
- The project's Vercel Authentication (deployment protection) must be off for the app to be reachable at
  all; the app's own session auth is the gate. Re-enable it in Vercel → Settings → Deployment Protection
  if you want Vercel SSO in front of it too.
- `.vercelignore` keeps `data/*.db` and build output out of the upload.
- Migrations are applied by script, not at runtime: `DATABASE_URL=... MIGRATION_SKIP=005 node scripts/db-migrate.mjs`.
  `005_row_level_security` is skipped on Supabase because it replaces `auth.uid()`.
