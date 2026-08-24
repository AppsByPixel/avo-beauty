# Where this is, right now

Written as a handoff. If you are a fresh session picking this up, read this first, then
`CLAUDE.md`, then `RUNBOOK.md`. Everything else is detail.

**Day 4 of a 30-day pilot build** (started 2026-08-16). `dev` is the trunk; `main` tracks it
when green. The build is far ahead of the calendar — what remains is mostly not code.

---

## HOW THIS PROJECT IS RUN — read before doing anything else

**Aftab has authorised parallel subagent dispatch, and expects it.** This is a standing
instruction, not a one-off. He asked for it explicitly, repeatedly, and asked for it to
continue unattended:

> "I need them to work simultaneously at the same time."
> "run all of them in this session and keep running… Do not depend on any action or
> decision from my side."

So: **you are the trunk.** You do not build in this checkout. You dispatch one subagent per
lane into its own worktree, integrate what comes back, and dispatch the next slice. Four
lanes, four worktrees, listed in `LANES.md`.

```
~/dev/avo         you — trunk: merge, decide, route
~/dev/avo-api     Lane A   feat/api      api/
~/dev/avo-wallet  Lane B   feat/wallet   apps/wallet/, apps/scanner/
~/dev/avo-web     Lane C   feat/web      apps/dashboard/, packages/ui/
~/dev/avo-qa      Lane D   feat/qa       **/*.test.ts, e2e/
```

**Dispatch two to four at once** when their columns do not overlap. Scanner and API never
collide; API and dashboard do, because the dashboard consumes what the API has not built
yet. `LANES.md` carries the order and the reasoning.

