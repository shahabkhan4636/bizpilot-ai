# DEPLOY-ADMIN — launching BizPilot AI as the platform owner

This is the runbook for **you**, the owner: how to get the app onto a real domain, how to
become the super-admin, how to take payments into your own SadaPay/JazzCash/IBAN, and what
to check when something looks wrong. It is deliberately operational, not aspirational: every
command below has been run in this repo, and every step says what "done" looks like.

Generic provider detail (Stripe, Dropbox OAuth, AI keys) lives in `docs/DEPLOYMENT.md`.
This file covers the owner-specific wiring added in Phases 1–5.

---

## 0. What must be true before you start

| Thing | Why it is needed | Blocked until you provide it |
| --- | --- | --- |
| Supabase **Session pooler** `DATABASE_URL` | Vercel is IPv4-only; the direct Supabase connection is IPv6-only | deploy cannot start |
| Vercel project access | hosting | deploy cannot start |
| Domain (or the `*.vercel.app` subdomain to start) | Resend needs a verified domain to email customers | emails queue instead of sending |
| `RESEND_API_KEY` | real transactional email | outbox queues (nothing is lost) |
| `SESSION_SECRET` | cookie signing | sessions are weaker, do not ship without it |

Honest status: **none of the above is in this repo** — they are your accounts, and this
workspace cannot create them. Everything else (schema, migrations, admin panel, payments,
smoke checks) is built and tested.

---

## 1. Create the database (Supabase)

1. Project → **Settings → Database → Connection string → Session pooler**, copy the URI.
   It looks like `postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres`.
   **The direct connection (`db.<ref>.supabase.co:5432`) will not work from Vercel.**
2. Run the schema **from your machine**, not from the app:

```bash
cd bizpilot
export DATABASE_URL='postgresql://...pooler.supabase.com:5432/postgres'
npm run db:migrate            # applies 001…012 and the plan catalogue
node scripts/db-migrate.mjs --status     # expect: "12 applied · 0 pending"
```

Done when `--status` shows **12 applied, 0 pending** and the plan catalogue prints
`✔ plan catalogue in place (4 plans)`. If it prints fewer, stop and read the error — a
half-migrated database is the one failure mode that is painful to fix later.

> Already done for the live Supabase project: migrations 001–012 are applied
> (11 rows in `schema_migrations`, 37 tables). You do **not** re-run them; the command above
> is for a fresh project.

---

## 2. Set the environment on Vercel

Project → Settings → Environment Variables (Production **and** Preview). Minimum viable set:

| Variable | Value | Notes |
| --- | --- | --- |
| `DATABASE_URL` | Session pooler URI | §1 |
| `NEXT_PUBLIC_APP_URL` | `https://your-domain.com` | absolute links in email + Stripe redirects |
| `SESSION_SECRET` | `openssl rand -base64 48` | rotating signs everyone out |
| `ADMIN_EMAIL` | `shahabkhanprofessional@gmail.com` | **the only rule for super-admin** |
| `CRON_SECRET` | `openssl rand -hex 32` | required by both cron endpoints |
| `RESEND_API_KEY` | `re_…` | without it, email queues instead of sending |
| `RESEND_FROM_EMAIL` | `BizPilot AI <hello@your-domain.com>` | domain must be verified in Resend |
| `PKR_PER_USD` | `280` | rupee conversion of the USD catalogue |
| `SUPPORT_EMAIL` | your support address | shown on `/suspended` |
| `LEAD_CAPTURE_KEY` | optional | opens `/api/leads/capture` |

Optional, only when the provider exists: `AI_API_KEY`, `AI_MODEL`, `AI_BASE_URL`,
`DROPBOX_APP_KEY`/`DROPBOX_APP_SECRET`/`DROPBOX_REDIRECT_URI`, `STRIPE_*`,
`SADAPAY_WEBHOOK_SECRET`, `JAZZCASH_INTEGRITY_SALT`, `EASYPAISA_HASH_KEY`.
Full list with comments: `.env.example` (and `tests/deploy-docs.test.ts` fails if a new
variable is added to the code without being documented there or here).

