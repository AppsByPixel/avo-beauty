# AVO Beauty — go-live checklist

Every line needs a name against it and a date. Anything unticked is a launch blocker
unless it is explicitly deferred in writing.

## Legal and regulatory — owned by the client

- [ ] CBK position confirmed: does the stored-value wallet require licensing, and under
      whose licence does AVO operate
- [ ] PSP selected, contracted, and named in the wallet terms
- [ ] Counsel sign-off on Terms & conditions, Privacy policy, and the five wallet
      documents, EN **and** AR, recorded in Owner Console → Policies sign-off
- [ ] "Not a bank deposit / not covered by deposit insurance / no interest / no cash
      withdrawal" wording approved as written
- [ ] Data residency decided and implemented; retention schedule documented
- [ ] Data processing agreement between AVO and each salon (the salon is a controller of
      its own customer data)
- [ ] WhatsApp Business templates submitted and approved — all four, EN + AR
- [ ] Support hours and reply-time promise set to something the team can keep

## Money

- [ ] Gateway live credentials, live KNET flow tested with a real card and a real KNET account
- [ ] Reconciliation: a daily job matches gateway settlements to `Transaction` rows and
      alerts on drift
      - Lane D, 2026-08-19 — **nothing implements this.** `api/src/jobs/` contains one file,
        `no-show-once.ts`; there is no reconciliation job, no drift alert and no scheduler.
        Every occurrence of "reconcil*" in `api/src` is a comment in `db/seed.ts` about the
        ledger reconciling to the balance. Lane A's row; there is nothing here to test yet.
- [ ] Idempotency verified under retry for top-ups, charges, orders, voids
      - Lane D, 2026-08-19 — **three of the four are driven and pass. Not ticked because
        `orders` has no endpoint to retry.**
      - Key REQUIRED, refused without one: `money.test.ts` §#4 for `POST /topups`,
        `POST /charges` and `POST /voids` — each asserts `400 idempotency_key_required` and
        that nothing was created or debited.
      - Key HONOURED under retry: `POST /topups` replay returns byte-identical JSON;
        `POST /charges` replay debits once (balance after is the same, not twice down);
        same key + a different body is a `422`, not a replay of the first result, and the
        mutated retry never produces a second larger intent. Two different keys are two
        different charges, so idempotency is per key and not per basket
        (`concurrency.test.ts` § double submit). A double `POST /voids` answers
        `already_voided` rather than `request_in_progress` (`scanner.test.ts`).
      - Gateway retries specifically: `gateway.test.ts` § "a failed gateway leg does not burn
        its idempotency key" — the case where a key is spent on a leg that never moved money.
      - **`orders` cannot be driven:** the shop is not built. `GET /salons/{id}/products`
        returns a hardcoded empty list and there are no order or write endpoints at all
        (`grep "'/orders" api/src/routes` is empty). This row stays unticked on that alone.
        Lane A.
- [x] Concurrency suite green: double scan, double submit, duplicate callback, callback
      before client return, charge during a happy-hour boundary
      - Lane D, 2026-08-19 — **all five named cases have specs, and the suite is green.**
        Full e2e run three times on one tree: 16 files, 574 passed, 33 todo, exit 0.
      - double scan — `concurrency.test.ts` § "double scan of one wallet token": a second
        charge on a consumed token is `410`, and two charges racing on one token settle
        exactly one while the other `410`s. `scanner.test.ts` § "two charges at once" runs the
        same race against the real API, which the mock could not.
      - double submit — `concurrency.test.ts` § "double submit of one charge": a sequential
        resubmit under one key returns the first result, and a genuine double-tap (two in
        flight at once under one key) settles exactly one transaction.
      - duplicate callback — `gateway.test.ts` § "a duplicate callback credits once", plus
        § "a re-delivery under a NEW event id is refused by the machine", which is the harder
        half: with MyFatoorah the state machine is the load-bearing guard because
        `Event.Reference` is not signed, so the event index cannot be.
      - callback before client return — `gateway.test.ts` § "the callback and the customer
        race, and the answer is the same either way", plus § "a late `pending` or `declined`
        cannot walk a settled top-up backwards".
      - happy-hour boundary — `promotions.test.ts` § "the boundary is inclusive-start,
        exclusive-end" against the real API and the shared predicate, and
        `concurrency.test.ts` § "a charge crossing a happy-hour boundary". Note this suite
        could not pass between 23:00 and 01:00 Kuwait until 2026-08-19; see the note on that
        fix in the commit log, and the all-minutes sweep that now guards it.
