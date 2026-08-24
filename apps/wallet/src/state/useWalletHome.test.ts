/**
 * Stale, not blank — one level below the rule `useShop` carries.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * `GET /v1/salons/{id}/promotions` sat inside Home's `Promise.all` unguarded, so
 * a 500 from it failed the whole snapshot. On a cold start that renders the
 * full-page failure screen: no balance, no activity, no payment code — because
 * a strip of decoration above the wallet card could not be read. Every other
 * read in that batch genuinely leaves nothing honest to render if it fails.
 * Promotions do not: the banner and the branch chips simply are not there.
 *
 * The decision is a function taking its reader rather than a `.catch` inside the
 * `Promise.all`, for the reason `shopStatusForFailure` gives: this workspace has
 * no renderer and no HTTP double, so a branch left inline is a branch no test
 * can reach — which is how the unguarded version shipped in the first place.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { describe, expect, it } from 'vitest';
import type { PromotionSet } from '@avo/types';
import { readPromotionsOrNull } from './useWalletHome';
import { ApiError } from '../api/client';

const PROMOTIONS: PromotionSet = {
  boosts: { 'BR-KWC': { visit: 2, topup: 10, stamp: 1 } },
  boostsPublishedAt: '2026-08-10T06:00:00.000Z',
  boostsPublishedBy: 'Noura',
  happy: [],
};

const LIVE = { aborted: false };
const ABORTED = { aborted: true };

describe('a promotions read that fails', () => {
  it('passes the set straight through when it succeeds', async () => {
    await expect(readPromotionsOrNull(async () => PROMOTIONS, LIVE)).resolves.toBe(PROMOTIONS);
  });

  it('degrades to null rather than failing the whole Home load', async () => {
    const boom = async (): Promise<PromotionSet> => {
      throw new ApiError('server', 'Something went wrong.', 'WLT-0001-0002', 500);
    };
    await expect(readPromotionsOrNull(boom, LIVE)).resolves.toBeNull();
  });

  it('degrades for every failure kind, including a forbidden one', async () => {
    for (const kind of ['server', 'offline', 'forbidden'] as const) {
      const boom = async (): Promise<PromotionSet> => {
        throw new ApiError(kind, 'no', 'WLT-0000-0000', null);
      };
      await expect(readPromotionsOrNull(boom, LIVE)).resolves.toBeNull();
    }
  });

  it('degrades on a non-ApiError too — a thrown parse error is still not a blank wallet', async () => {
    const boom = async (): Promise<PromotionSet> => {
      throw new TypeError('unexpected token');
    };
    await expect(readPromotionsOrNull(boom, LIVE)).resolves.toBeNull();
  });
});

describe('an abort is not a promotions failure', () => {
  /**
   * The one case that must NOT degrade. `load()` aborts the previous controller
   * on every retry, so a superseded load's promotions read rejects with an abort
   * — and turning that into `null` would let the stale load resolve a snapshot
   * and race the live one onto the screen. It has to keep rejecting so
   * `Promise.all` fails and the caller's `signal.aborted` guard drops it.
   */
  it('rethrows so the superseded load fails instead of resolving', async () => {
    const boom = async (): Promise<PromotionSet> => {
      throw new DOMException('Aborted', 'AbortError');
    };
    await expect(readPromotionsOrNull(boom, ABORTED)).rejects.toThrow('Aborted');
  });
});
