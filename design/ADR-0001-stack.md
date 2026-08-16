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

**PSP.** Out of the pilot's path by decision — the gateway sits behind an adapter with a
sandbox implementation. Swapping in the contracted processor is a config change and one
adapter, not a rebuild.
