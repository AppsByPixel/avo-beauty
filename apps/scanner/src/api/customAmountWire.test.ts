/**
 * What the scanner puts on the wire for a typed price, and what it reads back.
 *
 * Two halves, and they fail for different reasons:
 *
 *   THE REQUEST   `POST /charges` refuses `serviceIds` and `amountFils` together
 *                 with `400 ambiguous_pricing`. This asserts the scanner cannot
 *                 send both — not because it checks, but because `ChargePricing`
 *                 is a discriminated union and there is no value of it that
 *                 carries both keys.
 *
 *   THE RESPONSE  `GET /charges` items carry `customAmount` and `note`.
 *                 `TransactionSchema` declares the first and DELIBERATELY not the
 *                 second — `note` is a merchant-route key that also carries void
 *                 reasons and owner adjustment text — so the row schema is
 *                 widened HERE, on the route that actually sends it, rather than
 *                 in trunk-owned `packages/types`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fils } from '@avo/types';
import { ApiError } from './client';
import { charge, ChargeRowSchema, fetchTodaysCharges } from './charges';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function stub(respond: () => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body === undefined ? {} : (JSON.parse(String(init.body)) as Record<string, unknown>),
    });
    return Promise.resolve(respond());
  });
  return calls;
}

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A real `POST /charges` 200, with the typed-price row. */
const CHARGED = {
  transaction: {
    id: 'TX-9900001',
    memberId: '8842',
    branchId: 'BR-KWC',
    kind: 'charge',
    amountFils: -18_500,
    bonusFils: 0,
    method: 'wallet',
    status: 'settled',
    reference: 'AVO-CHG-9900001',
    createdAt: '2026-09-14T10:20:31.000Z',
    customAmount: true,
    voidedAt: null,
    reversedByTransactionId: null,
  },
  balanceAfterFils: 6_000,
  depositAppliedFils: 0,
  depositReturnedFils: 0,
  bookingId: null,
  loyalty: { mode: 'tiers', visits: 3, tier: 'bronze', nextTier: 'silver', visitsToNext: 2 },
  voidableUntil: '2026-09-14T10:35:31.000Z',
  happyHour: null,
};

// ─────────────────────────────────────────────────────────────── the request ──

