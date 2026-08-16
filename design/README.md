# Handoff: AVO Beauty — Wallet + Loyalty Platform (iOS, Android & Web)

## Overview

AVO Beauty is a **white-label stored-value wallet + loyalty platform** for salons and spas in Kuwait / GCC. Customers top up a wallet, pay in-salon by showing a rotating QR code, and climb loyalty rewards with every visit. Booking and retail are optional modules a merchant can switch on.

There are **three separate apps, each with its own login**:

1. **Customer app** — mobile, web-first wallet (top up, pay via QR, shop, loyalty). → ship as **iOS + Android**.
2. **Staff scanner app** — mobile, scan-and-charge only, PIN sign-in. → ship as **iOS + Android**.
3. **Merchant dashboard + Owner console** — desktop web admin surfaces.

All four surfaces read one **shared promotions + authority endpoint** (`avo-promotions.js`) — boosts, happy hours, campaign approvals and staff permissions have a single source of truth, not a copy per app.

This bundle contains the design references for all of them. The full product brief is included as `AVO-Beauty-Product-Description-v2.md` — read it first; it is the source of truth for behavior, business rules, and settled decisions.

**Read in this order:**
1. `CLAUDE.md` — the working agreement for whoever (or whatever) builds this
2. `AVO-Beauty-Product-Description-v2.md` — what the product is and what's already decided
3. `api-contract.md` — entity shapes and the rules behind top-up and charge
4. `build-plan.md` — the phase order and what "done" means per phase
5. `interaction-spec.md` — breakpoints, focus, keyboard, motion, and the state rules
6. The `.dc.html` screens — layout, copy, and interaction
7. `whatsapp-templates.md` — the four customer messages (submit for approval early)
8. `go-live-checklist.md` — everything that must be true before launch

---

## About the Design Files

The `.dc.html` files in this bundle are **design references authored in HTML** — interactive prototypes that demonstrate the intended look, layout, copy, and behavior. **They are not production code to copy directly.**

The task is to **recreate these designs in the target codebase's native environment**:
- **Customer app & Staff scanner** → native **iOS (SwiftUI)** and **Android (Jetpack Compose)**, or React Native / Flutter if that's the chosen stack. Use the platform's established navigation, component, and state patterns.
- **Merchant dashboard & Owner console** → the web app's existing framework (React/Vue/etc.).

If no environment exists yet, choose the most appropriate framework per surface and implement the designs there. Match the visual spec below pixel-for-pixel; use the target platform's idioms for structure and interaction.

> **How to open the references:** each `.dc.html` opens directly in a browser. They are laid out on a pannable canvas (zoom/scroll). The mobile screens are shown inside an iPhone frame; the web screens inside a browser-window chrome. These frames are presentation scaffolding only — **do not reproduce the device bezel or browser chrome** in the real apps.

---

## Fidelity

**High-fidelity (hifi).** Final colors, typography, spacing, copy, and interactions. Recreate the UI pixel-perfectly. Interactions in the prototypes (toggles, steppers, tab switches, QR enlarge, cart checkout, CSV export, EN/AR RTL flip) are all live and reflect intended behavior.

---

## Design System (shared across all surfaces)

### Colors

| Token | Hex | Use |
|---|---|---|
| Ink / text | `#1C1B19` | Primary text, dark sidebar (owner console), dark device frame |
| Brand (Amara sage) | `#6E7F6C` | Wallet card gradient, tints, dots, progress, toggle-on — **surface only**. This is the white-label `--brand` token |
| Brand deep | `#5A6B58` | **Primary buttons and every other white-text fill** (4.27:1 vs 5.71:1 — see §2), plus brand text on light |
| Brand deep | `#5A6B58` / `#4F5E4C` | Links, link hover, brand text on light |
| Canvas | `#EBE8E1` | Page ground behind frames |
| Surface | `#FBFAF8` | App background (warm off-white) |
| Surface alt | `#F6F4EE` / `#F0EEE9` | Cards, merchant sidebar, segmented-control track |
| Brand tint | `#EEF1EC` | Info banners, chips, avatar backgrounds, pills |
| Brand tint 2 | `#F6F7F3` | Example/help note backgrounds |
| Hairline border | `rgba(28,27,25,0.08)` | Card borders (also `0.06` / `0.07` for inner dividers) |
| Muted text | `rgba(28,27,25,0.5)` | Secondary text (also `0.45`, `0.55`, `0.7` for scale) |
| Success dot | `#25D366` | "Link sent" / WhatsApp indicator |
| Error / danger | `#B0736F` (dot), `#8f5a56` (text), `#F6EAE8` (bg) | Validation, suspend, no-show |
| Warm alt (green delta) | `#5E7157` | Positive delta text |

