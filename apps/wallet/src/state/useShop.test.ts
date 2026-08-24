/**
 * Stale, not blank — the rule `useShop` was the only one of the three hooks to
 * be missing.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * `useWalletHome` and `useAccount` both resolve a failure against whether they
 * already hold data, so a failed refresh keeps the screen and adds a banner.
 * `useShop` set `failed` unconditionally, and `ShopScreen` renders a full-page
 * failure screen for `failed` — so a refresh that failed over a catalogue on
 * screen would have replaced it. interaction-spec.md §4 names that failure
 * outright.
 *
 * It was LATENT: `retry` is reachable only from the failure screen, so nothing
 * could refresh over data. Latent is how it ships and how it later becomes
 * reachable with nobody remembering — a pull-to-refresh, a focus refetch, a
 * reload after an order. This is the spec that makes it fail loudly instead.
 *
 * The pure function is tested rather than the hook because this workspace has no
 * renderer, which is the same reason `loadFailure.ts` and `orderRefusal.ts` are
 * pure — and the reason the branch went untested when it lived inside a catch.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { describe, expect, it } from 'vitest';
import { shopStatusForFailure } from './useShop';

const HAS_DATA = true;
const COLD = false;

describe('a failure over a catalogue already on screen', () => {
  it('keeps the catalogue and marks it stale on a server failure', () => {
    expect(shopStatusForFailure('server', HAS_DATA)).toBe('stale');
  });

  it('keeps the catalogue and marks it offline on a connection failure', () => {
    expect(shopStatusForFailure('offline', HAS_DATA)).toBe('offline');
  });

  it('never blanks a catalogue for either recoverable kind', () => {
    // `failed` is the only status ShopScreen answers with a full-page takeover.
    for (const kind of ['server', 'offline'] as const) {
      expect(shopStatusForFailure(kind, HAS_DATA)).not.toBe('failed');
    }
  });
});

describe('a cold failure has nothing to keep', () => {
  it('is `failed` for every kind when no catalogue has ever loaded', () => {
    for (const kind of ['server', 'offline', 'forbidden'] as const) {
      expect(shopStatusForFailure(kind, COLD)).toBe('failed');
    }
  });

  it('does not invent a stale state with no data behind it', () => {
    // A stale banner stamps a time the screen would not have.
    expect(shopStatusForFailure('server', COLD)).not.toBe('stale');
    expect(shopStatusForFailure('offline', COLD)).not.toBe('offline');
  });
});

describe('forbidden is the exception, and deliberately so', () => {
  it('blanks the catalogue even when one is on screen', () => {
    /*
      Non-negotiable #7: the server is the control. A 403 says she may not see
      this catalogue, and continuing to render priced, tappable, add-to-cart rows
      she has just been refused would be the UI overriding that answer.
    */
    expect(shopStatusForFailure('forbidden', HAS_DATA)).toBe('failed');
  });

  it('is the only kind that discards data it already had', () => {
    const discards = (['server', 'offline', 'forbidden'] as const).filter(
      (kind) => shopStatusForFailure(kind, HAS_DATA) === 'failed',
    );
    expect(discards).toEqual(['forbidden']);
  });
});

describe('the status is always one ShopScreen can render', () => {
  it('never returns a status outside the union', () => {
    const known = new Set(['loading', 'ready', 'off', 'stale', 'offline', 'failed']);
    for (const kind of ['server', 'offline', 'forbidden'] as const) {
      for (const hasData of [true, false]) {
        expect(known.has(shopStatusForFailure(kind, hasData))).toBe(true);
      }
    }
  });
});
