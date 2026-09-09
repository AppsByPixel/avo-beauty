/**
 * MEASURING A RACE, RATHER THAN ASSUMING ONE.
 *
 * `Promise.all([f(), g()])` is how this suite fires concurrent requests, and it is
 * NOT a guarantee that they overlapped. It guarantees only that both promises were
 * created before either was awaited. If anything upstream serialises them — a
 * connection pool with one socket, a helper that awaits inside the "fire" function,
 * an API that happens to answer the first before the second is written — the pair
 * runs SEQUENTIALLY and every assertion below it still passes, because a sequential
 * pair produces exactly the outcome a correctly-guarded concurrent pair produces.
 *
 * That is the failure this file exists to prevent, and it is not hypothetical. A
 * double-submit spec in this repository was measured at **-0.003ms of overlap** —
 * the second request started three microseconds after the first had finished — while
 * claiming in its title to test a double tap. It had never raced anything. It was
 * green for its whole life and would have stayed green against an API with no
 * idempotency guard at all.
 *
 * WHAT IS MEASURED, AND WHY IT IS TWO NUMBERS AND NOT ONE
 * ------------------------------------------------------
 * `overlapMs = min(end) - max(start)`. Positive means every request in the batch was
 * in flight simultaneously at some instant. This is the necessary condition.
 *
 * It is not sufficient on its own, and the reason is worth writing down: the bracket
 * is recorded in the TEST, around the call, so it is WIDER than the request. If a
 * client serialised two requests on one socket, both brackets would still start at
 * roughly the same moment — B's `start` is stamped before it waits for the socket —
 * and the bracket overlap would look large while the wire was strictly sequential.
 * An over-wide bracket makes overlap look BETTER than it is, which is the wrong
 * direction for a guard.
 *
 * So the second number closes it. `parallelMs = sum(durations) - elapsed`. If the
 * batch really ran in parallel, the wall clock is about as long as the SLOWEST
 * request and this is large. If it was serialised, the wall clock is the SUM and
 * this collapses to ~0 — and a serialised batch cannot fake it, because the wall
 * clock is not a bracket the test controls.
 *
 * Both are reported in the failure message, so a spec that stops racing says which
 * way it stopped.
 */

import { psql, psqlDetached, terminateBackend, waitersBlockedBy } from './tenancy-harness.js';

export interface Timed<T> {
  value: T;
  /** `performance.now()` immediately before the call. */
  start: number;
  /** `performance.now()` immediately after it resolved. */
  end: number;
}

/** Fire one request and bracket it. Pass these to `overlapOf` / `assertRaced`. */
export async function timed<T>(fn: () => Promise<T>): Promise<Timed<T>> {
  const start = performance.now();
  const value = await fn();
  return { value, start, end: performance.now() };
}

export interface Overlap {
  /** `min(end) - max(start)`. Positive ⇒ all N were in flight at one instant. */
  overlapMs: number;
  /** `sum(durations) - elapsed`. ~0 ⇒ serialised; large ⇒ genuinely parallel. */
  parallelMs: number;
  /** Wall clock from the first start to the last end. */
  elapsedMs: number;
  durationsMs: number[];
}

export function overlapOf(ts: Array<Timed<unknown>>): Overlap {
  if (ts.length < 2) throw new Error('overlapOf needs at least two timed calls');
  const lastStart = Math.max(...ts.map((t) => t.start));
  const firstEnd = Math.min(...ts.map((t) => t.end));
  const elapsedMs = Math.max(...ts.map((t) => t.end)) - Math.min(...ts.map((t) => t.start));
  const durationsMs = ts.map((t) => t.end - t.start);
  return {
    overlapMs: firstEnd - lastStart,
    parallelMs: durationsMs.reduce((a, b) => a + b, 0) - elapsedMs,
    elapsedMs,
    durationsMs,
  };
}

export function describeOverlap(o: Overlap): string {
  return (
    `overlap ${o.overlapMs.toFixed(3)}ms · parallel saving ${o.parallelMs.toFixed(1)}ms · ` +
    `elapsed ${o.elapsedMs.toFixed(1)}ms · durations [${o.durationsMs
      .map((d) => d.toFixed(1))
      .join(', ')}]ms`
  );
}

