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
| Scheduled automations never fire | no scheduler, or `CRON_SECRET` missing | set `CRON_SECRET` and point a scheduler (or Vercel Cron) at `/api/cron/automations`; the automations page warns when it is unset |
| Cron route returns 503 | `CRON_SECRET` is empty | set it — the route refuses to run unauthenticated by design |
| Cron route returns 401 | token mismatch | the bearer token must equal `CRON_SECRET` exactly |
| "Connect Dropbox" button missing | `DROPBOX_APP_KEY`/`DROPBOX_APP_SECRET` not set, or the role is not owner/admin | set both keys; only `settings:workspace` holders can connect |
| Dropbox callback says `state_mismatch` | the link was issued for a different workspace/user, or it expired (10 min) | press Connect again |
| Uploads still say `local` after connecting | `DROPBOX_CONTENT_URL` unreachable, or the app scopes are wrong | check the upload error in the notice; the file is kept locally rather than lost |
| `npm run test:e2e` hangs at webServer | port 3100 already in use | stop the stale `next start` (`E2E_PORT=3200` to move it) |
| Playwright test fails alone but passes in the suite | the suite is serial and resets the database | run the whole file, or pick a self-contained test |

## Logs

`src/lib/logger.ts` writes JSON lines with key+value redaction for secrets and `LOG_LEVEL` honoured
(`debug|info|warn|error`). Error boundaries show the user a digest; the same digest appears in the
server log line, so a report of "it said 123456789" can be traced to the throw.
## Downloads and documents

| Symptom | Cause | Fix |
| --- | --- | --- |
| `410` "The stored file is missing on this server" | the `documents` row survived but the file under `data/uploads` did not (volume wiped, container replaced without a persistent disk) | re-upload the file, or restore `data/uploads` from backup. The row is deliberately *not* deleted so the record of the file survives |
| `409` "this workspace has no Dropbox connection" | the row says `storage_provider = dropbox` but the workspace's OAuth credential was disconnected and no deployment token exists | reconnect Dropbox on `/documents`, or set `DROPBOX_ACCESS_TOKEN` |
| `502` "Dropbox download failed" | Dropbox rejected the call (expired token, missing scope, deleted app) | the message includes the Dropbox status; reconnect to get a fresh refresh token |
| Upload says "…files are not supported" | the extension is not on the allowlist (pdf, png, jpg, jpeg, webp, txt, csv, doc, docx, xls, xlsx) | rename/convert, or add the extension to `EXTENSION_MIME` in `src/lib/actions/documents.ts` |

## Auth rate limits

| Symptom | Cause | Fix |
| --- | --- | --- |
| Signup answers 429 for a whole office | the ceiling is per IP (default 10 signups/hour, 20 logins/10 min) and everyone shares one NAT address | set `SIGNUP_RATE_LIMIT` / `LOGIN_RATE_LIMIT` (and the `*_WINDOW_SECONDS` variants) to a value that suits the deployment. Those variables are read at startup; an invalid value falls back to the documented default |
| `/api/readiness` reports `schema_columns: missing …` | the code is newer than the database | `npm run db:migrate` |

