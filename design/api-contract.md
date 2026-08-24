# AVO Beauty — API contract (derived from the prototypes)

Every surface in this bundle runs on mock data. This document names the entities those
mocks stand for, so the three apps agree on shapes before anyone writes an endpoint.

**Conventions**

- All money is **integer fils** (1 KWD = 1000 fils). `18.000 KD` is `18000`. Never floats.
- Timestamps are ISO 8601 with offset: `2026-07-13T14:30:00+03:00` (Kuwait is UTC+3, no DST).
- IDs are opaque strings. Don't assume format.
- Every list endpoint is cursor-paginated: `{ items: [...], nextCursor: string | null }`.
- `Accept-Language: en | ar` selects server-rendered copy (customer surface only).
- **Passwords are never returned by any endpoint.** Reset is link-only.

---

## Entities

### Salon
```
id            string
name          string          // "Amara"
city          string | null   // registered city; null on salons predating migration 0037
plan          "starter" | "growth" | "pro"
brandColor    string          // hex; drives the white-label token
modules       { booking: bool, shop: bool }
loyaltyMode   "tiers" | "stamps"
tiers         Tier[]          // present when loyaltyMode = "tiers"
stampTarget   int             // present when loyaltyMode = "stamps", e.g. 8
stampReward   string          // "Free blow-dry"
depositFils   int             // merchant-set booking deposit, 1000–10000
noShowReturnMinutes int       // 60
businessHours { morning: [open, close], evening: [open, close] }   // "10:00"
branches      Branch[]
social        SocialLink[]    // the salon's public channels, shown in the wallet
whatsappEnabled bool
```

**Contract addition, 2026-08-24 — `city`, and an account fact that is deliberately absent.**
The onboarding wizard's first step gates Continue on name + city + phone, and two of the three
had no column; migration 0037 added them. `city` is served by **both** doors
(`GET /salons/{id}` and `GET /v1/platform/salons/{id}`) and is `null` on salons created before
the column existed, so it is **nullable and required** rather than optional — null is a real
answer, but a server that forgets the key should fail rather than pass.

**`ownerPhone` is NOT part of this entity, on purpose.** It is served only by the console's
per-salon read, outside the salon shape, in an envelope — precisely so `SalonSchema` cannot
carry it. Members read `GET /salons/{id}`; a salon owner's phone number is not theirs to have.
Editing either field is **platform-only** (`PATCH /v1/platform/salons/{id}`); the merchant door
does not accept them, because they are account facts AVO holds rather than settings a salon
tunes. `plan` is editable through neither: it prices the account, and that belongs to Billing.

### SocialLink (merchant → Settings → Social links)
```
id      "instagram" | "tiktok" | "snapchat" | "whatsapp"
label   string
handle  string     // "@amara.kw", or E.164 for whatsapp
on      bool       // false hides the icon without losing the handle
```
```
PATCH /v1/salons/{id}/social/{linkId}   { handle?, on? }
```
**Store the handle, derive the URL.** Never persist a URL: a salon that edits its handle
would leave the icon pointing at a dead profile. Resolution (server-side, mirrored in
`avo-promotions.js` → `socialUrl`):

| id | URL |
|---|---|
| instagram | `https://instagram.com/{handle without @}` |
| tiktok | `https://tiktok.com/@{handle without @}` |
| snapchat | `https://snapchat.com/add/{handle without @}` |
| whatsapp | `https://wa.me/{digits only}` |

The wallet renders only links with `on: true` and a non-empty handle, as an icon grid
under Account → Help. Salon-owned, unlike `SupportConfig`, which AVO owns.

### Branch
```
id      string    // "BR-SAL"
salonId string
name    string    // "Salmiya"
```
> One wallet, one loyalty status, valid at every branch. Branch scopes **staff access
> and reporting**, never the customer's balance.

### Member (customer)
```
id            string          // "8842" surfaces as "ID · 8842"
salonId       string
name          string
phone         string          // E.164, "+96599124408" — also the login identity
email         string | null   // optional; receipts + support replies
emailVerified bool
balanceFils   int
visits        int
tier          "bronze" | "silver" | "gold" | "black" | null
stamps        int | null      // null when salon runs tiers
policyVersion int             // the published legal version accepted at signup
joinedAt      datetime
```

#### Profile edit and password change (customer → Account)
```
PATCH /members/me                { name?, email? }        → Member
POST  /members/me/phone-change   { phone }                → { challengeId, expiresAt }
POST  /members/me/phone-change/{challengeId}/verify  { code }  → Member
POST  /members/me/password       { current, next }        → 204
```
Rules:
1. **Phone is the login identity.** `PATCH /members/me` must reject a `phone` field. A
   change goes through the challenge endpoints: a 4–6 digit code to the **new** number,
   short-lived, attempt-limited (lock after 5), rate-limited per member per hour. Notify
   the **old** number that the change happened.
2. A phone already in use on the same salon is rejected before the code is sent — do not
   leak which numbers exist beyond that.
3. `email` change clears `emailVerified` and sends a verification link. Receipts keep
   going to the last verified address until the new one is confirmed.
