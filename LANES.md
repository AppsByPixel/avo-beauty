# Four lanes — opening briefs

Four Claude Code sessions run at once, one per worktree. Open a terminal tab in each
directory and start a session there. `CLAUDE.md` loads automatically in all four, so the
12 non-negotiables and the one-writer-per-package rule are in context everywhere.

Start the mock first, from the trunk. All three UI lanes point at it.

```bash
cd ~/dev/avo && pnpm mock        # http://localhost:4000
```

| Lane | Directory | Branch |
|---|---|---|
| A · API | `~/dev/avo-api` | `feat/api` |
| B · Wallet | `~/dev/avo-wallet` | `feat/wallet` |
| C · Web | `~/dev/avo-web` | `feat/web` |
| D · QA | `~/dev/avo-qa` | `feat/qa` |

Merge every lane into `dev` at the end of each day. Four branches diverging for a week is
the failure mode this structure exists to prevent.

---

## Every lane isolates its own resources

**Eight** shared mutable resources have now crossed lanes: a Postgres database, the container,
the browser pane, a cross-worktree `pnpm --filter`, the turbo cache, the process table, the
session scratchpad, and an abandoned iOS simulator that starved three lanes to death. Most were
caught and disclosed by the lane that caused them — which is the standard, and also why this
rule exists rather than relying on it.

### Database — one per lane, already created

Trunk has created `avo_lane_a`, `avo_lane_b`, `avo_lane_c`, `avo_lane_d` and `avo_ci`.
**You do not create a database** — not because you cannot, but because trunk owns them.

`CREATE DATABASE` and `DROP DATABASE` are blocked in **some** lanes' sandboxes and not
others: lane C's drop was refused, so it carried on against the shared `avo_ci` and left a
row in it, while lane A's succeeded and it made two scratch databases before this rule
existed. **A blocked isolation step degrades into no isolation, quietly** — which is worse
than failing loudly. But do not read the permission as the rule. "It worked for me" is
exactly the reasoning that produces a database nobody else knows about, and the lane that
can create one is the lane that can leave one behind.

Reset yours instead:

```bash
./scripts/lane-db.sh c        # drops the SCHEMA inside avo_lane_c, migrates, seeds
```

Ordinary DDL inside a database you already own — nothing to block. Export the two URLs it
prints for anything you run against it. **Never set `POSTGRES_DB`**:
`e2e/support/global-setup.ts` skips minting its own per-run database when it sees one, which
puts every concurrent checkout back on shared fixtures.

If your database is missing, ask trunk. Do not work around it.

### Commands — `pnpm --dir`, never `pnpm --filter`

**Never `pnpm --filter` from a lane worktree. It resolves from cwd, so it can run another
worktree's package.** Use `pnpm --dir` with an **absolute** path — not a path relative to
cwd, which has the same failure.

```bash
pnpm --dir /Users/koraspond_developer/dev/avo-a/api run db:migrate    # yes
pnpm --filter @avo/api run db:migrate                                 # no
```

Lane A watched `pnpm --filter @avo/api run start`, run from its own worktree, boot
**`~/dev/avo-wallet/api` against `avo_lane_b`** — another lane's code and another lane's
database. The output looked completely normal and it nearly filed the result as a finding.
The tell was indirect: `pin_attempt` stayed empty in its own database after a login it had
just watched succeed.

Inside `scripts/lane-db.sh` the same call was worse, because the script exports
`DATABASE_URL` before invoking pnpm: **another worktree's migrations and seed applied to
this lane's database** — the exact cross-lane write the script exists to prevent, and it
would have looked like a clean reset.

This rule kept regressing because it lived only in `lane-db.sh`'s comments and in 21 e2e
error strings, so a 22nd place could reintroduce it silently — which is what happened. It is
written here now because this is where the briefs point.

**Assert what you are actually talking to before you trust output.** Lane A's habit, and it
is the only reason this was caught:

```bash
docker exec -i avo-postgres psql -U avo -d postgres \
  -c "SELECT datname, count(*) FROM pg_stat_activity WHERE usename='avo_app' GROUP BY datname;"
```

Anchor load-bearing claims in SQL against your own database rather than in the API's own
reply. A server that answers plausibly is not evidence that it is *your* server.

### The scratchpad is shared between lanes — a seventh vector

