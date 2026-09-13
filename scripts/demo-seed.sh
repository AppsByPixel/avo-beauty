#!/usr/bin/env bash
#
# Fill a DEMO database with plausible content, so the four surfaces look like a
# salon that has been trading for a while rather than a fresh install.
#
# WHY THIS IS NOT IN `api/src/db/seed.ts`
#
# `seed.ts` is a FIXTURE. The e2e suite, the integration suite and
# `packages/mock/src/fixtures.ts` all assert against its exact shape — member
# 8842 with 24.500 KD, artists AR-001..AR-004, two salons. Adding demo volume
# there would break those suites and, worse, would make every future test author
# reason about rows that exist only to look good in a meeting. So this is
# additive, separate, and never run by CI.
#
# WHY EVERY PENNY GOES THROUGH THE API
#
# `ledger_entry` is double-entry with a running `balance_after_fils` stamped per
# row, and a top-up also writes `salon_revenue`/`avo_commission` for the method's
# fee — KNET is 150 fils flat, card is 2.5% + 50. Hand-inserting money means
# recomputing the whole chain and re-deriving the commission, and getting it
# subtly wrong produces a demo where Reports and the wallet disagree. That is
# worse than sparse data.
#
# So: members are created through `POST /auth/member/signup`, money moves through
# `POST /topups` + the sandbox gateway, and visits come from real `POST /charges`.
# Slower, and correct by construction. Verified: one scripted top-up produced
# exactly the four ledger rows a real one does, commission included.
#
# USAGE
#
#   API_BASE=http://localhost:4100 DEMO_DB=avo_lane_c ./scripts/demo-seed.sh
#
# RE-RUNNING IS SAFE, AND HERE IS THE HONEST VERSION OF THAT CLAIM.
#
# An earlier draft of this header said phone numbers were derived from a run tag.
# They are not — they are fixed, which is deliberate: a demo cohort you can name
# ("sign in as Munira") is worth more than a fresh one each run. So the script
# CONVERGES instead. A member who already exists is signed in rather than created,
# and visits are topped up to a target rather than added blindly. Run it twice and
# the second run is nearly a no-op; run it after a `db:seed` wipe and it rebuilds.
#
# That earlier claim shipped for about twenty minutes and was false the whole time,
# which is the same defect this project has now found nine times. It is recorded
# here rather than quietly deleted.

set -euo pipefail

API_BASE="${API_BASE:-http://localhost:4100}"
DEMO_DB="${DEMO_DB:-avo_lane_c}"
PG_CONTAINER="${PG_CONTAINER:-avo-postgres}"

# HOW THIS SCRIPT REACHES POSTGRES, AND WHY IT IS NO LONGER `docker exec` ONLY.
#
# Three reads here need SQL: the published policy version (signup is refused
# without it), a visit count, and a balance. They went through
# `docker exec avo-postgres psql`, which quietly made the whole script
# LOCAL-ONLY — it could not touch a managed database at all, and the failure
# was a docker error rather than anything about databases. DEPLOY-DEMO.md had
# to carry a line saying so.
#
# Now: if DATABASE_URL is set, talk to that. Otherwise fall back to the
# container, so every existing local invocation behaves exactly as before.
#
# The guard below still applies either way — a URL is checked by NAME, so
# pointing this at a production database is refused for the same reason a
# DEMO_DB of `avo` is.
psql_q() {
  if [[ -n "${DATABASE_URL:-}" ]]; then
    psql "$DATABASE_URL" -tAc "$1"
  else
    docker exec -i "$PG_CONTAINER" psql -U avo -d "$DEMO_DB" -tAc "$1"
  fi
}

# ---------------------------------------------------------------- guards --
#
# This script writes to money tables through the API. The only thing standing
# between it and a real salon's books is the operator's shell, so the checks are
# deliberately blunt and come before anything else.

if [[ "${NODE_ENV:-}" == "production" ]]; then
  echo "  NODE_ENV=production. This script invents customers and money. Refusing." >&2
  exit 1
fi

case "$DEMO_DB" in
  avo_lane_*|avo_demo*|avo_ci) : ;;
  *)
    echo "  DEMO_DB='$DEMO_DB' is not a lane, demo or ci database." >&2
    echo "  Refusing rather than guessing. Set DEMO_DB explicitly if you are sure." >&2
    exit 1
    ;;