- [x] Negative balance is impossible at the database level, not just in application code
      - Lane D, 2026-08-19 — **driven as the application role, both directions.**
        `member_balance_non_negative` — `CHECK (balance_fils >= 0)`,
        `0000_initial_schema.sql:64` — had existed since the first migration with **nothing
        asserting it**, which is the state this row was written to catch: a guard nobody
        drives is a guard nobody would notice the loss of.
      - `scanner.test.ts` § "the money floor is in the schema, not only in the handler" now
        runs `SET ROLE avo_app` and writes `balance_fils = -1`, which is refused by name, with
        the balance unchanged afterwards. Asserted as `avo_app` on purpose: that is the role
        the API holds, and the claim is about what the database refuses the running system
        rather than what it refuses a superuser.
      - Both directions, because a constraint that refuses everything proves nothing: a debit
        to **exactly zero** is accepted in the same spec, so a customer can still spend her
        last fil. A CHECK written `> 0` would pass the negative half and break a real flow.
- [ ] Commission figures configured in Owner → Controls and shown correctly to merchants
- [x] Float/rounding audit: no floating point touches money anywhere in the stack
      - Lane D, 2026-08-19 — **audited statically across every surface, and the API boundary
        is driven.** Two halves, because either alone is insufficient: a grep proves what the
        source does, a spec proves what the server refuses.
      - Storage: every money column goes through `filsColumn` (`db/schema/_shared.ts`), which
        is `bigint` with `mode: 'number'` and branded `Fils` — "always `bigint`, never
        numeric/decimal/real/double/money". No money column is any other type.
      - The one genuine float hazard is documented and avoided rather than papered over:
        `api/src/money/kwd.ts` records that `8.87 * 1000 === 8869.999999999998` and
        `Math.trunc` of it loses a fil, and does not convert that way.
      - Swept `api/src`, `packages/types`, `packages/ui`, `packages/tokens`, `apps/wallet`,
        `apps/dashboard` and `apps/scanner` for `parseFloat`, `toFixed`, `Math.round/floor/ceil`
        and `* 1000` / `/ 1000`. **Every surviving hit is either a display boundary or not money
        at all** — `(x / 1000).toFixed(3)` in audit-log detail strings, seed logging, the sandbox
        gateway's HTML, job logs and error copy, which is exactly what non-negotiable #1 permits
        ("format to 3 decimals only at the display boundary"); and in the clients, `toFixed(1)`
        on **hours** (`Team.tsx`, the scanner's `hoursValue`), `/ 1000` on **seconds**
        (`useWalletToken`, `activity.ts`), `parseFloat` on typography **tracking**
        (`tokens/generate.ts`) and `toFixed(2)` on **contrast ratios** (`tokens/derive.ts`).
      - Runtime: `money.test.ts` §#1 "no float and no negative amount reaches money" — a
        fractional `amountFils`, a KWD amount sent where fils are expected, and a negative
        `amountFils` are each refused with an actionable `400` that creates nothing.
      - One observation, not a failure: several places do bare integer arithmetic on fils
        (`dueFils - balanceFils`, `m.balanceFils + refund`, `row.amountFils - row.bonusFils`)
        rather than `add`/`subtract` from `@avo/types`. Integer-safe, so no float touches money
        and this row stands — but it sidesteps the branded helpers CLAUDE.md points at, and a
        future edit there is where a float would first get in. Worth a lane A tidy.

## Security

- [x] Passwords hashed with argon2id or bcrypt; no endpoint returns a password field
      - Lane D, 2026-08-19 — **argon2id, and the no-return half is driven from four angles.**
        `api/src/auth/password.ts` uses `@node-rs/argon2` for both passwords and PINs, with
        verification constant-time inside argon2 itself so there is no comparison to get wrong.
      - `permissions.test.ts` § "never returns a PIN, a PIN hash or a password
        (non-negotiable #6)"; `scanner.test.ts` § `POST /scans` "and never returns the
        customer's password hash"; `account.test.ts` § "change password — the sentence on the
        screen is true only if the server did it".
      - `signup.test.ts` § "never returns the password or its hash, anywhere in the payload"
        asserts on the **raw response body** rather than key by key — the plaintext, the
        `$argon2` prefix and both spellings of the field — because a key-by-key check misses a
        hash nested inside `member` or one added later under a name the spec does not know.
- [x] Staff PIN hashed, device+salon scoped, rate limited, locked after N failures, and
      unable to reach any dashboard scope
      - Lane D, 2026-08-19 — **all five clauses driven, each by its own spec.**
      - hashed — `staff_user.pin_hash`, argon2id via `auth/password.ts`. The schema also
        refuses a `pin_hash` without a device id
        (`(pin_hash IS NULL) = (pin_device_id IS NULL)`), so an unbound PIN cannot exist.
      - device+salon scoped — `scanner.test.ts` § "PIN sign-in", and the cross-door case with
        the `B_STAFF_CROSSDOOR` fixture: a PIN bound to one device is refused from another.
      - rate limited — `scanner.test.ts` § "PIN rate limiting — per device, which is the
        control the lockout cannot be", plus § "the rate-limit constants this suite pins are
        the ones the API holds", so the suite cannot drift from the server's real numbers.
      - locked after N failures — `scanner.test.ts` § 'PIN lockout — "lock after N failures"'.
      - unable to reach any dashboard scope — `authority.test.ts` § "a PIN session with every
        permission still cannot reach a dashboard endpoint", and its mirror, "a web session
        with every permission still cannot charge a wallet". The surface is checked **before**
        the permission, so holding all nine is not a way in.
- [x] QR tokens single-use, server-minted, short-lived, and rejected after consumption
      - Lane D, 2026-08-19 — **all four clauses driven. The `short-lived` half was an
        `it.todo` until today and is the reason this row could not be ticked before.**
      - server-minted — the token comes from `GET /members/me/wallet-token`; the row stores a
        sha256, never the value. `concurrency.test.ts` "an unknown token is refused before
        anything else happens" and `scanner.test.ts` "a token that was never minted is
        refused" close the client-minting door. A wallet session also cannot scan, so a
        customer cannot resolve her own QR to a member card.
      - single-use / rejected after consumption — `concurrency.test.ts` "the second charge on a
        consumed token is refused with 410" and "two charges racing on the same token: exactly
        one settles, the other 410s". Consumption happens at the **charge**, not the scan, so
        re-reading a code before confirming does not burn it — asserted both ways.
      - short-lived — `TOKEN_TTL_SECONDS = 45`, capped by `wallet_token_expiry_window` at two
        minutes. `concurrency.test.ts` recorded this as unreachable ("needs a way to mint a
        short-lived or back-dated token; sleeping 45s in a suite is not a test"), which was
        true of that file for ever: it drives `packages/mock`, which owns no database.
        **`scanner.test.ts` § `POST /charges` "an EXPIRED token is refused with 410
        token_expired, and debits nothing"** now closes it against the real API by moving
        `issued_at` and `expires_at` together — the CHECK is
        `expires_at > issued_at AND expires_at <= issued_at + 2 minutes`, so pushing
        `expires_at` alone into the past is refused by the database and the fixture cannot
        express "expired" that way.
      - The spec asserts the CODE, not just the status: `token_consumed_or_unknown` and
        `token_expired` are both `410`, so a server collapsing the two would pass a
        status-only check while telling the counter the wrong thing to do about it.
- [ ] Every permission enforced server-side and covered by a test that calls the endpoint
      directly with the permission off
      - Lane C, 2026-08-19 — **dashboard client half done.** The courtesy-gate ledger in
        `apps/dashboard/src/routes/sectionState.tsx` was re-derived from every `require*Perm`
        in `api/src/routes` and matches on all nine sections, including the two non-obvious
        ones: `GET /charges` is `requireScannerPerm` so no web session can ever satisfy it,
        and every salon write is `perms.loyalty`, not `perms.dashboard`. Only Marketing and
        Settings have the ungated-read/gated-write shape that needs a client gate; the other
        six are deliberately ungated. Proven live: a manager holding all nine permissions
        gets the server's own refusal on Overview's activity feed.
      - **Still open, and not Lane C's:** server-side enforcement and the permission-off
        tests are Lane A and Lane D. This row stays unticked until those are named.
      - Lane D, 2026-08-19 — **naming it: 9 of 31. The row's criterion passes and the
        underlying claim fails, so it stays unticked.**
      - Enforcement itself is real and driven. `authority.test.ts` § "every gated endpoint,
        called directly with the permission OFF (non-negotiable #7)" covers **all nine**
        permissions against the real API, each with a genuinely restricted principal, and
        asserts the mirror — the same call succeeds once the permission is granted, so no probe
        is passing because the endpoint was broken shut. It also pins that perms are read per
        request, so a session does not survive a permission change.
      - **But #7 says "every gated ENDPOINT needs a test that calls it directly", not every
        permission.** A census of `require*Perm` call sites in `api/src/routes` gives **31 call
        sites resolving to 31 distinct (endpoint, permission) pairs** across the nine
        permissions. `authority.test.ts` probes **nine** of them — one per permission.
        `permissions.test.ts` probes nine too, but against `packages/mock`, so it cannot speak
        to server-side enforcement in the API.
      - So **22 gated endpoint/permission pairs have no direct permission-off test**, including
        every write in the `team` group (`POST /staff`, `PATCH /staff/:id`, `DELETE /staff/:id`,
        `POST /staff/:id/password-reset`, `PUT /artists/:id/availability`,
        `POST /artists/:id/calendar/connect`, `DELETE /artists/:id/calendar`), the whole
        `loyalty` write group (`PATCH /salons/:id`, `POST /salons/:id/branches`,
        `PATCH`/`DELETE /salons/:id/branches/:bid`, `PUT /salons/:id/loyalty`), four of the five
        `marketing` endpoints, and `dashboard` on `GET /salons/:id/activity` and
        `GET /salons/:id/audit`.
      - This is the same shape as Lane C's contrast finding: `authority.test.ts`'s own spec
        asserts "covers all nine permissions, each with a real gated endpoint" — a criterion
        that passes — while #7's actual requirement is unmet on 22 endpoints. **The 9-permission
        table reads like completeness and is not.**
      - Note the count moved while this was being written: the brief said 29 call sites and the
        census found 31. That is the argument for making it a spec rather than a paragraph — a
        census that enumerates the call sites from source and demands a probe for each would go
        red when a new gated endpoint lands untested, and would also catch one gated on the
        **wrong** permission. Lane D's next slice; the row stays unticked until it exists.
- [ ] Rate limiting on auth, top-ups, scans, support tickets
      - Lane D, 2026-08-19 — **one of the four named surfaces is limited. Not ticked.**
      - **auth — done, and driven.** Two independent limiters. Staff PIN: per-device rate limit
        plus lockout after N failures (`scanner.test.ts` § "PIN rate limiting", § "PIN lockout"),
        with the constants pinned against the server's own. Member signup: two tiers on the
        caller address, migration 0026, driven by `signup.test.ts` § "the signup limiter bounds
        the argon2 cost, in two tiers" — burst, hourly ceiling, ceiling-checked-first,
        window expiry, the shared null-address bucket, and that `avo_app` cannot clear the
        counter (a limit the API can reset is not a limit).
      - **top-ups — no limiter at all.** `api/src/routes/topups.ts` contains zero rate-limit
        code.
      - **scans — no limiter at all.** `POST /scans` in `routes/staff.ts` has none. Note the
        limiter that *does* exist nearby is on `GET /members?q=` (the manual directory lookup,
        `lookup_rate_limited` / `lookup_hourly_limit`), which is a different endpoint from the
        one this row names — easy to mistake for coverage.
      - **support tickets — no limiter at all.** `POST /v1/support/tickets` in
        `routes/platform.ts` has none, and it is unauthenticated-adjacent.
      - And there is **no global limiter** to fall back on: no `@fastify/rate-limit`, no
        `onRequest` hook. The complete set of `tooManyRequests` codes in `api/src` is
        `pin_locked`, `too_many_attempts`, `signup_rate_limited`, `signup_hourly_limit`,
        `lookup_rate_limited`, `lookup_hourly_limit` — auth and the directory read, nothing
        else. Lane A.
- [ ] Secrets in a manager, not in env files in the repo
- [ ] Penetration test or an external security review completed on the money paths
- [ ] Audit log verified append-only at the database level; 7-year retention configured
      - Lane D, 2026-08-19 — **append-only is proven at the database level. Retention is not
        configured at all. Two clauses, one met, so not ticked.**
      - Append-only, driven as the application role: `account.test.ts` and `scanner.test.ts`
        both run `SET ROLE avo_app` and get `permission denied` for `UPDATE` and `DELETE` on
        `audit_log`. Migration 0023 goes further and adds **triggers** refusing UPDATE, DELETE
        and TRUNCATE to *everyone*, the owner included — which is why this suite's own teardown
        cannot delete an audit row and why `signup.test.ts` leaves its throwaway salon behind
        (`audit_log.salon_id` is `onDelete: 'restrict'`, so an undeletable audit row makes the
        salon undeletable too). 0024 does the same for the ledger. The constraint is strong
        enough that it shapes the tests, which is the best evidence it is real.
      - `member_consent_event` carries the same protection (0020 revoke + 0023 triggers), so
        consent evidence is append-only on the same terms — relevant to #8 and #10.
      - **7-year retention: nothing implements it.** The number appears in the published privacy
        copy ("Transaction records are kept for 7 years") and in schema comments, and
        `db/schema/member.ts` says outright that deciding which data survives the seven years
        "is a retention decision that belongs" elsewhere. There is no retention job, no
        scheduled deletion and no configured window — `api/src/jobs/` holds only
        `no-show-once.ts`. So the product **promises a retention schedule it does not have**,
        which is a legal-copy-versus-implementation gap rather than a missing test. Trunk and
        the client (it is also on the Legal list as "retention schedule documented").

## Reliability

- [ ] Error tracking and structured logging on all four surfaces
- [ ] Alerting on: charge failure rate, gateway error rate, receipt queue depth, bounce
      rate, calendar sync failures, approval queue age
- [ ] Backups with a tested restore, not just a configured schedule
- [ ] The offline states behave correctly on a real degraded connection, not just with
      the network toggled off
      - Lane C, 2026-08-19 — **dashboard: refused-connection proven, degraded not yet.**
        With the API killed, sections reach §4's "No connection — We can't reach the
        workspace. Nothing is lost" state with a working Try again that recovers the real
        roster. Driven in a tab whose document reports `visibilityState: 'hidden'`, which
        used to park the query at `fetchStatus: 'paused'` with the error never recorded and
        the screen on skeletons for ever — fixed in `apps/dashboard/src/api/queryRuntime.ts`.
      - **Deliberately NOT ticked:** a refused connection is not a *degraded* one. Slow,
        flaky and partially-delivered responses are untested on every surface, and that is
        what this row asks for.
- [ ] Staging environment mirrors production, including the gateway sandbox

## Product completeness

- [ ] Every screen has its loading, empty, error and offline states built
      (`AVO States.dc.html`, `interaction-spec.md` §4)
      - Lane C, 2026-08-19 — **merchant dashboard: all eight built sections driven** against
        the real API on a real database (Overview, Appointments, Team, Loyalty, Marketing,
        Audit log, Accounts, Settings). Observed, not inferred: layout-shaped skeletons
        rather than a spinner and money fields skeletoned as bars (never `0.000` before
        data); the audit log's "No entries match that search."; the 403 explain state with
        the server's own copy and no retry button; and the connectivity state with Try again.
      - **Shop and Reports are not built at all** — both blocked on Lane A
        (`GET /salons/{id}/products` returns a hardcoded empty list with no write endpoints;
        the CSV route and three of the four report aggregates do not exist). The nav shows
        them because the shell design does; they resolve to a "not built yet" placeholder.
      - Wallet and scanner states are Lane B's half of this row.
- [ ] Reduced motion **removes** the scanner line, success pop, pulse and shimmer
      - Lane C, 2026-08-19 — **shimmer done.** `@avo/ui`'s `avo-shimmer` is a 1.4s infinite
        loop and `@avo/tokens` emits §3's blanket verbatim, so `*` with
        `animation-iteration-count: 1 !important` and `animation-duration: 0.01ms !important`
        necessarily kills it. Deliberately NOT re-added, and the reasoning is recorded at
        `apps/dashboard/src/app.css` §reduced-motion: the skeleton's *shape* carries the
        loading state, so removing the animation does not remove the state change. §3's one
        required re-add on this surface — the drawer cross-fading in place instead of
        sliding — is implemented there too.
      - Verified by cascade and by reading the emitted CSS, **not** by driving a browser
        under `prefers-reduced-motion` — the Browser pane cannot emulate that media query.
      - Scanner line, success pop and pulse are Lane B's; this row needs them before it
        can be ticked.
- [ ] Focus rings and the full keyboard map on both web surfaces
      - Lane C, 2026-08-19 — **merchant dashboard verified by driving it.** `:focus-visible`
        rings render on inputs and the stepper. §2's map, checked rather than assumed:
        toggles expose `role="switch"`; the deposit control is a `spinbutton` whose
        icon-only buttons carry real labels ("Decrease Booking deposit"); and the stepper's
        numeric claim holds — ArrowUp moved 5.000 to 6.000 (one step) and PageDown moved
        6.000 to 2.000 (four), which is exactly what §2 specifies and the sort of number
        that has drifted here before. Data tables are real `<table>` with
        `<th scope="col">`, and the sidebar is a single tab stop with roving arrow keys.
      - **BLOCKED on the second web surface.** "Both" means the owner console, which does
        not exist and cannot be started: there is no platform principal on the server
        (`PrincipalKind` is `'member' | 'staff'`, no `platform_admin` table). §2 also
        specifies a *different* focus-ring colour for the dark console sidebar
        (`#A9BBA6`, because `#6E7F6C` does not carry against `#1C1B19`) — `@avo/tokens`
        already emits it as `.avo-dark :focus-visible`, so the token is ready and the
        surface is not. Waits on Lane A.
- [ ] Arabic reviewed by a native speaker across every customer screen, including error
      copy, the legal set, and receipt emails
      - Lane C, 2026-08-19 — the merchant dashboard is **English-only by decision**
        (`design/README.md` § Known gaps 1), so it is out of scope for this row rather than
        pending on it. Non-negotiable #12 is about the customer surfaces. Noted because an
        unticked row with no scope reads as work nobody has started.
- [ ] Contrast scan repeated on the built apps: zero white-text failures, three
      documented exceptions only (`interaction-spec.md` §2)
      - Lane C, 2026-08-19 — **dashboard scanned in the live DOM, and the row's own
        criterion passes: zero white-text failures, and zero brand-filled elements whose
        only white content is an SVG stroke** — the two shapes §2's audit method says a
        naive find-and-replace misses.
      - **The brand-derived failures are FIXED** (Lane C, 2026-08-19, authorised by trunk
        as a one-off into `packages/tokens`). `deriveBrandSet` validated white-on-`deep`
        and never `deep`-on-`tint`, even though `deep` is the *text* colour on tinted
        chips, pills and labels — and the derived set is what renders, because
        `useBrandTheme.ts` writes it onto the document for any salon with a brand hex, so
        §2's hand-tuned table is overridden. Amara's `#6E7F6C` derived `deep: #637361` on
        `tint: #E9ECE9` = **4.24:1** at 11–12px. It now derives `#5C6A5A` on the same tint
        = **4.81:1**, and re-scanning the live DOM shows **zero brand-pair failures** on
        Settings and Audit log. Non-negotiable #9 was never violated — white-on-deep
        measured 5.05:1 throughout; the defect was that one pairing was the only one
        checked.
      - **SEVEN failures found and fixed** (Lane C, 2026-08-19, trunk-authorised into
        `packages/tokens`). Six came from a hand DOM scan; the seventh was found by the
        automated audit below on its first run. All are AA failures for normal text at the
        11–12.5px sizes they are used at:
        `color.warnText` 4.01 → **4.82**, `tier.gold.pillText` 4.01 → **4.82**,
        `plan.pro.text` 3.77 → **4.60**, `audit.accessText` 3.77 → **4.60**
        (all four were the one hex `#8a6d3b`, now `#7A6034`);
        `tier.bronze.pillText` **2.67 → 4.71** (`#B08D57` → `#80653C`);
        `brandPresets.noorRose.deep` 4.41 → **4.86** (`#8A6565` → `#825F5F`, regenerated
        through the solver); and `plan.starter.text` **4.32 → 5.93** (moved to the 0.7 step
        of the existing muted scale).
      - **Trunk's chosen `#7D6234` was not used, and this is why.** It measures 4.73:1 on
        `#F3E9CF` but only **4.46:1** on `#EAE2D6` — and that one hex served both
        backgrounds, so it would have left `plan.pro` and `audit.access` still failing.
        `#7A6034` is the smallest darkening of the same hue that clears both (4.82 / 4.60).
      - `tier.bronze`'s `dot` keeps `#B08D57` deliberately. It is decoration, and §2 says
        the pill carries its meaning as text rather than colour, so only `pillText` needed
        to move.
      - **THE CHECK IS NOW REPEATABLE WITHOUT A BROWSER** —
        `packages/tokens/src/audit.ts` + `audit.test.ts`. It discovers
        `<x>Text`/`<x>Bg` sibling pairs structurally, so a new pill group is audited the
        day it lands; carries the cross-group `deep`-on-`tint` pairings a structural rule
        cannot infer; and **composites translucent text rather than skipping it**, which is
        how the seventh failure was found. Skips are reported with a reason, never counted
        as passes. All six original failures are pinned as measured ratios that must move
        the right way.
      - **Surface coverage, honestly.** Dashboard: re-scanned live, zero failures of any
        kind. Wallet: booted on its web target and scanned — 10 text elements, zero
        failures — but only the sign-in screen is reachable, because the wallet still has
        no auth slice and defaults to port 4000, so the tier pills were not seen in a DOM.
        **Scanner: a DOM scan is impossible** — it has no web target at all, only
        `expo run:ios` / `run:android`. What covers both surfaces instead is that the audit
        is surface-independent and that no surface hardcodes the old values: grepping
        `apps/wallet`, `apps/scanner`, `apps/dashboard` and `packages/ui` for all six old
        hexes returns only comments, so every surface reads the token. The wallet and
        scanner consume `@avo/tokens`' native theme rather than the CSS variables; both are
        generated from the same JSON.
      - **One escalation left, and it is bundle-wide.** §2 states
        `rgba(28,27,25,0.6)` measures "~5.2:1" and mandates it for 51 uppercase
        micro-labels; composited on the app surface `#FBFAF8` it actually measures
        **4.48:1** — marginally under the floor it was chosen to clear, and lower on any
        darker surface. The JSON's own note says it is used 154 times. Not changed: moving
        it touches all four surfaces. The one place the JSON declared that pairing was
        `plan.starter`, which is fixed above. Recorded in `audit.ts` under what the audit
        does not cover.
- [ ] Tap targets ≥ 44px verified on device
      - Lane C, 2026-08-19 — not a dashboard row. `interaction-spec.md` §1 makes the
        merchant dashboard desktop-only and shows an "open on a larger screen" notice below
        768px, so the touch surfaces here are Lane B's wallet and scanner.
- [ ] Receipt email rendered in Gmail, Apple Mail, Outlook, and one Arabic client

## Consent and messaging

- [x] Accepted policy version stored against the member at signup
      - Lane D, 2026-08-19 — **stored as an EVENT at signup, and driven end to end.** Until
        migration 0025 there was no moment at which acceptance happened: `auth.ts` had sign-in,
        refresh, sign-out and a staff reset and **no registration**, so every
        `member.policy_version` in the database had been written by a seed script rather than by
        a customer agreeing to anything. `POST /auth/member/signup` is what closes it.
      - `signup.test.ts` § "writes ONE policy_acceptance event, granted, sourced to the signup"
        — one row in `member_consent_event`, `kind = 'policy_acceptance'`, `granted = true`,
        `source = 'signup'`, at the version she was shown, in the **same transaction** as the
        member row.
      - She can only accept what was on the screen: the client sends the version it displayed
        and the server refuses anything else. `policy_version_stale` is a `409` carrying both
        the published and the submitted version so the client can say "the terms changed", and
        an **omitted** version is `policy_version_required` rather than a default — which is
        `design/README.md` gap 5 ("do not rely on 'they agreed to whatever is current'") as a
        spec. Both driven.
      - The database refuses a withdrawn acceptance outright
        (`member_consent_acceptance_is_never_withdrawn`), and a double tap on the re-prompt
        writes one row, not two (`member_consent_acceptance_once_per_version`) while still
        answering `200` rather than leaking the unique index as a `500`. Marketing consent is
        deliberately **not** covered by that index and a spec asserts the difference, because
        off-on-off over a year is three real facts.
- [ ] Material policy change re-prompts, with `effectiveFrom` at least 30 days out
      - Lane D, 2026-08-19 — **the re-prompt half is proven. The 30-day rule is enforced
        nowhere. Not ticked.**
      - Re-prompt, and it is answered from the EVENT TRAIL rather than the cached column, which
        is the only version of this that works: `member.policy_version` is one mutable integer,
        so it can answer "which version did she last accept" and never "has she accepted the
        version published now". `GET /members/me/policy-acceptance` serves
        `{published, accepted, stampedVersion, upToDate}` where `upToDate = false` is the
        re-prompt.
      - Driven on one member twice, which is what makes it a demonstration rather than a
        coincidence of the fixture: `signup.test.ts` § "deleting the evidence alone re-prompts
        her, with the cached column untouched". She signs up, is `upToDate: true`; the
        acceptance **event alone** is deleted, leaving `policy_version` unchanged; the same read
        now returns `accepted: null` and `upToDate: false`. A build computing this from the
        column would call her up to date. That is also the exact state **every member seeded
        before 0025** is in, so they are all correctly due a re-prompt.
      - `contract.test.ts` wire-pins the read and the write to the same shape, with `accepted`
        sampled **populated** — a null `accepted` collapses to one leaf and the pin would stop
        declaring anything about `accepted.version` / `.at` / `.source`.
      - **`effectiveFrom` at least 30 days out is not enforced anywhere.** No check exists in
        `api/src/routes` or `services/policy.ts`; the seeded set is simply published with a date.
        Nothing stops a publish taking effect tomorrow, which is the half of this row that
        protects the customer rather than the record. There is also no publish endpoint to
        enforce it on yet. Lane A, and it needs the number confirmed by counsel — it is the kind
        of figure that belongs beside the CBK and counsel items on the Legal list.
- [ ] Marketing consent honoured; receipts and support acknowledgements sent regardless
      of it and excluded from any unsubscribe-all path
- [ ] Weekly-per-customer and monthly-per-salon caps and quiet hours enforced at send
      - Lane C, 2026-08-19 — **nothing implements this yet.** `requireApproval`,
        `weeklyCapPerCustomer`, `monthlyCapPerSalon`, `quietFrom` and `quietTo` are typed in
        `packages/types` and `isWithinQuietHours` exists in `rules.ts`, but they have **zero
        occurrences in `api/src`**. Lane A's row.
      - **A conflict Lane C cannot resolve alone:** the merchant dashboard already promises
        the merchant a specific version of this rule — "nothing leaves between 22:00 and
        09:00. A person gets at most two marketing messages a week" — which is verbatim
        design copy (`AVO Merchant Dashboard.dc.html:1929`). The same design's owner console
        treats those numbers as owner-configurable (`weeklyCapPerCustomer` 1..7, with 22:00 /
        09:00 / 2 as mere defaults), and `api-contract.md` § PlatformMessagingPolicy says "a
        merchant can never read or raise these values" — so the dashboard cannot be made
        truthful by fetching them. Copy is settled and Lane C will not paraphrase it; this
        needs Aftab.
- [ ] A held campaign is reported back to the salon, never silently dropped

## Store submission

- [ ] Account deletion reachable in-app (App Store requirement) with the remaining-balance
      warning, and a working server-side deletion path behind it
- [ ] Privacy nutrition labels / Data safety form completed accurately
- [ ] Camera permission string explains scanning in plain language, EN + AR
- [ ] Push permission requested in context, not on first launch
- [ ] Payments reviewed against store rules — the wallet funds real-world salon services,
      so it is not in-app purchase, but be ready to argue it
- [ ] White-label build pipeline produces a per-salon app from one `--brand` token, name,
      logo and typography pairing, with no code change

## Operations — decide before public launch

- [ ] Who monitors the AVO support queue, in what hours
- [ ] What the salon-routed queue actually is: WhatsApp Business inbox or the dashboard
- [ ] What happens to a message arriving outside promised hours
- [ ] Who approves campaigns, with what SLA, and who covers weekends
- [ ] Merchant onboarding runbook and training material for the scanner
- [ ] Incident process for a wrong charge, a stuck top-up, and a gateway outage
- [ ] Status page or an agreed channel for telling salons that something is down