The session scratchpad directory looks per-agent and is not. Lane C wrote `pids.txt` there for
its own cleanup; **another agent overwrote it**, and the PIDs it then contained belonged to
**lane B's live `avo-wallet/api` server**. A cleanup step written as `kill $(cat pids.txt)`
would have killed another lane's API — the exact cross-lane process write this section
catalogues, arriving through a file rather than a pattern. Lane C escaped it only because it
passed a hardcoded list instead of reading its own file back.

So: **treat generic filenames in the scratchpad as unsafe.** If you must write state there,
prefix it with your lane (`lane-c-pids.txt`), and prefer keeping PIDs in shell variables that
cannot be overwritten by anyone. A file you wrote is not necessarily a file you will read.

### A simulator you boot and abandon starves every other lane — an eighth vector

A lane booted an **iPhone 17 simulator** to verify native behaviour, then died. The simulator
stayed up, and with its `Virtualization` host and two `VideoToolbox` encoder services it drove
the machine to **load average 463** on twelve cores with 72% of memory still free — I/O and
process contention, not compute. **Three other lanes hit the 600-second watchdog and were
killed** while holding uncommitted work.

Shutting down that one orphaned simulator took the load from **463 to 61** in twenty seconds.

So: **if you boot a simulator, shut it down in the same slice**, and treat it as heavier than
any server you start. `xcrun simctl shutdown all` if you are unsure what you left behind, and
`xcrun simctl list devices booted` in your cleanup observation alongside the `ps` sweep and the
port scan — a booted simulator holds no port and appears under none of the process names a lane
greps for, which is exactly why three lanes died without anyone seeing the cause.

Trunk's lesson too: **when several lanes stall at once, check the machine before re-dispatching
them.** Sending three fresh agents into a saturated host reproduces the failure and costs
another round of interrupted slices.

### Browser — one context per lane

The lanes share one browser pane. Lane B once injected a `fetch` shim into **Lane C's
dashboard tab** and briefly left `window.fetch` undefined there. It caught it and restored
it, then moved to an isolated Chromium — but a page you did not open is another lane's
running app, and `javascript_tool` against it is a write into their process.

- **Open your own tab or your own browser context.** Never evaluate script in a tab you did
  not open.
- **Never stub a global** — `fetch`, `localStorage`, `Date` — on a shared surface. A test
  that needs a stub needs its own context.
- Check `tabs_context` first. If you did not open it, leave it.

### Ports and processes

Pick a port nobody else is using and name it in your report. The API has been on 4000, 4100,
4200, 4400 and 4500 across lanes; Vite on 5173 and 5199; Expo on 8081 and 8090. A leaked API
process — ppid 1, two and a half hours old — was once still polling `receipt_job` against a
database another lane was asserting against.

Kill what you start. A `pnpm check` that hangs on *"something prevents N Vite servers from
exiting"* is a leaked process, not a test failure.

**Prove the cleanup, do not print it.** Two lanes have now shipped a cleanup step that
reported success while leaving the process alive, and both said so themselves:

- `xargs -r kill` exits 0 on empty input, so a loop printed "killed 4101…4121" for every
  port whether or not anything was there.
- `pkill -f 'tsx src/server.ts'` never matched the real command line,
  `tsx watch --env-file-if-exists=.env src/server.ts`. A Vite server survived on 5173 for
  hours, an API kept holding 3000, and a later restart died on `EADDRINUSE` — the leak the
  rule above describes, caused by the code meant to prevent it.

So end with an observation, not an action: a `ps` sweep and a port scan that come back empty.
A misleading success line is the same defect as a green typecheck bought with a cast — it
spends your trust on something that did not happen.

**Kill by PID or process group. NEVER by name pattern.** The process table is shared by all
five worktrees, and a pattern does not know which worktree a process belongs to.

One lane ran unscoped `pkill -f vitest` on a loop, twice per cycle, for about an hour. It
killed **lane D's suite mid-run from a different worktree** — exit 144, no output — and because
every kill skipped teardown it left **9 orphaned per-run databases and 6 leaked mock
processes** behind. Lane D lost real time to per-`describe` verification before working out
that the failures were not its own. `ps` shows vitest workers as `node (vitest)`, so no
launcher path or filter evades a `-f vitest` pattern.

This is the sixth shared mutable resource, after the database, the browser pane, the
cross-worktree `pnpm` invocation, the container and the turbo cache. It is the worst of them,
because the others produced misleading results and this one destroys another lane's work while
looking like a flaky suite.

Record your own PIDs when you start something and kill those. If you genuinely cannot, scope
the pattern to your own worktree path and say in your report what you killed.

