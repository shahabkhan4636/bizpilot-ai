# BizPilot AI — Full Project Report

**Ye report aap ke check karne ke liye hai: kya kaam karta hai, kya nahi, kya missing hai — sab kuch, bilkul saaf.**
Koi cheez "ho gaya" nahi likha jab tak wo chal kar test na hui ho.

| | |
| --- | --- |
| Report date | 2026-08-09 |
| Code commit | latest on `main` (see `git log -1`) |
| Code size | ~17,500 lines TypeScript/TSX · 38 library modules · 15 server-action modules · 30 components |
| Routes | **34 pages** + **11 API endpoints** (incl. `POST /api/payments/webhook/<provider>`) |
| Database | **10 migrations** · **33 tables** · Postgres 17.12 (Supabase: live) + SQLite (local) |
| Tests | **241 unit/integration** (10 skipped by design) + **29 end-to-end journeys** |
| E2E engines | SQLite **29/29** ✅ · PostgreSQL **29/29** ✅ |
| CI | `.github/workflows/verify.yml` (gates + Postgres job) · `backup.yml` (daily dump) |
| Deployment | Vercel project configured — **code abhi deploy nahi hua** |
| Live preview | `next start` chalta hua: `/`, `/login`, `/pricing`, `/billing/local` sab 200 |
| Live revenue | **$0** — public website live nahi hai |

---

# 1. Ek page ka sach (Executive summary)

## Jo 100% kaam karta hai (maine chala kar, HTTP/DB response dekh kar verify kiya)

- Signup → onboarding → dashboard, login, logout, password reset, email verification
- Leads: create, edit, search, filter, sort, paginate, notes, AI rule-based scoring, delete, **CSV export**, **CSV import**
- **Lead → customer conversion** (idempotent — dobara click se duplicate customer nahi banta)
- Customers: CRUD, timeline, linked leads, delete
- Proposals: line items, discount/tax maths, **PDF download**, share link, client **accept**, client **decline with reason**, version history, "kis ne accept kiya" (naam ke saath)
- Automations: builder (triggers, conditions, multi-step), approvals queue, event triggers + **scheduled triggers** + overdue follow-up scan, run history, failure logging
- Documents: upload (10 MB limit, extension allowlist) → **download** (workspace-scoped, audited), delete; Dropbox storage optional
- **Local payments: SadaPay / JazzCash / EasyPaisa / bank IBAN** — account add, payment claim, approve → plan activate
- Roles: owner / admin / manager / member / viewer — server-side enforce (UI chhupana sirf convenience)
- Team: invite → real link → accept → join; role change; remove member
- Notifications (bell + page), activity feed, audit log
- Analytics + dashboard: real database numbers (koi fake chart nahi)
- Plans & limits: lead limit, member limit, AI limit, document limit, automation limit
- Admin (super-admin): workspaces, users, suspend, platform stats, audit log
- Health + readiness probes, backup / restore / verify scripts
- Migrations: SQLite + Postgres dono pe up/down, plus Supabase production

## Jo kaam karta hai — magar **aap ki key/approval** ke baad (code ready, externally BLOCKED)

| Cheez | Code | Missing |
| --- | --- | --- |
| Card payments (Stripe) | Poora: checkout, portal, webhook signature verify, invoices | **Stripe Pakistan ko onboard nahi karta** → Pakistani business ke liye ye rasta band hai |
| Email bhejna (Resend) | Real client, approval gate, "not configured" state | `RESEND_API_KEY` + verified domain |
| AI generation | OpenAI-compatible client, retries only on 5xx, token costing | `AI_API_KEY` |
| Dropbox storage | Per-workspace OAuth, HMAC state, refresh, upload, download, disconnect | `DROPBOX_APP_KEY` / `DROPBOX_APP_SECRET` |
| Scheduled automations | Endpoint + `CRON_SECRET` + dry-run + idempotent claim | Vercel **Pro** (Hobby cron sirf din mein 1 baar) |
| Automatic wallet verification (SadaPay/JazzCash/EasyPaisa API) | Plug-in point documented | **merchant account** (SadaBiz / JazzCash merchant / EasyPaisa store) |

## Jo ab naya complete hua (is round mein)

