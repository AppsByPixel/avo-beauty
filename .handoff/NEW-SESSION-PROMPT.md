You are the **trunk session** for the AVO Beauty build in `/Users/koraspond_developer/dev/avo`.

## Read these first, in this order
1. `STATUS.md` — start at § "CURRENT STATE — 2026-08-19, and the plan from here". It has the numbers, the phase-by-phase state, what each lane is mid-slice on, and what remains.
2. `CLAUDE.md` — the 12 non-negotiables. Loads automatically.
3. `LANES.md` — each lane's column, and § **"Every lane isolates its own resources"**, which is mandatory in every brief you write.
4. `DECISIONS.md` — every call already made, with reasoning and a reversal path. **Do not re-litigate these.** Also § "Queued for Aftab" — the six things that are genuinely his.
5. `RUNBOOK.md` — the integration ritual and the fresh-database gate recipe.

## How this project is run
You are the trunk. **You do not build in this checkout.** You dispatch one subagent per lane into its own worktree, integrate what comes back, and dispatch the next slice. Two to four at once where columns do not overlap.

```
~/dev/avo         you — trunk: merge, decide, route, gate
~/dev/avo-api     Lane A   feat/api      api/
~/dev/avo-wallet  Lane B   feat/wallet   apps/wallet/, apps/scanner/
~/dev/avo-web     Lane C   feat/web      apps/dashboard/, packages/ui/
~/dev/avo-qa      Lane D   feat/qa       **/*.test.ts, e2e/
```

**Aftab's standing instruction:** keep the lanes working unattended, make the decisions yourself, and do not ask him. If something genuinely cannot move without him, skip it, record it in `DECISIONS.md` § "Queued for Aftab", and move on. Record every call you make.

## FIRST ACTION — verify state, do not trust this prompt
The previous session's lanes were still running when it ended, so **their agents are gone but their worktrees are not**. Before anything:

```bash
cd /Users/koraspond_developer/dev/avo
git log --oneline -1 dev; git rev-list --count main..dev
for l in api wallet web qa; do
  printf "%-12s ahead:%s dirty:%s\n" "feat/$l" \
    "$(git rev-list --count dev..feat/$l)" \
    "$(git -C ~/dev/avo-$l status --porcelain | wc -l)"
done
```

As of handoff: `dev` at **9664707**, `main` **64 behind**. `feat/wallet` was 2 commits ahead; `avo-api` had 7 uncommitted files, `avo-web` 2, `avo-qa` 6. **Those numbers will have moved — re-read them.**

**If a worktree is dirty, preserve it before touching anything:**
```bash
cd ~/dev/avo-<lane>
git diff > ~/.claude/lane-<lane>-recovered-$(date +%F).patch
tar czf ~/.claude/lane-<lane>-untracked-$(date +%F).tgz $(git ls-files --others --exclude-standard)
```
`git diff` does **not** capture untracked files, and new files are usually the bulk of an interrupted slice. **Never `git reset --hard` or `git checkout .` in a lane worktree** — that destroyed a lane's work in this build and it was recovered only by luck. Uncommitted work is a lane mid-flight, not mess to tidy.

Then: merge anything committed and ahead, and re-dispatch each lane with a brief that tells it *its own uncommitted work is intact and to read it before changing anything*.

## Where to resume each lane

**Lane A — `api/`** (had `0032_platform_settings.sql` in flight)
Its last words before dying were: *"`DEFAULT_COMMISSION.cardFlatFils` is 50, not 0 — my default would have silently changed AVO's commission."* That is a money near-miss it caught in its own migration — do not lose it. Then: `GET /platform/metrics`, `PATCH /platform/settings`, the platform-wide audit read, the **console password-reset** (an invited platform admin cannot sign in at all today; #6 permits only a link and the design's "Temporary password" field must not be drawn), `policies_not_published` → **409** (it returns 503, which every client classifies as offline), and `reschedule` + the merchant-readable messaging policy into `api-contract.md`.

**Lane B — `apps/wallet/`, `apps/scanner/`**
Finishing the **Shop screen**, including the retired-product race: a product retired between the catalogue fetch and the order, where `POST /orders` answers `invalid_products` naming it. Then the **"Charged 0.000 KD" frame** (when a deposit covers the whole basket the headline reads Charged over a zero while the balance goes *up* — trunk decided: leave the figure, fix the frame, reusing the `deposit_return` copy that exists in both languages). Then the legacy-token secure-store migration, the one path still unproven on a device.

**Lane C — `apps/dashboard/`, `packages/ui/`**
**Approvals** — unblocked now that `GET /v1/platform/campaigns` emits `heldReason`/`heldAt`. Render the hold **sentence**, not a bell: quiet hours and the monthly cap hold the *campaign*; the weekly per-customer cap skips *recipients*. Then **Admins** (`/v1/platform/admins` is fully built). Then the remaining console sections as Lane A's three endpoints land.

**Lane D — `e2e/`**
The **near-duplicate charge guard** (`possible_duplicate`, 120s, migration 0031), the order path's **new second guard verified reachable alone**, the console's platform routes, and the go-live rows that are testable claims. Its method — *break each guard alone and record what still passes* — has found six real defects; keep using it.

## The gate, and `main`
`main` advances **only** on a genuinely twice-green run from a clean tree:
```bash
rm -rf packages/*/dist .turbo && pnpm build      # rebuild BEFORE the database; seed imports @avo/types from dist
./scripts/lane-db.sh ci                          # reset avo_ci
export DATABASE_URL="postgres://avo:avo_dev_password@localhost:5433/avo_ci"
export APP_DATABASE_URL="postgres://avo_app:avo_app_dev_password@localhost:5433/avo_ci"
pnpm check && pnpm check                         # POSTGRES_DB must stay unset
git checkout main && git merge --ff-only dev && git push origin main && git checkout dev
```
Run it only when the lanes are **idle** — a green produced under four concurrent lanes is worthless, and one attempt was OOM-killed. Docker must be up (`cd api && docker compose up -d --wait`).

## Traps this build has already paid for
- **Stale "not built" comments.** Nine instances; one cost a whole wasted lane dispatch. **Never conclude an endpoint is missing from a comment — grep `api/src/routes`.**
- **A check that matches a string, not the thing.** A `/password/` regex matched `passwordSet`; a test matched a substring that also appeared in a comment and stayed green with the real code deleted. If an assertion can be satisfied by a comment, it is not an assertion.
- **Assertions satisfied by an accident.** Two empty objects compare equal; a `WHERE` matching zero rows made a row-level trigger never fire and the spec reported the owner could rewrite the ledger. Assert *"the system refused"*, never *"nothing changed"*.
- **`pnpm --filter` from a lane worktree** runs another worktree's package. Use `pnpm --dir=/abs/path exec …`. Note `--dir <path> turbo` fails EACCES.
- **The machine runs PKT, two hours ahead of Kuwait.** A vitest `Start at 23:47` means 21:47 Kuwait — wrong in the direction that feels safe.
- **Seven shared mutable resources** have crossed lanes; they are catalogued in `LANES.md`.

## What is actually left
The remaining console sections, **Reports** (twice refused for good reason — no CSV route, three of four cards have no aggregate), and **trunk aggregation of `go-live-checklist.md`** (8/45). Its rows are scoped by *concern*, not surface, so no single lane can ever tick one — collating lane evidence is trunk's job and is the only honest path to green.

Everything else is blocked on Aftab: MyFatoorah live credentials, WhatsApp template approval plus a sending domain, counsel and PSP sign-off, a Google Cloud project, the retention decision, and the Arabic native-speaker review.
