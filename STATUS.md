# Where this is, right now

Written as a handoff. If you are a fresh session picking this up, read this first, then
`CLAUDE.md`, then `RUNBOOK.md`. Everything else is detail.

**Day 3 of a 30-day pilot build.** `dev` is the trunk; `main` tracks it when green.

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

**Every brief must name the lane's own database and browser context.** Three shared-resource
collisions have happened — a lane using the shared `avo_ci` after its `DROP DATABASE` was
sandbox-blocked, and a lane injecting a `fetch` shim into another lane's browser tab. Trunk
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

**The no-show return job has never been executed by a spec.** `api/src/jobs/no-show-once.ts`
exists and its own docstring says it was built *for* evidence — *"a claim about a background loop
that can only be exercised by waiting for a timer is a claim nobody checks. This makes it two
commands and a diff."* Nothing runs it: `no_show_returned` appears in **zero** assertions, so the
suite reaches `deposit_held` and `completed` and never the third terminal state. It is a money
path that returns held deposits to customers, with a purpose-built runner created to make it
testable, unused — the same shape as the concurrency gap, and the reason it is listed here rather
than under *What works*.

Four surfaces: **API** (auth, nine permissions gated both directions, tenancy, booking,
promotions, audit log), **wallet** (home, QR, top-up, Book, Account, full Arabic with RTL —
but see the auth caveat below), **scanner** (PIN, scan, charge, void, manual lookup, bookings,
schedule, and charge-after-manual-lookup driven on a simulator), **dashboard** (sign-in, and
all seven sections).

**The wallet has no auth slice, and that qualifies the line above.** `apps/wallet/src/api/client.ts`
sends no `authorization` header at all — no `Bearer`, no token — and its base URL defaults to
`http://localhost:4000`, the mock, which requires none. Every real `/members/me*` route is
behind `requireMember`, which has no dev bypass. So the wallet's screens are built and its
states are real, but **it has only ever run against the mock**; the scanner, by contrast, is
wired to real sessions. This was item 1 in lane B's own brief and was never built. It is not a
regression and nothing hid it — `AccountScreen.tsx:62` says so in its own comment — but "the
wallet works" should be read as "against the mock" until the auth slice lands.

Consequently **non-negotiable #10 is unmet**: nothing stores the accepted `policyVersion`
against the member, because there is no signup endpoint to store it at. `api/src/routes/auth.ts`
registers `/auth/member/session`, `/auth/web/session`, `/auth/refresh`, `/auth/sign-out` and
`/auth/staff/password-reset` — sign-in exists, registration does not. Sign-in and policy
rendering are buildable today; consent needs the API side first.

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
- **31 Arabic strings have no source** in the bundle — `AVO States.dc.html` contains zero
  Arabic. Tracked in `AR_GAPS`; that list is the worksheet for the native-speaker review.
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