**Every brief must name the lane's own database and browser context.** **Seven** shared mutable
resources have now crossed lanes: the database, the browser pane, a cross-worktree `pnpm
--filter`, the container, the turbo cache, the process table (an unscoped `pkill -f vitest`
destroyed a lane's suite for an hour), and the session scratchpad (a `pids.txt` overwritten
with another lane's live server PIDs). Trunk
has pre-created `avo_lane_{a,b,c,d}`; lanes reset theirs with `./scripts/lane-db.sh <lane>`
and never run `CREATE DATABASE`. Full rules in `LANES.md` § "Every lane isolates its own
resources" — put a line in each brief pointing at it.

**Every brief has four parts**, and the fourth is the one that has caught every real bug:

1. Who it is and which worktree.
2. One slice, sized for a run — not an hour, not a week.
3. Its column, restated. *"If the change you want is outside it, stop and report."*
4. **Verify by running it and pasting real output.** Not "it should work" — the SQL error
   text, the screenshot, the balance before and after.

**Then integrate**: merge one lane at a time, `pnpm check` after each — never at the end, or
you know something broke and not which lane broke it. Then the fresh-database recipe in
`RUNBOOK.md`, twice.

**Do not build a lane's work yourself in the trunk checkout.** Route it. Trunk editing a
lane's column turned one failing spec into four, once; the policy since is route and accept
a short red.


---

## CURRENT STATE — 2026-08-25, and the plan from here

`dev` **773d66a** · 496 commits · `main` 14 behind (it advances only on a clean twice-green gate)
29 e2e files, **673 `it()`/`test()` calls** (grep count, not a run) · `db:verify` exit code gated in CI
`go-live-checklist.md` **15 ticked / 38 unticked** · 38 migrations, latest committed `0037_salon_onboarding.sql`
**24 route files** (not 26 — `salons.test.ts` and `support.test.ts` sit in `routes/` and register
zero routes) · 122 `app.<method>` registrations, but **124 endpoints**: `POST /webhooks/:provider`
registers on `scoped.post` and `GET /_health` lives outside `routes/`, so both are invisible to
every `app.`-anchored sweep — including the permission census's.

**Numbers above were re-measured 2026-08-25 01:50 PKT.** The block they replace was stale by six
days on every line: it said 337 commits (496), 10/43 go-live (15/38), 33 migrations (38). It also
carried its own warning that it goes stale faster than the tree — which it then did. **Verify
against git before believing any line of this file, including this one.** The commands are in
§ "the habit" of the verification handoff; a zero result is a claim about your command as much as
about the tree.

### Where the 30-day plan actually stands

| Phase | State |
|---|---|
| 0 · Foundations | **Done** |
| 1 · Wallet read-only | **Done** — sign-in, signup, session layer, secure store proven on a simulator |
| 2 · Money core | **Done bar receipts.** `RECEIPT_DRIVER: z.enum(['logging'])` — one driver, so nothing sends |
| 3 · Staff scanner | **Done bar a real QR on real hardware** (needs a device) |
| 4 · Merchant dashboard | **Done.** Seven sections, Team wired, branches editor, permission ledger verified row by row |
| 5 · Shared platform state | **Done** |
| 6 · Booking and shop | Booking done. **Shop: API done, wallet screen in flight** |
| 7 · Owner console | Platform principal, policy publish, campaign decision and #8-at-send **done**. Approvals + Admins in flight. Metrics, settings, platform audit read and console password-reset **not built** |
| 8 · Hardening | `go-live-checklist.md`, 8/45 |

**All twelve non-negotiables are satisfied.** #10 was the last one open and closed when signup landed.

### Session of 2026-08-19 — four lanes merged, and what each returned

**THE GATE RAN AND MAIN ADVANCED — 2026-08-23, `e7015f8`.** Everything is level:
`dev`, `main`, all four `feat/*` branches, `origin/dev` and `origin/main` are the same commit.
416 commits. Nothing unpushed, nothing behind, no worktree dirty.

The gate was run as `RUNBOOK.md` writes it, with lanes idle and the host quiet (load 1.85 after
a reboot — the OOM-killed attempt happened under four live lanes, and that is the precondition
that matters): `rm -rf packages/*/dist .turbo`, then **rebuild before touching the database**,
then a dropped-and-recreated `avo_ci`, migrate, seed, and `pnpm check` **twice**, with
`POSTGRES_DB` never set.

**Both runs: 23 files, 889 passed, 32 todo, 0 failed** — at **482s** and **494s**. The differing
durations are the point: this project has been fooled three times by a single green run, once by
a turbo replay that took 14ms and was reported as a pass. Two real runs, eight minutes each.

All four lanes merged: **A** `0e0b50f`, **C** `0c6a3fa`, **D** `44f17ec`, **B** `0614e2f` and
`1bdf6ae`. go-live **10 → 13 ticked / 40**.

**What actually shipped.** Lane A: the console password-reset's *redeem* half, so an invited
platform admin can sign in — the invite and the refusal were both already correct and there was
no door between them. Lane C: the console's Admins section, plus a removed admin who still
rendered with a live role select and nine live chips while the header counted her. Lane B: the
authorised offline cold-load sentence, the `FailureScreen` kind that `useShop` was discarding,
and two more screens that had already shipped "showing your last update" with nothing on screen.
Lane D: the console's eight gates (previously zero coverage), the order path's basket guard, and
the first reset redemption any spec has driven on either surface — 700 specs, twice, on fresh
databases with negative controls.

### The pattern this session, and the reason to read the rest of this file suspiciously

**Every lane corrected a claim I gave it, and every one of those claims came from this file.**

- The order path's "second guard verified reachable alone" — **unreachable by construction.**
  Deliberate type-narrowing the author chose over the file's only `!`, and its own comment says
  so. The defect was in the description, not the code.
- "The no-show return job has never been executed by a spec" — **12 occurrences, 5 hard
  assertions**, driven through the real runner.
- "31 Arabic strings have no source" — **74**, plus a derived-forms list. It more than doubled as
  screens landed and nothing recomputed it.
- "`ShopScreen` makes no reference to `invalid_products`, so the wallet does not handle it" —
  true grep, false inference; the handling was **deliberately extracted** so a test could reach
  it.
- A 403 branch I instructed on `BookingsScreen` — **unreachable**; that route raises 404 by
  design, so the branch would have been dead code with an invented string attached.

Five for five. **A status file is prose about code, and prose does not recompile.** The
generalisation worth more than any single fix: **a zero result is a claim about your command as
much as about the tree.** This session was misled by a silent zsh glob eating `--include=*.ts`,
by `_` as a `LIKE` wildcard (`rst_` matching "fi**rst**"), and by a single-file grep against an
extracted module — three shapes of one error, each caught only because a lane re-checked
something it had been told.

### What is left after those queues drain

1. The **remaining console sections** as Lane A's three endpoints land.
2. **Reports** — still correctly refused twice: no CSV route, and three of four cards have no aggregate. `build-plan.md` puts it in Phase 7.
3. **Trunk aggregation of `go-live-checklist.md`.** Its rows are scoped by *concern*, not surface — "states on every screen", "focus on both web surfaces" — so **no single lane can ever tick one**. Only trunk collating lane evidence can, and that is the honest remaining path from 8/45 to green.
4. Anything the client unblocks (below).

### Standing decisions a fresh session must not re-litigate
All in `DECISIONS.md` with reasoning and a reversal path. The load-bearing ones:
- Sign-in identity is **phone**, not the username the design draws — the design contradicts its own copy, and no member username column exists.
- **The overnight happy hour stays impossible for the pilot.** Rule and schema agree; fixing it is a four-way break for no plan criterion.
- **Near-duplicate charge**: refuse with `possible_duplicate`, name the earlier transaction, 120s, explicit confirm. A flag cannot work — the triggering condition is a response the client could not read.
- **No retry affordance on a charge error state.** A client that could not read the response cannot know whether the money moved.
- `TRUST_PROXY` **fails fast in production** when unset.
- A merchant **may read** the effective messaging policy; the write stays platform-only.

## Read these, in this order

| File | What it is |
|---|---|
| `CLAUDE.md` | The 12 non-negotiables and the one-writer-per-lane rule. Loads automatically. |
| `RUNBOOK.md` | How to actually drive four lanes. Start here on day one. |
| `LANES.md` | Each lane's column, brief, and the work order with reasoning. |
| `DECISIONS.md` | Every call made without asking, why, and how to reverse it — plus the questions that are the client's, not ours. |
| `PRIOR-ART.md` | What AvoRewards, AVO's live platform, already learned the hard way. |
| `.claude/skills/` | `money-check`, `perms-check`, `states-check`, `screen-from-design`. |

The git log is part of the record: commit messages carry the reasoning, not just the diff.

---

## What works

Money core proven against real Postgres — charges, top-ups, the signed gateway webhook,
duplicate and out-of-order callbacks, five concurrent charges on one token, voids, deposit
holds and the no-show return job.

**That sentence was true of less than it sounded, until recently.** `e2e/support/global-setup.ts`
boots `packages/mock`, which has **no database** — so every suite importing `./support/api.js`
was driving in-memory fixtures. That was `money.test.ts`, `concurrency.test.ts` and
`permissions.test.ts`: 74 of the 485 specs, and precisely the three files named for the
guarantees that matter most. The mock's entire permission model is
`has(req, 'noperms') ? staff[1] : staff[0]` — it reads no permissions at all, so #7 was being
asserted against a scenario header. Suites using `e2e/support/tenancy-harness.ts` spawn the real
API against real Postgres, which is the other 411.

**What settles that it mattered:** with both concurrency guards removed, five simultaneous
charges all settled and every one reported `balanceAfterFils: 493000` — a lost update in its
purest form — while **all seven sequential specs in the `POST /charges` describe still passed**,
including *"consumes the token — the same QR cannot be charged twice"*. 485 green specs with no
way to see a lost update on the charge path.

Now: the charge races run against real Postgres, and `authority.test.ts` checks the nine
permissions against the real API. Breaking the race took two attempts because there are **two
independent guards** — the wallet's `FOR UPDATE` and the token's conditional consumption — and
each covers the other. Roughly 28 of the 74 turned out to be genuinely covered elsewhere
already; about 17 are legitimately mock-scoped and now say so in their headers, recording what
the mock lies about, because three lanes build against it and that is how the wallet's missing
auth hid for a whole build.

**#7 found no holes when checked properly.** Every gate was already there. What changed is that
we can now notice if one disappears.

**The no-show return job IS covered — this paragraph claimed the opposite for at least a
session, and two briefs repeated it.** `no_show_returned` appears **12 times** in
`e2e/deposit.test.ts` with **5 hard `expect(...).toBe('no_show_returned')`** assertions, driven
through the real `api/src/jobs/no-show-once.ts` runner, including the two-simultaneous-passes
race. So the third terminal state is reached and the deposit-return money path is exercised.

**How the false claim survived is the part worth keeping.** Lane D re-checked before building and
its *own first grep also found nothing* — because zsh ate `--include=*.ts`, so the pattern never
searched the files it named. The claim did not survive a correct grep. **A zero result is a claim
about your command as much as about the tree**, and this build has now been misled by a silent
glob, by a `LIKE` wildcard (`rst_` matching "fi**rst**"), and by a single-file grep against a
deliberately extracted module — three shapes of the same error in one session.

Four surfaces: **API** (auth, nine permissions gated both directions, tenancy, booking,
promotions, audit log), **wallet** (home, QR, top-up, Book, Account, full Arabic with RTL —
but see the auth caveat below), **scanner** (PIN, scan, charge, void, manual lookup, bookings,
schedule, and charge-after-manual-lookup driven on a simulator), **dashboard** (sign-in, and
all seven sections).

**The wallet's auth slice has since landed, and the two paragraphs that used to sit here were
stale — they said the opposite of the tree.** Re-verified 2026-08-19:
`apps/wallet/src/api/client.ts:180` sends `authorization: Bearer ${token}` when a token is
held, and `API_BASE_URL` now defaults to `http://localhost:4100` — the real API — with the mock
on 4000 available only by setting `EXPO_PUBLIC_AVO_API` explicitly, and the file's own header
records the switch. So "the wallet works" no longer needs reading as "against the mock".

**Non-negotiable #10 is met**, which the top of this file already said while this section
denied it. `POST /auth/member/signup` is registered (`api/src/routes/auth.ts:182`), and
`member.policy_version` is stored `NOT NULL` behind a `member_policy_version_positive` check
(`api/src/db/schema/member.ts:74`), with acceptance also recorded as an event
(`api/src/db/schema/legal.ts`) so a published version can never be mutated out from under a
member's stored consent.

**Worth noticing how this file failed:** it contradicted itself across two screens for at
least a session, and both halves read as confident. A status file is prose about code, and
prose does not recompile. Re-measure before quoting any line of this document.

Roughly 400 specs. `pnpm check` runs them; **test caching is off** because turbo was
replaying a green run in 14ms and calling it a pass.

## What does not work yet

- **No real money.** MyFatoorah is the confirmed PSP; the gateway driver is still `sandbox`.
- **Receipts do not send.** The worker, queue, retry and `(transaction_id, channel)` key all
  exist behind a logging driver. Real sending needs WhatsApp template approval and a
  transactional email domain — both the client's.
- **No charge from a real QR on a real phone.** The simulator has no camera; the scanner
  deep-links through the same function `onBarcodeScanned` calls. Ten minutes with a device.
- **Google Calendar** is behind a stub driver. `DECISIONS.md` lists the six things AVO must
  provide, starting with a Google Cloud project AVO owns.
- **81 Arabic strings have no source** in the bundle — re-counted from the array on 2026-08-25 by
  two independent methods; this line said 74 and DECISIONS.md said 31, both while claiming to have
  been counted directly. The array is test-guarded and was always right; only the prose rotted. Plus a
  separate derived-forms list and an `AR_UNVERIFIED` set for strings that render Arabic no
  designer has checked. `AVO States.dc.html` contains zero Arabic. `AR_GAPS` is the worksheet for
  the native-speaker review, and `i18n/digits.test.ts` asserts the list is **exactly** the set of
  keys still holding English, so a gap cannot be closed quietly by machine translation — removing
  an entry fails by name.
  **This said "31" until 2026-08-19 and was repeated into two lane briefs before Lane B checked
  it.** The number more than doubled as screens landed, and nothing recomputed it, because a
  hand-written count in prose has no test.
- **Owner console** is deferred; policies are seeded rather than administered.

---

## The three habits that actually caught things

1. **Verify by running it, and paste real output.** Every serious bug this build found came
   from driving the thing, not reading it — a void under-refunding 3.000 of 8.000, a
   dashboard showing one staff member the previous user's figures, a scanner reading another
   salon's customer.
2. **Lanes report, trunk routes.** A lane that finds a bug in another's code says so and
   stops. Every cross-lane fix came through that path.
3. **A single green run is not evidence.** It has been wrong three times — on a stale
   `dist`, on a warm database, and on a turbo cache replay. Run `pnpm check` twice, from the
   recipe in `RUNBOOK.md`.

## The trap that keeps reappearing

**A schema narrower than the wire is not a smaller contract, it is a lossy one.** Zod does
not fail to type an undeclared field — it *strips* it. Five drifts were found this way, each
by a lane hitting it, including one created while fixing another. `e2e/contract.test.ts` is
now the guard: it parses real responses and asserts nothing was dropped and nothing was
wrongly required. **Do not narrow a response to match a schema — widen the schema.**

---

## Open, and waiting on the client

Full list with reasoning in `DECISIONS.md`. The two that gate a launch:

1. **CBK position** — does AVO holding stored value need its own licence? MyFatoorah being
   licensed answers who moves the money, not who may hold it.
2. **Counsel and PSP sign-off on the legal set.** The seven documents are seeded and
   versioned, carrying `reviewNote: "Awaiting counsel + PSP sign-off"`. Seeding the text is
   not approval of it.

And one worth asking early, because it shapes the wallet terms: if MyFatoorah pays the salon
at top-up time, **the salon holds the cash while the customer holds an unspent balance.**
Coherent — it is how gift cards work — but it decides who owes her that money if a salon
leaves the platform.
