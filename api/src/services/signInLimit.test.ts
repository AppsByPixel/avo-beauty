/**
 * The password sign-in budget — the half of it that needs no database.
 *
 * WHY THERE ARE TWO SPECS. `signInLimit.int.test.ts` proves the behaviour through
 * the three real handlers against real rows, and it is the more valuable of the
 * two — but `vitest.int.config.ts` explains why that suite is NOT in `pnpm check`:
 * it needs a live Postgres with this lane's schema, and the workspace package that
 * owns that problem is `e2e/`, which is Lane D's column. So the properties that
 * can be pinned without a connection are pinned here, where the gate runs them on
 * every commit.
 *
 * Three of them, and each one is a specific defect this file exists to catch:
 *
 *   THE COUNTER KEY IS NOT THE IDENTITY. Migration 0026 refused to store the phone
 *   number in `signup_attempt` — "a list of people who do not have accounts here"
 *   — and this table has the same problem, plus a worse one: a Kuwaiti mobile is
 *   eight digits behind a fixed prefix, so an UNKEYED digest of one is a
 *   laptop-minute from the number. A future "simplify this to a sha256" fails here.
 *
 *   THE CEILING IS REPORTED BEFORE THE BURST TIER. `memberSearch.ts`'s rule:
 *   telling somebody to "wait a moment" when they have an hour to wait sends them
 *   back every minute.
 *
 *   THE CHECK RUNS BEFORE THE RECORD. Reversing them would let an attacker in a
 *   loop push the window forward with every refused request, so the customer never
 *   gets back in — see § THE SECOND TRAP. This is the one property of the pair
 *   that is invisible from the outside, because both orderings return 429.
 */

import { describe, expect, it } from 'vitest';
import type { Db } from '../db/client';
import {
  SIGN_IN_HOURLY_LIMIT,
  SIGN_IN_HOUR_WINDOW_MINUTES,
  SIGN_IN_MAX_PER_HOUR,
  SIGN_IN_MAX_PER_WINDOW,
  SIGN_IN_RATE_LIMITED,
  SIGN_IN_WINDOW_MINUTES,
  chargeSignInBudget,
  enforceSignInLimits,
  signInIdentityKey,
} from './signInLimit';
import { ApiError } from '../http/errors';

/**
 * A `Db` that answers the limiter's one query with fixed counts and records
 * whether an insert was attempted. The limiter runs exactly one SELECT and at most
 * one INSERT, both spelled out in this file, so a stub is honest here in a way it
 * would not be for anything that reasons about rows — that is the int suite's job.
 */
function stubDb(counts: { burst: number; hour: number }) {
  const inserted: unknown[] = [];
  const db = {
    select: () => ({ from: () => ({ where: async () => [counts] }) }),
    insert: () => ({
      values: async (v: unknown) => {
        inserted.push(v);
      },
    }),
  } as unknown as Db;
  return { db, inserted };
}

/** What `ApiError` a call threw, or null if it did not throw. */
async function refusal(fn: () => Promise<unknown>): Promise<ApiError | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
}

