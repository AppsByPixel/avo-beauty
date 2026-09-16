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

### ⚠ `db:verify` and `test:int` need SEPARATE databases

Run both against one database, in the order a person naturally runs them, and
`db:verify` reports a **false red on invariant 5** — `member.balance_fils =
sum(member_wallet entries)`, naming `AP-M-…` members "off by 59000 fils". Those
are the integration suite's own fixtures: they mint a member with a balance
directly rather than through a top-up, so nothing in `member_wallet` backs it.
The invariant is correct and the product is fine; the database has test data in
it that no product code path can produce.

Reset and run `db:verify` alone and it is **103 / 103**.

CI never meets this because it already separates them — `db:verify` gets
`avo_migrate_check` and the integration suite gets `avo_int_check`
(`.github/workflows/ci.yml`). That separation is the correct design and it was
written only into the workflow, which is not where somebody running the gates by
hand looks. It is here now. **DECISIONS.md 108** carries what it cost: a FAIL on
the one assertion that stands between this product and a ledger that disagrees
with itself, arriving minutes after a money-moving merge.

The suite **was** idempotent and **is not any more**: it is green exactly once per
database reset. Counts are still asserted as **deltas** against what each run
finds, because `topup_intent` rows are real payment records and a suite that
truncates them to stay green is a suite that can hide a real charge — and that
design is not what broke.

Measured 2026-08-25 — fresh database `26 passed (26)`, immediate re-run on the
same database `26 passed (26)`. **Re-measured 2026-09-16 on 30 files: fresh
`482 passed (482)`, immediate re-run on the same database `2 failed | 480
passed`.** Both failures are the same sentence — *"a walk-in is |amount_fils| and
carries no deposit"*, `expected 10000 to be +0` — in
`reportsArtist.int.test.ts` and `reportsReconciliation.int.test.ts`.

**The cause is a cleanup that deletes half a fixture.**
`routes/artistDayVoid.int.test.ts`'s `afterAll` runs
`DELETE FROM booking WHERE id LIKE 'AV-BK-%'` — because
`booking_artist_slot_no_overlap` would otherwise collide on the next run. The
charges those bookings settled are **not** deleted, and they consumed real
deposits. So a second run finds charges carrying a `deposit_held` leg with no
booking pointing at them, which is precisely `services/reports.ts`'s definition
of a **walk-in** — and a walk-in that carries a deposit is the one thing those
two specs exist to refuse.

Nothing here is wrong about the product: both reports are correct about the rows
they were given. The fixture manufactured a state the product cannot reach.

**CI does not meet it** — `ci.yml` mints `avo_int_check` fresh on every run — so
this is a trap for a person running the suite twice by hand, which is exactly
what this section tells you to do. Reported by the lane that proved it was not
its own red, with a control run in which its own file was never loaded.

The durable fix is a per-run slot rather than a delete, so nothing needs
cleaning up: the same move `e2e/support/global-setup.ts` makes with its
per-run database. Not taken yet.

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
  nothing is sent in that configuration anyway. **That moment has arrived:
  `RECEIPT_DRIVER=email` exists** (below), and selecting it on a serverless
  deployment is now the most expensive absence on this list. It has its own
  one-shot: `pnpm run job:receipt-drain`.