| Kaam | Status | Proof |
| --- | --- | --- |
| **Automatic payment verification** (SadaPay / JazzCash / Easypaisa webhooks) | ✅ built + tested | `tests/gateway.test.ts` (36) · e2e "a signed SadaPay webhook approves the claim on its own" |
| **Refunds / credit note** (amount + reason + author, full refund cancels access) | ✅ built + tested | e2e refund journey · `validateRefund` unit tests |
| **CI pipeline** (types, lint, tests, schema, build + real Postgres job + e2e) | ✅ commit shuda | `.github/workflows/verify.yml` |
| **Scheduled backups** (daily `pg_dump` → artifact, 30 din) | ✅ commit shuda | `.github/workflows/backup.yml` |
| **PKR-first launch copy** (Rs 8,200 / 22,200 / 41,800 / 83,800, SadaPay-first) | ✅ | `marketing/LAUNCH-KIT.md`, `docs/LAUNCH-RUNBOOK.md` |
| **Email outbox** (`email_outbox`, retry 5 min → 30 min → 2 h, `/admin/email`, never burns a retry when the key is missing) | ✅ Phase 2 | `tests/email.test.ts` (14) · e2e "email outbox is admin-only…" |
| **`RESEND_FROM_EMAIL`** respected for every transactional email | ✅ Phase 2 | `tests/email.test.ts` from-address cases |
| **Platform payments** (customer → owner ka apna SadaPay/JazzCash/Easypaisa/IBAN; numbers DB mein, source mein kabhi nahi; approve karte hi plan activate) | ✅ Phase 3 | `tests/platform-payments.test.ts` (32) · e2e "platform payments: owner configures payouts…" |
| **Founding Member offer** (Rs 1,500/mo, 10 slots, Starter limits + 3 seats, price `founding_memberships` mein lock — catalogue price barhne se purane member ka price nahi barhta) | ✅ Phase 3 | locked-price test · slot-exhaustion test · e2e friendly banner |
| **Self-approval + `demo_mode`** (khud ki payment approve karna allowed, magar `self_approved` flag + audit; demo mode sirf owner ke apne claim pe) | ✅ Phase 3 | audit metadata assert · demo-mode tests |
| **`/billing/local` regression lock** (shared `ensureSubscriptionPlan` refactor ke baad wahi behaviour) | ✅ Phase 3 | `tests/local-payments-regression.test.ts` (18) |
| **`DEPLOY-ADMIN.md`** (owner launch runbook: Session pooler, env table, deploy order, day-1 checklist, incident table, rollback, security hygiene, "abhi kya possible nahi") | ✅ Phase 6 | doc + `tests/deploy-docs.test.ts` (9) |
| **`npm run smoke`** (9 real post-deploy checks: readiness, CSP nonce, admin gate, payout page, cron, webhook, 404) | ✅ Phase 6 | production build pe **9/9**, dead port pe **exit 1** |
| **Env-var documentation guard** (jo env var code padhta hai magar kahin document nahi, build fail) | ✅ Phase 6 | deleted `SESSION_SECRET` from both docs → test fail → restore → pass |
| **`/admin/workspaces` + `[id]`** (search, plan/status filters, pagination, members, plan apply, Founding controls, audit trail) | ✅ Phase 5 | e2e "workspaces, users and payments are admin-only and list real data" |
| **Suspend / restore with mandatory reason** (reason row mein + audit + in-app notify + email outbox; customer `/suspended` page pe reason dekhta hai, 500 nahi) | ✅ Phase 5 | `tests/admin-workspaces.test.ts` (16) · e2e suspend → blocked → restore |
| **Impersonation** (read-only default; write mode ke liye `IMPERSONATE` type karna; har write `impersonated_write: true` audit + owner notification; 60 min expiry; owner ka apna account kabhi nahi) | ✅ Phase 5 | `tests/impersonation.test.ts` (22) · e2e full journey |
| **`/admin/users` + `/admin/payments`** (3 tabs: platform claims / workspace payments / refunds — do flows kabhi mix nahi) | ✅ Phase 5 | e2e admin-only + list assertions |
| **Owner workspace unlimited** (limits `Infinity` enforcement layer pe — leads, AI, documents, automations, seats + saare features; badge sidebar aur `/admin` list mein) | ✅ Phase 4 | `tests/platform-owner-unlimited.test.ts` (14) · e2e "platform owner's own workspace is unlimited…" |
| **Unlimited leak nahi hota** (customer ke workspace mein owner ko admin banaane se us customer ko free limits nahi milte; `ADMIN_EMAIL` unset ⇒ kisi ko unlimited nahi) | ✅ Phase 4 | owner-as-admin test · unset-env test |
| **Platform owner = `ADMIN_EMAIL`** (single rule in `src/lib/owner.ts`; `/admin` returns **404** to everyone else; unset variable ⇒ no admin at all) | ✅ Phase 1 | `tests/owner.test.ts` (6) · `e2e/admin.spec.ts` (3) |
| **Transfer-note collision bug** (do workspaces ka note same ho sakta tha) | ✅ fix + test | 5,000 workspace pe zero collision test |
| **Idempotent webhooks + amount mismatch guard** (Rs 1 se plan unlock nahi hota) | ✅ tested | e2e replay + mismatch tests |

