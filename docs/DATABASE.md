# Database

One query surface (`src/lib/db.ts` → `all/get/run/one`) on two engines:

| Engine | When | Notes |
| --- | --- | --- |
| PostgreSQL 15+ | production, CI, `DATABASE_URL` set | true concurrency, RLS policies, `pg` driver |
| SQLite (`better-sqlite3`) | local dev, e2e on a scratch file | single writer, no RLS (isolation comes from the query layer) |

Choosing: `isPostgresEngine()` is `Boolean(DATABASE_URL)` (or `BIZPILOT_ENGINE=postgres`). Write
statements use `?` placeholders everywhere; `src/lib/pg-sync.ts` rewrites them to `$n` and asserts
that the placeholder count matches the parameter count, so a typo fails with both numbers instead of
an opaque protocol error.

## Migrations

```
sql/migrations/001_initial.up.sql              portable up
sql/migrations/001_initial.down.sql            portable down
sql/migrations/003_role_permissions.up.postgres.sql   engine-specific (table rebuild differs)
sql/migrations/003_role_permissions.up.sqlite.sql
```

```bash
npm run db:migrate                       # apply everything pending
node scripts/db-migrate.mjs --status      # what is applied / pending
node scripts/db-migrate.mjs --down 1      # roll back one migration
node scripts/db-migrate.mjs --to 002      # roll back to a specific id
node scripts/db-migrate.mjs --baseline    # mark all applied on a DB created from the snapshot
```

Rules:

- **Additive by default.** New columns are nullable or have defaults; drops and renames go through a
  table rebuild with an explicit `.down`.
- **`--baseline` is not a shortcut.** It records migrations as applied without running them, so only
  use it when the database really was created from `sql/schema.sqlite.sql` or an equivalent dump.
  Using it to "fix" a failed migration leaves the schema wrong and the bookkeeping lying.
- **Never edit an applied migration.** Add the next number instead; the checksum in
  `schema_migrations` exists to catch this. The one exception is the literal `snapshot` checksum,
  written when a database was created from the consolidated snapshot: there is no per-file checksum
  to compare, so the runner treats it as unknown rather than as edited history.
- **`sql/schema.sqlite.sql` is generated**: `npm run db:schema`. CI runs
  `node scripts/build-schema.mjs --check` and fails if the snapshot is stale.

## Row-level security

The 83 policies over 26 tables ship **inside the migration chain** as
`005_row_level_security` — a from-scratch `npm run db:migrate` is protected exactly like an upgraded
database. (They used to live only in `sql/rls.postgres.sql`, applied by the docker helper scripts, so
a fresh production deploy silently had *no* policies. Migration 005 is generated from that file by
`npm run db:schema`, and `--check` fails if the two drift.)

All policies are keyed on the caller's organisation membership. It is defence in depth: the application layer already scopes every query by
`organization_id`, and RLS catches a query that forgets. Two things to remember when testing it:

- the table **owner bypasses RLS** unless `FORCE ROW LEVEL SECURITY` is set, so tests connect as a
  non-owner role;
- policy changes need `drop … cascade` on the way down (see `003_*.down.postgres.sql`);
- the SQLite variant of 005 is a documented no-op (SQLite has no policies; isolation there is the
  query layer, asserted by the test suite).

## Migrations 001–006 at a glance

| # | What it does |
| --- | --- |
| 001 | initial portable schema |
| 002 | roles, email verification, notifications, CRM tags, proposal financials |
| 003 | role CHECK constraint (engine-specific rebuild) |
| 004 | widen `org_invites.role` so manager/viewer invitations are accepted |
| 005 | row-level security (generated from `sql/rls.postgres.sql`) |
| 006 | scheduled automations (`schedule_interval_minutes`, `next_run_at`) + `integration_credentials` |

## Plan catalogue

`npm run db:migrate` also applies `sql/seed_plans.sql` (idempotent upserts) and prints
`✔ plan catalogue in place (4 plans)`. This is not cosmetic: `subscriptions.plan_code` references
`plans(code)`, so an empty catalogue makes the very first signup fail with a foreign-key error.

## Test data

```bash
npm run seed              # SQLite demo workspace
npm run db:seed:pg        # Postgres demo workspace
```

Seeded logins are in `PROJECT_STATUS.md`. **Rotate or delete them before a real deployment.**

## When the app boots

`src/lib/db.ts` applies the schema snapshot statement-by-statement on first use. This is what lets a
local database pick up a newly added table without a manual step. `create table/index if not exists`
is idempotent; `alter table … add column` is not, so only "already there" errors are ignored and any
other failure is raised with the offending statement attached. In production, migrations run from CI
instead of at boot.
