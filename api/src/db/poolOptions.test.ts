/**
 * The pooling knob, proved without a network.
 *
 * WHAT THIS SPEC IS FOR. `db/client.ts` is the file every row in the ledger
 * travels through, and this change gave it a second shape. The claim that has to
 * hold is symmetric and both halves matter equally:
 *
 *   1. `DB_POOL_MODE=serverless` really does construct the client with `max: 1`
 *      and `prepare: false` — otherwise the port silently keeps `max: 10` per warm
 *      instance and exhausts the database under load, or keeps prepared statements
 *      and fails intermittently against a transaction-mode pooler.
 *   2. THE DEFAULT IS UNTOUCHED. This is the half worth having. Local dev, CI, the
 *      unit suite and the int suite must run on exactly `{ max: 10 }` and
 *      postgres.js's own `prepare`, because several int specs assert behaviour
 *      that a change in pooling would quietly redefine.
 *
 * NO DATABASE IS INVOLVED. postgres.js connects lazily on the first query, so
 * constructing a client against `vitest.config.ts`'s deliberately unreachable URL
 * touches nothing — and `sql.options` is the constructed, normalised option set,
 * which is a stronger assertion than re-reading the function's return value.
 */

import { describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { poolOptionsFor } from './poolOptions';

const UNREACHABLE = 'postgres://avo_app:never@127.0.0.1:1/avo_unit_never';

describe('poolOptionsFor', () => {
  it('default mode is exactly what db/client.ts has always passed', () => {
    expect(poolOptionsFor('default')).toEqual({ max: 10 });
  });

  it('default mode does not pin `prepare` — the library default is part of "unchanged"', () => {
    expect(poolOptionsFor('default')).not.toHaveProperty('prepare');
  });

  it('serverless mode is max 1 and prepared statements off', () => {
    expect(poolOptionsFor('serverless')).toEqual({ max: 1, prepare: false });
  });
});

describe('the options actually reach the constructed client', () => {
  it('serverless: one connection per instance, no prepared statements', () => {
    const sql = postgres(UNREACHABLE, poolOptionsFor('serverless'));
    expect(sql.options.max).toBe(1);
    expect(sql.options.prepare).toBe(false);
  }, 30_000);

  it('default: ten connections, prepared statements on', () => {
    const sql = postgres(UNREACHABLE, poolOptionsFor('default'));
    expect(sql.options.max).toBe(10);
    // postgres.js's own default, restated so a library change is visible here
    // rather than in a money path.
    expect(sql.options.prepare).toBe(true);
  }, 30_000);
});

/**
 * The wiring, not just the values. `db/client.ts` could hold the right function
 * and call it with a constant; this is what says it reads the environment.
 *
 * The module is imported dynamically, after `process.env` is set and with the
 * module registry reset, because both `env.ts` and `db/client.ts` do their work at
 * module load — `env.ts` parses and throws there, which `vitest.config.ts`'s header
 * calls out as a known structural problem.
 */
describe('db/client.ts honours DB_POOL_MODE', () => {
  async function clientUnder(mode: string | undefined) {
    const previous = process.env.DB_POOL_MODE;
    if (mode === undefined) delete process.env.DB_POOL_MODE;
    else process.env.DB_POOL_MODE = mode;
    try {
      vi.resetModules();
      return await import('./client');
    } finally {
      if (previous === undefined) delete process.env.DB_POOL_MODE;
      else process.env.DB_POOL_MODE = previous;
    }
  }

  /**
   * AN EXPLICIT TIMEOUT, BECAUSE THE COST HERE IS NOT THE ASSERTION.
   *
   * Each of these re-imports the whole module graph after `vi.resetModules()` —
   * `env.ts` parses and `db/client.ts` constructs a pool on load, which is the
   * point: the spec asserts what the REAL client is built with, not what a
   * helper returns. Locally that costs ~300ms. On CI it cost 5029ms and failed
   * against vitest's 5s default, on a runner simultaneously running Postgres,
   * the integration suites and every other package through turbo.
   *
   * So the default was a general-purpose budget, not a statement about this
   * test, and it made a green tree red for a reason with nothing to do with
   * pooling. Bounded rather than removed: a genuine hang still fails here, it
   * just is not measured against someone else's parallelism.
   */
  it('unset means default — a deployment gets today behaviour unless it asks otherwise', async () => {
    const { sql } = await clientUnder(undefined);
    expect(sql.options.max).toBe(10);
    expect(sql.options.prepare).toBe(true);
  });

  it('DB_POOL_MODE=serverless reshapes the real client', async () => {
    const { sql } = await clientUnder('serverless');
    expect(sql.options.max).toBe(1);
    expect(sql.options.prepare).toBe(false);
  });
});
