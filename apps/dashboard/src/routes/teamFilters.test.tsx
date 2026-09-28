// @vitest-environment jsdom

/**
 * MERCHANT → ACCOUNTS (team), TEAM (artists) and SERVICES — their filters.
 *
 * All three rosters are served WHOLE (`nextCursor: null`, no LIMIT — `GET /staff`,
 * `GET /salons/{id}/artists`, `GET /salons/{id}/services`), so every filter here
 * is applied in the browser and the assertion that matters beside "it narrows"
 * is that it asks the server nothing new. Each screen is mounted whole with its
 * real hooks; `authedRequest` is the only stand-in.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authedRequest = vi.fn();
vi.mock('../auth/authedRequest.js', () => ({
  authedRequest: (...args: unknown[]) => authedRequest(...args),
}));
const perms = { team: true, loyalty: true, dashboard: true };
vi.mock('../auth/AuthProvider.js', () => ({
  useSalonId: () => 'SAL-AMARA',
  useSession: () => ({ staffId: 'ST-001', salonId: 'SAL-AMARA', perms }),
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
const BRANCHES = [
  { id: 'BR-SAL', name: 'Salmiya' },
  { id: 'BR-KWT', name: 'Kuwait City' },
];
vi.mock('../api/salon.js', () => ({
  useSalon: () => ({ data: { id: 'SAL-AMARA', timezone: 'Asia/Kuwait', branches: BRANCHES } }),
}));

const { Accounts } = await import('./Accounts.js');
const { Team } = await import('./Team.js');
const { Services } = await import('./Services.js');

const PERMS = {
  dashboard: true,
  appointments: true,
  shop: false,
  loyalty: false,
  team: false,
  scanner: true,
  charges: false,
  void: false,
  marketing: false,
};
const staff = (id: string, name: string, handle: string, over: Record<string, unknown> = {}) => ({
  id,
  salonId: 'SAL-AMARA',
  name,
  handle,
  role: 'frontdesk',
  branchAccess: 'all',
  pinSet: true,
  passwordSet: true,
  active: true,
  deactivatedAt: null,
  perms: PERMS,
  ...over,
});
const STAFF = [
  staff('ST-001', 'Noura Al-Sabah', 'noura', { role: 'owner', perms: { ...PERMS, team: true } }),
  staff('ST-002', 'Hessa Al-Mutairi', 'hessa', { branchAccess: ['BR-SAL'] }),
  staff('ST-003', 'Dana Yousef', 'dana', { role: 'artist', branchAccess: ['BR-KWT'] }),
  staff('ST-004', 'Mona Karim', 'mona', {
    role: 'artist',
    branchAccess: ['BR-SAL'],
    active: false,
    deactivatedAt: '2026-08-01T00:00:00.000Z',
  }),
];

const artist = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id,
  salonId: 'SAL-AMARA',
  name,
  nameAr: null,
  hasOwnLogin: false,
  active: true,
  branchId: null,
  availabilitySource: 'manual',
  googleConnected: false,
  slotMinutes: 30,
  windows: {},
  ...over,
});
const ARTISTS = [
  artist('AR-1', 'Noura', { branchId: 'BR-SAL', availabilitySource: 'google', googleConnected: true }),
  artist('AR-2', 'Dana', { branchId: 'BR-KWT' }),
  artist('AR-3', 'Rana'),
];

const service = (id: string, name: string, artistIds: string[], nameAr: string | null = null) => ({
  id,
  salonId: 'SAL-AMARA',
  name,
  nameAr,
  priceFils: 8500,
  active: true,
  image: null,
  artistIds,
});
const SERVICES = [
  service('SV-1', 'Blow-dry', ['AR-1'], 'تجفيف'),
  service('SV-2', 'Brow shape', []),
  service('SV-3', 'Balayage', ['AR-1', 'AR-2']),
];

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  authedRequest.mockImplementation((_s: string, path: string) => {
    if (path === '/staff') return Promise.resolve({ items: STAFF, nextCursor: null });
    if (path === '/salons/SAL-AMARA/artists') return Promise.resolve({ items: ARTISTS, nextCursor: null });
    if (path === '/salons/SAL-AMARA/services') return Promise.resolve({ items: SERVICES, nextCursor: null });
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

const paths = () => authedRequest.mock.calls.map(([, path]) => path as string);
const searchFor = (label: string, value: string) =>
  fireEvent.change(screen.getByRole('searchbox', { name: label }), { target: { value } });
const back = () =>
  act(async () => {
    window.history.back();
    await new Promise((r) => setTimeout(r, 30));
  });

/* ============================================================ team accounts == */

const accountNames = () =>
  Array.from(document.querySelectorAll('.account__name')).map((el) => el.textContent);

