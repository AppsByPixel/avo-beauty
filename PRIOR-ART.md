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

## Two things the live app confirmed for us

**The customer never sees a payment fee — checked twice, independently.** Zero fee or
commission strings anywhere in Lean's source or either localisation file. And the payment
method list renders exactly one field per method:

```js
{langugaeId === 'ar' ? item?.nameAr : item.name}     // topupModal.js:233
```

A name. No fee, no per-method charge. That is the opposite of what
`AVO Wallet Home.dc.html` draws (`knetFee: '150 fils fee'` under each method), and it
matches what the product owner confirmed: the AVO/salon split is configured inside
MyFatoorah and "the customer doesn't see this of course, they just see the price."

**`nameAr` on backend entities is the house pattern.** That same line picks an Arabic name
off the entity by language. We added `nameAr` to `Salon` and `Branch` because the bundle's
own `avo-promotions.js` carries it; the production system has been doing it on payment
methods all along. Independent confirmation that the field belongs on the entity rather
than being derived or hardcoded per client.

**The app is payment-provider agnostic, and deliberately.** Lean names no gateway anywhere.
The backend returns a hosted payment URL, the app opens it in a webview
(`screens/webviews/knwtWebView.js`) and watches the return path for `/Success`. That is why
MyFatoorah appears nowhere in the app — the integration lives server-side.

Which is the same shape Lane A built: `POST /topups` returns `redirectUrl`, the client opens
it, then re-reads `GET /topups/{id}` for the authoritative status. Arrived at from the
contract rather than copied, and it agrees with a system already in production.

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

---

## The shop is delivery-based, and Lean already settled how

Added 2026-09-09, when Aftab asked for AVO Beauty's shop to be delivery-based and said to
follow Lean's flow. Read out of `~/Desktop/AvoMobileApps-Lean` (branch `Lean`) rather than
from memory. Four decisions come free, and one thing must not be copied.

**Pickup is not replaced. It is a fork.** `src/components/Modals/deliveryOption.js` sets
`deliveryOption` to `"pickup"` or `"address"`, and both paths are live. So "delivery-based"
means delivery is *available and chosen*, not that collection is removed — which also
answers whether to drop the design bundle's Pickup copy. Keep it.

**Three order statuses, not a workflow engine.** `PREPARING → READY → CLOSED`. That is the
whole lifecycle in an app that has served ten tenants for years. Anything richer than this
is a thing we would be inventing, not following.

**A saved address book, with coordinates.** Google Places autocomplete fills the
structured parts, the customer types the rest, `longitude`/`latitude` ride along, and the
address is named (`saveAs`) so it can be reused. Addresses belong to a `userId`, not to an
order.

**There is no delivery fee anywhere.** No `deliveryCharge`, no `deliveryFee`, no
`shippingFee` in the source. This is the most consequential finding for us: following Lean
keeps the shop **entirely off the money path**, so no idempotency key, no atomic
multi-table write, and no refund-as-wallet-credit case to design. If a fee is ever wanted
it is its own slice with its own decision, not part of making delivery work.

### The one thing not to follow

`src/components/address/addressDetail.js:110-140` builds its payload like this:

```js
block:          data.houseNo,
street:         data.landMark,
buildingNumber: data.houseNo,
floor:          data.houseNo,
apartment:      data.houseNo,
areaId: 1,  regionId: 1,
jadda: 'string',  instructions: 'string',
```

**The customer fills two inputs — `houseNo` and `landMark` — and one of them is sent as
four different address fields.** A landmark is written where the street belongs, `areaId`
and `regionId` are hardcoded to 1, and two fields ship the literal text `'string'`.

Kuwaiti addresses are genuinely block, street, building — so a driver receives a house
number in the block field and a landmark in the street field. This is the same shape as
the contrast bug above: a real thing, in production, that costs somebody real time on the
day it matters.

**What we do differently:** collect the fields we actually intend to store, store exactly
those, and let a field be empty rather than filling it with a copy of another field or a
placeholder. If Places cannot resolve a component, that component is `null` — not
`'string'`, and not the house number.

---

## Lean's coupon shape is right and its enforcement is in the wrong place

Added 2026-09-09, scoping AVO-issued vouchers. `src/screens/redeemPoints/index.js:211`.

**The shape is worth taking.** A coupon is `couponText` (the code), an optional
`minimumAmountIsCart` (minimum spend), and an `optionType`/`optionList` pair restricting
it to named products. Three fields, and they cover most of what a voucher needs.

**The enforcement is entirely client-side, and we must not copy that.** `applyDiscount`
fetches a list of promos, finds the code in it **in the app**, compares the cart total to
the minimum **in the app**, and filters ineligible products **in the app**. So the client
decides whether a discount applies and what it is worth.

That is non-negotiable #2 with a different subject: *the server owns the balance, and
clients never decide what a thing costs.* A coupon that reduces what a customer pays is a
price decision, and a price decision made in an app is one a modified app makes
differently.

**What we do differently:** the code is resolved server-side, the eligibility rules are
evaluated server-side, and the client submits a code rather than a discount. The app may
*preview* what it expects — it may not *assert* it. Same rule the wallet's top-up card
already follows: `TopUpCard` deliberately shows no client-computed bonus figure because
`bonusFils` is the server's to decide.

**Second instance of the same lesson in this file.** Lean's address payload (above) has the
right fields and fans one input across four of them; its coupon has the right fields and
enforces them in the wrong process. The pattern worth naming: *take Lean's vocabulary,
never Lean's trust boundary.*

