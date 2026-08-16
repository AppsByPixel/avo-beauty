# AVO Beauty — Product Description & Design Brief (v2 Final)

**Prepared for:** Design (Claude)
**Product owner:** Fahad — AVO platform
**Market:** Kuwait / GCC · **Currency:** KWD, 3 decimals (fils) · **Languages:** English + Arabic, full RTL

---

## 1. What AVO Beauty is

A **white-label stored-value wallet + loyalty platform** for salons, spas, and beauty studios in Kuwait. Each salon gets the app under its own brand — one brand color token restyles everything. The core mechanic: customers top up a wallet, pay in-salon by showing a QR code, and climb loyalty rewards with every visit and purchase. Booking and retail are **optional modules** the merchant can switch on; the platform never disrupts how a salon already operates.

**Product philosophy (non-negotiable):**
- Low-friction adoption: web-first customer wallet, no forced app download.
- Merchant-friendly defaults: optional modules default OFF; nothing to maintain that merchants won't maintain (no stock counts, no services menu upkeep).
- Money stays in the ecosystem: deposits, refunds, and rewards all move through the wallet.

---

## 2. The three surfaces (separate apps, separate logins)

### 2.1 Customer app (mobile, web-first)

**Home = one page.** No separate pay/status tabs. A single scrollable screen containing:
- **Wallet card** (brand-colored, the signature element): balance, loyalty progress, and the **live payment QR** inline. The QR is real and scannable, encoding member ID + a security token that rotates every 45 seconds with a visible countdown.
- Line under the card: *"One wallet — valid at all branches."* (Wallet, tier, and stamps are shared across every branch of the salon.)
- **Upcoming appointment** card (if booked): service, artist, day/time, deposit held, cancel action.
- **Activity feed**: top-ups, visits, shop purchases, deposits held/returned.
- **Membership levels** detail (tiers mode only).

**Bottom nav:** Home · Book (if enabled) · Shop (if enabled) · Top up.

**Top up:** amounts 5/10/25/50 KD. **KNET first and default**, tagged "Most used in Kuwait," no added fee shown; then Apple Pay, then Visa/Mastercard. Calculation card shows: you pay → tier bonus → credited to wallet.

**Loyalty — merchant picks ONE mechanic per salon** (shapes the home screen):
- **Tiers:** Bronze (0 visits, no bonus) → Silver (4+, 10→11 KD on top-up) → Gold (10+, 10→12 KD) → Black (20+, 10→13 KD + priority booking). Progress bar on the wallet card.
- **Stamps:** collect 8 visit stamps → free blow-dry. Stamp dots on the wallet card. No top-up bonus in this mode.
- Shop purchases count toward loyalty the same as visits.

**Book tab (optional module):**
- Flow: service → artist → day (7-day strip) → time slot → confirm.
- **Artist availability is real:** business hours (10:00–13:00, 16:00–21:00; afternoon closure typical of Kuwait retail) minus the artist's Google Calendar busy slots minus already-booked slots. Unavailable slots shown struck through.
- Artists display a badge: "Live availability" (calendar connected) or "Availability by salon hours" (not connected).
- **Deposit, not fixed price** (booking is never one price): merchant-set amount (default 5 KD) held from the wallet at confirmation; summary shows "Pay at the salon ~remainder." Insufficient balance → inline error with a one-tap path to KNET top-up.
- **No-show rule:** if the customer doesn't arrive within 1 hour of the slot, the deposit **automatically returns to their wallet**. (Money never leaves the ecosystem; the deposit creates commitment, not punishment.)
- Confirmation + day-before reminder sent via **WhatsApp**.

**Shop tab (optional module):**
- Simple product grid: name, price, "Buy · pickup at salon." Paid from wallet. No delivery (phase 2), no stock counts.
- Purchase earns a stamp/visit and fires a WhatsApp order confirmation.

### 2.2 Staff scanner app (mobile — scanning ONLY)

