/**
 * `knownBug()` — an executable defect report.
 *
 * Lane D reports bugs in other lanes' code, it does not fix them. But a bug
 * written down in prose rots, and a spec that asserts the broken behaviour
 * (`expect(status).toBe(200) // wrong, but that's what it does`) cements it.
 *
 * So: write the assertion the way the contract says it should be. `knownBug()`
 * expects that assertion to fail today and reports the spec as passing. The
 * moment the owning lane fixes it, the assertion succeeds and this spec FAILS,
 * with a message telling you to promote it to a plain `it()`.
 *
 * The distinction from vitest's `test.fails` matters: `test.fails` passes when
 * the body throws for ANY reason, so a typo, a parse error or a dead server all
 * read as green. This helper only accepts an *assertion* failure. Anything else
 * is re-thrown and fails the spec.
 */

import { it } from 'vitest';

function isAssertionFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'AssertionError' || err.constructor.name === 'AssertionError';
}

/**
 * Assert a precondition inside a `knownBug()` body. Throws a plain Error, which
 * is re-thrown rather than swallowed — so "the server was down" can never be
 * mistaken for "the bug is still there".
 */
export function precondition(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(`precondition failed: ${message}`);
}

/**
 * `timeoutMs` mirrors vitest's own third argument to `it`.
 *
 * Without it a knownBug could not be written for anything slow — `seed.test.ts`
 * runs a whole migration chain and a whole seed inside one — and the workaround
 * would be to abandon the helper and hand-roll the try/catch, which is the exact
 * pattern this file exists to stop people writing.
 */
export function knownBug(
  title: string,
  fn: () => Promise<void> | void,
  timeoutMs?: number,
): void {
  it(
    `KNOWN BUG — ${title}`,
    async () => {
      let thrown: unknown;
      try {
        await fn();
      } catch (err) {
        thrown = err;
      }

      if (thrown === undefined) {
        throw new Error(
          `This bug appears to be FIXED: "${title}".\n` +
            'The contract-correct assertion now passes. Promote this knownBug() to a plain it() ' +
            'so the behaviour stays locked in.',
        );
      }
      if (!isAssertionFailure(thrown)) throw thrown;
    },
    timeoutMs,
  );
}
