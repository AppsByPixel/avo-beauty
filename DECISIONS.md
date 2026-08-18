# Autonomous decision log

Aftab asked for a long unattended run: keep the lanes working, integrate, test, decide,
continue. This file is the accountability for that — every call I made without asking, with
the reasoning, so it can be reviewed or reversed in one pass rather than archaeology
through commit messages.

**Rules I am holding myself to while unattended:**

1. **`dev` never stays red.** If a merge breaks it, I fix it or revert it before moving on.
2. **Everything is committed with the reasoning in the message.** A decision you cannot
   find is a decision you cannot reverse.
3. **Client-owned questions get queued, not answered.** CBK licensing, PSP contracts,
   counsel sign-off, support staffing, anything about what AVO's business does. These go to
   "Queued for Aftab" below.
4. **No destructive operations.** No force-push over shared history, no dropping data, no
   deleting a lane's work. If two things conflict I keep both and flag it.
5. **Verify before reporting.** The same rule the lanes get. Clean-tree checks, real output.

---

## Queued for Aftab — needs a human, not me

| # | Question | Why it is not mine |
|---|---|---|
| 1 | CBK position: does AVO holding stored value need its own licence? | Regulatory. MyFatoorah being licensed answers who moves money, not who may hold it. |
| 2 | If MyFatoorah pays the salon at top-up time, the salon holds cash while the customer holds a balance. Intended? | Determines who owes the customer her balance, and what happens if a salon leaves. |
| 3 | Counsel + PSP sign-off on the legal set | Named in `go-live-checklist.md` as the remaining launch blocker. |
| 4 | Native-speaker Arabic review — 31 keys in `AR_GAPS` have no source in the bundle | A person, with a lead time. The list is the worksheet. |
| 5 | Who monitors the AVO support queue, in what hours | Operations, not code. |
| 6 | Data residency: Kuwait or EU | Leaning Kuwait. Schema stays provider-neutral until decided. |
| 7 | Sign-in now needs a Workspace field, which is not in `AVO Login.dc.html` | Forced by `staff_user` being unique on `(salon_id, handle)`. A visible departure from the drawn design. |

---

## Decisions I made

Newest first. Each: what, why, and how to reverse it.

### My fix for the third drift created the fourth, and hid it the same way

**What.** I set `AvailabilitySlotSchema.reason` to `.nullable()`. The server **omits** the
key on an available slot rather than sending null, so `reason` was required and **every
bookable slot failed `.parse()`** — the entire Book grid, unvalidatable by any client using
the contract.

**Why it looked fixed.** It hides on today's date, where every slot is already past and
therefore carries a reason. Lane A found it by asking for a future date. My verification
asked for today.

**And the same fix was narrow in the other direction:** with `reason` forced present, the
envelope parsed and stripped `artistId`, `timezone`, `slotMinutes`, `open` and `subtracted`.
`open: false` with an empty `slots` is how a client tells *"she does not work that day"*
from an error — deleted in transit.

**Four drifts now, all mine, all the same shape, none caught by a check.** The pattern is
worth naming: I keep fixing the instance and not the class. `.nullable()` versus `.optional()`
is a distinction I got wrong while writing a comment about how the last one had gone wrong.

Fixed properly: slot `reason` optional, envelope carrying all nine served fields, plus
`SubtractedBlockSchema` and `BookableArtistSchema`.

**The durable fix is routed to Lane D:** a guard that parses real API responses and asserts
no key was dropped and no required key was absent — both directions, because drifts 2 and 3
lost fields and drift 4 wrongly required one. And on a **future** date, since that single
choice is the difference between catching this one and shipping it.

### `ServiceSchema` — a slip worth recording because of how I made it

Splicing by string index between two anchors, I replaced everything between
`AvailabilitySlotSchema` and `ProductSchema` — and `ServiceSchema` was sitting between them.
The typecheck caught it immediately, so it cost a minute. Recorded because it is the third
time today a shell/index rewrite has damaged a file I was editing, after twice telling a
lane not to do exactly that. Use the editing tools.


### The contract was silently deleting the cancellation window

**What.** `BookingSchema` was missing five fields the API sends, one of them
`changeableUntil` — the entire one-hour rule, as an instant.