- **4-digit PIN sign-in** per staff member. No dashboard access, no settings — this is deliberate.
- Camera-style scanner reads the customer QR → member card (name, tier/stamps, balance) → select services (chips with prices) → **charge**.
- If the customer has a held deposit, it is **auto-applied** as a credit line (e.g., 8.000 service − 5.000 deposit = 3.000 charged).
- Charging deducts the wallet, adds the visit/stamp, detects tier climbs, consumes the QR token, and sends a WhatsApp receipt.
- Insufficient balance → clear error prompting a customer top-up, then rescan.

### 2.3 Merchant dashboard (desktop web)

All management lives here — sidebar navigation:
- **Overview:** members, loaded today, repeat rate, upcoming appointments, recent activity.
- **Appointments:** every booking with status pills — *Deposit held / Completed / No-show · returned* — and the 1-hour auto-return rule stated. (Manual "mark no-show" exists for edge cases.)
- **Team:** artists with Google Calendar connection status. Each artist connects **once**; busy slots block booking automatically and new bookings sync back to their calendar — **artists never log into AVO unless they want to**.
- **Shop:** flat catalog editor (name + price only).
- **Loyalty:** the tiers-vs-stamps selector + current rules.
- **Settings:** module toggles (Booking, Shop — both default OFF), deposit amount stepper (1–10 KD), no-show rule, business hours, branches list ("one wallet, one status, every branch"), WhatsApp notifications toggle, AVO commission display.

---

## 3. Business model

- **AVO commission on top-ups:** KNET 150 fils flat per transaction; card/Apple Pay 2.5% + 50 fils. Shown transparently to the merchant.
- Tier bonuses are funded by the merchant (stated in customer fine print).
- Freemium/module pricing TBD; deposits drive top-up volume.

---

## 4. Design language

- **Aesthetic:** minimal, chic, spa-clean. Warm off-white ground (#FBFAF8), ink text (#1C1B19), muted warm grays.
- **White-label token:** one `--brand` color (+ derived tint) restyles the entire app. Demo presets: Amara sage #6E7F6C, Noor rose #B08D8D, Lila lilac #8A7CB0.
- **Type:** Fraunces (serif) for display numerals and headings; Inter for UI; IBM Plex Sans Arabic in AR mode.
- **Signature element:** the brand-colored wallet card with the live rotating QR inside it.
- **Arabic:** full RTL mirroring, feminine address forms (customer base is women's salons: اشحني، احجزي، أنتِ), Western digits for money amounts.
- Rounded 12–22px radii, hairline borders, single-accent restraint. Reduced-motion respected.

---

## 5. Decisions log (settled — do not reopen in design)

| Decision | Resolution |
|---|---|
| Booking module | Optional, merchant-toggled, default OFF |
| Booking price | Deposit only (merchant-set), remainder at checkout |
| No-show | Deposit auto-returns to wallet 1 hour after missed slot |
| Loyalty mechanic | Merchant chooses tiers OR stamps, one per salon |
| Shop inventory | Catalog only — no stock counts |
| Notifications | WhatsApp: booking confirmation, day-before reminder, receipts |
| Branches | One wallet/status valid at all branches |
| Merchant access | Desktop dashboard = full control; staff phone = PIN + scan only |
| Customer/merchant separation | Fully separate apps; customers never see merchant surfaces |
| Artist workflow | Google Calendar one-time connect; no AVO login required |
| Payments | KNET primary, then Apple Pay, then cards; KWD 3-decimals |
| Customer home | Wallet, QR, loyalty, activity — all one page |

---

## 6. Open items (phase 2 / future)

- Shop delivery and multi-item cart
- Retention automation (WhatsApp win-back campaigns)
- Deposit as % of service price (currently flat)
- Artist-level service pricing
- Merchant-editable tier/stamp rules UI (display exists; editing flow TBD)

---

*Reference implementation: `avo-beauty-v2.html` — a working single-file prototype of all three surfaces with real scannable QR, deposits, calendar-aware availability, and full EN/AR.*
