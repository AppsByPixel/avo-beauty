// @vitest-environment jsdom

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHICH BRANCH SHE COLLECTS FROM — the merchant's half of migration 0060
 * ═══════════════════════════════════════════════════════════════════════════
 * The client: "Collect it is good, but from which branch if they have
 * multiple". The customer now chooses; this board is where staff learn which
 * counter to prepare the order at. So every property below is about what a
 * member of staff READS on a row, and the board is MOUNTED — through
 * `useOrderBoard`, through `parseOrderBoard`, through the header's branch
 * selection — rather than a row being handed props, because two of the six
 * guarantees live in the parse and the narrowing, not in the row.
 *
 *   1. A pickup names its branch; a delivery names none.
 *   2. `closed: true` renders as needing attention, and can still be moved.
 *   3. `pickupBranch: null` on a pickup says "not chosen", and names nothing.
 *   4. The header's selector narrows to the selected branch's pickups — and a
 *      closed branch's orders stay on screen under EVERY selection.
 *   5. (Settings, `api/branchResponseParse.test.tsx` § 4.)
 *   6. No lookup in `salon.branches`: the scope below hands the board the
 *      salon's OPEN branches, exactly as the real `BranchScope` does, and the
 *      closed branch's order must still carry its name.
 *
 * `authedRequest` is mocked at the wire — it answers raw JSON, so every body
 * below goes through the same parse the real API's does.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import type { Branch } from '@avo/types';
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

/**
 * THE HEADER'S SELECTION, as a tiny external store. The real
 * `BranchScopeProvider` needs a parsed `GET /salons/{id}` to exist at all; this
 * keeps its CONTRACT — `selected` is `'all'` or an open branch's id, `branches`
 * is the salon's OPEN branches, `selectedName` is looked up there — and nothing
 * else, so `select` genuinely re-renders the board.
 */
const scope = vi.hoisted(() => {
  let selected = 'all';
  const subs = new Set<() => void>();
  return {
    get: () => selected,
    set: (next: string) => {
      selected = next;
      subs.forEach((f) => f());
    },
    subscribe: (f: () => void) => {
      subs.add(f);
      return () => {
        subs.delete(f);
      };
    },
  };
});

const SALMIYA: Branch = { id: 'BR-SAL', salonId: 'SAL-AMARA', name: 'Salmiya', nameAr: 'السالمية', businessHours: { morning: ['10:00', '13:00'] as [string, string], evening: ['16:00', '21:00'] as [string, string] }, businessHoursSource: 'salon' as const };
const KUWAIT_CITY: Branch = {
  id: 'BR-KWT',
  salonId: 'SAL-AMARA',
  name: 'Kuwait City',
  nameAr: 'مدينة الكويت',
  businessHours: { morning: ['10:00', '13:00'] as [string, string], evening: ['16:00', '21:00'] as [string, string] }, businessHoursSource: 'salon' as const,
};
/** OPEN BRANCHES ONLY — `GET /salons/{id}` serialises no closed one. Jabriya is not here. */
const OPEN_BRANCHES: Branch[] = [SALMIYA, KUWAIT_CITY];

vi.mock('../shell/BranchScope.js', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    ALL_BRANCHES: 'all',
    useBranchScope: () => {
      const selected = useSyncExternalStore(scope.subscribe, scope.get);
      return {
        selected,
        select: scope.set,
        branches: OPEN_BRANCHES,
        status: 'ready',
        selectedName:
          selected === 'all' ? null : (OPEN_BRANCHES.find((b) => b.id === selected)?.name ?? null),
      };
    },
  };
});

const { ShopOrders, narrowToBranch } = await import('./ShopOrders.js');
const { parseOrderBoard } = await import('../api/orders.js');

beforeEach(() => scope.set('all'));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/* =============================================================== fixtures == */

function row(transactionId: string, over: Record<string, unknown>): Record<string, unknown> {
  return {
    transactionId,
    fulfilment: 'pickup',
    status: 'preparing',
    address: null,
    pickupBranch: null,
    createdAt: '2026-09-28T09:00:00.000Z',
    readyAt: null,
    closedAt: null,
    memberName: `Customer ${transactionId}`,
    memberPhone: '+96599124408',
    memberErased: false,
    ...over,
  };
}

