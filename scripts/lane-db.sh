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

# Docker's own absence must NOT be reported as "the database does not exist".
# `if !` swallows a command-not-found into the same branch, and the branch below
# tells the lane to go ask trunk for a database it very likely already has.
if ! command -v docker >/dev/null 2>&1; then
  echo "  docker is not on PATH, so nothing can be said about $DB." >&2
  echo "  This is NOT the same as the database being missing — do not ask trunk" >&2
  echo "  to create one until docker is back and this script can actually look." >&2
  exit 1
fi

if ! docker exec -i "$CONTAINER" psql -U avo -d postgres -tAc \
      "SELECT 1 FROM pg_database WHERE datname='$DB';" | grep -q 1; then
  echo "  $DB does not exist."
  echo "  Trunk creates lane databases — ask it rather than running CREATE DATABASE"
  echo "  yourself, which is sandbox-blocked and fails into using the shared one."
  exit 1
fi

# RESOLVED BEFORE ANYTHING IS DROPPED, DELIBERATELY. The schema drop below is
# destructive and unrecoverable; discovering a missing toolchain after it would
# leave the lane an empty database rather than a stale one.
# `pnpm` is not reliably on PATH. Under node v25.7.0 there is no global install and
# nothing in `node_modules/.bin`; `corepack pnpm` works. Resolve it once, here, so
# the three calls below cannot half-resolve and reset a database with a stale build.
CLEANUP=()
trap 'for d in "${CLEANUP[@]:-}"; do [ -n "$d" ] && rm -rf "$d"; done' EXIT

if command -v pnpm >/dev/null 2>&1; then
  PNPM=(pnpm)
elif command -v corepack >/dev/null 2>&1; then
  # `PNPM=(corepack pnpm)` IS NOT ENOUGH, and the way it fails is instructive.
  # `build` runs turbo, and turbo spawns `pnpm` ITSELF, by name, off PATH. So the
  # outer call succeeds, turbo starts, and it dies with "Unable to find package
  # manager binary: cannot find binary path" — an error that says nothing about
  # PATH and reads like a turbo bug. Give the whole run a real `pnpm` instead.
  SHIM_DIR="$(mktemp -d)"
  CLEANUP+=("$SHIM_DIR")
  printf '#!/usr/bin/env bash\nexec corepack pnpm "$@"\n' > "$SHIM_DIR/pnpm"
  chmod +x "$SHIM_DIR/pnpm"
  export PATH="$SHIM_DIR:$PATH"
  PNPM=(pnpm)
else
  echo "  Neither pnpm nor corepack is on PATH. $DB was NOT reset." >&2
  echo "  Node here is $(command -v node || echo 'not on PATH either')." >&2
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

# NOT `>/dev/null 2>&1`. Under `set -e` that pairing is the worst failure this
# script can have: the build dies, NOTHING is printed, and the "ready" block below
# never runs — which is indistinguishable from a reset that succeeded quietly. A
# lane then works on a database it believes is fresh. Keep the output; show it only
# when the build actually fails.
BUILD_LOG="$(mktemp)"
CLEANUP+=("$BUILD_LOG")
if ! "${PNPM[@]}" --dir "$ROOT" build >"$BUILD_LOG" 2>&1; then   # seed.ts imports @avo/types from dist
  # SAY WHAT IS ACTUALLY TRUE OF THE DATABASE. The drop above already ran, so this
  # is NOT "nothing happened" — $DB is empty right now: dropped, not rebuilt. An
  # earlier draft of this message said "was NOT reset", which would send a lane off
  # to debug against a database it believed was untouched.
  echo "  build failed. $DB IS NOW EMPTY — the schema was dropped before this step," >&2
  echo "  so it is neither the old database nor a fresh one. Re-run this script once" >&2
  echo "  the build works; nothing else will repopulate it. Build output:" >&2
  cat "$BUILD_LOG" >&2
  exit 1
fi

"${PNPM[@]}" --dir "$ROOT/api" run db:migrate
"${PNPM[@]}" --dir "$ROOT/api" run db:seed

echo
echo "  $DB ready. Export these for anything you run against it:"
echo "    export DATABASE_URL=\"$DATABASE_URL\""
echo "    export APP_DATABASE_URL=\"$APP_DATABASE_URL\""
echo
echo "  Do NOT set POSTGRES_DB — e2e's global-setup skips minting its own"
echo "  per-run database when it sees one, which puts every checkout back on"
echo "  shared fixtures."
