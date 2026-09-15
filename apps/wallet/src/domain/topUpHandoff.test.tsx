// @vitest-environment jsdom

/**
 * "TOP UP TO CONTINUE" — WHERE IT GOES, AND WHAT IT ASKS THE SERVER FOR.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE DEFECT.
 *
 *   App.tsx:446  onTopUp={goHome}
 *   App.tsx:337  const goHome = () => { setScreen('home'); setReschedule(null); }
 *
 * Fill a cart, be told "Balance too low by 3.250", tap the only action offered —
 * and land on Home with the cart closed, nothing open and no account of what
 * happened. The CTA, its copy and its position were all correct; its destination
 * was a tab switch. `HomeScreen:363` did the same thing properly one file away.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE AMOUNT IS THE DECISION, BECAUSE `open()` COMMITS IT.
 *
 * `useTopUp.open(amount)` quotes immediately — there is no tile picker inside
 * the sheet — so the figure a caller passes is the figure `POST /topups` is
 * asked for. `domain/topup.ts` § topUpAmountForShortfall carries the argument.
 * This file proves the consequence rather than restating it: it drives the REAL
 * controller with the API mocked at the boundary and reads the `amountFils` that
 * actually reached the wire. An assertion on the helper's return value alone
 * would not catch a caller that passed the raw shortfall.
 *
 * NON-NEGOTIABLE #2 IS THE POINT OF THE LAST DESCRIBE. The client picks WHICH
 * published denomination to have quoted; it never computes credit and never adds
 * to a balance. The guard that makes that checkable is that every amount this
 * helper can ever produce is a member of `TOP_UP_AMOUNTS` — so no arbitrary
 * figure, however derived, can reach the money endpoint through this path.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { fils, type Fils } from '@avo/types';

const { createTopUp, getTopUp } = vi.hoisted(() => ({
  createTopUp: vi.fn(),
  getTopUp: vi.fn(),
}));

vi.mock('../api/topups', () => ({ createTopUp, getTopUp }));

// eslint-disable-next-line import/first
import { useTopUp } from '../state/useTopUp';
// eslint-disable-next-line import/first
import {
  DEFAULT_TOP_UP_AMOUNT,
  TOP_UP_AMOUNTS,
  topUpAmountForShortfall,
} from './topup';

beforeEach(() => {
  createTopUp.mockReset();
  getTopUp.mockReset();
  createTopUp.mockResolvedValue({
    id: 'TU-1',
    amountFils: 10000,
    creditFils: 11000,
    feeFils: 150,
    method: 'knet',
    status: 'created',
    redirectUrl: 'https://pay.example/1',
  });
});

describe('the tile a shortfall opens the sheet on', () => {
  it.each([
    // shortfall            tile      why
    [fils(1), fils(10000), 'a 1-fils shortfall still gets the default, not 0.001'],
    [fils(3250), fils(10000), "the reported case — 3.250 short, the default covers it"],
    [fils(10000), fils(10000), 'exactly the default'],
    [fils(10001), fils(25000), 'one fils over the default steps to the next tile'],
    [fils(25000), fils(25000), 'exactly a tile'],
    [fils(40000), fils(50000), 'the largest tile covers it'],
    [fils(50000), fils(50000), 'exactly the largest tile'],
  ])('short by %s -> %s (%s)', (shortfall, tile) => {
    expect(topUpAmountForShortfall(shortfall as Fils)).toBe(tile);
  });

  it('never goes below the default, so a small shortfall still leaves a cushion', () => {
    // This is `BookScreen`'s existing argument, generalised rather than
    // contradicted: for every shortfall the default already covers, this returns
    // exactly what the Book flow's shortfall CTA returns.
    for (const short of [0, 1, 500, 3250, 9999, 10000]) {
      expect(topUpAmountForShortfall(fils(short))).toBe(DEFAULT_TOP_UP_AMOUNT);
    }
  });

  it('caps at the largest tile, and that is progress rather than a dead end', () => {
    // Nothing offered covers 60.000. The largest tile is the most one tap can
    // do, and it strictly reduces what is left — the NEXT hand-off is smaller
    // and the loop terminates.
    const huge = fils(60000);
    const first = topUpAmountForShortfall(huge);
    expect(first).toBe(fils(50000));
    expect(first).toBeLessThan(huge);
    expect(topUpAmountForShortfall(fils(huge - first))).toBe(DEFAULT_TOP_UP_AMOUNT);
  });

  it('only ever returns an offered denomination — #2, and no free-entry field', () => {
    // Exhaustive over every fils value from 0 to 60.000. A custom amount is "a
    // product decision, not something to add here" (domain/topup.ts), and this
    // is what stops one arriving by inference from a shortfall.
    for (let short = 0; short <= 60000; short += 1) {
      expect(TOP_UP_AMOUNTS).toContain(topUpAmountForShortfall(fils(short)));
    }
  });
});

describe('the figure that reaches POST /topups', () => {
  it('is the tile, not the raw shortfall', async () => {
    const { result } = renderHook(() => useTopUp({ onSucceeded: vi.fn() }));

    act(() => {
      result.current.open(topUpAmountForShortfall(fils(3250)));
    });

    await waitFor(() => expect(createTopUp).toHaveBeenCalledTimes(1));
    const [input] = createTopUp.mock.calls[0]!;
    expect(input.amountFils).toBe(10000);
    expect(input.amountFils).not.toBe(3250);
    // #4: a money-moving POST carries an idempotency key, minted per attempt.
    expect(typeof input.idempotencyKey).toBe('string');
    expect(input.idempotencyKey.length).toBeGreaterThan(0);
    // KNET is the default rail — domain/topup.ts § PAYMENT_METHODS.
    expect(input.method).toBe('knet');
  });

  it('the sheet opens — the stage leaves `closed`, which `goHome` never did', async () => {
    const { result } = renderHook(() => useTopUp({ onSucceeded: vi.fn() }));
    expect(result.current.stage.name).toBe('closed');
    act(() => {
      result.current.open(topUpAmountForShortfall(fils(3250)));
    });
    await waitFor(() => expect(result.current.stage.name).toBe('ready'));
  });
});

/**
 * The wiring itself, read from source.
 *
 * LABELLED HONESTLY: these are source assertions, not renders. `ShopScreen`
 * cannot be mounted in this suite — it imports `react-native-svg`, which reaches
 * untranspiled Flow and fails to parse (`SyntaxError: Unexpected token 'typeof'`,
 * reproduced while writing this file; `vitest.config.ts` documents the same
 * wall). The behaviour they stand in for is proved against the real controller
 * above; what is left to check is that the caller is joined up to it.
 */