**No HTTP endpoints were added for these.** A cron platform calls URLs, so wiring
them would mean new routes, which is a product change (CLAUDE.md: "Do not add
features"). Decide it, then build it.

### An email receipt driver exists now: `RECEIPT_DRIVER=email`

`src/receipts/email/` is an email sender behind the same seam — a directory of
new files, one case in `receipts/index.ts`, four variables in `env.ts`. **No
SDK**: `resend` on npm would mean a new entry in the workspace-root
`pnpm-lock.yaml`, outside `api/`, and the API is one POST reached with the
runtime's own `fetch`. `logging` remains the default and is not deprecated by it.

**It handles the email channel only**, which makes `processJob`'s give-back
branch execute in production for the first time: under this driver every
`whatsapp` row is claimed, handed back to `queued` with its attempt returned, and
never sent. That is correct — it is waiting for a driver that can — and it is
**silent**, because a re-queued row is not a failed one and writes no audit.

**It settles nothing about the sending domain.** CLAUDE.md § Escalate still owns
"whether receipts send from AVO's domain or per-salon subdomains", which is what
decides where SPF and DKIM records go. `RECEIPT_EMAIL_FROM_ADDRESS` has no
default and expresses both answers — written plainly it is one domain, written
with `{salon}` it is per-salon subdomains. The display name is always the salon's
(`whatsapp-templates.md`). The API refuses to boot with `RECEIPT_DRIVER=email` and
either that or `RECEIPT_EMAIL_API_KEY` unset, naming whichever is missing.

**What it sends is plain text, and that is a reported gap rather than a
preference.** `design/AVO Receipt Email.html` is a finished template, and
`receipt_job.payload` cannot fill it: the salon's address, phone and brand hex,
the human receipt reference, the settled timestamp, the staff member and device,
the per-line artist and duration, the deposit applied, the balance *before*, the
loyalty counter and the happy-hour note are none of them frozen at charge time.
Rendering that markup with two thirds of its rows deleted would be a redesign of a
settled design wearing the design's own styling. Widening `ReceiptPayload` across
the five callers of `queueReceipts` is the slice that closes it. There is also **no
Arabic receipt email in the bundle and no locale column on `member`**, so the
composer is English-only; non-negotiable #12 makes that a gap worth naming.

### Serverless + `RECEIPT_DRIVER=email` is a defect, not a limitation

`src/serverless.ts` starts no loops. An undrained receipt is **not** a failed
send: it stays `queued` with no attempt, no `last_error` and no `risk` audit row,
because `markFailed` is the only thing that writes one and it is only reached by a
job somebody claimed. So that configuration promises every customer a receipt and
breaks the promise invisibly, with a merchant who now believes receipts send.
Measured on a lane database, a `receipt_job` row costs ~3.4 kB with its two
indexes (240-byte average payload), one or two rows per settled payment — so the
table is the small half of the cost.

Two configurations are safe:

- **a process deployment.** `render.yaml` runs `server.ts`, `RECEIPT_WORKER_ENABLED`
  defaults to `1`, and the outbox drains itself. `job:receipt-drain` is then only a
  manual catch-up.
- **serverless plus a scheduled `job:receipt-drain`** run from something that can
  execute the repository against the database. Nothing here sets that up, and a
  cron platform calls URLs rather than scripts — so this needs an external runner,
  or the HTTP endpoint that was deliberately not added.

`job:receipt-drain` repeats `runOnce` until a pass claims nothing or a 50-pass
ceiling (1000 receipts at the default batch size), and says which. `gaveUp` is
printed to stderr with the query that lists the rows, because each one is a
customer who paid and was not told.

### Images break; they do not degrade

`IMAGE_DRIVER=disk` writes to a filesystem a serverless function does not have.
The failure is clean and was driven rather than assumed: the upload answers
**`502 image_store_unavailable`**, the underlying `ENOTDIR`/`EROFS` is in the log
as a `cause` chain, and **no `image` row is written** — so there is no record
pointing at bytes that never existed. Reads of images uploaded elsewhere would
404. `images/disk.ts` § "WHY A WRITE REFUSAL AND NOT A BOOT REFUSAL" is the
reasoning. **That refusal is unchanged**, and `disk` is still the default.

### A durable store exists now: `IMAGE_DRIVER=supabase`

`src/images/supabase.ts` is a Supabase Storage driver behind the same seam — one
file next to `disk.ts`, one case in `images/index.ts`, three variables in
`env.ts`. **No SDK**: `@supabase/supabase-js` would mean a new entry in the
workspace-root `pnpm-lock.yaml`, outside `api/`, and Storage's REST surface is
three verbs on one URL grammar reached with the runtime's own `fetch`.

**It settles nothing about data residency, and must not be read as though it
does.** It is selected by an environment variable, in one environment: the demo.
The `avo-demo` project is in **eu-central-1** — which is exactly the fact that
makes it a demo-only configuration, not a proposal for where a Kuwaiti salon's
customer photographs should live. CLAUDE.md § Escalate still owns that question,
and pointing this driver at a production bucket needs the answer first.

**The failure contract is the same and was proved, not assumed.** A refused
upload leaves **no `image` row** — `src/images/supabaseAttach.int.test.ts` drives
a 403 through the real `attachImage` against a real database and counts the rows.
The assertion was anchored by deliberately inverting the write order and watching
it go red; the comment in that file records which inversion does it and which one
does not.

**Reads of an image uploaded under the OTHER driver 404**, exactly as `disk` does
for one uploaded elsewhere. The `image` row carries a `driver` column and the
`storage_key` is driver-independent, but the bytes only exist in the store that
was configured when they were written, so switching `IMAGE_DRIVER` in either
direction strands whatever the previous store held. Nothing migrates them, and no
job exists that would. **There is no error for this**: `GET /v1/images/{id}` finds
the row, the store answers "absent", and the route turns that into its documented
uniform 404 plus an error-level log line naming the image id, the storage key and
the driver — which is the one place an operator can see it happening.

**Not implemented: `presignedUrl`.** Supabase has the call, and the seam has the
plug, but a `302` to storage drops every response header `routes/images.ts`
documents as load-bearing — `nosniff`, the `default-src 'none'; sandbox` CSP,
`cache-control: private`, and the stored `content-type` from the row. The seam can
express "redirect there"; it cannot express "redirect there and keep these". So
reads still stream through the function, at up to `IMAGE_MAX_BYTES` (2 MiB) per
image per request with no CDN in front. Reported as a decision with a named cost,
not taken silently.

**The reaper needs no change.** `services/imageReaper.ts` and
`pnpm run job:image-reap` only ever call `imageStore.remove`, and assume nothing
about a filesystem; the int spec above runs a real reap pass against the Supabase
driver and asserts the `DELETE` reached the store.

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
