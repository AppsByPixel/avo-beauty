# Operating AVO in production

**This file is not `RUNBOOK.md`.** That one is the *lane* manual — how four build
sessions share a machine without destroying each other's databases. This one is for
running the deployed product: what to watch, what a number means when it moves, and
which knob answers it.

It starts with one entry because one entry is what has been earned. Add beside it
rather than inventing a new place; the reason `RUNBOOK.md` had no home for this is
that nobody had needed one yet.

---

## Receipt worker

### `lost` is the number to watch

`TickResult.lost` counts receipt jobs whose write was **refused** because the row
moved on between the claim and the write. It is not an error and not a send —
another worker owns that outcome. Logged on every tick that claimed anything, as
`event: 'receipt.tick'`.

**Zero, or occasional single digits, is normal.** `RECEIPT_WORKER_ENABLED` defaults
to `'1'`, so every API process drains the outbox, and `available_at` is a *lease* —
it exists precisely so a second process can take over a row the first is still
sending. Two writers reaching for one job is the design, not a fault.

**Persistently non-zero means leases are expiring while sends are still in flight**
— two workers contending faster than the lease intends. The knob is
`RECEIPT_LEASE_MS` (default `120000`); raise it toward the provider's worst observed
latency.

**Do not respond by cutting API processes.** The contention is intended and the
guard handles it correctly: every post-claim write carries `stillOurs` —
`id AND status = 'sending' AND attempts = <the claim's>` — so a refused write loses
nothing, it just declines to overwrite a row somebody else now owns.

**If `lost` is high *and* `sent` is near zero, stop looking at the lease.** That
shape means a writer that is not a worker at all: a QA helper parking the outbox, or
an operator running an UPDATE by hand.

> Background: decisions 72, 73 and 75 in `DECISIONS.md`. The guard landed in
> `da442bc` after the unguarded version was found to lose a send silently — and to
> *raise* on two of its three writes, out of a function documented as never
> throwing.
