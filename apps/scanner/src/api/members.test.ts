/**
 * The lookup row's shape, pinned to what the server actually sends.
 *
 * This file exists because the previous schema was `MemberSchema`, which
 * requires eight fields `GET /members?q=` deliberately withholds — so every
 * SUCCESSFUL search threw and the screen showed its error state. The payload
 * below is transcribed from a live response on avo_lane_b:
 *
 *   GET /members?q=Dana
 *   {"items":[{"id":"8842","salonId":"SAL-AMARA","name":"Dana Al-Sabah",
 *              "phoneLast4":"4408","tier":"silver"}],"nextCursor":null}
 */

import { describe, expect, it } from 'vitest';
import { MemberSearchRowSchema, MIN_QUERY_LENGTH } from './members';

/** Exactly the wire payload, field for field. */
const WIRE_ROW = {
  id: '8842',
  salonId: 'SAL-AMARA',
  name: 'Dana Al-Sabah',
  phoneLast4: '4408',
  tier: 'silver',
};

describe('the directory row', () => {
  it('accepts the response the server actually sends', () => {
    const parsed = MemberSearchRowSchema.safeParse(WIRE_ROW);
    expect(parsed.success).toBe(true);
  });

  it('accepts a null tier, because a stamps salon has no tiers', () => {
    expect(MemberSearchRowSchema.safeParse({ ...WIRE_ROW, tier: null }).success).toBe(true);
  });

  it('does NOT require the eight fields the old schema demanded', () => {
    // The regression this file is here for. If someone reaches for MemberSchema
    // again, or widens this one to match it, these keys become required and
    // every successful lookup starts throwing again.
    const required = Object.keys(MemberSearchRowSchema.shape);
    for (const absent of [
      'phone',
      'email',
      'emailVerified',
      'balanceFils',
      'visits',
      'stamps',
      'policyVersion',
      'joinedAt',
    ]) {
      expect(required).not.toContain(absent);
    }
  });

  it('keeps the balance and the full phone OUT of the row, which is the point', () => {
    // Not a style preference. This list is reachable by any staff member with
    // perms.scanner and two keystrokes, so a field here is a field that leaks.
    const parsed = MemberSearchRowSchema.parse(WIRE_ROW) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('balanceFils');
    expect(parsed).not.toHaveProperty('phone');
    expect(parsed.phoneLast4).toBe('4408');
  });

  it('keeps phoneLast4 a string, so a leading zero survives', () => {
    const zeroLed = MemberSearchRowSchema.parse({ ...WIRE_ROW, phoneLast4: '0042' });
    expect(zeroLed.phoneLast4).toBe('0042');
    // A number would have made this 42 and printed "···· 42" at the counter.
    expect(MemberSearchRowSchema.safeParse({ ...WIRE_ROW, phoneLast4: 4408 }).success).toBe(false);
  });

  it('rejects a row missing the fields it does need', () => {
    for (const key of ['id', 'salonId', 'name', 'phoneLast4']) {
      const partial: Record<string, unknown> = { ...WIRE_ROW };
      delete partial[key];
      expect(MemberSearchRowSchema.safeParse(partial).success).toBe(false);
    }
  });

  it('rejects a tier the loyalty ladder does not have', () => {
    expect(MemberSearchRowSchema.safeParse({ ...WIRE_ROW, tier: 'platinum' }).success).toBe(false);
  });
});

describe('the minimum query length', () => {
  it("matches the server's, so the client cannot refuse a query the API would answer", () => {
    // api/src/services/memberSearch.ts:56 — MEMBER_SEARCH_MIN_QUERY = 2.
    // This was 3, which silently made "Da" find nobody.
    expect(MIN_QUERY_LENGTH).toBe(2);
  });
});
