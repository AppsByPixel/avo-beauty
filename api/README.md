# `@avo/api`

The Fastify API. Everything about *how* the service behaves lives next to the code
it describes — this file is only the map of the **test surfaces**, because one of
them does not run in `pnpm check` and that is the kind of fact that has to be
findable without opening a config file.

## Two test suites, and only one of them is gated

| | Config | Script | Runs in `pnpm check`? |
|---|---|---|---|
| **Unit** | `vitest.config.ts` | `pnpm --dir <abs>/api run test` | **Yes** |
| **Integration** | `vitest.int.config.ts` | `pnpm --dir <abs>/api run test:int` | **No — see below** |

The unit config points `DATABASE_URL` at port 1 on purpose, so a unit spec that
connects to anything fails loudly instead of quietly passing against whatever
database happened to be exported. It therefore also *excludes* `**/*.int.test.ts`:
a spec that has to prove something about a row cannot live under it.

### Running the integration suite

Against **your own lane database**, never a shared one:

```bash
/Users/koraspond_developer/dev/avo-<lane>/scripts/lane-db.sh a
export AVO_INT_DATABASE_URL="postgres://avo_app:avo_app_dev_password@localhost:5433/avo_lane_a"
pnpm --dir /Users/koraspond_developer/dev/avo-<lane>/api run test:int
```

With `AVO_INT_DATABASE_URL` unset every spec **skips with a printed reason** rather
than connecting to something it was not pointed at. Absolute paths and `--dir`, not
`--filter` and not `./scripts/...` — `LANES.md` § "Every lane isolates its own
resources" carries why.

The suite is idempotent: it may be run repeatedly against the same database with no
reset in between, and it deletes nothing. Counts are asserted as **deltas** against
what each run finds, because `topup_intent` rows are real payment records and a
suite that truncates them to stay green is a suite that can hide a real charge.
Measured 2026-08-25 — fresh database `26 passed (26)`, immediate re-run on the same
database `26 passed (26)`.

---

## ⚠ KNOWN GAP: `pnpm check` does not run the integration suite

`pnpm check` is `turbo run typecheck lint test`. Turbo's `test` task for this
package resolves to `vitest run --passWithNoTests` — the **unit** config — so
`test:int` is never invoked by any gate. Verified with
`pnpm turbo run test --dry=json`.

**What that means in practice:** a green `pnpm check` says nothing about the
assertions in `src/**/*.int.test.ts`. Today those are the rate limiters
(`services/scannerLimit.int.test.ts`, `services/topupLimit.int.test.ts`) and the
per-link social endpoint (`routes/socialLink.int.test.ts`) — including the one claim
no pure spec can make, that **a refused request moved no money**. A limiter that
fires *after* the debit refuses the customer *and* charges her, and that regression
would pass every gate this repo runs.

**Why it is not simply wired in.** The suite needs a live Postgres with this lane's
schema and seed. The workspace package that already solves that problem is `e2e/`,
which mints an unguessable per-run database in `support/global-setup.ts` and boots
the API against it; duplicating that provisioning here would be a second harness
free to drift from the first. But `e2e/` is **Lane D's column** (`CLAUDE.md` §
Lanes) and Lane A may not write to it.

**Who closes it.** Lane D, by rehoming these assertions into `e2e/` — or trunk, by
deciding that `api` provisions its own database. Until one of those happens, run
`test:int` by hand after any change to a limiter or to `POST /topups`,
`POST /charges` or `POST /scans`. `vitest.int.config.ts` carries the full argument.

---

## Two entry points: `src/server.ts` and `src/serverless.ts`

Both build the same app with the same `buildApp()`. The difference is the loops.

| | `src/server.ts` | `src/serverless.ts` |
|---|---|---|
| Started by | `pnpm --dir=/abs/path/to/api start` | the platform, per request (`api/index.ts`) |
| Listens | yes, on `PORT` | no — Fastify's server is fed `'request'` events |
| Receipt worker | on unless `RECEIPT_WORKER_ENABLED=0` | **never** |
| No-show worker | on unless `NO_SHOW_WORKER_ENABLED=0` | **never** |
| Top-up reaper | off unless `TOPUP_REAPER_ENABLED=1` | **never** |

`server.ts` is unchanged by the serverless port and is still the way to run this
API as a process. Nothing selects between the two at runtime: they are two files,
and a deployment picks one by picking what it invokes.

### What the absent background jobs cost

A serverless deployment runs no loop at all, so each of the five is a scheduled
invocation of its existing one-shot script (`pnpm run job:*`) or it does not
happen. In order of what it costs to skip:

- **`job:no-show` — the one that matters.** Without it a customer who misses an
  appointment keeps her deposit held out of her wallet for ever. It is money the
  product promises to return, and nothing else returns it.
