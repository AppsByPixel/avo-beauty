# AVO Beauty — Interaction spec

What the prototypes demonstrate visually but do not encode: responsive behavior, focus,
keyboard, and motion. Read alongside `README.md`.

---

## 1. Breakpoints (web surfaces only)

The prototypes render the Merchant Dashboard and Owner Console at a **single width inside
a browser frame**. That frame is presentation scaffolding — it is not a viewport spec.
Real merchants open these on 13" laptops and iPads.

| Name | Range | Layout |
|---|---|---|
| `wide` | ≥ 1440px | Sidebar 232px fixed. Content max-width 1180px, centered. KPI row 4-up. Two-column card grids stay 2-up. |
| `base` | 1200–1439px | Sidebar 232px. Content fluid with 32px gutters. KPI row 4-up. Two-column grids stay 2-up. |
| `narrow` | 1024–1199px | Sidebar collapses to 68px, icons only, label on hover. KPI row 2×2. Two-column card grids become 1-up. |
| `tablet` | 768–1023px | Sidebar becomes a top drawer behind a menu button. KPI row 2×2. Everything 1-up. Data tables scroll horizontally inside their card — never squeeze columns. |
| below 768 | — | **Not supported.** Show a "open the dashboard on a larger screen" notice. Merchants manage on desktop by design; the phone surface is the staff scanner. |

Rules that hold at every width:
- The sidebar never scrolls with content; the content column scrolls independently.
- Modals/editors (Team hours, salon editor, customer detail) cap at 720px and center.
- Data tables never drop columns responsively — a merchant reconciling money needs all of
  them. Scroll the table, keep the header row sticky.
- Minimum content column width is 640px; below that, go to `tablet`.

**Mobile surfaces** are fixed-width app screens; the reference is 402pt (iPhone 16 Pro).
Scale type and spacing proportionally down to 375pt and up to 430pt. Nothing reflows.

---

## 2. Focus & keyboard

The prototypes have no focus styling. Add it — the merchant dashboard is a data tool that
people drive from the keyboard, and it is the cheapest accessibility win available.

**Focus ring** (all surfaces):
```
outline: 2px solid #6E7F6C;
outline-offset: 2px;
border-radius: inherit;
```
On the dark owner-console sidebar and the dark scanner frame, use `#A9BBA6` instead —
`#6E7F6C` does not carry enough contrast against `#1C1B19`.

- Use `:focus-visible`, not `:focus` — no rings on mouse clicks.
- Never `outline: none` without a replacement.
- Inputs already show a `#6E7F6C` border on focus; keep that **and** add the ring.

**Tab order and keys**
- Sidebar nav is a single tab stop with arrow-key movement between items (`role="tablist"`
  where sections swap in place, which is what the prototypes do).
- Segmented controls (tiers/stamps, period, branch): arrow keys move, Space/Enter selects.
- Steppers (deposit, From/To hours): Up/Down adjust by one step, Page Up/Down by four.
- Sheets and modals: focus moves to the sheet on open, is **trapped** while open, and
  returns to the trigger on close. `Esc` closes — **except** the KNET redirect state,
  which is deliberately not dismissible.
- Toggles are `role="switch"` with `aria-checked`.
- Data tables: `<table>` with real `<th scope="col">`. Not divs.
- The 4-digit PIN pad must accept physical keyboard digits and Backspace.

**Screen readers**
- The rotating QR needs `aria-label="Payment code for member 8842, refreshes in 45 seconds"`
  and a polite live region on the countdown — but announce only every 15s, not every tick.
- Money: mark up `18.000` so it reads as "eighteen point zero zero zero Kuwaiti dinars",
  not "eighteen thousand". An `aria-label` on the amount is the simplest fix.
- Status pills (Deposit held / No-show · returned) must carry their meaning as text, not
  color alone. They already do — keep it that way.
- Every icon-only button needs an `aria-label`: log out, close sheet, remove branch, call,
  WhatsApp.

**Contrast — brand fills.** This is the one that breaks the white-label promise if it is
missed. White text must **never** sit on `--avo-brand` directly:

| Preset | white on `brand` | white on `brand-deep` |
|---|---|---|
| Amara sage `#6E7F6C` | 4.27:1 ✗ | `#5A6B58` — 4.9:1 ✓ |
| Noor rose `#B08D8D` | 2.98:1 ✗✗ | `#8A6565` — 5.1:1 ✓ |
| Lila lilac `#8A7CB0` | 3.76:1 ✗ | `#6B5C92` — 6.0:1 ✓ |

Even the default sage fails. So:
- **Primary buttons, badges and active nav use `--avo-brand-deep`.** `--avo-brand` is a
  *surface* colour — wallet-card gradients, tints, progress fills, dots.
