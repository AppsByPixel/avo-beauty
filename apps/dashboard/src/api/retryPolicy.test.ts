import { describe, expect, it } from 'vitest';
import { ApiError } from './client.js';
import { RETRY_BUDGET, retryPolicy } from './retryPolicy.js';

const api = (status: number, opts: { offline?: boolean } = {}) =>
  new ApiError(`status ${status}`, { status, code: 'test', ...opts });

/**
 * The two refusals must cost ZERO extra requests.
 *
 * This is the regression the seven `retry: 1` overrides caused: a bare number
 * sets the budget and silently re-enables retrying a 403, so a permission
 * refusal — a NORMAL response on this dashboard under non-negotiable #7 — made
 * the merchant wait out a second round trip before being told she lacks access.
 * Asserted at `failureCount: 0`, which is the call that decides whether a second
 * request happens at all.
 */
describe('retryPolicy — a refusal is never retried', () => {
  it('does not retry a 403, on the very first failure', () => {
    expect(retryPolicy(0, api(403))).toBe(false);
  });

  it('does not retry a 401, on the very first failure', () => {
    // authedRequest has already rotated the token and dropped the session by
    // now; a retry here races the shell's redirect to sign-in with nothing new
    // to send.
    expect(retryPolicy(0, api(401))).toBe(false);
  });

  it('stays false for a refusal at every failure count', () => {
    for (const count of [0, 1, 2, 5, 50]) {
      expect(retryPolicy(count, api(403))).toBe(false);
      expect(retryPolicy(count, api(401))).toBe(false);
    }
  });
});

/**
 * The other half of what the overrides were buying: a budget small enough that a
 * failure surfaces in about two seconds rather than five. Boundaries only — the
 * off-by-one here is the difference between the measured behaviour and the
 * default three-retries-with-backoff that made Settings look like it saved.
 */
describe('retryPolicy — the budget, at its edges', () => {
  it('is one retry: allowed at 0, refused at 1', () => {
    expect(RETRY_BUDGET).toBe(1);
    expect(retryPolicy(0, api(500))).toBe(true);
    expect(retryPolicy(1, api(500))).toBe(false);
  });

  it('retries the failures a second attempt can actually fix', () => {
    // 5xx, a dead connection, and the offline classification — the reason the
    // budget is not zero.
    expect(retryPolicy(0, api(500))).toBe(true);
    expect(retryPolicy(0, api(503))).toBe(true);
    expect(retryPolicy(0, api(0, { offline: true }))).toBe(true);
  });

  it('spends the budget on a non-ApiError too, rather than treating it as final', () => {
    // A thrown TypeError or an aborted fetch has no status. Retrying once is the
    // safe reading: an unknown failure is more likely transient than a refusal.
    expect(retryPolicy(0, new TypeError('boom'))).toBe(true);
    expect(retryPolicy(1, new TypeError('boom'))).toBe(false);
    expect(retryPolicy(0, undefined)).toBe(true);
  });
});

/**
 * Not widened to every 4xx on purpose, and pinned so the decision is visible
 * rather than implicit. A 400/404/409 is equally unretryable in principle, but
 * nothing in this dashboard reaches one on a READ today, and changing behaviour
 * for statuses nobody has driven would be inventing policy. If a read starts
 * returning one of these, this test is the place the choice gets revisited.
 */
describe('retryPolicy — the deliberate scope limit', () => {
  it.each([400, 404, 409, 422])('still spends the budget on a %i', (status) => {
    expect(retryPolicy(0, api(status))).toBe(true);
  });
});