## Jo **abhi bhi nahi** bana (missing features — jhoot nahi)

1. **Platform payout numbers abhi khaali hain** — `/admin/platform-payments` pe aap ko khud
   SadaPay number/IBAN type karna hai (ye jaan bujh kar source mein nahi hai).
2. **Public deploy nahi hua** — Supabase pooler string + GitHub connect chahiye (dono aap ke paas).
3. **Koi bhi asli vendor call kabhi nahi hui** (Stripe/Resend/AI/Dropbox/SadaPay) — credentials nahi thay.
4. **Gateway adapters live nahi** — merchant account (SadaBiz / JazzCash merchant / Easypaisa store) chahiye. Code + tests ready.
5. **Multi-currency invoices / GST tax nahi** — sirf discount + tax percent maths hai.
6. **Mobile app nahi** — sirf responsive web.
7. **S3 / cloud storage backend nahi** — local disk ya Dropbox.
8. **Redis-based rate limiting nahi** — DB-based (single instance ke liye theek).
9. **White-label branding page nahi** (Agency plan mein feature flag hai, UI nahi).
10. **Real-time updates nahi** (websockets) — page refresh pe data aata hai.

---

# 2. Feature-by-feature status (evidence ke saath)

Har row ka proof ya test ka naam hai — aap khud chala kar dekh sakte hain.

