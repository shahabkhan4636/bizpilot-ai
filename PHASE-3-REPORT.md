# BizPilot AI — Phase 3 report: it runs on PostgreSQL, proven

**Date:** 9 August 2026 · **Goal you set:** "do each and every thing to make it work, don't stop until it works."

---

## 1. The headline

The app no longer runs on SQLite only. It now runs on **PostgreSQL 17.12** with the same code path, and every gate has
been executed green against that database — not simulated, not mocked:

| Gate | SQLite engine | PostgreSQL 17.12 engine |
| --- | --- | --- |
| `npx tsc --noEmit` | clean | clean |
| `npx eslint .` | clean | clean |
| `npx vitest run` | **72 passed** (+10 RLS skipped) | **82 passed** (incl. 10 live RLS) |
| `npx next build` | 39 routes | 39 routes |
| `npx playwright test` | **15 passed** | **15 passed** |
| `/api/health` | `ok:true` | `{"ok":true,"engine":"postgres","tables":26,"plans":4}` |

One command proves the Postgres side end to end:

```bash
DATABASE_URL=postgres://… npm run test:postgres
# typecheck → lint → migrate → vitest → build → playwright, all on Postgres
```

---

## 2. How it works (the part that was supposed to be hard)

The data layer is synchronous (`better-sqlite3` heritage, **304 call sites**), and every Node Postgres client is
asynchronous. Rewriting 304 call sites would have risked the working app. Instead:

* `scripts/pg-worker.mjs` — a worker thread owns the real `pg` connection.
* `src/lib/pg-sync.ts` — the main thread posts the query and blocks on a `SharedArrayBuffer` with `Atomics.wait` until
  the rows come back. Callers see the same synchronous `all/get/run/tx` they always did.
* The worker normalises the dialect every time, so no call site changed:
  * `?` placeholders → `$1…$n` (quote-aware, never rewrites inside strings)
  * `LIKE` → `ILIKE` (SQLite's `LIKE` is case-insensitive, Postgres's is not — search results stay identical)
  * `bigint`/`numeric` → JS numbers, so `count(*)` is a number on both engines
* `src/lib/db.ts` picks the engine from `DATABASE_URL`. Empty → SQLite file. Set → Postgres. No flags to remember.

**Trade-off, stated plainly:** a query blocks the Node process while it runs — exactly as `better-sqlite3` already did.
Invisible at SMB volume; for high concurrency, move the hot paths to async queries.

---

## 3. The database

`sql/schema.sqlite.sql` was rewritten to be **portable SQL** (no `PRAGMA`, no SQLite-only functions, foreign keys
declared after their targets) so the *same file* creates the identical 26 tables on both engines. That removes the
"two schemas drift apart" failure mode entirely.

New files:

| File | Purpose |
| --- | --- |
| `sql/rls.postgres.sql` | **83 RLS policies across all 26 tables**, plus `auth.uid()`, `auth_user_org_ids()`, `is_super_admin()` |
| `scripts/migrate-pg.mjs` | `npm run db:migrate:pg` — schema + plan seed + policies, idempotent |
| `tests/rls.live.test.ts` | 10 assertions executed against a **live** server from a **non-owner** role |
| `src/app/api/health/route.ts` | Real health probe: engine, table count, plans, query latency |
| `Dockerfile`, `docker-compose.yml`, `.dockerignore` | App + Postgres 17, healthcheck-gated, `docker compose up -d --build` |
| `.github/workflows/ci.yml` | CI runs **both engines** — SQLite job and a Postgres 17 service job running the browser suite |
| `scripts/test-postgres.mjs` | The whole gate against Postgres in one command |

`scripts/seed.mjs` is now engine-aware: `node scripts/seed.mjs --postgres --demo` seeds a real login into Postgres.

---

## 4. Security: what RLS actually protects

The app connects as the **owner** of the tables, so its own queries bypass RLS — the same trust level as Supabase's
`service_role`. RLS is what protects **every other connection**: an anon key, psql, a BI tool, a compromised read-only
user. That is proven, not claimed:

```
tests/rls.live.test.ts (10 passed, live PostgreSQL 17, role bizpilot_anon)
  ✔ runs as a non-owner role (the only configuration where RLS applies)
  ✔ sees only its own workspace's leads
  ✔ cannot read another workspace's lead even by primary key
  ✔ cannot insert a lead into another workspace   (throws: row-level security policy)
  ✔ cannot update or delete another workspace's lead (rowCount 0, data unchanged)
  ✔ cannot read another workspace's members or invites
  ✔ cannot see profiles outside its workspace
  ✔ a super admin sees every workspace
  ✔ can read the public plan catalogue but cannot change prices
  ✔ cannot read webhook events or rate limits
```

Keep the app's database credentials server-side. Never ship them to a browser.

---

## 5. Live preview — now Postgres-backed

`npx next start -H 0.0.0.0 -p 3000` with `DATABASE_URL` set:

```
GET /api/health → {"ok":true,"engine":"postgres","migrated":true,"tables":26,"plans":4,"leads":3,"latencyMs":3}
```

| Account | Email | Password | Notes |
| --- | --- | --- | --- |
| Demo workspace | `demo@bizpilot.local` | `BizPilotDemo123` | Starter trial + 3 labelled sample leads, all in Postgres |
| Super admin | `shahabkhanprofessional@gmail.com` | `BizPilotAdmin123` | `/admin` panel |

Also verified over real HTTP against Postgres: the public capture API wrote a lead
(`201 {"ok":true,…}` → row present in the `leads` table), and `/dashboard` → `307 → /login` without a session.

---

## 6. Deployment — now actually possible

Before this phase, a Vercel deploy would have lost data on every cold start. That blocker is gone:

```bash
# Self-hosted (app + Postgres 17, healthchecked)
cp .env.example .env
docker compose up -d --build
docker compose exec app node scripts/seed.mjs --postgres --demo

# Or any managed Postgres (Supabase / Neon / RDS) + Vercel
export DATABASE_URL="postgres://…"
npm run db:migrate:pg
npm run build && vercel --prod
```

I did not deploy to a public host: the only credentials available here were a GitHub token (used — repo pushed) and a
Netlify token, and neither gives a durable managed Postgres. Everything needed to deploy is now in the repository and
verified locally on real PostgreSQL 17.

---

## 7. What is still not real (unchanged, and I will not pretend otherwise)

1. **Third-party credentials.** No Stripe, AI, Resend or Dropbox keys exist in this environment. Those paths are
   verified against their *missing-credential* behaviour — the checkout button, the webhook signature verification, the
   "AI not configured" banner, the "approved, unsent" email state. No live charge, generation or delivery has happened.
2. **No queue worker.** Automation steps run inline on the triggering request.
3. **Tokens to revoke.** The GitHub token (`ghp_a5a6…`) and Netlify token (`nfp_7CWU…`) you pasted are still valid.
   Revoke them: <https://github.com/settings/tokens>, <https://app.netlify.com/user/applications>.

---

## 8. Repository

<https://github.com/shahabkhan4636/bizpilot-ai> — public, `main`, with CI that runs both engines.