describe('signInIdentityKey', () => {
  const PHONE = '+96599124408';

  it('never contains the identifier it is derived from', () => {
    const key = signInIdentityKey('member', 'SAL-AMARA', PHONE);
    expect(key).not.toContain(PHONE);
    // Nor the digits without the '+', which is the form a `like` would match.
    expect(key).not.toContain(PHONE.slice(1));
  });

  it('is a 64-character hex digest', () => {
    expect(signInIdentityKey('member', 'SAL-AMARA', PHONE)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable for the same claimed identity', () => {
    expect(signInIdentityKey('member', 'SAL-AMARA', PHONE)).toBe(
      signInIdentityKey('member', 'SAL-AMARA', PHONE),
    );
  });

  it('separates the three surfaces, so one door cannot spend another door’s budget', () => {
    const a = signInIdentityKey('member', 'SAL-AMARA', 'noura');
    const b = signInIdentityKey('web', 'SAL-AMARA', 'noura');
    const c = signInIdentityKey('platform', 'SAL-AMARA', 'noura');
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('separates salons, because the same phone is two different wallets', () => {
    /**
     * `member_salon_phone_uq` is on (salon_id, phone) and the schema comment says
     * why: "the same person can hold a wallet at two salons". Sharing one bucket
     * would let a failed sign-in at one salon lock her out at the other.
     */
    expect(signInIdentityKey('member', 'SAL-AMARA', PHONE)).not.toBe(
      signInIdentityKey('member', 'SAL-OTHER', PHONE),
    );
  });

  it('separates a null salon from an empty one', () => {
    // The console passes null. A salon whose id is the empty string is not a real
    // case, but a delimiter that let the two collide would be the kind of bug that
    // only shows up as a shared bucket.
    expect(signInIdentityKey('platform', null, 'yousef')).toBe(
      signInIdentityKey('platform', null, 'yousef'),
    );
    expect(signInIdentityKey('platform', null, 'yousef')).not.toBe(
      signInIdentityKey('platform', null, 'yousef|extra'),
    );
  });
});

describe('the thresholds', () => {
  it('put the burst window inside the hour, which is what lets one query answer both', () => {
    expect(SIGN_IN_WINDOW_MINUTES).toBeLessThan(SIGN_IN_HOUR_WINDOW_MINUTES);
    expect(SIGN_IN_MAX_PER_WINDOW).toBeLessThan(SIGN_IN_MAX_PER_HOUR);
  });
});

describe('enforceSignInLimits', () => {
  const KEY = signInIdentityKey('member', 'SAL-AMARA', '+96599124408');

  it('allows the last attempt below the burst threshold', async () => {
    const { db } = stubDb({ burst: SIGN_IN_MAX_PER_WINDOW - 1, hour: SIGN_IN_MAX_PER_WINDOW - 1 });
    expect(await refusal(() => enforceSignInLimits(db, KEY))).toBeNull();
  });

  it('refuses at the burst threshold with 429 and the burst code', async () => {
    const { db } = stubDb({ burst: SIGN_IN_MAX_PER_WINDOW, hour: SIGN_IN_MAX_PER_WINDOW });
    const err = await refusal(() => enforceSignInLimits(db, KEY));
    expect(err?.statusCode).toBe(429);
    // THE CODE, not the status. `http/errors.ts`: the `error` string is the
    // contract and the clients switch on it.
    expect(err?.code).toBe(SIGN_IN_RATE_LIMITED);
  });

  it('reports the hourly ceiling ahead of the burst tier when both are spent', async () => {
    const { db } = stubDb({ burst: SIGN_IN_MAX_PER_HOUR, hour: SIGN_IN_MAX_PER_HOUR });
    const err = await refusal(() => enforceSignInLimits(db, KEY));
    expect(err?.code).toBe(SIGN_IN_HOURLY_LIMIT);
  });

  it('never names the identity or the account in what it tells the caller', async () => {
    /**
     * The refusal is the one message a caller can provoke on demand for any
     * identity it likes, so it is the one that must say nothing. Anything derived
     * from the request or from a row here would be the enumeration oracle the
     * whole design avoids — and `details` is where that would arrive, because
     * `ApiError` serialises it into the body.
     */
    const { db } = stubDb({ burst: SIGN_IN_MAX_PER_WINDOW, hour: SIGN_IN_MAX_PER_WINDOW });
    const err = await refusal(() => enforceSignInLimits(db, KEY));
    expect(err?.message).not.toContain('9912');
    expect(err?.message).not.toContain(KEY);
    expect(err?.details).toEqual({});
  });
});

describe('chargeSignInBudget', () => {
  it('records the attempt when the caller is inside its budget', async () => {
    const { db, inserted } = stubDb({ burst: 0, hour: 0 });
    await chargeSignInBudget(db, 'member', 'SAL-AMARA', '+96599124408');
    expect(inserted).toHaveLength(1);
  });

  it('does NOT record an attempt it has already refused', async () => {
    /**
     * The ordering property, and the one nothing outside this module can see:
     * both orderings answer 429. Record-then-check would let an attacker in a loop
     * push the rolling window forward with every refused request, so the window
     * never drains and the customer is locked out for as long as the attack runs —
     * turning a decaying budget back into the latch it was designed not to be.
     */
    const { db, inserted } = stubDb({
      burst: SIGN_IN_MAX_PER_WINDOW,
      hour: SIGN_IN_MAX_PER_WINDOW,
    });
    const err = await refusal(() => chargeSignInBudget(db, 'member', 'SAL-AMARA', '+96599124408'));
    expect(err?.code).toBe(SIGN_IN_RATE_LIMITED);
    expect(inserted).toHaveLength(0);
  });

  it('stores the surface and the salon beside the key, and never the identifier', async () => {
    const { db, inserted } = stubDb({ burst: 0, hour: 0 });
    await chargeSignInBudget(db, 'web', 'SAL-AMARA', 'noura');

    const row = inserted[0] as { surface: string; identityKey: string; salonId: string | null };
    expect(row.surface).toBe('web');
    expect(row.salonId).toBe('SAL-AMARA');
    expect(row.identityKey).toBe(signInIdentityKey('web', 'SAL-AMARA', 'noura'));
    expect(JSON.stringify(row)).not.toContain('noura');
  });

  it('carries a null salon through for the console', async () => {
    const { db, inserted } = stubDb({ burst: 0, hour: 0 });
    await chargeSignInBudget(db, 'platform', null, 'yousef');

    const row = inserted[0] as { salonId: string | null };
    expect(row.salonId).toBeNull();
  });
});
