# Backup & restore

Two scripts, both engine-aware, both exercised end to end before being written into this doc:

```bash
npm run db:backup                 # → backups/bizpilot-<timestamp>.sql.gz
npm run db:restore -- backups/bizpilot-2026-08-09_10-00-00.sql.gz --yes
```

## What a backup is

| Engine | Mechanism | Why that mechanism |
| --- | --- | --- |
| PostgreSQL | `pg_dump --no-owner --no-privileges` piped through gzip | portable plain SQL, restores into any database owned by anyone |
| SQLite | `VACUUM INTO` → gzip | point-in-time copy that is consistent while the app is still running (it reads through the WAL), unlike `cp bizpilot.db` |

`scripts/backup.mjs` refuses to hand you a file it has not checked: for Postgres the dump must end
with pg_dump's `PostgreSQL database dump complete` marker and must contain at least one
`CREATE TABLE`, otherwise it exits non-zero and writes nothing. A backup that cannot be restored is
worse than no backup, because it makes you stop taking them.

Options: `--out <dir>`, `--keep <n>` (prune all but the newest n), and for SQLite `BIZPILOT_DB_FILE`
selects the source file.

## Restore

```bash
# into an empty database (recommended: restore, then point the app at it)
node scripts/restore.mjs backups/….sql.gz --yes --target "$NEW_DATABASE_URL"

# over a database that already has data — explicitly destructive
node scripts/restore.mjs backups/….sql.gz --yes --force
```

Guardrails, in order:

1. no `--yes` → exits 2, nothing touched;
2. archive does not gunzip, or a Postgres dump without the completion marker → exits 1;
3. target already holds organisations and no `--force` → exits 1 (this is what stops
   `--target` pointing at production by accident);
4. `--force` drops and recreates `schema public` before restoring, so the result is exactly the
   backup and not a merge;
5. SQLite keeps `<db>.pre-restore-<timestamp>` next to the restored file;
6. after restoring, it counts the tables in the target and prints the number.

The restore path keeps the archive as raw bytes. Decoding it as UTF-8 first (an easy mistake, and one
this script originally made) corrupts a SQLite image into `database disk image is malformed`.

## Verified round trip

```
pg_dump: 28 table(s)                    → 14.7 KiB gz
restore → fresh database                → 28 tables, 83 policies, 4 migrations
source:  6 orgs, 8 profiles, 4 plans
restored: 6 orgs, 8 profiles, 4 plans    (identical)
sqlite:  26 tables → gz → restore       → 26 tables, row counts identical
```

## Scheduling

Not scheduled by this repo — production backups belong to your provider (Neon/RDS snapshots) *plus*
a logical dump you control:

```bash
# Postgres: nightly logical dump into object storage, keep 14
0 3 * * *  cd /srv/bizpilot && DATABASE_URL=… node scripts/backup.mjs --out /srv/backups --keep 14
```

Test a restore quarterly into a scratch database. An untested backup is a hypothesis.
