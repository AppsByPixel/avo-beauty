# Where this is, right now

Written as a handoff. If you are a fresh session picking this up, read this first, then
`CLAUDE.md`, then `RUNBOOK.md`. Everything else is detail.

**Day 3 of a 30-day pilot build.** `dev` is the trunk; `main` tracks it when green.

---

## Read these, in this order

| File | What it is |
|---|---|
| `CLAUDE.md` | The 12 non-negotiables and the one-writer-per-lane rule. Loads automatically. |
| `RUNBOOK.md` | How to actually drive four lanes. Start here on day one. |
| `LANES.md` | Each lane's column, brief, and the work order with reasoning. |
| `DECISIONS.md` | Every call made without asking, why, and how to reverse it — plus the questions that are the client's, not ours. |
| `PRIOR-ART.md` | What AvoRewards, AVO's live platform, already learned the hard way. |
| `.claude/skills/` | `money-check`, `perms-check`, `states-check`, `screen-from-design`. |

The git log is part of the record: commit messages carry the reasoning, not just the diff.

---

## What works

Money core proven against real Postgres — charges, top-ups, the signed gateway webhook,
duplicate and out-of-order callbacks, five concurrent charges on one token, voids, deposit
holds and the no-show return job.

Four surfaces: **API** (auth, nine permissions gated both directions, tenancy, booking,
promotions, audit log), **wallet** (home, QR, top-up, Book, Account, full Arabic with RTL),
**scanner** (PIN, scan, charge, void, manual lookup, bookings, schedule), **dashboard**
(sign-in, and all seven sections).

Roughly 400 specs. `pnpm check` runs them; **test caching is off** because turbo was
replaying a green run in 14ms and calling it a pass.

## What does not work yet

- **No real money.** MyFatoorah is the confirmed PSP; the gateway driver is still `sandbox`.
- **Receipts do not send.** The worker, queue, retry and `(transaction_id, channel)` key all
  exist behind a logging driver. Real sending needs WhatsApp template approval and a
  transactional email domain — both the client's.
- **No charge from a real QR on a real phone.** The simulator has no camera; the scanner
  deep-links through the same function `onBarcodeScanned` calls. Ten minutes with a device.
- **Google Calendar** is behind a stub driver. `DECISIONS.md` lists the six things AVO must
  provide, starting with a Google Cloud project AVO owns.
- **31 Arabic strings have no source** in the bundle — `AVO States.dc.html` contains zero
  Arabic. Tracked in `AR_GAPS`; that list is the worksheet for the native-speaker review.
- **Owner console** is deferred; policies are seeded rather than administered.

---

## The three habits that actually caught things

1. **Verify by running it, and paste real output.** Every serious bug this build found came
   from driving the thing, not reading it — a void under-refunding 3.000 of 8.000, a
   dashboard showing one staff member the previous user's figures, a scanner reading another
   salon's customer.
2. **Lanes report, trunk routes.** A lane that finds a bug in another's code says so and
   stops. Every cross-lane fix came through that path.
3. **A single green run is not evidence.** It has been wrong three times — on a stale
   `dist`, on a warm database, and on a turbo cache replay. Run `pnpm check` twice, from the
   recipe in `RUNBOOK.md`.

## The trap that keeps reappearing

**A schema narrower than the wire is not a smaller contract, it is a lossy one.** Zod does
not fail to type an undeclared field — it *strips* it. Five drifts were found this way, each
by a lane hitting it, including one created while fixing another. `e2e/contract.test.ts` is
now the guard: it parses real responses and asserts nothing was dropped and nothing was
wrongly required. **Do not narrow a response to match a schema — widen the schema.**

---

## Open, and waiting on the client

Full list with reasoning in `DECISIONS.md`. The two that gate a launch:

1. **CBK position** — does AVO holding stored value need its own licence? MyFatoorah being
   licensed answers who moves the money, not who may hold it.
2. **Counsel and PSP sign-off on the legal set.** The seven documents are seeded and
   versioned, carrying `reviewNote: "Awaiting counsel + PSP sign-off"`. Seeding the text is
   not approval of it.

And one worth asking early, because it shapes the wallet terms: if MyFatoorah pays the salon
at top-up time, **the salon holds the cash while the customer holds an unspent balance.**
Coherent — it is how gift cards work — but it decides who owes her that money if a salon
leaves the platform.
