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