4. `POST /members/me/password` requires `current`, enforces a minimum length of 6 (the
   client says so; enforce it server-side too), rejects `next === current`, and
   **revokes every other session** while keeping the calling device signed in. Send a
   notification on success — password change is a security event.
5. Never return a password field. "Forgot my current password" drops into the existing
   WhatsApp reset-link flow; it is not a bypass of `current`.

   **The flow's endpoints** (contract addition, 2026-08-19 — the rule above promised the flow
   and named no shape): `POST /auth/member/password-reset/request { salonId, phone }` → 202,
   `POST /auth/member/password-reset { token, password }` → 204. Identity is the **sign-in
   pair**, not the phone — `member_salon_phone_uq` means a phone alone is not a person, and a
   reset against "whichever row matched first" would set a password on an arbitrary one of her
   wallets. The request answers **202 regardless of whether the pair matched** (unknown phone
   and right-phone-wrong-salon are byte-identical), is IP-throttled with the throttle answering
   **before** validation, and the token is stored only as a sha256, single-use under a race.
   Redemption revokes every session and **does not touch a pending deletion's clock** — proving
   she holds her phone says nothing about whether she still wants the account gone; cancelling
   the erasure is its own act, taken signed-in.

#### Notification preferences (customer → Account → Notifications)
```
GET   /members/me/notifications                     → NotificationPrefs
PATCH /members/me/notifications { push?, remind?, wa?, receipt?, offers? } → NotificationPrefs

NotificationPrefs
  push          bool
  remind        bool
  wa            bool
  receipt       bool
  offers        bool            // flattened for the switch to bind to
  offersConsent {
    granted       bool
    at            datetime | null  // when the latest event was recorded
    source        string | null  // "wallet_account", "signup", …
    policyVersion int | null     // the terms in force when she agreed
  }
```
Rules:
1. **Four of the five are server-owned, not client-owned.** `wa` and `receipt` gate messages
   the *server* sends — the receipt outbox does not consult a handset before it queues.
   Holding them only on the client means a local "off" that does not stop a receipt, which is
   a false statement made to the customer, not a lost setting. `push` and `remind` are stored
   server-side too, so a reinstall does not silently re-enable what she turned off.
2. **`offers` is marketing consent and is stored as an append-only event**, not a boolean.
   Non-negotiable #8 needs it readable on the platform send path, and a boolean cannot answer
   *when* she agreed, under which terms, or whether she had withdrawn it before. The boolean on
   the wire is a projection of the latest event; `offersConsent` carries the evidence.
3. An event is written **only when the answer changes.** Re-sending the same value is a client
   re-rendering a screen, not the customer consenting again.
4. An unknown switch name is rejected by name, not ignored.

#### Account deletion (customer → Account → Delete my account)
```
GET    /members/me/deletion               → DeletionState
POST   /members/me/deletion  { password } → DeletionState
DELETE /members/me/deletion               → DeletionState

DeletionState
  requestedAt      datetime | null
  erasureDueAt     datetime | null   // requestedAt + graceDays
  status           "none" | "pending"
  graceDays        int               // 30 — the number the privacy policy promises
  erasureScheduled bool              // false: the clock is real, the job is not built
```
Rules:
1. **Deletion is an erasure of personal data, not a row delete.** The published policy set says
   transaction records are kept 7 years *and* the rest is deleted within 30 days, so two
   retention periods cover one customer. `transaction`, `ledger_entry` and `audit_log`
   reference her with restrict/append-only, so the database would refuse a `DELETE` anyway.
2. **`password` is required on `POST`.** It is the most destructive thing the wallet offers and
   an unlocked handset on a salon counter is the threat. Same reasoning as
   `POST /members/me/password` demanding `current`.
3. **`POST` is idempotent and must not restart the clock.** Asking twice is one request; a
   mis-tapped button may not quietly extend the 30 days.