**White-label presets** (one `--brand` token restyles everything): Amara sage `#6E7F6C`, Noor rose `#B08D8D`, Lila lilac `#8A7CB0`. All three are shown applied to the signature wallet card in `AVO States.dc.html`.

> **White text never goes on `--brand`.** All three presets — including the default sage — fail 4.5:1 with white. Buttons and any white-on-colour fill use the derived `--brand-deep`. White-label onboarding must *derive and validate* that variant rather than accepting any hex. Rule and ratios: `interaction-spec.md` §2, `tokens/avo-tokens.json` → `$rules.brandFill`. **Applied across all six design files** — every white-text fill uses `#5A6B58`; `#6E7F6C` remains only as a surface colour.

**Machine-readable tokens:** `tokens/avo-tokens.json` (all colors, type ramp, radii, shadows, motion) and `tokens/avo-tokens.css` (the same as CSS custom properties). Import these rather than re-typing hexes — the table below is the human-readable view of the same data.

**Plan pills:** Pro `#EAE2D6`/`#8a6d3b`, Growth `#EEF1EC`/`#5A6B58`, Starter `#F0EEE9`/`rgba(28,27,25,0.6)`.

**Tier pills / dots:** Bronze `#B08D57`, Silver `#B7BEC4`, Gold `#C9A24B`, Black `#3A3A3A`. Pill backgrounds: Gold `#F3E9CF`/`#8a6d3b`, Silver `#ECEEF0`/`#5f6b73`, Black `#E3E1DC`/`#3A3A3A`, Member `#EEF1EC`/`#5A6B58`.

### Typography

- **Fraunces** (serif, weights 400/500/600, optical sizing) — display numerals, headings, balances, prices. Letter-spacing `-0.01em` on large headings.
- **Inter** (400/500/600/700) — all UI text, labels, body.
- **IBM Plex Sans Arabic** (400–700) — Arabic (AR / RTL) mode in the customer app only.
- Uppercase micro-labels: 11px, weight 600, `letter-spacing: 0.06–0.09em`, `text-transform: uppercase`, muted color.
- **Money:** KWD with **3 decimals** (fils), e.g. `18.000`, `32.500`. Western digits even in Arabic.

### Shape & elevation

- Radii: buttons/inputs `10–13px`, cards `16px`, large avatars `15–17px`, pills/toggles `999px`.
- Borders: hairline `1px solid rgba(28,27,25,0.08)`; focused input `#6E7F6C`.
- Shadows: very restrained — segmented active `0 1px 3px rgba(0,0,0,0.08)`, toggle knob `0 1px 2px rgba(0,0,0,0.2)`.
- Toggle switch: track `44×26`, knob `20px`, on = `#6E7F6C`, off = `#D9D6CF`.
- Spacing rhythm: card padding `18–22px`, grid/flex `gap: 12–18px`.

### Reusable components (appear across surfaces)

- **Toggle switch** (`track` + `knob`), **stepper** (− / value / +), **segmented control** (pill track, active = white card), **pill/badge**, **selectable chip** (with leading dot), **info banner** (tint bg + icon + text), **data table** (grey header row + hairline rows), **KPI card**, **bar chart** (rounded-top bars).
- Icons are inline SVG line icons, `1.6–1.7` stroke, `currentColor`. Reuse an icon set in the real app (SF Symbols / Material) matching these.

---

## Screens / Views

### 1. Customer Wallet — `AVO Wallet Home.dc.html` (iOS + Android)

**Purpose:** the customer's whole world — one scrollable home with wallet, QR, loyalty, activity; plus Top-up, Book, Shop, and Cart flows. Includes full **EN + Arabic (RTL)** and an auth flow (login/signup).

