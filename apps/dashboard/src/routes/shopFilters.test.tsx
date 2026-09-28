// @vitest-environment jsdom

/**
 * MERCHANT → SHOP — the catalog's search and the orders board's filters.
 * Aftab, 2026-09-29: "Search and filters on shop and all other screens of the
 * merchant dashboard."
 *
 * Both screens are mounted WHOLE with their real hooks; `authedRequest` is the
 * only stand-in, so what reaches the wire is what is asserted. The property the
 * whole slice turns on is WHERE a filter is applied:
 *
 *   the catalog     complete (`nextCursor: null`, no cap) → filtered here.
 *   order status    the endpoint takes `?status=` → it is SENT, never trimmed.
 *   fulfilment/day  the endpoint takes neither → applied here ONLY over a
 *                   complete board; over a truncated one they are paused, not
 *                   applied, because trimming 200 survivors hides the rest.
 *
 * And the URL: every filter round-trips through the query string, Back undoes
 * it, and Clear leaves no parameter behind.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authedRequest = vi.fn();
vi.mock('../auth/authedRequest.js', () => ({
  authedRequest: (...args: unknown[]) => authedRequest(...args),
}));
vi.mock('../auth/AuthProvider.js', () => ({
  useSalonId: () => 'SAL-AMARA',
  useSession: () => ({ perms: {} }),
}));
vi.mock('../shell/BranchScope.js', () => ({
  ALL_BRANCHES: 'all',
  useBranchScope: () => ({
    selected: 'all',
    select: () => {},
    branches: [],
    status: 'ready',
    selectedName: null,
  }),
}));

const { ShopCatalogue } = await import('./Shop.js');
const { ShopOrders, applyOrderFilters } = await import('./ShopOrders.js');

beforeEach(() => {
  window.history.replaceState(null, '', '/shop');
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const paths = () => authedRequest.mock.calls.map(([, path]) => path as string);

/* ================================================================ catalog == */

const PRODUCTS = {
  items: [
    { id: 'PR-1', salonId: 'SAL-AMARA', name: 'Argan oil', priceFils: 4500, image: null },
    { id: 'PR-2', salonId: 'SAL-AMARA', name: 'Rose hair mist', priceFils: 6000, image: null },
    { id: 'PR-3', salonId: 'SAL-AMARA', name: 'Cuticle oil', priceFils: 2500, image: null },
  ],
  nextCursor: null,
};

function mountCatalogue() {
  let items = PRODUCTS.items;
  authedRequest.mockImplementation(
    (_s: string, path: string, opts?: { method?: string; body?: Record<string, unknown> }) => {
      if (opts?.method === 'PATCH') {
        const id = path.split('/').pop();
        items = items.map((p) => (p.id === id ? { ...p, ...opts.body } : p));
        return Promise.resolve(items.find((p) => p.id === id));
      }
      if (path === '/salons/SAL-AMARA/products') return Promise.resolve({ ...PRODUCTS, items });
      throw new Error(`unrouted ${path}`);
    },
  );
  render(<ShopCatalogue />, { wrapper });
}

const productNames = () =>
  screen.queryAllByRole('textbox', { name: /^Product name/ }).map((el) => (el as HTMLInputElement).value);

async function typeSearch(label: string, text: string) {
  fireEvent.change(screen.getByRole('searchbox', { name: label }), { target: { value: text } });
}

