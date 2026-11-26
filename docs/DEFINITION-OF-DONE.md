# Definition of done

A phase is done when every line below is true **and was executed**, not when the feature exists.

## Universal gates (run on every change)

- [ ] `npx tsc --noEmit` — clean, `strict`, no `any`
- [ ] `npx eslint .` — 0 errors, 0 warnings
- [ ] `npx vitest run` — all green
- [ ] `npx playwright test` — all green on PostgreSQL **and** SQLite
- [ ] `npm run build` — green
- [ ] `node scripts/build-schema.mjs --check` — snapshot matches migrations
- [ ] `/api/readiness` returns 200 locally

## Per-feature

- [ ] The happy path was exercised through the real UI or a real HTTP request
- [ ] The failure path was exercised too (bad input, permission denied, provider down)
- [ ] Authorisation is enforced **server-side**, and the UI merely reflects it
- [ ] Tenant isolation: a second workspace cannot see or touch the record
- [ ] No fake data, placeholder button, dead link, empty handler or simulated success
- [ ] Missing credentials produce a visible "not configured" state, never a pretend success
- [ ] Errors are surfaced (form error, `/forbidden`, error boundary) and logged with a digest
- [ ] Schema changes exist as a migration with a working `.down`
- [ ] A test covers the behaviour, and it fails when the behaviour is removed

## Phase map

| Phase | Deliverable | Status |
| --- | --- | --- |
| 0 | architecture audit, feature inventory, bug/security/db/deploy assessments, roadmap | ✅ `PHASE-REPORT.md` |
| 1 | audit report | ✅ `PHASE-REPORT.md` |
| 2 | Postgres migration, versioned migrations, rollback, RLS verified | ✅ `PHASE-2-REPORT.md` |
| 3 | security + multi-tenant isolation, roles, denial handling | ✅ `PHASE-3-REPORT.md` |
| 4 | auth + onboarding wizard (verification, reset, workspace, invites, progress) | ✅ |
| 5 | CRM: custom fields, filters, sort, pagination, CSV in/out, duplicates, bulk, timeline, notes, reminders, tags, scoring | ✅ |
| 6 | AI assistant: server-side, provider-configurable, structured output, cost tracking, approval gate | ✅ code · live **BLOCKED** (no key) |
| 7 | proposals: line items, discount, tax, currency, versions, PDF, expiring share link, accept/reject | ✅ |
| 8 | automation engine: event + scheduled triggers, conditions, multi-action, retries, limits, dry-run, pause | ✅ |
| 9 | team + documents: seats, revocation, role changes, secure upload/download | ✅ code · Dropbox live **BLOCKED** |
| 10 | Stripe billing: checkout, change plan, cancel, portal, webhooks, idempotency, entitlements | ✅ code · live **BLOCKED** |
| 11 | analytics: real queries, defined metrics, date filters, export | ✅ |
| 12 | UI/UX: dark + light, skeletons, empty/error/success states, toasts, confirmations, mobile nav, a11y | ✅ |
| 13 | email infra, API architecture, performance, QA journeys A–G, observability, deployment docs | ✅ code · Resend live **BLOCKED** |

"BLOCKED" always means the same thing: the integration is implemented, documented, shows an honest
"not configured" state, and cannot be *verified* without credentials. It is never reported as done.
