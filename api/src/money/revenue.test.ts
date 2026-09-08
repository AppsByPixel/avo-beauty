/**
 * `money/revenue.ts` — the one definition of what a visit was worth, and the
 * guard that keeps it one.  (DECISIONS.md #81)
 *
 * =========================================================================
 * WHAT A UNIT SPEC CAN AND CANNOT PROVE HERE
 * =========================================================================
 * The arithmetic lives in a VIEW, so the numbers are only assertable against a
 * database — `services/reportsReconciliation.int.test.ts` does that, and it is
 * the spec that matters for correctness. This file exists for the half of the
 * problem that has nothing to do with numbers and everything to do with how the
 * defect happened.
 *
 * IT DID NOT HAPPEN BECAUSE SOMEBODY GOT THE SUM WRONG. `routes/charges.ts` had
 * it right from the day deposits landed. It happened because two report
 * aggregates wrote their OWN version of the expression — `sum(-amount_fils)` —
 * and there was nothing in the build that could notice a third and fourth
 * opinion about one quantity. `money/ledger.test.ts` had already solved exactly
 * this shape for ledger ACCOUNTS: it greps the source and fails if any file but
 * the posting builders names a `ledger_account` value, so a re-inlined literal
 * is a red test rather than an archaeology exercise. This is the same technique
 * applied to the same class of defect one column over, and it runs in
 * `pnpm check` where the int suite does not (see `vitest.int.config.ts`).
 *
 * COMMENTS ARE STRIPPED BEFORE EVERY GREP. This file's whole subject is a
 * defect worth writing about at length, and the files that write about it name
 * the old wrong expression in prose repeatedly — including this sentence. A
 * guard that could be broken by explaining the bug it guards against would be
 * turned off within a week.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { revenueJoin, revenueLeftJoin, TRANSACTION_REVENUE } from './revenue';

// ------------------------------------------------------------ the source ----

const SRC = new URL('..', import.meta.url).pathname;

function sources(dir = SRC, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

/**
 * Block and line comments removed, string literals left alone. Deliberately a
 * small state machine rather than a regex: `/*` inside a template literal is
 * rare here and a regex that got it wrong would fail in the direction of hiding
 * a real occurrence, which is the one direction this file must not fail in.
 */
function code(file: string): string {
  const src = readFileSync(file, 'utf8');
  let out = '';
  let mode: 'code' | 'block' | 'line' = 'code';
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    const d = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && d === '*') { mode = 'block'; i += 2; continue; }
      if (c === '/' && d === '/') { mode = 'line'; i += 2; continue; }
      out += c;
      i += 1;
      continue;
    }
    if (mode === 'block') {
      if (c === '*' && d === '/') { mode = 'code'; i += 2; } else i += 1;
      continue;
    }
    if (c === '\n') { mode = 'code'; out += '\n'; }
    i += 1;
  }
  return out;
}

const rel = (f: string) => f.slice(SRC.length);
const FILES = sources();

/** The stripper has to actually strip, or every guard below passes vacuously. */
describe('the comment stripper the guards rest on', () => {
  it('removes a block comment and keeps the code after it', () => {
    expect(FILES.length).toBeGreaterThan(50);
    const revenue = FILES.find((f) => rel(f) === 'money/revenue.ts') as string;
    expect(readFileSync(revenue, 'utf8')).toContain('sum(-amount_fils)');
    expect(code(revenue)).not.toContain('sum(-amount_fils)');
    // …and it did not strip the file to nothing on the way.
    expect(code(revenue)).toContain('readTransactionRevenue');
  });
});

// ------------------------------------------------------- the three guards ----

describe('there is ONE definition of what a visit was worth', () => {
  /**
   * The shape of the defect itself. `sum(-amount_fils)` under a column labelled
   * `gross` is what understated every booked appointment by its deposit for the
   * life of two reports; nothing in `api/src` may write it again.
   *
   * `platformMetrics.ts` and `metrics.ts` both sum `amount_fils` and are NOT in
   * breach: their money tiles are TOP-UPS, where `amount_fils` is the credit
   * that landed and there is no deposit half to lose, and their `kind='charge'`
   * query counts VISITS rather than money. Checked when this guard was written,
   * and the reason it greps for the negation rather than for the column.
   */
  it('no revenue sum is written by hand anywhere under api/src', () => {
    const offenders = FILES.filter((f) => code(f).includes('sum(-'));
    expect(offenders.map(rel)).toEqual([]);
  });

  /**
   * Callers reach the view through this module, not by typing its name. A
   * hand-written `JOIN transaction_revenue` would work, and would be the first
   * step back to four copies of the join condition — `reports.ts` and
   * `charges.ts` both mention the relation in prose and neither names it in code.
   */
  it('only money/revenue.ts names the relation in code', () => {
    const namers = FILES.filter((f) => code(f).includes('transaction_revenue'));
    expect(namers.map(rel)).toEqual(['money/revenue.ts']);
  });

  /**
   * And nobody reads the applied deposit out of the ledger themselves any more.
   * `routes/charges.ts` used to, with the three predicates inline, and being the
   * only correct copy is what let the two wrong ones survive.
   *
   * `money/ledger.ts` WRITES the leg and `db/schema/ledger.ts` declares the
   * enum, so both legitimately name the account; every other file that mentions
   * `deposit_held` means the BOOKING STATUS, which is a different fact with the
   * same spelling — hence the `direction`/`.account` conjunction rather than a
   * bare grep.
   */
  it('only the posting builders and the schema name the deposit_held ACCOUNT', () => {
    const readers = FILES.filter((f) => {
      const c = code(f);
      return c.includes("'deposit_held'") && (c.includes('direction') || c.includes('.account'));
    });
    expect(readers.map(rel).sort()).toEqual(['db/schema/ledger.ts', 'money/ledger.ts']);
  });
});

// ----------------------------------------------------------- the fragments ----

/**
 * Rendered through the REAL dialect rather than by reading `queryChunks`, so
 * what these assertions see is the SQL Postgres would see — identifiers quoted,
 * parameters placed. A hand-rolled reader of the chunk list passed while the
 * alias was interpolated unquoted, which is exactly the difference that matters.
 */
const render = (fragment: SQL) => new PgDialect().sqlToQuery(fragment).sql;

describe('the join fragments', () => {
  it('the inner join names the view and matches on transaction_id', () => {
    const t = render(revenueJoin('t'));
    expect(t).toBe('JOIN "transaction_revenue" "rev" ON "rev".transaction_id = "t".id');
  });

  it('the left join takes an arbitrary id expression, for a caller of bookings', () => {
    const t = render(revenueLeftJoin(sql`bk.settled_transaction_id`));
    expect(t).toBe(
      'LEFT JOIN "transaction_revenue" "rev" ON "rev".transaction_id = bk.settled_transaction_id',
    );
  });

  it('the alias is overridable, so a query may join the view twice', () => {
    expect(render(revenueJoin('t', 'r2'))).toContain('"r2".transaction_id = "t".id');
  });

  it('the relation is one quoted identifier, not an interpolated string', () => {
    expect(render(sql`${TRANSACTION_REVENUE}`)).toBe('"transaction_revenue"');
  });
});