**Why it is worse than a missing type.** Zod does not merely *fail to type* an undeclared
field; `.parse()` **strips it**. So the API sent the deadline, the contract removed it, and
a client reading `booking.changeableUntil` got `undefined` with no way to know it had ever
existed. Lane B found it building the Book flow against the real API.

**A schema narrower than the wire is not a smaller contract, it is a lossy one.** That is
the opposite of what this package is for, and it is the second time the shape has appeared:
`ArtistSchema` was narrower than the wire too. `AvailabilitySlotSchema` was worse — it
declared `{time, available, reason?}` against an API sending
`{startsAt, endsAt, local, available, reason}` inside an envelope carrying `hoursSource`
and `fallbackReason`, so the fallback that tells a customer *which grid she is looking at*
never reached her.

Fixed: the five booking fields, a rewritten slot schema, a new `AvailabilityDaySchema` for
the envelope, and a `ServiceSchema` with the `nameAr` the Book flow needed.

**The check this wants, and does not have:** nothing verifies the contract is not narrower
than what the API serves. Every drift so far was found by a lane hitting it. A test that
parses a real response and asserts no key was dropped would have caught all three.

### Two "money moved, screen lied" defects, both found only by driving

Lane B, in the same slice:

- A reschedule refused inside the hour rendered the **cold-load** error — "We couldn't load
  your wallet" — instead of the one-hour sentence the server had just sent.
- **A failed `GET /bookings` rendered the empty card.** Caught with the API down mid-drive:
  the deposit had already left the balance, the activity feed said `Deposit held −5.000`,
  and the card underneath told the customer she had no appointment.

Neither is visible in code review and neither is a crash. Both are a screen confidently
stating the opposite of what the money says.


### Turbo was caching test runs, so "green twice in a row" was one run and a 14ms replay

**What.** `turbo.json`'s `test` task had no `"cache": false`. Turbo hashes source files; this
workspace's e2e suite also depends on a running Postgres, a booted API process and the wall
clock, none of which are in the hash. Measured on an unchanged tree:

```
run 1:  Cached: 0 cached, 22 total   Time: 2m26s
run 2:  Cached: 22 cached, 22 total  Time: 14ms  >>> FULL TURBO
```

**Why it is worse than it looks, and Lane D's insight rather than mine:** turbo does **not**
cache failures. So a flaky suite *looks* like it re-runs — every red run genuinely
executes — and **the first green one seals it**. Every "green" after that is a replay of one
lucky run's log, indefinitely.

I reported "274 passed, twice consecutively" a few messages before this as evidence of
stability. It was one real run and a fourteen-millisecond replay of its output.

**Fixed:** `"cache": false` on `test` only. Build and typecheck stay cached — those are
genuinely a function of the source they hash. Verified: three consecutive genuine runs, 323
passed each, 13 of 22 tasks cached (the typecheck and lint ones).

**To reverse:** delete the flag and get a test suite that reports success without running.

### My diagnosis of the flakiness was wrong in mechanism, right in class

I said vitest was running test files in parallel over a shared member. Lane D corrected all
three parts:

1. **`fileParallelism: false` had been set since the suite was written.** Files were never
   parallel.
2. **`money`, `concurrency` and `permissions` drive the in-memory mock**, not Postgres. They
   cannot touch that member at all.
3. The shared state was **one constant**: `PG_DB = process.env.POSTGRES_DB ?? 'avo_qa'`.
   Every worktree carries a copy of the harness, every copy resolves it to the same eleven
   characters, and they all `docker exec` into the same container. It was never lane D's own
   database against another *checkout* running the same suite.

It reproduced my exact numbers — two copies started twenty seconds apart failed **7 and 4**,
two of the four counts I had seen — and got 0 and 0 after the fix. It also found a leaked
API process, ppid 1, two and a half hours old, still polling `receipt_job`: the same bug
through time rather than across worktrees.

**The lesson I keep re-learning in new costume:** I had a plausible mechanism and stopped.
Lane D reproduced before fixing, which is why the fix works and mine would not have.


### Booking landed, and Lane A found a live money bug in a path we had already shipped

**`POST /voids` was under-refunding a deposit-funded charge.** It refunded
`abs(amountFils)` off the charge row — which is *net of the deposit already applied*. So the
design's own worked example (8.000 service, 5.000 deposit held, 3.000 charged) handed the
customer back **3.000 of the 8.000 she had paid**.