**Never** put a wallet number, IBAN or API key in the source. Payout details are typed in
`/admin/platform-payments` and stored in `platform_settings`; that is why they are not in
this table.

---

## 3. Deploy

```bash
npm ci
npm run verify          # typecheck, lint, 343 unit tests, schema snapshot, build
vercel deploy --prod
```

Done when the deploy reports **Ready** and the build log ends with the route table
(37 tables / 12 migrations do not appear there — the readiness probe proves the database).

---

## 4. Smoke test the live deployment

```bash
node scripts/smoke.mjs https://your-domain.com
# or: ADMIN_LIVE_URL=https://your-domain.com npm run smoke
# or: node scripts/smoke.mjs --list      (see what it checks, touch nothing)
```

Nine checks, all real requests. Locally verified 9/9 against a production build, and the
failure path exits **1** (point it at a dead port and every check fails — it does not
pretend).

| Check | Proves |
| --- | --- |
| `marketing` / `login` | the app renders, not just 200s |
| `csp` | strict CSP with a nonce, no `'unsafe-inline'` for scripts |
| `readiness` | `/api/readiness` says `ready: true` (schema + migrations) |
| `admin-gate` | an anonymous visitor never gets the admin panel's content |
| `billing-platform` | payout details are not visible without signing in |
| `cron-email` | the email worker refuses an unauthenticated request (401/503) |
| `webhook-closed` | an unsigned payment webhook is refused |
| `not-found` | unknown routes 404 |

A failure here is a reason to roll back (§7), not to re-run the script.

---

## 5. Owner day-1 checklist (10 minutes, in this order)

1. **Sign up with exactly `ADMIN_EMAIL`.** That account, and only that account, can open
   `/admin`; everyone else gets a 404. Nothing is hardcoded, so if you later change
   `ADMIN_EMAIL`, access moves with it.
2. Open `/admin` → confirm you see **Workspaces / Users / Payments / Payout settings /
   Email outbox**. If you see 404, `ADMIN_EMAIL` does not match your login (check the
   trimmed, lowercased value).
3. Open `/admin/platform-payments` → enter **your** SadaPay / JazzCash / EasyPaisa number
   and/or bank IBAN + account holder name → **Save payout settings**. Done when the banner
   at the top of the page lists the methods you entered.
4. Decide the **Founding Member** offer: price (default Rs 1,500/mo), slots (default 10) and
   seats (default 3). Leave **demo mode off** for real customers — it auto-approves *your own*
   claims only, and is for testing the flow without a second person.
5. Open `/billing/platform` in a normal (non-admin) browser session and check the numbers
   are visible and the amount is calculated for you.
6. `curl -s -H "Authorization: Bearer $CRON_SECRET" https://your-domain.com/api/cron/email?dryRun=1`
   → proves the retry worker is reachable with the secret.
7. Your own workspace is **unlimited** by design (badge: “Platform owner”) — leads, AI,
   documents, automations and seats have no ceiling, and `/admin/workspaces` shows it as
   `unlimited / never billed`. That is not a bug.

---

## 6. Cron on Vercel

`vercel.json` schedules the email retry worker **daily** (`0 7 * * *`) because the Hobby
plan rejects anything more frequent and the deploy fails if you try. `vercel.pro.json`
schedules every 10 minutes for after you upgrade. Both routes need
`Authorization: Bearer $CRON_SECRET` (or `x-cron-secret`).

