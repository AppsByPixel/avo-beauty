// @vitest-environment jsdom

/**
 * THE OWNER CONSOLE'S LISTS — Salons, Accounts, Audit, Activity, the support
 * queue and Approvals — and where each filter is applied.
 *
 * Every one of these reads is cursor-paged or capped, so every filter here is a
 * REQUEST PARAMETER — except Salons, whose endpoint takes none, and which must
 * therefore walk every page before it filters anything. The assertions are on
 * the wire and on the URL. `authedRequest` is the only stand-in.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authedRequest = vi.fn();
vi.mock('../../auth/authedRequest.js', () => ({
  authedRequest: (...args: unknown[]) => authedRequest(...args),
}));
vi.mock('../../auth/AuthProvider.js', () => ({
  useConsoleSections: () => ({ salons: false, controls: false }),
  useSession: () => ({ adminId: 'AD-1', perms: {} }),
  useSalonId: () => 'SAL-AMARA',
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a>,
  useNavigate: () => vi.fn(),
}));

const { Salons } = await import('./Salons.js');
const { ConsoleAccounts } = await import('./Accounts.js');
const { Audit } = await import('./Audit.js');
const { Activity } = await import('./Activity.js');
const { SupportQueue } = await import('./SupportQueue.js');
const { Approvals } = await import('./Approvals.js');

const salon = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id,
  name,
  nameAr: null,
  city: 'Kuwait City',
  plan: 'growth',
  loyaltyMode: 'tiers',
  branchCount: 1,
  memberCount: 10,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
});
const AMARA = salon('SAL-AMARA', 'Amara', { plan: 'pro' });
const NOOR = salon('SAL-NOOR', 'Noor Studio', { loyaltyMode: 'stamps' });
const GLOW = salon('SAL-GLOW', 'Glow Bar', { city: 'Salmiya' });

let routes: Record<string, (path: string) => unknown>;

beforeEach(() => {
  window.history.replaceState(null, '', '/console');
  // Two pages of salons: the filters must walk to the second before they answer.
  routes = {
    '/v1/platform/salons': (path) =>
      path.includes('cursor=SAL-NOOR')
        ? { items: [GLOW], nextCursor: null }
        : { items: [AMARA, NOOR], nextCursor: 'SAL-NOOR' },
  };
  authedRequest.mockImplementation((_s: string, path: string) => {
    const prefix = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((p) => path.startsWith(p));
    if (prefix) return Promise.resolve(routes[prefix]!(path));
    return Promise.reject(new Error(`unrouted ${path}`));
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mount(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

const pathsTo = (prefix: string) =>
  authedRequest.mock.calls.map(([, path]) => path as string).filter((p) => p.startsWith(prefix));
const lastTo = (prefix: string) => pathsTo(prefix).at(-1);

/* ================================================================== salons == */

const salonNames = () =>
  Array.from(document.querySelectorAll('.salons__table tbody tr')).map(
    (tr) => tr.querySelector('td')?.textContent ?? '',
  );

describe('Console → Salons: the filters walk every page before they answer', () => {
  it('unfiltered, only the first page is read and "Show more" pages by hand', async () => {
    mount(<Salons />);
    await screen.findByText('Amara');
    expect(pathsTo('/v1/platform/salons')).toEqual(['/v1/platform/salons']);
    expect(screen.getByRole('button', { name: 'Show more salons' })).toBeTruthy();
  });

  it('a search for a salon on page two finds it — the old page-one filter said "no match"', async () => {
    mount(<Salons />);
    await screen.findByText('Amara');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search the salons on AVO' }), {
      target: { value: 'glow' },
    });
    await waitFor(() => expect(salonNames().some((n) => n.includes('Glow Bar'))).toBe(true));
    expect(pathsTo('/v1/platform/salons')).toEqual([
      '/v1/platform/salons',
      '/v1/platform/salons?cursor=SAL-NOOR',
    ]);
    expect(screen.queryByText(/No salons match/)).toBeNull();
    expect(screen.getByText('1 of 3 salons')).toBeTruthy();
    await waitFor(() => expect(window.location.search).toBe('?q=glow'));
  });

  it('plan and loyalty narrow, from a shared URL, and Clear restores the first page view', async () => {
    window.history.replaceState(null, '', '/console/salons?loyalty=stamps');
    mount(<Salons />);
    await waitFor(() => expect(salonNames()).toHaveLength(1));
    expect(salonNames()[0]).toContain('Noor Studio');
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(salonNames()).toHaveLength(3));
    expect(window.location.search).toBe('');
  });

  it('no match is said only after the last page, with Clear filters', async () => {
    window.history.replaceState(null, '', '/console/salons?q=zzz');
    mount(<Salons />);
    await screen.findByText('No salons match “zzz”');
    expect(pathsTo('/v1/platform/salons')).toHaveLength(2);
  });
});