- **Loyalty mode:** the salon runs **tiers or stamps** — the toggle above the phone switches the reference between them. Stamps mode replaces the tier pill with a `4 / 8` count, the progress bar with stamp dots, drops the top-up bonus entirely (no bonus exists in stamps mode), and swaps the membership-levels list for a stamp card.
- **Home (single page):** brand-colored **wallet card** (balance in Fraunces, loyalty progress, and a **live scannable QR** encoding member ID + a token that rotates every 45s with a visible countdown), line "One wallet — valid at all branches," upcoming-appointment card, activity feed, membership-levels detail (tiers mode).
- **Bottom nav:** Home · Book (if enabled) · Shop (if enabled) · Top up.
- **Transaction detail:** every activity row opens a receipt sheet — amount, status pill, full breakdown (gateway fee, tier bonus, artist, branch, visit credit, balance after) and a reference number. EN + AR.
- **Consent at signup:** a required "I agree to the Wallet terms, refund policy and privacy notice" checkbox blocks account creation until ticked, with a separate opt-in for WhatsApp messages and links that open each document before signing.
- **Account & policies:** the header avatar opens Account — profile rows (name, phone, **email**, password, language), five notification toggles (app push, WhatsApp, appointment reminder, **email receipts**, salon offers — offers off by default), **seven policy documents**, a **Help** block, log out, and **request account deletion** (App Store requirement) with a remaining-balance warning.
- **Edit profile & change password:** an Edit button on the profile card (and every profile row) opens a sheet for name, phone and optional email, with validation. Changing the phone routes through a **4-digit confirmation** step, because the number is the login identity — see `api-contract.md` § Profile edit. Password change takes current / new / confirm with show-hide, a 6-character minimum, rejection of reuse, and a "forgot my current password" link into the WhatsApp reset flow. The copy promises other devices are signed out — the build must actually revoke those sessions.
- **Follow the salon (Account → Help):** an icon grid of the salon's own public channels — Instagram, TikTok, Snapchat, WhatsApp — each showing its handle and opening the profile. Handles are salon-owned and edited in Merchant → Settings → Social links; a channel with an empty handle or switched off simply doesn't render. **Store the handle, derive the URL** (`api-contract.md` § SocialLink).
- **Contact us (Account → Help):** under the policy documents, a Contact us row plus the support WhatsApp number and hours. It opens a sheet with a **topic picker**, a message field, an optional receipt reference, a **reply-on WhatsApp/email** choice, and a confirmation carrying the ticket reference (`SUP-48263`) and the reply-time promise. Each topic shows who answers it as a pill — **Salon** (appointment, the visit) or **AVO** (wallet, an unrecognised charge, account/data). The transaction detail sheet has **Report a problem with this payment**, which opens the same form pre-filled with that receipt's reference. Channels and topics come from the platform support config, not this file; the route must be resolved server-side (`api-contract.md` § SupportConfig).
- **Legal set (EN + AR, both complete) — authored in Owner Console → Policies, not in this file:** two platform-level documents — **Terms & conditions** (10 clauses: contracting parties, account, booking & deposits, prices, wallet credit, products, fair use, liability, complaints, changes & Kuwaiti law) and **Privacy policy** (8 clauses: controller, data collected, purposes, who sees it, retention, your rights, security, storage location) — sit above the five plain-language wallet documents (Wallet terms, Refunds & cancellation, How bonuses work, Does my credit expire?, Privacy & your data). The **"not a bank deposit / not covered by deposit insurance / no interest / no cash withdrawal"** wording now appears in both the general T&C (clause 5) and Wallet terms, and names the CBK-licensed PSP as the processor. Signup consent links to Terms, Refunds and Privacy before the box can be ticked. **All of it is drafted design copy — counsel and the PSP must sign it off before launch.**
- **Happy hour banner (real clock):** the banner is resolved from the shared promotion set against salon-local time — headline reward, branch, end time, and a **live countdown** ("1h 28m left") that ticks each second and **expires on its own**. When no window is open it becomes a muted "Next happy hour · today 16:00 · in 3h 24m" card. Nothing is hard-coded and there is no `live` flag; see `api-contract.md` § Promotion set.
- **Upcoming appointment:** Reschedule (carries the deposit to a new slot) and Cancel (returns the deposit), with the 1-hour rule stated inline.
- **Artist availability:** each artist in booking step 2 shows **Live availability** (Google Calendar connected) or **Availability by salon hours**.
- **Top up:** amounts 5 / 10 / 25 / 50 KD; **KNET first + default** ("Most used in Kuwait"), then Apple Pay, then Visa/Mastercard; calculation card: you pay → tier bonus → credited.
- **Top-up outcomes:** the payment sheet runs a real four-stage flow — idle → **KNET redirect** (not dismissible) → result. Results are **success**, **declined**, **cancelled**, and **pending**. Use the outcome selector above the phone to see each. Read `api-contract.md` § TopUpIntent before building this: `pending` is its own screen and must not offer retry.
- **Book:** service → artist → 7-day strip → time slot → confirm; real availability (business hours 10:00–13:00, 16:00–21:00 minus busy/booked, struck-through); deposit held (default 5 KD), "pay remainder at salon"; insufficient balance → inline error → one-tap KNET top-up.
- **Shop:** product grid (name, price, "Buy · pickup at salon"), add to cart, **cart checks out from wallet balance**.
- **QR enlarge** on tap; **العربية** toggle flips to full RTL with feminine address forms.
- Tap targets ≥ 44px. Uses `qrcode-generator` in the prototype — use a native QR lib in production.

