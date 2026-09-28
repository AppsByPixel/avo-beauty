// @vitest-environment jsdom

/**
 * THE LISTS THE SERVER PAGES OR CAPS — their filters are REQUEST PARAMETERS.
 *
 *   Appointments   `GET /salons/{id}/bookings`, 200 a page    → `?status=`
 *   Campaigns      `GET /v1/salons/{id}/campaigns`, LIMIT 200 → `?status=`
 *   Audit log      `GET /salons/{id}/audit`, cursor-paged     → `?kind=`, `?q=`
 *   Customers      `GET /salons/{id}/customers`, 25 a page    → `?q=`
 *
 * Filtering a loaded page of any of these would hide the rows the page did not
 * hold, so the assertion is on the WIRE: the chip changes the request, and the
 * rows rendered are the server's answer, untrimmed. Plus the URL, and the one
 * deliberate exception to it — a search that names a person stays out of it.
 *
 * Happy hours rides along: its promotion set is one complete document, so its
 * filters are the browser-side kind, and that is asserted too.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authedRequest = vi.fn();
vi.mock('../auth/authedRequest.js', () => ({
  authedRequest: (...args: unknown[]) => authedRequest(...args),
}));
vi.mock('../auth/AuthProvider.js', () => ({
  useSalonId: () => 'SAL-AMARA',
  useSession: () => ({
    staffId: 'ST-001',
    perms: { appointments: true, void: true, team: true, marketing: true, dashboard: true },
  }),
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
const BRANCHES = [
  { id: 'BR-SAL', salonId: 'SAL-AMARA', name: 'Salmiya', nameAr: null },
  { id: 'BR-KWT', salonId: 'SAL-AMARA', name: 'Kuwait City', nameAr: null },
];
vi.mock('../api/salon.js', () => ({
  useSalon: () => ({
    isSuccess: true,
    isPending: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
    data: {
      id: 'SAL-AMARA',
      timezone: 'Asia/Kuwait',
      modules: { booking: true, shop: true },
      noShowReturnMinutes: 60,
      businessHours: { morning: ['10:00', '13:00'], evening: ['16:00', '21:00'] },
      branches: BRANCHES,
    },
  }),
}));
vi.mock('../api/artists.js', () => ({ useBookableArtists: () => ({ data: undefined }) }));
vi.mock('./AppointmentForm.js', () => ({ AppointmentForm: () => null }));

const { Appointments } = await import('./Appointments.js');
const { Campaigns } = await import('./marketing/Campaigns.js');
const { HappyHours } = await import('./marketing/HappyHours.js');
const { AuditLog } = await import('./AuditLog.js');
const { Customers } = await import('./Customers.js');

let routes: Record<string, (path: string) => unknown>;

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  routes = {};
  authedRequest.mockImplementation((_s: string, path: string) => {
    const prefix = Object.keys(routes).find((p) => path.startsWith(p));
    if (prefix) return Promise.resolve(routes[prefix]!(path));
    throw new Error(`unrouted ${path}`);
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
const back = () =>
  act(async () => {
    window.history.back();
    await new Promise((r) => setTimeout(r, 30));
  });

/* ============================================================ appointments == */

const booking = (id: string, status: string) => ({
  id,
  salonId: 'SAL-AMARA',
  memberId: 'MB-1',
  memberName: `Customer ${id}`,
  memberPhone: null,
  memberErased: false,
  serviceId: 'SV-1',
  serviceName: 'Blow-dry',
  artistId: 'AR-1',
  artistName: 'Noura',
  startsAt: '2026-10-02T10:00:00.000Z',
  endsAt: '2026-10-02T11:00:00.000Z',
  depositFils: 5000,
  status,
  source: 'app',
});

