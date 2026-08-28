#!/usr/bin/env bash
# Where the build actually is, right now.
#
# This exists because a handoff document written on 2026-08-25 stated the state as
# a table, and 110 commits landed before anybody read it. Its own first instruction
# was "assume these numbers are stale" — which was correct and did not help, because
# a reader has nothing to replace them with.
#
# So: no stamped numbers anywhere. Run this instead.
#
#   ./scripts/state.sh
#
# Read-only. Touches no database and starts no server.
set -uo pipefail
cd "$(dirname "$0")/.."

hr() { printf '%s\n' "────────────────────────────────────────────────────────"; }

hr; echo "GIT"; hr
printf '  dev         %s  (%s commits)\n' "$(git rev-parse --short dev)" "$(git rev-list --count dev)"
printf '  main        %s  — %s behind dev\n' "$(git rev-parse --short main)" "$(git rev-list --count main..dev)"
if git rev-parse --verify -q origin/dev >/dev/null; then
  printf '  origin/dev  %s  — %s unpushed\n' "$(git rev-parse --short origin/dev)" "$(git rev-list --count origin/dev..dev)"
fi
printf '  trunk tree  %s file(s) dirty\n' "$(git status --porcelain | wc -l | tr -d ' ')"

hr; echo "LANE WORKTREES  (ahead/behind dev, and anything uncommitted)"; hr
for l in api wallet web qa; do
  d="$HOME/dev/avo-$l"
  [ -d "$d" ] || { printf '  avo-%-7s MISSING\n' "$l"; continue; }
  ahead=$(git -C "$d" rev-list --count dev..HEAD 2>/dev/null || echo '?')
  behind=$(git -C "$d" rev-list --count HEAD..dev 2>/dev/null || echo '?')
  dirty=$(git -C "$d" status --porcelain | wc -l | tr -d ' ')
  printf '  avo-%-7s %s ahead / %s behind   dirty=%s\n' "$l" "$ahead" "$behind" "$dirty"
  # Uncommitted lane work has been lost twice in this build and recovered by luck
  # both times. Name it loudly rather than leaving it in a count.
  [ "$dirty" != "0" ] && git -C "$d" status --porcelain | sed 's/^/      /'
done

hr; echo "BUILT"; hr
printf '  api routes        %s files, %s registrations\n' \
  "$(ls api/src/routes/*.ts 2>/dev/null | wc -l | tr -d ' ')" \
  "$(grep -rhoE 'app\.(get|post|patch|delete|put)' api/src/routes/*.ts 2>/dev/null | wc -l | tr -d ' ')"
printf '  migrations        %s\n' "$(ls api/drizzle/*.sql 2>/dev/null | wc -l | tr -d ' ')"
printf '  e2e               %s files, ~%s it()/test() (grep, NOT a run)\n' \
  "$(ls e2e/*.test.ts 2>/dev/null | wc -l | tr -d ' ')" \
  "$(grep -rhoE '^[[:space:]]*(it|test)\(' e2e/*.test.ts 2>/dev/null | wc -l | tr -d ' ')"
printf '  wallet screens    %s\n' "$(ls apps/wallet/src/screens/*.tsx 2>/dev/null | wc -l | tr -d ' ')"
printf '  scanner screens   %s\n' "$(ls apps/scanner/src/screens/*.tsx 2>/dev/null | wc -l | tr -d ' ')"

# Count NAV ITEMS, not .tsx files. A previous session reported the console as
# "9 of 10" by counting files — SupportPanel and SupportQueue are components
# inside Policies, not sections. The nav's own `built` flag is the truth.
if [ -f apps/dashboard/src/shell/consoleNavItems.tsx ]; then
  built=$(grep -c 'built: true' apps/dashboard/src/shell/consoleNavItems.tsx)
  total=$(grep -cE 'built: (true|false)' apps/dashboard/src/shell/consoleNavItems.tsx)
  printf '  console sections  %s of %s built  (nav items, not .tsx files)\n' "$built" "$total"
  grep -B6 'built: false' apps/dashboard/src/shell/consoleNavItems.tsx \
    | grep -oE "title: '[^']+'" | sed "s/title: '/      not built: /;s/'//"
fi

hr; echo "SPECIFICATION"; hr
if [ -f design/go-live-checklist.md ]; then
  t=$(grep -c '^- \[x\]' design/go-live-checklist.md)
  o=$(grep -c '^- \[ \]' design/go-live-checklist.md)
  printf '  go-live           %s ticked / %s total\n' "$t" "$((t + o))"
fi
printf '  DECISIONS.md      %s entries, %s rows queued for the client\n' \
  "$(grep -c '^### ' DECISIONS.md)" "$(grep -cE '^\| [0-9]+ \|' DECISIONS.md)"

hr; echo "NOT MEASURED HERE"; hr
cat <<'EOF'
  Whether the suite passes. This script greps; it does not run anything.
  A single green run has been wrong three times in this build — on a stale
  dist, on a warm database, and on a turbo cache replay that took 14ms.
  For a real answer see RUNBOOK.md's gate, and run it twice.
EOF