const AT_SALMIYA = row('TX-SAL', {
  pickupBranch: { id: 'BR-SAL', name: 'Salmiya', nameAr: 'السالمية', closed: false, businessHours: { morning: ['10:00', '13:00'] as [string, string], evening: ['16:00', '21:00'] as [string, string] }, businessHoursSource: 'salon' as const, timezone: 'Asia/Kuwait' },
});
const AT_KUWAIT_CITY = row('TX-KWT', {
  pickupBranch: { id: 'BR-KWT', name: 'Kuwait City', nameAr: 'مدينة الكويت', closed: false, businessHours: { morning: ['10:00', '13:00'] as [string, string], evening: ['16:00', '21:00'] as [string, string] }, businessHoursSource: 'salon' as const, timezone: 'Asia/Kuwait' },
});
/** Waiting at a branch that has since closed — and is therefore absent from OPEN_BRANCHES. */
const AT_CLOSED_JABRIYA = row('TX-JAB', {
  pickupBranch: { id: 'BR-JAB', name: 'Jabriya', nameAr: null, closed: true, businessHours: { morning: ['10:00', '13:00'] as [string, string], evening: ['16:00', '21:00'] as [string, string] }, businessHoursSource: 'salon' as const, timezone: 'Asia/Kuwait' },
});
/** Placed before 0060 at a multi-branch salon: she was never asked. */
const NOT_CHOSEN = row('TX-OLD', { pickupBranch: null });
const DELIVERY = row('TX-DEL', {
  fulfilment: 'delivery',
  pickupBranch: null,
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

const BOARD = {
  items: [AT_SALMIYA, AT_KUWAIT_CITY, AT_CLOSED_JABRIYA, NOT_CHOSEN, DELIVERY],
  truncated: false,
  nextCursor: null,
};

/* ================================================================ the rig == */

function mount(board: unknown, patch?: unknown) {
  authedRequest.mockImplementation((_s: string, path: string, opts?: { method?: string }) => {
    if ((opts?.method ?? 'GET') === 'PATCH') return Promise.resolve(patch);
    if (path.startsWith('/v1/salons/SAL-AMARA/orders')) return Promise.resolve(board);
    throw new Error(`unrouted ${path}`);
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  render(<ShopOrders shopOn timezone="Asia/Kuwait" />, { wrapper });
}

/** The row for a transaction, once the board has loaded. */
async function rowFor(transactionId: string): Promise<HTMLElement> {
  const ref = await screen.findByText(transactionId);
  return ref.closest('tr') as HTMLElement;
}

function whereOf(tr: HTMLElement): string {
  return tr.querySelector('.orders__where')?.textContent ?? '';
}

/* ======================================== 1 · a pickup names its branch == */

describe('a pickup says which counter to prepare it at; a delivery does not', () => {
  it('renders the chosen branch on a pickup', async () => {
    mount(BOARD);
    const tr = await rowFor('TX-SAL');
    expect(whereOf(tr)).toBe('Collecting at Salmiya');
    // The name is the one word on the line that is not muted — it is what staff scan for.
    expect(tr.querySelector('.orders__pickup-branch')?.textContent).toBe('Salmiya');
  });

  it('renders every pickup at its own branch, not one branch for all', async () => {
    mount(BOARD);
    expect(whereOf(await rowFor('TX-KWT'))).toBe('Collecting at Kuwait City');
    expect(whereOf(await rowFor('TX-SAL'))).toBe('Collecting at Salmiya');
  });

  it('renders no branch at all on a delivery', async () => {
    mount(BOARD);
    const tr = await rowFor('TX-DEL');
    const where = whereOf(tr);
    expect(where).toContain('Block 4');
    expect(where).not.toContain('Collecting');
    expect(tr.querySelector('.orders__pickup-branch')).toBeNull();
    expect(tr.querySelector('.orders__pickup-closed')).toBeNull();
    expect(where).not.toContain('branch');
  });
});

/* ============================ 2 · a closed branch needs a human, and moves == */

describe('an order waiting at a branch that has since closed', () => {
  it('stands out as needing attention rather than reading as a normal pickup', async () => {
    mount(BOARD);
    const tr = await rowFor('TX-JAB');
    const flag = tr.querySelector('.orders__pickup-closed');
    expect(flag, 'the closed-branch row rendered as an ordinary pickup').not.toBeNull();
    expect(flag?.textContent).toContain('Jabriya has closed.');
    expect(flag?.textContent).toContain('Nobody is at that counter to hand this over.');
    expect(whereOf(tr)).not.toContain('Collecting at Jabriya');
    // Not the ordinary pickup idiom.
    expect(tr.querySelector('.orders__pickup-branch')).toBeNull();
  });

  it('can still be moved preparing → ready, and the move goes to the server', async () => {
    mount(BOARD, { order: { ...AT_CLOSED_JABRIYA, status: 'ready' } });
    const tr = await rowFor('TX-JAB');
    const button = within(tr).getByRole('button', { name: 'Mark ready' });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    await act(async () => button.click());
    await waitFor(() =>
      expect(authedRequest).toHaveBeenCalledWith(
        'merchant',
        '/v1/salons/SAL-AMARA/orders/TX-JAB',
        { method: 'PATCH', body: { status: 'ready' } },
      ),
    );
    // And it stays flagged after the move — the PATCH answers the same pickupBranch.
    await waitFor(() =>
      expect(within(tr).queryByRole('button', { name: 'Close' })).not.toBeNull(),
    );
    expect(tr.querySelector('.orders__pickup-closed')?.textContent).toContain('Jabriya has closed.');
  });

  it('can be moved ready → closed as well', async () => {
    mount({ ...BOARD, items: [{ ...AT_CLOSED_JABRIYA, status: 'ready' }] });
    const tr = await rowFor('TX-JAB');
    expect(within(tr).getByRole('button', { name: 'Close' })).toBeTruthy();
  });
});

/* ================================= 3 · not chosen is said, not invented == */

describe('a pickup placed before customers could choose a branch', () => {
  it('says the branch was not chosen', async () => {
    mount(BOARD);
    const tr = await rowFor('TX-OLD');
    expect(whereOf(tr)).toContain('Pickup branch not chosen');
    expect(whereOf(tr)).toContain('Placed before customers could pick a branch.');
  });

  it('names no branch, and not "the salon", which a two-branch salon does not have', async () => {
    mount(BOARD);
    const where = whereOf(await rowFor('TX-OLD'));
    for (const name of ['Salmiya', 'Kuwait City', 'Jabriya', 'the salon']) {
      expect(where).not.toContain(name);
    }
    expect(where).not.toContain('Collecting at');
  });
});

/* ======================================== 4 · the header's branch selector == */

describe('the header branch selector narrows the board to what it knows', () => {
  it('under "All branches" shows every order and says nothing about narrowing', async () => {
    mount(BOARD);
    for (const tx of ['TX-SAL', 'TX-KWT', 'TX-JAB', 'TX-OLD', 'TX-DEL']) await rowFor(tx);
    expect(document.querySelector('.orders__scope')).toBeNull();
  });

  it('under Salmiya hides Kuwait City pickups — and only those', async () => {
    scope.set('BR-SAL');
    mount(BOARD);
    await rowFor('TX-SAL');
    expect(screen.queryByText('TX-KWT')).toBeNull();
    // Every row whose branch is not positively another open one stays.
    await rowFor('TX-DEL');
    await rowFor('TX-OLD');
    await rowFor('TX-JAB');
  });

  it("keeps a closed branch's orders reachable under every selection, flagged", async () => {
    for (const selected of ['all', 'BR-SAL', 'BR-KWT']) {
      scope.set(selected);
      mount(BOARD);
      const tr = await rowFor('TX-JAB');
      expect(tr.querySelector('.orders__pickup-closed'), `hidden under ${selected}`).not.toBeNull();
      cleanup();
    }
  });

  it('says what it hid, and gives the one click back', async () => {
    scope.set('BR-SAL');
    mount(BOARD);
    await rowFor('TX-SAL');
    const note = document.querySelector('.orders__scope');
    expect(note?.textContent).toContain('Showing pickups at Salmiya');
    expect(note?.textContent).toContain('1 pickup at other branches is hidden.');
    await act(async () => screen.getByRole('button', { name: 'Show all branches' }).click());
    await rowFor('TX-KWT');
    expect(scope.get()).toBe('all');
    expect(document.querySelector('.orders__scope')).toBeNull();
  });

  it('a board whose every order is at another branch says so, not "No orders yet"', async () => {
    scope.set('BR-SAL');
    mount({ ...BOARD, items: [AT_KUWAIT_CITY] });
    expect(await screen.findByText('No orders to collect at Salmiya')).toBeTruthy();
    expect(screen.queryByText('No orders yet')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show all branches' })).toBeTruthy();
  });

  /** The rule itself, as a table — every `keep` arm is one way of NOT guessing. */
  it.each([
    ['a pickup at the selected branch', AT_SALMIYA, true],
    ['a pickup at another open branch', AT_KUWAIT_CITY, false],
    ['a pickup at a closed branch', AT_CLOSED_JABRIYA, true],
    ['a pickup whose branch was not chosen', NOT_CHOSEN, true],
    ['a delivery', DELIVERY, true],
  ])('under Salmiya, %s is kept: %s', (_label, order, kept) => {
    const parsed = parseOrderBoard({ items: [order], truncated: false, nextCursor: null });
    const { visible, hidden } = narrowToBranch(parsed.items, 'BR-SAL');
    expect(visible.length).toBe(kept ? 1 : 0);
    expect(hidden).toBe(kept ? 0 : 1);
  });

  it('hides nothing under "All branches"', () => {
    const parsed = parseOrderBoard(BOARD);
    expect(narrowToBranch(parsed.items, 'all')).toEqual({ visible: parsed.items, hidden: 0 });
  });
});

/* ========================== 6 · the branch is the row's, never looked up == */

describe("the order's branch is read off the row, never resolved in salon.branches", () => {
  /**
   * `OPEN_BRANCHES` is what the scope hands the board, and Jabriya is not in it
   * — exactly as `GET /salons/{id}` would serve a salon whose Jabriya branch
   * closed. A board that resolved `pickupBranch.id` against that list would
   * find nothing and the order's location would vanish.
   */
  it("still names a closed branch that the salon's branch list no longer carries", async () => {
    expect(OPEN_BRANCHES.some((b) => b.id === 'BR-JAB')).toBe(false);
    mount(BOARD);
    const tr = await rowFor('TX-JAB');
    expect(whereOf(tr)).toContain('Jabriya');
  });

  /** The live join and the list can disagree for a beat (a rename); the row wins. */
  it('renders the name the row carries even where the list says otherwise', async () => {
    mount({
      ...BOARD,
      items: [
        row('TX-REN', {
          pickupBranch: { id: 'BR-SAL', name: 'Salmiya Souq', nameAr: null, closed: false, businessHours: { morning: ['10:00', '13:00'] as [string, string], evening: ['16:00', '21:00'] as [string, string] }, businessHoursSource: 'salon' as const, timezone: 'Asia/Kuwait' },
        }),
      ],
    });
    expect(whereOf(await rowFor('TX-REN'))).toBe('Collecting at Salmiya Souq');
  });
});

/* ======================================== the parse at the boundary == */

describe('the board is parsed, so a malformed branch cannot pick an arm silently', () => {
  it.each([
    ['closed as a string', { id: 'BR-JAB', name: 'Jabriya', nameAr: null, closed: 'true', businessHours: { morning: ['10:00', '13:00'] as [string, string], evening: ['16:00', '21:00'] as [string, string] }, businessHoursSource: 'salon' as const, timezone: 'Asia/Kuwait' }],
    ['no id', { name: 'Jabriya', nameAr: null, closed: true }],
    ['an empty name', { id: 'BR-JAB', name: '', nameAr: null, closed: false, businessHours: { morning: ['10:00', '13:00'] as [string, string], evening: ['16:00', '21:00'] as [string, string] }, businessHoursSource: 'salon' as const, timezone: 'Asia/Kuwait' }],
    ['the key missing', undefined],
  ])('a pickupBranch with %s fails the board rather than rendering', async (_label, branch) => {
    const bad = { ...AT_CLOSED_JABRIYA, pickupBranch: branch };
    if (branch === undefined) delete (bad as Record<string, unknown>).pickupBranch;
    mount({ ...BOARD, items: [AT_SALMIYA, bad] });
    expect(await screen.findByText("Couldn't load orders")).toBeTruthy();
    // Not a board one order short, and not the bad row drawn as an ordinary pickup.
    expect(screen.queryByText('TX-SAL')).toBeNull();
    expect(screen.queryByText('TX-JAB')).toBeNull();
  });

  it('keeps the joined member fields the shared schema does not carry', () => {
    const parsed = parseOrderBoard(BOARD);
    expect(parsed.items[0]).toMatchObject({
      memberName: 'Customer TX-SAL',
      memberPhone: '+96599124408',
      memberErased: false,
      pickupBranch: { id: 'BR-SAL', name: 'Salmiya', closed: false },
    });
  });

  it.each([
    ['no memberErased', { memberErased: undefined }],
    ['a numeric phone', { memberPhone: 96599124408 }],
  ])('a row with %s fails the board', (_label, over) => {
    const bad = { ...AT_SALMIYA, ...over };
    expect(() => parseOrderBoard({ ...BOARD, items: [bad] })).toThrow(/items\[0\]/);
  });
});