4. **A non-zero balance is refused** — `409 balance_outstanding`, carrying `balanceFils`. Her
   wallet is prepaid credit the salon owes her (non-negotiable #5), and erasing the account
   that names the money while the money is owed is the one outcome nobody can undo.
5. **A settled top-up CANCELS a pending deletion request**, in the same transaction as the
   credit. Rule 4 is checked once, at request time, so `deletion_requested_at` over a positive
   `balance_fils` was otherwise reachable — the state the 409 exists to prevent, arrived at
   from the other direction, with a 30-day clock running towards erasing a funded wallet.
   Paying money in is an unambiguous statement that she intends to keep using the wallet, and
   it is later and costlier than the deletion request. Blocking the top-up instead would refuse
   her money to protect a request she has evidently changed her mind about. Audited as
   `Account deletion cancelled` with `reason: "topup_after_deletion_request"`; she discovers it
   from `GET /members/me/deletion` answering `none`. **A proactive notice is owed and not
   sent** — there is no customer notification sender yet, so the audit row carries
   `customerNoticeOwed: true` rather than implying she was told.
6. **Sessions are NOT revoked**, deliberately. The 30 days are a grace window, and an account
   she is locked out of the moment she asks is one she cannot change her mind about. `DELETE`
   is that door, and `GET` is the sign on it — a grace window she cannot see is a grace window
   she cannot use.
7. `erasureScheduled` is `false` until the erasure job exists. Which columns are nulled at the
   due date, and which survive the 7-year financial record, is a retention decision that
   belongs to the client. A response implying the erasure had been carried out would make the
   confirmation screen say something untrue.

#### Staff member lookup (scanner → "Can't scan? Find member manually")
```
GET /members?q={query}   scanner scope + perms.scanner
  → { items: MemberSearchRow[], nextCursor: string | null }

MemberSearchRow
  id         string
  salonId    string
  name       string
  phoneLast4 string          // NOT the whole number
  tier       string | null

GET /members/{id}        scanner scope + perms.scanner
  → the SAME envelope as POST /scans:
    { member: Member, heldDepositFils, heldDepositBooking, services[] }
```
**`GET /members/{id}` is the last step of the manual path, and it returns the scan
envelope rather than a bare `Member` on purpose.** The QR and the manual lookup are two
doors onto one screen — the same name, balance, held deposit and service list to charge
against — so one server-side builder serves both (`api/src/services/counter.ts`). Two
hand-assembled copies is how `heldDepositFils` came to be hardcoded to `0` on the scan path
while the charge path read it for real, showing the customer a credit line the charge then
did not apply.

Rules specific to the resolve:
1. **Salon-predicated in the `WHERE`**, and a member of another salon is `404 unknown_member`
   — byte-identical to an id that does not exist. A distinct `403` would confirm the id is
   real, making this an oracle for "is 8842 a customer somewhere in AVO".
2. **It counts against the same directory-read ceiling as the search** (see rule 4 below).
   A resolve discloses strictly more than a search row — full phone, email, balance, visits —
   so metering it separately, or not at all, would reopen the enumeration path from a second
   door: exhaust the search budget, then walk ids here.
3. **The audit row names the customer** (`Customer opened`), unlike the search row, and is
   written **whether or not she was found and before the 404 is thrown**. An attempt on an id
   that is not in this salon is the most interesting line in the log — it is what a directory
   walk looks like from the inside — and a log of successful reads only would omit exactly
   that evidence.
**This is not `Member`, and parsing it as `Member` will fail — correctly.** A disambiguation
list is not a profile: it carries no balance and no email, and the phone is the last four
digits only. A balance in a list is a balance readable over a shoulder for every customer
whose name shares a prefix, and it answers no question the list is asking.

Rules:
1. **Salon-scoped in the `WHERE`,** not filtered afterwards — this is the endpoint class where a
   missing tenant predicate hands one salon's client book to another. A row from another salon
   is never read, so a later mistake in the mapping cannot leak it.
2. **Matches name (substring, case-insensitive), phone (digits only, substring) or member id
   (exact, case-insensitive).** The id is exact on purpose: ids are short, dense and
   sequential, so a substring match there turns the minimum-length rule into a directory walk.
   A staff member reading a number off a card has the whole number.
3. **Minimum query length 2.** One character returns the salon. `LIKE` metacharacters are
   escaped, so `%` searches for a percent sign rather than requesting the whole book.
4. **Rate-limited in two tiers**, both counted over the audit rows themselves so the counter and
   the promise cannot disagree:
   - **burst, per staff session** — 60 per 5 minutes → `429 lookup_rate_limited`
   - **ceiling, per staff member** — 240 per rolling 60 minutes → `429 lookup_hourly_limit`

   **Both tiers count searches AND resolves together**, because the thing being protected is
   the customer directory, not one endpoint.

   The per-session tier alone was not a limit: a session is not scarce, and the PIN limiter
   counts only *failed* attempts, so signing in again minted a fresh budget indefinitely. The
   per-actor tier is keyed on `audit_log.actor_id` and **nothing else** — no session, no device
   — so it cannot be reset by a new session, a new tablet or a new token. The ceiling is checked
   first, because "wait a moment" is the wrong thing to tell someone who must wait an hour.

   **The numbers are measured, not estimated.** Replaying `LookupScreen`'s debounce (300ms,
   reset per keystroke, minimum 3 characters) at realistic typing speeds and counting the audit
   rows the server wrote: a customer costs **2 requests** for a fluent typist and **5** for a
   deliberate one (4 searches + 1 resolve), because an `abort()` stops the client waiting but
   does not un-send a request the server has already handled. One front desk with a broken
   camera can serve ~20 customers an hour, so the worst realistic hour is ~100–140 requests.
   240 is 1.7× that; the earlier 60 would have fired at **twelve** customers an hour, at a
   counter with a customer standing there.

   Being honest about the limit's reach: it bounds bulk extraction at machine speed and
   guarantees attribution — it does not stop a determined insider reading her own salon's book
   slowly, and the tenant predicate is what confines her to it.
5. **Every lookup writes an audit row naming the staff member**, whether or not anything
   matched. The design promises the *customer* "Manual lookups are logged with your name", and
   only the server can keep that promise. The **query** is recorded; the **results** are not —
   copying matched customers into an append-only seven-year log would build a second customer
   list inside the audit trail.
