# Prompt for the next session

You are the **trunk session** for the AVO Beauty build in `/Users/koraspond_developer/dev/avo`.

Your job this session is **verification, not construction**: read the plan and the design bundle
in full, then test what has actually been built against them. Find where the build and the
specification disagree. Do not add features.

---

## 1 · Read these first, in this order

In the repo root:

| File | What it is |
|---|---|
| `CLAUDE.md` | The 12 non-negotiables and the one-writer-per-lane rule. Loads automatically. |
| `RUNBOOK.md` | How to drive four lanes, and the gate recipe. |
| `LANES.md` | Each lane's column, and § "Every lane isolates its own resources" — eight shared mutable resources that have crossed lanes and destroyed work. |
| `DECISIONS.md` | 54 entries: every call made without asking, with reasoning and a reversal path, plus 15 items queued for the client. **Do not re-litigate these.** |
| `STATUS.md` | Where the build is. **Assume it is stale** — see §3. |
| `PRIOR-ART.md` | What AvoRewards, AVO's existing live platform, already learned the hard way. |
| `DEMO.md` | The verified two-process demo path, with seeded credentials. |

In `design/` (the frozen handoff bundle — these are **final**, build to them, do not redesign):
`build-plan.md`, `README.md`, `api-contract.md`, `interaction-spec.md`, `go-live-checklist.md`,
`ADR-0001-stack.md`, `AVO-Beauty-Product-Description-v2.md`, `whatsapp-templates.md`, the six
`*.dc.html` screen references, and `tokens/avo-tokens.json`.

`.claude/skills/` has `money-check`, `perms-check`, `states-check`, `screen-from-design`. Use them.

---

## 2 · The single most important instruction

**Verify every claim against the code before you act on it — including claims in this document,
in `STATUS.md`, in code comments, and in the API contract.**

The previous session made **six wrong statements** to the user, and every one had the same cause:
trusting a *representation* of state instead of the state itself.

- `api-contract.md` says what **should** exist. The routes say what **does**. Twice, endpoints were
  reported as built from the contract and were not (console Reports; five of the six Support
  endpoints — actually six, a `DELETE` written as `DELETE/v1/…` with no space was missed twice).
- A code comment describes another file, and ages independently of it. **Nine** stale "not built"
  comments have been found in `api/src/routes`, four of them asserting a validation or an endpoint
  that existed. One made a live tile show `0` permanently.
- A partial test log was read as a result: "792 passed" was reported to the user as evidence from a
  run that **never finished**.
- The console was reported as "9 of 10 sections" by counting `.tsx` files instead of nav items. It
  is **7**.

**The habit:** before telling anyone something exists, run the command that proves it.

```bash
grep -rnE "app\.(get|post|patch|delete|put)" api/src/routes/    # what is actually registered
```

And **a zero result is a claim about your command as much as about the tree.** This build has been
fooled by: `_` as a `LIKE` wildcard (`rst_` matched "fi**rst**"), a zsh-eaten unquoted
`--include=*.ts`, `git diff` silently skipping untracked files, a greedy `sed` eating every line,
and a grep that printed `CLEAR` off a *failed* command. **Run every sweep against a known-positive
first.**

---

## 3 · Where the build is — run this, do not read a number

```bash
./scripts/state.sh
```

Read-only. Prints git position, every lane worktree's ahead/behind **and anything uncommitted
in it**, what is built, and the specification counters.

**This section used to be a table.** It was written on 2026-08-25 and stated `dev = 1ee49a0,
482 commits`. Before anyone read it, 110 commits landed. Its own first instruction was
"re-measure before believing" — correct, and useless, because a reader given a stale number and
no way to refresh it will use the stale number.

Then, while replacing the table with the script, the state moved **again between two
measurements minutes apart**: 592 → 600 commits, e2e 35 → 36 files, the console 7 → 9 sections.
**Other sessions work in this repo concurrently.** Check `./scripts/state.sh` and `git log` before
assuming you are alone, and before assuming a thing you remember is still true.

Two things the script deliberately does not tell you:

