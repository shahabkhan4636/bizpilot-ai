# BizPilot AI — Build Report
**Date:** 9 August 2026 · **Location:** `/home/user/bizpilot` · **Backup:** Dropbox `/BizPilot-AI/2026-08-09/bizpilot-ai-source.zip`

95 TypeScript files · ~10,800 lines of app code · 816 lines of SQL · 28 pages · 4 API routes · 10 server-action modules

---

## 1. What was built

### Foundation
- Next.js 15.5.29 (App Router) · React 19 · TypeScript strict · Tailwind CSS v4 · Lucide icons
- `better-sqlite3` runtime database, schema auto-applied on first open
- Postgres/Supabase schema (`sql/schema.postgres.sql`, 507 lines) with enums, triggers, `auth_user_org_ids()`,
  `is_super_admin()` and per-table RLS policies — ready for the adapter described in README §7
- Hand-written shadcn-style component kit (button, card, input/select/textarea, badge, alert, table, theme toggle)
- Dark/light theme with pre-paint script; no CDN dependencies at all

### Libraries (`src/lib`)
| Module | Purpose |
| --- | --- |
| `db.ts` | query helpers + tenant-scoped access |
| `session.ts` / `auth.ts` | opaque session tokens, `requireAuth` / `requireSuperAdmin` guards |
| `password.ts` | scrypt with per-user salt, timing-safe compare |
| `plans.ts` | 4 plans, usage metering, feature gates, limit enforcement |
| `automations.ts` | trigger engine: 8 triggers, 7 actions, conditions, idempotency, daily limits, step logs |
| `ai.ts` | provider abstraction + deterministic rule-based lead scoring fallback |
| `stripe.ts` | REST client + HMAC-SHA256 webhook verification |
| `pdf.ts` | dependency-free PDF 1.4 writer |
| `storage.ts` | local disk + real Dropbox upload |
| `csv.ts`, `audit.ts`, `ratelimit.ts`, `email.ts`, `validate.ts`, `utils.ts`, `ids.ts` | supporting utilities |

### Pages (28)
Marketing: `/`, `/features`, `/pricing`, `/help`, `/privacy`, `/terms`
Auth: `/signup`, `/login`, `/forgot-password`, `/reset-password`, `/onboarding`
App: `/dashboard`, `/leads`, `/leads/[id]`, `/leads/import`, `/customers`, `/customers/[id]`, `/ai-assistant`,
`/proposals`, `/proposals/new`, `/proposals/[id]`, `/documents`, `/automations`, `/analytics`, `/billing`,
`/settings`, `/admin`, `/p/[token]` (public client portal), `not-found`

### API routes (4)
- `POST /api/stripe/webhook` — signature verified, event deduped, subscription state machine
- `GET /api/leads/export` — CSV of the current filtered view
- `GET /api/proposals/pdf` — real PDF binary
- `POST /api/leads/capture` — public lead intake (key + CORS + rate limit + plan limit)

---

## 2. Safety properties enforced in code (not just in the UI)
1. **Approval gate** — `approveAndSendAction` is the only email path and refuses without the checkbox.
2. **Client-owned acceptance** — staff cannot set a proposal to accepted/rejected; the server action rejects it.
3. **No access from a success page** — only a verified Stripe webhook mutates the subscription.
4. **Duplicate automation prevention** — unique `(automation_id, idempotency_key)`; replays report "duplicate blocked".
5. **Tenant scoping** — `organization_id` on every query; cross-tenant reads return nothing (tested).
6. **Failure is visible** — missing credentials produce `not_configured` states, never fabricated output.
7. **No fabricated social proof** — no testimonials, review counts or customer logos anywhere.

---

## 3. Verification actually run (this session)

| Command | Result |
| --- | --- |
| `npm run typecheck` | ✅ clean, no output |
| `npm run lint` | ✅ clean (ESLint 9 flat config: Next core-web-vitals + React hooks + TS) |
| `npm test` (vitest) | ✅ **60 / 60 passed** across 3 files (unit, integration, API routes) |
| `npm run build` | ✅ 33 routes compiled, no type-check bypass |
| `npm run test:e2e` (Playwright, production build) | ✅ **12 / 12 passed** |

Unit: money/date/slug helpers, scrypt hashing & verification, unique salts, CSV round-trip with quoted commas and
newlines, PDF structure + escaping + page breaks, lead scoring bounds, prompt constraints, Stripe signature accept /
tamper / wrong-secret / replay / missing-header.
Integration: plan seeds and prices, limit enforcement at exactly 100 leads, AI quota, tenant isolation across two
workspaces, token scoping, rate-limit windows, automation run-once + duplicate block + condition skip + daily limit +
dry-run produces no rows, password never stored in plaintext.
Route tests: webhook rejects unsigned/badly-signed requests, upgrades plan after a valid checkout, ignores duplicate
event ids, maps price → plan and stores period end, downgrades on subscription delete, marks past_due on failure;
capture endpoint closed without a key, rejects wrong key/invalid email/empty contact, creates a real lead, enforces the
plan limit.
E2E: marketing pages + links, signup → onboarding → empty dashboard (no fake metrics), lead create/search/filter/CSV
download, status change + note + rule-based scoring, proposal create → PDF bytes verified `%PDF-1.4` → client accepts in
a separate browser context → staff sees "Accepted by the client", tenant isolation for a second workspace,
unauthenticated redirects on 7 routes, AI "not configured" honesty, settings/billing/admin guards, logout, password
reset end-to-end with the new password, mobile drawer navigation.

Also verified outside the test suite: the PDF writer's output parses back with `pypdf` (3 pages, extractable text).

---

## 4. Remaining issues (honest list)
1. **Postgres adapter not wired.** RLS exists in SQL but is not active at runtime. This is the one deliberate gap —
   documented at the top of `src/lib/db.ts` and in README §7. Until it is done, do not market "RLS-protected".
2. **Integrations unverified against live services.** No Stripe, AI, Resend or Dropbox credentials existed here, so
   those paths were tested against their failure modes only. README §9 lists the manual checks to run once keys exist.
3. **No background queue.** Automation steps run inline. Fine for SMB volume; move to a queue before scale.
4. **No invoice/PDF billing history.** The billing page shows raw verified Stripe webhook deliveries instead.
5. **Team invites require an existing account.** Email-based invitations need the email provider configured.
6. **Next.js build warning** "The Next.js plugin was not detected in your ESLint configuration" — cosmetic; the same
   rules run through `npm run lint`, which passes.

---

## 5. Credentials required to go live
| Variable(s) | Unlocks |
| --- | --- |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_*` (4 + annual) | Checkout, portal, plan changes |
| `AI_API_KEY` (+ `AI_MODEL`, `AI_BASE_URL`) | Real AI generation instead of the rule-based fallback |
| `RESEND_API_KEY`, `EMAIL_FROM` | Sending approved email |
| `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REDIRECT_URI`, `DROPBOX_ACCESS_TOKEN` | Files in Dropbox instead of `data/uploads` |
| `DATABASE_URL` + Supabase keys | Production Postgres (after wiring the adapter) |
| `ADMIN_EMAIL` | Which account gets the admin panel |
| `LEAD_CAPTURE_KEY` | Public lead capture endpoint |
| `NEXT_PUBLIC_APP_URL` | Correct share links, PDFs and Stripe redirects |

---

## 6. First run
```bash
cd /home/user/bizpilot
npm install          # already installed
npm run db:migrate   # creates data/bizpilot.db, seeds 4 plans
npm run seed         # prints a working login
npm run dev          # http://localhost:3000
```
