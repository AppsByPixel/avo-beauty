# Four lanes — opening briefs

Four Claude Code sessions run at once, one per worktree. Open a terminal tab in each
directory and start a session there. `CLAUDE.md` loads automatically in all four, so the
12 non-negotiables and the one-writer-per-package rule are in context everywhere.

Start the mock first, from the trunk. All three UI lanes point at it.

```bash
cd ~/dev/avo && pnpm mock        # http://localhost:4000
```

| Lane | Directory | Branch |
|---|---|---|
| A · API | `~/dev/avo-api` | `feat/api` |
| B · Wallet | `~/dev/avo-wallet` | `feat/wallet` |
| C · Web | `~/dev/avo-web` | `feat/web` |
| D · QA | `~/dev/avo-qa` | `feat/qa` |

Merge every lane into `dev` at the end of each day. Four branches diverging for a week is
the failure mode this structure exists to prevent.

---

## Every lane isolates its own resources

Four times now a shared mutable resource has crossed lanes: one Postgres database, one
container, one browser pane, and one `pnpm` invocation that ran another worktree's code.
Each time the lane involved caught and disclosed it. This rule is cheaper than relying on
that.

### Database — one per lane, already created

Trunk has created `avo_lane_a`, `avo_lane_b`, `avo_lane_c`, `avo_lane_d` and `avo_ci`.
**You do not create a database** — not because you cannot, but because trunk owns them.

`CREATE DATABASE` and `DROP DATABASE` are blocked in **some** lanes' sandboxes and not
others: lane C's drop was refused, so it carried on against the shared `avo_ci` and left a
row in it, while lane A's succeeded and it made two scratch databases before this rule
existed. **A blocked isolation step degrades into no isolation, quietly** — which is worse
than failing loudly. But do not read the permission as the rule. "It worked for me" is
exactly the reasoning that produces a database nobody else knows about, and the lane that
can create one is the lane that can leave one behind.

Reset yours instead:

```bash
./scripts/lane-db.sh c        # drops the SCHEMA inside avo_lane_c, migrates, seeds
```

Ordinary DDL inside a database you already own — nothing to block. Export the two URLs it
prints for anything you run against it. **Never set `POSTGRES_DB`**:
`e2e/support/global-setup.ts` skips minting its own per-run database when it sees one, which
puts every concurrent checkout back on shared fixtures.

If your database is missing, ask trunk. Do not work around it.

### Commands — `pnpm --dir`, never `pnpm --filter`

**Never `pnpm --filter` from a lane worktree. It resolves from cwd, so it can run another
worktree's package.** Use `pnpm --dir` with an **absolute** path — not a path relative to
cwd, which has the same failure.

```bash
pnpm --dir /Users/koraspond_developer/dev/avo-a/api run db:migrate    # yes
pnpm --filter @avo/api run db:migrate                                 # no
```

Lane A watched `pnpm --filter @avo/api run start`, run from its own worktree, boot
**`~/dev/avo-wallet/api` against `avo_lane_b`** — another lane's code and another lane's
database. The output looked completely normal and it nearly filed the result as a finding.
The tell was indirect: `pin_attempt` stayed empty in its own database after a login it had
just watched succeed.

Inside `scripts/lane-db.sh` the same call was worse, because the script exports
`DATABASE_URL` before invoking pnpm: **another worktree's migrations and seed applied to
this lane's database** — the exact cross-lane write the script exists to prevent, and it
would have looked like a clean reset.

This rule kept regressing because it lived only in `lane-db.sh`'s comments and in 21 e2e
error strings, so a 22nd place could reintroduce it silently — which is what happened. It is
written here now because this is where the briefs point.

**Assert what you are actually talking to before you trust output.** Lane A's habit, and it
is the only reason this was caught:

```bash
docker exec -i avo-postgres psql -U avo -d postgres \
  -c "SELECT datname, count(*) FROM pg_stat_activity WHERE usename='avo_app' GROUP BY datname;"
```

Anchor load-bearing claims in SQL against your own database rather than in the API's own
reply. A server that answers plausibly is not evidence that it is *your* server.

### Browser — one context per lane

The lanes share one browser pane. Lane B once injected a `fetch` shim into **Lane C's
dashboard tab** and briefly left `window.fetch` undefined there. It caught it and restored
it, then moved to an isolated Chromium — but a page you did not open is another lane's
running app, and `javascript_tool` against it is a write into their process.

- **Open your own tab or your own browser context.** Never evaluate script in a tab you did
  not open.
- **Never stub a global** — `fetch`, `localStorage`, `Date` — on a shared surface. A test
  that needs a stub needs its own context.
- Check `tabs_context` first. If you did not open it, leave it.

### Ports and processes

Pick a port nobody else is using and name it in your report. The API has been on 4000, 4100,
4200, 4400 and 4500 across lanes; Vite on 5173 and 5199; Expo on 8081 and 8090. A leaked API
process — ppid 1, two and a half hours old — was once still polling `receipt_job` against a
database another lane was asserting against.