The fix reads the `deposit_held` debit off the ledger rather than recomputing it, so an
already-returned remainder cannot be refunded twice, and moves the booking to `cancelled`.

Worth noting how it was found: not by a test, but by building the path that makes deposits
reachable. `heldDepositFils` had been hardcoded to `0` since the scanner shipped, so the
void code had never once run against a real hold. **A branch that cannot execute cannot be
wrong, and cannot be tested either.**

Two more, same slice:
- `promo_bonus_fils` shipped as `integer` on two tables while both Drizzle schemas declared
  `filsColumn()`. Not an overflow risk at these amounts — the point is that one exception
  stops non-negotiable #1 being *checkable*. Verified: 0 non-bigint money columns.
- Idempotent replay was byte-identical **by luck**. `response_body` was `jsonb`, which
  re-serialises in its own key order; adding two fields to the void response broke Lane D's
  `replay.raw === first.raw`. Now `json`. Reordering fields would have broken it again,
  silently.

### Double-booking is an exclusion constraint, not a unique index

Lane A's call and it is right. A unique index on (artist, start) accepts a 45-minute
booking at 16:00 *and* a 30-minute one at 16:15 — different keys, overlapping chairs.
`EXCLUDE USING gist` over the real `tstzrange` refuses it in the database, where two
concurrent requests cannot both win.


### `pnpm check` is flaky, so every "green" I reported from it was partly luck

**What.** Four consecutive runs of the same tree gave 7, 4, 1 and 3 failures. Standalone,
the e2e suite passes. The failures are always the same shape:

```
expected 50000 to be 149000      a balance
expected 11 to be 10             visits, off by one
expected 20 to be 18             visits, off by two
```

**Cause.** Vitest runs test *files* in parallel, one worker each, and several suites drive
the **same seeded member**. `gateway`, `promotions`, `money` and `concurrency` all charge
and top up Dana at once, so each reads a balance another file just moved. It is the
shared-database problem that has bitten three times across lanes, now inside a single
command.

**Why it matters more than the fix.** I have been reporting `dev` green off this command
for two days. Those greens were real runs, but a run that gives four different answers is
not evidence. Combined with the two earlier misses — reporting green off a stale `dist`,
and off a warm database — this is the third time the same lesson has arrived: **a check I
have not proven deterministic is not a check.**

**Routed to Lane D, not fixed here.** It owns the harness and already built
`seedQaMember()` for exactly this — per-run fixtures rather than shared ones. The other
plausible fix, `fileParallelism: false`, trades the race for a much slower suite and hides
rather than removes the coupling.

**To reverse:** nothing to reverse. The finding is the point.


### I routed work to Lane D that it had already done

**What.** I told Lane D to add four promotion routes to `SALON_ROUTES`. It had already added
them — in `2cba7f8`, along with `'DELETE'` on `SalonRoute.method` and per-salon `{hid}`
substitution. Its answer: "Nothing to do."

**Why it happened.** I read the ledger from `dev` *before* merging Lane D's commit, saw the
routes missing, and routed a task off a stale tree. The same class of mistake as reporting
`dev` green off a warm database: I checked the wrong copy.

**The cheap fix I am adopting:** before routing anything to a lane, check that lane's
worktree, not `dev`. `git -C ~/dev/avo-<lane> log --oneline -3` costs nothing and would have
caught it.

### Two corrections from Lane D worth keeping

**`audit_log` is stronger than its own comment claims.** `services/memberSearch.ts` rests
the untrimmable-counter argument on "the application role cannot UPDATE or DELETE it".
There is also a trigger, so the **database owner** cannot delete either — Lane D found this
by trying to delete its own rows as `avo`. Both halves are now asserted because they fail
differently: `permission denied` as `avo_app`, `audit_log is append-only` as the owner. The
comment in that file understates the guarantee; Lane A's line to correct.

**`ensureDatabase()`'s `pg_dump` clone is obsolete.** It exists because `db:seed` could not
bootstrap an empty database. Lane A fixed that and `seed.test.ts` proves it, so Lane D's
database is now built by a path nothing else uses. Not urgent, but a workaround outliving
its bug is how a harness quietly stops resembling production.


### `db:generate` will produce a destructive migration for whoever runs it next