/* ================================================================ accounts == */

const account = (id: string, name: string) => ({
  id,
  kind: 'customer',
  name,
  handle: null,
  role: 'customer',
  salonId: 'SAL-AMARA',
  salon: 'Amara',
  passwordSet: true,
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
});

describe('Console → Accounts', () => {
  beforeEach(() => {
    routes['/v1/platform/accounts'] = () => ({ items: [account('MB-1', 'Latifa A.')], nextCursor: null });
  });

  it('role and salon go to the server and into the URL; the search goes to the server only', async () => {
    mount(<ConsoleAccounts />);
    await screen.findByText('Latifa A.');
    fireEvent.click(screen.getByRole('radio', { name: 'Staff' }));
    await waitFor(() => expect(lastTo('/v1/platform/accounts')).toBe('/v1/platform/accounts?role=staff'));
    const salonSelect = await screen.findByRole('combobox', { name: 'Filter by salon' });
    fireEvent.change(salonSelect, { target: { value: 'SAL-AMARA' } });
    await waitFor(() =>
      expect(lastTo('/v1/platform/accounts')).toBe('/v1/platform/accounts?role=staff&salon=SAL-AMARA'),
    );
    expect(window.location.search).toBe('?role=staff&salon=SAL-AMARA');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search every account on the platform' }), {
      target: { value: 'latifa' },
    });
    await waitFor(() => expect(lastTo('/v1/platform/accounts')).toContain('q=latifa'));
    // A customer's name is never written to the address bar.
    expect(window.location.search).toBe('?role=staff&salon=SAL-AMARA');
  });

  it('a ?salon= from the URL waits for the salon list, then is sent — never an unfiltered read first', async () => {
    window.history.replaceState(null, '', '/console/accounts?salon=SAL-GLOW');
    mount(<ConsoleAccounts />);
    await waitFor(() => expect(pathsTo('/v1/platform/accounts')).toHaveLength(1));
    expect(pathsTo('/v1/platform/accounts')).toEqual(['/v1/platform/accounts?salon=SAL-GLOW']);
  });

  it('a ?salon= that is not a salon is ignored rather than refused into an error screen', async () => {
    window.history.replaceState(null, '', '/console/accounts?salon=SAL-GONE');
    mount(<ConsoleAccounts />);
    await screen.findByText('Latifa A.');
    expect(pathsTo('/v1/platform/accounts')).toEqual(['/v1/platform/accounts']);
  });
});

/* =================================================================== audit == */

describe('Console → Audit', () => {
  const page = { items: [], total: 0, nextCursor: null, appendOnly: true, retentionYears: 7 };
  beforeEach(() => {
    routes['/v1/platform/audit'] = () => page;
  });

  it('kind and the AVO-only scope go to the server and into the URL', async () => {
    mount(<Audit />);
    await waitFor(() => expect(pathsTo('/v1/platform/audit')).toHaveLength(1));
    fireEvent.click(screen.getByRole('radio', { name: 'Money' }));
    await waitFor(() => expect(lastTo('/v1/platform/audit')).toBe('/v1/platform/audit?kind=money'));
    fireEvent.click(screen.getByRole('switch', { name: 'AVO actions only' }));
    await waitFor(() =>
      expect(lastTo('/v1/platform/audit')).toBe('/v1/platform/audit?kind=money&salon=platform'),
    );
    expect(window.location.search).toBe('?kind=money&salon=platform');
  });

  it('a filtered empty names the filter and Clear asks for everything', async () => {
    window.history.replaceState(null, '', '/console/audit?kind=risk');
    mount(<Audit />);
    await screen.findByText('No Risk entries yet.');
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear filters' })[0]!);
    await waitFor(() => expect(lastTo('/v1/platform/audit')).toBe('/v1/platform/audit'));
    expect(window.location.search).toBe('');
  });
});

