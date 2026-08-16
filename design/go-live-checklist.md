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
- [ ] Staging environment mirrors production, including the gateway sandbox

## Product completeness

- [ ] Every screen has its loading, empty, error and offline states built
      (`AVO States.dc.html`, `interaction-spec.md` §4)
- [ ] Reduced motion **removes** the scanner line, success pop, pulse and shimmer
- [ ] Focus rings and the full keyboard map on both web surfaces
- [ ] Arabic reviewed by a native speaker across every customer screen, including error
      copy, the legal set, and receipt emails
- [ ] Contrast scan repeated on the built apps: zero white-text failures, three
      documented exceptions only (`interaction-spec.md` §2)
- [ ] Tap targets ≥ 44px verified on device
- [ ] Receipt email rendered in Gmail, Apple Mail, Outlook, and one Arabic client

## Consent and messaging

- [ ] Accepted policy version stored against the member at signup
- [ ] Material policy change re-prompts, with `effectiveFrom` at least 30 days out
- [ ] Marketing consent honoured; receipts and support acknowledgements sent regardless
      of it and excluded from any unsubscribe-all path
- [ ] Weekly-per-customer and monthly-per-salon caps and quiet hours enforced at send
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