Until the plan is Pro, run the worker yourself once a day (or after enabling Resend):

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" "https://your-domain.com/api/cron/email?dryRun=1"
```

With `RESEND_API_KEY` missing, messages sit in `email_outbox` as `queued` with **zero
attempts burned** — nothing is lost, and `/admin/email` → “Retry everything” sends the
backlog the moment the key exists.

---

## 7. When something is wrong: roll back, then read

| Symptom | First move |
| --- | --- |
| Smoke `readiness` fails (503) | `node scripts/db-migrate.mjs --status` against the pooler; usually a migration did not run |
| Smoke `csp` fails | someone edited `src/middleware.ts`; revert, do not "fix" it live |
| `/admin` 404 for the owner | `ADMIN_EMAIL` mismatch — compare with the login email exactly (trim + lowercase) |
| Customers cannot pay you | `/admin/platform-payments` has no method saved, or the default method has no number |
| Emails not arriving | `RESEND_API_KEY`/domain, then `/admin/email` for the provider's exact error |
| A customer's plan looks wrong | `/admin/workspaces/[id]` shows the plan, Founding lock and the audit trail |

Rollback of a bad **deploy**: Vercel → Deployments → the previous one → **Promote to
Production**. Rollback of a bad **migration**: `node scripts/db-migrate.mjs --down 1`
(every migration has a `.down` file). Roll back the code first if both are suspect.

---

## 8. Support tools you now have (and the rules built into them)

| Tool | Path | Built-in safety |
| --- | --- | --- |
| Suspend / restore a workspace | `/admin/workspaces/[id]` | reason **mandatory**, audited, owner notified **and** emailed; the owner's own workspace is refused; the customer sees `/suspended` with your reason instead of a 500 |
| Impersonate a member | `/admin/workspaces/[id]` → **Impersonate** | **read-only** by default; write mode needs the typed word `IMPERSONATE`; every write audited as `impersonated_write: true` and the owner is notified; 60-minute expiry; the platform owner's own account can never be impersonated |
| Approve a platform payment | `/admin/payments` (or `/admin/platform-payments`) | amount computed server-side; one approval activates the plan once; self-approval is allowed but flagged `self_approved` |
| Founding Member grant / revoke | `/admin/workspaces/[id]` | price locked in the database; renewals never read the plan catalogue |
| Email outbox | `/admin/email` | retries at 5 / 30 / 120 minutes, then waits for a human |
| Audit trail | `/admin`, `/admin/workspaces/[id]` | append-only; impersonated writes flagged |

Two rules worth remembering, because they are enforced in code and not just in the docs:
**you cannot suspend your own workspace**, and **you cannot impersonate the owner account**.
Both would let a single mistake take the platform down.

---

## 9. Security hygiene (do these before announcing)

- [ ] `SESSION_SECRET` and `CRON_SECRET` are freshly generated (never reused from a tutorial).
- [ ] `RESEND_API_KEY` lives only in Vercel env (never in the repo, never in chat).
- [ ] Revoke the old GitHub token (`ghp_a5a6…`) and Netlify token (`nfp_7CWU…`) from the
      earlier sessions; reset the Supabase database password if it was ever shared.
- [ ] `ADMIN_EMAIL` points at an address you control with 2FA.
- [ ] Smoke test passes 9/9 on the production domain.
- [ ] `/api/readiness` shows no unexpected warnings.
- [ ] Supabase project is on a plan that does not pause after 7 idle days (free tier does).

---

## 10. What is still not possible (and why) — no pretending

| Not done | Blocked on |
| --- | --- |
| Automatic wallet verification without a human | merchant accounts (SadaBiz / JazzCash merchant / Easypaisa store). Manual approval works today |
| Emails actually leaving the building | `RESEND_API_KEY` + a verified sending domain |
| Card payments | Stripe does not onboard Pakistani businesses |
| A public URL to show customers | the deploy itself (needs your Vercel + Supabase credentials) |
| Scheduler running every 10 minutes | Vercel Pro |

Everything in that table has a working code path **and** a test that proves the fallback is
honest (queue instead of drop, 503 instead of a fake success, manual approve instead of a
phantom gateway).
