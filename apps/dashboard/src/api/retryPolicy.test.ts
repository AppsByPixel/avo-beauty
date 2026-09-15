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
 * The scope limit, and the one status that has since left it.
 *
 * THIS BLOCK SAID "IF A READ STARTS RETURNING ONE OF THESE, THIS TEST IS THE PLACE
 * THE CHOICE GETS REVISITED", AND ONE DID. `GET /v1/platform/salons/:id` — the
 * owner console's per-salon editor — is the first read in this dashboard that can
 * 404, on the ordinary path of a bookmarked URL or an id pasted from a support
 * ticket. Driven: `404 {"error":"unknown_salon","message":"No such salon."}`.
 *
 * So 404 moved to the refusal side and the rest stayed, which is the outcome this
 * pin was designed to produce: the limit held until there was a real case, and it
 * moved for that case and no further. The test failed on the same commit that gave
 * it one, by name, which is the whole reason it was written as an assertion instead
 * of a paragraph.
 */
describe('retryPolicy — the deliberate scope limit', () => {
  it('does not spend the budget on a 404, now that a read can produce one', () => {
    // The editor holds a full-page skeleton for every attempt, so the budget buys
    // a slow load and then the same answer.
    expect(retryPolicy(0, api(404))).toBe(false);
  });

  it('does not spend the budget on a 400, now that a read can produce one too', () => {
    /*
     * Reports' window controls are the first thing in this dashboard that lets a
     * person compose a malformed READ. Driven against the real API with From
     * after To: five cards, each asking twice, each holding a skeleton through a
     * backoff before showing a sentence the server gave in one round trip —
     * "period starts after it ends: 2026-09-20 is later than 2026-09-16."
     */
    expect(retryPolicy(0, api(400))).toBe(false);
  });

  it.each([409, 422])('still spends the budget on a %i', (status) => {
    // Unretryable in principle and still undriven on a READ in this dashboard.
    // `namedStateAnswer` already treats a served 409 as an answer where one
    // appears. Widening on principle is what this pin exists to prevent.
    expect(retryPolicy(0, api(status))).toBe(true);
  });
});
