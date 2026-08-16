# AVO Beauty — build plan

Phases are ordered by dependency, not by visible progress. Each phase lists what must be
true to call it done. Nothing in a later phase is safe to start early except types.

Sequencing note: the money core (phase 2) and the scanner (phase 3) are the product. A
salon can run on those two alone. Everything after phase 4 is leverage.

---

## Phase 0 — Foundations

**Build**
- Repo layout: `api/`, `mobile/`, `web/`, `packages/types`, `packages/tokens`
- Design tokens imported from `tokens/avo-tokens.json` into every surface. Never re-type
  a hex. Fonts bundled: Fraunces, Inter, IBM Plex Sans Arabic
- Shared types generated from `api-contract.md`
- Postgres schema for Salon, Branch, Member, Transaction, Booking, Artist, Product,
  StaffUser, PlatformAdmin — money columns `bigint` fils, `CHECK (amount_fils = trunc(amount_fils))`
- Auth: member (phone + password), staff (device-scoped PIN), web (username + password),
  all with refresh tokens and revocation
- Environments: dev, staging, prod. Kuwait/EU data residency decided and applied
- Audit log table, append-only, write-through helper used by every mutating handler

**Done when**
- A member, a salon, a branch and a staff user can be created and authenticated
- Every mutating endpoint writes an audit row, and the row cannot be updated or deleted
- CI runs types, lint, and tests on every push

---

## Phase 1 — Customer wallet, read-only

**Build**
- Home: wallet card, balance, loyalty progress (tiers **and** stamps), activity feed
- QR: `GET /members/me/wallet-token`, 45s rotation, countdown, tap to enlarge
- Transaction detail sheet with full breakdown and reference
- Account: profile rows, notification toggles, language switch
- Full EN + AR with RTL mirroring
- Loading skeletons, empty states, offline (last-known balance with timestamp, **QR hidden**)

**Done when**
- A member sees a real balance and real history from the API
- The QR encodes `avo://pay?m={memberId}&t={token}` and the token is server-issued
- Arabic mode is complete, mirrored, and money renders `18.000` in Western digits
- Killing the network shows the offline state, not a blank screen or `0.000`

---

## Phase 2 — Money core

**Build**
- `POST /topups` with idempotency key, KNET first and default, then Apple Pay, then card
- Gateway redirect, return handling, and authoritative `GET /topups/{id}`
- All four outcomes as distinct screens: success, declined, cancelled, **pending**
  (pending offers no retry)
- Tier bonus calculation server-side; commission (KNET 150 fils flat, card 2.5% + 50 fils)
  recorded per transaction, merchant-visible, customer-never
- `POST /charges` as one atomic transaction per `api-contract.md`
- Email receipt pipeline: transactional domain with SPF/DKIM/DMARC, queue with retry,
  bounce and complaint webhooks flagging the member record. Template is
  `AVO Receipt Email.html` — wire the merge fields
- WhatsApp receipt via the approved template

**Done when**
- A top-up moves real money in the gateway sandbox and credits the wallet only after a
  server read
- Replaying the same idempotency key does not double-credit
- A charge that would overdraw fails with nothing else applied, and the scanner shows the
  exact shortfall
- Concurrency tests pass: double scan of one token, double submit of one charge,
  gateway callback arriving twice, callback arriving before the client returns
- A receipt email and a WhatsApp receipt arrive for every settled payment

---

## Phase 3 — Staff scanner

**Build**
- PIN sign-in, device+salon scoped, rate limited, lock after N failures
- Home hub: Scan, My bookings, My schedule, Today's charges (permission-gated)
- Scan → member card → service chips → charge, with held deposit applied as a credit line
- Manual member lookup, logged against the staff member
- Void within 15 minutes with a reason, full wallet refund, visit removed, customer notified
- My schedule: availability source toggle, slot length, per-day windows
- `GET /staff/me` returns `perms`; client re-reads on change; server rejects on permission

**Done when**
- A charge completes end to end from a real QR on a real phone
- A scanner with `charges: false` sees the locked screen and the endpoint returns 403
- A void inside the window refunds and reverses loyalty; outside the window it is refused
  and the merchant reimbursement path is the only route

---

## Phase 4 — Merchant dashboard

**Build**
- Overview, Appointments, Team (with the hours editor), Shop, Loyalty (editable tiers
  with validation and publish), Settings (modules, deposit, business hours, branches,
  brand kit including typography, plan and invoices)
- Accounts → Team authority: nine permission chips writing to the shared staff record
- Audit log with search and Money / Rules / Access / Risk filters
- Notifications bell with deep links
- Web sign-in per `AVO Login.dc.html`, responsive per `interaction-spec.md` §3

**Done when**
- An owner can configure a salon end to end without an engineer
- A permission change on the dashboard reaches the scanner on next read and is audited
- Tier rule edits validate thresholds and publish atomically

---

## Phase 5 — Shared platform state

**Build**
- `GET /v1/salons/{id}/promotions` as the single source for boosts and happy hours
- Boost publish, happy-hour CRUD
- Happy hour resolved by predicate — no `live` flag — in both clients and at charge time
- One push per window per member at `from`, suppressed inside quiet hours
- Salon social links: handles stored, URLs derived server-side from the handle

**Done when**
- The wallet and the dashboard read the same object and cannot disagree
- A window expires on its own with no push, no poll, no server tick
- The earning multiplier at charge time is decided by the server predicate, so a stale
  client banner cannot produce a wrong charge

---

## Phase 6 — Booking and shop

**Build**
- Availability computation: business hours minus Google busy minus existing bookings
- Google Calendar read-only connect, write-back of new AVO bookings
- Book flow with deposit hold, insufficient balance → inline top-up
- Auto-return of the deposit `noShowReturnMinutes` after a missed slot, as a
  `deposit_return` transaction
- Reschedule carries the deposit; cancel returns it; the 1-hour rule enforced server-side
- Shop catalog, cart, wallet checkout, pickup at salon

**Done when**
- Slots reflect real calendar state and unavailable slots render struck through
- A no-show returns the deposit automatically and the return appears in the audit log
- A calendar disconnect raises a merchant notification and falls back to salon hours

---

## Phase 7 — Owner console and governance

**Build**
- Analytics, Activity, Reports with real CSV export, Salons with the onboarding wizard,
  Accounts, Admins with section permissions, Controls, Billing, Audit log
- Approvals: the campaign queue, approve and release, reject with a note, the platform
  throttle, decided history
- Policies: draft/publish legal documents, EN + AR, consent flags, effective-from,
  version stamping, sign-off record
- Support & contact: channels, topics with Salon/AVO routing, the ticket queue

**Done when**
- No campaign can reach a customer without a decision here
- Caps and quiet hours are enforced again at send; a breaching campaign is held and
  reported, never silently dropped
- Publishing a policy version bumps `version`, writes an audit row, and the wallet picks
  it up on next fetch
- A member's accepted policy version is stored at signup and re-prompted on a material
  change

---

## Phase 8 — Hardening and launch

See `go-live-checklist.md`. Nothing ships until that document is fully green.
