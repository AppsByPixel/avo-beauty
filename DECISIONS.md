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
| 4 | Native-speaker Arabic review — **81** keys in `AR_GAPS` have no source in the bundle | A person, with a lead time. The list is the worksheet. **The count was recorded here as 31 and in the verification handoff as 74; both were stale. Measured 2026-08-25: 81, by two independent methods.** It prices and schedules a paid review, so it is worth re-measuring rather than restating. |
| 5 | Who monitors the AVO support queue, in what hours | Operations, not code. |
| 6 | Data residency: Kuwait or EU | Leaning Kuwait. Schema stays provider-neutral until decided. |
| 7 | Sign-in now needs a Workspace field, which is not in `AVO Login.dc.html` | Forced by `staff_user` being unique on `(salon_id, handle)`. A visible departure from the drawn design. |
| 8 | **RESOLVED — and this row was stale for weeks while the answer sat further down the same file.** The guard exists: `services/charge.ts` `NEAR_DUPLICATE_WINDOW_SECONDS = 120`, keyed on `basketHashFor(serviceIds)`, refusing a second charge for the same member and the same basket inside two minutes and naming the prior charge and its age. The explicit confirm is `confirmDuplicate: true`, and the idempotency key deliberately EXCLUDES that flag so the confirmed retry is the same attempt rather than a new one. The decision is recorded in this file under **§ "Five calls made without asking", item 3**, which even says *"Queue item 8"* — so the log and the queue have contradicted each other since it landed. | Found on 2026-08-27 the hard way: a demo-seeding script hit the refusal 77 times, and I read the message and assumed the queue row was right and the guard was new. It was the other way round. **The lesson is about the register, not the guard** — a queue row that stays open after its answer is recorded is worse than no row, because it gets counted, published and presented as an open question. This one was in the artifact handed to a manager. Whatever process closes a decision has to close its queue row in the same commit, and item 3 naming "Queue item 8" in prose was not enough. |
| 15 | **The onboarding wizard promises a 14-day trial and nothing implements one.** `AVO Owner Console.dc.html:307`: *"Creating the salon … opens a 14-day trial before the first invoice."* There is **no trial, subscription or invoice column in any schema file**, and neither `api-contract.md` nor `packages/types` names one — Billing is fully designed with no API behind it. So an AVO admin onboarding a salon is told a clock started, and none did. | Unlike the invite gap, this is not a missing implementation of a known thing — **a trial needs commercial terms before it can be built**: does it start at creation or at first charge, what happens on day 15, is it enforced or only billing metadata? Those are AVO's to set. Until then the drawn copy stands and the success state deliberately does not repeat it. |
| 16 | **AUTHORISED 2026-08-25 — no longer queued.** **Rate limiting on top-ups and charges/scans — what threshold?** The go-live row names four surfaces; auth and support tickets are limited, top-ups and charges are not, and there is no global limiter to fall back on (`api/src/app.ts` has none, `api/package.json` has no plugin). Lane A's recommended shape is sound: key on `(salonId, deviceId)` — the pair `pin_attempt` already indexes — never `req.ip`, since a salon is one NAT and `req.ip` is off by default until `TRUST_PROXY` names the proxy; refuse with a distinct code so the scanner can say "too many attempts, wait a moment" rather than show an authority error to staff standing in front of a customer. | The shape is engineering; **the threshold is not**. A busy salon's real charge rate is a measurement nobody has, and the false-positive cost is a refused sale at the counter. Picking a number unmeasured is how the lookup ceiling came to fire at twelve customers an hour (queue item 8's lesson). Needs either a measurement window in the pilot or a call from AVO on what a counter should tolerate. |
| 17 | **AUTHORISED 2026-08-25 — no longer queued.** **`PATCH /v1/salons/{id}/social/{linkId}` is in the contract and does not exist.** Named at `api-contract.md:61` (with body `{ handle?, on? }`) and `:647`. Social links *are* editable, but as a whole-array field through `PATCH /salons/:id` — a different endpoint, a different granularity, and a different permission (`requireDashboardPerm(req,'loyalty')`, `salons.ts:591`) than the contract specifies. Two managers editing different links overwrite each other, which is the exact argument `salons.ts:1122` makes for why the product catalog is per-row PATCH rather than bulk PUT. | Contract-versus-implementation. Either the contract is amended to describe the array field that exists, or the per-link endpoint is built to match what was specified. That is a spec decision, not a lane call — and the design bundle is frozen, so amending it is Aftab's. |
| 18 | **AUTHORISED 2026-08-25 — no longer queued.** **The contract never says how anyone signs in.** 8 of 11 `auth.ts` endpoints are absent from `api-contract.md` — member/web/platform session, refresh, sign-out, both staff and platform password resets, and member signup. `grep -ci "auth/refresh" design/api-contract.md` returns 0. The contract specifies permissions in fine detail and is silent on the session layer that produces a principal for them. | 57 of 124 endpoints are undocumented, but most carry an in-file "reported as a contract addition" note and are known-and-owed. The auth family looks like a genuine oversight rather than a deferral, and it is the layer every permission in the document depends on. Worth a ruling on whether the contract is meant to cover it before it is treated as settled. |
| 19 | **AUTHORISED 2026-08-25 — no longer queued.** **The enlarged-QR overlay is designed, written in both languages, and absent — and the control that should open it does something else.** `PaymentCode.tsx:93` sets `accessibilityHint={copy.tapEnlarge}` and the screen reads "Refreshes in 37s · Tap to enlarge", but `onPress` is bound to `walletToken.refresh`. Driven by Lane B: tapping moved the countdown 36s → 45s and rendered no overlay. The design specifies it at `AVO Wallet Home.dc.html:641-643`, the copy already exists in EN and AR (`qrBig`/`qrBigSub`/`done`), `interaction-spec.md §3` assigns it `avozoom`, and `README.md` names it as live behaviour four times. | Not in `design/README.md` § Known gaps and no decision attached, so it is not a documented omission — but building a missing screen element is product work, not verification. The sharp edge is that it is not merely absent: **a customer holding her code up to a cashier and tapping to enlarge silently gets a different code.** Needs a ruling on whether to build the overlay or change the affordance; leaving both is the one option that misleads. |
| 20 | **AUTHORISED 2026-08-25 — no longer queued.** **Happy hour never reaches the wallet.** `GET /v1/salons/{id}/promotions` returns `happy[]` (HH-01, HH-02) and the wallet fetches it, but `promotions.happy` is read nowhere and `isHappyHourLive`/`minutesRemaining` are never imported by the wallet. The design renders live and next banners with countdowns at `AVO Wallet Home.dc.html:1136-1151`. | Data, rules and design all exist; only the surface is missing. Not in Known gaps and no decision attached. Flagged rather than built, per the standing rule against inventing product — but it should be an explicit "not for the pilot" or a scheduled slice, because right now it is neither. |
| 21 | **The social-link endpoint is gated `perms.loyalty`, and that name is wrong.** `PATCH /v1/salons/{id}/social/{linkId}` now exists (DECISIONS #17, built). It edits a salon's Instagram/TikTok handles — settings, not loyalty. `perms.marketing` was considered and correctly rejected: that gates platform-approved customer messaging under caps and quiet hours (non-negotiable #8), and a Settings-form handle shares none of that. The honest permission is **`perms.settings`**, which does not exist. | Adding it is a **four-way break** — `PERMISSION_NAMES`, `PERM_COLUMN`, the `staff_user` columns and a migration, the Accounts → Team authority chips, and the generated permission census. Lane A escalated rather than inventing a tenth permission, which was right. The gate is not *wrong* today in the sense of letting the wrong person in — `loyalty` is held by the same managers — it is wrong in the sense that the name misdescribes the authority, and that is how a permission ends up granting more than anyone intended two features later. Needs a call on whether to take the four-way break now, before more endpoints attach to `loyalty` for want of anywhere better. |
| 22 | **Both mobile apps declare the same iOS URL scheme, `avo://`.** `apps/wallet/app.json` and `apps/scanner/app.json` both set `"scheme": "avo"` (bundle ids differ: `beauty.avo.wallet`, `beauty.avo.scanner`). Driven on a device with both installed, iOS resolved `avo://pay?m=…&t=…` — the **payment** deep link, which belongs to the scanner — to **AVO Wallet**. Uninstalling the wallet made it resolve to the scanner correctly, which is how the QR charge path was finally verified. | Mostly benign in the pilot, because the customer's phone has the wallet and the counter phone has the scanner. It bites in three real cases and one of them is already scheduled: **(a)** a staff member who is also a customer of her own salon — likely — has both, and her scanner's deep-link path is hijacked; **(b)** the white-label pipeline (go-live: "one `--brand` token produces a per-salon app") would put N salon wallets on one phone all claiming `avo`; **(c)** queue item 13's password-reset link is planned as `avo://reset?token=…`, which the scanner would be equally entitled to open. Needs a call on who owns `avo://` and what the other app uses — `avo-staff://` is the obvious candidate but it is a product/branding decision, and changing a scheme after release breaks any link already in the wild. |
| 23 | **The booking modules default OFF, so the pilot's default customer app is a loyalty card.** `salon.module_booking` and `module_shop` are both `.default(false)`. A salon that does not switch them on ships a customer app that is a wallet, a QR and a top-up button. Driven on device: the booking flow is the most sophisticated thing in the build — real Google-Calendar availability, the Kuwaiti afternoon closure, live-vs-salon-hours badges, deposit-not-price with automatic no-show return — and it is opt-in. | Not a defect: the modules are deliberately optional and the product description says the platform "never disrupts how a salon already operates". But it means the thing most likely to win customers is the thing least likely to be on at launch. Worth a call on whether onboarding should default booking ON for salons that have artists, or at least prompt for it — that is a commercial decision about what AVO is selling, not an engineering one. |
| 24 | **The booking flow asks for the artist before the time, and most customers arrive with the opposite question.** `AVO-Beauty-Product-Description-v2.md` §2.1 mandates service → artist → day → slot, and it is built exactly so. Driven: choosing a calendar-connected artist returned "Fully booked" for the whole day, and the only recovery is to go back and pick a different artist — repeat until something opens. | The spec is explicit, the design is frozen, and artist-first is right for a customer with a preferred stylist. But "when can I get in?" is the more common question, and the current order cannot answer it without brute force. An "any artist / next available" entry point would answer both. Needs a product ruling before anyone builds it — it changes a drawn flow. |
| 25 | **The customer is a guest in one salon's app, never a user of AVO.** `salonId` is required at sign-in; wallet, tier and stamps are salon-scoped; the go-live checklist plans one white-label build per salon. Three salons means three apps, three balances, three logins. | This is the architecture working as designed, not a gap — but three consequences are undiscussed. **(a) No discovery:** a customer cannot find a salon in the app, so AVO supplies no demand and acquisition stays entirely the salon's problem, which weakens the pitch to salons over time. **(b) Stranded value:** a customer who stops visiting a salon leaves money there with no route out, since refunds are wallet-credit-only (non-negotiable #5) — a support burden and a sharper version of queue item 1's CBK question. **(c) No cross-salon identity**, so nothing compounds across the network. Whether AVO is a white-label toolkit or a consumer network is the single largest product question in the build, and everything above follows from it. |
| 26 | **RESOLVED 2026-08-26 — the comment is gone.** Lane C deleted it, verifying each blocking claim false before removing it (`PrincipalKind` includes `platform_admin`, `SessionScope` includes `platform`, `POST /auth/platform/session` exists, every route on its "what is missing" list is registered), and KEPT the two parts still true: `packages/types` genuinely has no `PlatformAdmin` entity, and the build-after-the-API sequencing rule. Trunk re-verified both. **What is still open is the general form, and it got worse:** this was the FIFTH instance; a sixth was caught the same day in `auth.ts` ("NOT UNDER `AVO_TEST_PRINCIPALS`", true when written, false the moment the exemption went), and a seventh in `apps/wallet/vitest.config.ts` ("deliberately does not reach for a renderer", which had become "cannot"). **An eighth was found by demoing on 2026-08-27:** `apps/scanner/src/screens/HomeScreen.tsx` claimed `My bookings` and `My schedule` were "drawn and deliberately inert", pointing at a `comingSoon` note that no longer existed — both tiles were fully wired to real screens reading real endpoints. | **STOP COUNTING — 2026-09-09. This row said "eight", line 858 of this same file says "nine", and trunk quoted the wrong one into a lane brief, calling the closure-preview comment "the ninth instance" and "the first with a working workaround" when this row already records two earlier ones with workarounds. So it was neither.** The running total is not maintained and cannot be: instances are found sideways, by someone changing something nearby, at a rate of one or two a slice — since this row was written the register has added the parkOutbox docblock, `CLAUDE.md`'s lint claim (76), the wallet's "one language only" note that was hiding a live Arabic bug, a `salonName` note claiming no renderer existed, a `branch.ts` rule that was **never** true, and both halves of the closure-preview block. **A number in this row is the same defect the row is about**, which is funny once and expensive after that. What matters is unchanged and is the part to keep: the dominant shape is a CONSUMER-LANE comment asserting a gap the API lane had already closed, and the expensive variant leaves a working WORKAROUND behind it — lane C rates the worst wording as *"the fix is theirs and this column cannot make it"*, because that is a standing instruction to the next reader not to look. It is a missing gate step — and lane B's analysis of the eighth narrowed it into something actually buildable. **Seven of the eight were the same specific shape: a CONSUMER-LANE comment asserting a gap that the API lane had already closed.** Two of those also left a working WORKAROUND in place behind the comment, which is the expensive half — the comment was only the visible symptom. So the high-yield check is not a general comment audit, it is grep-able and narrow: **does any comment under `apps/` or `packages/` claim an endpoint is missing, unbuilt or not yet available — checked against the routes actually registered in `api/src/routes/`?** That is the same technique `consoleNavGates.test.ts` already uses to derive a section gate from the server, so the pattern is proven in this codebase. Trunk to scope; not a lane's to build. |
| 27 | **RESOLVED 2026-08-26 — the reaper exists, and it is deliberately OFF by default.** `api/src/services/topupReaper.ts`, 168-hour window, `TOPUP_REAPER_ENABLED` defaults to `'0'` (`env.ts:254`) — the opposite of its two siblings, because `NO_SHOW_WORKER_ENABLED` defaulting on is what made `deposit.test.ts` flaky for weeks. It asks the processor before writing `expired` and the processor's answer can veto: a `succeeded` intent is never reaped and never credited, only reported by id. | The row is resolved; three consequences of it are not, and they are 29, 30 and 31. **31 is the one to read**: because `services/erasure.ts` defers any member whose top-up sits in `LIVE_INTENT_STATUSES`, a single abandoned payment page parked her erasure PERMANENTLY before this existed — against a published 30-day deletion promise. That is the argument for turning the reaper ON in production rather than leaving it default-off, and it needs a decision. |
| 28 | **The customer's `Transaction` shape cannot express what she actually paid for a boosted top-up.** `amountFils` is the credit (bonus already inside), `bonusFils` is the **tier** portion only, and `promoBonusFils` is not serialised to the customer at all. Lane B's receipt derives `paid = amountFils − bonusFils`, which is exact today and wrong the moment a branch top-up boost applies — the row would read high. | `packages/types` is trunk-owned and consumed by all four surfaces, so widening it is a four-way rebase, not a lane fix. Two candidate shapes: serialise `promoBonusFils` to the customer, or add an explicit `paidFils` so no client has to reconstruct it by subtraction. The second is the safer one on this project's own evidence — every time a client has recomputed a money figure the API already knew, it has eventually disagreed with it (this session alone: the activity row that added the tier bonus twice and showed +12.000 for an 11.000 credit). |
| 29 | **Should a background job credit a wallet from a gateway read the customer never asked for?** The reaper (#27) now consults the processor before writing `expired`, and when the processor says **succeeded** it refuses to reap and reports the id as `awaitingCredit`. It deliberately does **not** credit. Lane A notes the crediting call would have been one line and declined to write it. | The refusal is right and the reasoning is worth keeping: crediting because a timer noticed is a different act from crediting because she asked, and the blast radius is asymmetric to everything else in that file — the sandbox gateway's `succeeded` default alone would have turned the reaper into an unattended credit machine. But the money **is** owed: a customer paid and the credit never landed. Somebody has to close that loop, and it belongs to the reconciliation slice the go-live checklist already calls for ("a daily job matches gateway settlements to `Transaction` rows"). Needs a ruling on whether that job credits automatically, or raises for a human. |
| 30 | **The payment-gateway seam cannot say "I have never heard of this reference".** `SandboxGateway.fetchPayment` raises `GatewayUnavailableError` both for a reference it never issued and for being down. The reaper cannot tell them apart, so it takes the conservative arm and vetoes the reap — which means the **safest possible reap** (an intent with a reference no processor recognises) is the one it will never perform. | A fifth `PaymentGateway` method separating "unknown reference" from "unreachable" fixes it, and the daily reconciliation job wants the same distinction for the same reason. Small interface change, but it is the gateway contract and touches `myfatoorah.ts` as well as the sandbox — worth doing once, deliberately, rather than twice under pressure. |
| 96 | **`perms.shop` opens ten routes; nine contain no customer at all, and the two the order board adds carry a name, a phone, block/street/building and coordinates. This register already drew the rule against exactly this, for a different screen.** The reports row states it — *"customer PII must not ride on the weakest gate a screen happens to sit behind"* — and admits in the same breath that **none of the nine merchant permissions is a customer-data permission**, so `customers → team` was an interim fit rather than a solution. Item 7 is that gap a second time, with a **home address** as the payload. | **Latent, not live:** the seeded front desk holds `shop: false` and gets 403 on both routes, verified in the database and in the browser with no customer data anywhere in the DOM. But the shape is wrong for the reason already written down: a permission whose other nine routes are catalogue, images and units-sold is not a permission anyone grants *thinking about addresses*. **Moving the gate is the API's call, so lane C did the half it owns** — the Team chip that grants `shop` now names what it opens, in the `title` **and** the accessible name, because a hover-only privacy disclosure is the wrong half of the audience. **This wants a decision.** Two smaller findings from the same slice: the board shows `TX-3233428` while the customer's receipt reads `AVO-SH-3233428` — digits match, prefixes do not, so a merchant matching a phone call to a row has to know they are the same order. And a **design-copy conflict half-corrected**: `design:299`'s "no delivery (phase 2), buyers pick up at the salon" had its false clause replaced and its true one kept, but the module description at `design:1044` — which `PRIOR-ART.md` explicitly says to keep — now describes the module as pickup-only in three places. **Corrected, not recorded as a defect:** lane C flagged the dashboard's total absence of RTL rules as breaking non-negotiable #12. It does not. `design/README.md` § Known gaps 1 decides that Arabic is customer-app only and the merchant dashboard, owner console and scanner ship English-only. The absence is the decision, and lane C's `dir="ltr"` pin on the phone and coordinate pair is right for a separate reason — a leading `+` in an RTL run prints as `965 9912 4408+`. **And trunk's correction was itself incomplete, which lane C caught:** "the dashboard ships English-only" is true of the **chrome** and false of the **data it authors**. `app.css` already invokes #12 correctly at `.support input[lang='ar']`, because that rule governs *editable Arabic content* — and the dashboard authors and renders plenty of it (`nameAr`, `stampRewardAr`, the Arabic topic labels). So the flat correction would have licensed the cheaper opposite error: someone reading "English-only" and stripping the Arabic face off an Arabic name field. **Worth noting how it surfaced:** lane C had written its original wrong finding into a code comment, so the already-merged commit was carrying a fresh instance of this register's own subject, and fixing it properly meant citing Known gaps 1 at the point the rule gets invoked — the only durable fix for a rule whose scope lives in a different file. |
| 95 | **Item 6 is complete, and the harm it removed was concrete rather than cosmetic: the old branch resolution would have filed a Salmiya appointment at Kuwait City — a branch carrying a 2x visit boost nobody chose.** Lane B's SQL proof reads the pair: `Rana Al-Sabah, artist BR-SAL, tx BR-SAL, branch_assumed = f` beside `Hessa M., artist NULL, tx BR-KWC, branch_assumed = t`. `BR-KWC` sorts first, so the pre-item-6 `ORDER BY id LIMIT 1` did not merely *mark* a booking as guessed — it guessed **wrong**, toward the branch with the better multiplier, by alphabetical accident. | **Three things worth keeping.** (1) **Unassigned artists get a third chip, as a peer of the branches.** Hiding them would have relocated migration 0044's rejected NULL-means-unbookable mistake into the client and broken booking at most salons today; showing them under every branch is a lie that costs money-adjacent trust, because she believes she chose Salmiya while the row records `branch_assumed = true` and nothing on screen said otherwise. It reads *"Other artists"*, never "unassigned", which is staff vocabulary. (2) **Three suppressions under one rule** — *a filter must be able to keep its promise to narrow the roster* — and the single-branch case was verified the interesting way, with one open branch holding two assigned artists and two unassigned, where a rule keyed on "are any artists assigned?" would have shown a picker. (3) **A correction to trunk's brief:** trunk stated that a nonsense `?branch=` value is refused. `invalid_branch_filter` fires only on **charset-invalid** input; a well-formed but non-existent id returns an **empty list**, deliberately, because "not hers" and "hers with no artists" must be the same answer. Trunk's sentence was true of malformed input and wrong about unknown ids. **Owed, not blocking:** seven new strings whose Arabic was *written* rather than transcribed, since the design bundle draws no branch step — `branchFilterOther` most of all — and they want a native read. **Pre-existing and deliberately not fixed:** horizontal scrollers in the wallet do not mirror chip order in RTL, and the day strip behaves identically, so fixing only the new strip would make the two disagree. A trunk call, not a lane's. |
| 94 | **`wallet_token_consumed_after_issue` compares a Postgres-written `issued_at` against a Node-written `consumed_at`, so it is clock-skew-sensitive by construction and will fire again under load.** Seen during item 10's verification: two `deposit.test.ts` money specs failed on that CHECK, and the failing row showed `consumed_at` **53ms before** `issued_at` — a consumption recorded as happening before the issue it consumed. Lane A demonstrated the mechanism and confirmed its own diff touched the token path in zero lines of code (four mentions, all comments). | **Not caused by the voucher slice and not a flake in the ordinary sense** — a flake is a test that sometimes fails; this is a constraint that is *sometimes false* because its two operands come from two clocks. Under load the two drift and the row is rejected after the work is done. **The fix is a direction rather than a patch:** either both instants come from the database, or both from the application, or the CHECK compares things that cannot disagree. Not attempted here, deliberately — it is a money-path constraint on the token that gates a charge, so changing which clock writes it is its own slice with its own proof. **The reason this entry exists at all is a second-order lesson worth more than the finding.** Lane A's first two attempts to attribute the failure were **contaminated by itself**: it ran `deposit.test.ts` while its own `pnpm check` was running the same e2e suite against the same Postgres container, with one run still spawning workers 27 minutes after it had timed out. That inflated the gate from ~12 to **30m32s** and produced additional failures which it then read as evidence for the regression it was investigating. It caught this, killed the stale processes, re-ran clean (35/35), and reported the contamination rather than the first answer. Same family as decision 85 — a container under contention produces failures that look like defects — except here the contending process belonged to the investigator. |
| 93 | **A response sent before its commit is a class, not an incident — and multi-run does not detect it, which trunk had assumed it did.** Lane A's item 6 introduced one: `PUT /artists/:id/branch` called `reply.send()` inside its `db.transaction()`, so the response dispatched before drizzle's `COMMIT` and a client that wrote then immediately re-read could see the old value. Int runs 1 and 2 green, run 3 red. Trunk asked lane D whether the class was detectable and explicitly offered *"multi-run already covers this and a new guard would be theatre"* as an acceptable answer. | **It is not, and the numbers are the answer.** Measured with a control rather than inferred: 40 write-then-immediately-reread attempts through a warm second connection saw the pre-commit value **4 times on the broken route and 0 of 40 on the fixed one**. At ~10% per attempt, three single-shot runs is 1 − 0.9³ ≈ **27%** — so "int run 3 caught it" was a lottery this project won, not a detector. **And the scan found a live second instance on its first run:** `routes/artists.ts:1029`, `DELETE /artists/:id/calendar`, still sending inside its transaction **twelve lines below the paragraph lane A wrote explaining why that is wrong** after fixing the sibling. The fix was understood and not generalised, which is the whole case for a guard over a lesson. Lane A's to fix; the pin goes red asking for its own line to be deleted when they do. **Lane D measured what defeats its own scan** — five spellings, three walk past, with the fixtures *run* in the spec rather than described so the limits fail red if a pattern change makes them false. The named live risk is `images.ts`, which already defines two functions taking `reply` and whose `performDetach` does its detach and audit as two statements, so wrapping it is a likely correct change — in the file whose curried factory already defeated the permission census once. It chose a pinned ledger over `knownBug()` because `knownBug` reports "still broken" as a **pass**, so a third instance would be swallowed. **A second lesson of the same species arrived in the same slice:** `deposit.test.ts`'s race receipt checked overlap by **wall clock**, which read 100% on every run *including* the one where the loser reported `candidates: 0` — a figure true whether or not the race happens is not evidence, and its "12 consecutive green runs" was exactly the claim the three int runs had been. |
| 92 | **`PUT /artists/:id/branch` is gated `perms.team` on the argument that an artist's branch "pays no multiplier" — which is precise, and will silently stop being true.** Lane D confirmed the gate three ways: `requireDashboardPerm(req, 'team')` checks the surface and exactly one bit rather than also requiring `dashboard`, so the two are genuinely disjoint; the behavioural mirror revokes all nine permissions and grants **only** `perms.team`, so the contrast is asserted rather than described; and `charge.ts:496` takes its branch from `ctx.principal.enrolledBranchId` and never reads `artist.branchId` or the booking's branch, with boosts applied in exactly two places (the device branch, and `null` for top-ups). `booking.ts` imports no promotions at all. | **The caveat is the entry.** "Pays no multiplier" is true; *"does not touch money"* would be false. `booking.ts:462` resolves the booking's branch from `a.branchId`, and that lands on the `deposit_hold` transaction's `branchId` and `branch_assumed` — so a `perms.team` holder can move which branch a future deposit is **reported** against. A reporting bucket, not a rate, and `perms.team` is still the right gate for that. **What makes this worth recording rather than a footnote: lane A's own comment anticipates the day it changes** — "once branch-scoped promotions touch bookings" — and **nothing fails when that day arrives.** The gate would quietly become a money-configuration permission held by roster administrators, with no test, census or ledger noticing, because every existing assertion is about *which* permission the route requires and none is about *what that permission may cost*. This is the same shape as decisions 82 and 88 (a value stored and served and never applied) inverted: an authority correctly scoped for today's blast radius, with no guard on the blast radius growing. |
| 91 | **Closing a branch leaves any till enrolled to it as a dead counter that answers `404 unknown_branch` on every charge, and nothing warns anybody.** `routes/devices.ts` refuses to *enrol* into a closed branch, on its own stated reasoning that doing so would be "a working configuration screen producing a broken counter". **The closure path has no matching guard:** the enrolment row survives, `resolvePrincipal` still reads it, and `resolveBranch` requires `closed_at IS NULL` on a supplied branch and throws. Driven by lane C: enrol → close the branch → charge from that till → **404**. | **Two guards, one invariant, and only one end of it was defended** — the enrol side reasoned correctly about exactly this outcome and the closure side never learned. `api/` is lane A's column so the server-side guard is routed there; lane C shipped the client-side half it could own, adding the affected tills to the branch-closure confirmation beside the stranded staff and held deposits. **It also found the wrong detector before using it:** `branchName` is not it, because the list's LEFT JOIN carries no `closed_at` clause and a closed branch returns its name intact — the detector is absence from the open-only `salon.branches`. **And a second defect of its own, worth recording for how it was found:** the Move panel initialised its target to the till's own branch while the picker offers open branches only, so on a *closed* branch React held an id the `<select>` could not display, the unchanged-comparison returned equal, and **Move was disabled on the one row telling the merchant to re-point it** — the single repair the panel exists for, unreachable, with typecheck green throughout. Found by driving the broken state in a browser, not by reading. **Separately noted, not a defect but a new operational fact:** `resolvePrincipal` reads `device_enrolment` on **every authenticated request**, so that table is now on the hot path for all auth — revoking `SELECT` on it 500s the entire API rather than only the device routes. |
| 90 | **`'either'` — the only dual-surface gate in the API — is asserted by nothing, and narrowing it would break the scanner's device enrolment with the entire suite green.** `routes/devices.ts` gates on `requirePerm(req, 'either', 'dashboard')`. But `GatedRoute['surface']` has no member for `'either'`, so `surfaceOf` silently collapses it to `'dashboard'` and `tokenFor` hands every generated probe a **web** session. The census ledger line is byte-identical whether the guard says `'either'` or `'dashboard'`. **Measured by mutation:** changing that one word turns lane D's 6 new specs red and leaves **all 429 pre-existing specs green** — the pin, both generated sweeps, tenancy and contract. The caller that would break is the scanner's "Set up this device" flow, which `devices.ts` names as its *primary* one. | **Found because a line was written by hand instead of generated, and that is the whole argument about ledger toil settled by evidence rather than preference.** Trunk asked lane D whether the four-slices-running cost of hand-editing route ledgers could be automated. Its answer: `contract.test.ts` is a judgement, `tenancy.test.ts` is fixture design, and only `PINNED_COVERAGE` is near-paste — so the framing "the fix is a hand-edited list" was true of one ledger in three and was hiding real work. Then the decisive part: **lane A claimed the census had derived `→ dashboard` independently, trunk relayed that claim, and it was false** — the census reads the last quoted argument of the guard, which is the same token a human reads, so ledger-agrees-with-source is a tautology. Had the line been regenerated it would have landed with a green tick and the claim would have entered the record unchallenged. Writing it by hand made someone ask what the line *meant*, which found the permission half confirmed more strongly than claimed and the surface half confirmed by nothing at all. **One hand-edit bought a coverage gap that four ledgers, three censuses and 429 specs could not see.** Covered now by hand-written scanner-surface pairs plus a self-expiry spec that goes red the hour `surfaceOf` learns the third value and instructs its own deletion. **The derivation fix belongs in `e2e/support/perm-census.ts`, which another session holds uncommitted — routed, not taken.** Lane D's offered alternative, not built: a read-only "new routes since last merge" reader with no pinning power, which removes correlation work rather than deliberation, and must never be allowed to write to a ledger. |
| 89 | **`tsconfig.json` excludes `src/**/*.test.ts` from typecheck entirely, so no spec in `api/` is type-checked and nothing said so.** Found by lane A when `routes/support.test.ts`'s `MERCHANT` fixture turned out to be typed `StaffPrincipal` and to have been **missing `deviceId` since that field was added** — a fixture silently drifted from the type it claims, and lane A's own change would have extended the lie to two fields. | **A cousin of decision 76 and arguably worse.** 76 is `pnpm check` reporting a lint pass it never ran; this is `pnpm check` reporting a typecheck that does not cover the files most likely to lie. A test fixture is a *claim about a shape* — it is exactly the artefact whose drift a compiler should catch, and it is the one place the compiler was told not to look. It is also the mechanism behind decision 78: a fixture with the right shape and stale data is invisible to a typecheck, and here the shape was not even checked. **Not fixed, deliberately** — including specs in the typecheck will surface an unknown number of existing drifts across every package at once, which is a slice with a measurement in front of it rather than a flag flip. Recorded so the next person to trust a green typecheck knows what it did not read. |
| 88 | **`salon.whatsappEnabled` is stored, merchant-editable, served to every client, and never consulted when a receipt is queued.** `services/receipts.ts:46` pushes a `whatsapp` job **unconditionally** for every transaction; the flag appears in `MERCHANT_EDITABLE` (`routes/salons.ts:138`), in the salon payload (`:449`) and in `SalonSchema` (`entities.ts:189`), and nowhere in the receipt path. **SAL-LUMIERE ships `whatsappEnabled: false` in the seed and still has WhatsApp receipts queued for every charge.** Latent only because `RECEIPT_DRIVER=logging` sends nothing — the day a real driver lands, that salon starts sending messages it opted out of. | **The identical shape as decision 82** — a per-salon setting stored, served to both clients, and applied by neither — found the same way, by scoping a feature request that happened to point at it. Aftab's item 11 ("invoice through email or WhatsApp, option set by merchant") is the feature; this is the defect underneath it, and fixing the feature without the flag would leave two competing sources of truth for the same question. **The constraint that shapes the feature, and it is not obvious:** `design/README.md` § Known gaps 7 states receipts are *"a record-keeping obligation, not marketing — send them regardless of the marketing consent flag"*. So a merchant's channel choice must not be able to produce **no receipt at all**. That is a real risk here rather than a theoretical one, because the email channel already has a customer-side precondition: `receipts.ts` queues email only when `email && emailVerified`, argued at length — an unverified address is one the customer typed and might be someone else's, and a receipt names what she bought, what it cost and her balance. So "email only" for a customer with no verified address is silence. Whatever the merchant chooses has to intersect with what is *possible* for that customer, and the failure mode must be a fallback rather than a gap. |
| 87 | **Compensation was already built and Aftab could not use it — and his answer moves the feature rather than the permission.** `POST /members/{id}/adjustments` is a complete money path: idempotency key claimed inside the effect's transaction, one atomic write across member/transaction/ledger/audit, a **required `reason`**, and the design's own example is *"Wallet adjusted · +5.000 KD to Noura S. · service complaint"* — compensation is its designed purpose. But it is gated `requirePlatform(req, 'accounts')`, so **only AVO can do it; a salon cannot compensate its own customer at all.** Asked whether he wanted merchant access, approval-gated access, or codes, Aftab chose: **"voucher or coupon by avo"**. | So the authority stays with AVO — consistent with loyalty (79) and campaign release (#8) — and what is new is the *voucher object*: a code a customer redeems, rather than a credit an admin pushes. **The critical design question is what redemption DOES**, and there are two answers with very different risk. **(a) Credit the wallet** — reuses the adjustment path wholesale, keeps the feature off `POST /charges` entirely, and matches non-negotiable #5's semantics for goodwill. **(b) Discount a charge** — puts new money arithmetic inside the most sensitive transaction in the product. Recommending (a) strongly. **And an escalation that is genuinely the client's:** a member's wallet is scoped to a salon (`member.salon_id`), so an AVO-issued voucher redeemed by that member credits *that salon's* wallet, and the salon then owes goods it did not agree to fund. **Who reimburses the salon is a commercial question nobody has answered**, and it belongs on `CLAUDE.md`'s escalate-don't-guess list beside CBK and residency. **Buildable without the answer; not launchable without it — and lane A found it has a SCHEMA consequence.** The voucher credit is correctly *not* revenue: `kind: 'adjustment'`, and `transaction_revenue` restricts to `charge`/`shop`. `walletAdjustedPosting` already argues why — *"a goodwill credit is not a service delivered, and booking it as revenue would inflate the salon's earnings report by every apology it ever makes"*. **But when she SPENDS it, that charge IS revenue and lands in the merchant's gross, with nothing distinguishing AVO-funded money from money she paid in.** Her takings rise by AVO's goodwill on the card she reads as earnings, and the only record of who funded it sits on a different transaction. **The ledger cannot express the link:** `merchant_bonus_funding` exists for merchant-funded bonuses; there is **no AVO-funded-credit account**, so a voucher posts to `gateway_clearing`, indistinguishable from any console adjustment. A reimbursement job would have to join spend back to funding source and no column carries it — so the commercial answer needs a new account or a new column, and settling it after shipping means backfilling money. **A landmine written down before it could be forgotten:** `adjustment` is *also* the void mechanism and `NOT_VOIDED` keys on `reverses_transaction_id`, not on kind. A voucher must never populate that column — if it did, it would **silently delete a charge from the merchant's gross**, caught by the reconciliation spec only when charge and voucher fell in the same window. **And of Lean's three coupon fields only `couponText` survives this ruling:** trunk named `minimumAmountIsCart` dead; lane A added that `optionType`/`optionList` is dead for the same reason, since restricting a voucher to named products presupposes a basket a credit does not have. |
| 86 | **The wallet's tier fine print told customers the salon can change its tiers, which decision 79 made false — Aftab's ruling: name AVO as the party that sets them.** `design/AVO Wallet Home.dc.html:1173` reads *"Bonus credit and tier rewards are funded by Amara Salon, not AVO. **The salon can change its tiers at any time**; your existing balance is never affected."* Since 79, a merchant gets `403 loyalty_read_only` and the `PATCH /salons/{id}` side door is closed too, so the salon cannot change them at all. | **Found by reading the design copy for item 9 rather than by anything failing** — the section that would have shipped this sentence is not even built yet, so nothing could have caught it. **Only the authority clause changes; the funding clause stays true and stays.** The salon does fund the rewards — that is the whole point of the sentence, and it is what protects AVO from being read as the guarantor of a salon's promise. So the shape is: funded by the salon, **set by AVO**, existing balance never affected. **Arabic is a subject substitution in an already-written sentence, not a new string** — `:1280` has the same three clauses, and only the subject of the middle one moves from `الصالون` to AVO. Flagged into the open native-speaker review of the Arabic set rather than treated as invented copy, because the construction (`يمكن لـ` + subject) is unchanged. **The general rule this earns:** `CLAUDE.md` says keep product copy verbatim, and it is right — so a copy string that a *code* decision has falsified is a decision, not an edit. The design bundle cannot know what we changed after it was drawn, which means every reversal recorded here (79, 84, and the item-7 pickup question) should be checked against the copy it silently invalidates. Nobody has done that sweep. |
| 85 | **The e2e gate went from ~9 to ~14 minutes, and the cause is neither the tests nor the test count — it is `docker exec` spawn latency under machine contention.** Lane D measured it during a run that hit **load average 437** on an 18 GB machine: `docker exec psql` went from **53ms to 2.4s, 45x**, one spec took **823 seconds**, and failures read as *"psql failed against container avo-postgres"* rather than as anything about the assertion. Concurrent at the time: three lane suites on the shared container, a demo stack trunk had been asked to run, and a booted iOS simulator with ~185 CoreSimulator processes behind it. Measured again on a calm machine: load 4.5, `docker exec` 64ms, gate 886s. | **The mechanism is the finding, not the load.** Every e2e database read is its own `docker exec`, hundreds per run, so **process-spawn latency is what saturates first** — which is why the symptom is a database that looks broken rather than a machine that looks busy. `e2e/support/tenancy-harness.ts` already names the fix: use a client library instead of shelling out. That would make the suite largely indifferent to the contention that currently triples it. **Trunk's share of the blame is worth writing down:** the demo stack and its simulator were running because Aftab asked for them, and the cost was invisible until a lane measured it — LANES.md already records "an abandoned iOS simulator that starved three lanes", and this is the same event with an owner. The rule that follows is not "do not run the demo" but **"a full-gate timing is only evidence when the machine is quiet, and a gate failure naming the container is a load symptom until proven otherwise."** |
| 84 | **Commission becomes invisible to merchants — a reversal of `api-contract.md`'s "merchant-visible, customer-never", and it happens to close a defect that was already recorded.** Aftab, 2026-08-29: *"Hide commissions from the settings (Merchants will not see anything related to commissions)."* | **The server side is already clean, which is the pleasant surprise.** `feeFils` is deliberately withheld from every merchant-facing response, and three separate files say so in their own words — `routes/activity.ts:167` ("`feeFils` is NOT here"), `routes/members.ts:980`, `routes/topups.ts:36`. No report exposes a fee column either; checked. So there is no second door of the kind that nearly shipped in decision 79. **The only merchant-visible commission is `Settings.tsx`'s `CommissionPanel`, and it was already wrong.** Its own comment records the premise expiring: it renders `DEFAULT_COMMISSION` from `@avo/types` — the compiled launch default — while the live rate is a `platform_settings` row the owner console edits, proven divergent on a real payment (a 20.000 KD card top-up recorded fee 550 at the compiled default and 650 after a PATCH). So the panel has been showing merchants a number that goes stale the first time AVO moves a stepper. Removing it resolves that rather than requiring the `api/` fix that comment asks for. **The distinction that matters: deleting the panel is the courtesy, and getting `DEFAULT_COMMISSION` out of the shipped bundle is the control** — rates sitting in dashboard JS are readable in devtools whatever the UI shows. `Settings.tsx` is the constant's only client consumer, so removing the panel should tree-shake it out; that must be verified against the built bundle rather than assumed, and it is the actual acceptance test for "will not see anything related to commissions". |
| 83 | **`best-selling-services` scored a no-show booking NEGATIVE, and its comment claimed the opposite.** A `no_show_returned` booking *has* a `settled_transaction_id` — `booking_settlement_matches_status` permits NULL only for `deposit_held` — and it points at the `deposit_return`, whose `amount_fils` is **positive**. So `sum(-amount_fils)` subtracted it. Measured live: **−6.000 KD** for a single 6.000 no-show, which is enough to drive a popular service's revenue below zero on the merchant's own card. The aggregate's comment asserted it "falls out naturally as zero because nothing settled". It did not. | **Found while fixing 81, by someone who had to understand that query rather than read its comment** — the fourth defect this week found in code being changed for a different reason. Now zero, and zero *because the view has no row for a `deposit_return` at all*, rather than because a caller remembered to exclude one. Also checked and cleared in the same pass: `metrics.ts` and `platformMetrics.ts` sum `amount_fils` only for top-ups, which have no deposit half to lose, and their `kind='charge'` query counts visits rather than money — so there was no third defective aggregate. **Two coverage gaps are the reason both defects survived, and both are lane D's column:** the plain `db:seed` fixture contains **no booked appointment at all**, so 81 changed nothing on it (8.000 → 8.000), and `e2e/reports.test.ts` writes no `ledger_entry` rows — its fixture has a `deposit_hold` and a `deposit_return` but has **never had an applied deposit on a charge**. A money report can be 34.6% wrong and every test stays green. |
| 82 | **The moment a salon adds a second branch, every per-branch earning rule silently stops being applied.** Verified chain: `branch.ts:128` returns `established: rows.length === 1`; `charge.ts` passes `branch.established ? branchId : null` into `loadPromotionInputs`; a `null` branch resolves no boost and no happy hour. So a one-branch salon's boosts pay, and **a two-branch salon's boosts are stored, served to both clients, and applied by neither** — the charge handler's own comment says exactly that. Every row they could have touched carries `branch_assumed = true`. This is also why item 3's staff report and the Overview branch filter both carry assumption caveats: they are downstream of the same gap. | **RESOLVED 2026-09-09 in `45a60a1`, and the proof is one line: an enrolled till at a two-branch salon charged with `branch_assumed = false` and `visits +2`. That had never happened in this product.** **Adding a branch was therefore not a configuration task, it was a regression** — a merchant who opens a second location loses the earning rates she is still being shown and still editing, with nothing telling her. That reframes what Aftab asked for: the request was "how to set up branch-specific stuff for a new branch", and the answer is that the per-branch machinery exists end to end EXCEPT for the one link that establishes where a charge happened. **The fix is named in the code and half-built.** `POST /charges` deliberately has no branch in its body — a client naming its own branch is a client choosing its own multiplier, non-negotiable #2 with extra steps — and `StaffPrincipal` carries branch ACCESS rather than a current location. `services/branch.ts` already accepts a `supplied` branch from "an enrolled, branch-bound device" and returns `established: true` for it. **What is missing is the enrolment: `session.device_id` is a nullable string the client sends, and there is no server-side device→branch record anywhere.** So item 4 is: a device enrolment that binds a scanner to a branch (lane A), the scanner's "Set up this device" flow choosing it (lane B), and the dashboard managing it (lane C) — in that order, because the others consume the contract. A default boost row for a new branch was considered and rejected as a separate matter: a default earning rate is a commercial commitment, and writing one because the shape was inconvenient is decision 80's mistake again. |
| 81 | **`sales` and `best-selling-services` have understated every booked appointment by its applied deposit for their whole life, and the column is labelled `gross`.** `charge.ts:488` writes `amountFils: fils(-due)` where `due = gross − heldDeposit`; `reports.ts` sums `sum(-t.amount_fils)` and calls it `gross`. It is net. Measured by lane A on its seeded window: **45.500 KD reported against a true 59.500 — 14.000 KD, 23.5%, missing.** Verified independently by trunk before the merge. A 6.000 KD service against a 5.000 KD deposit reports as **1.000**; an appointment the deposit covers outright reports as **0.000**. | **Found only because somebody needed the same number for a different reason.** Lane A was adding an artist-performance report and summing `-amount_fils` was the obvious implementation — it is what both existing kinds do. It drove a real booking and charge, saw `amount_fils = -1000` for a 6.000 KD manicure, and stopped. Had it copied the pattern, the new report would have credited an artist 1.000 KD for a 6.000 KD service and zero for any appointment a deposit covered — the false zero in the one column that decides a bonus. **The correct definition already existed in the codebase and nobody had connected it:** `routes/charges.ts:436` computes a void's refund as `|amount_fils| + the same deposit_held leg`, because what must be given back and what was earned are one quantity. **RESOLVED 2026-08-29 in `1f559ca`, and the fix found a SECOND defect this row did not know about — see 83.** Aftab asked for it fixed. The single definition is now a view, `transaction_revenue`, with four consumers and the expression in none of them. Measured on a driven window: **26.000 KD true against 17.000 reported — 34.6% missing**, worse than the 23.5% this row recorded. Originally deferred because: correcting `sales` is a small join but it changes numbers on a card lane C has already built and a merchant may have already read, so it wants its own decision and its own announcement. Lane A also proposed a `transaction.deposit_applied_fils` column, which would make the applied deposit a stored fact rather than a ledger read and let `sales` be corrected in one line — not taken. |
| 80 | **A legacy two-rung tier ladder is now unrepairable from every surface in the product.** `parseTiers` refuses anything but four rungs; **SAL-LUMIERE runs two** — verified live, `jsonb_array_length(tiers) = 2`. Before decision 79 the merchant could in principle republish her own ladder; now she cannot publish at all, and the console can only replace it by authoring two rungs that **do not exist**, which is inventing someone's commercial terms. Lane C refused to seed them from `DEFAULT_LOYALTY`, correctly — a server default is not a commercial decision. | **Found as a side effect of withdrawing the merchant editor, and it is the second defect this slice surfaced in code that was being deleted rather than written.** The first: the old merchant screen mapped `TIER_LADDER` unconditionally, so SAL-LUMIERE's merchant was shown two rungs her salon does not have at "0+ visits · +0%" — a wrong number on a live screen that nobody was looking for, which fell out of rebuilding the render. **Needs either a designed console affordance for a short ladder or a data fix, and it is a real decision because the four-rung rule is itself a product choice nobody has revisited.** Also recorded: `SalonEditor` carried the sentence "its own dashboard republishes it from Loyalty", which decision 79 made false — deleted rather than left. And a fifth site of the stale `PERMISSION_COPY.loyalty` string was found (`Loyalty.tsx`'s own 403 GET path) beyond the four lane A listed; it is wrong there in a NEW way, describing a write that no longer exists for anyone at that salon, and was reported rather than reworded because it is verbatim design copy. |
| 79 | **Loyalty authority moves from the merchant to AVO — a DELIBERATE REVERSAL of a closed design decision, not a gap being filled.** Aftab, 2026-08-29: *"Owner console will control the loyalty part not the merchant (it will be read only for merchant)."* `design/README.md` § Known gaps lists **"merchant-editable tier rules"** among the decisions *closed in a previous revision*, and `api/src/routes/loyalty.ts` implements exactly that: `GET` and `PUT /salons/:id/loyalty`, both on `perms.loyalty`, with the merchant's Loyalty screen owning the Publish button. | **Recorded as a reversal so nobody later reads the closed note and un-does this.** That is not hypothetical here — this register has now logged fourteen-plus cases of a confident sentence outliving the system it described, and `design/README.md`'s closed list is exactly the kind of sentence a future reader trusts. The build reason is sound: a tier ladder is a commercial commitment AVO underwrites, not a per-salon preference, and the same argument already puts campaign release on the platform side (non-negotiable #8 — a merchant asks, AVO decides). **Two things this must not break.** The publish is atomic across every loyalty column in one UPDATE because `salon_loyalty_config_complete` would otherwise be briefly violated when the mode changes, and Postgres checks a CHECK per statement — so "briefly illegal" means "the statement fails". And the audit row: a merchant who finds her tier rules changed needs to see WHO changed them, and the existing path assumes a staff principal, so a platform actor may not be representable in that row at all. Flagged to lane A as the part most likely to be quietly wrong. Also open: whether `perms.loyalty` still means anything once it can no longer publish. |
| 78 | **Landing a shared-type widening, I fixed the typecheck and did not RUN the affected packages — so `apps/wallet/src/api/shop.test.ts` sat red on `dev` and I did not know.** Widening `ProductSchema`/`ServiceSchema` with `image` broke four places. I found three by typechecking (`packages/mock` fixtures, `cart.test.ts`, `shopRender.test.tsx`), fixed them, saw `turbo run typecheck --force` report 11/11, and treated that as the combination verified. It was not: `shop.test.ts`'s fixture had the right SHAPE and stale DATA, which a typecheck cannot see. Lane B picked up the slice, found four failures already on `dev`, and had to recapture the fixture from the real wire before it could establish a baseline. | **Decision 77 said \"typecheck the COMBINATION before believing either lane's green\". That was the right instinct and the wrong verb.** A type error is the *easy* half of a shared-type landing — the compiler finds it for you. The half that hides is a value that still satisfies the type: a fixture, a recorded response, a hand-written mirror of a wire shape. **The rule is now RUN the combination, not typecheck it** — every package the widened type reaches, tests included, before the landing commit is believed. Cheap to apply: this cost one `vitest run` per affected package and would have taken minutes. Also note the shape of the discovery — a lane picking up the NEXT slice found it, which is the second time this week a defect surfaced only because somebody used the thing rather than read it. Same row also records that lane B found `shop.ts`'s header AND row 46 of this file both asserting \"ProductSchema declares four fields\", true until this widening made it five. It fixed the one in its column and reported the one in mine, which is the only reason the register corrected itself. |
| 77 | **A contract change sent to a lane mid-flight arrived after that lane had finished, and `dev` went red — the parallel-dispatch model has no way to interrupt a lane already deep in a slice.** Lane A discovered while building that two metrics cannot be branch-filtered (a top-up happens on a phone, so it has no branch) and changed the agreed contract to return `null` rather than a filtered number. Trunk relayed that to Lane C immediately. **The message queued for "its next tool round" and Lane C never acted on it** — its report mentions neither `null` nor `branchAssumed`, because it was already past the point where it read new input. It built against the original contract, its own typecheck was green against the un-widened schema, and the mismatch appeared only when trunk merged both and typechecked the combination. | **Trunk's error, not the lane's, and the interesting half is that every individual check passed.** Lane A verified its half. Lane C verified its half. Both were green, multi-run, in a browser. The defect existed only in the seam — which is what no lane can see and what trunk exists to catch, and trunk *did* catch it at merge. What failed was the assumption that a message reaches a running lane in time to change what it builds. **Two rules earned: (1) a contract that changes mid-slice should STOP the dependent lane and re-dispatch it, not message it — a queued message is advisory, a new brief is not; (2) when two lanes build against one contract, trunk must typecheck the COMBINATION before believing either lane's green.** Also recorded: trunk held the trunk-owned `packages/types` widening in a stash BETWEEN the two merges, rather than landing it alone (which turns `dev` red for three other lanes) or fixing the consumer itself (a lane-column violation). That staging is worth reusing — a shared-type change whose only consumer is one lane's file belongs in the integration step, not before it. |
| 76 | **There is no linting in this repository, and `CLAUDE.md` tells every session there is.** Its Commands section documents `pnpm check` as *"typecheck + lint + test across the workspace"*. Verified 2026-08-28: **no `eslint.config.*` and no `.eslintrc*` exists anywhere** outside `node_modules`. Root `lint` is `turbo run lint`, which fans out to per-package `lint` scripts — and of ten packages, **eight have no `lint` script at all** (`api`, `e2e`, `dashboard`, and all five shared packages). The two that do, `apps/wallet` and `apps/scanner`, define it as **`tsc -p tsconfig.json --noEmit`** — a typecheck wearing the name, running the same check `typecheck` already runs. So the lint third of the gate is a no-op that reports success, and the `// eslint-disable-next-line` comments in the tree are vestigial: they suppress a linter that has never run. | Found by Lane A in passing while fixing 75, which is how every instance of this gets found here. **Open, and it is a decision rather than a chore**, because adding a linter to a finished codebase is not free: it will light up thousands of findings across five surfaces at the exact moment the work is supposed to be converging, and a rule set nobody has agreed to is worse than none. The narrow honest fix — correct `CLAUDE.md` so the gate is described as what it is — costs nothing and should not wait. The broad one is a scheduling call for after the pilot. **What makes this the sharpest instance of this file's recurring shape:** the false sentence is in the project's own instruction file, in the section every session reads before running anything, and it has been quoted back in commit messages — including mine — as evidence a gate was green. |
| 75 | **RESOLVED 2026-08-28 in `4e569d6`. `receiptWorker.int.test.ts`'s already-sent spec was order-dependent — and the mechanism I said I had "fully confirmed" was the wrong one.** Measured before the fix: **6 failed / 4 passed of 10** on trunk's own lane, always `expected 'failed' to be 'sent'` at line 338. **The first single run of the broken spec passed**, which is this row's whole point restated. | **My diagnosis had true premises and a false conclusion, and I checked only the premises.** I was handed: tied `available_at` (one statement, one `now()`) plus `ORDER BY available_at` with no tie-break makes claim order undefined, and the driver's `let first = true` assumes an order. I verified all three facts, found them true, and wrote *"fully confirmed"* and *"their diagnosis is exact"*. **But `claimJobs` is `UPDATE … WHERE id IN (SELECT … ORDER BY available_at LIMIT n FOR UPDATE SKIP LOCKED) RETURNING …`, and the inner `ORDER BY` decides WHICH rows the `LIMIT` takes — it does not order `RETURNING`,** which emits in the outer UPDATE's scan order, and `runOnce` iterates exactly that. Order is undefined whether or not the timestamps tie. Reproduced on trunk with eight rows and **distinct** due times: the subquery picks 8,7,6,5 and `RETURNING` returns 5,6,7,8, the exact reverse. **The cost was in my recommendation, not my analysis:** I offered distinct `available_at` as an equally valid fix. Lane A tested it — bystander forced five seconds earlier, the OLD driver still passed 1 of 3. It would have cut the failure rate and looked like a fix, which is the worst available outcome for a flake. Lane A took the `jobId` route instead, so the spec depends on no order at all. Fourteenth instance of this file's shape, and the sharpest: **verifying the parts of a claim is not verifying the claim.** The three facts I checked were real and the conclusion drawn from them was still wrong, so the check felt like diligence and functioned as confirmation bias. Int suite now 91 across **six** runs, so the number I published off one run is finally measured. |
| 74 | **PARTLY RESOLVED 2026-08-28 in `4e569d6` — the false sentence is gone, the schema question is still open, and there was a SECOND one that this row never listed.** `receipts/types.ts` said `providerReference` was "stored for support to trace". Verified false against the **live** schema — no `provider_reference` column, no `provider` — and `markSent` drops the value. | Lane A corrected the sentence and added a note at `markSent` saying the parameter is deliberately unpersisted and why it stays; **no column, no migration, because the product question is not its to answer.** Still open and still on the register: does support need to follow a receipt into the provider's logs? **And it found the same falsehood one field away, which I had not noticed when I wrote this row:** `ReceiptSender.provider` claimed it "is stored on the job for forensics" — also false, its only reader is `logging.ts`'s own log line. So the count of this project's signature defect is not eleven or thirteen but higher than anyone has counted, because **each one found has been found by someone reading the line next to a different bug.** Nobody has ever gone looking for them on purpose. |
| 73 | **RESOLVED 2026-08-28 — and it needed a new file rather than a new paragraph.** `TickResult.lost` is an operational signal: persistently non-zero means two workers are contending faster than the lease intends, and `RECEIPT_LEASE_MS` (default 120s) is the knob. | Lane A drafted the line and **correctly refused to land it**, on two grounds: `RUNBOOK.md` is at repo root so outside its column, and — the useful half — **that document has no receipt worker section to sit beside, because it has no production ops content at all.** Its own title is *"Running four lanes — the daily operating manual"*: it is about four build sessions sharing one machine. Dropping production observability into it would have buried the line where nobody operating the product would look. So trunk created **`OPERATIONS.md`** and put a pointer in `RUNBOOK.md` naming the conflation. One entry, which is what has been earned — but a pilot needs somewhere for the second. Also recorded: `releaseHeldCampaigns` remains the only unguarded status write, deliberately, though its comment overstates what the `campaign_send` PK protects when an audience is empty. |
| 72 | **RESOLVED 2026-08-27 — and my "harmless in production today" was too generous, for a reason I had not looked for.** `RECEIPT_WORKER_ENABLED` defaults to `'1'` and `available_at` is a **lease**, existing precisely so a second process can take a row the first is still sending. **Two writers on one job is the design**, not a hypothetical. And of the three unguarded writes only `markSent` lost quietly: the other two **raise**, because `receipt_job_sent_at_matches_status` is `(status = 'sent') = (sent_at IS NOT NULL)` — verified against the live schema. That 23514 escapes `markFailed`, escapes `processJob` — **whose docblock at line 284 reads "Never throws — a bad job must not stop the batch"** — and escapes `runOnce`'s loop, abandoning every job the batch had not yet reached in `sending` for a whole lease. The give-back was not even inside the `try`. | Fixed with a predicate stronger than the one I asked for: `id AND status = 'sending' AND attempts = <claimed>`. **Status alone does not fence a lease-steal**, which is the case that actually happens between two instances — A's lease expires, B re-claims and leaves the row in `sending`, A's write still sees `sending` and still lands. `attempts` is incremented in exactly one place, `claimJobs`, so it is the claim's generation counter whether or not it was designed as one. Proven by staging each race from inside `send()` — the real window, the only one — so the interleaving is exact rather than probable: 4 failed unguarded, 4 passed guarded, byte-identical restore both ways. api int 91 (was 87) — **but see 75: that figure was one run of a suite that contains an intermittent failure, so it is 91-when-the-flake-sleeps, not 91.** |
| 71 | **Lane D's incorrect claim came from checking something narrower than it reported, and it diagnosed that itself.** It stated "only SELECTs precede them in their transactions" for the `computeAvailability` edits. It had actually grepped `tx.insert\|tx.update\|tx.delete` — a pattern a helper call like `claimKey(tx, …)` cannot match. So the check was narrower than the sentence, and the sentence is what a reader acts on. The conclusion happened to hold for a reason nobody had examined. | Worth recording because **it is the same defect this project has now found eleven times, one level up**: a confident sentence in the place a reader looks first, unbacked by what was actually run. The other ten were comments asserting a system state that had moved; this one is a lane report asserting a check that was never performed. The lesson generalises past comments to any claim about verification — **state what you ran, not what it would have caught.** Lane D reported it against itself unprompted, which is the behaviour that makes the rest of its reports trustworthy. |
| 70 | **`computeAvailability` writes, so whoever passes it a handle is choosing whether a merchant notification is part of their transaction — and the burst spec cannot see it.** On the google-sourced path `resolveWorkingWindow` raises or resolves a `calendar_disconnected` merchant notification. Moving booking's call onto `tx` (67's fix) means those writes now join the booking transaction, so a failed booking rolls them back. Lane A accepted it deliberately: the raise is `onConflictDoNothing` against a partial index, and the same call on the read path — `GET /artists/{id}/availability`, no transaction — has already raised it before a customer can pick a slot. | **The disclosure is the valuable part: the one semantic change in that diff is the one the test cannot cover.** Lane D's burst spec uses AR-004, which is `availabilitySource: 'manual'` and returns early before either write. So a genuinely correct fix carries a behaviour change that no spec in the suite exercises, and it is documented at the call site rather than left for someone to find. Also worth recording that Lane D's stated justification for the same edit — "only SELECTs precede them" — was **wrong**: `createBooking` calls `claimKey(tx, …)` first, which is an INSERT. Harmless, because `computeAvailability` never reads that table and READ COMMITTED makes the snapshot identical — but the conclusion was right for a reason other than the one given, which is worth knowing when the next person leans on it. |
| 69 | **RESOLVED 2026-08-27 by trunk, and with the stronger fix rather than the narrow one.** Lane A confirmed the diagnosis independently with the turbo dry-run graph — `@avo/tokens#build` appeared nowhere in it — and sharpened the remedy: declaring **`@avo/api`** as e2e's devDependency states the actual truth ("e2e boots the API, so everything the API needs must be built first") instead of patching today's single missing package. `@avo/api` has no build script, and turbo traverses straight through packages that lack one, so it resolves correctly. | Verified after landing: `@avo/e2e#test ← @avo/api#build ← @avo/tokens#build`, with `@avo/tokens#build` now a real transitive prerequisite. Touched the root lockfile, which is why it was trunk's to land rather than either lane's — and it stays correct the next time the API picks up a package, which the narrow fix would not have. |
| 68 | **A log written for an incident that no test harness can read is not a log.** `api/src/app.ts:57` sets `logger: false` when `NODE_ENV === 'test'`, and `e2e/support/tenancy-harness.ts` boots the API with exactly that. So `http/errors.ts`'s `req.log.error({ err }, 'unhandled error')` — written deliberately so that a 5xx is "an incident logged like one" — **writes nothing in the one configuration where 5xxs are actually observed.** Proven by fault injection: `false` produces nothing on stdout or stderr; `{ level: 'error' }` produces the full stack with file and line. | **This is why 65 took a full investigation instead of a log read**, and my own brief made it worse by asserting "an unhandled 500 means the API logged something" — false in that configuration, and it sent the investigation looking for evidence that could not exist. The proposed change prints only `req.log.error`, so a green run stays exactly as quiet as today and a failing one becomes diagnosable. The general form is worth more than the fix: **the value of an error log is decided by who can read it when it fires**, and a harness that silences the only reader turns every 5xx into an archaeology exercise. |
| 67 | **RESOLVED 2026-08-27 — verified on `dev` 2026-08-28, and the row had never said so.** `POST /charges` and `POST /bookings` permanently wedge the ENTIRE API process under ten or more concurrent requests — and the mechanism was already documented, fixed once, and left live in the caller.** `db/client.ts:17` opens the pool with `max: 10`. `services/charge.ts:179` opens `db.transaction(async (tx) =>` and takes one of the ten. `services/charge.ts:213`, **inside that transaction**, calls `peekToken(db, …)` — asking the same pool for a second connection while holding one. Ten concurrent charges hold all ten and each waits forever for an eleventh. **Postgres cannot see the cycle**, because it is in the JS pool rather than the database: no deadlock detector, no lock timeout, nothing ever breaks it. Measured by Lane D: twelve concurrent charges produced twelve twelve-second aborts, and a plain `GET /members/me/wallet-token` hung for twelve seconds *after the burst was over* — the wedge kills every endpoint, not just the one. Three one-word edits (`db` → `tx` at `charge.ts:213`, `booking.ts:380`, `booking.ts:903`) take that to twelve × 200 in 150 ms. | **`services/scannerLimit.ts:110` documents this exact mechanism** — *"pool for a SECOND connection while holding one. Ten concurrent charges hold all…"* — because it was found and fixed there. The same bug survived three lines away in its caller. And the probe that should have caught it cannot: `scannerLimit.int.test.ts` fires its twelve concurrent charges **with no `token`**, while the second acquisition sits behind `if (input.token)`. **Do not raise `max`** — with `max: N`, N concurrent still deadlock; it moves the cliff rather than removing it. In production this is ten tills scanning at once on the busiest day of the year taking the whole API down, and it would present as "the system is slow" rather than as an error. Fix dispatched. Money was never at risk: the wedged transactions had claimed an idempotency key and taken a row lock and nothing else, with balances, `transaction`, `ledger_entry` and `idempotency_key` byte-identical before and after, and clean rollback on process death. | **Verified 2026-08-28:** all three in-transaction sites now pass the handle — `charge.ts:238` and both `booking.ts` calls take `tx`. `staff.ts:825` still takes `db` and is CORRECT, because `POST /scans` opens no transaction; its own comment says so. The fix carries the mechanism in place rather than leaving it here, which is the right side of this file's recurring failure.
| 66 | **The schema constrains `member_wallet ⟹ member_id`, but says nothing in the other direction — so any non-wallet leg may legally name a member, and that asymmetry is why 64 survived.** `ledger_entry_wallet_requires_member` reads `account <> 'member_wallet' OR member_id IS NOT NULL`. Compare its neighbour `ledger_entry_balance_after_is_wallet_only` — `balance_after_fils IS NULL OR account = 'member_wallet'` — which DOES state the non-wallet direction. One constraint is written both ways round and the other is not. | Lane A closed it in TypeScript rather than SQL: `depositAppliedPosting` no longer accepts a `memberId` at all, so the mistake is unrepresentable and the compiler refuses it — verified by trunk, `TS2353: 'memberId' does not exist in type 'PostingRefs & …'`. A derived spec now asserts the missing direction over **every** posting rather than pinning the one site that was wrong. **What remains open is the database level:** a future path that writes `ledger_entry` without going through `money/ledger.ts` can still legally name a member on a non-wallet leg. The "the builders are the only place naming a ledger account" grep spec is what currently prevents that, and it is a test rather than a constraint. Whether to add the missing CHECK is the decision. |
| 65 | **ANSWERED 2026-08-27 — it was the connection layer, and candidate (1) was excluded by symptom rather than by preference.** The two candidates produce *different* failures, and only one produces a 500. **Contention inside the charge transaction cannot produce a 500 here** — it produces a permanent HANG: twelve concurrent charges answered nothing in twelve seconds, and `pg_stat_activity` **five seconds after every client had aborted** still showed ten backends, nine on `Lock/tuple` behind the member row. No 40P01, no timeout, no 500. **Connection starvation produces exactly 65's signature:** with the pool unable to open another connection, seven of eight concurrent charges answered 500 on `PostgresError 53300 "too many connections for role"`, FATAL at `InitializeSessionUserId`, body byte-identical to what a spec sees — a burst that clears the moment connections free up. | Two supporting facts worth keeping. `packages/mock`'s charge handler is pure in-memory with no throw path, so the eight failing specs were **necessarily** driven against the real API. And a full `pnpm check` peaks at ten `avo_app` connections against 97 usable, so a single run cannot starve the container — it takes leaked or concurrent API processes, which this file already records happening (three orphaned lane servers, one 2.5 hours old). **Money was never at risk in either mode:** starvation fails at connection authentication before any SQL runs, and the wedged transactions had claimed a key and taken a row lock and nothing else. Natural reproduction was not achieved — one forced `pnpm check` came back clean — and the investigation is closed anyway, because it turned up **67**, which is worse and was hiding behind the same symptom. |
| 64 | **RESOLVED 2026-08-27 — and the arithmetic in my ruling was wrong in a way that made the bug WORSE, not milder.** I said a deposit hold would net to zero for the member because the wallet debit and escrow credit cancel. That is not what happened: the **hold** is written by `depositHeldPosting`, which already passed `null`, so the hold was always correct. The defect was entirely in the **apply**, in `services/charge.ts` § 7:

| leg | rows | per-member net | her balance |
|---|---|---|---|
| hold | `member_wallet` debit (hers) + `deposit_held` credit (NULL) | −5.000 | fell 5.000 ✓ |
| apply | `deposit_held` debit (**hers**) + `salon_revenue` credit (NULL) | −5.000 | did not move ✗ |

**So the deposit was counted against her twice** — once leaving her wallet, and again when the salon earned it — and a per-member ledger net drifted by the full deposit on every completed booking. | Fixed by removing `memberId` from `depositAppliedPosting`'s signature entirely, so the compiler refuses it (66). My counter-argument was not merely weaker, it was incoherent: I suggested naming the member would answer "how much is held for this customer" without a join, but since the HOLD leg passes `null`, filtering `member_id` on `deposit_held` summed the applies alone — a purely negative number, never the open position. Buying that convenience would have required `m.id` on all three sites, which is the larger change and the one that breaks the net permanently. **No data migration**, and not as a judgement call: `ledger_entry` carries a `BEFORE UPDATE OR DELETE` trigger and `avo_app` holds only SELECT and INSERT, so a backfill would mean dropping the ledger's immutability to tidy a column no query reads. Nothing reads the historical rows — the only `member_id` filter on that account is in a test using deltas on a member with no deposit activity. |
| 63 | **My statement of 58 was right on the counts and wrong on the shape — the correction is worth more than the fix.** I said the ledger is never asserted by account and listed five accounts with zero test occurrences against `member_wallet`'s three. True. But Lane A asked the better question — "if these two accounts were swapped, would anything catch it?" — and the answer splits on one line: **the wallet leg was already pinned by the database; the non-wallet leg was pinned by nothing.** Verified against the live schema: `ledger_entry_wallet_requires_member` (`account <> 'member_wallet' OR member_id IS NOT NULL`) and `ledger_entry_balance_after_is_wallet_only` (`balance_after_fils IS NULL OR account = 'member_wallet'`), both from migration 0001. | So `member_wallet` — the single account the suite did mention — is the only one that could never have moved silently anyway, and the five it ignored are exactly the five carrying neither `member_id` nor `balance_after_fils`. **The suite was testing the one leg the database already defended.** That is the generalisable lesson: a coverage count tells you what is mentioned, not what is exposed, and the exposed set is whatever the schema does not already constrain. Proven not argued — Lane A inserted a swapped commission pair into a real database with `SET CONSTRAINTS ALL IMMEDIATE` and **Postgres committed it**, net zero, four rows, so both `e2e/adjustments.test.ts`'s net and `e2e/gateway.test.ts:393`'s row count stay green on a misposting. Trunk reproduced the unit half independently: 3 red, 301 green including every net-by-direction spec. |
| 62 | **A spawned background task inherits the `cwd` you give it, so a lane that spawns follow-up work into its own worktree puts two writers in one checkout.** Lane D spawned two chips for the HIGH items in its inventory and set their `cwd` — and wrote the path into their prompts — to `~/dev/avo-qa`. So a second session is now working in Lane D's checkout: two untracked `e2e/*.test.ts` files and a live uncommitted mutation in `api/src/routes/accounts.ts` (`!(role === 'all' …)`, which is a correct red/green step, not a defect). Lane D reported this itself rather than leaving it to be found. | **The work is disciplined and the placement is wrong** — this is precisely the shared-mutable-resource collision LANES.md exists to prevent, and it arrived from a direction the document does not cover: not two lanes racing, but one lane cloning itself. Trunk is unaffected (the mutation is uncommitted, so merging `feat/qa` picked up zero `api/` changes — verified), and nothing was touched. Two things to settle: **spawned work needs its own worktree**, which means the spawner cannot simply pass its own `cwd`; and a chip that mutates another lane's column to prove a test red is doing the right thing in the wrong checkout, since a session dying mid-ritual leaves someone else's file mutated. Also worth noting Lane D verified the thing that *looked* dangerous and found it safe: `sweepStaleRunDatabases()` is PID-blind but only drops databases older than two hours against ~10-minute runs, a twelvefold margin — so concurrent e2e runs do not eat each other, and the two exit-0 runs stand. |
| 61 | **`PLATFORM_FLAGS` are five dead controls: stored, echoed back, enforced nowhere.** `flagSignups`, `flagBooking`, `flagShop`, `flagWa`, `flagMaintenance` are written and returned by `services/platformSettings.ts:161-165`, and **no route reads any of them.** So an AVO admin can switch off signups platform-wide, see the switch move, and signups keep working. | A product question before it is a code one, which is why it is queued rather than dispatched. `flagMaintenance` is the sharp one: a maintenance switch that does nothing is worse than no switch, because it will be reached for in an incident. Decide whether these are meant to be enforced (and where — a global gate is a different thing from five per-feature checks) or removed from the console so nobody trusts them. |
| 60 | **File-in-isolation green is not evidence in `e2e/` — one shared per-run database, files run serially.** Lane D's own new spec passed alone and failed at file 31 of 31 with `expected 2 to be 1`: it counted a `lowbal` audience, and earlier files create consenting customers at the same salon and spend their balances down. It rewrote the assertion rather than the fixture — from a count to properties of the predicate (contains the low-balance row, contains no gold row, every recipient under the threshold by column) — which hold whatever else ran and are strictly stronger, since a predicate returning every member of the salon satisfied the old count and fails the new one. | Worth writing wherever the suite's contract lives, because the next lane will make the same assumption. The general form: in this suite an assertion about *how many* rows match is an assertion about file order. Assert properties of the result, not its cardinality. Note the file's own header already warned about this and it still caught the person who wrote the warning's neighbour. |
| 59 | **`pnpm check` is 10m48.9s and PASSES — it is not a hang and not the database mint.** Chased by Lane D after `833ee13` recorded it as unchased: 22 turbo tasks all successful, exit 0, with the e2e suite ~9.8 min of the total. It sits about **49 seconds past a 10-minute tool timeout**, which is the entire reason it reads as a failure from inside one. The +14 audience specs cost ~9 seconds; the gate was already there. | Not a regression, so nothing to fix — but two real options, and both are decisions. Either the gate keeps the full e2e suite and every invocation gets a budget above eleven minutes (and the RUNBOOK says so, since "it timed out" has now been misread twice), or the gate stops including e2e and that suite moves to its own step. Leaving it as it is means the gate intermittently reads as broken depending on who runs it and with what timeout. |
| 58 | **RESOLVED 2026-08-27 — the ledger is now asserted by account, and 63 records the sharper version of what the gap actually was.** `api/src/money/ledger.ts` holds eight pure posting builders covering every ledger write in the build, with 62 specs derived from `ledgerAccount.enumValues`, and ten call sites rewired through them — including `db/seed.ts`, so the demo ledger cannot drift from what the API posts. A grep spec asserts the builders are the only place in `api/src` naming a ledger account, which closes the "a caller stopped calling a builder" hole that pure functions would otherwise leave. api 304 pass (was 242). | Proven rather than argued, and reproduced by trunk independently: swapping the commission pair turns **3 specs red and leaves 301 green**, the 301 including every pre-existing net-by-direction assertion. Lane A went further and inserted the swapped pair into a real database with `SET CONSTRAINTS ALL IMMEDIATE` — **Postgres committed it**, net zero, four rows — so `e2e/adjustments.test.ts`'s net and `e2e/gateway.test.ts:393`'s row count both stayed green on a misposting handing AVO's commission to the salon. Still open around it: the daily reconciliation job (its own ticket) means nothing yet compares this ledger to the processor's, and **64** pins a `deposit_held` inconsistency this work surfaced. |
| 57 | **A test that pins one enum value proves the endpoint, not the enum — and `e2e/campaigns.test.ts` is the worked example.** `audience: "lapsed"` was a 500 for the entire life of the endpoint, on both the create and the release path, behind a suite that proves submission, approval, the weekly cap, the monthly cap, quiet hours and double-release idempotency — all with `audience: 'gold'` hardcoded at every call site. Five values exist in `CAMPAIGN_AUDIENCES`; one was exercised. The dashboard meanwhile offered `lapsed` in its audience select (`apps/dashboard/src/api/promotions.ts:279`), so the UI has been presenting an option that 500'd on submit. | The suite's depth is exactly why the money paths are trustworthy, so this is a coverage SHAPE to fix rather than a fault to assign. The rule: wherever a route validates against an `as const`, the coverage should be DERIVED from that constant, so a sixth value is covered the day it is added — the technique `consoleNavGates.test.ts`, `perm-census.ts` and now `campaignAudience.test.ts` all use. **BOTH OF THE TWO SITES I NAMED HERE AS MY TOP WORRIES WERE FALSE ALARMS, and that is worth recording so nobody spends a lane on them.** Top-up `method` is among the BEST-covered constants in the repo: `packages/types/src/money.test.ts:73-97` asserts exact fils per method (knet flat 150 at two amounts, card 300 and 675 showing the 2.5%+50 arithmetic, applepay = card), `e2e/integration.test.ts:1070-1099` asserts the persisted fee for all three, and `platformSettings.test.ts:84` runs a DERIVED loop over all three methods × five amounts. `PERMISSION_NAMES` likewise: all nine exercised twice (off→403, on→200) plus `e2e/permission-census.test.ts`, which parses the gates out of `api/src` source so a tenth is covered the day it lands. I picked the two that sounded most alarming rather than the two that were actually thin. **The real exposures Lane D found are 58 (the ledger by account), `ROLE_FILTERS` (no test sends `?role=` at all — three distinct query shapes), `availabilitySource` (the `google` side has five branches and zero test occurrences of the string), and `activityFeed`'s `FEED_KINDS` (a five-case switch carrying per-case arithmetic the file's own header flags as a previously-fixed double-counting defect, with NO test file at any layer).** Also systemic: the schema carries 84 `check()` constraints and 28 `pgEnum`s and not one is generated from its TypeScript constant — every list is typed a second time in SQL. Lane D verified all twelve `IN (...)` CHECKs against both the schema module and the migration that wrote them: no live drift today. |
| 56 | **`drizzle()` disables postgres.js's own date serializer, so a bare `Date` in a raw `sql` template is always a 500 — and three sites have now hit it.** Lane A proved the mechanism on one connection rather than inferring it: `drizzle-orm/postgres-js/driver.js` `construct()` overwrites `client.options.serializers[1184]` (also 1082/1083/1114) with an identity function, because Drizzle intends to encode dates itself from the column type. A parameter Drizzle never saw a column for therefore reaches `Bind` as a live `Date`, the identity serializer hands it to `Buffer.byteLength`, and it throws. **postgres.js can bind a `Date` perfectly well before `drizzle()` runs** — which is why "the driver cannot take a Date" is the wrong summary and sends the next person into `node_modules/postgres`, where the code is correct. | The rule that falls out: **where a Drizzle column is on one side of the comparison, use the helper** (`gte(transaction.createdAt, cutoff)`) and let Drizzle encode against it; **where there is genuinely no column** — raw aggregates — use the house `at()` idiom (`${iso}::timestamptz`) that `metrics.ts` and `platformMetrics.ts` already established. Those two files hit this same wall and recorded the symptom without the cause; `metrics.ts:84` even says "FOUND BY RUNNING IT" with the identical error text. Lane A swept all 109 raw `sql` templates in `api/src` and found no fourth instance. The gate-visible guard is `campaignAudience.test.ts`, which needs no database and generalises to any predicate builder. |
| 54 | **The `My bookings` tile's NEW-count badge is drawn in the design and not built.** `design/AVO Staff Scanner.dc.html:112` puts `{n} new` on that tile. The per-row `NEW` pill inside the bookings list *is* built (`BookingsScreen.tsx:214`) — this is only the count on the hub tile. | Blocked on the same question as 53, which is now answered **no**: the count exists only inside `GET /artists/me/bookings`, and the hub screen is not getting a request. So the badge stays unbuilt while that decision stands, and it should be revisited only if the hub screen ever gains a read for another reason — at which point this becomes nearly free. Held deliberately rather than dropped, because it is a real gap against a frozen design. |
| 53 | **RESOLVED 2026-08-27 — the `My schedule` tile will NOT be dimmed for a staff login with no linked artist. Lane B's recommendation, accepted.** The obvious parallel is `Today's charges`, which draws a padlock and *"Needs a senior to switch this on"* for a staff member lacking `perms.charges`. The mechanism transfers; the economics do not. `perms.charges` is authority the salon grants and is already in the session from sign-in, so the padlock costs nothing. "Does this login have an artist row" (`artist.staff_user_id`) is nowhere on the client — the only source is `GET /artists/me`. | Dimming would buy the hub screen — the one screen that renders instantly from session state and has no load, error or offline state of its own — three things it does not have: a tile-level loading state (dim-until-known, or draw-then-dim, which flickers), a rule for what to draw when that request fails, and a second live claim about artist-ness that can disagree with what `ScheduleScreen` reads a moment later. **The deciding argument is the failure case: dimming on a dropped signal would lock a real artist out of her own hours, and dropped signals on a salon phone are ordinary rather than edge.** Against that, the saving is one tap that already ends in a clear answer. **Also rejected: the zero-request `staff.role` heuristic.** The session knows Noura is a `manager`, but role and artist-linkage are separate columns that can diverge, and it would be the first courtesy in this app drawn from a proxy rather than the fact. **What made the demo feel broken was not the missing padlock — it was the refusal's copy**, which said "appointments" on a screen about hours and told a manager to get herself added to a team she manages. Fixing that copy is the real answer, and is done separately. |
| 52 | **`CLAUDE.md` and `LANES.md` disagree about who owns `apps/scanner/`.** CLAUDE.md's lane table says lane B writes only to `apps/wallet/`. `LANES.md:420` says "You write only to `apps/wallet/` and `apps/scanner/`", and `:422` explains why — ADR-0001 puts the wallet and the scanner in one Expo codebase. | Trivial to fix and worth fixing, because CLAUDE.md is the file every lane reads FIRST and the scanner is a quarter of the product. A lane following the table literally would refuse scanner work as out of column, or a trunk session would build it itself. LANES.md is the one with the reasoning attached, so it is probably right — but the two should be made to agree deliberately rather than by whichever a reader saw last. |
| 51 | **The scanner's "device-scoped PIN" is a rate-limit key, not a device pairing — and PIN guessing locks out a named staff member.** Found by trying to sign a second staff member into one device during a demo, and all three parts are measured rather than read. **(a) One device binds to one staff handle.** The PIN screen never asks who you are; `POST /staff/session` takes `salonId + deviceId + handle + pin`, and the handle comes from an unauthenticated "Set up this device" screen reachable from the sign-in screen. Hessa's correct PIN failed on a device bound to `noura`; re-running setup was the only way to switch. So **two staff cannot share one counter device without re-running setup**, and a receptionist plus a stylist sharing one iPad is the ordinary case. **(b) The failed attempt was attributed to the BOUND handle, not the typist.** My mistyped entry incremented `staff_user.pin_failed_attempts` for **Noura** — measured at 1. Because the lockout is keyed on the account, **anyone holding the counter device can lock a named staff member out of the till** by mistyping N times. **(c) "Device-scoped" is weaker than the phrase implies, and trunk stated it wrongly in a demo.** There is **no device registry table** — verified against the schema. The server resolves staff by `(salonId, handle)` and uses `deviceId` only to key the rate limiter and stamp the session; `deviceId` is a client-supplied string typed by hand, so rotating it yields a fresh rate-limit bucket. **What actually bounds PIN guessing is the per-account lockout at `auth.ts:1411`** — not the device. | Non-negotiable #6 requires staff PINs to be "rate limited, device-scoped, locked after N failures". All three exist, but "device-scoped" is satisfied in the weakest available sense, and the account lockout is therefore load-bearing — it must not be weakened on the assumption that device scoping backs it up. Three product calls follow: should one device serve several staff (a handle picker at sign-in rather than at setup)? Should re-binding a device require authentication? And should a lockout notify a manager, given a stranger can induce it? |
| 50 | **`apps/dashboard` has no `lint` script, so `pnpm check`'s lint leg is a no-op for the largest front-end package.** Verified: its scripts are build, dev, preview, test, typecheck. The gate reports lint as successful because turbo ran the dependencies' builds, not because anything was linted. | Two of the four surfaces' worth of code — the merchant dashboard and the owner console — are unlinted by the gate while the gate says otherwise. Cheap to fix and worth deciding deliberately, because adding a linter to a 16-file test suite and ~40 components will surface a backlog on the day it lands, and that is better known before launch than during it. |
| 49 | **`window.localStorage` is a bare `{}` under Node 25 + jsdom 30 in this workspace — no `getItem`, no `setItem`.** Measured by Lane C, not inferred. `auth/session.ts` calls `store.getItem` unguarded, which is CORRECT for a browser, so any jsdom test that mounts `AuthProvider` throws inside `hydrate()` before it renders anything. | The second render test to touch auth will hit this, and the failure looks like a bug in `session.ts` rather than in the test environment. Lane C installed a real in-memory `Storage` inside its own test and documented why that belongs in the test rather than in production code — do not fix `session.ts` to defend against a browser that cannot exist. A shared jsdom setup file is the better home once a third such test appears; that is the decision. |
| 48 | **Navigating imperatively straight after mutating auth state is broken in this app, and it is not a race.** `ConsoleSignIn.tsx` did `await signInToConsole(...)` then `await navigate(...)` on the next line. Lane C instrumented it: the guard reads an EMPTY context (`keys= Array(0)`) and bounces to the sign-in route. The cause is React's commit boundary — `setSessions` had not committed, so `RouterProvider` still held the previous `context`. **Deterministic, three reproductions out of three**, which is why a `setTimeout(0)` or an extra `await` would have appeared to fix it by coincidence. | Both sign-in screens are now effect-driven (`SignIn.tsx` already was — that difference was the diagnostic clue), but a third screen written the obvious way reintroduces it silently. Lane C proposes a derived guard of the `consoleNavGates.test.ts` kind: no `navigate(` in the same function body as a `signIn`/`signInToConsole` call. Worth deciding, because the failure mode is a user clicking a button that does nothing — and the submit button is disabled on an empty password while the success path clears it, so the admin could not even retry. They were stuck. |
| 47 | **A failed refresh blanks the Shop editor, including text she has typed.** `products.isError` renders `SectionError` over the whole screen — parity with `Accounts.tsx` and every other section, where only Overview does stale-not-blank. On an editor that also discards in-progress input. | Lane C kept the section vocabulary rather than inventing a seventh state pattern, which is right by default. But this is the one place where §4's stale-not-blank rule and the section vocabulary point in different directions, and an editor is exactly where losing typed text costs the most. Reachability is low today (`refetchOnWindowFocus` is off globally), so it is a decision rather than a defect — but it stops being low the moment that flag changes. |
| 46 | **`product.nameAr` does not exist, and the customer wallet renders product names in Arabic anyway.** Confirmed: `apps/wallet/src/screens/ShopScreen.tsx:206` renders `p.name` — one name, no variant — so an Arabic customer reads whatever English the merchant typed. `ServiceSchema` has `nameAr`; `ProductSchema` does not. **Corrected 2026-08-29: this row said "declares four fields" until the image slice widened it to five — lane B fixed the identical stale sentence in `apps/wallet/src/api/shop.ts`'s header and reported that the copy HERE was still wrong, which is the only reason it was caught.** The count was never the point and should not have been written down; what matters is that `nameAr` is absent. | Sharper now than when the schema first raised it, because **the Shop editor exists and is the surface that would author the Arabic name** — and it draws one name field. Fixing it needs a widening of trunk-owned `packages/types` (a four-way rebase) *and* a drawn input, so it is a trunk-plus-designer call, not a lane's. Note this does not conflict with `design/README.md` § Known gaps 1: the dashboard stays English-only as a UI; what is missing is an English UI for authoring an Arabic *value* the customer app already displays. |
| 45 | **A retired product cannot be brought back by anything.** There is no un-retire endpoint, `GET` filters on `active`, and `PATCH` carries `active` in its WHERE — driven: `204`, then `404 unknown_product` on a second DELETE and on a PATCH of the retired row, with `active=f` still in the table. | So a merchant who mistypes and hits ✕ must re-create the product under a new id, which orphans it from its own order history. Is that intended, or does the Shop editor owe a "show retired" view? The screen now says the action is one-way, so the customer-facing copy is honest either way — this is about whether the product should be recoverable at all. |
| 44 | **The design says "Delete product"; the server retires and cannot do otherwise.** `design/AVO Merchant Dashboard.dc.html:310` sets `title="Delete product"`. `DELETE /salons/{id}/products/{pid}` retires the row — the contract says so, and the API's own audit line already reads "retired from the catalog". Lane C used the truthful word: the ✕ reads "Remove {name} from the catalog". | The frozen bundle and the shipped screen now disagree on the record, and someone has to say which is authoritative. **The design cannot win this one on the API side** — the row is referenced by order history under `ON DELETE restrict`, so a real delete is not available to be built. So either the design's label is corrected, or the screen ships a word that promises something the product deliberately does not do. |
| 43 | **The Accounts screen's fifth column is a suspend toggle, and there is no suspension endpoint anywhere in the product.** `design/AVO Owner Console.dc.html:455` heads the table Name · Salon · Role · Password · **Active**, and `:469` binds that column's switch on every row to `a.onSuspend`. Nothing can serve it: there is no suspension endpoint in `api/src/routes` for a member, a staff member or a salon. The only matches for "suspend" under `api/src/routes` are a drawn-field list in `salons.test.ts:84` and comments at `platformConsole.ts:171` and `:419` arguing that the *salon* Live toggle the design draws has no column behind it either. Lane C rendered the four-state `status` the endpoint already resolves — `accounts.ts:135`, `active` / `deletion_requested` / `erased` / `deactivated` — as a read-only pill instead of shipping a toggle wired to nothing on the screen that controls every account AVO holds. | Policy before API. **Does AVO want account suspension at all**, and if so is it distinct from the deactivation (staff) and deletion-request/erasure (member) paths that already exist and are pinned by CHECK constraints? It cannot be layered onto what is there: **a toggle has two positions where an account has four states**, so suspension needs its own field, its own transitions and its own answers — what a suspended customer sees, whether her balance stays spendable, whether a suspended salon's staff can still charge. The design draws the control; nobody has said what it does. Expands #34 with the evidence; the read side is #42. |
| 42 | **The customer detail view has no read endpoint — its two writes exist, the read behind them does not.** The same design section opens a customer into a profile drawing phone, email, birthday, tier, stamp card, next booking, purchase history and a per-customer activity feed, plus **Adjust wallet** and **Add stamps**. Both writes exist and are gated `accounts`: `POST /members/{id}/adjustments` (`api/src/routes/adjustments.ts`) and `POST /accounts/{id}/reset-link` (`api/src/routes/accountResets.ts`). There is **no per-account READ**, and `api/src/routes/accounts.ts` says so in its own header: *"If the console needs to tell two customers named Dana apart, that belongs on a per-account read, not on a list that returns every tenant at once."* The wallet-adjust form is the sharpest case — **it needs the balance it is adjusting, and nothing serves that to the console.** | Which fields a `GET /v1/platform/accounts/{id}` should serve is a privacy call, not a schema question. The same header deliberately withholds customer phone and email from the list because *"serving the phone would put every customer's number in the product's widest list"* — and that argument may or may not hold on a single-account read that an admin has deliberately opened, which is a far narrower disclosure and an auditable one. The design draws the phone and the email. The field set needs a ruling **before** the endpoint is built, because the list's restraint was a deliberate departure from the design, and the detail read is where that departure either holds or is reversed by accident. Expands #34 with the evidence; the suspend side is #43. |
| 41 | **`POST /members/me/password` verifies the current password with no rate limit.** Found by Lane A while fixing the three anonymous sign-in doors, and outside the stated finding because this endpoint is authenticated. Flagged, not fixed. | An attacker who already holds a session can brute-force the current password without bound — which matters because the endpoint is the step before changing it, and because a session obtained on a shared or lost handset is exactly the case the wallet's own refresh-token decision already worries about. Minor next to the anonymous doors, and real. |
| 40 | **RESOLVED — the exemption is gone, and the default gate now covers the sign-in limiter.** Lane D removed the *reason* for the exemption rather than the enforcement: one cached session per identity per run in `tenancy-harness.ts`, and a fresh admin per round in `console-reset.test.ts`. `e2e/sign-in-limit.test.ts` drives all three endpoints from outside, so `pnpm check` — not just the integration suite — now guards the wiring. **The enumeration property is asserted from outside too**, and by byte-equality of the raw response rather than "both 429", because a body that differed would still be an oracle: a real seeded member proven sign-in-able in `beforeAll`, against a number registered to nobody. **Gaps Lane D named rather than left to be inferred:** it guards the 429 path; the 401 path is asserted as the same status and the same `invalid_credentials` code for both but is not byte-compared; and the `burnVerifyTime` argon2 timing channel is not covered and is not reliably e2e-testable, so it stays with Lane A's int suite. ORIGINAL ENTRY, kept because the measurement is the reason this got fixed: with the exemption in place I deleted the customer sign-in's charge line and `pnpm check` stayed 235 green — only the int suite caught it, 8 specs red, and that suite needs `AVO_INT_DATABASE_URL` and is not part of `pnpm check`. |
| 39b | **The hourly ceiling of 20 is far harder to reach than it looks, and whoever tunes #39 needs to know why.** Measured by Lane D against the red baseline: enforcing the limiter turned `console-reset.test.ts` red with `sign_in_rate_limited` firing **six** times and `sign_in_hourly_limit` firing **never**. The cause is the deliberate check-then-record ordering — a refused request writes no row, so of 20 attempts against one handle, 10 are counted and 10 are refused at the burst tier and leave no trace. The file stressed the 15-minute tier at twice its budget and never exercised the hourly one at all. | Not a defect: check-then-record is the right ordering and Lane A chose it deliberately, so a refused request cannot push the window forward indefinitely. But it means the two tiers are not independent knobs — the hourly ceiling is only reachable by a caller who stays *under* the burst tier and keeps going, which is a patient attacker rather than a script. Anyone lowering the burst tier makes the hourly one even less reachable. Also worth noting the corrected count: Lane A reported this file signs one handle in "four or five" times, which is the per-round figure; the file total is **20** (9 syntactic call sites, two inside loops, `RACERS = 5`). So the conflict with CI was 2× the budget, not marginal. |
| 39 | **Sign-in thresholds: 10 per 15 minutes and 20 per hour, per claimed identity.** An engineering default chosen by Lane A, not a policy decision, and it argues both directions in the file: tighter makes a stranger's denial-of-service cheaper on the one surface with no manager to call, looser stops being a control on guessing. | Someone has to own the number, and it is a product/risk judgment rather than an engineering one. Two properties are settled and should not be traded away in tuning it: the bucket is keyed on **what the request claims** and charged **before** any account lookup, so a spent bucket for a real customer and for a number nobody registered are the same code path; and it is a rolling window with nothing written to the account row, so no stranger can latch a customer out of her own money. What remains unbounded, named rather than denied: spraying one password across many identities, which needs a per-caller key that does not exist until `TRUST_PROXY` names the real proxy. |
| 38 | **PARTLY RESOLVED — two of three surfaces can now render a component in a test; the row is kept open for the third and for what is still unreachable.** `jsdom` + `@testing-library/react` are installed on the dashboard and the wallet, opted into per file so the ~700 node-environment tests pay nothing. The wallet aliases `react-native` → `react-native-web` and now collects `.test.tsx`, which it previously did not — so a render test there would not have failed, it would not have been COLLECTED and the run would have reported success. | **The scanner still has no renderer**, and more sharply: anything importing `react-native-qrcode-svg` — `QrOverlay`, `PaymentCode` — cannot be rendered at all. That package ships JSX inside `.js`, which vite refuses, and transforming it hits untranspiled Flow in React Native's own source via `react-native-svg`. Plain `react-native-web` renders fine, so the wall is that dependency chain rather than the approach. **The consequence is that the single most valuable render test in this product — proving a payment code §4 has suppressed never reaches the screen — is still the one that cannot be written**, and that property rests on `payTabWiring.test.ts` reading source text instead. |
| 37 | **Should the cart-count badge mirror to the leading edge in Arabic?** It sits on the physical right of the bag glyph in both languages. Lane B checked before changing anything: that is exactly what the design does — design:626 carries an inline `right:-8px`, and design:1078 sets `dir=rtl` without ever touching the badge. | Faithful to the design and against the usual RTL mirroring convention, so it is a designer's call rather than a bug. Non-negotiable #12 says Arabic is a first-class layout, which is an argument for mirroring it; the design is an argument for leaving it. Raised now because the new fourth nav item sits beside it and makes the asymmetry easier to notice. |
| 36 | **Should the wallet's bottom nav render on the Account screen, as the design draws it?** design:622's nav sits inside the same `authed` block as `isAccount` (design:391), so the design does show it there. The build hides it, on a rationale that predates this session. | Left alone by Lane B, correctly — but it now has a consequence it did not have before: **Pay is unreachable from Account**, and Pay is the app's primary action. The old rationale was written when the nav held three navigational tabs and hiding it cost nothing. |
| 35 | **What should the wallet's Pay tab do when §4 has hidden the payment code?** §4 says only that the QR must be hidden offline, because "a stale token will fail at the counter and that failure looks like the salon's fault". It does not say what a Pay affordance should do in that state, and the design's prototype has no offline state at all. Lane B chose to fall back to Home, where the design's own `qrOfflineTitle`/`qrFailedTitle` copy already lives. | The alternatives both require inventing something the design does not contain: a disabled tab (no disabled treatment is drawn) or a toast (nobody wrote the words). The chosen answer invents nothing, which is why it is the right default — but it is still a product decision about the app's primary action, made by a lane because the spec is silent. |
| 34 | **SUPERSEDED by 42 and 43, which ask the same two questions with the design's own line numbers.** Kept only for what it uniquely records: what Lane C BUILT instead of the three unservable controls. It rendered the four-state `status` the endpoint already resolves rather than a switch wired to nothing; it dropped the banner's middle clause because that clause describes the detail view of 42 and kept the two true clauses verbatim; and it removed "role" from the search placeholder because the API deliberately does not match it, so promising it would work for one chip and fail silently for three. | Answer 42 and 43, not this row. Recorded as a duplicate rather than deleted because the queue is the project's critical path now, and a row that quietly vanishes is indistinguishable from a row someone answered. |
| 33 | **`?salon=` exists on both platform endpoints, is exposed by neither, and the two disagree on the refusal.** `GET /v1/platform/activity` answers an unknown salon with `notFound`; `GET /v1/platform/accounts` answers the same case with `badRequest`. `SectionError` maps neither 400 nor 404 to a named answer. | Harmless today because no UI passes the parameter — neither design section draws a filter. It becomes a live defect the moment anyone wires a salon picker, and then it presents as one screen saying something useful and the other showing a generic failure. Cheaper to settle which code is right now than to discover it from a screenshot. |
| 32 | **The console's Activity feed has an empty state that cannot be reached, by construction.** Reaching the screen requires a console sign-in, which writes an `audit_log` row (`kind:'access'`, `salon_id:null`) at `auth.ts:626` — and that feed reads audit rows unfiltered and append-only for seven years. The reader's own arrival guarantees the row she is looking at. | Lane C built the state correctly and kept it rather than deleting it, which is the right call for a state that is unreachable by circumstance rather than by design. Worth a decision because the alternative — filtering the reader's own arrival out of the feed — is a change to what the audit log means, and an audit trail that hides one class of access to make a screen look tidier is a bad trade nobody has actually been asked to make. |
| 31 | **One abandoned payment page blocks a customer's deletion promise for ever.** `services/erasure.ts` defers any member whose top-up sits in `LIVE_INTENT_STATUSES`, marking her `deferred_pending_topup`. Before the reaper there was nothing to clear such a row, so a single abandoned intent parked her erasure permanently. | This is the sharpest consequence of #27 and it is not a tidiness issue: the published privacy policy promises deletion within 30 days, and an unresolvable row broke that promise silently and for ever. The 168-hour reap window sits deliberately inside thirty days for this reason. Recorded because the interaction is non-obvious — a table nobody was watching was holding a legal deadline open — and because it is the argument for the reaper being enabled in production rather than left default-off. |
| 14 | **What should a customer see for a salon-initiated balance change?** The design draws the console's "Adjust wallet" and its audit line, but the wallet's activity fixtures never show an adjustment. The label `'Adjustment'` was **forced by the type** (`txKind` is a Record over every `Transaction` kind) and filled in undocumented — same provenance as three other labels the record demanded, none drawn. She now sees an honest unexplained balance change with **no route to an explanation**, because `note` deliberately never reaches her. | Needs a drawn row and a product call: whether it is even called "Adjustment", whether a credit and a deduction should read the same, and whether an unexplained change is meant to be a support call. Widening `TransactionSchema` to carry `note` is trunk-owned *and* a product question. |
| 13 | **The set-new-password screen is not drawn, and the reset link has nowhere to land.** The design's auth flow has login/signup/forgot only — no redeem layout, no copy for its success or refusal states — the sender is the standing WhatsApp/domain escalation, and the wallet has no inbound deep-link routing at all, so the link's shape (`avo://reset?token=…`) is a decision, not a wiring gap. | Needs a drawn screen (designer), the sender (client escalation), and a deep-link ruling. Until all three, the flow honestly ends at "Check WhatsApp" — which is everything it can truthfully do. |
| 12 | **Erasure cannot reach the audit log, structurally — and the policy promises both.** Her historical `audit_log` rows (`actor_name`, ip, ua, names in `detail`) and `member_consent_event` outlive erasure: the app role had UPDATE/DELETE revoked in 0020/0023, which is what makes the log trustworthy. Policy §5 (deletion) and §7 (audit) are in genuine tension. | The fix needs an owner-role job or a narrow column grant, and the **retention schedule is client-owned** (CLAUDE.md escalations). Every erasure records `retainedBeyondErasure` in its own audit metadata, so the gap is a standing measured fact while it waits. |
| 11 | **Should a deletion request be refused up front when money is still in motion?** The request checks only `balance_fils` at request time, so residual balance, escrowed `deposit_held`, and a live top-up intent can all reach the due date. The job counts and **defers** each, visibly — a deferred count persisting across runs is a member the platform is quietly failing. | Whether the *request* endpoint should refuse escrow/in-flight states is a product call about what a customer is told at the moment she asks to leave. The safe behaviour (defer, never erase money in motion) ships either way. |
| 10 | The `marketing` plugin's MCP servers (Slack, Figma, Notion, HubSpot, Klaviyo and others) all report needing authorisation, and the OAuth flow cannot run in a non-interactive session. | Needs Aftab in an interactive session, or the claude.ai connector settings. **No lane has needed one**, so nothing is blocked today — recorded because a capability that silently fails is worse than one known to be off. |
| 9 | **Who in a salon may export customer PII?** The design draws nine permission chips and Reports is not one of them, and none of the nine is a customer-data permission. A `customers.csv` carries every member's name, phone, wallet balance and tier. | A tenth permission is a four-way break in trunk-owned `packages/types`, but the real blocker is that this is a **product** call about salon staff and customer data, not a schema question. Interim rule below errs restrictive so nothing ships open. |

---

## Decisions I made

Newest first. Each: what, why, and how to reverse it.

### Three undeclared keys in one round, and the shape of my five wrong claims

**The round.** The owner console went from 7 of 10 sections to 9 of 10: Lane A built the six
support endpoints (seven, with the `DELETE` I had missed), `GET /v1/platform/activity` and
`GET /v1/platform/accounts`; Lane C built Support & contact end to end; Lane D asserted the
predicate boundary and #11 in both directions. **Billing remains blocked on #15** and console
Reports still needs a `reports` section that `PLATFORM_SECTIONS` does not have.

**Three keys were served first and declared second**, each reaching clients as `undefined`
because zod **deletes** an undeclared key rather than failing on it: `topic` (the joined label),
`salonId` (the value the queue's own tenancy predicate is built on), and `total`. Every one was
found by a probe, none by a client noticing data missing — which is the argument for that census
existing at all.

`total` got a **new helper rather than an optional field**. `paginated()` is used by the wallet's
booking and service pages, which do not send a count, so an optional `total` there would tolerate
a server that forgot it. Lane C then found the concrete case that justifies the split better than
my reasoning did: its hand-parsed envelope defaulted `total` to `0`, so an API that stopped
sending the count would render **"Messages · 0" over a list of real messages** — the premature-zero
class arriving through a defensive *default* rather than a loading state, invisible to census pins
that guard only the pending path.

**And the audit reads are not probed at all** — both `UNMODELLED`, because no audit schema exists.
So there is no latent strip there today, but the trap is armed for whoever schemas them next,
since binding through `paginated()` would delete a `total` both endpoints serve. Lane D wrote
that into both entries rather than leaving it for someone to rediscover.

### My five wrong claims this round had one cause

`city` unserved; "every preset holds `analytics`"; the backwards-window rule (twice, from two
directions); console Reports' endpoints; Support's endpoint list (twice — five instead of six, and
the heading left saying five after the body was fixed); the retired-topic fallback; and "792
passed" reported to Aftab as a result when it was a **mid-run progress count** from a run that
never finished.

**Every one was me trusting a representation of state instead of the state.** A contract document
that says what *should* exist. A comment that describes another file. A partial log. A commit
message. My own earlier sentence. The build already has this rule pointed at code — *never trust a
comment, grep the routes* — and I did not point it at the artefacts I was reading.

**The habit, one line:** before telling a lane something exists, run the command that would prove
it. `grep app\.\(get\|post\|patch\|delete\) api/src/routes/`. Before quoting a run, check it
has a summary line.

Lane D's framing is better than treating this as a lane-catches-trunk story, and it is the version
to keep: the same habit that produces the slip catches it when applied, and the durable fix is not
vigilance but **making the claim executable so it fails by name when it stops being true.** That is
what the census, the regex-agreement corpus, the overlap precondition and the known-positive
control all are — and all of them caught something real this round.

### Support is SIX endpoints short, and I read that from the contract instead of the routes

**What.** Briefing two lanes that the Support panel was "purely unrendered, no API work needed",
I listed four endpoints as built. **Two exist.** (This heading said "five" until Lane C pointed
out that the correction had corrected the body and left the title — the most-read line in the
entry. Third correction to an entry about corrections.) `GET /v1/platform/support` and
`POST /v1/support/tickets`, both in `api/src/routes/platform.ts`. Specified in
`api-contract.md` §§ 555–586 and implemented nowhere: `PATCH /v1/platform/support/channels`,
`POST /v1/platform/support/topics`, `PATCH /v1/platform/support/topics/{id}`,
**`DELETE /v1/platform/support/topics/{id}`**, `GET /v1/support/tickets?route=&status=`,
`PATCH /v1/support/tickets/{id}`.

**CORRECTED TWICE, BOTH BY LANE D, BOTH INSIDE THIS ENTRY.** It is **six** missing, not five —
I omitted the `DELETE`, which the contract writes as `DELETE/v1/…` with no space, and which Lane
D found by **computing** the difference between the contract's list and the route registrations
rather than reading either. That method would have caught all five of my errors this session.

And this entry originally said the endpoint *"refuses a client-supplied route"*. **It ignores
it** — `platform.ts:707` says so in those words, and ignoring is the right behaviour. So the
entry about doc/code drift contained doc/code drift. Lane D caught that too.

So **every editor and the entire ticket queue have no endpoint.** Lane D caught the premise
before it wrote anything; all three lanes were then interrupted for unrelated reasons, which is
the only reason Lane C had not already built a screen full of dead controls.

**The mechanism, stated plainly because it is now a pattern rather than an incident.** This is
the **fifth** unverified claim I have passed to a lane this session — after `city` being unserved,
"every preset holds `analytics`", the backwards-window rule (twice), and console Reports' gate.
Four of the five share one cause: **I trusted a document that describes code instead of reading
the code.** `api-contract.md` is a specification, not an inventory; it says what should exist. The
routes say what does. I even caught myself making this exact mistake about Reports an hour
earlier and did not generalise it.

**The habit that would have prevented all four:** before telling a lane an endpoint exists,
`grep app\.\(get\|post\|patch\|delete\) api/src/routes/` for it. One command. It is the same
discipline the build already writes into every brief — *never trust a comment, grep the routes* —
applied to the contract, and to me.

**What changed as a result.** Lane A's slice is reordered to put the five support endpoints
**first**, because they unblock another lane. Lane C is scoped to the **read half only** and
explicitly told not to draw editors or a queue that have no endpoint — its own Manage-button
precedent, where it refused to ship a control that only 403s. Lane D starts with #11, which is
fully drivable today: `POST /v1/support/tickets` plus the existing config is enough to prove the
server resolves routing from `topicId` and refuses a client-supplied route.

**Not reversible, and not a decision — a correction.** Recorded so the count is visible: five in
one session, four with one cause.

### The owner console is 7 of 10, and two of its sections are not in the nav at all

**Asked whether the console is complete. It is not**, and the shape of what is missing is worth
recording because two pieces are invisible from the nav.

**Built (7):** Analytics, Salons, Admins, Approvals, Policies, Audit log, Controls — all routed,
all with endpoints.

**Stubbed as `NotBuiltYet` (3):** Activity, Accounts, Billing.

- **Activity** — no endpoint of any kind.
- **Accounts** — *the verbs exist and the list does not.* `POST /members/{id}/adjustments` and
  `POST /accounts/{id}/reset-link` were both built last session, but `GET /members` and
  `GET /staff` are salon-scoped merchant doors behind `requireDashboardPerm`. **The console can
  act on an account it cannot find.**
- **Billing** — no endpoint, and blocked rather than merely unbuilt: same gap as #15, no trial,
  subscription or invoice column exists and the design's figures are prototype fixtures.

**Missing and invisible (2):**

- **Support & contact.** The design puts it at the bottom of Policies. `Policies.tsx` contains
  **zero** references to it — while `GET`/`PATCH /v1/platform/support` and
  `GET`/`POST /v1/support/tickets` all exist. **Endpoints built, nothing renders them**, and
  because it is a panel inside a screen rather than a nav item, no "not built yet" stub reveals
  the gap. This is the inverse of the stale-comment class: not prose claiming something is
  absent, but a *nav* implying completeness because the missing thing was never an item.
- **Console Reports.** The design's section list names it ("per-salon CSV export") and it is not
  routed, not stubbed, not in the nav. **And I got this wrong once already:** I told Lane C its
  endpoints existed. They do not work for this caller — `requireDashboardPerm` returns a
  `StaffPrincipal` and demands a `dashboard` scope, so a platform admin cannot call
  `/salons/{id}/reports/{kind}` at all. It also has **no `reports` entry in
  `PLATFORM_SECTIONS`**, so there is no section to gate it on — the same shape as the merchant
  Reports having no permission chip (#9 in the queue). Adding a section is a `packages/types`
  change and therefore trunk's.

**Dispatched:** Lane A the two API-blocked sections (Activity, the Accounts list) with branch
add/remove and the Reports gate as stretch; Lane C Support inside Policies, which needs no API
work; Lane D the support endpoints nothing has driven — #11 is the point of that feature and
`POST /v1/support/tickets` must refuse a client-supplied route.

**Billing is deliberately not dispatched.** Building a billing screen against invented invoice
shapes is how prototype figures end up on a real merchant's account, and `Settings.tsx` already
refuses it for that reason.

**The lesson I keep paying for.** I asserted Reports' endpoints existed without checking, which
is the fourth unverified claim of mine this session after `city`, the preset table, and the
ordering rule. I checked this one *before* briefing because of the previous three — and it was
wrong. **The habit that works is checking before speaking, not after being corrected.**

### The wizard's second drawn promise — the 14-day trial — is queued, not corrected

**What.** Having authorised a success state that fixes the invite promise, Lane C pointed out the
review step carries a **second** one: *"opens a 14-day trial before the first invoice"*. It
declined to repeat it in the success state, on the grounds that restating it would invent a
second false claim while fixing the first. Correct.

**I verified the gap rather than take it on report:** zero `trial` / `subscription` / `invoice`
columns across every schema file, and neither `api-contract.md` nor `packages/types` names one.
Billing is fully designed with no API behind it.

**Decision: queue it (#15), keep the drawn copy, and do not correct it in the UI.**

**Why this is not treated like the invite.** The invite promise was an *implementation* gap: the
thing is specified, the fix is known (wire a sender), and the interim statement — "queued,
delivery not enabled" — is a plain fact about the system. A trial is a **commercial term**, and
there is nothing to state a fact about. Building one means choosing when the clock starts
(creation? first charge?), what day 15 does (a hard stop? a flag? an invoice?), and whether it is
enforced at all or is only billing metadata. Those are AVO's decisions, and inventing a
`trial_ends_at` that nothing reads would be worse than the gap — Lane A already refused it for
that reason.

**Why not soften the drawn copy in the meantime.** Editing a commercial commitment out of a
designed screen is a bigger act than adding an honest success line, and it is not reversible by
anyone but the client. The consistent position across both promises is the same:
**do not invent, and do not propagate.** The success state says nothing about a trial, so an
admin who reads it learns only true things — and the queue entry is where the contradiction gets
resolved by someone who can set the terms.

**Reversal.** If AVO says trials are tracked manually for the pilot, the answer is a line in the
success state and no schema at all. If they are a product feature, it is a column, a Billing API,
and the drawn copy becomes true.

### The salon list regates to `salons`, the wizard gets a success state, and I propagated a false premise

**1. `GET /v1/platform/salons` moves from `analytics` to `salons`.** Routed to Lane A.

Lane C found the list refuses a **support** admin. I verified the preset table myself rather
than take it on report: `PLATFORM_ROLE_PRESETS.support` is `{analytics: false, salons: true}`.
So the role whose job is customers, and which explicitly holds `salons`, cannot list salons —
while `analyst`, which holds `analytics: true, salons: false`, reads the tenant list fine. The
gate and the section name point at different people.

**Lane A's original tiebreak was sound and still gets the wrong answer.** It reasoned that
`GET /platform/metrics` already exposes salon names and money under `analytics`, so gating the
list there "widens nothing". True — that is a good argument for why `analytics` would be
*acceptable*, and not an argument that it is *correct*. `salons` is what "may see the platform's
salons" means, and regating widens nothing either: owner, admin and support all hold it. The
analyst loses the tenant list and keeps metrics, which already names its top five salons — so
nothing it needs disappears. The Audit picker's only consumers are owner and admin, who hold
`salons` too, so the unblock survives.

**The route's comment must go with it.** It justifies the gate with "each one holds `analytics`",
which is false. That is the same stale-or-wrong-comment class this build has now paid for four
times, and it is *how* the mis-gating survived review.

**2. The wizard gets a success state, and the copy is authorised.** English only — `design/README.md`
§ Known gaps 1 makes the console English-only, so there is no Arabic half.

The design draws no success state, so the wizard closed and the row appeared. Lane C declined to
draft copy and asked. The reason it needs one is operational, not decorative: the last thing the
admin read was the drawn promise *"sends the owner a WhatsApp invite"*, **no sender is wired**,
and the owner cannot sign in (`passwordSet: false`). An AVO admin who believes an invite went out
will tell a salon owner to check WhatsApp for a message that will never arrive.

So the state must carry three facts and no promises: the salon exists, the owner's sign-in handle
(which the API returns and nothing rendered), and that the invite is **queued with delivery not
yet enabled**. Mark it `INVENTED`. This is the same call as the offline cold-load sentence —
*"keep the copy verbatim" governs copy that exists*, and holding here ships a false impression to
AVO's own staff. **Reversal:** when the sender lands, the delivery clause is the only part that
changes.

**3. There is still no per-salon editor, and no endpoint for one.** Routed to Lane A:
`GET` / `PATCH /v1/platform/salons/{id}`. `GET /salons/:id` refuses a platform principal and
points at "the console's Salons section" — a guard pointing at a screen that has no remedy. Lane
C drew no Manage button rather than shipping a control that only 403s, which was right.

**4. A correction of my own, twice over.** I told Lane C that `city` is not served. It is. I had
grepped `api/src/routes/salons.ts`; the platform list lives in `platformConsole.ts`. That is a
zero result that was a claim about my command — the exact trap I had written into three briefs
that same hour. And I repeated Lane A's "analytics is the one section every preset holds" onward
without checking the preset table. **Both are the same failure: passing on a claim I had not
verified, while telling four agents to verify claims.**

### Lane B's three routed items: two decided, one sequenced behind Lane A

**1. `brandDeeper` and `brandTint2` WILL be white-labelled — but not while Lane A is building on
the deriver.**

`packages/tokens/src/generate.ts:42` white-labels exactly three values — `brand`, `brandDeep`,
`brandTint`. Lane B found that `brandDeeper` and `brandTint2` therefore stay sage in a rose app,
**on the dashboard as well as the wallet**, and correctly declined to derive them locally because
that would be a second derivation policy outside the trunk-owned package.

I checked what they are actually used for, because "fidelity gap" undersells it in one direction
and oversells it in the other. `brandDeeper` is a **text** colour — six places in
`apps/dashboard/src/app.css`, two in the wallet. `brandTint2` is a **background wash**, two
places in the wallet's booking parts. So a rose-branded salon renders **sage-green text** inside
its own app. Lane B's contrast numbers are reassuring (fixed `brandDeeper` on a themed tint is
5.81 / 5.67 / 5.60:1, themed `deep` on fixed `brandTint2` is 5.33 / 5.48 / 5.56:1), so this is
**not** an accessibility failure — but "one `--brand` token restyles the entire app" is the
product's first sentence, and green text in a rose app is a visible contradiction of it.

**Why it waits.** Deriving two more values means two more contrast constraints inside
`deriveBrandSet`, and **a tighter deriver can make a previously viable hex non-viable.** Lane A
is at this moment wiring that exact function into `POST /v1/platform/salons` and the `PATCH`
path, with fixtures built against today's answers. Moving the goalposts under the lane building
on them is how one failing spec became four, once. So: after Lane A lands, as a trunk operation
on `dev`, then every lane rebases — per `CLAUDE.md`'s rule for the shared packages.

**Lane B left a tripwire and it should be honoured, not deleted:** `brand.test.ts` asserts the
two are untouched, so whoever white-labels them gets a failing test naming the fact. That is the
test doing its job — update it deliberately in the same change, do not silence it first.

**2. `applyBrandColor` stays duplicated across the two apps.** Same ruling as `loadFailure.ts`,
for the same reason: ~15 lines whose surroundings genuinely differ — different theme objects,
different storage keys, and different fallback stories (the wallet has a signed-in source, the
scanner has a pre-enrolment default it must keep). A shared helper would have to be parameterised
over all three differences, which is more coupling than the duplication costs. **Reversal trigger
unchanged:** a third surface needing it, or the two fallback stories converging.

**3. An unauthenticated salon-identity read is a good idea, and it is Lane A's to shape.** Lane B
wants name + brand hex (+ logo, when it exists) readable with no principal, to close the wallet's
first-ever launch and the scanner's pre-enrolment PIN screen. The precedent it cites is real —
`/v1/platform/policies` is unauthenticated by necessity because a signup screen renders it before
there is a session. Queued for Lane A's next slice rather than injected into its current one.
**One thing whoever builds it must settle:** an unauthenticated endpoint keyed by salon id is an
enumeration surface, and this build already has a worked answer for that shape in the member
password-reset flow — byte-identical responses, throttle before validation. A salon's name and
brand colour are not secrets, but *which ids exist* is a different question and deserves the
explicit sentence rather than a shrug.

### White-label onboarding: the answer is a wizard, not a branch — and no salon can be created today

**The question put to me:** for each new client, does the backend get a tenant and the frontend
get a new branch or repo? And should a new client be web or mobile?

**I read the handoff and the plan before answering, and the premise needed correcting.** The
distribution question is downstream of a gap nobody had named: **there is no way to create a
salon.** No `POST /salons`, no `POST /v1/platform/salons`, and `api-contract.md` names neither.
Every salon in existence is there because `seed.ts` inserted it. Onboarding a real client today
means a hand-written `INSERT`. Deciding per-client app distribution before that exists is
choosing the roof before the foundation.

**And the flow is already designed**, so there was nothing for me to invent. `README.md:165`:
Owner Console → Salons → **+ Onboard a salon**, a four-step wizard — *details & plan → modules &
deposit → loyalty & brand colour → review* — which creates the salon and sends the owner a
WhatsApp invite with a 14-day trial. `build-plan.md` Phase 7 lists "Salons with the onboarding
wizard". The console ships six sections today; **Salons is not one of them.**

**Decisions.**

1. **No branches, no repos per client. This was already settled and stays settled.**
   `ADR-0001` rejects branch-per-brand *by name*, against AvoRewards' live model of one branch
   and one Xcode scheme per brand, with the reason that "every fix must be cherry-picked ten
   times". Per-client identity is **data**: a salon row, a brand hex, and (later) a logo and
   type pairing.

2. **Web and mobile both, from the one Expo codebase — this was never either/or.** The ADR:
   the wallet "builds to mobile web for the pilot — no forced download, no App Store review
   inside the 30 days, **no rewrite when it does go to the stores**." Store submission is in
   scope and partly built: in-app account deletion is ticked *because Apple requires it*. What
   I recommend on **sequencing** is that a new client's web URL goes live the day their row
   exists, and their native build follows through the store queue — the native app arriving
   second, not being dropped.

3. **Per-client native store distribution is deferred as a business decision, not a technical
   one.** How many store listings, under whose developer account, is about review cycles and
   credentials. It does not block the pilot and the ADR guarantees no rewrite. What it does
   change: a hardcoded hex hurts *more* in a native build than on the web, which is why the
   runtime-brand work below comes first either way.

4. **Logo and typography storage is deferred, deliberately.** Neither has a column anywhere.
   The wizard as designed sets **colour only**, so this blocks nothing today, and the merchant
   Brand kit (`README.md:141` — logo drop plus four type pairings) is its own design slice.
   Recorded so the go-live pipeline row is not read as closable without it.

**What I dispatched, in dependency order.** Lane A: `POST /v1/platform/salons`, with
`brandColor` validated through `deriveBrandSet` on **create and update** — which closes the #9
write-path defect in the same slice, since both doors need the same guard. Lane C: the Salons
section and the four-step wizard. Lane B: the wallet reading `brandColor` at runtime, which is
the single change that turns "per-client build" into "per-client config", plus the scanner
taking its pre-auth name from the enrolment binding it already holds. Lane D: coverage for the
new endpoint, its tenancy, and the refusal of a non-viable hex.

**Reversal.** Every piece is additive. If AVO later wants per-client repos, the wizard still
produces the row that such a build would read from; nothing here forecloses it, and the
argument against it is `ADR-0001`'s, not mine.

### A type-forced label is an undrawn design decision wearing a compiler's authority

**The pattern Lane B named while reporting the adjustment row.** `txKind` is typed
`Record<Transaction['kind'], string>`, so adding a transaction kind **forces** a label into
existence. Four of them — `'Adjustment'`, `'Service'`, `'Shop order'`, `'Deposit held'` — were
never drawn anywhere in the bundle. They exist because the compiler demanded a value, and they
read as designed copy to anyone who finds them later.

**Why this is worth a decision entry rather than a shrug.** This build's rule is *keep the copy
verbatim, do not paraphrase, do not invent*. An exhaustive `Record` quietly inverts that rule:
it makes inventing the **path of least resistance** and the omission **invisible**, because the
type is satisfied and nothing is missing. That is the opposite failure from the stale absence
comments — there the prose claimed a gap that had closed; here the type conceals a gap that is
open.

**What is not changing.** The labels stay, all four are in `AR_GAPS`, and the rendering is
consistent. Lane B was right to report rather than redesign: what a customer should read for a
salon-initiated balance change is a product call (queued as #14), and a lane guessing it would
be exactly the invention the rule forbids.

**What is changing: the provenance is now recorded where the labels live.** An undrawn label
should be identifiable as undrawn. `AR_GAPS` already marks them as lacking *Arabic*; nothing
marked them as lacking a *source*. Note this in the copy files when next in them — a
type-forced value is a decision nobody made, and it should not be able to pass as one that was.

**The generalisable check:** when a discriminated union gains a member, ask what the exhaustive
records over it just invented. `Record<Kind, …>` is a lint that catches missing *code* and
launders missing *design*.

### The drawn sent-state sentence stands, and the tension is recorded where the copy lives

**What Lane B raised.** The design's forgot-password sent state reads *"A secure reset link is
on its way to your registered number."* — rendered identically on every 202, which is the
anti-enumeration posture working. But on an unknown phone (or with no sender wired) the
sentence claims a fact that is not one. Lane B kept the verbatim copy per the rule and asked
whether a hedged "if that number has an account…" posture should win.

**Decision: the drawn sentence stands.** "Keep the copy verbatim" binds precisely here — both
languages exist drawn, and replacing designed bilingual copy with a hedge we drafted is the
paraphrase rule's clearest violation, not an exception to it. The privacy property does not
depend on the sentence: Lane B made it structural (a void return type, a refusal union with no
phone-existence member, one unconditional render), so the copy is presentation over an already-
sealed channel. And the sentence addresses *"your registered number"* — for the person who has
no account, the referent is empty rather than false in any way that leaks.

**What would reverse it:** the native-speaker review or counsel wanting hedged copy — a
one-string ruling for the client, on the worksheet where the AR review already lives. The
tension is recorded in `copy/types.ts` at the string itself, so nobody has to rediscover it.

### Erasure scope: bookings stay as tombstoned history, support tickets go entirely

Two of Lane A's erasure flags were mine to rule on; both rulings keep what it built.

**"Appointment history" is de-identified, not deleted.** Policy §2 lists appointment history
apart from transaction history, and a strict §5 reading calls it "the rest of your account
data". But a booking row is **deposit money's paper trail** — `deposit_held →
completed / no_show_returned / cancelled` is where an escrowed deposit's story lives, and
non-negotiables #1/#3 do not stop applying because the customer left. A booking pointing at a
tombstone identifies nobody: the row says *a* deleted account held a slot and a deposit moved,
which is exactly what a salon's books and a dispute need and nothing more. Deleting the rows
would erase the salon's side of a money event to serve a reading the policy does not compel.
**Reversal:** if counsel reads §5 the other way, the erasure service gains one DELETE with the
FK consequences argued at the migration — but it should carry a decision from the client, not a
guess from us.

**Support tickets: the full delete stands, salon-routed included.** Her tickets are her own
correspondence — the clearest possible "rest of your account data" — and a ticket's operational
value to a salon is *derived from* the customer relationship that erasure ends. Keeping
salon-routed tickets would preserve her words under a tombstone that was supposed to stop
identifying her; free text is where names, phones and addresses actually live, and no sweep can
prove a scrub of prose. **Reversal:** narrow the DELETE to platform-routed rows — one predicate
— if the client wants salon dispute-history retained, at which point the retained tickets join
`retainedBeyondErasure` so the residue stays measured.

**The other two flags are genuinely not ours** and are queued as #11 and #12: the
audit/consent PII that erasure structurally cannot reach (policy §5 vs §7, and the fix needs
privileges `avo_app` deliberately lacks), and whether the deletion *request* should refuse when
money is in motion. Both ship safe behaviour while they wait — the audit gap is measured on
every run, and money in motion defers rather than erases.

### The commission flats stay editable at the endpoint, read-only on the screen

**The question Lane C queued.** `commissionFor(amount, 'card')` is a percentage **plus a
50-fils flat**, and the design draws one stepper at 2.5% and no flat control — so an owner
reading the drawn console would predict 500 fils on a 20.000 KD card top-up where the server
records 550. The design understates AVO's own commission. Lane C stated the flat **read-only**
on the card rather than inventing a stepper the design never drew, and asked: does the card get
a control, or does the endpoint stop accepting the field?

**Decision: neither. Keep exactly what Lane C built.** The endpoint keeps accepting the flat
fields; the screen keeps stating them read-only.

- **Refusing the field protects nobody.** The write is behind `requirePlatform` with the
  `controls` section — this is AVO's own console, and the flat demonstrably prices every top-up
  (Lane C drove the same top-up to 550 then 650 across a rate change). Making it immutable at
  the API would mean a schema migration to change a fee component, which converts a settings
  edit into a deploy.
- **Drawing a stepper invents a control the design refused**, and "do not add features" binds.
  The read-only statement fixes the *understatement* — the defect — without inventing UI.
- **The drawn design is wrong about the fee, and that is recorded, not silently corrected.**
  One stepper cannot express `percent + flat`. If the client wants the flat adjustable from the
  screen, that is a design change with a drawing, not a gap-fill.

**Reversal.** To freeze the flats: remove them from the PATCH allow-list (one array in
`api/src/routes/platformConsole.ts`) — Lane D's settings suite asserts the row, so the change
shows up as a failing spec naming the field, which is the correct alarm.

### `git diff dev HEAD` shows somebody else's tree — the merge-base lesson

Lane C's post-slice self-check briefly looked like a column breach: `git diff dev HEAD` listed
`apps/wallet` files. It was a **tree comparison** against a `dev` that had moved 14 commits —
Lane B's merged work *missing from the branch*, not the branch's edits. The honest question is
`git diff $(git merge-base dev HEAD)..HEAD`, which answered `apps/dashboard/` + `packages/ui/`
only.

Same family as the replayed-turbo-log lesson, and trunk hit the identical false alarm twice this
session while checking lanes' column discipline (both times the "breach" was dev's own merges
missing from a behind branch). **The tool showed somebody else's tree.** Now in `LANES.md` next
to the build-freshness rules, since column self-checks are in every brief.

### Reports has no permission chip — the interim rule errs restrictive, and the product question is queued

**The gap Lane A found and correctly refused to close alone.** The design draws **nine**
permission chips and Reports is not one of them. `StaffPermsSchema` lives in trunk-owned
`packages/types`, so a tenth is a four-way break — reported, not taken.

**The interim rule, which I am keeping: a report inherits the permission of the section it
exports.** `customers`→`team`, `sales`→`dashboard`, `best-selling-services`→`appointments`,
`products-sold`→`shop`.

**Why the obvious answer was the dangerous one.** A blanket `dashboard` gate looks natural —
Reports sits next to Overview — and it would have handed **every front-desk tablet every
customer's name, phone number and wallet balance.** Lane A proved it with that exact shape:
`dashboard` on, `team` off → `sales` 200, `customers` 403. The seeded frontdesk (Hessa, `ST-002`)
holds neither, so this is a constructed case rather than a shipped one, but the direction of the
argument is what matters: **customer PII must not ride on the weakest gate a screen happens to
sit behind.**

**Where the mapping is imperfect, said plainly.** I checked what `team` actually gates today:
`/staff`, `/staff/{id}`, the password reset, and `/salons/{id}/artists` — **staff and artists,
not customers.** And `loyalty`, the other candidate, gates salon settings and branches. So
**none of the nine is a customer-data permission**, and `customers`→`team` is not a semantic fit;
it is the most administrative gate available, chosen because erring toward restriction is the
correct direction to err when the right answer does not exist yet. Anyone reading this later
should know it was picked for its strictness, not its meaning.

**Queued for Aftab as #9**, because the real question is not schema: **who in a salon may export
customer PII?** That is a product and privacy call about the client's own customers. The interim
rule means nothing ships open while it waits.

**Reversal.** One constant, `REPORT_PERMISSION` in `api/src/services/reports.ts`, with a unit
test that asserts the map — including `customers === 'team'` and explicitly `!== 'dashboard'`, so
a future widening cannot be silent. If a tenth permission is granted, it lands on `dev` in
`packages/types` first and every lane rebases, per `CLAUDE.md`.

### `money-check` was passing because it audited nothing — the skill is fixed

**What.** Lane A ran `.claude/skills/money-check` over the Reports slice and every grep came back
clean. **The slice was three new files, and `git diff` does not show untracked files** — so the
audit inspected an empty diff and reported no findings. Re-run after `git add -N`, it produced a
real hit (a `Number(raw)` at the money cell, judged safe because it feeds `formatFils(fils(v))`
and `fils()` throws on a float, asserted by a test).

**Why this is the session's signature failure, for the third time.** A check satisfied by looking
at nothing: the `rst_` sweep that matched "fi**rst**" because `_` is a `LIKE` wildcard, the
`--include=*.ts` that zsh ate so a grep never searched the files it named, and now a money audit
over an empty diff. **This build already recorded the same trap in the lane-preservation step** —
`git diff` misses new files, which is why preserving a dirty worktree needs a tarball as well as a
patch — and it still bit, because the knowledge lived in `STATUS.md` and the instruction lived in
a skill.

**Fixed at the instruction**, not in a report nobody re-reads: `money-check` now stages intent
first. The same correction applies to any skill that reasons over `git diff`.

**Reversal.** Trivial — it is one added step. The generalisation is not reversible and should not
be: **a check that can pass by examining nothing must prove it examined something.**

### `loadFailure.ts` does NOT move to a shared package — held, with the reversal named

**The question, held open by Lane B rather than answered inside a lane, correctly.** After
building `apps/wallet/src/domain/loadFailure.ts` — the pure error-kind mapper whose absence let
two defects ship — Lane B needed the same logic in the scanner and stopped: the scanner has its
**own** `ApiError` and `FailureKind`, there are no cross-app relative imports anywhere today, and
`apps/scanner/tsconfig.json` includes only its own files. Sharing it means a new shared package,
which `CLAUDE.md` makes a trunk conversation. It built the scanner fix in the scanner's own idiom
and left the move to me.

**Decision: do not move it. The duplication is cheaper than the coupling, for now.**

1. **The taxonomies are genuinely different, not accidentally so.** The wallet's kinds are
   `forbidden` / `offline` / `server`; the scanner's carry `not_an_artist`, two distinct 409s and
   a PIN-scope class. A shared type would have to be the **union**, which makes each app handle
   kinds it cannot produce — and a branch that cannot fire is the dead code Lane B just declined
   to write when it refused my 403-on-`BookingsScreen` instruction.
2. **The evidence for sharing is two small modules, and the cost is the build graph.** A new
   package means tsconfig references, turbo edges and a build ordering that all four surfaces
   inherit. This build has already lost a session to a missing turbo dependency edge and another
   to `packages/types/dist` being stale.
3. **Nothing is blocked by the duplication.** Both surfaces now branch correctly and both are
   spec-covered.

**What made this decidable rather than a coin flip:** the shared thing would be the *type*, and
the types genuinely differ. Where the two apps agreed — one **sentence** — the shared artefact is
the copy string, and that is already shared by decision rather than by import.

**Reversal, and the trigger to watch for.** Move it when a **third** surface needs the same
mapping, or when the two taxonomies converge to the same union in practice. At that point the
shared package is `packages/…` with the union type, and both apps narrow from it. If the wallet
and scanner error shapes are ever unified upstream in the API's error envelope, that is the same
trigger arriving from the other direction.

**Not a licence to duplicate generally.** `CLAUDE.md`'s rule stands: a component that genuinely
belongs to both moves to a shared package. This is the narrower finding that *this* module does
not yet genuinely belong to both, because what it encodes is per-surface.

### A status code is not evidence about which guard answered — a new trap, from Lane C

**What.** Lane C built the console's reset-link button and its first call returned **404**. The
obvious reading is that the removed-admin guard fired. It had not: the body was
`not_found` / *"No such endpoint."* — a **stale pre-rebase API binary** that did not have the
route at all — rather than `unknown_admin` / *"No such console admin."*

**Both directions of the error are bad, which is what makes it worth naming.** Reading only the
status would have either filed a working client as broken, or — worse, and the direction that
ships — **filed the removed-admin guard as verified when the route was merely absent.** A
guard that does not exist and a guard that fires produce the same three digits.

**The rule:** assert on the **error code and the state**, never on the status alone. This build
already holds two neighbouring versions of this — *"a check that matches a string rather than
the thing is not a check"* and *"assert the system refused, never that nothing changed"* — and
this is the third: **a status is a class of answer, not an identification of the answerer.** It
bites hardest exactly where a lane is verifying a *new* endpoint, because that is when "the
route is missing" and "the route refused me" are both live hypotheses.

**Two more from the same report, kept for the same reason.**

**A check satisfied by the wrong branch.** Lane C's first self-removal assertion passed — through
the **owner-not-editable** path, not the self-removal guard. It noticed and re-ran as a
non-owner. Same family as the order path's two `invalid_products` guards and the charge path's
two concurrency guards: **when two guards can answer, a passing check does not tell you which
one did.** Lane A independently applied the same discipline this session, isolating the
deactivation guard by un-spending a link by hand.

**An unreachable state driven anyway.** The Admins empty state is not merely unlikely but
**unreachable against the real API** — a successful `GET` is gated on the caller's own row, so
any 200 implies at least one item. Lane C built it and drove it against a real empty envelope
over the wire, rather than deleting it as dead or faking a fixture. Correct: the state is
reachable through an API change, and a screen without its four states is not done.

**Reversal.** Nothing to reverse — these are method, not code. They belong with the trap list in
`STATUS.md`, and the checks they imply are Lane D's to encode where they touch an endpoint.

### The offline cold-load sentence — inventing it is AUTHORISED, and marked, because the bundle's one offline string would lie

**The wall Lane B stopped at, correctly.** Two screens still assert our fault when the phone
is simply offline: `FailureScreen` branches only on `forbidden`, so a cold offline load on Shop
or Book says *"We couldn't load your wallet … This is on our side."*, and
`apps/scanner/src/screens/BookingsScreen.tsx:64-73` discards `err.kind` exactly as `useShop`
did, routing everything but `not_an_artist` into an `ErrorState` that always offers a retry — so
a 403 gets a retry it cannot use, when the scanner already has `Refusal` built for that.

Lane B did not fix them, because both need a sentence the bundle does not contain. The only
customer offline string is `offlineBanner: 'No connection · showing your last update'`, verbatim
from `AVO States.dc.html` — and that is a **stale-data** sentence. On a cold load there is no
last update, so it would be a lie. Lane B declined to write a third invented string on its own
authority, noting `signInOffline` and `signUpOffline` are already marked INVENTED for exactly
this reason.

**Decision: invent it. EN for both apps, AR for the wallet only.** Marked `INVENTED` and added
to `AR_GAPS` so it reaches the native-speaker worksheet, following the precedent those two
strings already set. The scanner needs no Arabic — `design/README.md` § Known gaps 1 decides the
staff scanner ships English-only.

**Why authorise rather than hold.** "Keep the copy verbatim" governs copy that **exists**; it
cannot govern a sentence the bundle never wrote. Holding leaves a screen that tells a customer
with no signal that AVO has failed, and offers her a Try again that cannot succeed — a false
statement about whose fault it is, shipped, versus an unreviewed true one. The build already
chose the second twice and marked its work. Consistency with that beats a third answer.

**The distinction that keeps this narrow:** the offline state is *product* copy, and inventing
it is a marked, reversible, one-string decision. **Non-negotiable #10 is untouched — the
customer app still holds no legal copy**, renders the published policy set from the API, and
stamps the version. Inventing a connectivity sentence is not inventing a term.

**Reversal.** One string per language, all `INVENTED`-marked and listed in `AR_GAPS`. When the
native-speaker review lands, the reviewer replaces them; if the client would rather write them,
delete and re-render from the bundle. Routed back to Lane B.

### A replayed turbo log names whichever worktree first populated the hash — third instance, now generalised

**What.** Lane B saw `@avo/dashboard:typecheck: cache hit, replaying logs` print the path
`~/dev/avo-api/apps/dashboard` — **Lane A's** worktree — from Lane B's own shell. It forced cold
and got 11/11, every task correctly under `~/dev/avo-wallet/`.

**This is not a new defect.** It is the same mechanism already recorded and closed under "The
turbo cache is shared across all five worktreesa — RESOLVED": each lane's `.git` is a file
pointing into `~/dev/avo/.git/worktrees/<name>`, so turbo resolves the repository root through
the shared git dir and **every lane writes into trunk's single cache**. Not a key defect; the
input sets were proven exact.

**What is new, and worth writing down, is the reading rule.** Lane B's generalisation:
**the path in a replayed log is whichever worktree first populated that hash, so it is never
evidence about the tree you are standing in.** Three lanes have now been briefly misled by a
replayed path, and one of them (Lane C) previously drew a *wrong conclusion from a true
observation* on the same class of staleness.

So a replayed log is not merely weak evidence about your tree — **its paths are affirmatively
about somebody else's.** Added to `LANES.md` § "Build freshness", where the briefs point.

**Not adopted, again:** a standing `--force`. It costs seconds on every run, and treating a
working cache as broken is how the next genuine anomaly gets waved through as normal. The
existing rule stands: tree changed, trust the cold run; same tree needing independent
confirmation, `--force`, because a replay is not a second opinion.

### A reset redemption can be driven end to end with no production test hook — routed to Lane D

**The question Lane A raised, correctly.** Nobody has ever driven a password-reset redemption
end to end, staff or console. The raw token is stored **only** as a sha256 and returned by no
endpoint — which is non-negotiable #6 working exactly as intended — and no sender is wired, so
`e2e/configuration.test.ts` stops at the `202`. Lane A stood in for delivery by hand, then
asked whether a test hook was needed, noting one would have to live outside `api/`.

**My answer: no hook, and nothing in `api/` changes.** The pieces are already there.
`e2e/support/tenancy-harness.ts` shells out to the real `avo-postgres` container, and
`hashPasswordResetToken` is a plain sha256 **hex digest** of the raw token
(`api/src/auth/tokens.ts`). So a spec can:

1. mint its own token locally — any string; `randomBytes` keeps it honest;
2. compute the sha256 hex **in the spec**, with node's `crypto`, importing nothing from
   `api/src`;
3. `UPDATE platform_admin_password_reset SET token_hash = …` for the row the real issue
   endpoint created — **this is the delivery step, and only the delivery step**;
4. POST the raw token to the real `POST /auth/platform/password-reset`.

Everything the endpoint does — the hash lookup, the `used_at IS NULL` conditional spend, the
argon2id write, the session revocation, the refusals — is exercised for real. Only the
messenger is simulated, which is the one part that is genuinely blocked on a client escalation
(WhatsApp templates, sending domain).

**Why this is not the "test hook that becomes a back door".** A production endpoint that
returned the token would be a #6 violation living permanently in the codebase to serve a test,
and the reason `passwordSet: boolean` exists instead of any password field. Writing a row from a
test does not weaken the product, because the test's privileges are the database's, not the
API's — and Lane D already holds those to assert tenancy.

**The one coupling, and why it is a feature.** The spec must know the algorithm is sha256-hex.
If the API ever changed it, the spec would fail loudly. That is the correct alarm, not
brittleness — a credential-hashing change nobody noticed is precisely what should break a build.

**Reversal.** If a real sender lands, the delivery step is replaced by reading the outbox
instead of stamping it, and steps 1–2 disappear. Note the sender will have to receive the raw
token **at mint time**, from the issue endpoint's own memory — it cannot recover one from the
table, by design. Worth knowing before anyone designs that worker.

### Three orphaned lane API servers were still writing to lane databases — killed by PID

**What.** Picking up a session whose four lane agents had died, I found five leaked processes
with no live parent, ~3 hours old: API servers on ports 4100 (`avo-wallet`), 4101 (`avo-api`)
and 4300 (`avo-web`), a Vite on 5300, and an Expo on 8090. `pg_stat_activity` confirmed the
first three held **live connections to `avo_lane_a`, `avo_lane_b` and `avo_lane_c`** — the exact
shape `LANES.md` § Ports and processes warns about, where a leaked server kept polling
`receipt_job` against a database another lane was asserting against.

**Why it mattered before dispatch, not after.** Three fresh lanes were about to reset those
same databases and assert against them. A server holding a connection and writing on a timer
turns another lane's clean reset into a race it cannot see, and it would have read as flakiness.

**How.** `kill` by **explicit PID**, parents then children, then `kill -9` only for survivors.
Not `pkill -f` — the process table is shared by five worktrees and an unscoped pattern kill has
already destroyed one lane's suite for an hour in this build. I left the unrelated `pulsse_cpu`
container and the MCP servers alone.

**Verified by observation, not by the kill's own output**, per the rule that a cleanup which
reports success while leaving the process alive is the same defect as a green typecheck bought
with a cast: a `ps` sweep, a port scan and a `pg_stat_activity` count, **all three empty**.

**Reversal.** Nothing to reverse — no state was written. Restarting any of them is one command
per lane, and each lane starts its own on its own assigned port now (A 4110, B 4120/8100,
C 4130/5310).

### The handoff was as stale as the comments it warned about

**What.** The session handoff named resume points for all four lanes. Checked against `dev`
before dispatching, **most had already landed**: `0032_platform_settings.sql` committed, all
three platform endpoints built in `routes/platformConsole.ts`, `policies_not_published` → 409
built, `Approvals.tsx` merged, both `invalid_products` guards built in `services/order.ts`, and
the near-duplicate charge guard already asserted in `e2e/scanner.test.ts`. The lane branches
told the same story: all four were **behind `dev` with nothing unique**, so the previous session
had integrated everything before it ended.

**Why it is worth an entry.** This build already has a documented trap — nine stale "not built"
comments in `api/src/routes`, and the rule *never trust a comment, grep the routes*. A handoff
document is the same object: prose about code, written at a moment, aging independently of it.
Had I dispatched the handoff's queue verbatim, four lanes would have rebuilt landed work, and
the reports would have looked like success.

**What I did instead.** Grepped the route registrations and the branch topology first, then
wrote each brief against what the tree actually contained. The genuine remainder was much
smaller and sharper than the queue: one missing endpoint half (the console reset's **redeem**
side, which is why an invited admin still cannot sign in), one unhandled API response in the
wallet, one section to verify and commit, and one guard to prove reachable alone.

**Reversal.** None needed. The durable fix is the note now at the top of `STATUS.md` § CURRENT
STATE: re-measure before believing it, including that line.

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

### The turbo cache is shared across all five worktrees — RESOLVED

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

**RESOLVED — it was not a cache defect.** **Trunk holds the only turbo cache.** `.turbo/cache`
in `~/dev/avo` has 84 entries; none of `avo-api`, `avo-wallet`, `avo-web` or `avo-qa` has a
cache directory at all. Each lane's `.git` is a file pointing into
`~/dev/avo/.git/worktrees/<name>`, so turbo resolves the repository root through the shared
git dir and writes every lane's entries into trunk's cache.

The trail, captured on the second occurrence: `@avo/dashboard#typecheck` hashed to
`3ea15262fe96380e` with status `HIT`, and that entry's `.tar.zst` was written at **14:43:51** —
while lane C was verifying content it committed at 14:48:50, and thirteen minutes before trunk
merged it at 14:57:01. Trunk ran no typecheck at 14:43:51. Both occurrences were lane C
merges, and lane C is also the lane that disclosed its `--filter` runs executing inside
trunk's worktree.

**Not a correctness problem.** The key is content-derived, complete and responsive, so a hit
returns a result computed from identical content: a cached green is a real green. What it costs
is **independence** — trunk's post-merge gate can be satisfied by the lane's own earlier run of
that same tree. Sound verdict, not a second opinion. Which is exactly why the rule in
`LANES.md` reads "same tree needing independent confirmation → `--force`" rather than "distrust
the cache"; that distinction turned out to be load-bearing. `b05e36a` was confirmed that way:
0 cached, 8.79s, green.

**If a cache anomaly recurs elsewhere:** capture the full `turbo run typecheck` output *and* a
`--dry=json` from the same tree before doing anything else — the hash plus cache status per
task is the artifact that settles it, and `.turbo/runs` does not exist so there is no summary
to recover afterwards. Then check the entry's mtime against what each worktree was doing at
that moment, which is what closed this one. Note that `--force` rewrites entries it just hit,
so an mtime alone cannot separate "written cold" from "rewritten by force".

### Idempotency protects the attempt, not the recovery — the double-charge path

**What.** A parse failure on a *successful* `POST /charges` produces a customer debited twice,
and no idempotency test can catch it. The chain, all of it working as designed:

1. `POST /charges` succeeds — token consumed, wallet debited, stamp incremented, receipt queued.
2. The response fails `ChargeResultSchema` (`apps/scanner/src/api/charges.ts:48`, which embeds
   `TransactionSchema`). The scanner shows a failure for a charge that landed.
3. Staff reach for `onRescan` — `setScreen({ name: 'scan' })`, `ScannerFlow.tsx:209` — which
   unmounts `MemberScreen`. Returning re-runs `useRef(newIdempotencyKey())` at
   `MemberScreen.tsx:79` and mints a **new key**.
4. The customer's app mints a **fresh token**; the spent one is gone.
5. Fresh basket, fresh key, fresh token — a second real charge.

**Why no test catches it.** The server behaved correctly both times. Nothing is a replay and
nothing is a duplicate submit, so every idempotency and concurrency spec passes. The defect is
a parse failure on a successful write, and **the idempotency protection ends at exactly the
attempt boundary the recovery path crosses.** `attemptKey` is reminted only in `toggle`, which
is right for the reason its comment gives — the API treats a same-key-different-body as a 409
rather than a replay — and that reasoning is untouched by this.

**The instance is closed** (`509cbda` routes both money POSTs through
`serialiseTransactionForCustomer`; both contract specs pass). **The shape is not.** Any charge
whose response the client cannot read — parse failure, timeout, dropped connection — has it.

**Standing rules, until something better exists:**

- **No retry affordance on a charge error state.** A client that could not read the response
  cannot know whether the money moved, so a "Try again" button makes the double-charge path one
  tap instead of a rescan. What belongs there is an instruction to **check the customer's
  balance first** — her balance is the only reliable evidence the debit landed.
- **Validate a money response against the CLIENT's own schema** when changing a serialiser, not
  against the API's shape or the shared types in isolation. `ChargeResultSchema` is local to the
  scanner, and it is the boundary this drift crossed — checking it is what would have caught the
  bug at the moment the same fix was applied one endpoint over.

**To reverse / improve:** the durable fix is for recovery to re-resolve the member and show her
**current** balance, so staff see a debit that already happened rather than guessing.
`GET /members/{id}` returns the same envelope as `POST /scans`, so it is cheap. That is a lane B
decision and has been reported, not imposed.

### A server-side near-duplicate charge guard — HELD, for the reason the ceiling taught us

**What.** The double-charge shape recorded above has **no API-side defence**. Idempotency is
the only duplicate guard on `POST /charges`, and it is keyed on
`hashRequestBody({ memberId, serviceIds, token })` plus a client-supplied key. A fresh key with
a fresh token is a genuinely new charge — which is exactly why the server is correct both times
and no idempotency or concurrency spec can see it. Lane A verified that rather than assuming it,
named it as the only unblocked-in-principle work left in `api/`, and did not start it.

**Held, and the deciding reason is lane A's own lesson from tonight.** There is no measurement
of how often a legitimate same-member, same-basket charge happens inside a short window. Any
threshold picked without one has precisely the failure mode of the 60-per-hour lookup ceiling:
a control that fires on real work at a counter with a customer standing there. That ceiling
turned out to refuse at **twelve customers an hour**, and it was defended with plausible
arithmetic until someone measured. Two identical services back to back is a legitimate charge.

**And a flag cannot work, which forces the harder version.** The triggering condition is a
response the client could not read — so a warning field in the response arrives after the money
has moved. A guard that actually prevents the second debit must **refuse before debiting**,
which means a refusal real staff will hit legitimately, which is what makes the window, the
default, and refuse-versus-confirm product decisions rather than an API call.

**It is also not an `api/` change.** A refusal needs a confirm affordance in the scanner with
copy in both languages, so it is a coordinated lane A + lane B slice.

**Why holding is defensible rather than lazy.** The instance is closed (`509cbda`), the
contract-drift guard that would catch its return runs in CI, and the two client-side rules are
recorded above: no retry affordance on a charge error state, and validate a money response
against the client's own schema.

**To unblock:** either a measurement of legitimate same-basket repeat frequency from real pilot
traffic, or a product decision on the window and whether it refuses or requires confirmation.
The second is faster and is the kind of call that belongs to whoever owns what a salon counter
should do — it is in "Queued for Aftab" for that reason.

### Member signup — the shape, decided and specified before it is built

Signup does not exist (`auth.ts` has session, refresh, sign-out, staff password-reset and no
registration), so non-negotiable #10 — *store the accepted version against the member* — is
unmet for want of a moment at which acceptance happens. The design specifies self-serve:
`Your name`, `Phone`, `Password`, a required consent checkbox, and a **separate** WhatsApp
checkbox (`design/README.md:107`/`:113`).

**Acceptance is an event, not a column.** Migration `0020`'s own comment predicted this use —
*"the next one is already visible: non-negotiable #10's acceptance of a NEW policy version is
the same shape of fact"* — and `member_consent_source_is_known` **already permits `'signup'`**,
which is a second confirmation from the enum rather than the comment. `member_consent_kind_is_known`
is `CHECK (kind = 'marketing_offers')`, so widening it to add policy acceptance is the migration.
`member.policyVersion` stays as the cached current value, exactly as the `offers` boolean relates
to its event stream.

**The client sends the version it displayed; the server refuses `policy_version_stale` if that is
not the currently published one.** So she can only accept what she was shown. A server stamping
"whatever is current" would satisfy the letter of #10 while reproducing precisely what
`design/README.md` gap 5 warns against — *"do not rely on 'they agreed to whatever is current'."*
The refusal is a **renderable client state**, not an edge case: a publish landing between render
and submit is the ordinary race, and it must read as "the terms changed, here they are again".

**Signup writes NO marketing consent event — not even `granted: false`.** I had assumed the
signup WhatsApp opt-in was the `offers` marketing field with a second entry point. It is not, and
the copy proves it verbatim: `consentWa` is *"Send me receipts and appointment confirmations on
WhatsApp"*, which is **word-for-word** `nWaSub`, the **service** channel — while `nOffersSub` is
*"Occasional promotions from Amara. Off by default."* There are four `consent*` keys in the copy
and none mentions offers. So **marketing has no signup entry point at all**, which matches 0020's
rule that consent is never a default. And a `granted: false` row would be worse than nothing:
0020 is explicit that *"`granted = false` is a withdrawal event, not the absence of a grant"* —
recording a withdrawal she never made puts a false fact in an append-only table.

**`notify_wa` must be written explicitly, and an absent value is a client bug.** It is
`NOT NULL DEFAULT true` (`0020:50`) because service channels default on — but signup presents it
as a checkbox she can leave unticked. If the payload omits `wa`, the column default makes it
**true, the opposite of what she chose.** That is the same shape as the `passwordSet` substring
match and the stale "not built" comments: an absence read as agreement.

**To reverse:** if signup ever becomes staff-operated in-salon rather than self-serve, the
acceptance event's `source` changes and the `policy_version_stale` race mostly disappears — but
the event-not-column decision holds regardless, because re-prompting on a material change needs
history and a column cannot answer it.

### Wallet sign-in identity: phone, not the username the design draws

**What.** `design/AVO Login.dc.html:100` draws a **Username** field, placeholder `dana.k`, in both
languages, and its signup collects no phone at all. Built with **phone** instead.

**Why, and it is not a close call.** The design contradicts **itself**: `AVO Wallet Home.dc.html:1187`
and `:1294` say, in both languages, *"Your phone number is how you log in."* Every other source
agrees — `api-contract.md:76` and rule 1 at `:95` make phone the login identity, and
`routes/auth.ts:81` takes `{ salonId, phone, password }`. And there is **no member username
anywhere**: no column, no `MemberSchema` field. Rule 1 is load-bearing rather than incidental — it
is the reason `PATCH /members/me` must *reject* a phone.

When a design contradicts itself and every other source agrees, the other sources win. Inventing a
username column to satisfy one drawn field would have been a schema and contract change made to
match a mock-up against its own copy.

**Two design links deliberately not built:** "Forgot password?" — there is no member reset
endpoint, `/auth/staff/password-reset` is staff-only — and "New here? Create account", pending the
signup endpoint specified above.

**To reverse:** if usernames are genuinely wanted, they are a `member` column, a `MemberSchema`
field, a uniqueness decision per salon, and a change to rule 1 — not a client edit.

### The wallet's refresh token is recoverable from an unlocked handset — authorised fix, held

**What.** The access token is memory-only; the refresh token is persisted, and on web that is
`localStorage`. Lane B stated plainly that this is not secure and not solved, with server-side
revocation on sign-out as the mitigation rather than a fix. `expo-secure-store` is neither a
dependency nor available on the web target.

**Decided: yes, use a real secret store on native — and not in this slice.** Adding a dependency
edits the shared lockfile, and a shared-lockfile change while three other lanes have work in flight
breaks `pnpm install` in four worktrees at once. It gets its own slice after `main` tracks `dev`.

**Residual risk until then, stated rather than buried:** an unlocked handset yields a refresh token
that survives until it expires or is revoked. Two things bound it — sign-out revokes server-side
(verified: `REVOKED`, `revoked_reason: sign_out`), and the access token is memory-only so a cold
start must refresh. **An offline sign-out cannot revoke**, so the local clear is unconditional and
the session stays alive server-side until expiry; that is the honest gap.

**To reverse / complete:** `expo-secure-store` on native with the web path unchanged, since the web
target is development and demo rather than a customer surface.

### Defence in depth hides the absence of its own layers — three instances, one method

**What.** Three times tonight a guard was removed and **every relevant spec stayed green**, because
a second independent guard covered it. Each time the first instinct — "the spec is weak" — was
wrong, or at least incomplete.

| path | guards | what one removal proved |
|---|---|---|
| `POST /charges` race | wallet `FOR UPDATE` + token conditional consumption | nothing; both had to go before five concurrent charges all settled at `balanceAfterFils: 493000` |
| no-show return job | candidate scan predicate + status re-check under the row lock | nothing; both had to go for a double payout, `expected 202000 to be 192000` — a customer refunded for a visit she attended |
| the same job, concurrently | — | with **only** the re-check removed, two simultaneous passes both reported `returned: 1` while all four sequential specs stayed green |

**The method, in lane D's words:** *when a break does not fail a spec, the useful question is not
"is the spec weak" but "how many guards are there".* A single-guard removal that changes nothing is
evidence about the **design**, not only about the test — and it is good news worth recording rather
than a dead end.

**But the corollary is the sharp end.** The no-show job's own comment calls the status re-check
*"the single line that makes the job idempotent"*, and **no sequential spec could reach it**: by the
second pass the settled row is no longer a candidate, so "run it twice" proves the scan's
idempotence, not the re-check's. A layer nothing can reach is a layer nobody will notice
disappearing. Reaching it required two passes launched together, both scanning before either commits
— which needed `runApiDbScriptAsync` in the harness, because `execFileSync` makes two sequential
runs trivial and two simultaneous runs impossible.

**How to apply.** When testing a guarantee with more than one guard, break each layer **alone** and
record what still passes. If nothing fails, either a spec is missing that isolates that layer, or the
layer is redundant — and which of those it is matters, because the first is a coverage gap and the
second is a design question. Do not conclude from a passing suite that a layer works.

**Cost, recorded because it is the first change tonight with a measurable one:** the five job specs
each spawn a real `tsx` process, two of them concurrently, at roughly three seconds each. The suite
went from 3:51 for 511 specs to 4:07 and 4:10 for 516. Worth it for a money path that had never
executed, and flagged rather than absorbed.

### Five calls made without asking, to keep the run moving

Aftab: *"Make decisions that you think are right, do not ask me anything. If you can't move
forward without asking, leave that task."* These are the open ones, decided.

**1. `TRUST_PROXY` — fail fast in production, default off in development.** `req.ip` became a
security control when the signup limiter shipped, and both silent defaults are wrong: unset puts
every caller behind a proxy in one bucket, `true` lets any client forge its own. So the API
refuses to boot in production with it unset, naming the variable. A deployment that cannot say
what its proxy is has not been configured, and finding that out at boot beats finding it out
from a rate limiter that never fires. Added to `go-live-checklist.md`.

**2. The overnight happy hour stays impossible — for the pilot.** `isHappyHourLive` is
`minutes >= from && minutes < to` and the CHECK is `to > from`, so 23:00–01:00 cannot be
expressed. A Kuwaiti salon open until 1am is a real case, so this is a genuine product gap —
but rule and schema **agree**, so it is a limitation rather than a defect, it blocks no plan
criterion, and fixing it is a `packages/types` change plus a migration plus three consumers,
i.e. a four-way break landed mid-sprint. Deferred deliberately, not overlooked. **To reverse:**
allow `to <= from` to mean "wraps midnight" in both the predicate and the CHECK, together, and
rebase every lane.

**3. Near-duplicate charge: refuse, name the prior charge, require an explicit confirm.** Queue
item 8. A second charge for the same member and the same basket inside **120 seconds** answers
`possible_duplicate` carrying the earlier transaction, and proceeds only with an explicit
confirm flag. A flag-after-the-fact cannot work — the triggering condition is a response the
client could not read, so a warning arrives after the money moved. Two identical services back
to back is legitimate, so this costs one extra tap in a rare case to prevent a double debit in
a case we have already traced end to end. 120s because a genuine repeat is a separate visit.

**4. Show the returned deposit.** A 5.000 hold meeting a 3.000 basket returns 2.000 with
nothing on screen explaining the balance move. `deposit_return` copy already exists in both
languages (`en.ts:194`, `ar.ts:244`) with a receipt branch, so this is wiring existing copy
rather than inventing design.

**5. `expo-secure-store` on native: yes, and it is now safe to land.** It was held because a
shared-lockfile edit breaks `pnpm install` in four worktrees at once. It goes in as its own
slice with every lane rebasing immediately after, rather than waiting for a quieter moment that
does not arrive.

**Left undecided on purpose, because they are not mine:** CBK licensing, who holds the customer's
balance if MyFatoorah pays the salon at top-up, counsel and PSP sign-off, data residency, support
staffing, the Arabic native-speaker review, and whether signup needs a verification step to close
the enumeration oracle. Each is queued above.

---

### LANES.md misdiagnosed the cross-worktree incident; the cause is cwd, not `--filter`

**Decided in trunk, without asking, during the verification session of 2026-08-25.**

LANES.md § "Every lane isolates its own resources" attributed Lane A's cross-worktree run —
`pnpm --filter @avo/api run start` booting `~/dev/avo-wallet/api` against `avo_lane_b` — to
`--filter` resolving from cwd. I measured it and that diagnosis is incomplete in a way that
matters.

`--filter` resolves **correctly** when cwd genuinely is your worktree root:

```
$ cd /Users/koraspond_developer/dev/avo-wallet && pnpm --filter @avo/mock exec pwd
/Users/koraspond_developer/dev/avo-wallet/packages/mock
```

What is actually broken is that **cwd does not persist between tool calls** — every command
starts in trunk regardless of what a previous command `cd`'d to. So "run from its own worktree"
was never true; the `cd` had happened in an earlier call and the shell had already reset.

**Why the correction is worth making rather than leaving a working rule alone.** If the fault
is pnpm's, `--dir` closes it and the matter ends. It is not, so the same failure reaches every
cwd-dependent command — including `./scripts/lane-db.sh <letter>`, which from a reset cwd runs
*trunk's* copy and, because the script correctly derives `ROOT` from its own location
(`scripts/lane-db.sh:64`), migrates and seeds **trunk's `api/`** against the lane's database.
A correctly written script doing the wrong thing is precisely the failure mode this file exists
to catalogue, and the old diagnosis could not predict it.

It also explains why the rule "kept regressing" — the recorded puzzle in that section. It was
not being forgotten. It was being followed, in a call where cwd had silently reset.

Recorded as a **ninth vector** in LANES.md, with the `--dir` rule kept intact: `--dir=<absolute>`
is immune to this by construction, which makes it the right habit whether or not anyone
remembers the cause. The four root scripts that wrap `--filter` (`package.json:14-17`, which
CLAUDE.md's Commands section tells every lane to run) are left as they are for now — they are
correct from trunk, and rewriting shared tooling while four lanes are mid-run is the kind of
change this project defers to a quiet tree.

**To reverse:** if a future harness makes cwd persist between calls, the ninth-vector section
becomes historical and can be cut back to a line; the `--dir` rule should survive it regardless.
**Still open:** rewriting `package.json:14-17` to use `--dir` with a path derived from the
workspace root, so `pnpm mock` cannot serve trunk's mock to a lane. Queued rather than done,
deliberately — see above.

---

### Two counts everyone was restating, and a sixth worktree nobody counted

**Measured in trunk, 2026-08-25, during the verification session.**

**`AR_GAPS` is 81, not 31 and not 74.** This file's queue item 4 said 31. The verification
handoff said 74. Both were restatements that had aged away from the array. Two independent
methods agree on 81: comment-stripped string-literal extraction, and bracket-matched
comma-splitting with a check that every item is a plain string literal (zero anomalies).

Worth correcting rather than shrugging at, because this number is not decoration — it is the
worksheet for a **paid native-speaker review with a lead time**. Understating it by fifty keys
misprices the engagement and under-schedules it. Corrected in queue item 4, with the measurement
date attached so the next reader knows how old the figure is.

**There is a sixth worktree.** `git worktree list` reports
`/Users/koraspond_developer/dev/avo/.claude/worktrees/youthful-lewin-1e9609`, on branch
`claude/youthful-lewin-1e9609`, left over from an earlier session's isolated agent.

It is **clean and holds nothing** — `git status --porcelain` empty, `git rev-list --count
dev..HEAD` = 0, sitting at the old `dev` tip `1ee49a0`. So no work is at risk either way.

It matters anyway, for one reason: RUNBOOK.md and the handoff both warn that **the turbo cache
is shared across "all five worktrees"**, and that a replayed log's paths name whichever
worktree first populated the hash. There are six. Any reasoning that enumerates five and
concludes "therefore this log must be mine" has an unlisted candidate in it — which is exactly
the shape of error that section exists to prevent.

**Not removed — and the reason got stronger an hour later.** I first recorded it as an abandoned
leftover that was clean and therefore safe to remove, and noted that removing it was a one-liner
Aftab could run. **That was wrong.** `ListAgents` subsequently showed a *live interactive session*
running in that worktree, started 44 minutes before I looked. It is not abandoned; it is someone
else's working tree, and `git worktree remove` on it would have destroyed an active session's
checkout.

Correcting it here rather than quietly editing, because the mistake is instructive and is this
file's own subject: **"clean" is a statement about committed state, not about whether anyone is
using it.** `git status --porcelain` empty and `rev-list --count dev..HEAD` = 0 say nobody has
saved anything yet — which is exactly what an active session looks like before its first commit.
I read an empty tree as an unused one, and they are the same picture. Rule 4 of this document
already forbade the removal; the evidence I offered against it was simply not evidence.

**To reverse either:** re-measure. That is the entire point — both of these were wrong because
they were restated rather than re-measured, and this entry will age the same way.

---

### Aftab authorised all five queued items from the verification session

**2026-08-25.** Items 16–20 were queued because each needed a call he alone could make. He made
it: *"go for all 5."* They are now decided work, not open questions, and the rows are marked so
nobody re-queues them.

Two of the five had been **refused by a lane on purpose**, and that refusal was correct at the
time. Lane B declined to build the enlarged-QR overlay and the happy-hour banner under CLAUDE.md
§ "Do not add features", flagging both instead. The rule says to check `design/README.md`
§ Known gaps first and **ask** — neither was a documented omission, so asking was the right
move, and the answer came back yes. Worth recording because the rule reads like a prohibition
and is actually a routing instruction.

**What each authorisation means in practice, since "go" is not a specification:**

- **#16 rate limits.** The shape was already settled — key on `(salonId, deviceId)`, never
  `req.ip`, a distinct refusal code, constants not env. The threshold was the blocked half, and
  it is *still* unmeasured. Lane A is instructed to pick generous starting values and make the
  reasoning the deliverable: what each number assumes, what it would refuse, how to revise it on
  pilot data. A limiter that never fires in year one can be tightened; one that refuses a paying
  customer at the counter is found out from the salon.
- **#17 social links.** Build the per-link endpoint to match the contract. The contract is the
  specification; the whole-array field was the improvisation.
- **#18 the auth family.** Documented by trunk this session — `api-contract.md` § "Addendum —
  the session layer". Descriptive of what shipped, except three explicit rulings (the workspace
  asymmetry, refresh rotation, and the identical answer for expired and unknown reset tokens).
  **Note the count correction:** eight were absent, not eleven. The member reset pair and
  `POST /members/me/password` were already specified at line 126. I wrote "eleven" first and
  caught it against the file — a fresh overstatement inside the document being corrected for
  overstatements, which is worth writing down rather than quietly fixing.
- **#19 the QR overlay.** Build it, and rebind the control. Refresh must stay reachable and the
  overlay must stay unreachable offline, since the QR is already removed from the DOM there.
- **#20 happy hour.** Render it from `isHappyHourLive`/`minutesRemaining` in the salon's zone —
  never a `live` flag, never the host clock, which is two hours ahead of Kuwait on this machine.
  The overnight window (23:00–01:00) stays inexpressible; that deferral stands with its own
  reversal path.

**To reverse any of them:** they are ordinary work now. Revert the commit. The reasoning above
survives so the next reader knows what was decided rather than assumed.

---

### #38 — this project can now render a component in a test, on two surfaces of three — PARTLY RESOLVED

Acted on rather than queued, because #38 was the one open item marked trunk's call: adding a
renderer is a root-lockfile change touching every surface, so no lane could do it.

**What exists now.** `jsdom` + `@testing-library/react` on the dashboard and the wallet. Tests opt
in per file with a `// @vitest-environment jsdom` docblock; the other ~700 tests keep running under
`node` and pay nothing. The wallet additionally aliases `react-native` → `react-native-web` — the
same surface Expo web already runs — and now collects `.test.tsx`, which it previously did not, so a
render test there would not have failed, it would not have been COLLECTED and the run would have
reported success.

**Three render tests, each proving something no source-text guard could reach.**
`Money` — the drawn glyphs are `aria-hidden` and the accessible name is computed by a different
function, so what a screen reader announces is a different string from what the eye reads; grepping
proves both calls exist, only rendering proves the DOM got the right one on the right node. Red
when `aria-hidden` is removed. `HappyHourBanner` — same props, two system clocks, two renderings,
which is CLAUDE.md's "the happy-hour predicate, never a `live` flag" asserted at the component
rather than at the pure function. Red on a frozen clock, which is exactly what a stored flag would
look like.

**What is still blocked, so nobody rediscovers it.** Anything importing `react-native-qrcode-svg` —
`QrOverlay`, `PaymentCode` — will not load: that package ships JSX inside `.js`, which vite refuses,
and transforming it gets one step further before hitting untranspiled Flow in React Native's own
source via `react-native-svg`. Plain `react-native-web` components render fine, which is how we know
the wall is that dependency chain and not the approach. **So the §4 "no stale payment code on
screen" property still rests on `payTabWiring.test.ts` reading the source** — the single most
valuable render test in this app is the one still not possible. Lane D, with a real budget.

**The scanner has no renderer.** Same argument applies to it; not done, not blocked, just not done.

**One thing I got wrong while doing this**, recorded because the test would otherwise have frozen my
guess into a requirement: I asserted the happy-hour banner renders nothing on a day it does not run.
It renders the NEXT occurrence — a branch plainly present in the component. The test now asserts
that, with the mistake noted in it.

### The wallet outgrew Expo Go, and trunk picked the dependency for the wrong reason

**Decided in trunk, 2026-08-25, with Aftab's standing authorisation to complete both mobile apps.**

Native RTL needs a reload: `I18nManager.forceRTL()` writes a flag Yoga reads at bridge start, so the
running app does not turn around. `i18n/language.tsx` had documented this and deliberately declined
a restart dependency, naming its own trigger — *"when the native build lands"*. The native build
landed this session, so the trigger fired and the restart was wired.

**Trunk told Lane B to use `expo-updates` rather than `react-native-restart`, on the stated grounds
that it works in Expo Go. That reason was wrong.** Lane B disproved it by measurement rather than
argument:

- Adding the dependency made the wallet fail to launch in Expo Go at all —
  `UNIQUE constraint failed: updates.scope_key, updates.commit_time`. Expo Go carries its own
  updates table; `commit_time` has second resolution and `scope_key` is the Metro URL, so two
  relaunches inside one second collide and the app is bricked until the table is cleared.
- `Updates.reloadAsync()` throws in Expo Go and in dev mode.
- And mirroring was never observable there anyway: Expo Go's own preferences show the app writing
  `forceRTL: true` correctly and **Expo Go clearing it at every process launch**.

**The dependency stays; the host changes.** `expo-updates` is the right mechanism for a shipping
native app — `reloadAsync()` is what it exists for. What was wrong was the premise that Expo Go
could host it, and that premise was never survivable: the collision is structural, not a bug. An
app that needs native modules beyond Expo Go's bundle has outgrown Expo Go, which is the ordinary
Expo trajectory. Native verification moves to a development build (`expo run:ios`); `ios/` is
generated and stays uncommitted.

**Why this is recorded rather than quietly amended.** The instruction was wrong in exactly the way
this project keeps paying for — a plausible claim about a tool, asserted rather than run. The lane
ran it. That is the standard, and a reversal that hides its own cause teaches nothing.

**To reverse:** if a future Expo Go stops shipping `expo-updates`, or the app drops its native
modules, Expo Go becomes viable again and the dev-client step can go. Neither is likely.
**Also unblocked by this:** `platform/gateway.ts` declined `expo-web-browser` on the grounds that a
lockfile change was outside a lane's column. That precedent is now broken — the in-app-browser
gateway deviation it records can be revisited, but it needs its own decision, not a drive-by.