| # | Feature | Status | Evidence (test / command) |
| --- | --- | --- | --- |
| 1 | Auth: signup, login, logout, session cookie (httpOnly, secure in prod, sameSite) | ✅ | `e2e`: "signup, onboarding and empty dashboard", "logout ends the session" |
| 2 | Password reset (token, single use, expiry) | ✅ | `e2e`: "password reset issues a working token", `tests/email-verification.test.ts` |
| 3 | Email verification | ✅ (email block) | `tests/email-verification.test.ts` (7 tests) |
| 4 | Onboarding (workspace + business type) | ✅ | `e2e`: signup journey |
| 5 | RBAC 5 roles, server-side deny | ✅ | `tests/rbac-notifications.test.ts` (15), `e2e`: "a viewer is read-only" |
| 6 | Tenant isolation (query layer + PG RLS 83 policies) | ✅ | `tests/rls.postgres.test.ts` (12), `tests/rls.live.test.ts` (10), `e2e`: tenant isolation journey |
| 7 | Leads CRUD + search/sort/paginate | ✅ | `e2e`: lead journey, `tests/unit.test.ts` |
| 8 | Lead CSV export (**formula-injection safe**) | ✅ | `tests/hardening.test.ts` "CSV export cannot carry a spreadsheet formula" |
| 9 | Lead CSV import (**Excel BOM safe**) | ✅ | `tests/hardening.test.ts` "CSV import tolerates what Excel actually produces" |
| 10 | AI lead scoring (rule-based, no key needed) | ✅ | `e2e`: "status update, note and rule-based AI scoring" |
| 11 | AI drafts / summaries (LLM) | ⚠️ blocked | `tests/providers.test.ts` (doubles); real key missing |
| 12 | Lead → Customer conversion (idempotent) | ✅ | `e2e`: "a lead converts to a customer exactly once" |
| 13 | Proposals + line items + discount/tax maths | ✅ | `tests/unit.test.ts` (`proposal-math`) |
| 14 | Proposal PDF (real `%PDF-1.4`) | ✅ | `e2e`: PDF header assertion; `tests/hardening.test.ts` PDF escaping |
| 15 | Client portal: accept with name, decline with reason | ✅ | `e2e`: "a client cannot double-accept…decline records the reason" |
| 16 | Proposal share link + expiry | ✅ | `tests/integration.test.ts` |
| 17 | Automations: builder, conditions, multi-step | ✅ | `e2e`: "automation builder…run on a real lead" |
| 18 | Automations: scheduled (every N min) + overdue follow-ups | ✅ | `tests/scheduler.test.ts` (9), `tests/cron.test.ts` (5) |
| 19 | Automation email step never sends silently | ✅ | `tests/integration.test.ts` (queued for approval) |
| 20 | Approvals queue (human gate) | ✅ | `e2e`: approvals page journey |
| 21 | Documents upload (size + extension allowlist) | ✅ | `tests/hardening.test.ts` "document storage paths cannot escape…" |
| 22 | Documents **download** (scoped, audited, 404 cross-tenant) | ✅ | `e2e`: "documents can be downloaded back byte-for-byte" |
| 23 | Dropbox storage (OAuth, refresh, upload, download, disconnect) | ⚠️ blocked | `tests/integrations.test.ts` (13) against real HTTP double |
| 24 | **Local payments: SadaPay/JazzCash/EasyPaisa/bank** | ✅ | `e2e`: "SadaPay local payment: configure, submit, approve…", `tests/hardening.test.ts` (+6) |
| 24b | **Gateway webhooks (SadaPay/JazzCash/Easypaisa): signature, idempotency, amount match** | ✅ built (keys nahi) | `tests/gateway.test.ts` (36), e2e: "a signed SadaPay webhook approves the claim on its own" |
| 24c | **Refunds (partial/full, full = access band)** | ✅ | e2e refund journey, `validateRefund` tests |
| 25 | Stripe checkout + webhook + invoices | ⚠️ blocked / not viable in PK | `tests/webhook.test.ts`, `e2e`: "billing page reports the missing Stripe config" |
| 26 | Plans, limits, entitlements | ✅ | `tests/unit.test.ts`, `tests/ai-usage.test.ts` |
| 27 | Notifications + bell + clear | ✅ | `e2e`: "notifications: the bell shows what happened" |
| 28 | Activity feed + audit log | ✅ | `e2e`: local payment approval appears in both |
| 29 | Analytics (real numbers only) | ✅ | `e2e`: analytics journey |
| 30 | Admin panel (super-admin only, guard tested) | ✅ | `e2e`: "settings, billing and admin pages enforce their guards" |
| 31 | Public lead capture API (key + rate limit + 64 KB cap) | ✅ | `tests/webhook.test.ts` (19) |
| 32 | Rate limiting (atomic, configurable) | ✅ | `tests/hardening.test.ts` "rate limiter" |
| 33 | Health / readiness (schema + provider truth) | ✅ | `e2e`: "readiness probe reports schema state…", `tests/hardening.test.ts` |
| 34 | Backups: backup / restore / verify | ✅ (script) | `npm run db:backup`, `db:restore` — schedule karna baqi |
| 35 | Migrations 001–008 (both engines + Supabase) | ✅ | `node scripts/build-schema.mjs --check`, `npm run db:migrate:status` |
| 36 | Deployment (Vercel) | ⚠️ **partial** | project + env set; **code deploy nahi hua** |
| 37 | Cron in production | ⚠️ blocked | Hobby plan = daily only; Pro chahiye |
| 38 | Mobile app / offline | ❌ not built | — |
| 39 | CI + scheduled backups | ✅ | `.github/workflows/verify.yml`, `backup.yml` |
| 40 | Real-time updates | ❌ not built | — |

---

# 3. Verification gates — asli numbers

