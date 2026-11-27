# Launch runbook — from this repo to taking real money

Written for the actual Vercel account already connected (`bizpilot-ai` project,
`prj_Yjg54ublYIGrnKFvYLRPsev78rdJ`, team `team_u76Q3u7Qi14nCDxdQ0eQ2XNq`, region `iad1`).

**Current state:** project exists, `CRON_SECRET` is already set as a sensitive production/preview
variable. No code is deployed yet, no database is attached, no Stripe keys exist. This document is the
remaining order of operations, and nothing here is skippable.

---

## 0. The three things that must be true before you can charge a customer

| # | Requirement | Why it is not optional | Who does it |
| --- | --- | --- | --- |
| 1 | **Vercel Pro ($20/mo)** | Hobby is limited to *non-commercial* use by Vercel's fair-use policy, and Hobby rejects any cron more frequent than daily **at deploy time** | you (billing) |
| 2 | **A Postgres database** | Vercel has no persistent disk; SQLite would lose data on every deploy | you (Neon/Supabase, ~5 min) |
| 3 | **Stripe live keys + KYC** | Stripe is the only payment path in the product | you (business + bank details) |

Without all three the app deploys but cannot take money. Everything else in this file is 1–2 hours of work.

---

## 1. Database — **DONE on Supabase** (project `bizpilot`, ref `mpzuknincvfrfrvanpio`)

The production database exists and is migrated. What was applied, verified by querying it:

| Check | Result |
| --- | --- |
| Public tables | **29** (same as a migrated SQLite dev database) |
| Migrations recorded | **6** — 001, 002, 003, 004, 006, 007 |
| Plan catalogue | **4 plans** (Starter/Professional/Business/Agency) |
| Migration 005 (RLS policies) | **deliberately not applied** — see below |
| Postgres version | 17.12, region `us-east-1` (matches the Vercel `iad1` region) |

**Why 005 was skipped — read this, it matters.** Migration 005 starts with
`create or replace function auth.uid()`. On a self-hosted Postgres that is correct; on Supabase that
function belongs to Supabase Auth and the connecting role does not own it, so applying it either fails or
silently replaces Supabase's own auth helper. So on Supabase the policies are skipped and tenant isolation
rests on the application layer, which is where it actually lives: every query in `src/lib/*` filters by
`organization_id`, and the e2e suite proves one workspace cannot read another's rows. If you want the
second lock as well, run `sql/rls.postgres.sql` **without** the `auth` function block, as a database owner.

The runner now supports this honestly — a skipped migration is printed as `SKIPPED` and never recorded as
applied:

```bash
MIGRATION_SKIP=005 DATABASE_URL="postgres://…" BIZPILOT_ENGINE=postgres npm run db:migrate:status
#  001  applied  3da9f02812816002  001_initial
#  005  SKIPPED  028de6dcafee4d99  005_row_level_security
#  6 applied · 0 pending · 1 skipped
```

### The connection string you must paste (one click, do not guess it)

Supabase dashboard → project `bizpilot` → **Connect** → **Session pooler** → copy the URI. It looks like

```
postgresql://postgres.mpozuknincvfrfrvanpio:<password>@aws-0-us-east-1.pooler.supabase.com:5432/postgres
```

- The **database password** was generated when the project was created: `favEkwg9YbsONfUSFoLoERQjAa9z`
  (change it under Settings → Database → Reset password if you prefer your own; then update this).
- Use the **Session pooler (port 5432)**, not the transaction pooler (6543): the app's `pg` driver issues
  multi-statement transactions, which transaction-mode pooling does not keep together.
- Add `?sslmode=require` if your copy drops it.
- Do not guess the host: the pooler hostname is region-specific, and a wrong one produces "tenant/user not
  found" — which looks like a code bug and is not one.

Once you have it, either paste it here (I will set it in Vercel) or add it yourself as `DATABASE_URL`.

---

## 1b. Original database instructions (Neon or your own Postgres)

If you ever move off Supabase, this is the path.

