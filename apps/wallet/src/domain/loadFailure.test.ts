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
import { failureCopy } from './loadFailure';
import { en } from '../copy/en';
import { ar } from '../copy/ar';
import { ApiError } from '../api/client';
import { failurePresentation, NO_REFERENCE, toLoadFailure } from './loadFailure';

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

/**
 * `FailureKind` has three members and `FailureScreen` branched on one, so
 * `offline` fell through to the `server` copy and told a customer whose phone had
 * no signal that her balance was safe and "This is on our side." Shop and Book
 * both cold-load through that component, so both said it.
 *
 * These pin the pairing rather than the sentences: the function returns copy KEYS
 * so it can be tested without a language, and `copy[key]` resolves them.
 */
describe('what the failure screen draws', () => {
  it('offline gets its OWN sentence, never the "on our side" one', () => {
    const p = failurePresentation('offline');
    expect(p.titleKey).toBe('offlineColdTitle');
    expect(p.bodyKey).toBe('offlineColdBody');
    // The defect, stated as an assertion: it must not borrow the server copy.
    expect(p.bodyKey).not.toBe('errorBody');
    expect(p.titleKey).not.toBe('errorTitle');
  });

  it('offline KEEPS the retry — reconnecting is something she can do', () => {
    expect(failurePresentation('offline').canRetry).toBe(true);
  });

  it('forbidden explains with the SERVER\'s sentence and offers no retry', () => {
    const p = failurePresentation('forbidden');
    expect(p.titleKey).toBe('blockedTitle');
    // null = render the server's own message, which is more specific than ours.
    expect(p.bodyKey).toBeNull();
    expect(p.canRetry).toBe(false);
  });

  it('server is unchanged — our failure, our copy, with a retry', () => {
    expect(failurePresentation('server')).toEqual({
      titleKey: 'errorTitle',
      bodyKey: 'errorBody',
      canRetry: true,
    });
  });

  it('gives all three kinds a distinct title — none shares another\'s', () => {
    const titles = (['forbidden', 'offline', 'server'] as const).map(
      (k) => failurePresentation(k).titleKey,
    );
    expect(new Set(titles).size).toBe(3);
  });

  it('only forbidden withholds the retry', () => {
    const noRetry = (['forbidden', 'offline', 'server'] as const).filter(
      (k) => !failurePresentation(k).canRetry,
    );
    expect(noRetry).toEqual(['forbidden']);
  });
});

/**
 * The end-to-end pairing the two halves of this module make together: a thrown
 * 503 from the wire has to arrive at the screen as the offline sentence.
 */
describe('a 503 from the wire reaches the screen as her connection, not our fault', () => {
  it('classifies and then presents without losing the kind', () => {
    const err = new ApiError('offline', 'Service unavailable.', 'WLT-9-9', 503);
    const presentation = failurePresentation(toLoadFailure(err).kind);
    expect(presentation.bodyKey).toBe('offlineColdBody');
    expect(presentation.canRetry).toBe(true);
  });
});


/**
 * The resolved copy, against the REAL dictionaries.
 *
 * `failurePresentation` is well covered above, and the Upcoming card still
 * shipped the bug — because consulting it was optional and that component did
 * not. These assert the sentences a customer actually reads, so a surface that
 * resolves them by hand is failing a spec rather than passing a key check.
 */
describe('the sentence a failing surface renders', () => {
  const SERVER_MESSAGE = 'This wallet is not available on this account.';

  it('never tells an offline customer the failure is ours', () => {
    for (const copy of [en, ar]) {
      const { title, body } = failureCopy('offline', SERVER_MESSAGE, copy);
      // copy/en.ts § offlineColdTitle: "`errorBody`'s 'This is on our side' is
      // the other wrong answer — it blames us for her signal."
      expect(body).not.toBe(copy.errorBody);
      expect(title).not.toBe(copy.errorTitle);
      expect(body).toBe(copy.offlineColdBody);
      expect(title).toBe(copy.offlineColdTitle);
    }
  });

  it('does not promise a last update on a cold offline failure', () => {
    // `offlineBanner` is the stale-data sentence and would be a lie here.
    for (const copy of [en, ar]) {
      expect(failureCopy('offline', SERVER_MESSAGE, copy).body).not.toBe(copy.offlineBanner);
    }
  });

  it("renders the server's own sentence on forbidden, and ours on the rest", () => {
    for (const copy of [en, ar]) {
      expect(failureCopy('forbidden', SERVER_MESSAGE, copy).body).toBe(SERVER_MESSAGE);
      expect(failureCopy('offline', SERVER_MESSAGE, copy).body).not.toBe(SERVER_MESSAGE);
      expect(failureCopy('server', SERVER_MESSAGE, copy).body).not.toBe(SERVER_MESSAGE);
    }
  });

  it('withholds the retry only where retrying cannot change the answer', () => {
    for (const copy of [en, ar]) {
      expect(failureCopy('forbidden', SERVER_MESSAGE, copy).canRetry).toBe(false);
      expect(failureCopy('offline', SERVER_MESSAGE, copy).canRetry).toBe(true);
      expect(failureCopy('server', SERVER_MESSAGE, copy).canRetry).toBe(true);
    }
  });

  it('gives the three kinds three distinct sentences, in both languages', () => {
    for (const copy of [en, ar]) {
      const bodies = (['forbidden', 'offline', 'server'] as const).map(
        (k) => failureCopy(k, SERVER_MESSAGE, copy).body,
      );
      expect(new Set(bodies).size).toBe(3);
    }
  });

  it('never resolves to an empty string, whatever the kind or language', () => {
    for (const copy of [en, ar]) {
      for (const kind of ['forbidden', 'offline', 'server'] as const) {
        const { title, body } = failureCopy(kind, SERVER_MESSAGE, copy);
        expect(title.trim()).not.toBe('');
        expect(body.trim()).not.toBe('');
      }
    }
  });
});