**What.** Drizzle's meta snapshots were never written for migrations 0004-0006, 0010 and
0011 — they were hand-authored. So `drizzle-kit generate` diffs the schema against the 0009
snapshot and re-emits DDL that already exists. Lane A ran it, got a migration re-creating
`boost` and `happy_hour`, discarded it, and hand-wrote 0012 instead.

**Why this is on the list rather than fixed.** It is a live trap with no owner: the next
person to run a normal, documented command gets a migration that drops and re-creates tables
holding money. Lane A correctly treated it as outside its slice and reported it.

**The options, none of which I am taking unilaterally:** regenerate the missing snapshots so
the tool tells the truth; or delete `db:generate` from `package.json` and make hand-authored
migrations the documented path. The second is honest about what this repo actually does —
every migration since 0004 was hand-written — but it gives up drift detection.

**Queued rather than decided** because it changes how every future migration is authored,
and that is a workflow choice rather than a technical one. Whoever picks it up should note
that three of the last four migrations were hand-written *by preference*, not by accident.

### The branch guess: no boost when the branch is not established

**Lane A's call, and I am keeping it.** Rather than refusing a charge when the branch is
ambiguous, apply no boost and record `transaction.branch_assumed`.

Its reasoning is better than the alternative: refusing would take every multi-branch salon
offline until device enrolment ships, to fix an attribution defect whose money impact is
already nil. The money was safe; what was wrong is that **a guess looked like knowledge**.

It also found a correction inside the bug: a *single*-branch salon is now `established`, so
its boost pays. Previously it never did — there was no sort order to be at the mercy of, and
no boost either.

**To reverse:** the real fix is still a branch-bound scanner session, blocked on device
enrolment. `services/branch.ts` documents the fix that must NOT be taken — a client-supplied
branch — beside the parameter that will one day carry the server-established one.


### Lane D answered on the ledger edits, and its reasoning beats mine

I asked twice whether editing its tenancy ledger at trunk was the right call. Its answer:

> "The edit itself was correct; the general policy should change, and you've already found
> the reason. The auto-discovery assertion is the tenancy proof; the hand-written table adds
> a stricter body shape, an existence-oracle comparison, and *a control call that really
> performs the write*. Read routes need no fixture, so those five were safe. That's not a
> property of the ledger — it's a property of those five routes, and there was no way to see
> it from outside."

That is the distinction I could not draw. I had justified the first edit by saying tenancy
was already proven, which was true and beside the point: what made it safe was that all five
were *reads*. Writes need a fixture and a control that performs the write, which is exactly
where my second attempt turned one failure into four.

**Policy from here: trunk routes to the lane and accepts a short red.** Lane D endorsed
keeping the escalation rule — if the auto-discovery assertion also fails, revert the merge
rather than edit — because that one is about a real property, not about who owns a file.

It also found its own tripwire was under-counting: the discovery list held the original
eight while nine routes had landed, so **it could have lost every write route and still
passed.** Now seventeen.

**To reverse:** nothing. This replaces the earlier entry's conclusion, which was right by
luck.


### I edited a lane's file twice. The first worked by luck; the second I reverted.

**What happened.** Twice, a merge turned `dev` red on Lane D's tenancy gap ledger, and twice
I edited `e2e/tenancy.test.ts` at trunk rather than waiting. The first time (Lane A's five
read routes) it worked. The second time (four promotion write routes) **one failure became
four** — the new *control* assertions need a happy hour seeded on salon B, and I do not know
that harness's fixtures. I reverted.

**The lesson, which I got backwards.** I justified the first edit on the grounds that the
ledger's auto-discovery sibling had already proven tenancy, so only a list was stale. That
reasoning was sound and the outcome was still luck: those five routes happened to need no
fixture. Nothing in my reasoning distinguished the case that worked from the case that did
not, which means it was not really reasoning.

A rule that only holds when the data is simple is not a rule. **Trunk does not edit a lane's
column to keep `dev` green — it routes to the lane and accepts a short red.** A red `dev`
that someone is actively fixing is honest; a green one built on a guess about another
suite's fixtures is not.

**Current state:** `dev` carries one failing spec — the ledger listing four routes it does
not yet cover. Tenancy is independently proven (the auto-discovery sibling passes on all
four); only the hand-written half is stale. Lane D has the routes and is landing them.

**To reverse:** nothing to reverse. The revert is the decision.


### Branch boosts are stored and served but applied by nobody — HELD, not fixed

