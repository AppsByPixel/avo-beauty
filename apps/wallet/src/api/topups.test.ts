/**
 * The two top-up endpoints, parsed against what the API actually sends.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THIS FILE EXISTS BECAUSE THE WALLET COULD NOT TAKE MONEY AT ALL.
 *
 * `POST /topups` answered 200 with a valid intent and the sheet showed
 * "We couldn't start that top-up — Nothing was charged." Every single time, for
 * every amount, on every rail. The server was right and the client threw the
 * answer away: `createTopUp` parsed with `TopUpIntentSchema`, which REQUIRES
 * `feeFils`, and the customer endpoints deliberately serialise
 * `TopUpIntentPublicSchema` — the same schema minus `feeFils`, because the
 * commission is merchant-visible and customer-never (api-contract.md
 * § Commission, and `serialiseIntentForCustomer` in api/src/services/topup.ts).
 *
 * A required field the wire will never send is not a strict schema, it is a
 * closed door. `zod` threw, `client.ts` turned the throw into
 * `ApiError('server', …)`, and the sheet showed its generic failure — which is
 * why this presented as a mystery rather than a contract drift.
 *
 * `shop.test.ts` already guards the identical drift on the transaction shape
 * ("it does not expect an `active` flag the route never sends", and an explicit
 * `not.toHaveProperty('feeFils')`). Top-ups had no such test, so the drift lived
 * on the one path by which money enters the product.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * The fixtures below are REAL responses, captured from avo_lane_b with the API
 * on :4180 and the seeded Silver member 8842. Nothing is hand-written, and in
 * particular nothing has had `feeFils` helpfully added to it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { TopUpIntentPublicSchema, TopUpIntentSchema, fils } from '@avo/types';
import { ApiError } from './client';
import { createTopUp, getTopUp } from './topups';

/**
 * A real `POST /topups` 200. 10.000 KD on Silver: +10% = 1.000 bonus,
 * 11.000 lands. Ten keys, and `feeFils` is not one of them.
 */
const TOPUP_200 = {
  id: 'TI-WQJTHJ',
  memberId: '8842',
  amountFils: 10000,
  bonusFils: 1000,
  creditFils: 11000,
  method: 'knet',
  status: 'redirected',
  failureReason: null,
  redirectUrl:
    'http://localhost:4180/_gateway/SBX-2B3901429B33?return=avo%3A%2F%2Ftopup%2Freturn%3Fintent%3DTI-WQJTHJ',
  reference: 'AVO-TOP-WQJTHJ',
} as const;

/** The same intent from `GET /topups/{id}` once the sandbox had settled it. */
const TOPUP_GET_200 = { ...TOPUP_200, status: 'succeeded' } as const;

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
}

function stub(respond: (path: string) => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    (url: string, init: RequestInit = {}) => {
      calls.push({
        url,
        method: init.method ?? 'GET',
        headers: (init.headers ?? {}) as Record<string, string>,
      });
      return Promise.resolve(respond(new URL(url).pathname));
    },
  );
  return calls;
}

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
});

// ------------------------------------------------------------- the schemas --

describe('the shape the customer endpoints actually send', () => {
  /**
   * The failing assertion, stated as plainly as it can be: the schema the wallet
   * parses with must accept the bytes the API emits.
   */
  it('parses a real POST /topups 200 — the wire has no feeFils', () => {
    const parsed = TopUpIntentPublicSchema.safeParse(TOPUP_200);
    expect(parsed.success).toBe(true);
  });

  it('the merchant schema REFUSES that same real response, which is the bug', () => {
    // Not a curiosity — this is what ran in the app. Kept as an assertion so
    // that anyone tempted to "tighten" the wallet back onto the merchant schema
    // sees the consequence spelled out.
    expect(TopUpIntentSchema.safeParse(TOPUP_200).success).toBe(false);
  });

  it("the intent's key set is the wire's, with no phantom field", () => {
    const parsed = TopUpIntentPublicSchema.parse(TOPUP_200);
    expect(Object.keys(parsed).sort()).toEqual([
      'amountFils',
      'bonusFils',
      'creditFils',
      'failureReason',
      'id',
      'memberId',
      'method',
      'redirectUrl',
      'reference',
      'status',
    ]);
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(TOPUP_200).sort());
    // Non-negotiable: the commission is customer-never. If it ever appears on
    // this response the wallet must fail here, not render it.
    expect(TOPUP_200).not.toHaveProperty('feeFils');
  });

  it('refuses a float anywhere money lives — money is integer fils', () => {
    for (const bad of [
      { amountFils: 10000.5 },
      { bonusFils: 1000.5 },
      { creditFils: 11000.5 },
    ]) {
      expect(TopUpIntentPublicSchema.safeParse({ ...TOPUP_200, ...bad }).success).toBe(false);
    }
  });
});

// ----------------------------------------------------------------- the calls --

describe('createTopUp', () => {
  it('returns the intent the server issued rather than failing the parse', async () => {
    stub(() => json(TOPUP_200));
    const intent = await createTopUp({
      amountFils: fils(10000),
      method: 'knet',
      idempotencyKey: 'wlt-test-key',
    });
    expect(intent.id).toBe('TI-WQJTHJ');
    expect(intent.creditFils).toBe(11000);
    expect(intent.redirectUrl).toContain('/_gateway/');
  });

  it('sends the idempotency key on the money-moving POST — non-negotiable #4', async () => {
    const calls = stub(() => json(TOPUP_200));
    await createTopUp({
      amountFils: fils(10000),
      method: 'knet',
      idempotencyKey: 'wlt-test-key',
    });
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers['idempotency-key']).toBe('wlt-test-key');
  });

  /**
   * The failure this file was written under, reproduced end to end: a 200 body
   * the schema cannot read becomes `ApiError('server')`, which `useTopUp` turns
   * into `quoteFailed` — "We couldn't start that top-up". Asserting the shape of
   * the failure keeps the diagnosis attached to the symptom.
   */
  it('a body the schema cannot read is a server failure, not a silent undefined', async () => {
    stub(() => json({ ...TOPUP_200, creditFils: 'eleven thousand' }));
    await expect(
      createTopUp({ amountFils: fils(10000), method: 'knet', idempotencyKey: 'k' }),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe('getTopUp', () => {
  it('reads the authoritative status off a real GET /topups/{id}', async () => {
    stub(() => json(TOPUP_GET_200));
    const intent = await getTopUp('TI-WQJTHJ');
    expect(intent.status).toBe('succeeded');
  });

  it('percent-encodes the id rather than pasting it into the path', async () => {
    const calls = stub(() => json(TOPUP_GET_200));
    await getTopUp('TI-A/B');
    expect(calls[0]?.url).toContain('/topups/TI-A%2FB');
  });
});
