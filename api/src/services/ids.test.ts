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
 */
const COLLIDING_MINT = /Math\.floor\(Math\.random\(\)/;

/**
 * The SECOND family: `Math.random().toString(36).slice(2, 8)`, six base-36
 * characters. 36^6 = 2.18e9, so a 50% collision needs ~55,000 rows rather than
 * ~3,531 — 242x the space of the one above, and every id it makes is already
 * opaque, so none of `ids.ts`'s readability argument applies to them.
 *
 * `TI-` LEFT THIS LIST IN 0054 and the other five stay, which is a decision trunk
 * took on 2026-09-17 rather than a line nobody looked at. `TI-` is on
 * `topup_intent`, one row per top-up ATTEMPT, and api/README.md calls those real
 * payment records — a duplicate there is a customer's money, and 55,000 attempts
 * is reachable. The five below name a staff account, a branch, a product, a happy
 * hour and a policy document: none is money, and all are low-volume per salon, so
 * 2.18e9 is not a pressing space for any of them.
 */
const BASE36_MINT = /Math\.random\(\)\.toString\(36\)/;

/**
 * THE PIN, in the shape `e2e/permission-census.test.ts` uses for gates and
 * `e2e/tenancy.test.ts` for salon-scoped routes, and for their reason: an
 * aggregate "how many are left" floor cannot tell a REMOVAL from an ADDITION, and
 * it is the addition that matters. A new base-36 mint on a money path would keep
 * any count-based assertion green.
 *
 * SO AMENDING THIS LIST IS DELIBERATE, BOTH WAYS. Fixing one of these fails this
 * spec until the line is deleted, which is the prompt to decide whether the rest
 * should follow. Adding a sixth fails it until somebody writes down why the new
 * one is allowed to be a dice roll — and if the answer involves money, the answer
 * is a sequence.
 */
const BASE36_PINNED = [
  'routes/platform.ts',          // HH- happy hour
  'routes/policies.ts',          // doc- policy document
  'routes/salons.ts',            // BR- branch, PR- product
  'routes/staff.ts',             // ST- staff account
  'services/salonOnboarding.ts', // ST- the owner's own staff row
] as const;

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

  /**
   * See `BASE36_PINNED`. This is the narrowing written down, so that the five ids
   * still minted from 2.18e9 are a decision with a date on it rather than five
   * lines nobody has looked at since.
   */
  it('pins every file still minting from the 36^6 space, so a sixth is a failing spec', () => {
    const found = [
      ...new Set(
        sourceFiles(SRC)
          .filter((file) =>
            readFileSync(file, 'utf8')
              .split('\n')
              .some((text) => !isComment(text) && BASE36_MINT.test(text)),
          )
          .map((file) => file.slice(SRC.length)),
      ),
    ].sort();

    expect(
      found,
      'The 36^6 minters moved. An ADDITION is the case this exists for: a new id ' +
        'drawn from 2.18e9 with no uniqueness check, which is fine for a happy hour ' +
        'and is a customer\'s money on a payment record — `TI-` was exactly that ' +
        'until migration 0054. A REMOVAL means one was fixed, and the pin should ' +
        'lose the line so the next reader sees what is genuinely left.',
    ).toEqual([...BASE36_PINNED]);
  });
});