- **Whether the suite passes.** It greps. A real answer is `RUNBOOK.md`'s gate, run twice.
- **Whether the console's unbuilt sections are blocked or merely unbuilt.** As of this writing
  Billing was blocked on a client decision (no trial/subscription/invoice column exists and the
  design's figures are prototype fixtures) while others were simply not built yet. Check
  `DECISIONS.md` before treating an empty section as work.

## 4 · How this project is run: four lanes, four worktrees

**You are the trunk. You do not build in this checkout.** You dispatch one subagent per lane into
its own git worktree, integrate what comes back, and dispatch the next slice. Parallel dispatch is
authorised and expected.

```
~/dev/avo         you — trunk: merge, decide, route
~/dev/avo-api     Lane A   feat/api      api/
~/dev/avo-wallet  Lane B   feat/wallet   apps/wallet/, apps/scanner/
~/dev/avo-web     Lane C   feat/web      apps/dashboard/, packages/ui/
~/dev/avo-qa      Lane D   feat/qa       e2e/ and cross-cutting tests
```

`packages/types`, `packages/tokens` and `packages/mock` are **trunk-owned**. Changing them lands on
`dev` first, then every lane rebases. A colocated test inside a lane's package belongs to **that**
lane, not to Lane D's glob (`LANES.md` records the deciding question).

**Every brief has four parts**, and the fourth catches the real bugs:
1. Who it is and which worktree. 2. One slice, sized for a run. 3. Its column, restated —
*"if the change you want is outside it, stop and report."* 4. **Verify by running it and pasting
real output.** Not "it should work" — the SQL, the status code, the balance before and after.

**Every brief must also point at `LANES.md` § "Every lane isolates its own resources".** Each lane
resets its own database with `./scripts/lane-db.sh <a|b|c|d>`; **never** `CREATE`/`DROP DATABASE`,
**never** set `POSTGRES_DB`, **never** `pnpm --filter` (it resolves from cwd and has run another
worktree's code against another lane's database while looking normal — use `pnpm --dir=<absolute>`,
or `pnpm --dir=<worktree> exec turbo run <task>` for the build edge), **never** `pkill -f` (an
unscoped `pkill -f vitest` once killed another lane's suite mid-run and left 9 orphaned databases).
Assign each lane distinct ports and have it kill only recorded PIDs, ending with an *observation* —
a `ps` sweep and port scan that come back empty — because two lanes have shipped cleanup that
reported success while leaving the process alive.

**Integrate one lane at a time**, checking after each. Not at the end, or you know something broke
and not which lane broke it.

---

## 5 · The gate, and why a typecheck is not it

`main` advances only on a genuinely twice-green run from a clean tree. `RUNBOOK.md` has the recipe;
run it **only when lanes are idle** (one attempt was OOM-killed under load) and on a quiet host.

```bash
pnpm install                       # step 0 — a new workspace dep leaves stale symlinks that read
                                   # as a broken import; the lane that adds one cannot see it
rm -rf packages/*/dist .turbo
pnpm build                         # BEFORE the database: seed.ts imports @avo/types from dist
docker exec -i avo-postgres psql -U avo -d postgres \
  -c "DROP DATABASE IF EXISTS avo_ci;" -c "CREATE DATABASE avo_ci OWNER avo;"
export DATABASE_URL="postgres://avo:avo_dev_password@localhost:5433/avo_ci"
export APP_DATABASE_URL="postgres://avo_app:avo_app_dev_password@localhost:5433/avo_ci"
pnpm --filter @avo/api run db:migrate && pnpm --filter @avo/api run db:seed
pnpm check && pnpm check           # twice. POSTGRES_DB must stay unset.
```

**A green `turbo run typecheck` is not evidence for a `packages/types` change.** The previous
session treated it as such four times and was wrong every time: one schema widening broke the mock
fixture (twice), a dashboard interface, and a wallet test fixture — **all runtime shape, none
visible to `tsc`.** After any shared-package change, run `pnpm check`.

**A single green run has been wrong three times** — on a stale `dist`, on a warm database, and on a
turbo cache replay that took 14ms. Note also that **the turbo cache is shared across all five
worktrees**, so a replayed log's paths name whichever worktree first populated the hash: it is
evidence about *someone else's* tree, never yours. `--force` when you intend to trust a result.

---

## 6 · Your actual task: test what has been built

Work through the plan and the design, and for each phase ask **what would prove this, and does that
proof exist?** Dispatch lanes to close gaps you find; do not build features.

Suggested shape:

1. **Read `design/build-plan.md`'s nine phases and `go-live-checklist.md`'s 53 rows.** The checklist
   is the specification for "done". 38 rows are open. Many are scoped by *concern* rather than
   surface ("states on every screen", "focus on both web surfaces"), so **no single lane can ever
   tick one** — only trunk collating lane evidence can. That is the honest path from 15 to green.
2. **Walk `api-contract.md` against the routes.** Every endpoint the contract names: does it exist,
   is it gated, is it probed? Lane D has a **generated** permission census (`e2e/permission-census.test.ts`)
   that reads `api/src/routes/` and turns every gate into a probe — 57 gates, all enforced. Extend
   that method rather than hand-keeping lists.
3. **Walk the design's screens against the built ones.** `design/*.dc.html` are interactive
   references — read them for layout, copy, colour and interaction; do not copy their markup. Check
   the four states (loading, empty, error, offline) per `interaction-spec.md` §4 and `AVO States.dc.html`.
4. **Drive the money paths.** Charge, top-up, void, deposit return, adjustment, and the concurrency
   cases. `.claude/skills/money-check` audits a diff — **note it must `git add -N` first**, or it
   inspects an empty diff and reports no findings.
5. **Run the demo** (`DEMO.md`) and click through it. Several of this build's real defects were
   found only by driving: a void under-refunding 3.000 of 8.000, a dashboard showing one staff
   member another user's figures, a scanner reading another salon's customer.

**Ask of every green test: what would still pass if the guard were absent?** That question has
repeatedly found tests that could not fail. Examples worth knowing:
- A contradicting-route spec that would have passed a handler hardcoded to `'avo'`, because the
  topic it used was genuinely AVO-routed — right answer and wrong answer coincided.
- A double-submit spec that passed with the requests **sequential** (measured overlap: −0.003ms),
  so the concurrency it existed to test never happened.
- Five simultaneous charges all reporting the same balance — a lost update in its purest form —
  while all seven sequential specs in that `describe` stayed green.

---

## 7 · Traps this build has already paid for

- **Never trust a comment — grep the routes.** Nine stale ones found.
- **A status code is not evidence about which guard answered.** A 404 from a missing route and a
  404 from a real refusal are the same three digits; assert the error **code** and the state.
- **Assert "the system refused", never "nothing changed."**
- **A schema narrower than the wire is lossy, not smaller.** Zod *strips* undeclared keys rather
  than failing. Seven drifts found this way. **Widen the schema; never narrow the response.**
  `e2e/contract.test.ts` is the guard and it fails by name.
- **`git diff dev HEAD`** against a moved `dev` lists other lanes' merged files and reads exactly
  like a column breach. Use `git diff $(git merge-base dev HEAD)..HEAD`.
- **This machine runs PKT, two hours ahead of Kuwait.** Anything reasoning about "today" must use
  the salon's IANA zone, not the host clock.
- **The mock is not typed against the schemas it imitates for *data*.** It served five invented
  support-topic ids for the whole build; the wallet's Contact-us form worked against it and would
  have been refused by the real API on every topic. `packages/mock/src/fixtures.test.ts` now guards
  the topic vocabulary — that pattern should be extended to other fixture data.
- **`pnpm start` is not a watcher.** Restart before believing output; a stale binary has twice
  nearly become a finding.

---

## 8 · Blocked, and not yours to decide

`DECISIONS.md` § "Queued for Aftab" has 15 items. The ones that gate a launch: **CBK position on
holding stored value**, **counsel and PSP sign-off on the legal set**, **WhatsApp template approval
and a sending domain** (receipts, reset links and campaigns are fully built behind a logging driver
and cannot send), and a **native-speaker Arabic review** (74 keys in `AR_GAPS` have no source in the
bundle; they are deliberately English and must not be machine-translated).

Also client-owned: whether the 14-day trial the onboarding wizard promises actually exists (nothing
implements it), what a customer should see for a salon-initiated balance change, and the
set-new-password screen the design never drew.

If something cannot move without the client, **record it in `DECISIONS.md` § "Queued for Aftab" and
move on.** Do not invent product to fill a gap. Several deliberate omissions look like bugs and are
documented refusals — check `design/README.md` § "Known gaps" and `DECISIONS.md` before "fixing"
one.

---

## 9 · Standing instruction from Aftab

Keep the lanes working unattended. Decide yourself; don't wait on him. Everything decided without
asking goes in `DECISIONS.md` with its reasoning and a reversal path — a decision you cannot find
is a decision you cannot reverse. `dev` never stays red: fix it or revert it before moving on, and
route a lane's work back to that lane rather than editing its column from trunk.
