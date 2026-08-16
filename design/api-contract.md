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
A merchant can never read or raise these values.

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
| Owner | Messaging policy | `PATCH /v1/platform/messaging-policy` |
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
