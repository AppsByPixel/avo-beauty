# AVO Beauty — build agreement

Production build of a completed design bundle. The designs in `design/` are **final**.
Build them faithfully; do not redesign them.

Stack decisions: `design/ADR-0001-stack.md`. Scope and dates: `design/build-plan.md`,
cut down to 30 days per the plan artifact.

---

## Lanes — read this before you write a file

Four sessions run **simultaneously**, each in its own git worktree. The rule that keeps
them mergeable:

| Lane | Branch | Writes ONLY to |
|---|---|---|
| **A · API** | `feat/api` | `api/` |
| **B · Wallet** | `feat/wallet` | `apps/wallet/` |
| **C · Web** | `feat/web` | `apps/dashboard/`, `packages/ui/` |
| **D · QA** | `feat/qa` | `**/*.test.ts`, `e2e/` |

**If you are in a lane and the change you want to make is outside your column, stop and
say so.** Do not edit it "just quickly" — a contract edit made inside one lane silently
breaks the other three, and nobody finds out until the daily merge.

`packages/types` and `packages/tokens` are **shared, trunk-owned**. Changing either is a
trunk operation: land it on `dev` first, then every lane rebases. Both are consumed by all
four surfaces, so a field rename is a four-way break.

`packages/tokens/src/generated.ts` and `packages/tokens/dist/` are **generated**. Edit
`design/tokens/avo-tokens.json` and run `pnpm tokens`. Never hand-edit either.

Merge into `dev` daily. Four lanes diverging for a week is the failure mode this structure
exists to prevent.

---

## Non-negotiables

Not preferences. Breaking any one of them is a defect.

1. **Money is integer fils.** No float touches money — not the API, not the database, not
   a computed total. Use `Fils` from `@avo/types`; it is a branded type, so a bare number
   will not type-check. Format to 3 decimals only at the display boundary.
2. **The server owns the balance.** Clients never add credit locally, never mint a QR
   token, never decide whether a happy hour is live for the purpose of a charge.
3. **`POST /charges` is one transaction.** Token consumption, deposit application, debit,
   visit/stamp increment, tier evaluation, receipt queue — all or nothing. If the debit
   fails, nothing else happened.
4. **Idempotency keys on every money-moving POST.** Top-ups, charges, orders, voids.
5. **Refunds are wallet credit.** No cash, no card reversal, on any surface, ever.
6. **Passwords are never stored in plaintext, never returned by an endpoint, never shown
   in a UI.** Owner console only sends a reset link. Staff PINs are hashed, rate limited,
   device-scoped, locked after N failures.
7. **Permissions are enforced server-side.** `perms.charges`, `perms.void`,
   `perms.marketing`, admin section permissions. The UI hiding a button is a courtesy, not
   a control. Every gated endpoint needs a test that calls it directly with the permission
   off.
8. **A merchant cannot send a customer message.** `POST /campaigns` only creates
   `pending`. Delivery happens on the platform decision endpoint, and caps and quiet hours
   are enforced again at send time.
9. **White text never goes on `--avo-brand`.** Use `--avo-brand-deep`. `--avo-brand` is a
   *surface* colour: gradients, tints, dots, progress fills. Validate derived variants at
   white-label onboarding with `deriveBrandSet()`; reject a hex that cannot produce a
   4.5:1 fill.
10. **The customer app holds no legal copy.** It renders the published policy set from the
    API and stamps the version. Store the accepted version against the member.
11. **Support ticket routing is resolved server-side** from `topicId`. A client-supplied
    route can land a wallet dispute in a salon's inbox.
12. **Arabic is a first-class layout, not a translation pass.** Full RTL mirroring, IBM
    Plex Sans Arabic, feminine address forms, Western digits for money.

---

## Shared packages

```
packages/types    Entities, endpoints, money, and the rules that must resolve
                  identically everywhere (happy-hour predicate, social URL
                  derivation, quiet hours). Source: design/api-contract.md.
packages/tokens   Generated from design/tokens/avo-tokens.json. CSS custom
                  properties, a React Native theme, TS constants, plus the
                  contrast maths behind non-negotiable #9.
```

Import money helpers from `@avo/types`, never reimplement them:

```ts
import { fils, add, subtract, formatMoney, commissionFor } from '@avo/types';

const balance = fils(24500);
formatMoney(balance, 'ar');       // "24.500 د.ك" — Western digits, always
commissionFor(fils(10000), 'knet'); // 150
```

And the happy-hour predicate, never a `live` flag:

```ts
import { isHappyHourLive, minutesRemaining } from '@avo/types';
```

---

## What the design files are

`design/*.dc.html` are **interactive design references**, not production code. Do not copy
their markup, their `localStorage` layer, or their device/browser frames. Read them for
layout, spacing, copy, colour, and interaction, then rebuild in the target stack.

`design/support.js`, `ios-frame.jsx`, `browser-window.jsx`, `image-slot.js` are
presentation scaffolding. Not part of the product.

`design/avo-promotions.js` is the reference implementation of shared platform state. Keep
the shapes and the rules; replace the storage layer with the real API. Its rules are
already ported into `packages/types/src/rules.ts` — use those.

---

## How to work

- **One vertical slice at a time.** A phase is done when the flow works end to end against
  the real API with the real states, not when the screen renders.
- **Build the states with the screen.** Loading, empty, error and offline are specified in
  `design/AVO States.dc.html` and `design/interaction-spec.md` §4. A screen without them is
  not done.
- **Test the money paths.** Charge, top-up, void, deposit return, and the concurrency cases
  (double scan, double submit, gateway retry) need automated tests before launch.
- **Do not add features.** If something seems missing, check the Known gaps section of
  `design/README.md` — it is probably a deliberate omission with a decision attached. Ask.
- **Do not restyle.** Colours, type, spacing and copy are settled. If a platform idiom
  conflicts with the design (Android back behaviour, Material elevation), follow the
  platform and note it.
- **Keep the copy verbatim.** Both languages. Product copy is written; do not paraphrase.

## Commands

```bash
pnpm install
pnpm tokens        # regenerate design tokens after editing avo-tokens.json
pnpm check         # typecheck + test across the workspace. NOT lint: there is no
                   # eslint config in this repo and eight of ten packages have no
                   # lint script, so `turbo run lint` is a no-op that reports
                   # success. The two that define one run `tsc --noEmit`. See
                   # decision 76 — do not cite a green `check` as a lint pass.
pnpm mock          # the mock API the wallet and dashboard lanes build against
pnpm db:migrate
```

## Escalate, don't guess

These belong to the client:

- CBK/PSP selection and counsel sign-off on the legal set
- Who monitors the AVO support queue, in what hours, and what the salon-routed queue is
- Data residency (leaning Kuwait, undecided) and the retention schedule
- Whether receipts send from AVO's domain or per-salon subdomains

---

## How this project is run

**Parallel subagent dispatch is authorised and expected.** Aftab asked for it explicitly and
asked for it to continue without waiting on him. A session picking this up should dispatch
lanes rather than build in the trunk checkout.

Read `STATUS.md` § "HOW THIS PROJECT IS RUN" first — it carries the worktree map, the
four-part brief shape, and the integration ritual. `LANES.md` has each lane's column and the
work order.

The short version: **you are the trunk.** Dispatch one subagent per lane into its own
worktree, two to four at once where columns do not overlap, integrate what comes back, then
dispatch the next slice. Do not build a lane's work yourself here.