### 2. Merchant Dashboard — `AVO Merchant Dashboard.dc.html` (desktop web)

**Purpose:** full salon control panel (demo salon "Amara"). Left sidebar (light `#F6F4EE`), main content area.

- **Sections:** Overview (members, loaded today, repeat rate, upcoming, activity) · Appointments (status pills: Deposit held / Completed / No-show · returned; 1-hour auto-return rule) · Team (artists + their **weekly working hours** — see below) · Shop (flat name+price catalog) · Loyalty (tiers-vs-stamps selector + rules) · Settings (module toggles default OFF, deposit stepper 1–10 KD, business hours, branches, WhatsApp toggle, AVO commission).
- **Team scheduling (editable):** each artist card shows the availability source (**Google Calendar** live-sync *or* **Manual hours**), a 7-day week strip, and a days/hours/slot-length summary. **Edit hours** opens a per-artist editor so an owner or **receptionist can set hours on the artist's behalf**: a Google-Calendar/Manual source toggle, a **booking slot length** selector (15/20/30/45/60 min), and per-day **availability windows** (From/To steppers, 30-min steps) that compute bookable slots. Google-sourced artists show read-only synced windows until switched to Manual.
- **Notifications:** header bell with unread count — new bookings, no-shows, late cancellations, shop pickups, calendar disconnects. Clicking an alert marks it read and jumps to the relevant section.
- **Loyalty (editable):** per-tier **Visits** and **Bonus %** inputs with a live "10 → 11 KD" preview, validation when a threshold isn't above the tier below, and a **Publish changes** button with a dirty/unsaved state. Bronze is locked. (This closes the phase-2 open item — merchants now edit their own tier rules.)
- **Shop:** a real editor — live name/price inputs, add, delete, empty state.
- **Audit log:** every charge, void, reimbursement, automatic deposit return, rule change and permission change in this salon, with who/what/source, search and Money / Rules / Access / Risk filters. AVO platform actions on the salon appear here marked "Owner console". Append-only, 7 years.
- **Marketing:** three tabs. **Campaigns** — compose (audience, branch, channel, headline, body, reward, now/scheduled), live push preview, reach count, and **Submit to AVO** (never "Send"); the queue below shows every campaign with its status (Awaiting AVO / Approved / Sent / Rejected), AVO's rejection note verbatim, a **Withdraw** button while pending, and the remaining monthly cap. **Branch boosts** — per-branch visit value / top-up bonus / stamps steppers with a plain-language summary and a dirty **Publish changes** state that writes to the shared endpoint, so wallets and scanners pick it up immediately. **Happy hours** — recurring windows with the salon clock in the corner, each row showing **Live · 42m left**, **Opens in 3h 24m**, **Scheduled** or **Paused** derived from the clock, plus pause / remove and an add-window form (branch, day chips, from/to, reward, notify-on-open).
- **Accounts → Team authority:** nine permission chips per account, including three that were added for go-live — **See today's charges**, **Void a charge** and **Submit campaigns**. Toggling a chip writes to the shared staff record, so a senior can grant or revoke the scanner's charges view from the dashboard and the phone changes on next read. Every grant/revoke is logged in the audit trail.
- **Settings → Brand kit:** salon name, logo drop, brand colour palette, and **Typography** — four pairings (Fraunces + Inter, Inter throughout, Georgia + Inter, Helvetica Neue) that apply to the customer app, receipts and notifications, with a live phone preview. Arabic always uses a matched Arabic face, so a Latin choice never degrades Arabic legibility. **Typography is a setting, not a code change** — a new white-label salon is configured here, not in a stylesheet.
- **Settings → Social links:** the salon's Instagram, TikTok, Snapchat and WhatsApp handles, each with an on/off switch, written to the shared endpoint and rendered as the Follow row in the customer app. Only the handle is stored; the link is derived from it, so editing a handle can never leave a dead icon in the wallet.
- **Settings → Your plan & invoices:** plan pill, monthly fee + commission, next invoice, payment method, last three invoices.
- Live: sidebar nav, toggles, deposit stepper, tiers/stamps switch, full Team hours editor, tier editor, shop editor, notifications.

### 3. Staff Scanner — `AVO Staff Scanner.dc.html` (iOS + Android)

**Purpose:** the phone staff carry — scan-to-charge, plus their own bookings and hours. No salon dashboard/settings (deliberate). The scanner uses a **dark device frame**; other screens are light.