/**
 * THE GUARD. Throws a plain `Error` rather than failing an assertion, deliberately.
 *
 * A batch that did not overlap has not tested the thing the spec is named after, and
 * that is a broken EXPERIMENT, not a defect in the API. Reporting it as an assertion
 * failure would put it in the same bucket as "the API double-debited her", and a
 * reader triaging a red suite would look for a lock bug that is not there. Same
 * reasoning as `precondition()` in `support/known-bug.ts`.
 *
 * `minParallelMs` defaults to 1ms: enough to separate "genuinely concurrent" from
 * "serialised" on any request this suite makes (the fastest are ~30ms), and far
 * below the ~30-150ms these batches actually measure, so it is not a flake source.
 */
export function assertRaced(
  ts: Array<Timed<unknown>>,
  what: string,
  minParallelMs = 1,
): Overlap {
  const o = overlapOf(ts);
  if (o.overlapMs <= 0) {
    throw new Error(
      `${what}: the ${ts.length} requests DID NOT OVERLAP — ${describeOverlap(o)}.\n` +
        'They ran one after the other, so this spec measured a sequential pair and proves ' +
        'nothing about the guard in its title. A sequential pair passing a concurrency spec ' +
        'is the exact false green this check exists to catch.',
    );
  }
  if (o.parallelMs < minParallelMs) {
    throw new Error(
      `${what}: the ${ts.length} requests overlapped by the bracket but were SERIALISED on the ` +
        `wire — ${describeOverlap(o)}.\n` +
        'The wall clock is the SUM of the durations rather than the slowest of them, which is ' +
        'what a one-socket client or a serialising helper looks like. The bracket is recorded ' +
        'in the test and is wider than the request, so it cannot see this; the wall clock can.',
    );
  }
  return o;
}

/**
 * `fired.map((t) => t.value)` loses the tuple, so `const [a, b] = ...` becomes
 * `T | undefined` and every assertion after it needs a `!`. This preserves the
 * arity and the element types, so the destructuring at the call sites reads
 * exactly as it did before the timing was added.
 */
export function valuesOf<T extends ReadonlyArray<Timed<unknown>>>(
  ts: T,
): { -readonly [K in keyof T]: T[K] extends Timed<infer U> ? U : never } {
  return ts.map((t) => t.value) as never;
}

// ===========================================================================
// ARRANGING A RACE, RATHER THAN MEASURING ONE
// ===========================================================================

/**
 * `withRowLockHeld` — hold a row's lock so N contenders are GUARANTEED to have
 * passed their unlocked read before any of them can commit.
 *
 * WHY THE REST OF THIS FILE IS NOT ENOUGH. Everything above measures a race
 * after the fact and fails a spec that stopped racing. That is the right guard
 * and it is not a fix: a spec whose race is arranged by `Promise.all` over two
 * cold-start processes still only races SOMETIMES, so the honest measurement
 * just converts an invisible loss of coverage into an intermittently red suite.
 *
 * MEASURED, on `deposit.test.ts`'s two-pass no-show race — the spec this was
 * written for. Each pass is a `tsx` cold start of about 570ms and the two
 * overlapped 100% by wall clock on every run, yet the loser reported
 * `candidates: 0` on one run in a set where the others reported 1. The processes
 * were alive together for their whole lifetimes; their CRITICAL SECTIONS — a
 * scan and a commit a few milliseconds apart inside that half second — were not.
 * The spec's own comment already conceded the gap ("Wall clock can only say the
 * processes overlapped"), and its 12 consecutive green runs were the same kind of
 * evidence as decision 75's three int runs: a lottery this project kept winning.
 *
 * WHAT THIS DOES INSTEAD. A detached session takes the row `FOR UPDATE` and
 * sleeps. The contenders are launched, do their unlocked reads — which a row lock
 * does not block, because Postgres readers do not block on writers — and then all
 * pile up on that same row lock. Once `contenders` backends are observed waiting
 * on a chain that leads back TO THIS HOLDER — `pg_blocking_pids` followed
 * transitively, not a bare count of who happens to be waiting — every one of them
 * has provably finished its unlocked read while the row was still in its original
 * state, because none of them could have committed. The holder is then released
 * immediately and exactly one wins.
 *
 * So the overlap is not hoped for, not measured afterwards, and not a function of
 * scheduling: it is arranged, and the blocked-contender count is the receipt. The
 * assertion a spec makes on the loser becomes deterministic rather than
 * probabilistic.
 *
 * THE ROW TO HOLD IS THE FIRST ONE THE CONTENDERS LOCK, not the row the spec is
 * about. `noShowWorker.ts` locks the MEMBER before the booking (its documented
 * lock order, shared with `performCharge`), so holding the member row stops both
 * passes at the earliest point and neither has touched the booking yet. Holding
 * the second lock in an order would let one contender get past the first, which
 * still works but arranges less.
 */