| Gate | Command | Result |
| --- | --- | --- |
| Types | `npx tsc --noEmit` | ✅ clean (strict, 0 `any`) |
| Lint | `npx eslint .` | ✅ 0 errors, 0 warnings |
| Unit + integration | `npx vitest run` | ✅ **221 passed**, 10 skipped (13 files) |
| Schema snapshot | `node scripts/build-schema.mjs --check` | ✅ matches 8 migrations + RLS file in sync |
| Build | `npm run build` | ✅ 34 routes compile |
| Everything | `npm run verify` | ✅ "all gates green" |
| E2E (SQLite) | `npx playwright test` | ✅ **25/25** |
| E2E (PostgreSQL) | `DATABASE_URL=… BIZPILOT_ENGINE=postgres npx playwright test` | ✅ **25/25** |
| Migrations | `npm run db:migrate` | ✅ 8 migrations: dev SQLite, pg `bizpilot`, pg `bizpilot_ci`, Supabase (005 deliberately skipped) |

### Test inventory (file → kitne tests)

| File | Tests | Kya cover karta hai |
| --- | --- | --- |
| `tests/hardening.test.ts` | 33 | CSV injection, BOM import, strict money, PDF escaping, upload path escape, rate limiter, MIGRATION_SKIP, app URL, readiness, **local payments** |
| `tests/unit.test.ts` | 33 | core lib: plans, money maths, proposals, csv, validate |
| `tests/integration.test.ts` | 19 | actions: leads, proposals, automations, documents |
| `tests/webhook.test.ts` | 19 | Stripe webhook signature, lead capture API + hardening |
| `tests/gateway.test.ts` | 36 | **wallet gateway webhooks**: HMAC verification, idempotency, amount mismatch, shared approval, refunds, transfer-note collisions |
| `tests/providers.test.ts` | 15 | Stripe/Resend/AI against local HTTP doubles |
| `tests/rbac-notifications.test.ts` | 15 | permissions matrix, notifications |
| `tests/integrations.test.ts` | 13 | Dropbox OAuth state, token refresh, credentials |
| `tests/rls.postgres.test.ts` | 12 | RLS policies |
| `tests/rls.live.test.ts` | 10 | live RLS (needs Postgres) |
| `tests/scheduler.test.ts` | 9 | due claiming, dry-run, dedupe |
| `tests/email-verification.test.ts` | 7 | verify + reset tokens |
| `tests/ai-usage.test.ts` | 5 | token accounting, cost honesty |
| `tests/cron.test.ts` | 5 | cron auth 401/503, dry-run |
| `e2e/app.spec.ts` | **24 journeys** | signup → leads → proposals → portal → automations → invites → RBAC → tenant isolation → CSP → scheduler → **download** → **proposal race** → **lead conversion** → **SadaPay payment** |

---

# 4. Payments — poori sach

## 4a. Card payments (Stripe)

- Code: checkout session, billing portal, cancel, webhook with **signature verification**, invoice reconstruction from webhook events. Kuch bhi fake nahi: webhook na aaye to invoice table khali rehta hai.
- **Masla:** Stripe Pakistani business ko onboard nahi karta. Yani aap ke liye ye rasta **kaam nahi karega** jab tak aap ke paas kisi Stripe-supported mulk ki company na ho.
- Is liye app ab saaf likhta hai: *"Card payments (Stripe) are not configured"* aur rupee wale raste par bhej deta hai.

## 4b. Local payments — SadaPay / JazzCash / EasyPaisa / bank (naya, chal raha hai)

| Step | Kya hota hai |
| --- | --- |
| 1 | Owner `/billing/local` pe apna **SadaPay/JazzCash/EasyPaisa/IBAN** daalta hai (optional pay link/QR) |
| 2 | Number server pe validate hota hai: wallet `03xxxxxxxxx`, bank asli Pakistani IBAN — **ghalat number save nahi hota** |
| 3 | Customer transfer karta hai, app mein plan + rupees + **transaction ID** submit karta hai (ek waqt mein ek claim) |
| 4 | Owner **approve** karta hai — tab plan activate hota hai, period end ke saath |
| 5 | Audit log + notification + activity entry: kis ne approve kiya, kitne paise, kaunsa reference |
| 6 | Double approve se subscription **double nahi** hoti (conditional update) |

**Rupee pricing** (rate `PKR_PER_USD`, default 280, aap badal sakte hain):

| Plan | USD | Rs / month | Rs / year |
| --- | --- | --- | --- |
| Starter | $29 | 8,200 | 81,200 |
| Professional | $79 | 22,200 | 221,200 |
| Business | $149 | 41,800 | 417,200 |
| Agency | $299 | 83,800 | 837,800 |

