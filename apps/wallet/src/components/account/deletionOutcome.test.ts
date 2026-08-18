/**
 * The delete sheet's five outcomes, which must stay five and not become one.
 *
 * Each case below is a response this lane drove against the real API on a
 * throwaway database (`avo_lane_b`) before it was written down here, so the
 * statuses, codes, messages and the shape of `details` are transcribed rather
 * than imagined:
 *
 *   POST   wrong password        401 invalid_credentials  "That password does not match."
 *   POST   balance 31.750        409 balance_outstanding  details.balanceFils = 31750
 *   POST   balance 0             200 status=pending       graceDays = 30
 *   DELETE pending               200 status=none
 *   DELETE nothing pending       404 no_deletion_request
 */

import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/client';
import {
  deletionSubmitFailure,
  isAlreadyCancelled,
  BALANCE_OUTSTANDING,
  NO_DELETION_REQUEST,
} from './deletionOutcome';

const FALLBACK = 'Something went wrong. Please try again.';

/** The 401 the API returns for a password that does not match. */
function unauthorised() {
  return new ApiError(
    'forbidden',
    'That password does not match.',
    'WLT-1000-1000',
    401,
    'invalid_credentials',
    {},
  );
}

/** The 409 the API returns while she still holds credit. */
function balanceOutstanding(balanceFils: number) {
  return new ApiError(
    'server',
    'You still have credit in your wallet.',
    'WLT-2000-2000',
    409,
    BALANCE_OUTSTANDING,
    { balanceFils },
  );
}

/** The 404 the API returns when there is nothing pending to cancel. */
function noDeletionRequest() {
  return new ApiError(
    'server',
    'There is no deletion request to cancel.',
    'WLT-3000-3000',
    404,
    NO_DELETION_REQUEST,
    {},
  );
}

describe('the wrong password (401)', () => {
  it("shows the server's sentence, so she knows to retype rather than give up", () => {
    const outcome = deletionSubmitFailure(unauthorised(), FALLBACK);
    expect(outcome.message).toBe('That password does not match.');
    expect(outcome.message).not.toBe(FALLBACK);
  });

  it('changes nothing else on screen — no clock started, no balance correction', () => {
    // `serverBalanceFils` staying null is what leaves the balance card showing
    // the prop. A 401 must not repaint the figure.
    expect(deletionSubmitFailure(unauthorised(), FALLBACK).serverBalanceFils).toBeNull();
  });

  it('is not mistaken for an already-cancelled deletion', () => {
    expect(isAlreadyCancelled(unauthorised())).toBe(false);
  });
});

describe('the outstanding balance (409)', () => {
  it("takes the balance from the SERVER, not from the prop the sheet opened with", () => {
    // The exact case driven in the browser: the sheet was opened showing 24.500
    // (a stale prop) while the server held 31.750.
    const outcome = deletionSubmitFailure(balanceOutstanding(31750), FALLBACK);
    expect(outcome.serverBalanceFils).toBe(31750);
    expect(outcome.message).toBe('You still have credit in your wallet.');
  });

  it('reads integer fils, and refuses a float rather than rounding it into a sentence', () => {
    // Non-negotiable #1. A float here is a broken contract upstream; falling
    // back to the prop is honest, formatting 24.5001 as money is not.
    expect(deletionSubmitFailure(balanceOutstanding(24.5), FALLBACK).serverBalanceFils).toBeNull();
  });

  it('refuses a missing or non-numeric balance instead of showing NaN', () => {
    const missing = new ApiError('server', 'msg', 'WLT-0-0', 409, BALANCE_OUTSTANDING, {});
    expect(deletionSubmitFailure(missing, FALLBACK).serverBalanceFils).toBeNull();

    const stringy = new ApiError('server', 'msg', 'WLT-0-0', 409, BALANCE_OUTSTANDING, {
      balanceFils: '31750',
    });
    expect(deletionSubmitFailure(stringy, FALLBACK).serverBalanceFils).toBeNull();
  });

  it('accepts a zero balance as a real figure, not as absent', () => {
    // 0 is falsy, so a truthiness check here would silently fall back to the
    // prop and show her credit she no longer has.
    expect(deletionSubmitFailure(balanceOutstanding(0), FALLBACK).serverBalanceFils).toBe(0);
  });

  it('does not correct the balance on any other code', () => {
    // Only the code that carries the figure may repaint it.
    const other = new ApiError('server', 'msg', 'WLT-0-0', 409, 'some_other_conflict', {
      balanceFils: 99999,
    });
    expect(deletionSubmitFailure(other, FALLBACK).serverBalanceFils).toBeNull();
  });
});

describe('the cancel door', () => {
  it('treats 404 no_deletion_request as already cancelled, not as an error', () => {
    expect(isAlreadyCancelled(noDeletionRequest())).toBe(true);
  });

  it('does NOT treat a 500 as already cancelled', () => {
    // The lie this sheet cannot afford: telling her the clock stopped when it
    // is still running.
    const boom = new ApiError('server', 'Something went wrong.', 'WLT-0-0', 500, 'internal', {});
    expect(isAlreadyCancelled(boom)).toBe(false);
  });

  it('does not treat an offline failure as already cancelled', () => {
    const offline = new ApiError('offline', 'No connection.', 'WLT-0-0', null, null, {});
    expect(isAlreadyCancelled(offline)).toBe(false);
  });
});

describe('a failure that is not from the API at all', () => {
  it('falls back to the screen copy rather than leaking an internal message', () => {
    const outcome = deletionSubmitFailure(new TypeError('x is not a function'), FALLBACK);
    expect(outcome.message).toBe(FALLBACK);
    expect(outcome.serverBalanceFils).toBeNull();
  });

  it('is not already-cancelled', () => {
    expect(isAlreadyCancelled(new TypeError('boom'))).toBe(false);
    expect(isAlreadyCancelled(null)).toBe(false);
    expect(isAlreadyCancelled(undefined)).toBe(false);
  });
});
