/**
 * THE RESULT SCREEN'S LOYALTY LINE — "+1 visit · 2 more to Gold".
 *
 * Aftab, 2026-09-29 (DECISIONS.md § "The fourth list"): *"After each scan the
 * membership points are gained"*, ruled as: show what she gained. There are no
 * points and no new earning rule; the charge transaction already earns, and
 * this line reports what it earned.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RENDERED, AT THE ONE LEVEL THIS WORKSPACE CAN RENDER
 * ─────────────────────────────────────────────────────────────────────────────
 * The scanner has no renderer: no jsdom, no testing-library, and adding one
 * rewrites the trunk-owned `pnpm-lock.yaml` (chargeStates.test.ts says the
 * same). So `LoyaltyLine` is hookless on purpose, and this file calls it and
 * reads the element tree it returns: the `result-loyalty` node, and its text.
 * That is a shallow render — what the component draws from a given charge
 * response — and the source scan at the bottom pins that `ResultScreen` draws
 * it in the Loyalty row rather than a sentence of its own.
 *
 * Each case is a charge response the server can send, built on the recorded
 * wire body in api/charges.test.ts and parsed through `ChargeResultSchema`, so a
 * case the contract would reject cannot pass here.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';

vi.mock('react-native', () => ({
  Text: 'Text',
  View: 'View',
  StyleSheet: { create: <T>(s: T) => s },
}));

/* eslint-disable import/first */
import { ChargeResultSchema } from '../api/charges';
import { LoyaltyLine } from '../components/LoyaltyLine';

const BASE = {
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
    customAmount: false,
    voidedAt: null,
    reversedByTransactionId: null,
  },
  balanceAfterFils: 16500,
  depositAppliedFils: 0,
  depositReturnedFils: 0,
  bookingId: null,
  voidableUntil: '2026-08-18T10:35:31.000Z',
  happyHour: null,
};

/**
 * `transaction.loyalty` as the server writes it for a given outcome —
 * `services/charge.ts § loyaltyColumnsFor` through `serialiseTransactionLoyalty`.
 * Fixture construction only: it keeps each case's two copies of the one outcome
 * agreeing, the way the real response's do. No screen reads this function.
 */
function recorded(o: Record<string, unknown>) {
  return o['mode'] === 'stamps'
    ? {
        mode: 'stamps',
        stampsEarned: o['stampsEarned'],
        tierAfter: null,
        climbed: false,
        rewardReady: o['rewardReady'],
      }
    : {
        mode: 'tiers',
        visitsEarned: o['visitsEarned'],
        tierAfter: o['tier'],
        climbed: o['climbed'] ?? false,
        rewardReady: false,
      };
}

function response(loyalty: Record<string, unknown>, happyHour: unknown = null) {
  return ChargeResultSchema.parse({
    ...BASE,
    transaction: { ...BASE.transaction, loyalty: recorded(loyalty) },
    loyalty,
    happyHour,
  });
}

function hh(visitMultiplier: number, stampMultiplier: number) {
  return { id: 'HH-1', visitMultiplier, stampMultiplier, creditFils: 0, minutesRemaining: 40 };
}

/** Every string under an element, in order. */
function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  const el = node as ReactElement<{ children?: ReactNode }>;
  return textOf(el.props.children);
}

/** Render the line for a response and return the `result-loyalty` node's text. */
function line(result: ReturnType<typeof response>): string {
  const el = LoyaltyLine({ result }) as ReactElement<{ testID?: string; children?: ReactNode }>;
  expect(el.type).toBe('Text');
  expect(el.props.testID).toBe('result-loyalty');
  return textOf(el);
}

describe('tiers mode', () => {
  it('climbing: the visits earned, then how far the next rung is', () => {
    const r = response({
      mode: 'tiers',
      visits: 8,
      tier: 'silver',
      nextTier: 'gold',
      visitsToNext: 2,
      climbed: false,
      visitsEarned: 1,
    });
    expect(line(r)).toBe('+1 visit · 2 more to Gold');
  });

  it('crossing a rung says so, even with another rung ahead', () => {
    const r = response({
      mode: 'tiers',
      visits: 10,
      tier: 'gold',
      nextTier: 'black',
      visitsToNext: 15,
      climbed: true,
      visitsEarned: 1,
    });
    expect(line(r)).toBe('+1 visit · Reached Gold');
  });

  it('at the top of the ladder: no "more to", and no dangling preposition', () => {
    const r = response({
      mode: 'tiers',
      visits: 40,
      tier: 'black',
      nextTier: null,
      visitsToNext: null,
      climbed: false,
      visitsEarned: 1,
    });
    expect(line(r)).toBe('+1 visit · Reached Black');
  });

  it('with a multiplier: the count the server applied, and its name', () => {
    const r = response(
      {
        mode: 'tiers',
        visits: 9,
        tier: 'silver',
        nextTier: 'gold',
        visitsToNext: 1,
        climbed: false,
        visitsEarned: 2,
      },
      hh(2, 1),
    );
    expect(line(r)).toBe('+2 visits · Double visit credit · 1 more to Gold');
  });
});

