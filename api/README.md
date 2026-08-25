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