6. `perms.scanner`, the same permission as `POST /scans`: this is the fallback for a scan that
   cannot happen, not a wider capability. A staff member who may not scan may not look a
   customer up by name instead. A dashboard-scope token is refused.

### WalletToken (the rotating QR payload)
```
memberId  string
token     string      // rotates server-side every 45s
expiresAt datetime
```
- `GET /members/me/wallet-token` → issue. Client refreshes at `expiresAt`.
- **The client never mints the token.** Rotation and single-use consumption are
  server-enforced; the countdown in the UI is cosmetic.
- Encoded QR string: `avo://pay?m={memberId}&t={token}`.

### Transaction
```
id           string
memberId     string
branchId     string
kind         "topup" | "charge" | "deposit_hold" | "deposit_return" | "shop" | "adjustment"
amountFils   int          // signed: credit positive, debit negative
bonusFils    int          // tier bonus portion of a topup, 0 in stamps mode
method       "knet" | "card" | "applepay" | "wallet" | null
status       "pending" | "settled" | "failed" | "cancelled"
reference    string       // gateway ref, shown to the customer on failure
createdAt    datetime
```

### TopUpIntent
```
id            string
memberId      string
amountFils    int          // what the customer pays
bonusFils     int          // funded by the merchant
creditFils    int          // amountFils + bonusFils — what lands in the wallet
method        "knet" | "card" | "applepay"
feeFils       int          // AVO commission, shown to the merchant not the customer
status        "created" | "redirected" | "pending" | "succeeded" | "failed" | "cancelled"
failureReason "declined" | "expired" | "cancelled_by_user" | "gateway_error" | null
redirectUrl   string       // gateway hosted page
reference     string
```
**Flow:** `POST /topups` → open `redirectUrl` → gateway returns to
`avo://topup/return?intent={id}` → `GET /topups/{id}` for the authoritative status.

Client rules, in order of importance:
1. **The return URL is a hint, not a result.** Always re-read `GET /topups/{id}`.
2. Treat `pending` as its own screen — never as a failure, never as a success. Do not
   offer "retry" from `pending`; that is how double charges happen.
3. `POST /topups` takes an **idempotency key**. Reuse it on retry of the same attempt.
4. Balance is only ever read from the server. Never add `creditFils` locally.

### Booking
```
id           string
memberId     string
artistId     string
branchId     string
serviceId    string
startsAt     datetime
durationMin  int
depositFils  int
status       "deposit_held" | "completed" | "no_show_returned" | "cancelled"
source       "app" | "google_calendar"
```
- Deposit is held at confirmation, **auto-returned** `noShowReturnMinutes` after a missed
  slot. The return is a `deposit_return` Transaction — money never leaves the ecosystem.
- **Reschedule carries the deposit** to the new slot rather than returning and re-holding it.
  `POST /bookings/{id}/reschedule` `{ startsAt }` — a **contract addition**: README § Upcoming
  appointment specifies the behaviour ("Reschedule (carries the deposit to a new slot)") and
  names no endpoint. A sub-resource POST rather than `PATCH /bookings/{id}`, because a
  reschedule is a **transition with rules** — the change window, slot re-validation, the
  deposit carry — not a field assignment; a PATCH that accepted `startsAt` invites one that
  accepts `status` or `depositFils` next. Refusals: `not_reschedulable` (409, outside the
  change window or not in `deposit_held`), `same_slot` and `not_a_slot` (400),
  `invalid_starts_at` (400), and `slot_taken` (409) from the **same exclusion constraint** that
  guards `POST /bookings` — two customers moving into one slot is the same race as two booking
  it, so it is caught in the database on the UPDATE, not in application code.

### Artist
```
id             string
salonId        string
name           string
availabilitySource "google" | "manual"
googleConnected bool
slotMinutes    int                 // 15 | 20 | 30 | 45 | 60
windows        { [dayOfWeek: 0-6]: { open: bool, from: "HH:mm", to: "HH:mm" } }
```
- Artists do **not** need an AVO login. Google connect is one-time and read-only for busy
  slots; new AVO bookings write back to their calendar.
- Owner/receptionist can edit `windows` on the artist's behalf (Merchant → Team).

### Availability (computed, never stored)
```
GET /artists/{id}/availability?date=YYYY-MM-DD
→ { slots: [{ time: "16:45", available: bool, reason?: "busy" | "booked" | "closed" }] }
```
Business hours **minus** Google busy blocks **minus** existing bookings. The UI strikes
through unavailable slots rather than hiding them.

### Product
```
id, salonId, name, priceFils
```
Catalog only — **no stock counts**, deliberately. A purchase earns a visit/stamp.

