/**
 * The refused checkout, and the race that motivated it.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE RETIRED-PRODUCT RACE, DRIVEN AGAINST THE REAL API BEFORE IT WAS WRITTEN.
 *
 * A product retired between the catalogue fetch and the order. Driven on
 * `avo_lane_b` against the real `POST /orders` on 4100, in this order:
 *
 *   1. `GET /salons/SAL-AMARA/products` → PR-01, PR-02, PR-03, all live.
 *   2. `UPDATE product SET active=false WHERE id='PR-01'` — the race window.
 *   3. `POST /orders {PR-01:1, PR-03:2}` → 400
 *      `{"error":"invalid_products",
 *        "message":"Unknown or unavailable product: PR-01.",
 *        "unknown":["PR-01"]}`
 *   4. `member.balance_fils` still 24500, `transaction` still 0 rows,
 *      `shop_order_line` still 0 rows. NOTHING happened.
 *
 * Every literal below comes from that run. The bodies are the captured wire, not
 * a plausible reconstruction — four contract drifts in this project were a schema
 * narrower than the wire, and one of them made a *successful* charge unparseable.
 *
 * WHY THE WHOLE ORDER IS REFUSED AND NOT THE VALID PART: step 3's cart also held
 * a live PR-03 and it was not charged. That is correct and it is what makes the
 * "take it out of your cart" sentence the right one — the server prices the
 * basket in one query and refuses the basket, so her recovery is to remove one
 * line, not to discover afterwards that she bought half of it.
 *
 * AND THE RECOVERY, ALSO DRIVEN: with PR-01 removed, `{PR-03:2}` settled 201 for
 * 13500 against a balance that went 24500 → 11000, exactly one `shop` transaction
 * row. So the refusal in step 3 genuinely left the key and the money untouched.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { describe, expect, it } from 'vitest';
import { fils } from '@avo/types';
import { ApiError } from '../api/client';
import { INVALID_PRODUCTS, orderRefusal } from './orderRefusal';

/**
 * The captured 400 from step 3, rebuilt the way `client.ts` builds it.
 *
 * `client.ts` does `const { error, message, ...details } = body`, so the wire's
 * TOP-LEVEL `unknown` becomes `details.unknown`. That indirection is the thing
 * most likely to be got wrong by reading the route instead of the wire, so it is
 * reproduced here rather than assumed.
 */
function invalidProducts(unknown: unknown): ApiError {
  return new ApiError(
    'server',
    'Unknown or unavailable product: PR-01.',
    'WLT-4821-7734',
    400,
    INVALID_PRODUCTS,
    { unknown },
  );
}

// ------------------------------------------------------ the retired product ----

describe('a product retired between the catalogue fetch and the order', () => {
  it('is a stale refusal that NAMES the product, not a generic failure', () => {
    const refusal = orderRefusal(invalidProducts(['PR-01']));
    expect(refusal).toEqual({ kind: 'stale', ids: ['PR-01'] });
  });

  /**
   * The sentence has to say WHICH. "Something went wrong" for a product she is
   * holding is the failure this whole state exists to avoid — she cannot act on
   * it, and the one action that helps is removing a specific line.
   */
  it('carries every id the server named, not just the first', () => {
    const refusal = orderRefusal(invalidProducts(['PR-01', 'PR-07']));
    expect(refusal).toEqual({ kind: 'stale', ids: ['PR-01', 'PR-07'] });
  });

  /**
   * A 400 must not be read as a dead connection. `client.ts` maps 503/504 to
   * `offline`, and the check order in `orderRefusal` is what keeps a coded
   * refusal arriving on a 503 from claiming her network is down — the exact
   * collision that once made a signup refusal blame the connection.
   */
  it('stays stale even when the transport kind says offline', () => {
    const err = new ApiError(
      'offline',
      'Unknown or unavailable product: PR-01.',
      'WLT-4821-7734',
      503,
      INVALID_PRODUCTS,
      { unknown: ['PR-01'] },
    );
    expect(orderRefusal(err)).toEqual({ kind: 'stale', ids: ['PR-01'] });
  });

  /**
   * DEGRADES, NEVER THROWS. This runs inside the catch of a money-moving POST: a
   * classifier that threw on a malformed body would replace a refusal she can act
   * on with a blank screen. She is still told something in her cart has gone.
   */
  it('is still a stale refusal when the server names nothing usable', () => {
    for (const bad of [undefined, null, 'PR-01', 42, {}, [1, 2], [null]]) {
      expect(orderRefusal(invalidProducts(bad))).toEqual({ kind: 'stale', ids: [] });
    }
  });

  it('keeps only the strings out of a mixed list', () => {
    expect(orderRefusal(invalidProducts(['PR-01', 7, null, 'PR-02']))).toEqual({
      kind: 'stale',
      ids: ['PR-01', 'PR-02'],
    });
  });
});

