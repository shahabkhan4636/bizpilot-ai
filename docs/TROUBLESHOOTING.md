# Troubleshooting

Start here: `GET /api/readiness`. It reports `ready`, the engine, `schema`/`migrations` checks and
which providers are configured, and returns **503** when a check fails. Most incidents are one line
in that response.

| Symptom | Cause | Fix |
| --- | --- | --- |
| `503` from `/api/readiness`, `migrations.ok=false` | schema behind the code | `npm run db:migrate`, check `--status` |
| `ready:true` but a page shows "not configured" | that provider's env vars are missing | fill them in; the readiness `warnings` list names which |
| `column … does not exist` after a deploy | migration not run in that environment | run it; if the code deployed first, roll the deploy back, migrate, redeploy |
| `SQL placeholder mismatch: 25 placeholder(s) but 24 parameter(s)` | a hand-written statement drifted | the message names the count and the statement — fix the SQL, not the parameters |
| `duplicate column name: …` on boot | a non-idempotent `alter table` ran twice | the boot path already tolerates "already there" errors; a real failure names the statement |
| `no such table: organization_members` in e2e | a test deleted the SQLite file the running server had open | tests truncate in place (`resetSqlite()`), never delete; see the comment in `e2e/app.spec.ts` |
| `next build` fails: `Server Actions must be async functions` | a sync function exported from a `"use server"` module | move it to a plain module (that is why `src/lib/proposal-math.ts` exists) |
| Page loads but nothing is interactive | a script was blocked by CSP | every script must carry the request nonce; check the rendered HTML for `<script` without `nonce=` |
| `ForbiddenError` surfaced as a 500 | a void action threw instead of redirecting | void actions use `forbiddenRedirect()`, value actions return `handle(e)` |
| `permission denied to create database` | restore/migrate role lacks CREATEDB | use a role that owns the database, or create it as the superuser first |
| `database disk image is malformed` after a restore | the archive was decoded as UTF-8 | keep the bytes; `scripts/restore.mjs` writes `raw` |
| Stripe webhook returns 400 | signature mismatch | `STRIPE_WEBHOOK_SECRET` must match the endpoint that is calling, not another one |
| Webhook handled twice | provider retried | expected — `webhook_events` makes handling idempotent; check the event id is stored |
| Email "sent" but never arrived | provider rejected it | the app only reports success on a 2xx from Resend; check the response body in the logs |
| `npm run test:e2e` hangs at webServer | port 3100 already in use | stop the stale `next start` (`E2E_PORT=3200` to move it) |
| Playwright test fails alone but passes in the suite | the suite is serial and resets the database | run the whole file, or pick a self-contained test |

## Logs

`src/lib/logger.ts` writes JSON lines with key+value redaction for secrets and `LOG_LEVEL` honoured
(`debug|info|warn|error`). Error boundaries show the user a digest; the same digest appears in the
server log line, so a report of "it said 123456789" can be traced to the throw.