### StaffUser
```
id, salonId, name, handle, role: "owner" | "manager" | "frontdesk" | "artist" | "scanner"
branchAccess: "all" | branchId[]
pinSet: bool
perms: {
  dashboard, appointments, shop, loyalty, team,
  scanner,      // can scan & charge
  charges,      // can open Today's charges on the scanner   <- senior permission
  void,         // can reverse a charge within 15 min        <- implies charges
  marketing     // can submit a campaign for AVO approval
}
```
`perms` is **set in the merchant dashboard (Accounts → Team) and read by the staff
scanner** — the same shared object as the promotion set. `GET /staff/me` returns it on
PIN sign-in and the client must re-read it on change; a scanner that has `charges: false`
shows a locked screen naming who can grant it, and `void` is meaningless without
`charges`. Enforce both server-side: `GET /charges?date=today` and `POST /voids` reject
on the permission, not on the UI state.
Staff scanner authenticates by **4-digit PIN scoped to a device+salon**. PIN is not a
password: rate-limit it, lock after N failures, and never let it reach dashboard scopes.

### Promotion set (boosts + happy hours) — ONE source of truth
```
GET  /v1/salons/{id}/promotions
PUT  /v1/salons/{id}/promotions/boosts
POST /v1/salons/{id}/promotions/happy-hours
PATCH/DELETE /v1/salons/{id}/promotions/happy-hours/{hid}

{
  boosts: { [branchId]: { visit: 1..3, topup: 0..30, stamp: 1..3 } },
  boostsPublishedAt: iso, boostsPublishedBy: string,
  happy: [{
    id, branchId: branchId | "all",
    days: number[],              // JS getDay(): 0 = Sunday
    from: "HH:MM", to: "HH:MM",  // salon-local, 24h
    reward: "x2stamp"|"x3stamp"|"x2visit"|"topup10"|"topup20"|"credit3",
    on: bool, notify: bool
  }]
}
```
The **customer wallet and the merchant dashboard read the same object.** Never duplicate
boost or happy-hour values in a client — the wallet's "2× visits / +10% top-ups" chips and
the dashboard's steppers are two views of `boosts`.

**There is no `live` flag.** A window is live if and only if
`days.includes(now.getDay()) && from <= now < to` in salon-local time. Both clients
resolve it every second and render a real countdown; the banner disappears on its own at
`to` with no push, no poll and no server tick. Server-side, the same predicate gates the
earning multiplier at charge time — a client that shows a stale banner cannot cause a
wrong charge. `notify: true` fires exactly one push per window per member at `from`,
suppressed inside platform quiet hours.

Reference implementation of the whole contract — read/subscribe, clock resolution,
countdown formatting, approval state machine: `avo-promotions.js` in this bundle.

### Campaign (merchant-authored, AVO-approved)
```
id, salonId, salon
title, body
channel: "push" | "wa" | "both"
audience: "all" | "lapsed" | "lowbal" | "gold" | "new"
branchId: branchId | "all"
reward: rewardKey | "none"
reach: int                       // server-computed, never trusted from the client
when: "now" | "later" | "recurring"
scheduledAt: iso | ""
status: "pending" | "approved" | "rejected" | "sent"
submittedBy, submittedAt
decidedBy, decidedAt, note       // note is shown verbatim to the merchant
result: string                   // "612 reached · 148 booked"
```
```
POST  /v1/salons/{id}/campaigns            → status "pending" (never "sent")
DELETE/v1/salons/{id}/campaigns/{cid}      → merchant withdraw, pending only
POST  /v1/platform/campaigns/{cid}/decision  { status, note }   // owner console
GET   /v1/platform/campaigns?status=pending
```
**A merchant cannot send.** `POST /campaigns` only ever creates a `pending` row; delivery
is queued by the platform decision endpoint. Rejections must carry a `note` — the
merchant sees it under the campaign in Marketing → Campaigns. Withdraw is allowed while
pending and nowhere else.

### PlatformMessagingPolicy (owner console → Approvals)
```
requireApproval: bool          // off = salons send unreviewed; default ON
weeklyCapPerCustomer: 1..7     // hard cap across ALL salons, enforced server-side
monthlyCapPerSalon: 1..30      // counts approved + sent
quietFrom: "22:00", quietTo: "09:00"
```
Caps and quiet hours are enforced at **send** time, not at approval time: an approved
campaign that would breach a cap is held, not dropped, and reported back to the salon.
A merchant can never **raise** these values — the write is `requirePlatform`-only, and that
is the half of non-negotiable #8 with teeth.

**A merchant MAY read the effective policy** via `GET /v1/salons/{id}/messaging-policy`
(`perms.marketing`, same-salon). *This line previously said she could never read them either,
and the API departed from it deliberately:* quiet hours and caps are constraints she is
**subject to**, not secrets, and telling a salon when her messages will not send helps her
comply. A number she cannot verify is worse than one she can. Reading a ceiling is not raising
it. `requireApproval` is included on purpose — with approval off her campaign goes out
unreviewed, which changes what she should expect after pressing submit; that is a fact about
her own workflow, not an internal control.

Both surfaces read through **one function** (`readMessagingPolicy`), so the merchant's screen
and the console's stepper cannot disagree — the same one-object-two-surfaces rule
`readPromotionSet` exists for.

