/**
 * The spec for `toLoadFailure` — and specifically for the field the Shop screen
 * used to throw away.
 *
 * THE DEFECT THIS FILE PINS. `useShop` stored only the reference on a failed
 * catalogue load, so `ShopScreen` passed a literal `kind="server"` to
 * `FailureScreen`. `FailureScreen` branches on exactly one thing —
 * `canRetry = kind !== 'forbidden'` — so a 403 rendered "We couldn't load your
 * wallet" plus a Try again button that could only ever fail again. That is the
 * defect the component's own header warns about, arriving through the state layer
 * rather than through the component.
 *
 * `classify()` in `api/client.ts` is the source of the three kinds: 401/403 →
 * `forbidden`, 503/504 → `offline`, everything else → `server`. These tests build
 * `ApiError` directly with the kind `classify` would have produced, so they pin
 * the reduction rather than re-testing the classifier.
 */

import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { NO_REFERENCE, toLoadFailure } from './loadFailure';

describe('a refusal the customer cannot retry away', () => {
  it('keeps `forbidden` as itself — the field that suppresses the retry button', () => {
    const err = new ApiError(
      'forbidden',
      'This wallet belongs to another salon.',
      'WLT-4412-8890',
      403,
      'forbidden',
    );
    const failure = toLoadFailure(err);
    // The whole point: NOT flattened to 'server'.
    expect(failure.kind).toBe('forbidden');
    expect(failure.kind).not.toBe('server');
  });

  it("carries the server's own sentence, which is the only copy shown on that branch", () => {
    const err = new ApiError('forbidden', 'This wallet belongs to another salon.', 'WLT-1-1', 403);
    expect(toLoadFailure(err).message).toBe('This wallet belongs to another salon.');
  });
});

describe('the other two kinds survive the reduction', () => {
  it('keeps `offline` distinct from `server` — a 503 is not our fault', () => {
    const err = new ApiError('offline', 'Service unavailable.', 'WLT-7000-1000', 503);
    expect(toLoadFailure(err).kind).toBe('offline');
  });

  it('keeps `server` and its reference for support to quote', () => {
    const err = new ApiError('server', 'Something went wrong.', 'WLT-5502-9917', 500);
    const failure = toLoadFailure(err);
    expect(failure.kind).toBe('server');
    expect(failure.reference).toBe('WLT-5502-9917');
  });

  it("passes the API's error code through for callers that branch on it", () => {
    const err = new ApiError('server', 'No.', 'WLT-2-2', 409, 'shop_not_enabled');
    expect(toLoadFailure(err).code).toBe('shop_not_enabled');
  });
});

describe('a thrown value that is not an ApiError', () => {
  it('is ours, so it is `server` — the kind that offers a retry', () => {
    // A zod parse failure on a malformed payload arrives here as a TypeError.
    expect(toLoadFailure(new TypeError('x.map is not a function')).kind).toBe('server');
  });

  it('gets a real-looking reference rather than an empty string', () => {
    // The failure screen renders "Reference · " + this either way.
    const failure = toLoadFailure(new Error('boom'));
    expect(failure.reference).toBe(NO_REFERENCE);
    expect(failure.reference).not.toBe('');
  });

  it('never throws, whatever it is handed — it runs inside a catch', () => {
    for (const thrown of [null, undefined, 0, '', { kind: 'forbidden' }, []]) {
      expect(() => toLoadFailure(thrown)).not.toThrow();
      // A bare object claiming to be forbidden must NOT be believed.
      expect(toLoadFailure(thrown).kind).toBe('server');
    }
  });
});
