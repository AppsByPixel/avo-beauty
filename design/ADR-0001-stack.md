# ADR-0001 — Stack selection

**Status:** Accepted · **Date:** 2026-08-16 · **Decides:** the "Nothing is chosen yet"
row in `CLAUDE.md` § Stack, required before phase 1 of `build-plan.md`.

## Context

One developer, 30 days, targeting a pilot: one salon running real transactions on real
hardware against a sandbox gateway. Scope is `build-plan.md` phases 0–4; booking, shop,
the owner console, promotions and store submission are deferred.

Four constraints shape every choice below:

1. **Money correctness outranks developer convenience.** `POST /charges` is one atomic
   transaction over five tables. Whatever sits between the handler and the database has to
   be thin enough to reason about under concurrency.
2. **The wallet is web-first.** The brief is explicit: *"low-friction adoption: web-first
   customer wallet, no forced app download."* A stack that forces an app download to run
   the pilot contradicts the product.
3. **`CLAUDE.md` requires shared codebases** — the two mobile apps share one, the two web
   surfaces share one, everything shares the API and the token package.
4. **Data residency is undecided, leaning Kuwait.** Nothing may depend on a
   cloud-provider-specific database feature until that is settled.

## Decision

### Repository — pnpm workspaces + Turborepo

```
api/                  Fastify service — the only writer of money
apps/wallet           Expo, web + native targets
apps/scanner          Expo, native only (camera)
apps/dashboard        React + Vite (merchant; owner console added later as a route scope)
packages/types        generated from api-contract.md, shared client + server
packages/tokens       generated from tokens/avo-tokens.json
packages/ui           web component library, shared by dashboard and console
```

`packages/tokens` is **generated, never hand-written**. `CLAUDE.md` says "never re-type a
hex"; a build step is the only way to actually enforce that. It emits CSS custom
properties for web, a React Native theme object, and TypeScript constants from one source.

### API — TypeScript · Fastify · Postgres · Drizzle · Redis/BullMQ

**Fastify over NestJS.** NestJS's dependency injection and module system pay off on a team
over a year. Here they add a layer between the request handler and the SQL transaction,
and that transaction is the single highest-risk thing in the product. Fastify keeps the
charge handler readable in one screen.

**Drizzle over Prisma.** The money paths need explicit transaction control, `SELECT … FOR
UPDATE`, and `CHECK` constraints expressed in migrations. Drizzle emits SQL you can read
and puts those in reach; Prisma abstracts exactly the layer that must not be abstracted.
Non-negotiable #1 — integer fils, no floats — is enforced as `bigint` columns with
`CHECK` constraints, which is a schema concern, not an application one.

**Postgres, provider-neutral.** No managed-service-specific extensions, no
provider-specific auth, no row-level-security scheme that ties us to one vendor. Plain
Postgres 16 that can be restored into whichever region the residency decision lands on.

**Redis + BullMQ** for the receipt queue, the WhatsApp queue, and later the no-show
deposit-return job. A failed WhatsApp send must never roll back the charge that triggered
it (`whatsapp-templates.md` § Delivery notes), which means the send has to be a queued job,
not an inline call.

### Wallet and scanner — one Expo codebase, React Native + react-native-web

This is the choice that buys the schedule. Expo with the web target satisfies both
constraints at once: the two mobile apps genuinely share a codebase and a token package,
**and** the wallet builds to mobile web for the pilot — no forced download, no App Store
review inside the 30 days, no rewrite when it does go to the stores.

The scanner builds native only, because it needs the camera.

Rejected alternatives:

- **Flutter** — a fine choice for the two apps, but it puts the wallet behind an app
  install for the pilot and adds a second language and a second token pipeline to a
  one-person build.
- **Native SwiftUI + Jetpack Compose** — the best result and roughly triple the surface
  area. Two platforms × two apps is four codebases for one developer in 30 days.
- **React web wallet + separate Expo scanner** — ships the pilot, but breaks "the two
  mobile apps share a codebase" and means porting the wallet later.

### Dashboard and console — React + TypeScript + Vite

Client-side SPA with TanStack Query and TanStack Router. These are authenticated internal
tools behind a login — there is no SEO case and no first-paint case that justifies a
server-rendered framework's added deployment complexity.

The owner console is **the same application** with a different auth scope and shell, not a
second app. It is deferred out of the 30 days, but the routing and permission structure is
built to accept it from day one so adding it later is not a refactor.

## Consequences

**Good**

- One TypeScript language across all four surfaces and the API; types generated once from
  `api-contract.md` and shared, so a contract change breaks the build rather than
  production.
- The wallet reaches pilot users through a URL. Store submission becomes a later,
  independent workstream instead of a dependency on the pilot date.
- Money logic sits in readable SQL inside explicit transactions, which is what the
  concurrency suite in phase 2 has to test against.

**Accepted costs**

- React Native's web output is heavier than a purpose-built React web app. Acceptable for
  a wallet whose heaviest screen is a QR code and a list.
- Fastify gives less structure than NestJS. Mitigated by keeping money logic in a service
  layer with its own tests, not in route handlers.
- Running our own Postgres and Redis rather than a managed platform is more operational
  work. That is the direct price of keeping the residency decision open, and it is the
  right price to pay.

## Open, and blocking nothing yet

