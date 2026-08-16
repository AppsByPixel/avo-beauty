---
name: screen-from-design
description: Extract everything needed to build one screen from the AVO design bundle — layout, verbatim copy in both languages, tokens, states, and the interaction rules that apply. Use before building or reworking any screen in apps/wallet, apps/dashboard or the scanner. Catches paraphrased copy, re-typed hexes, missing states, and the cases where the design file and the API contract disagree.
---

# screen-from-design

The design files are the source for layout, spacing and copy — but they are **not** the
only source, and on at least one screen they contradict the contract. This assembles the
full picture for one screen before any code is written, because the expensive mistakes here
are the ones you only find after the screen looks finished.

Take the screen name from the user. If none is given, work from the diff.

## 1 · Find the screen

| Screen | File |
|---|---|
| Wallet home, top-up, book, shop, account | `design/AVO Wallet Home.dc.html` |
| Scanner PIN, scan, charge, bookings, schedule | `design/AVO Staff Scanner.dc.html` |
| Merchant dashboard, all sections | `design/AVO Merchant Dashboard.dc.html` |
| Owner console, all sections | `design/AVO Owner Console.dc.html` |
| Web sign-in, both variants | `design/AVO Login.dc.html` |
| **Every loading / empty / error / offline state** | `design/AVO States.dc.html` |

Read the happy path in the screen file **and** the matching states in the states file. The
five screen files show the happy path only; a screen built from them alone is not done.

## 2 · Extract the copy, verbatim, in both languages

`CLAUDE.md`: *"Keep the copy verbatim. Both languages. Product copy is written; do not
paraphrase."*

```bash
grep -n "ar:\|'ar'\|العربية" "design/<file>.dc.html" | head -40
```

Put it in a `copy/` module, not inline in components. Two rules learned the hard way:

- **The currency unit does not belong in the copy file.** It comes off `formatMoney()` in
  `@avo/types` so it changes with the language. A local `kd: 'KD'` constant renders
  "24.500 KD" in the Arabic build — correct-looking in English testing, wrong in Arabic,
  and invisible until someone switches language.
- **Arabic uses feminine address forms** — اشحني، احجزي، أنتِ. The customer base is
  women's salons. A masculine form is a copy defect, not a nuance.

## 3 · Take every colour from the tokens

Never re-type a hex. `@avo/tokens` for React Native, `@avo/tokens/css` for web.

```bash
grep -rhoE "#[0-9A-Fa-f]{6}" apps/<app>/src | sort -u
```

Anything that returns is a finding unless it sits in a comment explaining why the code
doesn't use it. If a value in the design genuinely has no token, **report it** — do not
invent one. Three tokens were added this way (`textMutedLabel`, `borderControl`, `white`)
after a lane found values the design used 154, 111 and many times with nothing to name them.

And non-negotiable #9: white text goes on `brand-deep`, never `brand`. `--avo-brand` is a
*surface* colour — gradients, tints, dots, progress fills.

## 4 · Build the four states with the screen

Not after. Drive them from the mock:

```
x-avo-scenario: loading | empty | error | offline | stamps | declined | cancelled | pending | lowbal | noperms
```

They combine — `empty,stamps` is a new member at a stamps salon, which is a different card
from an empty tiers member. Run `/states-check` on the finished screen.

## 5 · Apply the interaction rules

From `design/interaction-spec.md`:

- **Web** — the four breakpoints (§1), `:focus-visible` never `:focus`, the keyboard map
  (§2), and the below-768 notice, which is the design and not a gap.
- **Mobile** — tap targets ≥ 44px, and reduced motion **removes** the scanner line, the
  success pop and the pulse rather than shortening them (§3).
- **Money** — `moneyAriaLabel()` so `18.000` reads as dinars, not eighteen thousand.

## 6 · Cross-check the design against the contract

**This step exists because the bundle contradicts itself.** Before building anything that
displays a value, check what `design/api-contract.md` says about it.

The known case: `AVO Wallet Home.dc.html:1239` shows `knetFee: '150 fils fee'` and
`cardFee: '2.5% + 50 fils'` in the **customer** wallet, and again as a "Processing fee" row
in the transaction sheet — translated into Arabic at line 1346, so it is deliberate, not a
leftover. But `api-contract.md:469` says commission is *"merchant-visible, customer-never"*
and the product brief says *"no added fee shown"*.

Two documents against one. Unresolved at the time of writing.

**When the design and the contract disagree, build neither and ask.** Guessing puts a
number in front of a customer that someone decided they should not see, or removes one
someone decided they should.

Check specifically for: money the customer may not be entitled to see, fields that do not
exist on the entity, and states the contract says are impossible.

## 7 · Report before you build

Produce this, then build from it:

```
SCREEN   Wallet home
SOURCE   design/AVO Wallet Home.dc.html (happy path)
         design/AVO States.dc.html (loading, empty, error, offline)
COPY     18 strings, EN + AR — extracted to src/copy/
TOKENS   brand-deep (buttons), brandTint (chips), textMutedLabel (micro-labels)
         GAP: no token for the offline dot; composites from textMuted, reported
DATA     GET /members/me, /transactions, /wallet-token   (@avo/types)
STATES   4 + the empty,stamps crossing
RULES    44px targets, QR hidden offline, money aria-labels
CONFLICT none
```

Any line reading `CONFLICT` is a stop-and-ask, not a judgement call.