### Build freshness — `--dir` alone does not rebuild

The two rules above interact, and the interaction is silent.

`pnpm --dir <pkg> run typecheck` runs that package's `tsc` **directly**, bypassing turbo — so
`turbo.json`'s `"typecheck": { "dependsOn": ["^build"] }` never fires and `packages/types`
is never rebuilt. Lane C read `packages/types/dist/entities.d.ts`, found `passwordSet`
genuinely absent, and concluded the shared schema was missing a field it had actually carried
since `133a657`. The observation was true of what the compiler could see and still the wrong
conclusion.

Run turbo from your own worktree root, which gets you both the build edge and the right
worktree:

```bash
pnpm --dir=/Users/koraspond_developer/dev/avo-web exec turbo run typecheck
```

**Do not reach for `--force` by habit.** The cache is sound and paying 8s on every merge to
distrust it is how the next real anomaly gets waved through as normal. Three cases:

- **Tree changed → trust the cache.** A cold run *is* a gate.
- **Need independent confirmation of the same tree → `--force`.** A replay is not a second
  opinion. This is the same trap as "green twice" being one run and a replay, which
  `turbo.json` documents at length for `test` — the difference is that `test` is uncached, so
  it cannot bite you there.
- **Suspect the cache → `--dry=json`.** It prints each task's hash and input count and
  executes nothing:

  ```bash
  pnpm turbo run typecheck --dry=json
  ```

The key mechanism has been checked and is not the problem. There is no `inputs` override, no
remote cache and no `TURBO_*` env, so every task uses the default input set — and that set is
complete: `@avo/dashboard` 48, `@avo/ui` 19, `@avo/wallet` 84, `@avo/api` 120, each an exact
match for `git ls-files` on that package. It is also **responsive**: appending one comment
line to a dashboard file moves `@avo/dashboard#typecheck` from `c2527732…` to `f937cbcf…`.

That matters more than it looks. If the key under-covered, `build` would share the defect —
and `build` is what `seed.ts` imports `@avo/types` from, what the drift guard parses against,
and what hid a missing dependency edge for a whole session. A key that could no-op on changed
source would mean every downstream check reads yesterday's contract. It cannot.

**A failed invocation still caches everything that finished before it died.** Turbo writes a
cache entry per task, at the moment that task succeeds — not at the end of the run. So
`pnpm build` dying at exit 137 on `@avo/dashboard#build` still left its dependency builds
cached, and the next `turbo run build --filter=@avo/dashboard` reported `3 successful,
2 cached`. "The run failed" does not mean "nothing cached", and a fast re-run after a failure
is not automatically suspicious.

Note also that `typecheck` depends on `^build` — **dependencies'** builds, not its own
package's. `@avo/dashboard#typecheck` never waits on `@avo/dashboard#build`, which is why a
build failure in one package does not block typechecking it.

**Your turbo cache is trunk's cache. There is only one.** Trunk's `.turbo/cache` holds every
lane's entries — 84 of them — and none of `avo-api`, `avo-wallet`, `avo-web` or `avo-qa` has a
cache directory at all. Each lane's `.git` is a pointer into
`/Users/koraspond_developer/dev/avo/.git/worktrees/<name>`, so turbo resolves the repository
root through the shared git dir and writes there.

This is the fifth shared mutable resource, and unlike the others it is **not** a correctness
problem: the key is content-derived, complete and responsive, so a hit returns a result
computed from identical content. A cached green is a real green.

What it costs is **independence**. When trunk merges your branch and typechecks it, a `HIT`
may be replaying *your* run of that same content minutes earlier — the verdict is sound but it
is your verdict, not a second opinion. That is exactly the case the `--force` rule above
covers, and it is why "same tree, independent confirmation" is a real distinction rather than
a pedantic one. Two `FULL TURBO` post-merge runs in trunk were traced to precisely this, both
on lane C merges; the trail is in `DECISIONS.md`.

---

## Lane A — API

> Build the API in `api/`. Start with the Postgres schema: salon, branch, member,
> staff_user, transaction, ledger_entry, audit_log, idempotency_key, wallet_token. Money
> columns are `bigint` fils. A negative balance must be impossible **at the database
> level**, not in application code, and `audit_log` must have `UPDATE` and `DELETE` revoked
> at the role level so it is append-only for real.
>
> Then implement, in this order: auth (member phone+password with argon2id, staff PIN
> hashed and scoped to device+salon with lockout, web username+password, refresh with
> revocation), then `POST /topups` + `GET /topups/{id}` behind a gateway adapter with a
> sandbox implementation, then `POST /charges` as ONE transaction per
> `design/api-contract.md` § Charging.
>
> `packages/mock/src/server.ts` is the shape you are implementing — match its responses
> and its error codes, including the 402 carrying the exact shortfall and the 410 on a
> consumed token.
>
> You write only to `api/`.