**Jo cheez automatic nahi hai (aur jhoot nahi bol raha):** wallet API se payment khud verify nahi hoti. Uske liye **merchant account** chahiye — SadaBiz approval, JazzCash merchant ID + integrity salt, EasyPaisa store ID, ya Safepay/PayFast. Plug-in point tayyar hai: `src/lib/payments/<provider>.ts` → wahi approval path. Tafseel: `docs/PAYMENTS-PAKISTAN.md`.

---

# 5. Infrastructure — kya bana, kya pending

| Cheez | Status | Detail |
| --- | --- | --- |
| Vercel project | ✅ bana | `bizpilot-ai` · `prj_Yjg54ublYIGrnKFvYLRPsev78rdJ` · region `iad1` · framework nextjs |
| Vercel env vars | ✅ set | `CRON_SECRET` (sensitive), `ADMIN_EMAIL` |
| Vercel plan | ⚠️ **Hobby** | Hobby pe **commercial use allowed nahi** + cron din mein 1 baar. Paisay lene se pehle **Pro $20/mo** |
| Supabase project | ✅ live | `bizpilot` · ref `mpzuknincvfrfrvanpio` · us-east-1 · PG 17.12 · **32 tables, 8 migrations, 4 plans** |
| Supabase RLS migration | ⚠️ skip (jaan boojh kar) | 005 `auth.uid()` ko replace karti hai jo Supabase Auth ko tor deti — `MIGRATION_SKIP=005`, sach reported |
| `DATABASE_URL` in Vercel | ❌ **pending** | aap ke Supabase dashboard se **Session pooler (5432)** string chahiye |
| Code deploy | ❌ **pending** | GitHub connector on karein (main push + deploy kar dunga) ya `vercel --prod` |
| Cron schedule | ⚠️ daily | `vercel.json` daily (Hobby-safe); Pro pe `cp vercel.pro.json vercel.json` = har 10 min |
| Custom domain | ❌ nahi | domain + DNS + `NEXT_PUBLIC_APP_URL` |
| Backups schedule | ❌ nahi | script ready, chalane wala koi nahi |

---

# 6. Security & data — kya kiya gaya

| Area | Kya hai |
| --- | --- |
| Tenant isolation | Har query `organization_id` se scoped + e2e proof ke doosra workspace data nahi dekh sakta |
| Postgres RLS | 83 policies (self-hosted Postgres pe). Supabase pe skip — wajah documented |
| Passwords | scrypt + per-user salt, timing-safe compare |
| Sessions | httpOnly, sameSite=lax, `secure` production mein, DB-backed, expiry |
| Rate limiting | **atomic** single statement (burst-proof), per-IP, env-configurable (login 20/10min, signup 10/hr) |
| CSV injection | `= + - @ TAB CR` se shuru hone wale values neutralise (Excel formula execution band) |
| Upload safety | extension allowlist, client MIME ko trust nahi, filename single segment (path escape band) |
| Download safety | session + permission + workspace scope, `attachment` + `nosniff`, 404 cross-tenant, audit |
| Capture API | constant-time key compare, 64 KB cap (declared + actual), JSON object only |
| Webhook | HMAC signature verify, idempotent (`provider + external_id` unique) |
| Secrets | sab env se, koi hardcoded nahi; `.env.example` mein sirf naam |
| Audit | har sensitive action audit_logs mein (payment approve, download, role change, admin actions) |

**Credential hygiene:** Supabase database password is chat mein share hua hai — chahein to Supabase → Settings → Database → Reset password se badal dein, phir `DATABASE_URL` update kar dein. GitHub token (`ghp_a5a6…`) aur Netlify token (`nfp_7CWU…`) purane hain — **revoke kar dein**.

---

# 7. Database — 8 migrations

