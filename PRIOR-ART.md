# What AvoRewards already learned

AVO runs a white-label wallet and loyalty platform for roughly ten food-and-drink tenants.
We are not extending it (`design/ADR-0001-stack.md`, addendum), but it has been in
production for years and the lessons in it were paid for. These are the ones that apply
here.

Source: `AvoMobileApps-Lean` (branch `Lean`), and its `CLAUDE.md`.

---

## The contrast bug, forty-seven times

From their working notes:

> Labels on PRIMARY are ink, never white — the blue is light enough that white fails
> contrast. `brand.onPrimary` exists for this. **This has been fixed ~47 times across the
> app**; if you add a blue button, use ink.

This is our non-negotiable #9, discovered independently on a different palette. A token
existed. A rule was written down. It was still broken forty-seven times.

**What we do differently:** `deriveBrandSet()` in `packages/tokens` does not trust anyone
to remember. It derives `deep` from the merchant's hex, measures it, and **refuses the
colour** if white cannot clear 4.5:1. The rule is enforced at the point of entry rather
than documented and hoped for. `assertWhiteIsLegible()` is the same guard for call sites.

The same note records a second-order version of the bug: the brand blue was originally
sampled off a PDF render, which produced `#5DC9F3` at one resolution and `#7AC7EF` at
another. **Take brand values from the source, never from a render.** Ours come from
`design/tokens/avo-tokens.json`, generated, never re-typed.

## The token that existed but nobody used

> Every filled primary button uses this. They had drifted to 4, 5, 10, 17 and 30 across
> the app because the token existed but only three call sites used it.

A token nobody imports is a comment. This is the argument for `packages/tokens` being
**generated** and for CI failing when the generated file drifts from source — a convention
that isn't mechanically enforced decays at exactly this rate.

## Tier progress: the field means the opposite of what it reads like

> `percentageLeftToNextLevel` is percent REMAINING. Using it raw draws a full bar for a
> user with zero points.

Directly relevant to our wallet card. When Lane A designs the loyalty response, name the
field for what it contains — `visitsToNext`, not `percentageLeft` — and if a percentage is
ever exposed, make the direction unambiguous in the name. A field whose name implies the
inverse of its value will be misread, and the failure is silent and flattering.

## Branch-per-brand is the model we are not repeating

Ten brands, ten long-lived git branches, one Xcode scheme each, one `theme/brand.js` each.
Every fix is cherry-picked ten times, and a brand can silently miss one.

`go-live-checklist.md` requires the opposite: one brand token, name, logo and typography
pairing producing a per-salon app **with no code change**. Keep that property; it is the
main architectural improvement Beauty makes over the platform it grew out of.

## Choices worth copying

- **`react-native-qrcode-svg`** for QR rendering — already proven on this exact use case
  (a customer showing a code at a counter). Lane B should use it rather than evaluating
  from scratch.
- **One brand file, no scattered hexes.** Their `src/theme/brand.js` is the right instinct;
  ours is the same idea, generated rather than hand-maintained.
- **Their brand file documents *why* each value is what it is** — measured off a specific
  artboard at a specific scale. Worth imitating. A hex with a reason survives a redesign
  argument; a hex without one gets changed by whoever is most confident.

## Platform facts, if we ever need to interoperate

- API base: `https://nextwhitelabelling-prod.azurewebsites.net/api`, .NET/ABP conventions
  (`/services/app/Wallet/GetCurrentUserDepositAmount`), Bearer auth.
- **Prod only — there is no staging.** Anything we test against it is live.
- Tenanting is `COMPANY_ID` + `brandId`. Accounts are scoped per company: signing in with
  another tenant's account returns *"Invalid user name or password"*, which reads like a
  wrong password but means "no such account here". Worth knowing if a salon owner ever
  holds accounts on both platforms.
- Money is floats (`parseFloat(n).toFixed(d)`). Any integration boundary between their
  system and ours has to convert at the edge, and that conversion is a place to put a test.