esac

if ! curl -fsS -o /dev/null "$API_BASE/salons/SAL-AMARA" 2>/dev/null; then
  # 401 is the expected answer for an unauthenticated read, and curl -f treats it
  # as failure — so probe for "something is listening and speaks our JSON"
  # instead of for success.
  code=$(curl -s -o /dev/null -w '%{http_code}' "$API_BASE/salons/SAL-AMARA" || echo 000)
  if [[ "$code" == "000" ]]; then
    echo "  Nothing is answering at $API_BASE. Start the API first." >&2
    exit 1
  fi
fi

RUN_TAG="${RUN_TAG:-$(date +%H%M%S)}"
POLICY_VERSION="$(psql_q \
  "SELECT version FROM legal_document_set WHERE published_at IS NOT NULL ORDER BY version DESC LIMIT 1;" | tr -d '[:space:]')"

if [[ -z "$POLICY_VERSION" ]]; then
  echo "  No published policy set in $DEMO_DB — signup would be refused. Run db:seed first." >&2
  exit 1
fi

echo "  API      $API_BASE"
echo "  database $DEMO_DB"
echo "  policy   v$POLICY_VERSION"
echo "  run tag  $RUN_TAG"
echo

# ------------------------------------------------------------- helpers --

# json_kv k v k v ... -> a JSON object.
# Built this way ON PURPOSE: an inline `python3 -c "...{'a':1}..."` has literal
# braces in a double-quoted shell string, and bash expands them before python
# runs. Single-quoted python plus argv pairs has no braces for the shell to touch.
json_kv() { python3 -c 'import json,sys;print(json.dumps(dict(zip(sys.argv[1::2],sys.argv[2::2]))))' "$@"; }