- **`job:topup-reap`** — off by default even under `server.ts` (DECISIONS.md #27),
  so its absence changes nothing. Abandoned intents accumulate either way.
- **`job:campaign-release`** and **`job:erasure`** — both are deliberate manual
  passes today; a schedule would be a new behaviour, not a restored one.
- **the receipt worker** — costs nothing while `RECEIPT_DRIVER=logging`, because
  nothing is sent in that configuration anyway. It starts costing the moment a
  real driver is selected: receipts queue in `receipt_job` and nobody drains them.

**No HTTP endpoints were added for these.** A cron platform calls URLs, so wiring
them would mean new routes, which is a product change (CLAUDE.md: "Do not add
features"). Decide it, then build it.

### Images break; they do not degrade

`IMAGE_DRIVER=disk` writes to a filesystem a serverless function does not have.
The failure is clean and was driven rather than assumed: the upload answers
**`502 image_store_unavailable`**, the underlying `ENOTDIR`/`EROFS` is in the log
as a `cause` chain, and **no `image` row is written** — so there is no record
pointing at bytes that never existed. Reads of images uploaded elsewhere would
404. `images/disk.ts` § "WHY A WRITE REFUSAL AND NOT A BOOT REFUSAL" is the
reasoning; a durable store is a driver nobody has written, and writing one needs
the data-residency decision (CLAUDE.md § Escalate).

### `DB_POOL_MODE`

`default` (the default) is `{ max: 10 }` — unchanged, and what every suite runs.
`serverless` is `{ max: 1, prepare: false }` and is only correct against a
**transaction-mode** pooler. `src/db/poolOptions.ts` carries the argument and
`src/db/poolOptions.test.ts` holds both halves of it.

### Deploying as Vercel functions

`vercel.json`, `api/index.ts` and `scripts/build-function.mjs` are the whole of it.
Set the project's **Root Directory to `api`** — that is what makes Vercel scan
`api/api/` for functions — and leave "include files outside the root directory" ON,
because the install and build commands in `vercel.json` run at the workspace root:
`@avo/types` and `@avo/tokens` are consumed from a `dist/` that is gitignored and
produced by `pnpm build`. Without that build the function dies at import, before
any of the readable boot errors.

`rewrites` sends every path to the single function, so Fastify keeps doing the
routing and no route list is duplicated in configuration. `public/index.html`
exists only because Vercel requires an output directory when a build command is
set; the rewrite means nothing but `/` ever reaches it.

**The function is BUNDLED before Vercel sees it, and it has to be.** Vercel's Node
runtime does not bundle — it transpiles each `.ts` in the entrypoint's import graph
to a sibling `.js` and leaves every specifier exactly as written. `api/src` writes
extensionless relative imports throughout (`./app`, `./db/client`, `./env`), which
`tsx` and `vitest` resolve and real Node ESM does not, so the first deploy of this
function built green and then died on every request with
`ERR_MODULE_NOT_FOUND ... /var/task/api/src/serverless`. That is not one bad
import: all 836 of them would have failed in turn.

So `vercel.json`'s build command runs `pnpm --filter @avo/api run build:function`
after `pnpm build`, and that esbuilds `src/serverless.ts` into
`api/_serverless.js` — one file, every bare specifier still bare, no relative
import left to resolve. `api/index.ts` is a one-line re-export of it and is the
only thing Vercel compiles. The leading underscore keeps Vercel from making the
bundle a second function; `api/_serverless.d.ts` is committed and gives the shim
the real handler's type by re-exporting `src/serverless.ts`, so `pnpm typecheck`
neither needs a build nor trusts one.

`scripts/build-function.mjs`'s header carries the evidence and argues the
alternative — moving `api/src` to explicit `.js` specifiers under NodeNext, which
`packages/types` and `packages/tokens` already do — and why it was not taken. The
bundle step is deliberately NOT the package's turbo `build` task: `build.outputs`
is `dist/**`, and a cache hit would restore nothing and ship a handler-less
function.

**`pnpm --dir api start` and `tsx` are untouched by all of this.** `src/server.ts`
is still the long-running entry, still runs the three background workers, and the
bundle is a build artifact nothing local reads.

Environment, beyond the ordinary set:

| Variable | Value | Why |
|---|---|---|
| `APP_DATABASE_URL` | pooler host, **port 6543** | transaction mode; see below |
| `DB_POOL_MODE` | `serverless` | `{ max: 1, prepare: false }` |
| `TRUST_PROXY` | the platform's proxy | every request arrives through one, and `services/signupLimit.ts` keys on `req.ip` |
| `DATABASE_URL` | owner, **port 5432** | migrations only, and they want session mode |

`NODE_ENV=development` for a demo, for the reason `DEPLOY-DEMO.md` § "The one
blocker" gives — the gateway assertion is an answer, not an obstacle.

One consequence of that setting is now handled rather than latent. `buildApp()`
used to attach a `pino-pretty` transport to every non-`test` environment, and with
`NODE_ENV=development` in Production the function boot-failed on
`unable to determine transport target for "pino-pretty"` — `pino-pretty` is
declared by `packages/mock`, never by `@avo/api`, and pino names a transport by
string, so Vercel's tracer ships nothing for it. It is also the wrong thing to
want in a function, which is frozen between invocations and whose log rows Vercel
parses as JSON. `app.ts` now gates the pretty transport on `process.stdout.isTTY`:
a developer's terminal gets exactly the output it always did, and a function, CI
and any captured pipe get pino's JSON.