// ---------------------------------------------------------- the shortfall ----

describe('the shortfall is the server’s figure', () => {
  /**
   * #2: the server owns the balance and therefore owns the difference. Captured
   * from a real 402 on avo_lane_b — a 12000 PR-02 against an 11000 balance:
   *
   *   {"error":"insufficient_balance","message":"Balance too low.",
   *    "shortfallFils":1000,"balanceFils":11000,"dueFils":12000}
   *
   * All three are sent and the client renders the first, never a subtraction of
   * its own — even though here the subtraction would agree.
   */
  it('reads shortfallFils off the 402 rather than subtracting', () => {
    const err = new ApiError('server', 'Balance too low.', 'WLT-1', 402, 'insufficient_balance', {
      shortfallFils: 1000,
      balanceFils: 11000,
      dueFils: 12000,
    });
    expect(orderRefusal(err)).toEqual({ kind: 'short', shortfallFils: fils(1000) });
  });

  /**
   * A 402 with no figure is NOT a shortfall of zero. "Balance too low by 0.000"
   * is a sentence that cannot be acted on and is worse than the generic failure,
   * so this deliberately falls through.
   */
  it('falls through to failed when the 402 carries no shortfall', () => {
    const err = new ApiError('server', 'Balance too low.', 'WLT-1', 402, 'insufficient_balance');
    expect(orderRefusal(err)).toEqual({ kind: 'failed' });
  });

  it('refuses a float shortfall rather than rendering it — money is integer fils', () => {
    const err = new ApiError('server', 'Balance too low.', 'WLT-1', 402, 'insufficient_balance', {
      shortfallFils: 57500.5,
    });
    expect(() => orderRefusal(err)).toThrow();
  });
});

// ------------------------------------------------ the two with no retry ----

describe('the refusals whose outcome is unknown', () => {
  /**
   * An order has ONE concurrency guard where a charge has two. A client that
   * could not read the response does not know whether the money moved, so these
   * two must stay distinguishable from `short` and `stale` — which the sheet keys
   * its button off.
   */
  it('classifies a genuine connection failure as offline', () => {
    const err = new ApiError('offline', 'No connection.', 'WLT-1', null);
    expect(orderRefusal(err)).toEqual({ kind: 'offline' });
  });

  it('classifies an unmapped coded refusal as failed, not offline', () => {
    const err = new ApiError('server', 'Nope.', 'WLT-1', 409, 'duplicate_product');
    expect(orderRefusal(err)).toEqual({ kind: 'failed' });
  });

  it('classifies a reused idempotency key as failed', () => {
    // Driven: replaying a COMMITTED key with a different body answers 422
    // `idempotency_key_reused`. It is not actionable copy — the cart re-mints the
    // key on every edit, so reaching this is a client bug, not a customer one.
    const err = new ApiError('server', 'Already used.', 'WLT-1', 422, 'idempotency_key_reused');
    expect(orderRefusal(err)).toEqual({ kind: 'failed' });
  });

  /**
   * A schema parse failure is a TypeError, not an ApiError, and it must not
   * escape the classifier — the one drift that made a *successful* charge
   * unparseable arrived exactly this way.
   */
  it('classifies a non-ApiError as failed rather than escaping', () => {
    for (const thrown of [new TypeError('bad parse'), 'string', null, undefined, 0]) {
      expect(orderRefusal(thrown)).toEqual({ kind: 'failed' });
    }
  });
});
