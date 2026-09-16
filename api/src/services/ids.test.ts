/**
 * THE CENSUS THAT WOULD HAVE CAUGHT THE OTHER THREE.
 *
 * Migration 0052 fixed `CMP-` and `SUP-` after a campaign id collided in a full
 * `e2e/` run. It fixed the case that was found, not the defect: `TX-`, `BK-` and
 * `NT-` were still minting `Math.floor(Math.random() * 9_000_000 + 1_000_000)`
 * into a PRIMARY KEY, and `TX-` was doing it from five separate private copies of
 * one identical function. Nothing failed, because nothing was looking.
 *
 * So this spec does the looking. It is a UNIT spec on purpose — it needs no
 * database, so it runs in `pnpm check` on every commit, which is the only place a
 * guard against "somebody adds a sixth copy" is worth anything.
 *
 * IT IGNORES COMMENTS, and that is not a convenience. The first version matched
 * raw lines and went red on `routes/orders.ts`, which now QUOTES the old minter
 * while explaining why its idempotency catch was unsound until 0053. A census that
 * cannot tell code from prose punishes exactly the comments that record the defect,
 * so the honest fix is to skip comment lines rather than to stop writing them.
 *
 * IT READS SOURCE, WHICH IS UNUSUAL HERE AND IS THE POINT. The property is not
 * about what one function returns; it is "no production file does this anywhere",
 * and that is not observable from any module's exports. `e2e/permission-census.ts`
 * makes the same move for permission gates and its header carries the general
 * argument: a defect that is a MISSING call cannot be caught by testing the calls
 * that exist.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = new URL('..', import.meta.url).pathname;

/**
 * The exact shape 0052 and 0053 removed: a numeric id space small enough to
 * collide, drawn with no uniqueness check and no retry.
 *
 * DELIBERATELY NARROWER THAN "no Math.random in a minter". A second family
 * survives in production — `Math.random().toString(36).slice(2, 8)`, six base-36
 * characters, used for `BR-`, `PR-`, `HH-`, `ST-`, `doc-` and `TI-`. That is
 * 36^6 ≈ 2.18e9, where a 50% collision needs ~55,000 rows rather than ~3,531, and
 * every one of those ids is already opaque so none of the readability argument in
 * `ids.ts` applies to them. `TI-` on `topup_intent` is the one worth a decision —
 * the README calls those rows real payment records — and it is REPORTED TO TRUNK
 * rather than swept into this change, because changing an id format on a live
 * payment table is not a thing to do as a side effect of fixing a different bug.
 *
 * If that decision lands, widen this pattern. Until it does, asserting the wider
 * property here would fail on six ids nobody has decided about, and a red suite
 * that everybody knows to ignore is worse than no suite.
 */
const COLLIDING_MINT = /Math\.floor\(Math\.random\(\)/;

/**
 * Comment or code. Line-based and therefore approximate: it reads `/*`, `*` and
 * `//` openers, which is every comment this codebase actually writes, and it would
 * miss a mint sharing a line with a trailing `/* ... *\/`. That miss is one-way —
 * it can only ever produce a FALSE GREEN on a line nobody writes, never a false red
 * — and the alternative is a TypeScript parser in a spec whose whole value is that
 * it is simple enough to trust.
 */
function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*');
}

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, found);
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    /*
     * Fixtures may mint however they like — they are not a primary key in
     * production, and several deliberately randomise to stay idempotent across
     * runs.
     *
     * `services/ids.ts` IS NOT EXCLUDED, and an earlier draft of this spec
     * excluded it because its header quotes the old line. That made the census
     * blind over the one file that now does every mint: putting `Math.random()`
     * back into `nextTransactionId` would have passed. Skipping comment lines
     * removed the reason for the exclusion, so the exclusion goes too — measured,
     * not assumed: with the exclusion in place a reverted `nextTransactionId` was
     * NOT caught, and the red that draft produced came from an unrelated comment.
     */
    if (entry.endsWith('.test.ts')) continue;
    found.push(full);
  }
  return found;
}

describe('no production file mints an id from a small random space', () => {
  it('finds the source tree at all, so a green run cannot mean an empty walk', () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.endsWith(join('services', 'charge.ts')))).toBe(true);
  });

  it('finds no `Math.floor(Math.random()` id mint anywhere under api/src', () => {
    const offenders = sourceFiles(SRC)
      .map((file) => ({ file, lines: readFileSync(file, 'utf8').split('\n') }))
      .flatMap(({ file, lines }) =>
        lines
          .map((text, i) => ({ text, line: i + 1 }))
          .filter(({ text }) => !isComment(text) && COLLIDING_MINT.test(text))
          .map(({ text, line }) => `${file.slice(SRC.length)}:${line} ${text.trim()}`),
      );

    expect(
      offenders,
      'A primary key drawn from a small random space with no uniqueness check and ' +
        'no retry. It is a birthday collision, not a tail — 50% at ~3,531 rows for a ' +
        '9,000,000 space — and on a money path it does not even surface as a 500: ' +
        'routes/orders.ts and friends read every 23505 as an idempotency-key ' +
        'collision and answer "still being processed" for something that never ' +
        'happened. Mint it from a sequence via services/ids.ts instead.',
    ).toEqual([]);
  });
});