**What Lane A found by running it.** The first live charge under the new promotion set
**doubled a customer's visits**, because `defaultBranchId()` sorts `BR-KWC` before `BR-SAL`
and Kuwait City carries a 2x visit boost. A sort order decided a loyalty multiplier.

**Why it is not fixed yet, and must not be fixed the easy way.** The obvious patch is to let
the client send its branch on `POST /charges`. That is wrong: **a client naming its branch is
a client choosing its own multiplier**, which is non-negotiable #2 with extra steps — the
same shape as a wallet minting its own token.

The correct fix is a branch-bound scanner session. `StaffPrincipal` currently carries branch
*access* — which branches this person may work at — not branch *location*, which is where
this device is standing. Those are different facts and only the second one can price a
charge.

**Held because** it needs a decision about device enrolment that overlaps Lane B's finding
that there is no device provisioning endpoint at all (it resolved PIN sign-in as one-time
enrolment, adequate for a pilot on salon-owned hardware, explicitly not for release). Both
want answering together, and the answer shapes the scanner's sign-in.

**Meanwhile the exposure is real but bounded:** boosts are seeded for Kuwait City only, and
the pilot salon is a single branch. It is wrong in the data, not yet wrong in front of a
customer.

**To reverse the hold:** add `branchId` to the charge body. Do not. Read the paragraph above
first.


### `turbo.json` — `dev` now depends on `^build`. Third instance of one bug.

**What.** `dev` was the last task with no `dependsOn`. Lane B found `dev` needed a manual
`pnpm --filter @avo/types build` before the API would boot, because `topup.ts` imports
`TopUpIntentPublicSchema` and the built `dist` did not have it yet.

**Why it matters more than the one-line fix.** This is the *third* time the same shape has
bitten: `@avo/e2e` needed `@avo/types` built but declared no dependency; `lint` had no
`dependsOn` while every lint script is `tsc --noEmit`; now `dev`. Each time it was invisible
locally, because a warm tree already has the artifact.

I audited every task rather than patching the one that hurt. All five now carry `^build`.
Verified by wiping every `dist` and booting the API cold with no manual build.

**To reverse:** remove the `dependsOn`. You get back a dev server that boots from a stale
artifact and fails only for whoever checks out clean — which is CI, and eventually a new
machine.

### The native declaration was mine, and it was wrong twice

**What.** `packages/tokens` now emits one `NativeTextStyle` interface plus a `TextToken`
union, rather than nine literal object types.

**Why.** Lane B found it by deleting its hand-copied declaration and typechecking against
the real one. Each token having its own shape makes `theme.text[token]` a union of nine, so
`lineHeight`, `letterSpacing` and `textTransform` are unreadable from a `text(token)`
helper — **which both mobile apps have.** The wallet still typechecks only because its
ambient `declare module` shadows the package; it will hit this the moment it deletes its
copy.

Also widened `textTransform` from `string` to the literal `'uppercase'`, so React Native's
own prop type accepts it without the consumer narrowing.

**Twice wrong, worth recording.** The first version derived the declaration by re-parsing
the emitted JavaScript with string splits — types as a function of a string. The second
emitted per-token literals and pushed a workaround into every consumer, which is the same
class of problem as the missing declaration it was meant to fix. A generator that makes
every consumer write the same adapter has not finished its job.

**To reverse:** revert `emitNativeTypes`. Both apps go back to hand-copied declarations,
and the drift returns silently.


### Five tokens added, and the native theme now ships its own types