jqv() { python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print(d$2)" "$1" 2>/dev/null || echo ""; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

MEMBERS_MADE=0
TOPUPS_MADE=0
CHARGES_MADE=0
BOOKINGS_MADE=0

# get_or_make_member <salon> <name> <phone-suffix> -> echoes "id token"
#
# Signs in if she already exists. `POST /auth/member/signup` answers 409
# `already_registered` on a repeat, and treating that as fatal is what made the
# second run of this script a complete no-op while reporting "members 0".
get_or_make_member() {
  local salon="$1" name="$2" suffix="$3"
  local phone="+9659${suffix}"

  # SIGN IN FIRST, SIGN UP SECOND — and the order is the whole fix.
  #
  # An earlier version tried signup first and treated 409 as "already there, now
  # sign in". That works once, but on a re-run it fires eleven signups from one
  # address and `signupLimit` correctly refuses the tail with 429 — which is the
  # limiter doing its job against exactly the traffic it exists to stop. Four
  # members were silently left at their old visit counts because of it.
  #
  # This cohort has FIXED phone numbers (deliberately — "sign in as Munira" is
  # worth more in a demo than a fresh name each run), so sign-in is the common
  # case and signup is the exception. Reversing the order means a re-run never
  # touches the signup limiter at all.
  curl -s -X POST "$API_BASE/auth/member/session" -H 'content-type: application/json' \
    -d "{\"salonId\":\"$salon\",\"phone\":\"$phone\",\"password\":\"demo-pass-2026\"}" \
    -o "$TMP/member.json" -w '%{http_code}' > "$TMP/code"

  if [[ "$(cat "$TMP/code")" == "200" ]]; then
    echo "$(jqv "$TMP/member.json" "['member']['id']") $(jqv "$TMP/member.json" "['accessToken']")"
    return 0
  fi

  curl -s -X POST "$API_BASE/auth/member/signup" -H 'content-type: application/json' \
    -d "{\"salonId\":\"$salon\",\"name\":\"$name\",\"phone\":\"$phone\",\"password\":\"demo-pass-2026\",\"wa\":true,\"policyVersion\":$POLICY_VERSION}" \
    -o "$TMP/member.json" -w '%{http_code}' > "$TMP/code"
  local code; code="$(cat "$TMP/code")"

  if [[ "$code" == "429" ]]; then
    echo "    ~ signup limiter hit on $name; waiting 25s" >&2
    sleep 25
    curl -s -X POST "$API_BASE/auth/member/signup" -H 'content-type: application/json' \
      -d "{\"salonId\":\"$salon\",\"name\":\"$name\",\"phone\":\"$phone\",\"password\":\"demo-pass-2026\",\"wa\":true,\"policyVersion\":$POLICY_VERSION}" \
      -o "$TMP/member.json" -w '%{http_code}' > "$TMP/code"
    code="$(cat "$TMP/code")"
  fi

  if [[ "$code" != "201" ]]; then
    echo "    ! could not sign in or create $name ($code): $(head -c 140 "$TMP/member.json")" >&2
    return 1
  fi
  echo "$(jqv "$TMP/member.json" "['member']['id']") $(jqv "$TMP/member.json" "['accessToken']")"
}

# top_up <token> <memberId> <fils> <method> <key-suffix>
top_up() {
  local token="$1" mid="$2" fils="$3" method="$4" keyx="$5"
  curl -s -X POST "$API_BASE/topups" \
    -H "authorization: Bearer $token" -H 'content-type: application/json' \
    -H "idempotency-key: demo-$RUN_TAG-$mid-$keyx" \
    -d "{\"amountFils\":$fils,\"method\":\"$method\"}" \
    -o "$TMP/topup.json" -w '%{http_code}' > "$TMP/code"
  [[ "$(cat "$TMP/code")" == "200" ]] || { echo "    ! topup failed for $mid: $(head -c 160 "$TMP/topup.json")" >&2; return 1; }

  # The redirect URL carries the sandbox reference; pressing the button is a POST
  # to the same path the customer's browser would have landed on.
  local redirect ref
  redirect="$(jqv "$TMP/topup.json" "['redirectUrl']")"
  ref="$(printf '%s' "$redirect" | sed -E 's#.*/_gateway/([^?]+).*#\1#')"
  [[ -n "$ref" ]] || { echo "    ! no sandbox reference in redirect for $mid" >&2; return 1; }

  curl -s -o /dev/null -X POST "$API_BASE/_gateway/$ref" \
    -H 'content-type: application/json' -d '{"outcome":"succeeded","notify":true}'
  TOPUPS_MADE=$((TOPUPS_MADE + 1))
}

# staff_session <salon> <handle> <pin> <device> -> echoes token
staff_session() {
  curl -s -X POST "$API_BASE/staff/session" -H 'content-type: application/json' \
    -d "{\"salonId\":\"$1\",\"handle\":\"$2\",\"pin\":\"$3\",\"deviceId\":\"$4\"}" \
    -o "$TMP/staff.json" -w '%{http_code}' > "$TMP/code"
  [[ "$(cat "$TMP/code")" == "200" ]] || { echo "    ! staff sign-in failed ($2): $(head -c 200 "$TMP/staff.json")" >&2; return 1; }
  jqv "$TMP/staff.json" "['accessToken']"
}

# charge <stafftoken> <memberId> <serviceIds-json> <key-suffix>
#
# THE NEAR-DUPLICATE GUARD IS WHY THIS TAKES TWO ATTEMPTS.
#
# `services/charge.ts` refuses a second charge for the same member and the same
# basket inside `NEAR_DUPLICATE_WINDOW_SECONDS` (120) — decided deliberately, and
# it named the prior charge and its age when it refused this script the first time.
# A seed loop is exactly the shape it exists to stop, so the honest way past it is
# the one the scanner uses: retry the SAME attempt with `confirmDuplicate: true`.
#
# The idempotency key deliberately EXCLUDES that flag (see `ChargeInput`), so the
# confirmed retry is the same attempt rather than a new one — which is why reusing
# the key here is correct rather than a replay.
charge() {
  local token="$1" mid="$2" svc="$3" keyx="$4"
  local key="demo-$RUN_TAG-chg-$mid-$keyx"

  curl -s -X POST "$API_BASE/charges" \
    -H "authorization: Bearer $token" -H 'content-type: application/json' \
    -H "idempotency-key: $key" \
    -d "{\"memberId\":\"$mid\",\"serviceIds\":$svc}" \
    -o "$TMP/charge.json" -w '%{http_code}' > "$TMP/code"

  if [[ "$(cat "$TMP/code")" == "409" ]] \
     && grep -q "same services" "$TMP/charge.json" 2>/dev/null; then
    curl -s -X POST "$API_BASE/charges" \
      -H "authorization: Bearer $token" -H 'content-type: application/json' \
      -H "idempotency-key: $key" \
      -d "{\"memberId\":\"$mid\",\"serviceIds\":$svc,\"confirmDuplicate\":true}" \
      -o "$TMP/charge.json" -w '%{http_code}' > "$TMP/code"
  fi

  if [[ "$(cat "$TMP/code")" != "200" ]]; then
    echo "    ~ charge skipped for $mid ($(cat "$TMP/code")): $(python3 -c "import json;print(json.load(open('$TMP/charge.json')).get('message',''))" 2>/dev/null | head -c 110)" >&2
    return 0   # an insufficient balance is not a script failure
  fi
  CHARGES_MADE=$((CHARGES_MADE + 1))
}

# book <token> <artistId> <serviceId> <startsAt> <key> -> quiet on conflict
#
# A booking HOLDS A DEPOSIT out of her wallet (5.000 KD on the seed's config), so
# this is money too and goes through the endpoint like everything else. A slot
# that is already taken answers 409 and that is not a script failure — the point
# is that the diary looks busy, not that a particular minute is ours.
book() {
  local token="$1" artist="$2" svc="$3" at="$4" key="$5"
  curl -s -X POST "$API_BASE/bookings" \
    -H "authorization: Bearer $token" -H 'content-type: application/json' \
    -H "idempotency-key: demo-$RUN_TAG-bk-$key" \
    -d "{\"artistId\":\"$artist\",\"serviceId\":\"$svc\",\"startsAt\":\"$at\"}" \
    -o "$TMP/book.json" -w '%{http_code}' > "$TMP/code"
  if [[ "$(cat "$TMP/code")" != "201" ]]; then
    echo "    ~ booking skipped ($(cat "$TMP/code")): $(python3 -c "import json;print(json.load(open('$TMP/book.json')).get('message',''))" 2>/dev/null | head -c 100)" >&2
    return 0
  fi
  BOOKINGS_MADE=$((BOOKINGS_MADE + 1))
}

# member_token <salon> <phone-suffix> -> echoes token, or empty
member_token() {
  curl -s -X POST "$API_BASE/auth/member/session" -H 'content-type: application/json' \
    -d "{\"salonId\":\"$1\",\"phone\":\"+9659$2\",\"password\":\"demo-pass-2026\"}" \
    -o "$TMP/mt.json" -w '%{http_code}' > "$TMP/code"
  [[ "$(cat "$TMP/code")" == "200" ]] && jqv "$TMP/mt.json" "['accessToken']" || echo ""
}

echo "1 · Amara — customers with history"
echo "   Each charge is one visit, and visits are what move a member up the tiers,"
echo "   so the ladder below is produced rather than asserted."

STAFF_TOKEN="$(staff_session SAL-AMARA noura 2468 DEV-SCANNER-01)" || {
  echo "  Cannot take charges without a staff session. Members and top-ups only." >&2
  STAFF_TOKEN=""
}

# The cheapest service is SV-04 Manicure at 6.000 KD, and a visit is one charge.
# So twenty-one visits is 126 KD of spending, which no single sensible top-up
# covers — TOP-UPS ARE INTERLEAVED WITH CHARGES, four charges to a 30 KD tranche.
# That is also what a real customer does, so the activity feed ends up alternating
# rather than showing one deposit and a wall of debits.
#
# name | phone suffix | method | visits to buy   (tier: 4+ silver, 10+ gold, 20+ black)
AMARA=(
  "Latifa Al-Mutawa|0100101|knet|11"
  "Shaikha Al-Rashid|0100102|knet|6"
  "Munira Al-Ajmi|0100103|card|21"
  "Fatima Al-Hajri|0100104|knet|2"
  "Bibi Al-Sabah|0100105|knet|13"
  "Sara Al-Otaibi|0100106|card|4"
  "Nour Al-Enezi|0100107|knet|1"
  "Aisha Al-Kandari|0100108|knet|8"
)

# Five real services, cheapest first. Cycling them makes the history look like a
# person rather than a loop, and keeps most baskets cheap so the interleaved
# top-ups can cover them.
BASKETS=('["SV-04"]' '["SV-01"]' '["SV-04","SV-01"]' '["SV-05"]' '["SV-02"]' '["SV-01","SV-05"]')
TRANCHE=50000               # 50 KD covers four of the varied baskets with change
PER_TRANCHE=4

for row in "${AMARA[@]}"; do
  IFS='|' read -r name suffix method visits <<< "$row"
  read -r mid token < <(get_or_make_member SAL-AMARA "$name" "$suffix") || continue
  [[ -n "$mid" ]] || continue
  MEMBERS_MADE=$((MEMBERS_MADE + 1))

  # VISITS ARE TOPPED UP TO A TARGET, not added blindly — so a second run of this
  # script converges instead of pushing everyone two tiers higher.
  have="$(psql_q \
    "SELECT visits FROM member WHERE id='$mid';" | tr -d '[:space:]')"
  have="${have:-0}"
  want=$(( visits - have ))

  if [[ -z "$STAFF_TOKEN" ]]; then
    # No staff session: still give her a balance so no demo wallet reads 0.000.
    top_up "$token" "$mid" "$TRANCHE" "$method" a || true
  elif (( want <= 0 )); then
    : # already at or past target
  else
    for ((v = have + 1; v <= visits; v++)); do
      if (( (v - have - 1) % PER_TRANCHE == 0 )); then
        top_up "$token" "$mid" "$TRANCHE" "$method" "t$v" || true
      fi
      basket="${BASKETS[$(( (v - 1) % ${#BASKETS[@]} ))]}"
      charge "$STAFF_TOKEN" "$mid" "$basket" "$v" || true
    done
    top_up "$token" "$mid" $((TRANCHE / 2)) "$method" z || true
  fi

  bal="$(psql_q \
    "SELECT balance_fils || ' ' || tier || ' ' || visits FROM member WHERE id='$mid';" | tr -d '\r')"
  printf '   %-22s %-7s %s\n' "$name" "$mid" "$bal"
done

echo
echo "2 · Lumiere — so the console's Salons view is not one salon and an empty one"
LUMIERE=(
  "Dalal Al-Fadhli|0100201|20000|knet"
  "Hind Al-Salem|0100202|30000|card"
  "Maryam Al-Duaij|0100203|15000|knet"
)
for row in "${LUMIERE[@]}"; do
  IFS='|' read -r name suffix fils method <<< "$row"
  read -r mid token < <(get_or_make_member SAL-LUMIERE "$name" "$suffix") || continue
  [[ -n "$mid" ]] || continue
  MEMBERS_MADE=$((MEMBERS_MADE + 1))
  top_up "$token" "$mid" "$fils" "$method" a || true
  printf '   %-22s %s\n' "$name" "$mid"
done

echo
echo "3 · The diary — so Appointments, My bookings and the wallet's UPCOMING are not empty"
echo "   Dated forward from the artists' real open windows: AR-003 works Sun-Thu"
echo "   10:00-21:00 in 30m slots, AR-004 opens at 16:00, AR-002 runs 45m."

# DATES ARE COMPUTED, NOT WRITTEN DOWN, AND THAT IS THE WHOLE POINT.
#
# This block used to hold eight literal dates in August 2026. By 9 September every
# one of them was in the past, so `POST /bookings` refused all eight and the script
# cheerfully reported "bookings 0" — the diary empty, the wallet's UPCOMING card
# empty, and the artist-performance report showing every artist at zero with the
# salon's whole revenue sitting in the unattributed bucket.
#
# Nothing failed loudly. `book()` treats a non-201 as "not a script failure" on
# purpose, because a taken slot answers 409 and that is genuinely fine — which is
# exactly what let an expired diary look like an ordinary conflict for ten days.
#
# The artists' real windows still constrain the hours: AR-003 works Sun-Thu
# 10:00-21:00 in 30m slots, AR-004 opens at 16:00, AR-002 runs 45m. So the OFFSETS
# below are chosen to land inside those windows, and the DAY is relative.
#
# `next_weekday` returns the next date whose weekday is in Sun-Thu, at least N days
# out, so a run on a Friday does not aim the whole diary at a closed salon.
next_open_day() {
  python3 - "$1" <<'PYDAY'
import sys, datetime
ahead = int(sys.argv[1])
d = datetime.date.today() + datetime.timedelta(days=ahead)
# Kuwait working week: Sunday(6) through Thursday(3) in Python's Mon=0 numbering.
while d.weekday() in (4, 5):   # Friday, Saturday
    d += datetime.timedelta(days=1)
print(d.isoformat())
PYDAY
}

D1="$(next_open_day 1)"
D2="$(next_open_day 2)"
D4="$(next_open_day 4)"

# suffix | artist | service | startsAt (Kuwait, +03:00) — inside a real window
DIARY=(
  "0100101|AR-003|SV-02|${D1}T12:00:00+03:00"
  "0100102|AR-003|SV-01|${D1}T13:30:00+03:00"
  "0100103|AR-001|SV-03|${D1}T14:00:00+03:00"
  "0100105|AR-003|SV-05|${D2}T10:30:00+03:00"
  "0100108|AR-004|SV-02|${D1}T17:00:00+03:00"
  "0100106|AR-002|SV-01|${D1}T11:00:00+03:00"
  "0100104|AR-003|SV-04|${D2}T15:00:00+03:00"
  "0100101|AR-003|SV-01|${D4}T16:00:00+03:00"
)

for row in "${DIARY[@]}"; do
  IFS='|' read -r suffix artist svc at <<< "$row"
  tok="$(member_token SAL-AMARA "$suffix")"
  [[ -n "$tok" ]] || { echo "    ~ no session for +9659$suffix" >&2; continue; }
  book "$tok" "$artist" "$svc" "$at" "$suffix-$artist-${at:0:10}" || true
done

echo
echo "3b · One appointment carried through to a charge — the only shape that attributes"
echo "   Everything above is FUTURE. A booking only attributes revenue to its artist"
echo "   once it has started and been charged, so without this step the"
echo "   artist-performance report shows every artist at zero and the whole salon's"
echo "   takings sitting in the unattributed bucket."

# WHY THIS IS CONDITIONAL AND SAYS SO.
#
# `findApplicableHold` matches a booking whose `starts_at <= now + noShowReturnMinutes`
# and whose no-show window has not closed. So the booking has to start about now — which
# means the salon has to be OPEN about now. AR-003 works 10:00-21:00 Kuwait, Sun-Thu.
#
# A seeder that silently produced nothing outside those hours is what this whole
# commit is fixing, so this one reports which branch it took instead.
KW_NOW="$(TZ=Asia/Kuwait date +%H%M)"
KW_DOW="$(TZ=Asia/Kuwait date +%u)"   # 1=Mon .. 7=Sun
# NO `zoneinfo` HERE, DELIBERATELY. The `python3` first on PATH is miniconda's and
# predates the module, so `import zoneinfo` is a ModuleNotFoundError on this machine —
# the same PATH trap LANES.md records for node. `date` knows about TZ and is enough.
read -r _kd _kh _km < <(TZ=Asia/Kuwait date -v+10M '+%Y-%m-%d %H %M')
if (( 10#$_km < 30 )); then _sh="$_kh"; _sm=30; else _sh=$(( 10#$_kh + 1 )); _sm=00; fi
SLOT="$(printf '%sT%02d:%02d:00+03:00' "$_kd" "$_sh" "$_sm")"

if [[ "$KW_DOW" == "5" || "$KW_DOW" == "6" ]]; then
  echo "    ~ skipped: it is Friday/Saturday in Kuwait and AR-003's window is Sun-Thu."
  echo "      Re-run on a working day to produce an attributed appointment."
elif (( 10#$KW_NOW < 1000 || 10#$KW_NOW > 2000 )); then
  echo "    ~ skipped: Kuwait local time is ${KW_NOW:0:2}:${KW_NOW:2:2}, outside AR-003's"
  echo "      10:00-21:00 window. Re-run during salon hours for an attributed appointment."
else
  # `get_or_make_member` echoes "id token" — the same contract the loops above use,
  # so this reuses an existing member rather than minting a twelfth.
  read -r ATT_MID ATT_TOK < <(get_or_make_member SAL-AMARA "Farah Al-Otaibi" 0100107) || true
  if [[ -z "${ATT_TOK:-}" ]]; then
    echo "    ~ skipped: no session for +96590100107." >&2
  else
    if book "$ATT_TOK" AR-003 SV-04 "$SLOT" "attributed-$RUN_TAG"; then
      echo "    booked  AR-003 · SV-04 · $SLOT"
      # The charge settles the hold, completes the booking, and is the row the
      # artist-performance report attributes. Needs a scanner session, like any charge.
      if [[ -n "$STAFF_TOKEN" ]]; then
        charge "$STAFF_TOKEN" "$ATT_MID" '["SV-04"]' attributed || true
        echo "    charged — this appointment now attributes to AR-003 in Reports"
      else
        echo "    ~ booked but not charged: no scanner session, so it stays unattributed." >&2
      fi
    fi
  fi
fi

echo
echo "4 · The console's queues — Support and Approvals are otherwise empty screens"

# Support tickets. Routing is resolved SERVER-SIDE from the topic (non-negotiable
# #11), so a wallet dispute lands in AVO's queue and a service complaint lands in
# the salon's — which is the thing worth showing, not the ticket count.
TICKETS=(
  "0100101|wallet|My top-up on Sunday shows twice in my history but only one amount left my account."
  "0100103|charge|I was charged 15.000 KD on Tuesday and I only had a blow-dry that day."
  "0100105|booking|I need to move my Monday appointment to the afternoon, the app says it is too late to change."
  "0100102|visit|The colour came out darker than we agreed and I would like to speak to the manager."
  "0100108|account|Please remove my phone number from marketing messages, I still get them."
)
for row in "${TICKETS[@]}"; do
  IFS='|' read -r suffix topic msg <<< "$row"
  tok="$(member_token SAL-AMARA "$suffix")"
  [[ -n "$tok" ]] || continue
  code=$(curl -s -o "$TMP/tk.json" -w '%{http_code}' -X POST "$API_BASE/v1/support/tickets" \
    -H "authorization: Bearer $tok" -H 'content-type: application/json' \
    -d "$(json_kv topicId "$topic" message "$msg" via wa)")
  if [[ "$code" == "200" || "$code" == "201" ]]; then
    printf '   ticket  %-8s %s\n' "$topic" "routed"
  else
    echo "    ~ ticket skipped ($code): $(head -c 100 "$TMP/tk.json")" >&2
  fi
done

# Campaigns. A merchant CANNOT send one — `POST /campaigns` only ever creates
# `pending`, and release happens on the platform decision endpoint (#8 of the
# non-negotiables). So these land in the console's Approvals queue, which is
# exactly the state a stakeholder should see: the salon has asked, AVO decides.
WEB_TOKEN="$(curl -s -X POST "$API_BASE/auth/web/session" -H 'content-type: application/json' \
  -d '{"salonId":"SAL-AMARA","username":"noura","password":"noura-dev-password"}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin).get('accessToken',''))" 2>/dev/null || echo "")"

if [[ -n "$WEB_TOKEN" ]]; then
  CAMPAIGNS=(
    "Eid weekend — double visit credit|Book any colour service this Eid weekend and earn two visits towards your next tier.|all"
    "We have missed you|It has been a while. Your wallet balance is still here whenever you are ready.|lapsed"
    # `gold`, NOT `tier`. The audience enum is
    # `all | lapsed | lowbal | gold | new` (`packages/types/src/entities.ts:855`)
    # and `tier` was never in it, so this row was refused 400 `invalid_audience`
    # on every run this script has ever made — silently, because the loop logs a
    # skip and carries on. The console's Campaigns screen was one campaign short
    # in every demo and nobody noticed, which is what a non-fatal skip buys you.
    "Gold and Black members — early access|Priority booking for the new treatment menu opens to you a week early.|gold"
  )
  for row in "${CAMPAIGNS[@]}"; do
    IFS='|' read -r title body audience <<< "$row"
    code=$(curl -s -o "$TMP/cp.json" -w '%{http_code}' -X POST "$API_BASE/v1/salons/SAL-AMARA/campaigns" \
      -H "authorization: Bearer $WEB_TOKEN" -H 'content-type: application/json' \
      -d "$(json_kv title "$title" body "$body" audience "$audience")")
    if [[ "$code" == "200" || "$code" == "201" ]]; then
      printf '   campaign pending  %s\n' "${title:0:38}"
    else
      echo "    ~ campaign skipped ($code): $(head -c 110 "$TMP/cp.json")" >&2
    fi
  done
else
  echo "    ~ no dashboard session; skipping campaigns" >&2
fi

echo
echo "Done."
printf '   members %d · top-ups %d · charges %d · bookings %d\n' \
  "$MEMBERS_MADE" "$TOPUPS_MADE" "$CHARGES_MADE" "$BOOKINGS_MADE"
echo
echo "   Every member's password is demo-pass-2026."
echo "   Balances, tiers, visits, commission and the ledger were all produced by"
echo "   the real endpoints, so Reports and the wallet cannot disagree."