describe('Appointments → status', () => {
  const BOOKINGS = '/salons/SAL-AMARA/bookings';

  it('is sent as ?status=, and the rows drawn are the server’s answer untrimmed', async () => {
    routes[BOOKINGS] = () => ({ items: [booking('BK-1', 'deposit_held'), booking('BK-2', 'completed')], nextCursor: null });
    mount(<Appointments />);
    await screen.findByText('Customer BK-2');
    fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), { target: { value: 'cancelled' } });
    await waitFor(() => expect(lastTo(BOOKINGS)).toBe(`${BOOKINGS}?status=cancelled`));
    expect(window.location.search).toBe('?status=cancelled');
    // The mock answers the same two rows; a client that trimmed by status would show none.
    await screen.findByText('Customer BK-2');
  });

  it('a shared URL with a status and a preset asks for both on the first request', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-09-29T09:00:00.000Z'));
    window.history.replaceState(null, '', '/appointments?dates=today&status=completed');
    routes[BOOKINGS] = () => ({ items: [], nextCursor: null });
    mount(<Appointments />);
    await waitFor(() =>
      expect(pathsTo(BOOKINGS)).toEqual([`${BOOKINGS}?status=completed&from=2026-09-29&to=2026-09-29`]),
    );
    vi.useRealTimers();
  });

  it('no match under a status says so and Clear asks for the whole board again', async () => {
    window.history.replaceState(null, '', '/appointments?status=no_show_returned');
    routes[BOOKINGS] = (path) =>
      path.includes('status=') ? { items: [], nextCursor: null } : { items: [booking('BK-1', 'deposit_held')], nextCursor: null };
    mount(<Appointments />);
    await screen.findByText('No appointments match these filters');
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear filters' })[0]!);
    await screen.findByText('Customer BK-1');
    expect(lastTo(BOOKINGS)).toBe(BOOKINGS);
    expect(window.location.search).toBe('');
  });

  it('a date preset is in the URL, Back undoes it, and the one-appointment link’s ?booking= survives', async () => {
    window.history.replaceState(null, '', '/appointments?booking=BK-1');
    routes[BOOKINGS] = () => ({ items: [booking('BK-1', 'deposit_held')], nextCursor: null });
    mount(<Appointments />);
    await screen.findByText('Customer BK-1');
    fireEvent.click(screen.getByRole('radio', { name: 'Tomorrow' }));
    await waitFor(() => expect(window.location.search).toBe('?booking=BK-1&dates=tomorrow'));
    await back();
    await waitFor(() =>
      expect((screen.getByRole('radio', { name: 'All dates' }) as HTMLElement).getAttribute('aria-checked')).toBe(
        'true',
      ),
    );
    await waitFor(() => expect(lastTo(BOOKINGS)).toBe(BOOKINGS));
  });

  it('the link’s ?day= still opens the board on that day', async () => {
    window.history.replaceState(null, '', '/appointments?booking=BK-1&day=2026-10-02');
    routes[BOOKINGS] = () => ({ items: [booking('BK-1', 'deposit_held')], nextCursor: null });
    mount(<Appointments />);
    await waitFor(() => expect(pathsTo(BOOKINGS)).toEqual([`${BOOKINGS}?from=2026-10-02&to=2026-10-02`]));
  });
});

/* =============================================================== campaigns == */

const campaign = (id: string, status: string) => ({
  id,
  salonId: 'SAL-AMARA',
  salonName: 'Amara',
  title: `Campaign ${id}`,
  body: 'Body',
  audience: 'all',
  branchId: 'all',
  channel: 'push',
  when: 'now',
  scheduledAt: null,
  reward: null,
  customReward: null,
  reach: 120,
  status,
  note: null,
  result: null,
  submittedAt: '2026-09-20T10:00:00.000Z',
});

describe('Marketing → Campaigns queue → status', () => {
  const QUEUE = '/v1/salons/SAL-AMARA/campaigns';

  beforeEach(() => {
    routes['/v1/salons/SAL-AMARA/campaign-rewards'] = () => ({ items: [] });
  });

  it('a status chip is sent as ?status=, not applied to the loaded 200', async () => {
    routes[QUEUE] = () => ({ items: [campaign('CP-1', 'pending'), campaign('CP-2', 'sent')], nextCursor: null });
    mount(<Campaigns branches={[]} loading={false} timezone="Asia/Kuwait" />);
    await screen.findByText('Campaign CP-2');
    fireEvent.click(screen.getByRole('radio', { name: 'Rejected' }));
    await waitFor(() => expect(lastTo(QUEUE)).toBe(`${QUEUE}?status=rejected`));
    expect(window.location.search).toBe('?status=rejected');
    // The server's rows, as given.
    await screen.findByText('Campaign CP-2');
  });

  it('opens on the URL’s status, and a filtered empty offers Clear, which asks for all', async () => {
    window.history.replaceState(null, '', '/marketing?status=approved');
    routes[QUEUE] = (path) =>
      path.includes('status=') ? { items: [], nextCursor: null } : { items: [campaign('CP-1', 'pending')], nextCursor: null };
    mount(<Campaigns branches={[]} loading={false} timezone="Asia/Kuwait" />);
    await screen.findByText('No campaigns match these filters');
    expect(pathsTo(QUEUE)).toEqual([`${QUEUE}?status=approved`]);
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear filters' })[0]!);
    await screen.findByText('Campaign CP-1');
    expect(lastTo(QUEUE)).toBe(QUEUE);
  });
});

/* ============================================================== happy hours == */

const window_ = (id: string, branchId: string, on: boolean) => ({
  id,
  branchId,
  days: [0, 1, 2, 3, 4, 5, 6],
  from: '00:00',
  to: '23:59',
  reward: 'x2stamp',
  on,
  notify: false,
});

