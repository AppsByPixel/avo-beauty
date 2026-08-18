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
- [ ] Idempotency verified under retry for top-ups, charges, orders, voids
- [ ] Concurrency suite green: double scan, double submit, duplicate callback, callback
      before client return, charge during a happy-hour boundary
- [ ] Negative balance is impossible at the database level, not just in application code
- [ ] Commission figures configured in Owner → Controls and shown correctly to merchants
- [ ] Float/rounding audit: no floating point touches money anywhere in the stack

## Security

- [ ] Passwords hashed with argon2id or bcrypt; no endpoint returns a password field
- [ ] Staff PIN hashed, device+salon scoped, rate limited, locked after N failures, and
      unable to reach any dashboard scope
- [ ] QR tokens single-use, server-minted, short-lived, and rejected after consumption
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
- [ ] Rate limiting on auth, top-ups, scans, support tickets
- [ ] Secrets in a manager, not in env files in the repo
- [ ] Penetration test or an external security review completed on the money paths
- [ ] Audit log verified append-only at the database level; 7-year retention configured

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
      - **STILL NOT TICKED. One designed token pair fails, and it is not Lane C's to
        change.** `--avo-warn-text` `#8a6d3b` on `--avo-warn-bg` `#F3E9CF` measures
        **4.01:1** at 11–12.5px. Both are literal values in
        `design/tokens/avo-tokens.json`, and that same `#8a6d3b` is also `pillText`,
        `text` and `accessText` there — so it carries the **Gold tier pill** and the access
        rows on the wallet and scanner too, not only `.settings__notice` and the audit-log
        pills. Darkening `warnText` to `#7D6234` reaches 4.73:1 and `#775C31` reaches
        5.17:1 against the same background. Escalated rather than adjusted: it is a
        designed colour used across the bundle.
      - Also escalated, found while checking the presets as instructed: the **shipped**
        `noorRose` preset fails the same pairing by hand — `deep #8A6565` on
        `tint #F5EDED` = **4.41:1**, where amaraSage measures 5.01 and lilaLilac 5.04. The
        new validator would refuse that pair from a new salon while AVO ships it itself.
        Pinned in `derive.test.ts` so it cannot drift unnoticed, and left unchanged because
        the hex appears in `interaction-spec.md` §2's table and across the design files.
      - Wallet and scanner have not been scanned; that is Lane B's half of this row.
- [ ] Tap targets ≥ 44px verified on device
      - Lane C, 2026-08-19 — not a dashboard row. `interaction-spec.md` §1 makes the
        merchant dashboard desktop-only and shows an "open on a larger screen" notice below
        768px, so the touch surfaces here are Lane B's wallet and scanner.
- [ ] Receipt email rendered in Gmail, Apple Mail, Outlook, and one Arabic client

## Consent and messaging

- [ ] Accepted policy version stored against the member at signup
- [ ] Material policy change re-prompts, with `effectiveFrom` at least 30 days out
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
