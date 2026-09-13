# Deploying the demo

A reachable URL for the dashboard and the API, on free tiers, for showing the
product. **This is not the production deployment and cannot become one by
changing a variable** — the reason is the first section below, and it is worth
reading before you spend an evening on it.

`go-live-checklist.md` is the real thing. This is the demo.

---

## The one blocker, and why it is not a bug

**The API refuses to boot with `NODE_ENV=production`, on purpose, and there is
no combination of environment variables that gets a demo past it.**

`api/src/env.ts:486`:

> `GATEWAY_DRIVER=sandbox` settles payments nobody paid for. Select a real
> processor before production.

The only other driver is `myfatoorah`, and `:502` refuses to boot with it unless
real processor credentials are present — which is a client decision this project
does not have (CLAUDE.md § Escalate, don't guess: "CBK/PSP selection").

So the honest configuration for a demo is `NODE_ENV=development` on a public
host. That is not defeating the assertion; it is answering it. A demo *is* a
deployment where the money is fake, and the environment should say so rather
than claim production and then be lied to about the gateway.

`render.yaml` does exactly this, with the reason written at the top of the file
so nobody later reads it as an accident.

---

## What is weaker here than in production

Four things, all consequences of the above. None is a defect; each is a fact to
know before someone draws a conclusion from the demo.

**1 · Money is not real, and the gateway will confirm anything.** The sandbox
gateway settles a top-up nobody paid for. Charges, wallet balances, tiers and
the ledger are all genuinely exercised — only the payment leg is fabricated.

**2 · Uploaded images do not survive a restart, and there are none to begin
with.** `IMAGE_DRIVER=disk` writes to the container filesystem, which a free
service replaces on every deploy and every wake from idle. `db/seed.ts` inserts
no images at all, so products and services start with placeholders. If the demo
needs pictures, upload them immediately before showing it, or attach a persistent
disk (paid).

**3 · Anyone with the URL can sign in.** `db/seed.ts` creates its console and
staff users with known development passwords — `yousef / yousef-dev-password`
and friends, printed by the seed itself. That is correct for a seed and wrong
for something on the public internet. Either treat the URL as the secret, or
change the passwords after seeding. **Do not put real customer data in it.**

**4 · The first request after an idle period is slow.** A free service spins
down. The wake takes tens of seconds, and it will happen at the worst moment.
Hit the URL a minute before showing it to anybody.

---

## The stack

| | | |
|---|---|---|
| Dashboard | Render static site | free, no spin-down, CDN |
| API | Render web service | free, spins down when idle |
| Postgres | **Supabase** — project `avo-demo`, `eu-central-1` | **provisioned 2026-09-13, migrated, seeded, 93/93 verified** |

Postgres is **not on Render** deliberately: its own free database has
historically been time-limited, and a demo database that expires a month later
is a demo that breaks with no warning. Supabase's free tier pauses after about a
week of inactivity instead and wakes on request, which is a better failure mode
for something shown occasionally. Check current terms before relying on either —
they change, and this file will not know.

`eu-central-1` matches `render.yaml`'s `frankfurt` on purpose: the latency that
matters is API-to-database, not you-to-database. Note this puts demo data in the
EU, which is one of the two candidate answers to the open data-residency
question (CLAUDE.md § Escalate) — fine for seeded fixtures, a decision to make
properly before anything real.

Nothing here is Render-specific except `render.yaml` itself. The API is a plain
Node process (`pnpm --dir api start`) and the dashboard is a static Vite build,
so any host that runs Node 22 and serves a directory will do.

---

## Steps

**I cannot do the account parts.** Creating accounts and entering credentials is
yours — I can prepare everything else, and have.

### 1 · Database — **already done**

Supabase project `avo-demo` (`ndzmbfeyymvyiwpbjxfk`, `eu-central-1`) exists,
is migrated, is seeded, and passes all 93 invariants. Both connection strings
are in the scratchpad file named in the handover note, not in this repo.

It has **two roles**, not one, and the split is not ceremony: an owner can
`UPDATE` its own tables regardless of `REVOKE`, so serving requests as the owner
would make the append-only ledger guarantees decorative — the API would be
*allowed* to rewrite history it promises never to rewrite.

- `postgres` — owns the tables → `DATABASE_URL`
- `avo_app` — created `LOGIN`, non-owner, granted `CONNECT` → `APP_DATABASE_URL`

**Three provider-specific things, each found by doing it rather than reading
about it. Any of them would have cost an evening.**

1. **Use the pooler host, not the direct one.** `db.<ref>.supabase.co` has an
   `AAAA` record and no `A` record — it is **IPv6-only**, and a host without
   IPv6 egress cannot reach it at all. `aws-0-eu-central-1.pooler.supabase.com`
   resolves through an ELB with IPv4.
2. **Session mode (port 5432), not transaction mode (6543).** `db/client.ts` is
   `postgres(url, { max: 10 })`, and postgres.js uses prepared statements by
   default. Transaction pooling does not support them. Session mode does.
3. **`GRANT avo_app TO postgres` before verifying.** Supabase's `postgres` is
   not a superuser, so `verify-constraints.sql` failed at line 221 with
   `permission denied to set role "avo_app"` — it impersonates the app role to
   prove the `REVOKE`s actually bite. The grant makes `SET ROLE` legal; it
   changes nothing about who owns the tables.

Then verify — and note the wrapper cannot do this. `api/scripts/db-verify.sh`
shells to `docker exec avo-postgres`, so it only ever targets the local
container. Against a managed provider, run the SQL the wrapper runs:

```bash
psql "$DATABASE_URL" -q -f api/scripts/verify-constraints.sql
```

**That returned `invariants checked: 93   failed: 0` on Supabase**, which is
worth more than it sounds: ADR-0001's claim that the schema is provider-neutral
had only ever been tested against the local container. It now holds on a second
provider, with the append-only triggers and the non-owner `REVOKE`s intact.

### 2 · Schema and seed — **already done**

For the record, this is what was run, and it is what to re-run if the demo
database is ever rebuilt:

```bash
DATABASE_URL='…owner…' APP_DATABASE_URL='…app…' pnpm --dir api run db:migrate
```

```bash
DATABASE_URL='…owner…' APP_DATABASE_URL='…app…' pnpm --dir api run db:seed
```

The seed prints the credentials it creates. They are development passwords —
see "Anyone with the URL can sign in" above.

**`scripts/demo-seed.sh` will NOT work against this database.** It shells to
`docker exec` in three places, so it is local-only. The richer diary it builds —
appointments on the next open day, one charged visit attributed to an artist —
is not available on the demo unless someone adapts the script or does it through
the UI. The base seed is still substantial: two members with balances, tiers and
visit history, a salon with two branches, staff with PINs, and three console
users.

### 3 · Services

Point Render at the repo as a Blueprint; it reads `render.yaml` and creates both
services. Then fill in the four secrets it leaves blank, in the Render dashboard:

| Service | Variable | Value |
|---|---|---|
| `avo-api` | `DATABASE_URL` | Supabase pooler URL, `postgres` role |
| `avo-api` | `APP_DATABASE_URL` | Supabase pooler URL, `avo_app` role |
| `avo-api` | `PUBLIC_BASE_URL` | the dashboard's URL, once it has one |
| `avo-dashboard` | `VITE_AVO_API_URL` | the API's URL |

`VITE_AVO_API_URL` is read at **build** time, so changing it needs a redeploy of
the static site, not a restart.

### 4 · Check it

```bash
curl -sS "$API_URL/v1/platform/policies" | head -c 200
```

A JSON policy set means the API booted, reached Postgres, and the seed landed.
An empty reply usually means the service is still waking up.

**Rehearse it locally first** — this exact shape was driven against the local
`avo_ci` before this file was written, and it is the fastest way to find a typo
in an environment variable without waiting on a deploy:

```bash
NODE_ENV=development PORT=4599 DATABASE_URL='…' APP_DATABASE_URL='…' JWT_SECRET='at-least-32-characters-long-please' GATEWAY_WEBHOOK_SECRET='at-least-16-chars' TRUST_PROXY=1 pnpm --dir api start
```

It should log `Server listening`, `receipt worker on, driver=logging`, and a
no-show worker tick. The top-up reaper logging that it is **off** is correct and
is the default.

---

## Gotchas that will cost you an hour each

- **`pnpm install --prod` breaks the API.** `api`'s `start` runs `tsx`, a
  devDependency. A production install prunes it and the service dies with
  `tsx: not found`, which reads like a missing package rather than a pruned one.
- **`pnpm build` is required even though `api` has no build script.** It imports
  `@avo/types` and `@avo/tokens` from their built `dist/`, which is gitignored.
  Without it the process dies at import, before any of the readable boot errors.
- **`--dir`, never `--filter`.** `--filter` runs from the workspace root, so
  `--env-file-if-exists=.env` resolves against the wrong directory and the
  command exits 9 with nothing useful said. RUNBOOK.md carries this too.
- **Connection ceiling.** `db/client.ts` opens a pool of `max: 10`. Free
  Postgres tiers cap connections low, which is the other reason both URLs go
  through the **pooler** rather than direct — otherwise the API exhausts them
  and fails in a way that looks like a query bug.
- **The secrets have minimum lengths, enforced at boot.** `JWT_SECRET` must be
  at least **32** characters and `GATEWAY_WEBHOOK_SECRET` at least **16**. Too
  short is a boot refusal, not a warning: `JWT_SECRET: String must contain at
  least 32 character(s)`, and the process exits 1. If your host's generated
  value is shorter, set one by hand.
- **There is no health endpoint.** Nothing serves `/health`, so `render.yaml`
  declares no health check and the platform probes the port instead. Adding one
  is a product change — ask first (CLAUDE.md: "Do not add features").

---

## What this demo does not show

- **Receipts do not send.** `RECEIPT_DRIVER=logging` queues and logs; nothing
  reaches a customer. Real sending needs WhatsApp template approval and a
  transactional email domain — both client-owned.
- **Calendar is a stub.** `CALENDAR_DRIVER=stub`; no Google project exists.
- **Arabic has unreviewed strings.** 81 keys have no source in the design bundle
  and await a native-speaker review. Demo in English unless that is the point.
