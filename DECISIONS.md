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

