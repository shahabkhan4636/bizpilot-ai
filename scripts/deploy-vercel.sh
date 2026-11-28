#!/usr/bin/env bash
# One-shot production deploy to the existing Vercel project `bizpilot-ai`.
#
#   VERCEL_TOKEN=... ./scripts/deploy-vercel.sh
#
# The token is read from the environment only — it is never written to disk,
# never committed, and never echoed. Revoke it in Vercel → Settings → Tokens
# as soon as the deploy reports READY.
set -euo pipefail

: "${VERCEL_TOKEN:?VERCEL_TOKEN is not set}"
SCOPE="team_u76Q3u7Qi14nCDxdQ0eQ2XNq"
PROJECT="bizpilot-ai"

cd "$(dirname "$0")/.."

echo "→ linking $PROJECT (scope $SCOPE)"
npx --yes vercel@latest link --yes --project "$PROJECT" --scope "$SCOPE" --token "$VERCEL_TOKEN" >/dev/null

echo "→ deploying to production"
npx --yes vercel@latest deploy --prod --yes --scope "$SCOPE" --token "$VERCEL_TOKEN"