**What.** `color.neutralDot` (#8A867E), `color.skeleton` (#EDEAE3), and a `dark` group —
`surface` #131511, `accent` #A7BBA0, `focusRing` #A9BBA6. And `packages/tokens` now emits
`dist/native.d.ts` with a `types` export condition.

**Why.** Both mobile lanes reported the same thing independently: `@avo/tokens/native` was
untyped, so each app hand-copied a declaration file. **A generated artifact that forces a
hand-written companion is not generated** — it is the exact drift the generator exists to
prevent, arriving through the back door.

The five hexes are all in the design with nothing to name them. `neutralDot` had to be flat
rather than a composite: the wallet derived it from `textMuted` over `surfaceAlt2`, which is
correct there, but the scanner's ground is dark and a composite cannot serve both. That was
foreseen — the wallet's own comment said a flat token would be needed "if this dot ever has
to sit on a different ground."

`dark` is a group, not a theme. The scanner frame and owner-console sidebar are dark **by
design**; dark mode is explicitly out of scope (`README.md` § Known gaps 3). `dark.focusRing`
is mandatory there because `interaction-spec.md` §2 says #5A6B58 does not carry against
#1C1B19.

**One thing I got wrong first.** I generated the declaration by re-parsing the emitted
JavaScript with string splits. It broke, and it deserved to — that makes the types a
function of a string rather than of the data. The theme object is now built once and
serialised twice, as JS and as a declaration, so the two cannot drift. I had just told Lane
A not to do in-place shell rewrites for exactly this class of reason.

**To reverse:** delete the tokens and the `emitNativeTypes` call. Both apps go back to
hand-copied declarations that fall behind silently.


### Salon timezone — decided, IANA zone id, default `Asia/Kuwait`

**What.** `Salon.timezone` added to the contract, defaulting to `Asia/Kuwait`. Lane A owes
the column and the resolution logic.

**Why I decided this rather than queuing it.** Lane A escalated it three times and it now
touches three surfaces. The *business* question — will AVO sign a salon outside Kuwait —
is the client's. The *technical* choice does not depend on the answer: storing an IANA zone
id is correct either way, costs nothing today, and gets expensive once there is production
data. Deciding it does not pre-empt Aftab; leaving it undecided would have.

Without it, `businessHours`, artist `windows` and happy-hour `from`/`to` resolve against
whatever zone the API process booted with — UTC in docker-compose. That silently offers
every booking slot three hours out, and for happy hours applies the wrong earning
multiplier, which is a money bug rather than a display one.

An IANA id and not a stored offset, because "10:00 local" is two different instants across
the year in any DST zone. Kuwait has none, which is exactly why this is free to get right
now.

**To reverse:** drop the field and pin the API process to `TZ=Asia/Kuwait`. That works until
the first salon outside Kuwait, and fails silently rather than loudly when it stops working.

### Lane D's tenancy ledger updated at trunk, inside lane D's column

**What.** Added lane A's five new `/salons/:id/*` routes to `SALON_ROUTES` in
`e2e/tenancy.test.ts`, and widened `SalonRoute.method` to include `PUT` — lane A registered
the first salon-scoped PUT.

**Why, given it is lane D's file.** The merge turned `dev` red and rule 1 is that `dev`
never stays red. This is a list of known routes, and the moment the trunk merges new ones is
the moment it should update.

**Why it was safe.** The ledger's sibling assertion — which auto-discovers routes rather
than reading the list — **already passed against all five**. Tenancy was independently
proven before I touched anything; only the hand-maintained half was stale. Had that
assertion also failed, I would have reverted the merge instead.

Flagged to lane D on its next dispatch.


### `feeFils` on `POST /topups` — decided, deliberately not yet implemented

**What.** `POST /topups` still returns `feeFils`. It is as customer-facing as
`GET /topups/{id}` — the wallet calls it to create the intent — so the customer-never rule
applies there too and it should serialise through `TopUpIntentPublicSchema`.

**Why it is not done yet.** Lane D's two suites contradict each other on this exact
response: `integration.test.ts` wants the fee gone, while five specs in `money.test.ts`
assert `expect(intent.feeFils).toBe(150)`. Removing it from the mock right now turns `dev`
red, and rule 1 of this run is that `dev` never stays red.

**Sequencing.** Lane D moves the commission assertions off the customer response and onto
the persisted `fee_fils` — the pattern it already used for `receipt_job`, proving behaviour
against the table rather than through a response a customer sees. Lane A applies the public
shape to `POST /topups` in the same cycle. Both land together or neither does.

**To reverse:** keep `feeFils` on both responses and delete `TopUpIntentPublicSchema`. You
would be choosing to show AVO's commission to customers, against the contract, the product
owner's own words, and every AVO app in production.

### Scanner given to Lane B rather than a new lane

**What.** `apps/scanner/` is Lane B's column alongside `apps/wallet/`.

**Why.** ADR-0001 puts both in one Expo codebase sharing tokens and types. A separate lane
would have two agents in one dependency graph competing over shared components.

**To reverse:** split them once a shared mobile component package exists — that is the point
at which two lanes stop colliding.


### Telling her a top-up cancelled her deletion — HELD, and not faked

**What.** A top-up on a member with a pending deletion request now cancels that request, in
the same transaction as the credit (lane A, `c8d65e1`). She is **not** proactively told. The
audit row carries `customerNoticeOwed: true`, following the `oldNumberNoticeOwed` precedent.

**Why not.** There is no customer notification sender: WhatsApp templates are unapproved and
the transactional domain is undecided, both client-owned. Lane A reported the gap rather than
inventing a channel, which is right — a confirmation the app cannot back is worse than none,
the same reasoning that kept `requestAccountDeletion` from faking a success for two commits.

**Why not the top-up outcome screen either, which is the obvious alternative.**
`TopUpIntentPublicSchema` is `TopUpIntentSchema.omit({ feeFils: true })`, so a field added to
the base appears on the **merchant** view as well — and whether a salon should learn that a
customer's account-deletion request was cancelled is a privacy question, not a plumbing one.
Landing it costs a trunk schema change plus a four-way rebase, and it buys a screen she may
not be looking at.

**Why the severity is low enough to hold.** She can already discover the state from
`GET /members/me/deletion`, which lane A built for exactly this reason. And the act that
triggered the cancellation was her own top-up — funding a wallet is not the behaviour of
someone who believes her account is being erased. The states that would be dangerous are the
reverse: a deletion silently *not* cancelled over a funded wallet, which is the bug that was
fixed, or a UI implying erasure is underway when `erasureScheduled` is false.

**To reverse:** when the notification outbox exists, send it there — that is the right channel
regardless, and it makes the schema question moot. If it must go on the outcome screen first,
add the field to the **public** shape only and decide the merchant-visibility question
explicitly rather than inheriting it from `.omit()`.

### One turbo cache hit in trunk is unexplained — bounded, and not worked around

**What.** A post-merge `pnpm turbo run typecheck` in trunk reported `FULL TURBO`, 11 of 11
cached, in 29ms — on a merge (`bebcbba`) that changed eleven `apps/dashboard` files including
two new ones. Forced, the same tree took 8.16s with 0 cached and was green, so `dev` was sound.

**What has been eliminated, in order.**

1. **The key is not under-covering.** No `inputs` override anywhere, no remote cache, no
   `TURBO_*` env, so every task uses the default input set — and that set is exact:
   `@avo/dashboard` 48, `@avo/ui` 19, `@avo/wallet` 84, `@avo/api` 120, each matching
   `git ls-files` on the package. Both new files are inside the dashboard's 48.
2. **The key is responsive.** Appending one comment line to a dashboard file moves
   `@avo/dashboard#typecheck` from `c2527732…` to `f937cbcf…`.
3. **Per-task caching surviving a failed invocation.** True in general and demonstrated here —
   `pnpm build` died at exit 137 on `@avo/dashboard#build` and still left its dependency
   builds cached, so the next filtered build reported `2 cached`. But it does not explain this
   instance: the invocation that died was **`pnpm build`** (`turbo run build`, four tasks, all
   builds). `pnpm check` — `turbo run typecheck lint test` — was never invoked in trunk at
   all, and the first explicit `turbo run typecheck` there reported `2 cached / 11`, nine cold,
   consistent with the near-empty cache left by `rm -rf .turbo`.

**Why the eliminations matter more than the anomaly.** Had the key been under-covering,
`build` would share the defect — and `build` is what `seed.ts` imports `@avo/types` from, what
the contract-drift guard parses against, and what hid a missing dependency edge for a whole
session. A key that could no-op on changed source would mean every downstream check reading
yesterday's contract. It cannot. That is the direction that could have hurt, and it is closed.

**What was NOT adopted.** A standing "always `--force`" rule. It costs 8s on every merge, and
treating a working cache as broken is how the next genuine anomaly gets waved through as
normal. `LANES.md` carries the rule that fits instead: tree changed, trust the cold run; same
tree needing independent confirmation, `--force`, because a replay is not a second opinion;
suspect the cache, `--dry=json`, which answers in seconds and leaves nothing behind.

**To reverse:** if it recurs, capture the full `turbo run typecheck` output *and* a
`--dry=json` from the same tree before doing anything else — the hash plus cache status per
task is the artifact that would settle it, and `.turbo/runs` does not exist so there is no
summary to recover afterwards. Cache-entry mtimes cannot separate "written cold" from
"rewritten by `--force`", so they are not evidence.