Kill what you start. A `pnpm check` that hangs on *"something prevents N Vite servers from
exiting"* is a leaked process, not a test failure.

---

## Lane A — API

> Build the API in `api/`. Start with the Postgres schema: salon, branch, member,
> staff_user, transaction, ledger_entry, audit_log, idempotency_key, wallet_token. Money
> columns are `bigint` fils. A negative balance must be impossible **at the database
> level**, not in application code, and `audit_log` must have `UPDATE` and `DELETE` revoked
> at the role level so it is append-only for real.
>
> Then implement, in this order: auth (member phone+password with argon2id, staff PIN
> hashed and scoped to device+salon with lockout, web username+password, refresh with
> revocation), then `POST /topups` + `GET /topups/{id}` behind a gateway adapter with a
> sandbox implementation, then `POST /charges` as ONE transaction per
> `design/api-contract.md` § Charging.
>
> `packages/mock/src/server.ts` is the shape you are implementing — match its responses
> and its error codes, including the 402 carrying the exact shortfall and the 410 on a
> consumed token.
>
> You write only to `api/`.

## Lane B — Wallet

> Build the customer wallet in `apps/wallet/` with Expo, web target on. Point the API
> client at `http://localhost:4000`.
>
> Order: auth + signup consent (store the accepted `policyVersion`), then Home — wallet
> card, balance, the live QR on 45s server rotation with countdown, both loyalty modes,
> activity feed. Then the transaction detail sheet, then Top up with all four outcome
> screens.
>
> Build the states **with** each screen, not after. The mock serves them:
> `x-avo-scenario: loading | empty | error | offline`, and they combine —
> `empty,stamps` is a new member at a stamps salon. Offline keeps the last-known balance
> with a timestamp and **hides the QR**. Never render `0.000` before data arrives.
>
> Read layout, spacing and copy from `design/AVO Wallet Home.dc.html` and the states from
> `design/AVO States.dc.html`. Import every colour from `@avo/tokens` and every money
> helper from `@avo/types`.
>
> You write only to `apps/wallet/` and `apps/scanner/`.

### Lane B also owns the scanner

`design/ADR-0001-stack.md` puts the wallet and the scanner in **one Expo codebase**, so they
share a lane rather than competing for one. Lane B's column is `apps/wallet/` **and**
`apps/scanner/`.

If a component genuinely belongs to both — a money display, a sheet, a button — it moves to
a shared package, and that is a trunk conversation, not something either app does quietly.

## Lane C — Web

> Build the merchant dashboard in `apps/dashboard/` with React + Vite, and the shared
> component library in `packages/ui/`. Point the API client at `http://localhost:4000`.
>
> Order: sign-in per `design/AVO Login.dc.html`, then Overview, then Settings, then the
> Loyalty editor (threshold validation and an **atomic** publish — a half-published tier
> ladder is a money bug), then Accounts → Team authority with the nine permission chips,
> then the Audit log with its four filters.
>
> Structure routing and permissions so the owner console can be added later as a second
> auth scope in the same app, not a second codebase.
>
> The four breakpoints, the focus ring and the keyboard map are in
> `design/interaction-spec.md` §1–2. Below 768px shows the "open on a larger screen"
> notice — that is the design, not a gap.
>
> You write only to `apps/dashboard/` and `packages/ui/`.

## Lane D — QA

> Own the test suites. Start with the concurrency cases against lane A's API as it lands:
> double scan of one token, double submit of one charge, duplicate gateway callback,
> callback arriving before the client returns, and a charge crossing a happy-hour
> boundary.
>
> Then the permission suite: for every gated endpoint, a test that calls it **directly**
> with the permission off and asserts a 403. `GET /charges` and `POST /voids` first.
>
> Then an audit-row test — every mutating handler writes one, and the row cannot be
> updated or deleted.
>
> Review the other lanes' diffs adversarially. You did not write the code and should not
> assume the reasoning behind it.
>
> You write only to `**/*.test.ts` and `e2e/`.


---

## Order of work, and why

Not a preference — dependency, checked against what the API actually serves.

**1 · Scanner (lane B).** Fully unblocked: `POST /staff/session`, `GET /staff/me`,
`POST /scans`, `POST /charges`, `POST /voids` all exist and are tested under concurrency.
It is also the highest-value gap — without it there is no way to demonstrate a salon taking
a payment, which is the whole pilot. Build it first, and watch it, because it is a new
surface with a real camera on a real device.

**2 · API (lane A).** The dashboard needs four endpoints that do not exist:
`PUT /artists/{id}/availability`, the audit log, loyalty publish, and the artists list.
Until those land, lane C can only build against a mock and re-do the wiring later.

**3 · Dashboard (lane C).** Consumes what lane A just built. Running it *ahead* of the API
is what produced the throwaway sign-in stand-in that had to be rewritten.

**4 · QA (lane D) — always last, and always against integrated code.** Its best runs came
from testing what had already merged; its worst came from testing one lane's branch in
isolation, where a half-landed migration made a schema-pinned spec flap. Merge first, then
sweep.