describe('the cart CTA is wired to the sheet, not to a tab switch', () => {
  const WALLET = path.resolve(__dirname, '..', '..');
  const read = (rel: string) => fs.readFileSync(path.join(WALLET, rel), 'utf8');

  it('ShopScreen owns a TopUpSheet and opens it from the cart', () => {
    const src = read('src/screens/ShopScreen.tsx');
    expect(src).toContain('<TopUpSheet');
    expect(src).toContain('onTopUp={() => topUp.open(topUpAmountForShortfall(shop.shortfall))}');
  });

  it('and does not close the cart on the way — she comes back to her items', () => {
    // The old handler was `setCartOpen(false); onTopUp();`. The sheet paints
    // over the cart instead, so the cart must stay open.
    const src = read('src/screens/ShopScreen.tsx');
    const handler = /onTopUp=\{[^}]*\}/.exec(src)?.[0] ?? '';
    expect(handler).not.toContain('setCartOpen(false)');
  });

  it('only clears the refusal a top-up actually resolves', () => {
    // Unconditional `clearRefusal()` would re-arm Pay on an `alreadyPlaced`
    // cart — a 422 meaning an earlier attempt committed — which this CTA is
    // reachable from, because a settled order is what can have left her short.
    const src = read('src/screens/ShopScreen.tsx');
    expect(src).toContain("if (shop.refusal?.kind === 'short') shop.clearRefusal();");
  });

  it('App.tsx no longer routes the cart shortfall to goHome', () => {
    // The `<ShopScreen …/>` element's PROPS, not the file and not its
    // comments: the note that records what this used to be quotes
    // `onTopUp={goHome}` verbatim, and it sits inside the element. An assertion
    // that a comment can fail is an assertion nobody can safely explain a fix in.
    const src = read('App.tsx');
    const el = (/<ShopScreen\b[\s\S]*?\/>/.exec(src)?.[0] ?? '').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    expect(el, '<ShopScreen> not found in App.tsx').not.toBe('');
    expect(el).not.toContain('goHome');
    expect(el).not.toMatch(/\bonTopUp=/);
    expect(el).toContain('onToppedUp={home.retry}');
    expect(el).toContain('tier={snapshot.member.tier}');
  });
});