describe('the catalog search', () => {
  it('narrows by name, and says how many are left', async () => {
    mountCatalogue();
    await screen.findByDisplayValue('Argan oil');
    await typeSearch('Search products by name', 'oil');
    await waitFor(() => expect(productNames()).toEqual(['Argan oil', 'Cuticle oil']));
    expect(screen.getByText('2 of 3 products')).toBeTruthy();
  });

  it('is applied in the browser — the complete catalog is read once and never re-asked with ?q=', async () => {
    mountCatalogue();
    await screen.findByDisplayValue('Argan oil');
    await typeSearch('Search products by name', 'rose');
    await waitFor(() => expect(productNames()).toEqual(['Rose hair mist']));
    expect(paths()).toEqual(['/salons/SAL-AMARA/products']);
  });

  it('writes ?q= to the URL, and a URL that carries one opens already searched', async () => {
    mountCatalogue();
    await screen.findByDisplayValue('Argan oil');
    await typeSearch('Search products by name', 'cuticle');
    await waitFor(() => expect(window.location.search).toBe('?q=cuticle'));
    cleanup();

    window.history.replaceState(null, '', '/shop?q=rose');
    mountCatalogue();
    await waitFor(() => expect(productNames()).toEqual(['Rose hair mist']));
    expect((screen.getByRole('searchbox', { name: 'Search products by name' }) as HTMLInputElement).value).toBe(
      'rose',
    );
  });

  it('no match says so and offers Clear filters, which restores the whole catalog and the URL', async () => {
    window.history.replaceState(null, '', '/shop?q=shampoo');
    mountCatalogue();
    await screen.findByText('No products match these filters');
    // Not the catalog-is-empty sentence — the catalog is not empty.
    expect(screen.queryByText('No products yet — add your first one.')).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear filters' })[0]!);
    await waitFor(() => expect(productNames()).toEqual(['Argan oil', 'Rose hair mist', 'Cuticle oil']));
    expect(window.location.search).toBe('');
    expect((screen.getByRole('searchbox', { name: 'Search products by name' }) as HTMLInputElement).value).toBe('');
  });

  it('a row renamed out of the search stays put while she is typing in it', async () => {
    window.history.replaceState(null, '', '/shop?q=argan');
    mountCatalogue();
    await waitFor(() => expect(productNames()).toEqual(['Argan oil']));
    const field = screen.getByDisplayValue('Argan oil');
    fireEvent.change(field, { target: { value: 'Hair serum' } });
    // The save lands (700ms debounce) and the server's name no longer matches "argan".
    await waitFor(
      () =>
        expect(authedRequest).toHaveBeenCalledWith(
          'merchant',
          '/salons/SAL-AMARA/products/PR-1',
          expect.objectContaining({ method: 'PATCH' }),
        ),
      { timeout: 2000 },
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(productNames()).toEqual(['Hair serum']);
  });

  it('Back undoes a search that was cleared', async () => {
    window.history.replaceState(null, '', '/shop?q=rose');
    mountCatalogue();
    await waitFor(() => expect(productNames()).toEqual(['Rose hair mist']));
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear filters' })[0]!);
    await waitFor(() => expect(productNames()).toHaveLength(3));
    await act(async () => {
      window.history.back();
      await new Promise((r) => setTimeout(r, 30));
    });
    await waitFor(() => expect(productNames()).toEqual(['Rose hair mist']));
  });
});

/* ================================================================= orders == */

function order(transactionId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transactionId,
    fulfilment: 'pickup',
    status: 'preparing',
    address: null,
    pickupBranch: null,
    createdAt: '2026-09-29T09:00:00.000Z',
    readyAt: null,
    closedAt: null,
    memberName: `Customer ${transactionId}`,
    memberPhone: '+96599124408',
    memberErased: false,
    lines: [{ productId: 'PR-1', name: 'Argan oil', qty: 1, unitPriceFils: 4500, lineTotalFils: 4500 }],
    totalFils: 4500,
    ...over,
  };
}

const DELIVERY = order('TX-DEL', {
  fulfilment: 'delivery',
  address: {
    id: 'ADR-1',
    label: 'Home',
    block: '4',
    street: 'Salem Al-Mubarak',
    building: '27',
    floor: null,
    apartment: null,
    area: 'Salmiya',
    governorate: null,
    instructions: null,
    latitude: null,
    longitude: null,
  },
});
const PICKUP = order('TX-PICK');
const COMPLETE = { items: [PICKUP, DELIVERY], truncated: false, nextCursor: null };

function mountOrders(board: (path: string) => unknown) {
  authedRequest.mockImplementation((_s: string, path: string) => {
    if (path.startsWith('/v1/salons/SAL-AMARA/orders')) return Promise.resolve(board(path));
    throw new Error(`unrouted ${path}`);
  });
  render(<ShopOrders shopOn timezone="Asia/Kuwait" />, { wrapper });
}

const orderIds = () =>
  screen
    .queryAllByText(/^TX-/)
    .map((el) => el.textContent)
    .filter((t): t is string => t !== null);

describe('order status goes to the server', () => {
  it('a status chip sends ?status= and does not trim the loaded board', async () => {
    mountOrders(() => COMPLETE);
    await screen.findByText('TX-DEL');
    fireEvent.click(screen.getByRole('radio', { name: 'Ready' }));
    await waitFor(() =>
      expect(paths()).toContain('/v1/salons/SAL-AMARA/orders?status=ready'),
    );
    expect(window.location.search).toBe('?status=ready');
    // The server's answer is rendered as-is: both rows came back, both are shown —
    // they are "preparing" in the fixture, and the client did not second-guess it.
    await waitFor(() => expect(orderIds()).toEqual(['TX-PICK', 'TX-DEL']));
  });

  it('a URL with ?status= asks for it on the first request', async () => {
    window.history.replaceState(null, '', '/shop?tab=orders&status=closed');
    mountOrders(() => ({ items: [], truncated: false, nextCursor: null }));
    await waitFor(() => expect(paths()).toEqual(['/v1/salons/SAL-AMARA/orders?status=closed']));
    expect((screen.getByRole('radio', { name: 'Closed' }) as HTMLElement).getAttribute('aria-checked')).toBe(
      'true',
    );
  });

  it('a hand-edited status the server does not know is ignored, not sent', async () => {
    window.history.replaceState(null, '', '/shop?status=shipped');
    mountOrders(() => COMPLETE);
    await screen.findByText('TX-DEL');
    expect(paths()).toEqual(['/v1/salons/SAL-AMARA/orders']);
  });
});