describe('a typed price on the wire', () => {
  it('sends amountFils and reason, and no serviceIds at all', async () => {
    const calls = stub(() => json(CHARGED));
    await charge(
      {
        memberId: '8842',
        pricing: { kind: 'custom', amountFils: fils(18_500), reason: 'Bridal trial' },
      },
      'scn-key-1',
      'tok',
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({
      memberId: '8842',
      amountFils: 18_500,
      reason: 'Bridal trial',
    });
    /**
     * The half that produces `400 ambiguous_pricing`. Absent, not empty: the
     * server gates on `body.serviceIds !== undefined`, so `serviceIds: []`
     * alongside `amountFils` would be refused exactly as if a basket had been
     * sent.
     */
    expect(calls[0]?.body).not.toHaveProperty('serviceIds');
  });

  it('still sends the basket shape when nothing was typed', async () => {
    const calls = stub(() => json(CHARGED));
    await charge(
      { memberId: '8842', pricing: { kind: 'basket', serviceIds: ['SV-01'] }, token: 'tok_x' },
      'scn-key-2',
      'tok',
    );
    expect(calls[0]?.body).toEqual({ memberId: '8842', serviceIds: ['SV-01'], token: 'tok_x' });
    expect(calls[0]?.body).not.toHaveProperty('amountFils');
  });

  it('carries the idempotency key, because a typed price is money moving (#4)', async () => {
    const calls = stub(() => json(CHARGED));
    await charge(
      {
        memberId: '8842',
        pricing: { kind: 'custom', amountFils: fils(25_000), reason: 'Colour correction' },
      },
      'scn-key-3',
      'tok',
    );
    expect(calls[0]?.headers['idempotency-key']).toBe('scn-key-3');
  });

  /**
   * The amount is a branded `Fils` all the way to `JSON.stringify`, so the
   * integer that lands in the body is the integer the parser produced. Nothing
   * between the keyboard and the wire multiplies anything.
   */
  it('puts a whole number of fils in the body', async () => {
    const calls = stub(() => json(CHARGED));
    await charge(
      { memberId: '8842', pricing: { kind: 'custom', amountFils: fils(1_005), reason: 'Touch-up' } },
      'scn-key-4',
      'tok',
    );
    expect(Number.isInteger(calls[0]?.body['amountFils'])).toBe(true);
    expect(calls[0]?.body['amountFils']).toBe(1_005);
  });

  it('surfaces the 403 with its code intact so the screen can render it', async () => {
    stub(() =>
      json(
        {
          error: 'forbidden',
          message: "You don't have permission to void a charge. A manager can grant it.",
        },
        403,
      ),
    );
    const err = await charge(
      { memberId: '8842', pricing: { kind: 'custom', amountFils: fils(18_500), reason: 'Trial' } },
      'scn-key-5',
      'tok',
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
    expect((err as ApiError).message).toBe(
      "You don't have permission to void a charge. A manager can grant it.",
    );
  });

  it('surfaces the 422 reused key rather than collapsing it into a server error', async () => {
    stub(() =>
      json(
        {
          error: 'idempotency_key_reused',
          message: 'That Idempotency-Key was already used for a different request. Use a new key.',
        },
        422,
      ),
    );
    const err = await charge(
      { memberId: '8842', pricing: { kind: 'custom', amountFils: fils(25_000), reason: 'Trial' } },
      'scn-key-6',
      'tok',
    ).catch((e: unknown) => e);

    expect((err as ApiError).code).toBe('idempotency_key_reused');
    expect((err as ApiError).status).toBe(422);
  });

  it('surfaces the ceiling refusal with the server details attached', async () => {
    stub(() =>
      json(
        {
          error: 'amount_above_ceiling',
          message:
            'A custom amount cannot exceed 200.000 KD. Check the figure — 250.000 KD looks like a typing mistake.',
          maxFils: 200_000,
          amountFils: 250_000,
        },
        400,
      ),
    );
    const err = await charge(
      { memberId: '8842', pricing: { kind: 'custom', amountFils: fils(250_000), reason: 'Trial' } },
      'scn-key-7',
      'tok',
    ).catch((e: unknown) => e);

    expect((err as ApiError).code).toBe('amount_above_ceiling');
    expect((err as ApiError).details['maxFils']).toBe(200_000);
  });
});

// ────────────────────────────────────────────────────────────── the response ──

const ROW = {
  id: 'TX-9900001',
  memberId: '8842',
  branchId: 'BR-KWC',
  kind: 'charge',
  amountFils: -18_500,
  bonusFils: 0,
  method: 'wallet',
  status: 'settled',
  reference: 'AVO-CHG-9900001',
  createdAt: '2026-09-14T10:20:31.000Z',
  customAmount: true,
  note: 'Bridal trial',
  voidedAt: null,
  reversedByTransactionId: null,
};

describe("today's charges keeps the two fields that say a price was typed", () => {
  it('parses customAmount and note off the row', () => {
    const parsed = ChargeRowSchema.safeParse(ROW);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.customAmount).toBe(true);
    expect(parsed.data.note).toBe('Bridal trial');
  });

  /**
   * `note` SURVIVES THE PARSE, which is the whole reason this schema exists.
   * Zod strips an undeclared key rather than failing on it — the drift that has
   * already eaten `voidedAt`, `depositReturnedFils` and `bookingId` on this
   * surface. Parsing the row with the bare `TransactionSchema` would drop the
   * reason silently and the screen would have nothing to show.
   */
  it('does not strip the reason the way a bare Transaction would', () => {
    const parsed = ChargeRowSchema.parse(ROW);
    expect(Object.keys(parsed)).toContain('note');
  });

  it('accepts a menu charge, where both are the negative statement', () => {
    const parsed = ChargeRowSchema.safeParse({ ...ROW, customAmount: false, note: null });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.customAmount).toBe(false);
    expect(parsed.data.note).toBeNull();
  });

  it('refuses a row that omits note rather than guessing null', () => {
    const { note: _dropped, ...without } = ROW;
    expect(ChargeRowSchema.safeParse(without).success).toBe(false);
  });

  it('reads a list through fetchTodaysCharges with the reason intact', async () => {
    stub(() => json({ items: [ROW], nextCursor: null }));
    const rows = await fetchTodaysCharges('tok');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.customAmount).toBe(true);
    expect(rows[0]?.note).toBe('Bridal trial');
  });
});
