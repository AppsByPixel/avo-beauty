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
# THE HOST IS PART OF THE TARGET. This paragraph used to say the opposite — that
# "only the database NAME is taken from the URL, and that is not a shortcut", because
# the suite runs inside the container and a host describes how to reach it from
# outside. That reasoning is sound for a URL that names THIS container and false for
# every other URL, and the script applied it to all of them: it parsed the name out
# of DATABASE_URL and then ran `docker exec avo-postgres psql -d "$DB"` regardless of
# what host the URL named.
#
# Point it at Supabase and it verified the container on this laptop. It was caught
# only by an accident of naming — the demo database is called `postgres`, a local
# empty `postgres` exists, and the run died on `relation "salon" does not exist`.
# Had the demo database been named `avo`, the existence check would have passed and
# this script would have printed ALL INVARIANTS HOLD about the wrong machine.
# DECISIONS.md 112.
#
# WHAT MAKES THAT THE DANGEROUS KIND: THE WRONG ANSWER IS GREEN. A gate that fails on
# the wrong target teaches you the gate is broken. A gate that PASSES on the wrong
# target teaches you the target is sound — and the thing this one would have been
# wrong about is the 103-invariant ledger proof on the provider actually serving the
# demo.
#
# So the transport is now DERIVED from the host, and it never guesses:
#
#   host is this container (localhost/127.0.0.1/::1 on POSTGRES_PORT)
#                     -> `docker exec`, exactly as before. The fast local path.
#   any other host    -> `psql "$DATABASE_URL"` directly. `verify-constraints.sql`
#                        is host-agnostic and needs no container; this was already
#                        the command DEPLOY-DEMO.md tells you to run by hand.
#   any other host, and psql is not installed
#                     -> FAIL, naming it. It does NOT fall back to the container,
#                        because falling back is the whole defect.
#
# AND THE PROVENANCE LINE NAMES THE HOST. It used to print `verifying $DB (from
# $SOURCE)` — the database and not the host, which is precisely the half that was
# wrong. A provenance line that omits the ambiguous half is worse than none, because
# it looks like provenance. The password is never printed; host, port and database
# are.
#
# THE TARGET IS PRINTED BEFORE THE RUN AND STAMPED INTO THE SQL'S OWN REPORT.
# `verify-constraints.sql` now prints `current_database()` in its header, so the
# transcript names its subject even when psql is driven by hand and this wrapper is
# not involved. A verdict that does not say what it is about is how the first
# mistake stayed invisible.
set -euo pipefail

CONTAINER="${PG_CONTAINER:-avo-postgres}"
CONTAINER_PORT="${POSTGRES_PORT:-5433}"

# Where the invariants will actually run. `LOCAL` means `docker exec` into this
# machine's container; anything else means psql straight at the URL.
LOCAL=0
HOSTDESC=""

# postgres://user:pass@host:port/DBNAME?opts -> the host:port between '@' and the
# last '/'. Kept deliberately dumb: no password ever reaches a variable that gets
# printed, and a URL this cannot parse is a URL this refuses rather than guesses at.
url_hostport() {
  local rest="${1#*://}"
  rest="${rest#*@}"          # drop user:pass@ if present
  rest="${rest%%/*}"         # drop /dbname and everything after
  printf '%s' "$rest"
}

if [ -n "${AVO_VERIFY_DB:-}" ]; then
  DB="$AVO_VERIFY_DB"
  SOURCE="AVO_VERIFY_DB"
  # AVO_VERIFY_DB names a database and no host, so it means THIS container — which
  # is how CI uses it. That is only unambiguous while DATABASE_URL agrees; if it
  # names somewhere else, the two variables disagree about the target and this
  # script will not pick a winner. Refusing is the entire lesson of DECISIONS.md 112.
  if [ -n "${DATABASE_URL:-}" ]; then
    hp="$(url_hostport "$DATABASE_URL")"
    case "${hp%%:*}" in
      localhost|127.0.0.1|::1|0.0.0.0|'') : ;;
      *)
        echo "  AVO_VERIFY_DB and DATABASE_URL disagree about WHERE to verify." >&2
        echo "    AVO_VERIFY_DB=$DB          implies the local container $CONTAINER" >&2
        echo "    DATABASE_URL  host=$hp" >&2
        echo "  Unset one. AVO_VERIFY_DB means 'this database, on the container here';" >&2
        echo "  DATABASE_URL carries its own host. Verifying the local one because the" >&2
        echo "  name matched is exactly the defect DECISIONS.md 112 records." >&2
        exit 2
        ;;
    esac
  fi
  LOCAL=1
  HOSTDESC="container $CONTAINER"