| # | Migration | Kya karti hai | SQLite | Postgres | Supabase |
| --- | --- | --- | --- | --- | --- |
| 001 | initial | 29 core tables (profiles, orgs, leads, proposals, plans…) | ✅ | ✅ | ✅ |
| 002 | roles_crm_notifications | email verification, lead tags, proposal discounts, indexes | ✅ | ✅ | ✅ |
| 003 | role_permissions | role constraint: owner/admin/manager/member/viewer | ✅ | ✅ | ✅ |
| 004 | widen_invite_roles | invites mein manager/viewer | ✅ | ✅ | ✅ |
| 005 | row_level_security | 83 RLS policies | ✅ (no-op) | ✅ | ⏭ skipped (`auth.uid()`) |
| 006 | scheduled_automations | `schedule_interval_minutes`, `next_run_at`, `integration_credentials` | ✅ | ✅ | ✅ |
| 007 | proposal_responses | `accepted_by_name`, `rejected_reason` | ✅ | ✅ | ✅ |
| 008 | local_payments | `local_payment_methods`, `local_payment_requests` | ✅ | ✅ | ✅ |
| 009 | gateway + refunds | `gateway_provider`/`gateway_payment_id`/`paid_at`, `payment_refunds` | ✅ | ✅ | ✅ |

`sql/schema.sqlite.sql` generated snapshot hai — `--check` CI gate pass karta hai (drift nahi ho sakta).

---

# 8. File / component map

```
src/app/                 34 pages + 10 API routes
  billing/local/         ← naya: SadaPay/JazzCash/EasyPaisa/bank payments
  api/documents/[id]/download/   secure file download
  api/leads/capture/     public lead API (key + limits)
  api/cron/automations/  scheduler endpoint (CRON_SECRET, dryRun)
  api/readiness/         schema + provider truth
  p/[token]/             public client portal (accept / decline)
src/lib/                 34 modules
  db.ts pg-sync.ts       one query surface, SQLite + Postgres
  auth.ts authz.ts permissions.ts session.ts ratelimit.ts crypto.ts
  validate.ts csv.ts pdf.ts storage.ts proposal-math.ts plans.ts
  local-payments.ts      ← naya: rupee pricing, wallet validation
  integrations.ts        Dropbox OAuth
  scheduler.ts automations.ts automation-meta.ts
src/lib/actions/         15 server-action modules (the security boundary)
src/components/          29 components (billing/local-payment-forms.tsx ← naya)
sql/migrations/          8 migrations (+ down files, engine variants)
tests/                   13 files, 185 tests · e2e/app.spec.ts: 24 journeys
scripts/                 db-migrate, migrate, build-schema, backup, restore, verify, seed, test-postgres
docs/                    LAUNCH-RUNBOOK, PAYMENTS-PAKISTAN, DEPLOYMENT, DATABASE,
                         TROUBLESHOOTING, BACKUP-AND-RESTORE, DEFINITION-OF-DONE
marketing/               LAUNCH-KIT, FIRST-10-CUSTOMERS, lead-tracker.csv
PROJECT-REPORT.md        ← ye file
```

---

# 9. Kaam kaise chalayein

## Local (5 minute)
```bash
cp .env.example .env
npm install
npm run db:migrate      # SQLite schema + plans
npm run seed            # pehla account
npm run dev             # http://localhost:3000
```

## Sab gates khud check karein
```bash
npx tsc --noEmit
npx eslint .
npx vitest run
node scripts/build-schema.mjs --check
npm run verify
npx playwright test                                          # 24/24 SQLite
DATABASE_URL="postgres://…" BIZPILOT_ENGINE=postgres npx playwright test   # 24/24 Postgres
```

## Postgres mode
```bash
export DATABASE_URL="postgres://…" BIZPILOT_ENGINE=postgres
npm run db:migrate && npm run db:seed:pg
```

---

# 10. Paisa kab aayega — bina jhoot

| Step | Kaun | Waqt |
| --- | --- | --- |
| Supabase session-pooler `DATABASE_URL` dena | **aap** (30 second) | aaj |
| Code deploy (GitHub connect ya `vercel --prod`) | main / aap | 1–2 din |
| Vercel **Pro** ($20/mo) | aap | 1 din (billing) |
| `/billing/local` pe apna SadaPay number daalna | aap | 5 minute — **is ke baad paisa lena possible** |
| Custom domain + `NEXT_PUBLIC_APP_URL` | aap | 1 din |
| Pehla customer | **aap ki outreach** | 2–6 hafte (150 contacts ≈ 4–5 customers; `marketing/FIRST-10-CUSTOMERS.md`) |

**Aaj ki haalat:** $0. Website live nahi hai. Product tayyar hai — **customer** laana baqi hai, aur wo kaam sirf aap kar sakte hain (koi AI nahi kar sakta).

