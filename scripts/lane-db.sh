#!/usr/bin/env bash
#
# Reset one lane's own database: drop its schema, migrate, seed.
#
# WHY THIS EXISTS
#
# Lanes used to reach for `DROP DATABASE` + `CREATE DATABASE` to get a clean
# start. That is sandbox-blocked, so a lane whose drop failed quietly carried on
# against the SHARED database instead — Lane C did exactly that and left an inert
# deactivated staff row in the trunk's `avo_ci`. It disclosed and cleaned up, but
# the failure mode is the point: a blocked isolation step degrades into no
# isolation, silently.
#
# The fix is not a permission grant. Trunk pre-creates one database per lane, and
# a lane resets only the SCHEMA inside the database it already owns — ordinary
# DDL, no CREATE DATABASE, nothing to block.
#
#   ./scripts/lane-db.sh a        -> avo_lane_a
#   ./scripts/lane-db.sh qa       -> avo_lane_qa
#
set -euo pipefail

LANE="${1:?usage: lane-db.sh <a|b|c|d|qa|ci>}"
DB="avo_lane_${LANE}"
[ "$LANE" = "ci" ] && DB="avo_ci"

HOST_PORT="${POSTGRES_PORT:-5433}"
CONTAINER="${PG_CONTAINER:-avo-postgres}"

if ! docker exec -i "$CONTAINER" psql -U avo -d postgres -tAc \
      "SELECT 1 FROM pg_database WHERE datname='$DB';" | grep -q 1; then
  echo "  $DB does not exist."
  echo "  Trunk creates lane databases — ask it rather than running CREATE DATABASE"
  echo "  yourself, which is sandbox-blocked and fails into using the shared one."
  exit 1
fi

echo "  resetting $DB"
docker exec -i "$CONTAINER" psql -U avo -d "$DB" -q \
  -c "DROP SCHEMA IF EXISTS public CASCADE;" \
  -c "DROP SCHEMA IF EXISTS drizzle CASCADE;" \
  -c "CREATE SCHEMA public;" \
  -c "GRANT ALL ON SCHEMA public TO avo;"

export DATABASE_URL="postgres://avo:avo_dev_password@localhost:${HOST_PORT}/${DB}"
export APP_DATABASE_URL="postgres://avo_app:avo_app_dev_password@localhost:${HOST_PORT}/${DB}"

pnpm build >/dev/null 2>&1          # seed.ts imports @avo/types from dist
pnpm --filter @avo/api run db:migrate
pnpm --filter @avo/api run db:seed

echo
echo "  $DB ready. Export these for anything you run against it:"
echo "    export DATABASE_URL=\"$DATABASE_URL\""
echo "    export APP_DATABASE_URL=\"$APP_DATABASE_URL\""
echo
echo "  Do NOT set POSTGRES_DB — e2e's global-setup skips minting its own"
echo "  per-run database when it sees one, which puts every checkout back on"
echo "  shared fixtures."