describe('stamps mode', () => {
  it('mid-card: the stamps earned, then the card', () => {
    const r = response({ mode: 'stamps', stamps: 5, target: 8, rewardReady: false, stampsEarned: 1 });
    expect(line(r)).toBe('+1 stamp · 5 of 8');
  });

  it('reward ready replaces the count, which may have run past the target', () => {
    const r = response({ mode: 'stamps', stamps: 8, target: 8, rewardReady: true, stampsEarned: 1 });
    expect(line(r)).toBe('+1 stamp · Reward ready');
  });

  it('with a multiplier: "Double stamps" / "Triple stamps", the bundle\'s own labels', () => {
    const doubled = response(
      { mode: 'stamps', stamps: 6, target: 8, rewardReady: false, stampsEarned: 2 },
      hh(1, 2),
    );
    expect(line(doubled)).toBe('+2 stamps · Double stamps · 6 of 8');

    const tripled = response(
      { mode: 'stamps', stamps: 7, target: 8, rewardReady: false, stampsEarned: 3 },
      hh(1, 3),
    );
    expect(line(tripled)).toBe('+3 stamps · Triple stamps · 7 of 8');
  });

  it('a live window that multiplied nothing in this mode names nothing', () => {
    // A tiers-only x2visit window at a stamps salon: `happyHour` is present
    // and its stamp multiplier is 1. The line must not say "Double".
    const r = response(
      { mode: 'stamps', stamps: 5, target: 8, rewardReady: false, stampsEarned: 1 },
      hh(2, 1),
    );
    expect(line(r)).toBe('+1 stamp · 5 of 8');
  });
});

describe('the count is required, and there is no fallback', () => {
  /**
   * Lane A's eefccb1 sends `visitsEarned` / `stampsEarned` on every charge, so
   * the schema requires them and the line always opens with "+N visit(s)" or
   * "+N stamp(s)". The design's "Visit added" / "Stamp added", which stood in
   * while the API did not say, is gone — a body without the count is refused at
   * the parse and never reaches the screen.
   */
  /**
   * Built WITHOUT `response()`, whose `recorded()` would copy the missing count
   * into `transaction.loyalty` and fail the parse there instead — a refusal for
   * the wrong reason, which would pass against the old optional schema too.
   * The transaction's record here is whole; only the response's count is gone.
   */
  function withoutCount(outcome: Record<string, unknown>, record: Record<string, unknown>) {
    return ChargeResultSchema.safeParse({
      ...BASE,
      transaction: { ...BASE.transaction, loyalty: record },
      loyalty: outcome,
    }).success;
  }

  it('tiers: a response with no visitsEarned is refused', () => {
    const outcome = { mode: 'tiers', visits: 8, tier: 'silver', nextTier: 'gold', visitsToNext: 2, climbed: false };
    const record = { mode: 'tiers', visitsEarned: 1, tierAfter: 'silver', climbed: false, rewardReady: false };
    expect(withoutCount(outcome, record)).toBe(false);
    expect(withoutCount({ ...outcome, visitsEarned: 1 }, record)).toBe(true);
  });

  it('stamps: a response with no stampsEarned is refused', () => {
    const outcome = { mode: 'stamps', stamps: 5, target: 8, rewardReady: false };
    const record = { mode: 'stamps', stampsEarned: 1, tierAfter: null, climbed: false, rewardReady: false };
    expect(withoutCount(outcome, record)).toBe(false);
    expect(withoutCount({ ...outcome, stampsEarned: 1 }, record)).toBe(true);
  });

  it('never prints the old fallback sentence', () => {
    const tiers = response({
      mode: 'tiers',
      visits: 8,
      tier: 'silver',
      nextTier: 'gold',
      visitsToNext: 2,
      climbed: false,
      visitsEarned: 1,
    });
    const stamps = response({ mode: 'stamps', stamps: 5, target: 8, rewardReady: false, stampsEarned: 1 });
    for (const r of [tiers, stamps]) {
      expect(line(r)).toMatch(/^\+\d+ (visit|visits|stamp|stamps) · /);
      expect(line(r)).not.toMatch(/added/i);
    }
  });

  it('prints the count the server applied, verbatim — a boost with no window is still +2', () => {
    // `happyHour` is null under a branch boost that doubled the visit, so the
    // count cannot come from the multiplier. It comes from `visitsEarned`.
    const r = response({
      mode: 'tiers',
      visits: 9,
      tier: 'silver',
      nextTier: 'gold',
      visitsToNext: 1,
      climbed: false,
      visitsEarned: 2,
    });
    expect(line(r)).toBe('+2 visits · 1 more to Gold');
  });

  it('a response with no loyalty outcome at all never reaches the screen', () => {
    // `loyalty` is required on the contract, like `happyHour`: a body without it
    // is refused at the parse, so the line has no "absent" case to draw.
    const { loyalty: _dropped, ...rest } = response({
      mode: 'stamps',
      stamps: 5,
      target: 8,
      rewardReady: false,
      stampsEarned: 1,
    });
    expect(ChargeResultSchema.safeParse(rest).success).toBe(false);
  });
});

describe('ResultScreen draws this line in its Loyalty row', () => {
  const src = readFileSync(join(__dirname, 'ResultScreen.tsx'), 'utf8');

  it('renders LoyaltyLine from the charge response, and no sentence of its own', () => {
    expect(src).toContain('<LoyaltyLine result={result} />');
    expect(src).not.toContain('loyaltySentence');
    expect(src).not.toContain('testID="result-loyalty"');
  });
});