## Lane B — Wallet

> Build the customer wallet in `apps/wallet/` with Expo, web target on. Point the API
> client at `http://localhost:4000`.
>
> Order: auth + signup consent (store the accepted `policyVersion`), then Home — wallet
> card, balance, the live QR on 45s server rotation with countdown, both loyalty modes,
> activity feed. Then the transaction detail sheet, then Top up with all four outcome
> screens.
>
> Build the states **with** each screen, not after. The mock serves them:
> `x-avo-scenario: loading | empty | error | offline`, and they combine —
> `empty,stamps` is a new member at a stamps salon. Offline keeps the last-known balance
> with a timestamp and **hides the QR**. Never render `0.000` before data arrives.
>
> Read layout, spacing and copy from `design/AVO Wallet Home.dc.html` and the states from
> `design/AVO States.dc.html`. Import every colour from `@avo/tokens` and every money
> helper from `@avo/types`.
>
> You write only to `apps/wallet/` and `apps/scanner/`.

### Lane B also owns the scanner

`design/ADR-0001-stack.md` puts the wallet and the scanner in **one Expo codebase**, so they
share a lane rather than competing for one. Lane B's column is `apps/wallet/` **and**
`apps/scanner/`.

If a component genuinely belongs to both — a money display, a sheet, a button — it moves to
a shared package, and that is a trunk conversation, not something either app does quietly.

## Lane C — Web

> Build the merchant dashboard in `apps/dashboard/` with React + Vite, and the shared
> component library in `packages/ui/`. Point the API client at `http://localhost:4000`.
>
> Order: sign-in per `design/AVO Login.dc.html`, then Overview, then Settings, then the
> Loyalty editor (threshold validation and an **atomic** publish — a half-published tier
> ladder is a money bug), then Accounts → Team authority with the nine permission chips,
> then the Audit log with its four filters.
>
> Structure routing and permissions so the owner console can be added later as a second
> auth scope in the same app, not a second codebase.
>
> The four breakpoints, the focus ring and the keyboard map are in
> `design/interaction-spec.md` §1–2. Below 768px shows the "open on a larger screen"
> notice — that is the design, not a gap.
>
> You write only to `apps/dashboard/` and `packages/ui/`.

## Lane D — QA

> Own the test suites. Start with the concurrency cases against lane A's API as it lands:
> double scan of one token, double submit of one charge, duplicate gateway callback,
> callback arriving before the client returns, and a charge crossing a happy-hour
> boundary.
>
> Then the permission suite: for every gated endpoint, a test that calls it **directly**
> with the permission off and asserts a 403. `GET /charges` and `POST /voids` first.
>
> Then an audit-row test — every mutating handler writes one, and the row cannot be
> updated or deleted.
>
> Review the other lanes' diffs adversarially. You did not write the code and should not
> assume the reasoning behind it.
>
> You write only to `**/*.test.ts` and `e2e/`.


---

## Order of work, and why

Not a preference — dependency, checked against what the API actually serves.

**1 · Scanner (lane B).** Fully unblocked: `POST /staff/session`, `GET /staff/me`,
`POST /scans`, `POST /charges`, `POST /voids` all exist and are tested under concurrency.
It is also the highest-value gap — without it there is no way to demonstrate a salon taking
a payment, which is the whole pilot. Build it first, and watch it, because it is a new
surface with a real camera on a real device.

**2 · API (lane A).** The dashboard needs four endpoints that do not exist:
`PUT /artists/{id}/availability`, the audit log, loyalty publish, and the artists list.
Until those land, lane C can only build against a mock and re-do the wiring later.

**3 · Dashboard (lane C).** Consumes what lane A just built. Running it *ahead* of the API
is what produced the throwaway sign-in stand-in that had to be rewritten.

**4 · QA (lane D) — always last, and always against integrated code.** Its best runs came
from testing what had already merged; its worst came from testing one lane's branch in
isolation, where a half-landed migration made a schema-pinned spec flap. Merge first, then
sweep.