describe('fulfilment narrows a complete board in the browser', () => {
  it('Pickup hides the delivery, and the count says so', async () => {
    mountOrders(() => COMPLETE);
    await screen.findByText('TX-DEL');
    fireEvent.change(screen.getByRole('combobox', { name: 'Fulfilment' }), { target: { value: 'pickup' } });
    await waitFor(() => expect(orderIds()).toEqual(['TX-PICK']));
    expect(screen.getByText('1 of 2 orders')).toBeTruthy();
    expect(window.location.search).toBe('?fulfilment=pickup');
    // Complete board, so no second request was made for it.
    expect(paths()).toEqual(['/v1/salons/SAL-AMARA/orders']);
  });

  it('Clear filters restores the whole board and empties the query string', async () => {
    window.history.replaceState(null, '', '/shop?tab=orders&fulfilment=delivery');
    mountOrders(() => COMPLETE);
    await waitFor(() => expect(orderIds()).toEqual(['TX-DEL']));
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(orderIds()).toEqual(['TX-PICK', 'TX-DEL']));
    // `tab` is Shop's, not the board's filter, and survives.
    expect(window.location.search).toBe('?tab=orders');
  });

  it('a filter that matches nothing says so, with its own escape', async () => {
    mountOrders(() => ({ items: [PICKUP], truncated: false, nextCursor: null }));
    await screen.findByText('TX-PICK');
    fireEvent.change(screen.getByRole('combobox', { name: 'Fulfilment' }), { target: { value: 'delivery' } });
    await screen.findByText('No orders match these filters');
    expect(screen.queryByText(/No orders yet/)).toBeNull();
  });
});

describe('over a TRUNCATED board the browser-side filters are paused, not applied', () => {
  const TRUNCATED = { items: [PICKUP, DELIVERY], truncated: true, nextCursor: 'TX-DEL' };

  it('disables them, keeps every row, and says why', async () => {
    window.history.replaceState(null, '', '/shop?fulfilment=pickup');
    mountOrders(() => TRUNCATED);
    await screen.findByText('TX-DEL');
    expect(orderIds()).toEqual(['TX-PICK', 'TX-DEL']);
    expect((screen.getByRole('combobox', { name: 'Fulfilment' }) as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByRole('combobox', { name: 'Placed' }) as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByText(/Fulfilment and date filters are paused/)).toBeTruthy();
  });
});

describe('Placed is the salon’s calendar day', () => {
  it('Placed today keeps what was placed on Kuwait’s today, even when UTC is still on yesterday', () => {
    // 21:30Z on the 29th is 00:30 on the 30th in Kuwait.
    const now = new Date('2026-09-29T21:30:00.000Z');
    const rows = [
      { id: 'a', fulfilment: 'pickup' as const, createdAt: '2026-09-29T21:10:00.000Z' }, // 00:10 on the 30th
      { id: 'b', fulfilment: 'pickup' as const, createdAt: '2026-09-29T20:50:00.000Z' }, // 23:50 on the 29th
    ];
    expect(applyOrderFilters(rows, '', 'today', 'Asia/Kuwait', now).map((r) => r.id)).toEqual(['a']);
    expect(applyOrderFilters(rows, '', 'yesterday', 'Asia/Kuwait', now).map((r) => r.id)).toEqual(['b']);
    expect(applyOrderFilters(rows, '', '7d', 'Asia/Kuwait', now).map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('applies no day window while the salon’s zone is unknown, rather than the browser’s', () => {
    const rows = [{ id: 'a', fulfilment: 'pickup' as const, createdAt: '2020-01-01T00:00:00.000Z' }];
    expect(applyOrderFilters(rows, '', 'today', null).map((r) => r.id)).toEqual(['a']);
  });
});

describe('the toolbar is operable and announced', () => {
  it('status chips are one radio group, moved with the arrow keys', async () => {
    mountOrders(() => COMPLETE);
    await screen.findByText('TX-DEL');
    const group = screen.getByRole('radiogroup', { name: 'Show' });
    const all = within(group).getByRole('radio', { name: 'All' });
    expect(all.getAttribute('tabindex')).toBe('0');
    expect(within(group).getByRole('radio', { name: 'Ready' }).getAttribute('tabindex')).toBe('-1');
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    await waitFor(() => expect(window.location.search).toBe('?status=preparing'));
  });

  it('the landmark is named', async () => {
    mountOrders(() => COMPLETE);
    await screen.findByText('TX-DEL');
    expect(screen.getByRole('search', { name: 'Filter orders' })).toBeTruthy();
  });
});