### LegalDocumentSet (owner console → Policies)
```
GET   /v1/platform/policies                    → { published, draft }
PATCH /v1/platform/policies/draft/{docId}      → title / body / consent / order
POST  /v1/platform/policies/draft              → new document
DELETE/v1/platform/policies/draft/{docId}
POST  /v1/platform/policies/publish            { effectiveFrom }
POST  /v1/platform/policies/discard

published: {
  version: int, effectiveFrom: "YYYY-MM-DD",
  publishedAt: iso, publishedBy: string,
  docs: LegalDoc[]
}
draft: { docs: LegalDoc[] }

LegalDoc {
  id, scope: "platform" | "wallet",
  consent: bool,                       // linked at signup, blocks account creation
  title: { en, ar },
  body:  { en: string[], ar: string[] }   // one string per clause, rendered in order
}
```
The **customer app holds no legal copy of its own** — Account → Wallet & policies renders
`published.docs` in array order, in the customer's language, and the signup consent row
links exactly those with `consent: true`. Editing writes to `draft`; **nothing reaches a
phone until publish**, which bumps `version`, stamps `publishedBy/At`, and must be written
to the platform audit log. Set `effectiveFrom` at least **30 days out for a material
change** — the terms themselves promise that notice.

Clients cache the published set and re-fetch on version change; show the version and
effective date in the document header (`Last updated 1 July 2026 · v3`) so support can
tell which wording a customer actually agreed to. Store the accepted `version` against
the member record at signup — that, not the current text, is what they consented to.

Both languages are authored here. An empty `body.ar` is a legitimate state (document not
yet translated) and the client falls back to `en`; do not ship a consent document that
way.

### SupportConfig + SupportTicket (owner console → Policies → Support)
```
GET   /v1/platform/support                     → SupportConfig
PATCH /v1/platform/support/channels            { whatsapp | email | hoursEn | hoursAr | replyEn | replyAr }
POST  /v1/platform/support/topics              { en }              → topic
PATCH /v1/platform/support/topics/{id}         { en | ar | route | order }
DELETE/v1/platform/support/topics/{id}

SupportConfig {
  channels: {
    whatsapp: string,           // E.164, shown LTR in both languages
    email: string,
    hoursEn, hoursAr: string,   // shown under the Contact us row
    replyEn, replyAr: string    // reply-time promise on the confirmation screen
  },
  topics: SupportTopic[]        // rendered in array order
}

SupportTopic {
  id: string,
  route: "salon" | "avo",       // which queue the message lands in
  en, ar: string                // label the customer picks
}
```
**AVO owns this, not the salon** — a merchant cannot point customers at an unmonitored
number. Channels and topics are live on save; unlike legal documents there is no
draft/publish step, because nothing here is a legal representation.

```
POST /v1/support/tickets
  { topicId, message, ref?, via: "wa" | "email" }
  → SupportTicket
GET   /v1/support/tickets?route=&status=        // staffed queues
PATCH /v1/support/tickets/{id}                  { status }

SupportTicket {
  id: string,                   // "SUP-48263" — the customer's reference, show it verbatim
  memberId, member: string,
  topicId: string,
  route: "salon" | "avo",       // resolved server-side from the topic, never sent by the client
  message: string,
  ref: string,                  // optional receipt/transaction reference the customer attached
  via: "wa" | "email",          // reply channel the customer chose
  at: iso, status: "open" | "closed"
}
```
Rules:
1. **Resolve `route` on the server** from `topicId`. A client-supplied route is a way to
   land a wallet dispute in a salon's inbox.
2. `route: "salon"` goes to the salon's queue **and the branch's WhatsApp**; `route: "avo"`
   goes to platform support. Salon-routed tickets are visible to the merchant; AVO-routed
   ones are not.
3. A ticket with `topicId` in the money set (wallet, unrecognised charge) and a `ref` that
   matches a Transaction should link them — support answering a dispute needs the receipt.
4. Echo the ticket `id` back on the confirmation screen and in the acknowledgement message.
   It is the only handle the customer has.
5. Rate-limit per member. Deduplicate an identical message inside 5 minutes rather than
   opening a second ticket.
6. Tickets are customer correspondence, not marketing — the acknowledgement sends
   regardless of the offers consent flag.

### PlatformAdmin (owner console)
```
id, name, username, role: "founder" | "admin" | "analyst"
permissions: { [section: "analytics"|"activity"|"reports"|"salons"|"accounts"|"admins"|"approvals"|"billing"|"audit"|"controls"]: bool }
```

---

## Operations the prototypes imply

