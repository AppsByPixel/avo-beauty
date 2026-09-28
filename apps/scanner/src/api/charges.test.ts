/**
 * The charge response, pinned to what the server actually sends.
 *
 * The payload below is transcribed from a live `POST /charges` on `avo_lane_b`,
 * taken through the MANUAL path — `{memberId, serviceIds}` with no wallet token —
 * against a member with a 5.000 deposit held inside the no-show grace window:
 *
 *   before: balance_fils 19500   booking BK-6432117 deposit_held
 *   after : balance_fils 16500   booking BK-6432117 completed -> TX-9802919
 *
 *   8.000 service − 5.000 deposit = 3.000 debited, which is the design's own
 *   worked example (AVO Staff Scanner.dc.html:354).
 */

import { describe, expect, it } from 'vitest';
import { ChargeResultSchema } from './charges';

/**
 * The real body, with the two keys the API omits today added back.
 *
 * SEE THE SECOND DESCRIBE BLOCK. `POST /charges` does not currently send
 * `voidedAt` or `reversedByTransactionId`, and `TransactionSchema` requires both,
 * so the live response is REJECTED. That is a server gap, routed to lane A, and
 * it is deliberately NOT worked around here: a client-side tolerance would mask
 * exactly the drift the contract guard exists to catch, and would outlive the bug.
 */
const WIRE = {
  transaction: {
    id: 'TX-9802919',
    memberId: '8842',
    branchId: 'BR-KWC',
    kind: 'charge',
    amountFils: -3000,
    bonusFils: 0,
    method: 'wallet',
    status: 'settled',
    reference: 'AVO-CHG-9802919',
    createdAt: '2026-08-18T10:20:31.000Z',
    // Added by trunk when `customAmount` joined `TransactionSchema` (api 0049).
    // This constant is a RECORDED wire body, which is the thing
    // `e2e/support/contract-drift.ts` opens by warning about: it drifts alongside
    // the schema it is meant to police, and the seven specs below went red on a
    // field the server had started sending rather than on anything they assert.
    // Lane D owns whether this file keeps a recording at all.
    customAmount: false,
    voidedAt: null,
    reversedByTransactionId: null,
    // Migration 0065 (lane A, edcb0f0): what the charge earned, recorded on its
    // own row. The charge response's transaction goes through
    // `serialiseTransactionForCustomer`, so it carries `loyaltyColumnsFor(outcome)`
    // in `serialiseTransactionLoyalty`'s shape — the SAME outcome as `loyalty`
    // below: +1 visit, silver after, no climb. `rewardReady` is always false in
    // tiers mode (services/charge.ts § loyaltyColumnsFor).
    loyalty: {
      mode: 'tiers',
      visitsEarned: 1,
      tierAfter: 'silver',
      climbed: false,
      rewardReady: false,
    },
  },
  balanceAfterFils: 16500,
  depositAppliedFils: 5000,
  depositReturnedFils: 0,
  bookingId: 'BK-6432117',
  loyalty: {
    mode: 'tiers',
    visits: 6,
    tier: 'silver',
    nextTier: 'gold',
    visitsToNext: 4,
    climbed: false,
    visitsEarned: 1,
  },
  voidableUntil: '2026-08-18T10:35:31.000Z',
  happyHour: null,
};

describe('the charge result', () => {
  it('accepts the body the server sends on the manual path', () => {
    const parsed = ChargeResultSchema.safeParse(WIRE);
    expect(parsed.success).toBe(true);
  });

  it('KEEPS the three fields this schema used to strip', () => {
    /*
      The regression this file is here for. The schema declared
      `{transaction, balanceAfterFils, depositAppliedFils, loyalty, voidableUntil}`
      while the server also sends `depositReturnedFils`, `bookingId` and
      `happyHour` (api/src/services/charge.ts:80-120). Zod strips undeclared
      fields rather than failing, so all three arrived and vanished silently.

      `depositReturnedFils` is the one with money in it: a 5.000 hold against a
      3.000 basket is capped at the basket and the remaining 2.000 goes back to her
      wallet as its own `deposit_return` transaction (non-negotiable #5). A client
      that strips it cannot tell the artist that happened, so the customer sees a
      balance move nobody at the counter can explain.
    */
    const parsed = ChargeResultSchema.parse(WIRE);
    expect(parsed.depositReturnedFils).toBe(0);
    expect(parsed.bookingId).toBe('BK-6432117');
    expect(parsed.happyHour).toBeNull();
  });

  it('names the booking the deposit was applied from', () => {
    // The pairing that makes the credit line explainable: 5.000 applied, and this
    // is the appointment it came from. Verified against the database, where the
    // same booking moved deposit_held -> completed naming this charge.
    const parsed = ChargeResultSchema.parse(WIRE);
    expect(parsed.depositAppliedFils).toBe(5000);
    expect(parsed.bookingId).toBe('BK-6432117');
  });

  it('keeps bookingId and happyHour null-not-absent', () => {
    /*
      "Both always present, both null/0 when there was no booking — a scanner has
      to be able to tell 'no deposit was held' from 'this API is too old to say'"
      (api/src/services/charge.ts). Optional would collapse the two.
    */
    const noDeposit = { ...WIRE, depositAppliedFils: 0, bookingId: null };
    expect(ChargeResultSchema.parse(noDeposit).bookingId).toBeNull();

    for (const key of ['bookingId', 'happyHour', 'depositReturnedFils'] as const) {
      const omitted: Record<string, unknown> = { ...WIRE };
      delete omitted[key];
      expect(ChargeResultSchema.safeParse(omitted).success).toBe(false);
    }
  });

  it('reads a live happy hour as an outcome, never an input', () => {
    // `POST /charges` reads no promotion field from its body at all, so this is
    // only ever something the server reports (non-negotiable #2).
    const boosted = {
      ...WIRE,
      happyHour: {
        id: 'HH-01',
        visitMultiplier: 2,
        stampMultiplier: 1,
        creditFils: 0,
        minutesRemaining: 42,
      },
    };
    expect(ChargeResultSchema.parse(boosted).happyHour?.id).toBe('HH-01');
  });

  it('refuses a fractional balance or deposit — money is integer fils', () => {
    // Non-negotiable #1, at the boundary where the server's number enters the app.
    for (const bad of [
      { balanceAfterFils: 16500.5 },
      { depositAppliedFils: 5000.001 },
      { depositReturnedFils: 0.5 },
    ]) {
      expect(ChargeResultSchema.safeParse({ ...WIRE, ...bad }).success).toBe(false);
    }
  });
});

