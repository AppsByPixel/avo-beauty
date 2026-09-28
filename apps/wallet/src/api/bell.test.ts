/**
 * The bell's boundary — what parses, what fails, and what goes on the wire.
 *
 * `FEED_200` is a REAL response, captured from `GET /members/me/notifications/feed`
 * on avo_lane_b (2026-09-28) after one card-paid shop order: the two receipts
 * the order writes, stamped to the same millisecond. The other kinds are built
 * to `serialiseReceiptItem`'s shape (api/src/services/memberNotifications.ts),
 * which is the only writer of them.
 *
 * THE LOAD-BEARING CASE IS "A MALFORMED BODY IS A FAILED READ". A bell that
 * rendered "You're all caught up" over a body it could not read would be a false
 * statement about her money; so a contract violation must surface as
 * `ApiError('server')`, which the sheet draws as its error state.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './client';
import { BellFeedSchema, getBellFeed, markBellAllRead, markBellRead } from './bell';

const FEED_200 = {
  items: [
    {
      id: 'TX-10000000',
      transactionId: 'TX-10000000',
      createdAt: '2026-09-28T08:38:18.990Z',
      readAt: null,
      kind: 'topup',
      amountFils: 8500,
      bonusFils: 850,
      creditFils: 9350,
      method: 'knet',
    },
    {
      id: 'TX-10000001',
      transactionId: 'TX-10000001',
      createdAt: '2026-09-28T08:38:18.990Z',
      readAt: null,
      kind: 'shop',
      amountFils: 8500,
      items: [{ name: 'Argan hair oil 100ml', qty: 1 }],
      fulfilment: 'pickup',
    },
  ],
  nextCursor: null,
  unreadCount: 2,
  visibleKinds: ['topup', 'charge', 'shop', 'deposit_hold', 'deposit_return', 'campaign'],
};

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function stub(respond: () => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return Promise.resolve(respond());
  });
  return calls;
}

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('GET /members/me/notifications/feed', () => {
  it('parses the captured response, and asks the BARE path — /v1 is a 404 there', async () => {
    const calls = stub(() => json(FEED_200));
    const feed = await getBellFeed(null);
    expect(new URL(calls[0]!.url).pathname).toBe('/members/me/notifications/feed');
    expect(feed.items.map((i) => i.kind)).toEqual(['topup', 'shop']);
    expect(feed.unreadCount).toBe(2);
  });

  it('passes the cursor back untouched', async () => {
    const calls = stub(() => json({ ...FEED_200, items: [] }));
    await getBellFeed('eyJhdCI6IjIwMjYifQ==');
    expect(new URL(calls[0]!.url).searchParams.get('cursor')).toBe('eyJhdCI6IjIwMjYifQ==');
  });

  describe('a malformed body is a FAILED READ, never an empty bell', () => {
    const broken: Array<[string, unknown]> = [
      ['a float where fils go', { ...FEED_200, items: [{ ...FEED_200.items[0], amountFils: 8.5 }] }],
      ['a known kind missing a field', { ...FEED_200, items: [{ ...FEED_200.items[1], items: undefined }] }],
      ['an item with no id', { ...FEED_200, items: [{ ...FEED_200.items[0], id: undefined }] }],
      ['no unreadCount', { ...FEED_200, unreadCount: undefined }],
      ['items is not an array', { ...FEED_200, items: {} }],
      ['a negative magnitude', { ...FEED_200, items: [{ ...FEED_200.items[0], creditFils: -1 }] }],
    ];
    it.each(broken)('%s → ApiError(server)', async (_name, body) => {
      stub(() => json(body));
      const err = await getBellFeed(null).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).kind).toBe('server');
    });
  });

  it('a kind this build has never heard of parses as `unknown` — it does not fail the read', () => {
    const parsed = BellFeedSchema.parse({
      ...FEED_200,
      items: [
        { id: 'LE-1', kind: 'tier_climb', createdAt: '2026-09-28T09:00:00.000Z', readAt: null, tier: 'gold' },
        FEED_200.items[0],
      ],
    });
    expect(parsed.items[0]).toEqual({
      id: 'LE-1',
      kind: 'unknown',
      serverKind: 'tier_climb',
      createdAt: '2026-09-28T09:00:00.000Z',
      readAt: null,
    });
    expect(parsed.items[1]!.kind).toBe('topup');
  });

  it('but an unknown kind still needs its envelope — no id is malformed, not unknown', () => {
    expect(
      BellFeedSchema.safeParse({
        ...FEED_200,
        items: [{ kind: 'tier_climb', createdAt: '2026-09-28T09:00:00.000Z', readAt: null }],
      }).success,
    ).toBe(false);
  });

  it('visibleKinds drops a kind it does not know rather than refusing the feed', () => {
    const parsed = BellFeedSchema.parse({ ...FEED_200, visibleKinds: ['topup', 'tier_climb'] });
    expect(parsed.visibleKinds).toEqual(['topup']);
  });
});

describe('POST /members/me/notifications/read', () => {
  it('markBellRead sends { ids } and never { all }', async () => {
    const calls = stub(() => json({ marked: 2, unreadCount: 0 }));
    const r = await markBellRead(['TX-10000001', 'TX-10000000']);
    expect(calls[0]!.method).toBe('POST');
    expect(new URL(calls[0]!.url).pathname).toBe('/members/me/notifications/read');
    expect(calls[0]!.body).toEqual({ ids: ['TX-10000001', 'TX-10000000'] });
    expect(r).toEqual({ marked: 2, unreadCount: 0 });
  });

  it('markBellAllRead is the only door that sends { all: true }', async () => {
    const calls = stub(() => json({ marked: 5, unreadCount: 0 }));
    await markBellAllRead();
    expect(calls[0]!.body).toEqual({ all: true });
  });
});