/* ================================================================ activity == */

describe('Console → Activity', () => {
  it('the salon picker is sent as ?salon= and kept in the URL', async () => {
    routes['/v1/platform/activity'] = () => ({ items: [], nextCursor: null });
    mount(<Activity />);
    const select = await screen.findByRole('combobox', { name: 'Filter by salon' });
    fireEvent.change(select, { target: { value: 'SAL-NOOR' } });
    await waitFor(() =>
      expect(lastTo('/v1/platform/activity')).toBe('/v1/platform/activity?limit=30&salon=SAL-NOOR'),
    );
    expect(window.location.search).toBe('?salon=SAL-NOOR');
    await screen.findByText('No events match these filters');
  });
});

/* =========================================================== support queue == */

describe('Console → Policies → the support queue', () => {
  beforeEach(() => {
    routes['/v1/support/tickets'] = () => ({ items: [], nextCursor: null, total: 0 });
  });

  it('opens on Open, and each chip is a request parameter and a URL key', async () => {
    mount(<SupportQueue />);
    await waitFor(() => expect(pathsTo('/v1/support/tickets')).toEqual(['/v1/support/tickets?status=open']));
    fireEvent.click(screen.getByRole('radio', { name: 'Answered' }));
    await waitFor(() => expect(lastTo('/v1/support/tickets')).toBe('/v1/support/tickets?status=closed'));
    fireEvent.click(screen.getByRole('radio', { name: 'AVO' }));
    await waitFor(() =>
      expect(lastTo('/v1/support/tickets')).toBe('/v1/support/tickets?route=avo&status=closed'),
    );
    expect(window.location.search).toBe('?ticket=answered&queue=avo');
  });

  it('a shared URL opens on its filter; Clear returns to Open', async () => {
    window.history.replaceState(null, '', '/console/policies?ticket=both&queue=salon');
    mount(<SupportQueue />);
    await waitFor(() => expect(pathsTo('/v1/support/tickets')).toEqual(['/v1/support/tickets?route=salon']));
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear filters' })[0]!);
    await waitFor(() => expect(lastTo('/v1/support/tickets')).toBe('/v1/support/tickets?status=open'));
    expect(window.location.search).toBe('');
  });
});

/* =============================================================== approvals == */

describe('Console → Approvals → Decided', () => {
  beforeEach(() => {
    routes['/v1/platform/campaigns'] = () => ({ items: [] });
    routes['/v1/platform/messaging-policy'] = () => {
      throw new Error('not under test');
    };
  });

  it('unfiltered, one read feeds the queue and Decided; a chip adds a ?status= read', async () => {
    mount(<Approvals />);
    await screen.findByText('Queue is clear');
    expect(pathsTo('/v1/platform/campaigns')).toEqual(['/v1/platform/campaigns']);
    fireEvent.click(screen.getByRole('radio', { name: 'Rejected' }));
    await waitFor(() => expect(lastTo('/v1/platform/campaigns')).toBe('/v1/platform/campaigns?status=rejected'));
    expect(window.location.search).toBe('?decided=rejected');
    await screen.findByText('No campaigns match these filters');
  });
});

/* ================================================================== back == */

describe('Back undoes a console filter', () => {
  it('on the support queue', async () => {
    routes['/v1/support/tickets'] = () => ({ items: [], nextCursor: null, total: 0 });
    mount(<SupportQueue />);
    await waitFor(() => expect(pathsTo('/v1/support/tickets')).toHaveLength(1));
    fireEvent.click(screen.getByRole('radio', { name: 'Both' }));
    await waitFor(() => expect(lastTo('/v1/support/tickets')).toBe('/v1/support/tickets'));
    await act(async () => {
      window.history.back();
      await new Promise((r) => setTimeout(r, 30));
    });
    await waitFor(() =>
      expect((screen.getByRole('radio', { name: 'Open' }) as HTMLElement).getAttribute('aria-checked')).toBe('true'),
    );
  });
});