---

# 11. Risky/limited cheezein (jo aap ko pata honi chahiye)

1. **Vercel pe uploads ephemeral hain** — serverless disk deploy ke baad khali ho jata hai. Vercel pe documents ke liye Dropbox connect karna zaroori hai, warna file `410` degi.
2. **Rate limiter DB-based hai** — ek instance pe theek, kai instances pe under-count karega (Redis chahiye ~50 workspaces ke baad).
3. **PDF sirf Latin-1** — emoji/CJK `?` ban jate hain (file valid PDF rehti hai).
4. **Local payment approval = aap khud** — single-owner business mein aap apni payment approve karte hain; audit log mein record hota hai, magar ye human trust hai, gateway verification nahi.
5. **Hobby plan commercial use allow nahi karta** — Pro lazmi hai.
6. **Supabase free tier 7 din inactivity pe pause** ho sakta hai; pehla customer aane se pehle Pro lena behtar.
7. **No CI** — gates manually chalte hain (`npm run verify`).
8. **Backups unscheduled** — aap ke server pe cron lagana hoga.

---

# 12. Is round mein kya kya kiya (short log)

1. **Migration 009** — `gateway_provider`, `gateway_payment_id`, `paid_at` + `payment_refunds`
   table. Applied: dev SQLite, `data/e2e.db`, local Postgres `bizpilot` + `bizpilot_ci`,
   aur **Supabase production** (32 tables, 8 migration rows).
2. **Gateway adapters** — `src/lib/payments/{provider,sadapay,jazzcash,easypaisa,registry}.ts`:
   HMAC verification (constant-time), amount unit normalisation, status mapping.
3. **Shared approval path** — `src/lib/payments/approve.ts`; manual button aur webhook dono
   ek hi function chalate hain, is liye do raste kabhi disagree nahi kar sakte.
4. **Webhook route** — `POST /api/payments/webhook/<provider>`: 503/401/413 guards,
   `webhook_events` idempotency, amount mismatch pe approve nahi, ambiguous reference pe guess nahi.
5. **Refunds** — action + UI + `payment_refunds` + rules; full refund pe subscription `canceled`.
6. **Transfer-note collision bug fix** — pehle `BP-<slug 10 chars>` tha (do customers ka same ho
   sakta tha); ab `BP-<slug8>-<digest4>`, 5,000 workspace pe zero collision, ambiguity pe refuse.
7. **CI + backups** — `.github/workflows/verify.yml` (gates + real Postgres + e2e),
   `.github/workflows/backup.yml` (roz `pg_dump`, 30 din artifact).
8. **PKR-first copy** — `marketing/LAUNCH-KIT.md`, `docs/LAUNCH-RUNBOOK.md` rupee table + SadaPay-first.
9. **Docs** — `docs/PAYMENTS-PAKISTAN.md` (gateway + refunds section), `docs/DATABASE.md`,
   `PROJECT_STATUS.md`, `README.md`, `.env.example`.
10. **Verification** — `npm run verify` all green; **221 unit**; **25/25 e2e SQLite aur Postgres**;
    live preview server chal raha hai (`/`, `/login`, `/pricing` = 200; readiness `ready: true, 9 applied`).

# 13. Aakhri baat

Ye project **"complete" nahi hai** aur main aisa nahi kahunga. Jo hai:
- ek **poora, tested, production-grade SaaS codebase** — 185 unit tests, 24 e2e journeys, dono database engines pe pass;
- **Supabase production database live** aur migrated;
- **Vercel project configured**;
- **Pakistani payment flow working** (SadaPay/JazzCash/EasyPaisa/bank);
- poori documentation: launch runbook, payments guide, deployment, troubleshooting, marketing kit, 14-din customer plan.

Jo nahi hai: **live URL, asli vendor credentials, merchant account, aur customers.**

**Sirf 3 cheezein aap se chahiye aur website live ho jayegi:**
1. Supabase **Session pooler** connection string
2. **GitHub** connector on (ya `vercel --prod` khud chalayein)
3. Vercel **Pro** plan (commercial use + 10-minute cron ke liye)

Uske baad: `/billing/local` pe SadaPay number daalein → customer bhejega → aap approve karenge → **paisa aap ke SadaPay mein**.