export interface RowLockTarget {
  /** Table name, interpolated into SQL — a literal from the spec, never input. */
  table: string;
  /** Primary key value. */
  id: string;
}

export interface RowLockRaceOptions {
  /**
   * How long the holder keeps the lock. The contenders cannot finish until it
   * releases, so this is roughly the spec's floor — generous rather than tight,
   * because the failure mode of too-short is the flake this exists to remove.
   */
  holdSeconds?: number;
  /** How long to wait for the holder to acquire, and for the waiters to appear. */
  timeoutMs?: number;
}

const LOCK_HELD_CODES = ['55P03', 'could not obtain lock', 'lock_not_available'];

/**
 * Is that row locked right now?
 *
 * `FOR UPDATE NOWAIT` in a transaction that immediately rolls back: it either
 * takes the lock (so nobody held it) or fails with 55P03 (so somebody does).
 *
 * THE ERROR IS MATCHED, NOT MERELY CAUGHT. A bare `catch { return true }` would
 * read a misspelled table, a dropped column or a stopped container as "locked"
 * and then wait forever for contenders that were never going to arrive — a
 * precondition failing as a timeout, which is the shape this suite keeps
 * complaining about elsewhere.
 */
function rowIsLocked(target: RowLockTarget): boolean {
  try {
    psql(
      `BEGIN; SELECT 1 FROM ${target.table} WHERE id = '${target.id}' FOR UPDATE NOWAIT; ROLLBACK;`,
    );
    return false;
  } catch (err) {
    const message = String((err as Error).message ?? err);
    if (LOCK_HELD_CODES.some((code) => message.includes(code))) return true;
    throw new Error(
      `probing whether ${target.table}/${target.id} is locked failed for a reason that is ` +
        `NOT "somebody holds it". Treating this as locked would hang the spec waiting for ` +
        `contenders.\n${message}`,
    );
  }
}