1. Create a project at **neon.tech** (or supabase.com). Region: pick the one closest to your customers
   (`aws-us-east-1` matches the app's `iad1` region).
2. Copy the **pooled** connection string. It looks like:
   `postgres://user:password@ep-xxx-pooler.us-east-1.aws.neon.tech/bizpilot?sslmode=require`
3. Apply the schema **from your own machine** (migrations are not run automatically on deploy):

```bash
cd bizpilot
DATABASE_URL="postgres://…?sslmode=require" BIZPILOT_ENGINE=postgres npm run db:migrate
DATABASE_URL="postgres://…?sslmode=require" BIZPILOT_ENGINE=postgres npm run db:seed:pg
```

`db:migrate` also seeds the plan catalogue and turns on the 83 row-level-security policies.
`db:seed:pg` creates your first account (make it the super-admin email you set as `ADMIN_EMAIL`).

4. Verify before deploying anything:

```bash
DATABASE_URL="postgres://…" BIZPILOT_ENGINE=postgres npm run db:migrate:status   # 7 applied · 0 pending
```

---

## 2. Deploy the code (choose one)

### Option A — GitHub + Vercel auto-deploy (recommended, one-time)

1. Push this repo to GitHub (private is fine).
2. In Vercel → project `bizpilot-ai` → **Settings → Git → Connect Git Repository** → pick the repo, branch `main`.
3. Deploy. Every later `git push` redeploys production.

> If you connect the GitHub app inside this workspace instead, I can create the repository, push, and
> trigger the deployment for you — that is the one step I cannot do without it.

### Option B — Vercel CLI from your machine (fastest right now)

```bash
npm i -g vercel
cd bizpilot
vercel login
vercel link --project bizpilot-ai        # links to the existing project, keep the name
vercel --prod                            # builds and deploys
```

### Option C — drag & drop (no terminal)

Dashboard → **Add New → Project → Deploy without Git** → upload a zip of this folder (exclude
`node_modules`, `.next`, `data`).

---

## 3. Environment variables (copy-paste set order)

Vercel → project → **Settings → Environment Variables**. Production (and preview where useful):

| Key | Value | Required |
| --- | --- | --- |
| `DATABASE_URL` | the pooled Postgres string from step 1 | **yes** |
| `NEXT_PUBLIC_APP_URL` | `https://yourdomain.com` (no trailing slash) | **yes** once you have a domain — until then the app falls back to Vercel's own URL automatically |
| `ADMIN_EMAIL` | your own email — becomes the first super-admin on seed | strongly recommended |
| `CRON_SECRET` | already set ✅ (`79ee…` sensitive variable) | yes, for automations |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | from Stripe, step 5 | for taking money |
| `STRIPE_PRICE_STARTER` / `_PROFESSIONAL` / `_BUSINESS` / `_AGENCY` (+ `_annual` variants) | price IDs from your Stripe products | for taking money |
| `RESEND_API_KEY` + `EMAIL_FROM` | welcome mail, proposal emails, reminders | optional at first |
| `AI_API_KEY` (+ `AI_MODEL`, `AI_BASE_URL`, `AI_PRICE_INPUT_PER_MTOK`, `AI_PRICE_OUTPUT_PER_MTOK`) | AI drafts/scoring | optional |
| `DROPBOX_APP_KEY` / `DROPBOX_APP_SECRET` | per-workspace document storage (**needed on Vercel**, see §7) | recommended |

Redeploy after adding variables — Vercel only injects them into new builds.

---

## 4. First-run smoke test (do this before telling anyone about the product)

```bash
curl -s https://your-domain/api/health        | jq          # liveness
curl -s https://your-domain/api/readiness     | jq          # ready + provider warnings
curl -s -H "Authorization: Bearer $CRON_SECRET" \
     "https://your-domain/api/cron/automations?dryRun=1" | jq # scheduler sees the database
```

Then in the browser, in this order — if any step fails, stop and fix before launch:

1. Sign up → onboarding completes → dashboard shows zeroed stats (no fake numbers).
2. Create a lead → open it → add a note → "Convert to customer" → the customer page opens.
3. Create a proposal → PDF downloads and opens → "Mark as sent" → open the client link in a private
   window → accept it → the workspace page shows **who** accepted.
4. Upload a document → **Download** it back → the content matches.
5. Settings → invite a teammate → the invite link works in a private window.
6. `/billing` → "Checkout" tells you Stripe is not configured (until step 5 is done) — it must never pretend.

---

## 5. Stripe, from test mode to live money

1. Stripe dashboard → **Developers → API keys** → copy the **restricted/live** secret key into
   `STRIPE_SECRET_KEY` (start with the test key `sk_test_…` and repeat the whole flow once).
2. Create four products/prices matching the seeded plans, monthly plus annual:
   Starter $29 · Professional $79 · Business $149 · Agency $299 (annual = 10 × monthly).
   Paste each price ID into the matching `STRIPE_PRICE_*` variable; the annual ID goes in
   `<same variable>_annual`.
3. Add the webhook: **Developers → Webhooks → Add endpoint**
   `https://your-domain/api/stripe/webhook`, events:
   `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.payment_succeeded`, `invoice.payment_failed`.
   Copy the `whsec_…` signing secret into `STRIPE_WEBHOOK_SECRET`.
4. Redeploy, then prove it end-to-end **in test mode**: `/billing` → Checkout → pay with `4242 4242 4242 4242`
   → you land back on the billing page with the plan upgraded → the Stripe dashboard shows the payment
   → **Resend webhook** (Stripe → your endpoint → "Send test webhook") and confirm the app does not 500.
5. Only after a successful test charge: switch the keys to live, repeat one real charge with your own
   card, then refund it. That refund is your proof, and it costs you ~$1 in fees.

---

## 6. Domain and DNS

1. Buy the domain (Namecheap/Cloudflare, ~$10–15/year).
2. Vercel → project → **Settings → Domains → Add** → follow the DNS record it shows (usually
   `A 76.76.21.21` or a `CNAME`).
3. Set `NEXT_PUBLIC_APP_URL=https://yourdomain.com` and redeploy.

> **Gotcha found in this account:** the project was created with deployment protection set to
> *all except custom domains*, so the plain `*.vercel.app` URL will show a Vercel login wall. Either add
> the custom domain (recommended) or set **Settings → Deployment Protection → Vercel Authentication → Disabled**
> while you test.

---

## 7. Things that behave differently on Vercel (read before launch)

- **Uploaded files do not survive a deploy.** Serverless has no persistent disk, so `data/uploads` is
  ephemeral. On Vercel you must connect Dropbox (per workspace, `/documents` → Connect Dropbox) or accept
  that documents vanish. The download route reports `410` when the file is gone rather than pretending.
- **Cron runs once a day** on the committed `vercel.json` (Hobby-safe). On Pro, promote the 10-minute
  schedule: `cp vercel.pro.json vercel.json`. Without that, scheduled automations run once daily.
- **The rate limiter is database-backed** — correct for a single region, and it will under-count if Vercel
  ever runs several instances of the same function concurrently. Acceptable at launch scale; swap for Redis
  when you cross ~50 active workspaces.
- **SQLite is not an option here.** If `DATABASE_URL` is missing the app will try to open a local file and
  the deploy will look "broken but alive". `/api/readiness` is the check.

---

## 8. Go-live checklist (tick every line)

- [ ] Vercel Pro active (commercial use allowed)
- [ ] `DATABASE_URL` set, `db:migrate:status` → 7 applied on the production database
- [ ] Super-admin account seeded, you can log in
- [ ] `/api/readiness` → `ready: true`, warnings are only the providers you deliberately skipped
- [ ] Custom domain attached, `NEXT_PUBLIC_APP_URL` matching it, HTTPS valid
- [ ] Stripe live keys + webhook secret set; one real charge made and refunded
- [ ] Proposal PDF, client accept and document download tested on the **live** URL
- [ ] `RESEND_API_KEY` + `EMAIL_FROM` with a verified domain (otherwise email actions say "not configured")
- [ ] Dropbox connected for document storage (or documents knowingly ephemeral)
- [ ] Backups: `npm run db:backup` scheduled somewhere (cron on your machine or a GitHub Action)
- [ ] Pricing page, terms and privacy pages reviewed with your own business details
- [ ] One real customer account created end-to-end by someone who is not you

---

## 9. What I cannot do for you (and nobody's AI can)

Sign up for Stripe under your business identity, buy a domain, approve Vercel billing, run your KYC, or
find your first customer. Those are the four gating items between "deployed" and "first payment".