- **Brand-coloured text on light** (links, "Tap to enlarge") also uses `brand-deep`.
- **Onboarding must derive and validate, not accept.** A merchant gives one hex; derive
  `deep` by dropping lightness until white clears 4.5:1, `tint` at ~92% lightness, and the
  card gradient at +6% / −8%. If `deep` can't reach 4.5:1 inside ~25% lightness shift, that
  hex isn't viable as a brand token — say so at the point of entry rather than shipping an
  unreadable button to a whole salon's customers.

**Applied across the whole bundle.** Every white-text brand fill in the six design files uses
`#5A6B58`. `#6E7F6C` remains only as a *surface*: wallet-card gradients, tint backgrounds,
dots, progress fills, toggle-on tracks, borders. Match this split in code.

*Audit method — reproduce it after any colour change.* Every screen and section was driven
through its states in the live DOM (wallet: home / book step 4 / booked / cart / all four
payment outcomes / stamps mode; scanner: home / member / charged / schedule / bookings;
dashboard and console: all sections plus the team editor; sign-in: both states) and scanned
for `color: #fff` on an opaque background below 4.5:1, plus brand-filled elements whose only
white content is an SVG stroke — the two shapes a naive find-and-replace misses. **Result:
zero failures.**

Three documented exceptions, all intentional:
- **Translucent pills on the wallet card** (`rgba(255,255,255,0.18)` tier pill, `0.22` bonus
  chip). White on white-over-gradient, roughly 3:1. Original design, on the signature card.
  If you want them AA-clean, darken the pill to `rgba(28,27,25,0.22)` with white text.
- **White checkmarks inside 20–32px stamp dots** on `#6E7F6C`. Non-text graphics, so the
  threshold is 3:1 (WCAG 1.4.11) and 4.27:1 clears it.
- **WhatsApp buttons** use WhatsApp green `#25D366`, a fixed third-party brand colour. White
  on it is 1.98:1, so the label is `#0B3D1E` (≈9:1). Never put white on WhatsApp green.

**Contrast — muted text.** `rgba(28,27,25,0.45)` measured ~3.3:1 on `#FBFAF8` — a fail at the
11px uppercase micro-label size it was used for. **Now `rgba(28,27,25,0.6)`** on all 51
uppercase micro-labels across the bundle (~5.2:1). `0.45` survives only on genuinely
secondary non-label text; `0.5` and `0.55` are unchanged and remain the muted body scale.

---

## 3. Motion

Existing keyframes: `avofade`, `avozoom`, `avosheet`, `avoscan`, `avopulse`, `avopop`.

| Animation | Duration | Easing | Purpose |
|---|---|---|---|
| `avofade` | 180ms | ease-out | Overlay backdrops |
| `avosheet` | 280ms | `cubic-bezier(.2,.9,.3,1.05)` | Bottom sheet slide-up |
| `avozoom` | 350ms | `cubic-bezier(.2,.9,.3,1.1)` | QR enlarge, result icons |
| `avopop` | 400ms | ease-out | Charge-success mark |
| `avoscan` | 2s loop | linear | Scanner line |
| `avopulse` | 1.1s loop | ease-in-out | Pending / waiting dots |
| transitions | 150ms | ease | Toggles, chips, hovers |

**Reduced motion.** The README claims this is respected; the prototypes do not implement
it. In production:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```
Then re-add, deliberately:
- Sheets: cross-fade in place instead of sliding.
- Scanner line: **remove entirely** — replace with a static frame and the text
  "Point at the customer's code". A looping line is the exact motion that triggers people.
- Pending dots: replace the pulse with static text "Waiting for the bank…".
- Never remove a *state change* — only the animation carrying it.

On iOS mirror `UIAccessibility.isReduceMotionEnabled`; on Android
`Settings.Global.ANIMATOR_DURATION_SCALE == 0`.

---

## 4. Empty, loading, error

See `AVO States.dc.html` for the designed states. The rules behind them:

- **Loading:** skeletons that match the real layout's shape, never a centered spinner on a
  full page. Money fields skeleton as a bar — never render `0.000` before data arrives; a
  customer seeing a zero balance for 200ms will call the salon.
- **Empty:** every empty state names the thing and offers the one action that fills it.
  No illustrations.
- **Error:** distinguish *we failed* (retry) from *you can't do that* (explain). Network
  failure keeps the last-known data visible with a stale banner rather than blanking.
- **Offline (customer):** the wallet card stays visible with the last-known balance and a
  clear "last updated" stamp. The **QR must be hidden offline** — a stale token will fail
  at the counter and that failure looks like the salon's fault.
