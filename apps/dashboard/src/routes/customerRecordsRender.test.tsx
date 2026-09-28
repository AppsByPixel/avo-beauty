// @vitest-environment jsdom

/**
 * MERCHANT → CUSTOMERS → ONE CARD → BOOKINGS AND PURCHASES, DRIVEN.
 *
 * Aftab, 2026-09-29: "On the customer view screen, the bookings and purchases
 * should be displayed". Each panel reads its OWN board filtered to her —
 * `GET /salons/{id}/bookings?memberId=` behind `appointments`,
 * `GET /v1/salons/{id}/orders?memberId=` behind `shop` — so a panel needs `team`
 * (which opened the card) AND its section's permission. Without the second it
 * says so; it does not fail, and it does not take the other panel with it.
 *
 * Driven through the real hooks and the real parsers, `customersRender.test.tsx`'
 * method: `authedRequest` is the only seam, so `OrderBoardSchema` runs on every
 * orders page and the URLs that left are the ones asserted.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client.js';

const authedRequest = vi.fn();
vi.mock('../auth/authedRequest.js', () => ({
  authedRequest: (...args: unknown[]) => authedRequest(...args),
}));
vi.mock('../auth/AuthProvider.js', () => ({ useSalonId: () => 'SAL-AMARA' }));

const salonState: { data: unknown } = {
  data: { timezone: 'Asia/Kuwait', modules: { booking: true, shop: true } },
};
vi.mock('../api/salon.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/salon.js')>()),
  useSalon: () => salonState,
}));

const { Customers, splitBookings } = await import('./Customers.js');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  authedRequest.mockReset();
  salonState.data = { timezone: 'Asia/Kuwait', modules: { booking: true, shop: true } };
});

/* ------------------------------------------------------------------ fixtures */

const LATIFA = {
  id: 'MB-1a2b3c4d5e',
  name: 'Latifa A.',
  memberErased: false,
  memberPhone: '+96599124408',
  tier: 'gold',
  balanceFils: 32500,
  visits: 14,
  joinedAt: '2024-03-04T08:12:00.000Z',
};

const DETAIL = {
  ...LATIFA,
  salonId: 'SAL-AMARA',
  email: 'latifa.a@example.com',
  emailVerified: true,
  stamps: null,
  noShowCount: 0,
};

/** Relative to the real clock, so "upcoming" is upcoming whenever this runs. */
const DAY = 86_400_000;
const at = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString();

function booking(id: string, offsetDays: number, over: Record<string, unknown> = {}) {
  const startsAt = at(offsetDays);
  return {
    id,
    memberId: LATIFA.id,
    guestName: null,
    guestPhone: null,
    artistId: 'AR-1',
    branchId: 'BR-KWC',
    serviceId: 'SV-1',
    startsAt,
    endsAt: startsAt,
    durationMin: 60,
    depositFils: 5000,
    status: 'deposit_held',
    source: 'app',
    changeableUntil: startsAt,
    noShowReturnDueAt: startsAt,
    rescheduledCount: 0,
    calendarSyncState: 'not_applicable',
    branchAssumed: false,
    memberName: 'Latifa A.',
    memberPhone: '+96599124408',
    memberErased: false,
    memberTier: 'gold',
    artistName: 'Noura Al-Rashid',
    serviceName: `Service ${id}`,
    ...over,
  };
}

function order(id: string, over: Record<string, unknown> = {}) {
  return {
    transactionId: id,
    fulfilment: 'pickup',
    status: 'ready',
    address: null,
    pickupBranch: null,
    createdAt: '2026-09-20T10:00:00.000Z',
    readyAt: '2026-09-20T11:00:00.000Z',
    closedAt: null,
    memberName: 'Latifa A.',
    memberPhone: '+96599124408',
    memberErased: false,
    lines: [
      { productId: 'PR-1', name: 'Argan oil', qty: 2, unitPriceFils: 4500, lineTotalFils: 9000 },
      { productId: 'PR-2', name: 'Silk scrunchie', qty: 1, unitPriceFils: 1250, lineTotalFils: 1250 },
    ],
    // What left her wallet — served, not re-summed.
    totalFils: 10250,
    ...over,
  };
}

const board = (items: unknown[], nextCursor: string | null = null) => ({
  items,
  truncated: nextCursor !== null,
  nextCursor,
});

type Answer = unknown | Error | ((path: string) => unknown);

/** Routes by the path's START, so `/customers/{id}` and `/customers/{id}/activity` never collide. */
function serve(answers: { bookings?: Answer; orders?: Answer; card?: Answer }) {
  authedRequest.mockImplementation((_scope: string, path: string) => {
    const pick = (a: Answer | undefined, fallback: unknown) => {
      const v = typeof a === 'function' ? (a as (p: string) => unknown)(path) : (a ?? fallback);
      return v instanceof Error ? Promise.reject(v) : Promise.resolve(v);
    };
    if (path.startsWith('/salons/SAL-AMARA/bookings')) return pick(answers.bookings, { items: [], nextCursor: null });
    if (path.startsWith('/v1/salons/SAL-AMARA/orders')) return pick(answers.orders, board([]));
    if (path.endsWith('/activity')) return Promise.resolve({ items: [], nextCursor: null });
    if (path.startsWith(`/salons/SAL-AMARA/customers/${LATIFA.id}`)) return pick(answers.card, DETAIL);
    if (path.startsWith('/salons/SAL-AMARA/customers')) return Promise.resolve({ items: [LATIFA], nextCursor: null });
    return Promise.reject(new Error(`no fixture for ${path}`));
  });
}

