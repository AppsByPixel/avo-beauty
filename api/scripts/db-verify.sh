#!/usr/bin/env bash
#
# Run the invariant suite against a database this script has NAMED OUT LOUD.
#
#   pnpm --dir=/abs/path/to/api run db:verify
#
# WHY THIS WRAPPER EXISTS
#
# The npm script used to be, inline:
#
#   psql -U avo -d "${AVO_VERIFY_DB:-avo}" -f - < scripts/verify-constraints.sql
#
# Two defects in one expression, and they compound:
#
#   IT DEFAULTED TO `avo`, the shared database. A lane that had correctly exported
#   DATABASE_URL and APP_DATABASE_URL for its own database, and then ran a bare
#   `pnpm run db:verify`, verified SOMEBODY ELSE'S database and got a completely
#   plausible answer — 71 invariants, 0 failed, about the wrong target. Lane B did
#   exactly that and disclosed it.
#
#   IT IGNORED `DATABASE_URL` ENTIRELY. So the one variable every lane already
#   exports, and which `lane-db.sh` prints at the end of every reset, had no effect
#   on what got verified.
#
# This is the `pnpm --filter` trap wearing different clothes — LANES.md § "Every
# lane isolates its own resources" — and it is worse here, because a verification
# tool that silently checks the wrong target is the exact class of defect it exists
# to catch. `verify-constraints.sql`'s own header says it was rewritten once already
# for being "true, unread, unenforced"; this is the third instance of its own
# finding.
#
# HOW IT RESOLVES THE TARGET, in order, and it never guesses:
#
#   1. AVO_VERIFY_DB, if set. An explicit answer wins over a derived one, always —
#      that is what makes CI's `AVO_VERIFY_DB=avo_ci` and a lane's deliberate
#      cross-check possible.
#   2. The database name parsed out of DATABASE_URL. Kinder than requiring a second
#      variable, because every lane already exports this one and lane-db.sh hands it
#      to you.
#   3. Nothing. FAIL, naming both variables. Not `avo`. A run with no stated target
#      is a question nobody asked.
#
# ONLY THE DATABASE NAME IS TAKEN FROM THE URL, and that is not a shortcut: the
# suite runs INSIDE the container via `docker compose exec`, so the host and port in
# DATABASE_URL describe how the HOST reaches Postgres and are irrelevant to a client
# already inside it. Taking the name alone is the whole of what transfers.
#
# THE TARGET IS PRINTED BEFORE THE RUN AND STAMPED INTO THE SQL'S OWN REPORT.
# `verify-constraints.sql` now prints `current_database()` in its header, so the
# transcript names its subject even when psql is driven by hand and this wrapper is
# not involved. A verdict that does not say what it is about is how the first
# mistake stayed invisible.
set -euo pipefail

CONTAINER="${PG_CONTAINER:-avo-postgres}"

if [ -n "${AVO_VERIFY_DB:-}" ]; then
  DB="$AVO_VERIFY_DB"
  SOURCE="AVO_VERIFY_DB"
elif [ -n "${DATABASE_URL:-}" ]; then
  # postgres://user:pass@host:port/DBNAME?opts -> DBNAME
  # Strip the query string, then everything up to the last '/'.
  DB="${DATABASE_URL%%\?*}"
  DB="${DB##*/}"
  SOURCE="DATABASE_URL"
  if [ -z "$DB" ]; then
    echo "  DATABASE_URL is set but names no database: $DATABASE_URL" >&2
    echo "  Expected postgres://user:pass@host:port/dbname" >&2
    exit 2
  fi
else
  cat >&2 <<'MSG'
  db:verify has no target, and it will not assume one.

  It used to default to the SHARED `avo` database while ignoring DATABASE_URL, so a
  lane that had exported its own URLs and run this verified somebody else's database
  and got a plausible answer. Lane B did exactly that. Defaulting is the defect.

  Set one of:
    export DATABASE_URL="postgres://avo:...@localhost:5433/avo_lane_a"   # normal
    AVO_VERIFY_DB=avo_ci pnpm --dir=/abs/path/to/api run db:verify       # explicit

  `./scripts/lane-db.sh <lane>` prints the DATABASE_URL to export.
MSG
  exit 2
fi

if ! docker exec -i "$CONTAINER" psql -U avo -d postgres -tAc \
      "SELECT 1 FROM pg_database WHERE datname='$DB';" | grep -q 1; then
  echo "  $DB does not exist (resolved from $SOURCE)." >&2
  echo "  Trunk creates lane databases — see LANES.md rather than running CREATE DATABASE." >&2
  exit 2
fi

# Announced BEFORE the run, so a wrong target is visible above the output rather
# than inferred from it afterwards.
echo "  verifying $DB   (from $SOURCE)"

# `docker exec`, not `docker compose exec`: compose resolves its service from the
# compose file relative to cwd, and this script is invoked from more than one place.
# The container name is the same fixed name lane-db.sh uses.
# `-q` so psql's own `\pset` confirmations ("Pager usage is off.") stay out of a
# transcript whose job is to be read. It does not suppress \echo, the report, or the
# verdict — only the meta-command chatter.
exec docker exec -i "$CONTAINER" psql -q -U avo -d "$DB" -f - \
  < "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify-constraints.sql"