describe('Accounts → Team', () => {
  it('search narrows by name or username', async () => {
    window.history.replaceState(null, '', '/accounts');
    mount(<Accounts />);
    await screen.findByText('Noura Al-Sabah');
    searchFor('Search team accounts by name or username', 'hessa');
    await waitFor(() => expect(accountNames()).toEqual(['Hessa Al-Mutairi']));
    expect(screen.getByText('1 of 4 accounts')).toBeTruthy();
    await waitFor(() => expect(window.location.search).toBe('?q=hessa'));
  });

  it('role narrows, and branch keeps everyone who CAN work there — all-branch accounts included', async () => {
    mount(<Accounts />);
    await screen.findByText('Noura Al-Sabah');
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by role' }), { target: { value: 'artist' } });
    await waitFor(() => expect(accountNames()).toEqual(['Dana Yousef', 'Mona Karim']));
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by role' }), { target: { value: '' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by branch' }), { target: { value: 'BR-SAL' } });
    await waitFor(() =>
      expect(accountNames()).toEqual(['Noura Al-Sabah', 'Hessa Al-Mutairi', 'Mona Karim']),
    );
    expect(window.location.search).toBe('?branch=BR-SAL');
  });

  it('standing separates the current team from leavers', async () => {
    mount(<Accounts />);
    await screen.findByText('Noura Al-Sabah');
    fireEvent.click(screen.getByRole('radio', { name: 'Left the team' }));
    await waitFor(() => expect(accountNames()).toEqual(['Mona Karim']));
  });

  it('a shared URL opens filtered; Clear restores all four and the URL; Back undoes the clear', async () => {
    window.history.replaceState(null, '', '/accounts?role=owner');
    mount(<Accounts />);
    await waitFor(() => expect(accountNames()).toEqual(['Noura Al-Sabah']));
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(accountNames()).toHaveLength(4));
    expect(window.location.search).toBe('');
    await back();
    await waitFor(() => expect(accountNames()).toEqual(['Noura Al-Sabah']));
  });

  it('no match names the thing and offers the escape', async () => {
    window.history.replaceState(null, '', '/accounts?q=zzz');
    mount(<Accounts />);
    await screen.findByText('No team accounts match these filters');
    expect(screen.queryByText('No team accounts')).toBeNull();
  });

  it('never asks the server again — the roster is whole', async () => {
    mount(<Accounts />);
    await screen.findByText('Noura Al-Sabah');
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by role' }), { target: { value: 'owner' } });
    searchFor('Search team accounts by name or username', 'nou');
    await waitFor(() => expect(window.location.search).toContain('q=nou'));
    expect(paths()).toEqual(['/staff']);
  });

  it('a branch id that is not this salon’s is ignored, not applied', async () => {
    window.history.replaceState(null, '', '/accounts?branch=BR-NOT-OURS');
    mount(<Accounts />);
    await screen.findByText('Noura Al-Sabah');
    expect(accountNames()).toHaveLength(4);
  });
});

/* ================================================================== artists == */

const artistNames = () =>
  Array.from(document.querySelectorAll('.team-card__name')).map((el) => el.textContent);

describe('Team (artists)', () => {
  it('search, branch and availability each narrow, and none asks the server', async () => {
    mount(<Team />);
    await screen.findByText('Rana');
    searchFor('Search artists by name', 'dan');
    await waitFor(() => expect(artistNames()).toEqual(['Dana']));
    searchFor('Search artists by name', '');
    await waitFor(() => expect(artistNames()).toHaveLength(3));
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by branch' }), { target: { value: 'unassigned' } });
    await waitFor(() => expect(artistNames()).toEqual(['Rana']));
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by branch' }), { target: { value: '' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Google Calendar' }));
    await waitFor(() => expect(artistNames()).toEqual(['Noura']));
    expect(paths()).toEqual(['/salons/SAL-AMARA/artists']);
  });

  it('round-trips the URL and clears back to the whole roster', async () => {
    window.history.replaceState(null, '', '/team?branch=BR-KWT');
    mount(<Team />);
    await waitFor(() => expect(artistNames()).toEqual(['Dana']));
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(artistNames()).toHaveLength(3));
    expect(window.location.search).toBe('');
  });

  it('no match says so', async () => {
    window.history.replaceState(null, '', '/team?q=nobody');
    mount(<Team />);
    await screen.findByText('No artists match these filters');
  });
});

/* ================================================================= services == */

const serviceNames = () =>
  screen
    .queryAllByLabelText(/^Service name/)
    .map((el) => (el as HTMLInputElement).value);

describe('Services', () => {
  it('search matches the English or the Arabic name', async () => {
    mount(<Services />);
    await screen.findByDisplayValue('Balayage');
    searchFor('Search services by name', 'bro');
    await waitFor(() => expect(serviceNames()).toEqual(['Brow shape']));
    searchFor('Search services by name', 'تجفيف');
    await waitFor(() => expect(serviceNames()).toEqual(['Blow-dry']));
  });

  it('"No one assigned" finds the services nobody can be booked for', async () => {
    mount(<Services />);
    await screen.findByDisplayValue('Balayage');
    fireEvent.click(screen.getByRole('radio', { name: 'No one assigned' }));
    await waitFor(() => expect(serviceNames()).toEqual(['Brow shape']));
    expect(window.location.search).toBe('?booking=unassigned');
  });

  it('"Done by" narrows to one artist’s services', async () => {
    mount(<Services />);
    await screen.findByDisplayValue('Balayage');
    const select = await screen.findByRole('combobox', { name: 'Done by' });
    fireEvent.change(select, { target: { value: 'AR-2' } });
    await waitFor(() => expect(serviceNames()).toEqual(['Balayage']));
  });

  it('Clear restores the menu; the whole thing was read once', async () => {
    window.history.replaceState(null, '', '/services?booking=bookable&q=bal');
    mount(<Services />);
    await waitFor(() => expect(serviceNames()).toEqual(['Balayage']));
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(serviceNames()).toEqual(['Blow-dry', 'Brow shape', 'Balayage']));
    expect(window.location.search).toBe('');
    expect(paths().filter((p) => p === '/salons/SAL-AMARA/services')).toHaveLength(1);
  });

  it('no match says so, and not "No services yet"', async () => {
    window.history.replaceState(null, '', '/services?q=nails');
    mount(<Services />);
    await screen.findByText('No services match these filters');
    expect(screen.queryByText(/No services yet/)).toBeNull();
  });
});
