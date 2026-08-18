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
#   ./scripts/lane-db.sh d        -> avo_lane_d     (lane D / QA)
#
set -euo pipefail

# `d`, not `qa`. The databases trunk created are avo_lane_{a,b,c,d} and avo_ci —
# there is no avo_lane_qa, and lane D following a `qa` example would land in the
# "does not exist, ask trunk" branch below. Accepted as an alias rather than a
# failure, because the lane is called QA everywhere else in LANES.md.
LANE="${1:?usage: lane-db.sh <a|b|c|d|ci>}"
[ "$LANE" = "qa" ] && LANE="d"
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

# `--dir` with an absolute path derived from THIS script's location, never
# `--filter`, and never a path relative to cwd.
#
# `pnpm --filter @avo/api` is the hazard this whole rule exists to stop: run from
# a lane worktree it once resolved to a DIFFERENT worktree's package — Lane A
# watched `--filter @avo/api run start` boot `~/dev/avo-wallet/api` against
# `avo_lane_b`, with entirely normal-looking output. Here it would be worse than
# a wasted run: the URLs above are already exported, so another worktree's
# migrations and seed would be applied to THIS lane's database. Lane D rewrote 21
# error strings away from `--filter` for the same reason; this script was still
# using it.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

pnpm --dir "$ROOT" build >/dev/null 2>&1     # seed.ts imports @avo/types from dist
pnpm --dir "$ROOT/api" run db:migrate
pnpm --dir "$ROOT/api" run db:seed

echo
echo "  $DB ready. Export these for anything you run against it:"
echo "    export DATABASE_URL=\"$DATABASE_URL\""
echo "    export APP_DATABASE_URL=\"$APP_DATABASE_URL\""
echo
echo "  Do NOT set POSTGRES_DB — e2e's global-setup skips minting its own"
echo "  per-run database when it sees one, which puts every checkout back on"
echo "  shared fixtures."