- **4-digit PIN** sign-in → **Home** hub (does *not* jump straight to scanning) with three actions: **Scan**, **My bookings**, **My schedule**.
- **Loyalty mode:** same tiers/stamps toggle as the customer app. In stamps mode the member card shows the `4 / 8` count plus stamp dots, and the charge result reads "Stamp added · 5 of 8".
- **Scan:** camera-style scanner (scan-line animation) → member card (name, tier/stamps, balance) → select service chips → **charge**. Held deposit auto-applies as a credit line (e.g. 8.000 − 5.000 = 3.000 charged). Charge deducts wallet, adds visit/stamp, detects tier climb, consumes QR token, sends WhatsApp receipt. Insufficient balance → error → prompt top-up → rescan.
- **My bookings:** upcoming appointments **from the AVO app and the artist's Google Calendar**, grouped by day, each showing time, duration, service, deposit held, the client's name/tier/**phone**, the booking source, and one-tap **Call** (`tel:`) and **WhatsApp** (`wa.me`) contact actions. New bookings surface a **push notification** and a "new" badge on the Home button. (Prototype data is mock; wire to real bookings + push service.)
- **Manual member lookup:** "Can't scan? Find member manually" on the scan screen — search by name, phone or member ID, pick the member, charge as normal. For a dead phone or a camera that won't focus. Lookups are logged against the staff member's name.
- **Void a charge:** the result screen offers **Wrong charge? Void it**, and Home has a **Today's charges** list. A charge is voidable for 15 minutes; voiding asks for a reason (wrong amount / duplicate / service not received), refunds the wallet in full, removes the visit, and notifies the customer. Past that window the merchant reimburses from their dashboard.
- **My schedule:** the artist sets their own **availability** — a source toggle (**Google Calendar** read-only sync vs **Set manually**), a **booking slot length** selector (15–60 min — any duration, not fixed morning/evening slots), and per-day **availability windows** (open toggle + From/To steppers), with a running open-days / hours / slots-per-week summary. These hours feed booking availability and mirror the Merchant Dashboard → Team editor.

### 4. Owner Console — `AVO Owner Console.dc.html` (desktop web)

**Purpose:** platform super-admin above every salon (**dark** `#1C1B19` sidebar). Sections: **Analytics** (KPI cards + bar chart + top salons), **Activity** (platform-wide live feed), **Reports** (per-salon CSV export), **Salons** (list → per-salon editor: modules, deposit, loyalty structure with tier thresholds/bonuses or stamp target, branches), **Accounts** (all users, filter, wallet adjust, stamps, password-reset links — passwords never stored/shown), **Admins** (invite console users, roles, per-section permission chips), **Controls** (platform switches, KNET flat fee in fils, card %, default deposit), **Billing** (subscription MRR, commission, outstanding, gateway pass-through; per-salon plan/fee/commission table; invoice list with CSV export), **Audit log** (append-only record of every money-touching and permission-changing action across all three surfaces — who, what, detail, source — with search and Money / Rules / Access / Risk filters).

- **Policies (new):** the legal documents every wallet shows, authored here. Document list (reorderable, add / delete), **English | العربية** editor per document with a title field and one textarea per clause, a **Required at signup** switch that controls which documents the consent checkbox links to, an effective-from date, and **Publish vN** with a Discard-changes escape. Editing only ever touches the **draft** — a sidebar dot and a "Draft ahead of v3" pill show unpublished work, and the wallet keeps showing the published version until you publish. Below: where each document surfaces, and a sign-off panel to record who cleared the version (counsel / PSP). **The customer app holds no legal copy of its own** — it renders `policies.published.docs` and stamps each document "Last updated 1 July 2026 · v3".
- **Support & contact (new, bottom of Policies):** the channels and topics the wallet's Contact us form offers — WhatsApp number, support email, hours, reply-time promise, and the topic list with a **Salon / AVO** routing switch per topic, reorder, add and delete. Below it, submitted messages with their route, reference, member and a mark-answered control. Channels and topics **save immediately** — there is no publish step, because nothing here is a legal representation. AVO owns this deliberately: a salon cannot redirect customers to an unmonitored number.
- **Approvals (new):** the platform gate on merchant marketing. Every submitted campaign lands here with the full message, audience, reach, branch, reward and send time, who submitted it and how long ago; **Approve & release** queues delivery (on schedule for a future send), **Reject with a reason** returns a note the merchant reads in their dashboard. Submissions that sit inside quiet hours or hit the salon's whole base are flagged inline. Alongside: the **platform throttle** — require-approval switch, per-customer weekly cap, per-salon monthly cap, quiet-hours summary — plus a decided-history table and this-month counts. The sidebar carries a pending badge. **A salon cannot send anything to a customer without a decision here.**
- **Onboarding wizard:** Salons → **+ Onboard a salon** runs a 4-step wizard (details & plan → modules & deposit → loyalty & brand colour → review), then creates the salon and sends the owner a WhatsApp invite with a 14-day trial. This closes the "no new-salon setup" gap.

### 5. Sign-in — `AVO Login.dc.html` (desktop web)

**Purpose:** username + password sign-in for the two web apps. **5a** merchant workspace (light, salon-branded), **5b** owner console (dark). Live: show/hide password, submit validation, signed-in landing state.

### 6. States — `AVO States.dc.html`

**Purpose:** the states the five screen files don't show, because they show the happy path. Loading skeletons, empty states, error and offline for both mobile and web, plus the white-label presets applied. The rules behind each are in `interaction-spec.md` §4. Notable ones:

- **Offline (customer):** last-known balance stays visible with a timestamp; the **QR is hidden** — a stale token fails at the counter and reads as the salon's fault.
- **Loading:** skeletons mirror the real layout. Never render `0.000` before data arrives.
- **Motion, focus & responsive:** the reduced-motion verdict per animation (remove vs cross-fade vs keep), the focus ring on light and dark surfaces with the full keyboard map, and the four responsive states of the web surfaces. These were previously spec-only.
- **Push notifications:** designed lock-screen cards for the customer app and the staff scanner, plus the merchant in-app alert panel, with deep-link targets and the no-duplicate-within-5-minutes rule.
- **Two different empties** for Appointments: nothing booked yet vs. the Booking module switched off. Never the same copy.
- **Stale-not-blank:** when a dashboard refresh fails, keep the old figures on screen behind a timestamped banner rather than blanking a screen someone is reading.

---

## Interactions & Behavior

- **Navigation:** sidebar/tab click swaps the section in place (client state, no route reload in the prototype — use real routing/navigation stacks in production).
- **Toggles/steppers/segmented controls:** immediate optimistic state change.
- **CSV export (Owner → Reports):** builds a UTF-8 CSV (BOM prefixed) from the currently filtered rows and downloads it; filename encodes the salon scope. In production, wire to a real export endpoint.
- **QR (Customer):** regenerates/rotates token every 45s with countdown; tap to enlarge (scale-in animation).
- **RTL (Customer):** `العربية` flips layout direction, mirrors components, switches font to IBM Plex Sans Arabic, uses feminine address forms; money stays Western digits / 3-decimals.
- **Validation:** login empty/short-password → inline error banner (`#F6EAE8` bg). Add-admin requires name+username+password ≥ 6 chars. Wallet deduct clamps to available balance; stamp add/remove clamps to target.
- **Responsive, focus, keyboard, reduced-motion:** now **designed** in `AVO States.dc.html` (Motion, focus & responsive) and specified in `interaction-spec.md` §3. The five happy-path files still render the full-motion, mouse-driven case — build from the States file for these behaviours. Reduced motion **removes** the scanner line, success pop, pulse and shimmer; it does not shorten them.
- **Animations (keyframes in prototypes):** `avofade`, `avozoom` (QR enlarge), `avosheet` (bottom sheet slide-up), `avoscan` (scanner line), `avopulse`, `avopop`. Durations are short (~150ms transitions); **respect reduced-motion**.

---

## State Management

Per-surface local state driving the prototypes (recreate with the platform's state solution):

- **Customer:** auth mode (login/signup/authed), language (en/ar), active tab, balance, loyalty (tier or stamps), cart items, top-up amount + method, booking selection, QR token + countdown.
- **Merchant:** active section, module toggles (booking/shop), deposit amount, loyalty mode + rules, team/calendar status.
- **Staff:** PIN entry, active screen (home/scan/bookings/schedule), scanned member, selected services, charge result, availability source (google/manual), booking slot length, per-day availability windows (open/from/to), upcoming bookings feed + unread-notification count.
- **Owner:** active section, salons[] (each: plan, members, active, booking, shop, deposit, loyalty mode, tiers[], stampTarget, branches[] — note the salon-level branch list is shared, not local), editSalon id, admins[] (role + per-section perms), account filters/query, wallet-adjust amount, per-account extras (added credit/stamps/entries), report salon filter + query, platform flags, KNET fee, card %, default deposit.

**Shared, not per-surface:** the legal document set (draft + published), the support channels and topics, branches, boosts, happy hours, campaigns + their approval status, the platform messaging policy, and staff permissions live in `avo-promotions.js` and are read by all four apps through one subscription. Treat that object as server state (fetch + invalidate / socket), not as component state — the wallet and dashboard disagreeing about a boost is the exact bug this replaced.

The rest of the data in the prototypes is **mock/hardcoded**. Wire every surface to the real API — shapes and endpoints are in `api-contract.md`. Note the sensitive rule: **passwords are never stored or shown** — only "send reset link" actions.

Two prototype affordances are **review scaffolding, not product**: the tiers/stamps toggle and the top-up outcome selector that sit above the phone frames. In the real apps, loyalty mode comes from `salon.loyaltyMode` and the outcome comes from the gateway.

---

## Assets

- **Fonts:** Fraunces, Inter, IBM Plex Sans Arabic (Google Fonts). Bundle equivalents or use platform system fonts where appropriate.
- **QR:** prototype uses the `qrcode-generator` CDN lib — replace with a native QR generator.
- **Icons:** all inline SVG line icons — map to SF Symbols (iOS) / Material Symbols (Android) / an icon set on web.
- **Logo:** the "A" monogram in a rounded brand-colored square is a placeholder — swap for the real per-salon brand mark (white-label).
- No raster image assets are required by the designs.

---

## Files in this bundle

- `AVO Wallet Home.dc.html` — customer app (iOS + Android)
- `AVO Staff Scanner.dc.html` — staff scanner app (iOS + Android)
- `AVO Merchant Dashboard.dc.html` — merchant dashboard (web)
- `AVO Owner Console.dc.html` — owner console (web)
- `AVO Login.dc.html` — sign-in (web)
- `AVO States.dc.html` — loading / empty / error / offline states + white-label presets
- `AVO-Beauty-Product-Description-v2.md` — **the product brief / source of truth**
- `CLAUDE.md` — the working agreement for the build: stack, non-negotiables, how to work
- `build-plan.md` — nine phases in dependency order, with acceptance criteria
- `go-live-checklist.md` — launch blockers: legal, money, security, stores, operations
- `api-contract.md` — entity shapes, endpoints, and the top-up / charge rules
- `interaction-spec.md` — breakpoints, focus & keyboard, motion, state rules
- `whatsapp-templates.md` — the four customer messages, EN + AR
- `tokens/avo-tokens.json`, `tokens/avo-tokens.css` — machine-readable design tokens
- `AVO Receipt Email.html` — **send-ready HTML email receipt**, issued for every payment, top-up and refund. Table-based, all styles inline, email-safe font stacks, no JavaScript, no images (the salon mark is a coloured cell with the initial — swap in a hosted https URL if a real logo is wanted), bulletproof CTA, hidden preheader, dark-mode meta, Outlook conditionals. Carries the receipt number, itemised lines including the deposit already paid, totals, wallet balance before/after, the loyalty effect, the 15-minute void / refund-as-credit rule, and the "not a bank deposit / CBK-licensed PSP" footer. **Merge fields to wire:** salon name, brand colour, branch address, receipt number, timestamp, staff name, terminal, line items, totals, balances, visit count, and the receipt URL. Open it in a browser to preview at 600px; drop it into your sending tool as a template.
- `avo-promotions.js` — **the shared promotions + authority endpoint.** Reference implementation of the single source of truth all four apps read: boosts, happy-hour windows with clock resolution and countdown formatting, the campaign approval state machine, the platform messaging policy, and staff permissions. Backed by `localStorage` in the prototype so the four files stay in step in one browser — **replace the storage layer with the real API, keep the shapes and the rules.** Read it alongside `api-contract.md`.
- `image-slot.js`, `ios-frame.jsx`, `browser-window.jsx`, `support.js` — presentation scaffolding the prototypes load (device/browser frames + runtime). **Not part of the product** — do not reproduce the bezel/chrome in the real apps.

### Screenshots

Full-design reference captures of each screen are in `screenshots/`:
- `1-customer-wallet.png`, `2-merchant-dashboard.png`, `3-staff-scanner.png`, `4-owner-console.png`, `5-login.png`

These show the default entry state — open the live files to see every section and interaction.

### Standalone exports (`standalone/`)

Each screen is also provided as a **single self-contained `.html` file** that works fully offline — no folder, no server, no internet. Just double-click to open in any browser; fonts, the QR library, and the device/browser frames are all embedded. Use these to review the designs anywhere:
- `1 - Customer Wallet.html`, `2 - Merchant Dashboard.html`, `3 - Staff Scanner.html`, `4 - Owner Console.html`, `5 - Sign-in.html`, `6 - States.html`

The `.dc.html` source files (plus `support.js` and the frame `.jsx`) remain the editable originals; the `standalone/` files are read-only snapshots for viewing.

### How to view

Open any `.dc.html` (or `standalone/*.html`) in a modern browser. Pan/zoom the canvas. The intro card in the top-left of each file (badge `1a`, `2a`, `3a`, `4a`, `5`, `6a`) explains what's live and how to interact.

---

## Settled decisions

- **Refunds are always wallet credit.** No cash, no card reversal, on any surface. Deposit auto-return, staff void (15 minutes) and merchant reimbursement all land in the customer's wallet. The customer app states this in *Refunds & cancellation*.
- **Multi-salon is white-label, not an aggregator.** Each salon ships its own branded app with its own wallet. There is no salon switcher and no shared balance — one `--brand` token and one salon per install.

## Known gaps — decide before or during build

These are deliberate omissions, not oversights. Each needs a call:

1. **Arabic is customer-app only.** Decided. Merchant dashboard, owner console and the staff scanner ship English-only. WhatsApp messages go to customers, so those are EN + AR.
2. **Android deltas.** One iPhone-framed reference serves both platforms. Navigation, back behavior, and elevation should follow Material rather than being ported 1:1.
3. **Dark mode.** Out of scope. All surfaces are light; the owner-console sidebar and scanner frame are dark by design, not by theme.
4. **Regulatory.** Stored value in Kuwait may fall under CBK / PSP rules. The customer app now ships a **full drafted legal set** — general Terms & conditions and a Privacy policy alongside the five wallet documents, EN + AR, with the "prepaid credit for one salon / not a bank deposit / not covered by deposit insurance / no expiry / refunds as wallet credit only" wording and the licensed-PSP reference. **It is design copy, not advice: counsel and the PSP must review and sign it off before launch. The only remaining launch blocker.**
5. **Consent versioning.** The Policies editor versions the documents and the wallet shows which version it is displaying, but a real build must **store the accepted version against the member** at signup, and re-prompt on a material change. Do not rely on "they agreed to whatever is current".
6. **Send-time enforcement.** The prototype enforces approval and shows the caps, but the weekly-per-customer and monthly-per-salon caps and quiet hours must be enforced **server-side at send**, not in the client — an approved campaign that would breach a cap is held and reported, never silently dropped.
7. **Receipt delivery.** The email template is designed but not plumbed: a real build needs a transactional sending domain with SPF/DKIM/DMARC, a queue with retry, a bounce/complaint webhook that flags a bad address on the member record, and an email-capture prompt for members who signed up with phone only. Receipts are a record-keeping obligation, not marketing — send them regardless of the marketing consent flag, and keep them out of any unsubscribe-all path.
8. **Support routing and cover.** The contact form is designed and the ticket shape is specified, but going public needs the human side decided: **who monitors the AVO queue and in what hours**, what the salon-routed queue actually is (WhatsApp Business inbox vs the dashboard), and what happens to a message that arrives outside the hours the wallet promises. The reply-time line in the wallet is a public commitment — set it to something you can keep. See `api-contract.md` § SupportConfig for the routing rule.
9. **Screenshots** in `screenshots/` capture entry state only. Open the live files for the rest.

*(Closed since the last revision: push notification design, customer transaction detail, refund/void path, new-salon onboarding, merchant-editable tier rules, account settings & deletion, audit trail, billing, brand kit.)*
*(Closed in the previous revision: **one promotions endpoint** — boosts and happy hours are no longer duplicated between wallet and dashboard; **happy hours run on a real clock** with a live countdown and self-expiry instead of a stored flag; **campaign approval** — merchants submit, AVO releases or rejects with a reason, with a platform throttle in Owner → Approvals; **staff authority** — Today's charges and voiding are merchant-granted permissions the scanner reads; **legal set** — general Terms & conditions and Privacy policy in EN + AR, now **editable and versioned in Owner Console → Policies** with draft/publish separation, the wallet holding no copy of its own; **email receipts** — send-ready template plus the account toggle and email field; **brand typography** — four pairings selectable in the brand kit.)*
*(Closed in this revision: **contact form** — Account → Help → Contact us in the wallet, with per-topic Salon/AVO routing, an attached receipt reference, a reply-channel choice and a ticket reference on the confirmation; **Report a problem with this payment** on every receipt; **Support & contact** editor in Owner Console → Policies so the number, hours, reply promise and topic list are configuration, not code.)*
*(Contrast — resolved. Primary buttons `#5A6B58`, uppercase micro-labels `rgba(28,27,25,0.6)`, WhatsApp buttons `#0B3D1E` on green. Every screen was driven through its states and scanned: zero white-text failures. Three intentional exceptions are documented in `interaction-spec.md` §2.)*
