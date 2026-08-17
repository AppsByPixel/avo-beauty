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