| Surface | Action | Endpoint |
|---|---|---|
| Customer | Home bootstrap | `GET /members/me?include=wallet,loyalty,upcoming,activity` |
| Customer | Edit profile | `PATCH /members/me` |
| Customer | Change phone | `POST /members/me/phone-change` (+ `/verify`) |
| Customer | Change password | `POST /members/me/password` |
| Customer | Rotate QR | `GET /members/me/wallet-token` |
| Customer | Start top-up | `POST /topups` (idempotency key) |
| Customer | Confirm top-up | `GET /topups/{id}` |
| Customer | Availability | `GET /artists/{id}/availability?date=` |
| Customer | Book | `POST /bookings` → holds deposit |
| Customer | Cancel | `DELETE /bookings/{id}` |
| Customer | Reschedule | `POST /bookings/{id}/reschedule` `{ startsAt }` — deposit carries |
| Customer | Shop checkout | `POST /orders` (pays from wallet) |
| Staff | PIN sign-in | `POST /staff/session` |
| Staff | Resolve QR | `POST /scans` `{ token }` → Member + heldDeposit |
| Staff | Charge | `POST /charges` `{ memberId, serviceIds[], token }` (idempotency key) |
| Staff | Own bookings | `GET /artists/me/bookings` |
| Staff | Own hours | `PUT /artists/me/availability` |
| Merchant | Overview | `GET /salons/{id}/metrics?period=` |
| Merchant | Appointments | `GET /salons/{id}/bookings?status=` |
| Merchant | Team hours | `PUT /artists/{id}/availability` |
| Merchant | Settings | `PATCH /salons/{id}` |
| Merchant | Social links | `PATCH /v1/salons/{id}/social/{linkId}` |
| Merchant | Reports | `GET /salons/{id}/reports/{kind}.csv?branch=&period=` |
| Merchant | Read promotions | `GET /v1/salons/{id}/promotions` |
| Merchant | Publish boosts | `PUT /v1/salons/{id}/promotions/boosts` |
| Merchant | Add / edit happy hour | `POST` / `PATCH` / `DELETE .../happy-hours` |
| Merchant | Submit campaign | `POST /v1/salons/{id}/campaigns` |
| Merchant | Withdraw campaign | `DELETE /v1/salons/{id}/campaigns/{cid}` |
| Merchant | Set staff authority | `PATCH /staff/{id}` `{ perms }` |
| Customer | Read promotions | `GET /v1/salons/{id}/promotions` (same object) |
| Staff | Own authority | `GET /staff/me` → `perms` |
| Staff | Today's charges | `GET /charges?date=today` (requires `perms.charges`) |
| Owner | Platform metrics | `GET /platform/metrics` |
| Owner | Salon editor | `PATCH /salons/{id}` |
| Owner | Wallet adjust | `POST /members/{id}/adjustments` |
| Owner | Reset link | `POST /accounts/{id}/reset-link` |
| Owner | Approval queue | `GET /v1/platform/campaigns?status=pending` |
| Owner | Decide a campaign | `POST /v1/platform/campaigns/{cid}/decision` |
| Owner | Messaging policy | `GET` / `PATCH /v1/platform/messaging-policy` |
| Merchant | Read effective messaging policy | `GET /v1/salons/{id}/messaging-policy` (`perms.marketing`; read only) |
| Owner | Read / edit legal docs | `GET` / `PATCH /v1/platform/policies` |
| Owner | Publish legal docs | `POST /v1/platform/policies/publish` |
| Customer | Legal documents | `GET /v1/platform/policies` (published only) |
| Customer | Support channels + topics | `GET /v1/platform/support` |
| Customer | Send a message | `POST /v1/support/tickets` |
| Owner | Edit support channels / topics | `PATCH /v1/platform/support...` |
| Owner / Merchant | Support queue | `GET /v1/support/tickets?route=` |
| Owner | Platform controls | `PATCH /platform/settings` |

## Charging — the one flow to get exactly right

`POST /charges` must be a single server-side transaction that:
1. validates and **consumes** the QR token (single use),
2. applies any held deposit as a credit line,
3. debits the wallet — rejecting if the remainder exceeds balance,
4. increments visits **or** stamps per `salon.loyaltyMode`,
5. evaluates a tier climb / stamp-target reward,
6. queues the WhatsApp receipt.

Partial application is not acceptable. If step 3 fails, nothing else happened, and the
scanner shows "Balance too low by X" with the customer's shortfall.

## Commission (merchant-visible, customer-never)
- KNET: **150 fils flat** per top-up.
- Card / Apple Pay: **2.5% + 50 fils**.
- Configurable per platform in Owner → Controls; display in Merchant → Settings.

---

## Addendum — idempotency key reused with a different body

`api-contract.md` was silent on this and two lanes implemented opposite behaviours:
Lane A returned **422**, Lane D's spec expected the first result replayed.

**Ruling: 422 Unprocessable Entity.** Replaying the first result is wrong because the
client asked for something *different* and would be told it succeeded — a customer who
retries a 5 KD top-up as 50 KD would be shown a 5 KD success and never learn the 50 never
happened. That is a silent money bug, which is worse than an error.

This matches the IETF `Idempotency-Key` header draft and how Stripe behaves.

The rule, precisely:

- Same key, **same** body → replay the stored result. This is the retry case idempotency
  exists for.
- Same key, **different** body → `422`, with a message naming the mismatch. Do not
  execute, do not replay.
- Fingerprint the body when the key is first stored, and compare on replay.

Lane D's spec must change to match; Lane A's implementation stands.

---

## Addendum — the customer never sees the commission