describe('Marketing → Happy hours → branch and state (a complete document, filtered here)', () => {
  const PROMOTIONS = {
    boosts: [],
    happy: [window_('HH-ALL', 'all', true), window_('HH-SAL', 'BR-SAL', true), window_('HH-KWT', 'BR-KWT', false)],
  };
  const windowIds = () =>
    Array.from(document.querySelectorAll('.mk__window .mk__chip:first-child')).map((el) => el.textContent);

  it('a branch keeps the windows that run there — all-branch ones included', async () => {
    mount(<HappyHours branches={BRANCHES as never} promotions={PROMOTIONS as never} loading={false} />);
    expect(windowIds()).toEqual(['All branches', 'Salmiya', 'Kuwait City']);
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by branch' }), { target: { value: 'BR-SAL' } });
    await waitFor(() => expect(windowIds()).toEqual(['All branches', 'Salmiya']));
    expect(window.location.search).toBe('?branch=BR-SAL');
  });

  it('Paused shows only switched-off windows; Clear restores; no request is made', async () => {
    window.history.replaceState(null, '', '/marketing?tab=happy&state=paused');
    mount(<HappyHours branches={BRANCHES as never} promotions={PROMOTIONS as never} loading={false} />);
    expect(windowIds()).toEqual(['Kuwait City']);
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(windowIds()).toHaveLength(3));
    expect(window.location.search).toBe('?tab=happy');
    expect(authedRequest).not.toHaveBeenCalled();
  });
});

/* ================================================================ audit log == */

const entry = (id: string, kind: string) => ({
  id,
  seq: 1,
  when: '2026-09-28T10:00:00.000Z',
  who: 'Noura',
  role: 'Owner',
  actorKind: 'staff',
  actorId: 'ST-001',
  kind,
  action: `Action ${id}`,
  detail: 'detail',
  salonId: 'SAL-AMARA',
  source: 'merchant',
  sourceLabel: 'Merchant',
  isPlatformAction: false,
  subjectType: null,
  subjectId: null,
  amountFils: null,
});

describe('Audit log → kind and search', () => {
  const AUDIT = '/salons/SAL-AMARA/audit';
  const page = (items: unknown[]) => ({ items, total: items.length, nextCursor: null, appendOnly: true, retentionYears: 7 });

  it('a kind chip is sent as ?kind= and kept in the URL', async () => {
    routes[AUDIT] = () => page([entry('A-1', 'money')]);
    mount(<AuditLog />);
    await screen.findByText('Action A-1');
    fireEvent.click(screen.getByRole('radio', { name: 'Risk' }));
    await waitFor(() => expect(lastTo(AUDIT)).toBe(`${AUDIT}?kind=risk`));
    expect(window.location.search).toBe('?kind=risk');
  });

  it('the search is sent as ?q= after a pause — and NOT written to the URL', async () => {
    routes[AUDIT] = () => page([entry('A-1', 'money')]);
    mount(<AuditLog />);
    await screen.findByText('Action A-1');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search the audit log' }), {
      target: { value: 'Latifa' },
    });
    // Debounced: nothing is sent for the keystroke itself.
    expect(lastTo(AUDIT)).toBe(AUDIT);
    await waitFor(() => expect(lastTo(AUDIT)).toBe(`${AUDIT}?q=Latifa`));
    expect(window.location.search).toBe('');
  });

  it('a filtered empty says what was looked for and Clear asks for the whole log', async () => {
    window.history.replaceState(null, '', '/audit?kind=access');
    routes[AUDIT] = (path) => (path.includes('kind=') ? page([]) : page([entry('A-1', 'money')]));
    mount(<AuditLog />);
    await screen.findByText('No Access entries yet.');
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear filters' })[0]!);
    await screen.findByText('Action A-1');
    expect(lastTo(AUDIT)).toBe(AUDIT);
    expect(window.location.search).toBe('');
  });
});

/* ================================================================ customers == */

describe('Customers → search', () => {
  const BOOK = '/salons/SAL-AMARA/customers';
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

  it('goes to the server as ?q=, stays out of the URL, and Clear restores the book', async () => {
    routes[BOOK] = (path) => (path.includes('q=') ? { items: [], nextCursor: null } : { items: [LATIFA], nextCursor: null });
    mount(<Customers />);
    await screen.findByText('Latifa A.');
    fireEvent.change(screen.getByRole('searchbox', { name: "Search this salon's customers by name or phone" }), {
      target: { value: '9912' },
    });
    await waitFor(() => expect(lastTo(BOOK)).toBe(`${BOOK}?q=9912`));
    expect(window.location.search).toBe('');
    await screen.findByText('No customers match “9912”');
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await screen.findByText('Latifa A.');
    expect(
      (screen.getByRole('searchbox', { name: "Search this salon's customers by name or phone" }) as HTMLInputElement)
        .value,
    ).toBe('');
  });
});