async function openCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  render(<Customers />, { wrapper: Wrapper });
  fireEvent.click(await screen.findByRole('button', { name: 'View' }));
}

const panel = async (title: 'Bookings' | 'Purchases') =>
  (await screen.findByText(title, { selector: 'h3' })).closest('.cust-card__panel') as HTMLElement;

const paths = () => authedRequest.mock.calls.map((c) => c[1] as string);

const forbidden = (message: string) => new ApiError(message, { status: 403, code: 'forbidden' });

/* --------------------------------------------------------------- bookings -- */

describe('the Bookings panel', () => {
  it('asks her own bookings of the appointments board, by memberId', async () => {
    serve({ bookings: { items: [booking('BK-1', 2)], nextCursor: null } });
    await openCard();
    await within(await panel('Bookings')).findByText('Service BK-1 · Noura Al-Rashid');
    expect(paths()).toContain(`/salons/SAL-AMARA/bookings?memberId=${LATIFA.id}`);
  });

  it('puts upcoming first, soonest first, then the past newest first', async () => {
    // The wire order: starts_at DESC.
    serve({
      bookings: {
        items: [booking('BK-FAR', 9), booking('BK-SOON', 1), booking('BK-LAST', -2), booking('BK-OLD', -30)],
        nextCursor: null,
      },
    });
    await openCard();
    const p = await panel('Bookings');
    await within(p).findByText(/Service BK-SOON/);
    const order = [...p.querySelectorAll('.cust-card__feed-what')].map((n) => n.textContent);
    expect(order).toEqual([
      'Service BK-SOON · Noura Al-Rashid',
      'Service BK-FAR · Noura Al-Rashid',
      'Service BK-LAST · Noura Al-Rashid',
      'Service BK-OLD · Noura Al-Rashid',
    ]);
    const heads = [...p.querySelectorAll('.cust-card__records-head')].map((h) => h.textContent);
    expect(heads).toEqual(['Upcoming', 'Past']);
  });

  it('links each row to the booking on Appointments, and shows its deposit to the fil', async () => {
    serve({ bookings: { items: [booking('BK-1', 2, { depositFils: 5250 })], nextCursor: null } });
    await openCard();
    const p = await panel('Bookings');
    const link = await within(p).findByRole('link');
    expect(link.getAttribute('href')).toMatch(/^\/appointments\?booking=BK-1&day=\d{4}-\d{2}-\d{2}$/);
    expect(p.textContent).toContain('5.250 KD deposit');
    expect(within(p).getByText('Deposit held')).toBeTruthy();
  });

  it('without `appointments` says so, and the Purchases panel is unaffected', async () => {
    serve({
      bookings: forbidden('You need the Appointments permission.'),
      orders: board([order('TX-1')]),
    });
    await openCard();
    const b = await panel('Bookings');
    expect(
      await within(b).findByText('You don’t have access to appointments, so her bookings aren’t shown here.'),
    ).toBeTruthy();
    expect(within(b).queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(await within(await panel('Purchases')).findByText('2 × Argan oil')).toBeTruthy();
  });

  it('is empty in words that name what fills it', async () => {
    serve({});
    await openCard();
    expect(await within(await panel('Bookings')).findByText('No bookings yet')).toBeTruthy();
  });

  it('fails with a retry, which is not the refusal', async () => {
    serve({ bookings: new ApiError('boom', { status: 500, code: 'internal' }) });
    await openCard();
    const b = await panel('Bookings');
    expect(await within(b).findByText("Couldn't load her bookings")).toBeTruthy();
    expect(within(b).getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('pages with the board’s cursor', async () => {
    serve({
      bookings: (path: string) =>
        path.includes('cursor=c1')
          ? { items: [booking('BK-OLDER', -60)], nextCursor: null }
          : { items: [booking('BK-1', 2), booking('BK-2', -3)], nextCursor: 'c1' },
    });
    await openCard();
    const b = await panel('Bookings');
    fireEvent.click(await within(b).findByRole('button', { name: 'Show more' }));
    expect(await within(b).findByText(/Service BK-OLDER/)).toBeTruthy();
    expect(paths()).toContain(`/salons/SAL-AMARA/bookings?memberId=${LATIFA.id}&cursor=c1`);
    expect(within(b).queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('folds the past at five, with one control', async () => {
    serve({
      bookings: {
        items: Array.from({ length: 8 }, (_, i) => booking(`BK-P${i}`, -1 - i)),
        nextCursor: null,
      },
    });
    await openCard();
    const b = await panel('Bookings');
    const toggle = await within(b).findByRole('button', { name: 'Show all' });
    expect(b.querySelectorAll('.cust-card__record')).toHaveLength(5);
    fireEvent.click(toggle);
    expect(b.querySelectorAll('.cust-card__record')).toHaveLength(8);
    expect(toggle.textContent).toBe('Show less');
  });
});

/* -------------------------------------------------------------- purchases -- */

describe('the Purchases panel', () => {
  it('draws each order with its lines and the total that left her wallet, to the fil', async () => {
    serve({ orders: board([order('TX-1')]) });
    await openCard();
    const p = await panel('Purchases');
    expect(await within(p).findByText('2 × Argan oil')).toBeTruthy();
    expect(within(p).getByText('1 × Silk scrunchie')).toBeTruthy();
    expect(p.textContent).toContain('10.250 KD');
    expect(p.textContent).toContain('9.000');
    expect(p.textContent).toContain('1.250');
    expect(within(p).getByText('Ready')).toBeTruthy();
    expect(paths()).toContain(`/v1/salons/SAL-AMARA/orders?memberId=${LATIFA.id}`);
  });

  it('without `shop` says so, and the Bookings panel is unaffected', async () => {
    serve({
      bookings: { items: [booking('BK-1', 2)], nextCursor: null },
      orders: forbidden('You need the Shop permission.'),
    });
    await openCard();
    expect(
      await within(await panel('Purchases')).findByText(
        'You don’t have access to the shop, so her purchases aren’t shown here.',
      ),
    ).toBeTruthy();
    expect(await within(await panel('Bookings')).findByText(/Service BK-1/)).toBeTruthy();
  });

  it('pages with the board’s real cursor, which the parse now accepts', async () => {
    serve({
      orders: (path: string) =>
        path.includes('cursor=o1') ? board([order('TX-OLD', { lines: [{ productId: 'PR-9', name: 'Old comb', qty: 1, unitPriceFils: 500, lineTotalFils: 500 }], totalFils: 500 })]) : board([order('TX-1')], 'o1'),
    });
    await openCard();
    const p = await panel('Purchases');
    fireEvent.click(await within(p).findByRole('button', { name: 'Show more' }));
    expect(await within(p).findByText('1 × Old comb')).toBeTruthy();
    expect(paths()).toContain(`/v1/salons/SAL-AMARA/orders?memberId=${LATIFA.id}&cursor=o1`);
  });

  it('is empty in words that name what fills it', async () => {
    serve({});
    await openCard();
    expect(await within(await panel('Purchases')).findByText('No purchases yet')).toBeTruthy();
  });

  it('fails the panel — not the card — on a row the board schema refuses', async () => {
    serve({ orders: board([{ ...order('TX-1'), totalFils: 10.25 }]) });
    await openCard();
    const p = await panel('Purchases');
    expect(await within(p).findByText("Couldn't load her purchases")).toBeTruthy();
    expect(screen.getByText('Personal information')).toBeTruthy();
  });
});

/* ------------------------------------------------------------ the whole card */

describe('the card around them', () => {
  it('no longer says bookings and purchases are "not on this card yet"', async () => {
    serve({});
    await openCard();
    await panel('Bookings');
    expect(screen.queryByText('Not on this card yet')).toBeNull();
  });

  it('draws no panel answer for a member who is not this salon’s', async () => {
    serve({ card: new ApiError('No such member.', { status: 404, code: 'unknown_member' }) });
    await openCard();
    expect(await screen.findByText("That customer isn't in this salon's book")).toBeTruthy();
    await waitFor(() => expect(paths().some((p) => p.includes('/customers/'))).toBe(true));
    // The card's 404 suppresses both panels; neither claims she has no records.
    expect(screen.queryByText('No bookings yet')).toBeNull();
    expect(screen.queryByText('No purchases yet')).toBeNull();
  });

  it('draws no panel for a module the salon has switched off', async () => {
    salonState.data = { timezone: 'Asia/Kuwait', modules: { booking: false, shop: false } };
    serve({});
    await openCard();
    await screen.findByText('Personal information');
    expect(screen.queryByText('Bookings', { selector: 'h3' })).toBeNull();
    expect(screen.queryByText('Purchases', { selector: 'h3' })).toBeNull();
    expect(paths().some((p) => p.includes('memberId='))).toBe(false);
  });
});

describe('splitBookings', () => {
  it('splits on the instant, not the status', () => {
    const now = new Date('2026-09-29T09:00:00Z');
    const b = (id: string, startsAt: string, status = 'deposit_held') =>
      ({ id, startsAt, status }) as unknown as Parameters<typeof splitBookings>[0][number];
    const { upcoming, past } = splitBookings(
      [
        b('C', '2026-10-05T09:00:00Z', 'cancelled'),
        b('B', '2026-09-30T09:00:00Z'),
        b('A', '2026-09-28T09:00:00Z', 'completed'),
      ],
      now,
    );
    expect(upcoming.map((x) => x.id)).toEqual(['B', 'C']);
    expect(past.map((x) => x.id)).toEqual(['A']);
  });
});