`AVO Wallet Home.dc.html` shows `knetFee: '150 fils fee'` and `cardFee: '2.5% + 50 fils'`
under the payment methods (line 1239, and translated at 1346), plus a `Processing fee` row
in the transaction detail sheet. Those contradict § Commission above and the product brief.

**Ruling: do not build them. The customer never sees the commission.** Three independent
reasons, strongest last:

1. **It would be false.** `creditFils = amountFils + bonusFils` — the fee is not deducted.
   A customer topping up 10.000 KD receives 10.000 plus her tier bonus and pays no fee. The
   merchant absorbs the commission, exactly as it funds the tier bonus. A "150 fils fee"
   line states a charge she does not pay.
2. **It would suppress KNET**, which the product deliberately makes first and default as
   "Most used in Kuwait". A phantom fee on the default rail works against the business, and
   the amount landing in her wallet is identical whichever rail she picks.
3. **It is not what AVO does.** Checked against `AvoMobileApps-Lean`, a live AvoRewards
   tenant: **zero** fee or commission strings in source or in either localisation file. The
   top-up modal takes an amount and sends it; the success screen shows amount, payment id,
   transaction id and date, and no fee. Across roughly ten tenants running for years, no
   AVO customer app has ever displayed the commission.

The design strings are a leftover from an earlier model. Commission stays merchant-facing:
Merchant → Settings displays it, Owner → Controls configures it.

**Reverse this only if** the money model changes so the customer pays the processing fee —
she pays 10.150 to have 10.000 credited. That is a different product, and it would require
redefining `creditFils`, not just adding a label.

**Confirmed by the product owner, 17 Aug 2026.** Asked directly whether the salon or the
customer absorbs the KNET fee:

> "usually that happens through our payment provider MyFatoorah … where in their system we
> put the amount we are going to take and what goes to salon. The customer doesn't see this
> of course, they just see the price."

So the split is configured **at the PSP**, not computed by this API. That has a consequence
for `feeFils`: it is a **record of the split MyFatoorah will apply**, not an amount this
system moves. Reconciliation must therefore match our `Transaction` rows against
MyFatoorah's split reporting, not against a single gross settlement figure.

---

## Addendum — Reports, and seven departures from the drawn export

`GET /salons/{id}/reports/{kind}.csv?branch=&period=` is the row in § Operations. Implemented
alongside a **JSON sibling** `GET /salons/{id}/reports/{kind}` — one aggregate rendered two ways,
so the card on screen and the file on disk cannot disagree. `kind` is one of `customers`, `sales`,
`best-selling-services`, `products-sold`, taken from the design's own export filenames. `period`
reuses the `7d` / `30d` / `90d` vocabulary of `GET /salons/{id}/metrics`.

**Permissions.** A report inherits the permission of the section it exports — `customers`→`team`,
`sales`→`dashboard`, `best-selling-services`→`appointments`, `products-sold`→`shop`. The design
draws nine chips and Reports is not one of them, and none of the nine is a customer-data
permission, so this is an interim rule that errs restrictive rather than a settled answer.
`DECISIONS.md` carries the reasoning and the reversal; **"who in a salon may export customer PII"
is queued for the client.** A blanket `dashboard` gate was rejected: it would hand every
front-desk tablet every customer's name, phone and wallet balance.

**Seven departures from the drawn export, each with its reason.**

1. **`Username` → `Phone`.** No member username column exists, and sign-in identity is already
   phone by standing decision. Phone is what the design's own Customers tab shows.
2. **No `Branch` column on `customers`.** A member deliberately has no branch. `?branch=` still
   applies to that report, read as *"transacted at that branch"*.
3. **ISO dates, not `06 Jul`.** A 90-day export crosses a year boundary, and a date without a
   year in a file that gets archived is ambiguous later.
4. **No thousands separator in CSV money.** `"1,820.000"` is parsed by Excel as **text**, in a
   file whose entire purpose is being opened in Excel. The JSON sibling carries integer fils.
5. **`?branch=` is a branch id** (or `all`), not the branch name the segmented control renders.
6. **Tier exports as the domain value** (`silver`), not the design's pill capitalisation.
   Presentation belongs to the client.
7. **A foreign branch answers 404, not an empty report.** An empty report reads as *"no sales
   there"*, which is a different and false claim.

**Dates are grouped in the salon's IANA zone, not UTC** — a 21:30Z charge belongs to the next
Kuwait day, and grouping by UTC splits one trading day into two rows.

**CSV cells are neutralised against formula injection.** Quoting is **not** protection: the
parser strips quotes before the cell is interpreted, so a value beginning `=`, `+`, `-` or `@`
takes an apostrophe prefix. Files are UTF-8 with a BOM and CRLF, served `cache-control: no-store`.

**One real limitation, recorded rather than hidden.** `best-selling-services` ranks **booked**
services only. Charges record their basket as a **sha256** (`charge_basket_hash`), so a walk-in
service sale is not attributable to a service. That is consistent with the card's own stat label
— "bookings" — but it is not the same as *all* service sales, and anyone reading the number for
revenue attribution should know it.