**Data residency.** Leaning Kuwait. Managed Postgres options inside Kuwait are materially
narrower than in Bahrain or the UAE, and the answer changes the hosting bill and the
provisioning lead time — I have not verified the current in-country options and should
before this is committed. Until then the schema and deployment stay provider-neutral, so
the decision costs nothing today and gets expensive only once production data exists.
Start the procurement conversation in week one.

**PSP — ANSWERED 17 Aug 2026: MyFatoorah.** The product owner confirmed AVO already uses
MyFatoorah as its payment provider, and that the AVO/salon split is configured inside
MyFatoorah rather than computed by this API.

This is exactly what the adapter was built for. `GATEWAY_DRIVER` currently accepts only
`sandbox`; adding `myfatoorah` is one driver in `api/src/gateway/` plus credentials — no
change to the charge path, the webhook state machine, or the signature verification, all of
which were built against the interface rather than a provider.

Still open, and NOT answered by this: the **CBK position**. MyFatoorah being a licensed
processor answers "who moves the money"; it does not answer whether AVO holding stored value
requires its own licence. Those are different questions and `go-live-checklist.md` lists
them separately.

---

## Addendum, same day — AvoRewards reviewed and deliberately not extended

The original decision above was taken without knowledge of **AvoRewards**, AVO's existing
white-label wallet and loyalty platform, live with roughly ten food-and-drink tenants
(Lean, Harvest, ACR, Aseer Time, Matcha Matcha, Nejoud, Roast Coffee, Say Suco, MHB, Back
Burner). Source reviewed: `AvoMobileApps-Lean`.

That platform is:

| | |
|---|---|
| Mobile | Bare React Native 0.69.5, yarn, patch-package |
| Backend | .NET / ABP on Azure — `nextwhitelabelling-prod.azurewebsites.net/api` |
| Tenanting | `COMPANY_ID` + `brandId` routing keys, accounts scoped per tenant |
| White-label | One git branch per brand, one Xcode scheme per brand, one `theme/brand.js` per branch |
| Already built | Wallet, deposits, loyalty levels, QR, stores, orders, Apple Pay |

**Decision: AVO Beauty is a new platform, not a new tenant. Expo is kept.** Confirmed by
the product owner after review. Three reasons, in order of weight:

1. **Money.** AvoRewards handles money as floats —
   `convertToDecimals = (n, d) => parseFloat(n).toFixed(d)` in `src/helper/cart.js`.
   Non-negotiable #1 requires integer fils end to end. In KWD at three decimals this is
   foundational, not a refactor, and changing it inside a system already serving ten
   tenants is a larger and riskier job than building correctly here.
2. **Web-first.** The brief requires a customer wallet reachable without an app download.
   AvoRewards is app-only. Expo with the web target serves the requirement and keeps store
   review off the 30-day critical path.
3. **White-label model.** `go-live-checklist.md` requires a pipeline producing a per-salon
   app from one brand token, name, logo and typography pairing **with no code change**.
   Branch-per-brand is the opposite, and every fix must be cherry-picked ten times. The
   handoff is an explicit correction of the current approach; adopting that approach would
   defeat it.

**Accepted cost:** AVO will run two mobile stacks and two backends. Real, and the reason
this is written down. It is the price of the three points above, and it was paid knowingly.

**What we take from AvoRewards anyway** — see `PRIOR-ART.md`. The hard-won operational
knowledge in that codebase is worth more than its architecture.

---

## Addendum 2 — .NET / Angular proposed, current stack kept

The engineering manager proposed **.NET backend, Angular dashboard, React Native mobile**.
Evaluated; the existing stack is kept. Decision by the product owner.

**The proposal was sound, and this is not a rejection of it on merit.** Recording the
reasoning so nobody re-litigates it later from a weaker position:

- **Mobile was never in dispute.** Expo *is* React Native. The only live question there is
  whether the web target survives, and it must — the brief requires a web-first wallet with
  no forced app download, which bare RN cannot serve. Expo ships that as a URL for the
  pilot and to the stores later from one codebase.
- **.NET is genuinely strong here, and better than TypeScript on one axis.** C# gives a real
  runtime money type (`readonly record struct Fils(long)`) where our branded `Fils` is a
  compile-time construct that erases at runtime. AVO also already runs .NET on Azure. This
  was the strongest part of the proposal.
- **Angular is a reasonable fit** for a keyboard-driven data tool. Its cost here is that the
  AVO design system is custom, so Angular Material would need heavy overriding to reach the
  intended spa-clean look.

**Why we stay anyway:** a 30-day money-critical build carries more risk from an unfamiliar
language than it gains from long-term house-stack alignment. The pilot date is the
constraint being optimised for, and it is the product owner's call.

**Cost of reversing later.** Roughly two days today, and it grows. Stack-independent and
safe either way: the design tokens, the mock API, **Lane D's entire e2e suite** (it speaks
raw HTTP and imports nothing from `@avo/types`, deliberately), the API contract, and the
schema *design* — `bigint` fils, the non-negative CHECK, the append-only audit log. Redone
on a switch: Lane A's Drizzle implementation, `packages/types` becoming OpenAPI-generated,
and the dashboard shell.

**Revisit if** the answer to "who maintains this after the pilot" turns out to be AVO's
existing .NET/Angular team. That single fact would outweigh everything above, and it is
still unanswered.