describe('the void state the wire must carry', () => {
  /**
   * REPORTED, NOT PAPERED OVER — and this block is the pin that keeps it reported.
   *
   * `TransactionSchema` declares `voidedAt` and `reversedByTransactionId` as
   * `.nullable()`, not `.optional()`, so both keys must be PRESENT. `POST /charges`
   * omits them (verified against a live response on avo_lane_b), which means a
   * charge that SUCCEEDS server-side is rejected by this schema and reads as a
   * failure at the counter — the worst possible shape for the bug, because staff
   * would reasonably charge again.
   *
   * The fix belongs in `api/`, not here. These assertions stay green either way:
   * they assert that a transaction missing the keys is refused, which is the
   * contract, and is exactly why the omission has to be fixed upstream.
   */
  it('refuses a transaction missing voidedAt or reversedByTransactionId', () => {
    for (const key of ['voidedAt', 'reversedByTransactionId'] as const) {
      const omitted: Record<string, unknown> = { ...WIRE.transaction };
      delete omitted[key];
      const parsed = ChargeResultSchema.safeParse({ ...WIRE, transaction: omitted });
      expect(parsed.success).toBe(false);
    }
  });

  it('accepts them as null, which is what an unvoided charge means', () => {
    const parsed = ChargeResultSchema.parse(WIRE);
    expect(parsed.transaction.voidedAt).toBeNull();
    expect(parsed.transaction.reversedByTransactionId).toBeNull();
  });

  it('carries them through once a charge HAS been voided', () => {
    // The scanner's void window is 15 minutes and the charge list renders
    // "Voided 14:32" from exactly this field. It was being stripped once before.
    const voided = {
      ...WIRE,
      transaction: {
        ...WIRE.transaction,
        voidedAt: '2026-08-18T10:31:00.000Z',
        reversedByTransactionId: 'TX-9802920',
      },
    };
    const parsed = ChargeResultSchema.parse(voided);
    expect(parsed.transaction.voidedAt).toBe('2026-08-18T10:31:00.000Z');
    expect(parsed.transaction.reversedByTransactionId).toBe('TX-9802920');
  });
});

describe('what the charge earned', () => {
  /**
   * TWO PLACES, ONE OUTCOME. `loyalty` on the response is the after-state the
   * result line draws; `transaction.loyalty` is the record 0065 wrote on the
   * charge row, which her wallet reads and a void takes back. Both are the
   * server's; neither is derived here (non-negotiable #2).
   */
  it('keeps the count on the response — the "+1 visit" the result line prints', () => {
    const parsed = ChargeResultSchema.parse(WIRE);
    expect(parsed.loyalty.mode).toBe('tiers');
    if (parsed.loyalty.mode !== 'tiers') return;
    expect(parsed.loyalty.visitsEarned).toBe(1);
  });

  it('refuses a response that does not say how many were earned', () => {
    // Required since lane A sends it on every charge. A body without it is an
    // API older than this client, and the line no longer has a fallback for it.
    const { visitsEarned: _v, ...noVisits } = WIRE.loyalty;
    expect(ChargeResultSchema.safeParse({ ...WIRE, loyalty: noVisits }).success).toBe(false);

    const stamps = { mode: 'stamps', stamps: 5, target: 8, rewardReady: false };
    expect(ChargeResultSchema.safeParse({ ...WIRE, loyalty: stamps }).success).toBe(false);
    expect(
      ChargeResultSchema.safeParse({ ...WIRE, loyalty: { ...stamps, stampsEarned: 1 } }).success,
    ).toBe(true);
  });

  it("keeps the transaction's record, with nothing stripped", () => {
    const parsed = ChargeResultSchema.parse(WIRE);
    expect(parsed.transaction.loyalty).toEqual(WIRE.transaction.loyalty);
    expect(Object.keys(parsed.transaction).sort()).toEqual(Object.keys(WIRE.transaction).sort());
  });

  it('refuses a transaction that omits loyalty rather than reading it as null', () => {
    // `.nullable()`, not `.optional()`: null is "nothing was recorded", and a
    // missing key is a serialiser that forgot it.
    const { loyalty: _dropped, ...omitted } = WIRE.transaction;
    expect(ChargeResultSchema.safeParse({ ...WIRE, transaction: omitted }).success).toBe(false);
  });
});
