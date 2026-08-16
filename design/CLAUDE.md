# CLAUDE.md — working agreement for building AVO Beauty

You are implementing a production system from a completed design bundle. The designs are
final. Your job is to build them faithfully, not to redesign them.

Read in this order before writing any code:

1. `README.md` — what the product is, the design system, every screen
2. `AVO-Beauty-Product-Description-v2.md` — the product brief, source of truth for rules
3. `api-contract.md` — entity shapes, endpoints, and the money rules
4. `build-plan.md` — the phase order and what "done" means per phase
5. `interaction-spec.md` — breakpoints, focus, keyboard, motion, state rules
6. `go-live-checklist.md` — everything that must be true before launch
7. `avo-promotions.js` — the reference implementation of shared platform state
8. The `.dc.html` files — layout, copy, and interaction, screen by screen

## What the design files are

`.dc.html` files are **interactive design references**, not production code. Do not copy
their markup, their `localStorage` layer, or their device/browser frames. Read them for
layout, spacing, copy, colour, and interaction, then rebuild in the target stack.

`support.js`, `ios-frame.jsx`, `browser-window.jsx`, `image-slot.js` are presentation
scaffolding. They are not part of the product.

## Stack

Nothing is chosen yet. Pick per surface and record the choice in an ADR before phase 1:

| Surface | Recommendation |
|---|---|
| Customer wallet | React Native or Flutter (one codebase, iOS + Android) |
| Staff scanner | Same stack as the wallet |
| Merchant dashboard | React + TypeScript, server-rendered or SPA |
| Owner console | Same app as the merchant dashboard, different auth scope and shell |
| Backend | One API, Postgres, a job queue. Kuwait or EU data residency |

Merchant dashboard and owner console share a codebase and a component library. The two
mobile apps share a codebase and a design-token package. Everything shares the API.

## Non-negotiables

These are not preferences. Breaking any one of them is a defect.

1. **Money is integer fils.** No floats anywhere — not in the API, not in the database,
   not in a computed total. Display with 3 decimals, Western digits, in both languages.
2. **The server owns the balance.** Clients never add credit locally, never mint a QR
   token, never decide whether a happy hour is live for the purpose of a charge.
3. **`POST /charges` is one transaction.** Token consumption, deposit application, debit,
   visit/stamp increment, tier evaluation, receipt queue — all or nothing.
4. **Idempotency keys on every money-moving POST.** Top-ups, charges, orders, voids.
5. **Refunds are wallet credit.** No cash, no card reversal, on any surface, ever.
6. **Passwords are never stored in plaintext, never returned by an endpoint, never shown
   in a UI.** Owner console only ever sends a reset link. Staff PINs are hashed, rate
   limited, device-scoped, and locked after N failures.
7. **Permissions are enforced server-side.** `perms.charges`, `perms.void`,
   `perms.marketing`, admin section permissions — the UI hiding a button is a courtesy,
   not a control.
8. **A merchant cannot send a customer message.** `POST /campaigns` only creates
   `pending`. Delivery happens on the platform decision endpoint, and caps and quiet
   hours are enforced again at send time.
9. **White text never goes on `--brand`.** Use `--brand-deep`. Validate derived variants
   at white-label onboarding; reject a brand colour that cannot produce a 4.5:1 fill.
10. **The customer app holds no legal copy.** It renders the published policy set from
    the API and stamps the version. Store the accepted version against the member.
11. **Support ticket routing is resolved server-side** from `topicId`. A client-supplied
    route can land a wallet dispute in a salon's inbox.
12. **Arabic is a first-class layout, not a translation pass.** Full RTL mirroring,
    IBM Plex Sans Arabic, feminine address forms, Western digits for money.

## How to work

- **Types first.** Generate TypeScript (or Swift/Kotlin) types from `api-contract.md`
  before building screens. Share them between client and server.
- **One vertical slice at a time.** A phase is done when the flow works end to end
  against the real API with the real states, not when the screen renders.
- **Build the states with the screen.** Loading, empty, error and offline are specified
  in `AVO States.dc.html` and `interaction-spec.md` §4. A screen without them is not done.
- **Test the money paths.** Charge, top-up, void, deposit return, and the concurrency
  cases (double scan, double submit, gateway retry) need automated tests before launch.
- **Do not add features.** If something seems missing, check the Known gaps section of
  `README.md` — it is probably a deliberate omission with a decision attached. Ask.
- **Do not restyle.** Colours, type, spacing and copy are settled. If a platform idiom
  conflicts with the design (Android back behaviour, Material elevation), follow the
  platform and note it.
- **Keep the copy verbatim.** Both languages. Product copy is written; do not paraphrase.

## Open decisions you may need to escalate

These belong to the client, not to you. Flag and stop rather than guessing:

- CBK/PSP selection and counsel sign-off on the legal set
- Who monitors the AVO support queue, in what hours, and what the salon-routed queue is
- Data residency and the retention schedule
- Whether receipts send from AVO's domain or per-salon subdomains