async function until(
  predicate: () => boolean,
  timeoutMs: number,
  describe: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms: ${describe()}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export async function withRowLockHeld<T>(
  target: RowLockTarget,
  contenders: number,
  body: () => Promise<T>,
  options: RowLockRaceOptions = {},
): Promise<T> {
  const holdSeconds = options.holdSeconds ?? 10;
  const timeoutMs = options.timeoutMs ?? 30_000;

  /**
   * `pg_backend_pid()` FIRST, before the lock and before the sleep — the pid has
   * to reach stdout while the session can still write, so the release below can
   * end it on the receipt instead of waiting out `holdSeconds`.
   *
   * `pg_sleep` remains as the BACKSTOP, not the mechanism. It is what stops a
   * spec that throws between here and the release from leaving a session holding
   * a row lock for the rest of the run — which would strand every later spec that
   * touches that row, in a suite where the next one along is usually about the
   * same member.
   */
  const holder = psqlDetached(
    `SELECT pg_backend_pid();\n` +
      `BEGIN; SELECT 1 FROM ${target.table} WHERE id = '${target.id}' FOR UPDATE; ` +
      `SELECT pg_sleep(${holdSeconds}); COMMIT;`,
  );
  const holderPid = await holder.pid;

  /**
   * Terminating the holder aborts a transaction that only ever took a lock and
   * read one column, so there is nothing to roll back — and psql then exits
   * non-zero, which is expected rather than a failure. `settle` swallows exactly
   * that and nothing else.
   */
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    try {
      terminateBackend(holderPid);
    } catch {
      // The session is going away on its own; the sleep is the backstop.
    }
  };
  const settle = async (): Promise<void> => {
    release();
    await holder.done.catch(() => undefined);
  };

  /**
   * Do not launch the contenders until the lock is actually held. Launching
   * first would reintroduce exactly the race being removed — a contender that
   * got to the row before the holder would sail through and commit.
   */
  try {
    await until(
      () => rowIsLocked(target),
      timeoutMs,
      () =>
        `the holder never acquired ${target.table}/${target.id}. Its session may have failed — ` +
        'the rejection from `holder.done` will say so.',
    );
  } catch (err) {
    /**
     * Settle even here. `pg_sleep` would release it eventually, but leaving a row
     * lock held for the rest of the backstop strands every later spec that
     * touches that row — and in this suite the next one along is usually about
     * the same member.
     */
    await settle();
    throw err;
  }

  const running = body();

  /**
   * THE RECEIPT: `contenders` backends blocked BY THE HOLDER. Each of them is
   * therefore past its unlocked read and none can have committed, which is the
   * guarantee the wall-clock overlap could only approximate.
   *
   * BLOCKED BY THE HOLDER, not merely blocked — and this receipt was wrong TWICE
   * before it was right, both times in a way only measurement found.
   *
   *   v1 counted every backend with `wait_event_type = 'Lock'`, which a
   *      SERIALISED pair satisfies just as well as a raced one: the second
   *      contender waits on the first, so "2 are waiting" is true whether or not
   *      either of them ever reached the holder. It could not distinguish the
   *      arrangement working from the arrangement being irrelevant.
   *
   *   v2 asked `holder = any(pg_blocking_pids(pid))`, which is the precise edge
   *      and is UNSATISFIABLE: Postgres queues only the first waiter against the
   *      holder's transactionid, and later ones against the preceding waiter's
   *      tuple lock. It reported 0 of 2 on the CORRECT target — a receipt that
   *      could never be issued, which reads exactly like a broken arrangement.
   *
   * `waitersBlockedBy` now follows the chain (see its own note), so a contender
   * queued behind a contender queued behind the holder counts, while an
   * arrangement aimed at a row the code under test never touches reports 0 and
   * fails by name. Both directions were measured on `deposit.test.ts`: holding
   * the candidate's own member row passes deterministically, and holding a
   * DIFFERENT member's row fails with `only 0 of 2 contenders`.
   *
   * ONE TRAP WORTH NAMING, because it produced a false negative control on the
   * way here: a row can be contended through a FOREIGN KEY without appearing in
   * the code under test at all. Holding the `salon` row `FOR UPDATE` also
   * arranges this race, because the audit-log insert inside each pass takes a
   * `KEY SHARE` lock on that salon to validate its FK, and `FOR UPDATE`
   * conflicts with it. That is a legitimate arrangement rather than a bug — but
   * a row chosen as "nothing touches this" may be touched by an FK check, so
   * pick a negative control by measurement rather than by reading the handler.
   *
   * `>=` and not `===` so an unrelated neighbour in the same database cannot make
   * this red; the property that matters is that at least N reached the holder.
   */
  let observed = 0;
  try {
    await until(
      () => {
        observed = waitersBlockedBy(holderPid);
        return observed >= contenders;
      },
      Math.min(timeoutMs, holdSeconds * 1000),
      () =>
        `only ${observed} of ${contenders} contenders ever blocked on the lock this holder ` +
        `has on ${target.table}/${target.id}, so they did not all reach it. Either a ` +
        'contender failed before getting there, or it does not lock this row at all — check ' +
        'the lock ORDER of the code under test and hold the row it takes FIRST. (A contender ' +
        'blocked on ANOTHER CONTENDER does not count here, deliberately: that is the ' +
        'condition a serialised pair also satisfies.)',
    );
  } catch (err) {
    // Still drain both, or the holder's session and the contenders outlive the spec.
    await settle();
    await running.catch(() => undefined);
    throw err;
  }

  /**
   * THE RECEIPT IS IN, so the lock has done its whole job: every contender is
   * past its unlocked read and none has committed. Releasing now rather than
   * sleeping is what keeps an arranged race about as fast as the hoped-for one it
   * replaced — the first version held for a flat ten seconds and made every
   * contender take ten seconds with it.
   */
  await settle();

  const value = await running;
  return value;
}
