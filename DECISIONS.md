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
| 8 | Should `POST /charges` refuse a near-duplicate — same member, same basket, short window — or only confirm? What window? | The double-charge path has no API-side guard. Picking a threshold without measuring legitimate repeats is how the lookup ceiling came to fire at twelve customers an hour. Needs a call on what a salon counter should do. |
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
| 26 | **`apps/dashboard/src/auth/scopes.ts` carries a ~60-line comment explaining why the owner console is blocked, and every reason in it is now false.** It cites a `Principal` union without a platform member, a missing `platform_admin` table, and an absent session endpoint. All three exist: Lane C signed into the console during the same run that read the comment. | Not a defect — the code works; the explanation is a fossil. But it is the **fifth** instance this session of a file asserting something about the system that stopped being true (console nav gate, wallet `nameAr`, `seed.ts` shop comment, `NotBuiltYet`, and now this), and it is the largest single block of them. Worth deciding whether stale-comment sweeps become a routine gate step rather than something found by accident during demos. Lane C queued it as a chip rather than folding it into an unrelated slice, which was the right call. |
| 27 | **Nothing ever expires an abandoned top-up intent.** `topup_intent` rows created at `created`/`redirected` stay there forever. The `expired` failure reason is declared in the schema and **never written by anything**. Driven by Lane B: five intents accumulated in one session, two permanently stranded at `redirected`, each with a `sandbox_gateway_payment` row behind it. Every abandoned payment, every crashed app, every "choose another method" leaves one. | Not a money defect — a stranded intent credits nothing and the balance is untouched — but it is an unbounded table on the path money enters by, and it makes the reconciliation row in `go-live-checklist.md` ("a daily job matches gateway settlements to `Transaction` rows") harder the longer it runs: the job has to distinguish an abandoned intent from a settlement that never arrived. Needs a reaper with a window, and the window is a product decision — how long may a customer leave a payment page open and still come back to it? `api/` is Lane A's; the number is Aftab's. |
| 28 | **The customer's `Transaction` shape cannot express what she actually paid for a boosted top-up.** `amountFils` is the credit (bonus already inside), `bonusFils` is the **tier** portion only, and `promoBonusFils` is not serialised to the customer at all. Lane B's receipt derives `paid = amountFils − bonusFils`, which is exact today and wrong the moment a branch top-up boost applies — the row would read high. | `packages/types` is trunk-owned and consumed by all four surfaces, so widening it is a four-way rebase, not a lane fix. Two candidate shapes: serialise `promoBonusFils` to the customer, or add an explicit `paidFils` so no client has to reconstruct it by subtraction. The second is the safer one on this project's own evidence — every time a client has recomputed a money figure the API already knew, it has eventually disagreed with it (this session alone: the activity row that added the tier bonus twice and showed +12.000 for an 11.000 credit). |
| 29 | **Should a background job credit a wallet from a gateway read the customer never asked for?** The reaper (#27) now consults the processor before writing `expired`, and when the processor says **succeeded** it refuses to reap and reports the id as `awaitingCredit`. It deliberately does **not** credit. Lane A notes the crediting call would have been one line and declined to write it. | The refusal is right and the reasoning is worth keeping: crediting because a timer noticed is a different act from crediting because she asked, and the blast radius is asymmetric to everything else in that file — the sandbox gateway's `succeeded` default alone would have turned the reaper into an unattended credit machine. But the money **is** owed: a customer paid and the credit never landed. Somebody has to close that loop, and it belongs to the reconciliation slice the go-live checklist already calls for ("a daily job matches gateway settlements to `Transaction` rows"). Needs a ruling on whether that job credits automatically, or raises for a human. |
| 30 | **The payment-gateway seam cannot say "I have never heard of this reference".** `SandboxGateway.fetchPayment` raises `GatewayUnavailableError` both for a reference it never issued and for being down. The reaper cannot tell them apart, so it takes the conservative arm and vetoes the reap — which means the **safest possible reap** (an intent with a reference no processor recognises) is the one it will never perform. | A fifth `PaymentGateway` method separating "unknown reference" from "unreachable" fixes it, and the daily reconciliation job wants the same distinction for the same reason. Small interface change, but it is the gateway contract and touches `myfatoorah.ts` as well as the sandbox — worth doing once, deliberately, rather than twice under pressure. |
| 34 | **The console's Accounts screen draws three controls no endpoint can serve.** The **suspend toggle** — there is no suspension endpoint anywhere for a member, a staff member or a salon. The **customer detail view** — the two writes exist and are gated `accounts`, but no per-account read does, and the wallet-adjust form it contains needs a balance nothing serves. Lane C built neither and rendered the four-state `status` the API already resolves rather than a switch wired to nothing; the banner clause describing the detail view was dropped and the two true clauses kept verbatim. | Three endpoints is a build decision with a cost, not a defect to fix quietly, and suspension in particular is a policy question before it is an API: what a suspended customer sees, whether her balance stays spendable, and whether a suspended salon's staff can still charge. The design draws the control; nobody has said what it does. |
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