elif [ -n "${DATABASE_URL:-}" ]; then
  # Strip the query string, then everything up to the last '/'.
  DB="${DATABASE_URL%%\?*}"
  DB="${DB##*/}"
  SOURCE="DATABASE_URL"
  if [ -z "$DB" ]; then
    echo "  DATABASE_URL is set but names no database: $DATABASE_URL" >&2
    echo "  Expected postgres://user:pass@host:port/dbname" >&2
    exit 2
  fi

  HP="$(url_hostport "$DATABASE_URL")"
  URL_HOST="${HP%%:*}"
  URL_PORT="${HP#*:}"
  [ "$URL_PORT" = "$HP" ] && URL_PORT=5432      # no explicit port in the URL

  case "$URL_HOST" in
    localhost|127.0.0.1|::1|0.0.0.0)
      if [ "$URL_PORT" = "$CONTAINER_PORT" ]; then
        LOCAL=1
        HOSTDESC="container $CONTAINER ($URL_HOST:$URL_PORT)"
      else
        # Local, but not the port this container publishes — another Postgres on
        # this machine. `docker exec` would verify the wrong one of the two.
        LOCAL=0
        HOSTDESC="$URL_HOST:$URL_PORT"
      fi
      ;;
    *)
      LOCAL=0
      HOSTDESC="$URL_HOST:$URL_PORT"
      ;;
  esac
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

SQL_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify-constraints.sql"

if [ "$LOCAL" -eq 0 ]; then
  # A remote target needs a client on THIS machine. It must not degrade into the
  # container: that fallback is the defect, and it fails green.
  if ! command -v psql >/dev/null 2>&1; then
    echo "  DATABASE_URL names $HOSTDESC, which needs a local psql, and psql is not" >&2
    echo "  on PATH. NOT falling back to the container $CONTAINER — that would verify" >&2
    echo "  a different machine's database of the same name and report it as a pass." >&2
    echo "  Install libpq/postgresql-client, or set AVO_VERIFY_DB to verify locally." >&2
    exit 2
  fi
  echo "  verifying $DB on $HOSTDESC   (from $SOURCE)"
  exec psql -q "$DATABASE_URL" -f "$SQL_FILE"
fi

if ! docker exec -i "$CONTAINER" psql -U avo -d postgres -tAc \
      "SELECT 1 FROM pg_database WHERE datname='$DB';" | grep -q 1; then
  echo "  $DB does not exist on $HOSTDESC (resolved from $SOURCE)." >&2
  echo "  Trunk creates lane databases — see LANES.md rather than running CREATE DATABASE." >&2
  exit 2
fi

# Announced BEFORE the run, so a wrong target is visible above the output rather
# than inferred from it afterwards. The HOST is named, not just the database:
# a provenance line that omits the ambiguous half is worse than none.
echo "  verifying $DB on $HOSTDESC   (from $SOURCE)"

# `docker exec`, not `docker compose exec`: compose resolves its service from the
# compose file relative to cwd, and this script is invoked from more than one place.
# The container name is the same fixed name lane-db.sh uses.
# `-q` so psql's own `\pset` confirmations ("Pager usage is off.") stay out of a
# transcript whose job is to be read. It does not suppress \echo, the report, or the
# verdict — only the meta-command chatter.
exec docker exec -i "$CONTAINER" psql -q -U avo -d "$DB" -f - < "$SQL_FILE"
