#!/usr/bin/env bash
# Starts the production build as a single-user try-out server on the sandbox preview.
#
#   scripts/tryout.sh
#
# The environment (including secrets) is read from /home/user/tryout-server.env, which
# lives OUTSIDE this repository so nothing sensitive can be committed. The database is
# data/live.db — separate from the dev database and from the e2e database, so trying the
# app can never corrupt the demo or the test fixtures.
#
# The loop re-launches the server if it crashes. It cannot survive the sandbox itself
# being frozen or recycled: that needs a real deploy (Vercel + Supabase).
set -a
. /home/user/tryout-server.env
set +a

cd "$(dirname "$0")/.." || exit 1

if [ ! -f data/live.db ]; then
  echo "→ data/live.db missing: migrating"
  node scripts/db-migrate.mjs
  node scripts/seed.mjs --demo --email "$ADMIN_EMAIL" --name "Workspace Owner"
fi

while true; do
  echo "→ starting BizPilot AI on 0.0.0.0:$PORT (db=$BIZPILOT_DB_FILE)"
  npx next start -H 0.0.0.0 -p "$PORT"
  echo "→ server exited, restarting in 3s"
  sleep 3
done
