// @vitest-environment jsdom

/**
 * Merchant → Services (M7), rendered whole against a mocked `authedRequest`.
 *
 * WHAT THIS PINS, in the brief's order:
 *
 *   - add / edit / retire / assign each send the body the route accepts, and
 *     nothing else;
 *   - each control is hidden from a reader without ITS OWN permission — loyalty
 *     for the price, team for the staff — and when a write is made anyway (a
 *     permission revoked while the screen is open) the server's 403 sentence is
 *     what she reads;
 *   - KD becomes integer fils exactly: 8.5 → 8500, 8.500 → 8500, 8.5005 refused
 *     before any request, and no float appears in the path that converts it;
 *   - the price-change sentence is on screen BEFORE the PATCH, not after;
 *   - `artistIds: []` reads "Not bookable yet — assign staff".
 *
 * The screen is mounted, not a reproduction of it: the permission split and
 * the request bodies are the subject, and a copy in the test would pin the copy
 * in the test.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stripComments } from '../testing/stripComments.js';

const authedRequest = vi.fn();
vi.mock('../auth/authedRequest.js', () => ({
  authedRequest: (...args: unknown[]) => authedRequest(...args),
}));

const perms = { loyalty: true, team: true };
vi.mock('../auth/AuthProvider.js', () => ({
  useSalonId: () => 'SAL-AMARA',
  useSession: () => ({ perms }),
}));

const { ApiError } = await import('../api/client.js');
const { Services } = await import('./Services.js');
const { NAV_ITEMS } = await import('../shell/navItems.js');

/* ================================================================= fixtures == */

const service = (over: Record<string, unknown>) => ({
  salonId: 'SAL-AMARA',
  nameAr: null,
  active: true,
  image: null,
  artistIds: [],
  ...over,
});

const BLOW_DRY = service({ id: 'SV-1', name: 'Blow-dry', priceFils: 8500, artistIds: ['AR-1'] });
const BROWS = service({ id: 'SV-2', name: 'Brow shape', priceFils: 4000, artistIds: [] });

const artist = (id: string, name: string, active = true) => ({
  id,
  salonId: 'SAL-AMARA',
  name,
  nameAr: null,
  hasOwnLogin: false,
  active,
  branchId: null,
  availabilitySource: 'manual',
  googleConnected: false,
  slotMinutes: 30,
  windows: {},
});

const ROSTER = [artist('AR-1', 'Noura'), artist('AR-2', 'Dana'), artist('AR-3', 'Rana', false)];

type Handler = (path: string, options: { method?: string; body?: unknown }) => unknown;

let services: Record<string, unknown>[];
let onWrite: Handler;

function route(_scope: string, path: string, options: { method?: string; body?: unknown } = {}) {
  const method = options.method ?? 'GET';
  if (method === 'GET' && path === '/salons/SAL-AMARA/services') {
    return Promise.resolve({ items: services, nextCursor: null });
  }
  if (method === 'GET' && path === '/salons/SAL-AMARA/artists') {
    return Promise.resolve({ items: ROSTER, nextCursor: null });
  }
  try {
    return Promise.resolve(onWrite(path, options));
  } catch (error) {
    return Promise.reject(error);
  }
}

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <Services />
    </QueryClientProvider>,
  );
}

const writes = () =>
  authedRequest.mock.calls.filter(([, , options]) => (options?.method ?? 'GET') !== 'GET');

const reads = (path: string) =>
  authedRequest.mock.calls.filter(
    ([, p, options]) => p === path && (options?.method ?? 'GET') === 'GET',
  );

beforeEach(() => {
  perms.loyalty = true;
  perms.team = true;
  services = [BLOW_DRY, BROWS];
  onWrite = () => {
    throw new Error('unexpected write');
  };
  authedRequest.mockImplementation(route);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const rowOf = async (name: string) => {
  const input = await screen.findByLabelText<HTMLInputElement>(`Price in KD — ${name}`);
  return input.closest('.services__item') as HTMLElement;
};

/* ==================================================================== nav == */

describe('the Services section is a real section', () => {
  it('has a built nav entry at /services', () => {
    const item = NAV_ITEMS.find((i) => i.id === 'services');
    expect(item).toMatchObject({ to: '/services', built: true, title: 'Services' });
  });

  it('router.tsx mounts the Services screen at that path', () => {
    const router = stripComments(readFileSync(join(__dirname, '..', 'router.tsx'), 'utf8'));
    expect(router).toContain("{ path: '/services', component: Services }");
  });
});

/* ================================================================= bodies == */

describe('each write sends the body its route accepts', () => {
  it('add: name, Arabic name and integer fils — and the new row says nobody can book it', async () => {
    onWrite = (path, options) => {
      expect(path).toBe('/salons/SAL-AMARA/services');
      expect(options.method).toBe('POST');
      return service({ id: 'SV-3', ...(options.body as object), artistIds: [] });
    };
    mount();
    fireEvent.click(await screen.findByRole('button', { name: '+ Add service' }));
    fireEvent.change(screen.getByLabelText('New service name'), { target: { value: ' Gel nails ' } });
    fireEvent.change(screen.getByLabelText('New service Arabic name'), {
      target: { value: 'أظافر جل' },
    });
    fireEvent.change(screen.getByLabelText('New service price in KD'), { target: { value: '8.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]![2]).toEqual({
      method: 'POST',
      body: { name: 'Gel nails', nameAr: 'أظافر جل', priceFils: 8500 },
    });
    const row = await rowOf('Gel nails');
    expect(row.textContent).toContain('Not bookable yet — assign staff');
  });

  it('add: a blank Arabic name is not sent at all', async () => {
    onWrite = (_path, options) => service({ id: 'SV-3', ...(options.body as object) });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: '+ Add service' }));
    fireEvent.change(screen.getByLabelText('New service name'), { target: { value: 'Gel nails' } });
    fireEvent.change(screen.getByLabelText('New service price in KD'), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]![2].body).toEqual({ name: 'Gel nails', priceFils: 12000 });
  });

  it('edit: a reprice sends priceFils only, as integer fils', async () => {
    onWrite = (path, options) => {
      expect(path).toBe('/salons/SAL-AMARA/services/SV-1');
      return { ...BLOW_DRY, ...(options.body as object) };
    };
    mount();
    fireEvent.change(await screen.findByLabelText('Price in KD — Blow-dry'), {
      target: { value: '9.250' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]![2]).toEqual({ method: 'PATCH', body: { priceFils: 9250 } });
    // The row settles on what the server stored.
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLInputElement>('Price in KD — Blow-dry').value).toBe('9.250'),
    );
  });

  it('edit: an emptied Arabic name is sent as null — the English-name fallback', async () => {
    services = [{ ...BLOW_DRY, nameAr: 'تجفيف' }];
    onWrite = (_p, options) => ({ ...BLOW_DRY, ...(options.body as object) });
    mount();
    fireEvent.change(await screen.findByLabelText('Arabic name — Blow-dry'), {
      target: { value: '  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]![2].body).toEqual({ nameAr: null });
  });

  it('retire: confirms first, says what happens to live bookings, then DELETEs', async () => {
    onWrite = (path, options) => {
      expect(path).toBe('/salons/SAL-AMARA/services/SV-1');
      expect(options).toEqual({ method: 'DELETE' });
      return undefined;
    };
    mount();
    fireEvent.click(await screen.findByLabelText('Retire Blow-dry'));
    expect(writes()).toHaveLength(0);

    const confirm = screen.getByRole('group', { name: 'Retire Blow-dry?' });
    const text = confirm.textContent ?? '';
    expect(text).toMatch(/disappears from new bookings and from the counter basket/);
    expect(text).toMatch(/already booked for it stay booked and still complete at the counter/);
    expect(text).not.toMatch(/delete/i);

    fireEvent.click(within(confirm).getByRole('button', { name: 'Retire service' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    await waitFor(() => expect(screen.queryByLabelText('Price in KD — Blow-dry')).toBeNull());
  });

  it('assign: PUTs the whole set for that service', async () => {
    onWrite = (path, options) => {
      expect(path).toBe('/salons/SAL-AMARA/services/SV-2/artists');
      return { ...BROWS, ...(options.body as object) };
    };
    mount();
    const row = await rowOf('Brow shape');
    await waitFor(() =>
      expect(within(row).getByRole('button', { name: 'Assign staff' })).not.toHaveProperty(
        'disabled',
        true,
      ),
    );
    fireEvent.click(within(row).getByRole('button', { name: 'Assign staff' }));
    const panel = screen.getByRole('group', { name: 'Staff for Brow shape' });
    fireEvent.click(within(panel).getByRole('switch', { name: 'Dana' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Save staff' }));

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]![2]).toEqual({ method: 'PUT', body: { artistIds: ['AR-2'] } });
    await waitFor(() => expect(row.textContent).toContain('Done by Dana'));
  });

  it('assign: ids she did not touch go back as they came — retired and unknown included', async () => {
    services = [service({ id: 'SV-4', name: 'Keratin', priceFils: 30000, artistIds: ['AR-9', 'AR-3'] })];
    onWrite = (_p, options) => ({ ...services[0], ...(options.body as object) });
    mount();
    const row = await rowOf('Keratin');
    // Assigned only to a retired artist and an id the roster does not know.
    await waitFor(() =>
      expect(row.textContent).toContain('Not bookable — only retired staff are assigned'),
    );
    fireEvent.click(within(row).getByRole('button', { name: 'Assign staff' }));
    const panel = screen.getByRole('group', { name: 'Staff for Keratin' });
    expect(within(panel).getByRole('switch', { name: 'Rana (retired)' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    fireEvent.click(within(panel).getByRole('switch', { name: 'Noura' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Save staff' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect([...(writes()[0]![2].body.artistIds as string[])].sort()).toEqual(['AR-1', 'AR-3', 'AR-9']);
  });
});

/* ============================================================ permissions == */

describe('each control answers to its own permission', () => {
  it('team without loyalty: can assign, cannot add, reprice or retire', async () => {
    perms.loyalty = false;
    mount();
    const priceText = await screen.findAllByLabelText('8.500 Kuwaiti dinars');
    expect(priceText.length).toBeGreaterThan(0);

    expect(screen.queryByRole('button', { name: '+ Add service' })).toBeNull();
    expect(screen.queryByLabelText('Price in KD — Blow-dry')).toBeNull();
    expect(screen.queryByLabelText('Service name — Blow-dry')).toBeNull();
    expect(screen.queryByLabelText('Retire Blow-dry')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Assign staff' })).toHaveLength(2);
    expect(document.body.textContent).toContain('Adding, pricing and retiring them needs the Loyalty permission');
  });

  it('loyalty without team: can price, cannot assign — and the roster is never requested', async () => {
    perms.team = false;
    mount();
    await screen.findByLabelText('Price in KD — Blow-dry');
    expect(screen.getByRole('button', { name: '+ Add service' })).not.toBeNull();
    expect(screen.getByLabelText('Retire Blow-dry')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Assign staff' })).toBeNull();
    expect(reads('/salons/SAL-AMARA/artists')).toHaveLength(0);
    // Without the roster it counts rather than names — and still flags the empty one.
    const blowDry = await rowOf('Blow-dry');
    expect(blowDry.textContent).toContain('1 staff member assigned');
    const brows = await rowOf('Brow shape');
    expect(brows.textContent).toContain('Not bookable yet — assign staff');
  });

  it('neither: the menu is still readable, with nothing to press', async () => {
    perms.loyalty = false;
    perms.team = false;
    mount();
    await screen.findAllByLabelText('8.500 Kuwaiti dinars');
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  const LOYALTY_403 = new ApiError(
    "You don't have permission to change loyalty settings. A manager can grant it.",
    { status: 403, code: 'forbidden' },
  );
  const TEAM_403 = new ApiError(
    "You don't have permission to manage the team. A manager can grant it.",
    { status: 403, code: 'forbidden' },
  );

  it('a reprice the server refuses says so in its words, and that the old price stands', async () => {
    onWrite = () => {
      throw LOYALTY_403;
    };
    mount();
    fireEvent.change(await screen.findByLabelText('Price in KD — Blow-dry'), {
      target: { value: '9' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    const alert = await screen.findByText(/You don't have permission to change loyalty settings/);
    expect(alert.closest('[role="alert"]')?.textContent).toContain(
      'Blow-dry is unchanged — the counter still charges 8.500 KD.',
    );
  });

  it('an add the server refuses says so, and that nothing was added', async () => {
    onWrite = () => {
      throw LOYALTY_403;
    };
    mount();
    fireEvent.click(await screen.findByRole('button', { name: '+ Add service' }));
    fireEvent.change(screen.getByLabelText('New service name'), { target: { value: 'Gel' } });
    fireEvent.change(screen.getByLabelText('New service price in KD'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    const alert = await screen.findByText(/You don't have permission to change loyalty settings/);
    expect(alert.closest('[role="alert"]')?.textContent).toContain('No service was added.');
  });

  it('a retire the server refuses says the service is still on the menu', async () => {
    onWrite = () => {
      throw LOYALTY_403;
    };
    mount();
    fireEvent.click(await screen.findByLabelText('Retire Blow-dry'));
    fireEvent.click(screen.getByRole('button', { name: 'Retire service' }));
    const alert = await screen.findByText(/You don't have permission to change loyalty settings/);
    expect(alert.closest('[role="alert"]')?.textContent).toContain('still on the menu');
  });

  it('an assignment the server refuses says so in its words', async () => {
    onWrite = () => {
      throw TEAM_403;
    };
    mount();
    const row = await rowOf('Brow shape');
    await waitFor(() =>
      expect(within(row).getByRole('button', { name: 'Assign staff' })).toHaveProperty('disabled', false),
    );
    fireEvent.click(within(row).getByRole('button', { name: 'Assign staff' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Dana' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save staff' }));
    const alert = await screen.findByText(/You don't have permission to manage the team/);
    expect(alert.closest('[role="alert"]')?.textContent).toContain('Nobody’s assignment changed.');
  });

  it('a service retired under her is named as such, not as our failure', async () => {
    onWrite = () => {
      throw new ApiError('No such service.', { status: 404, code: 'unknown_service' });
    };
    mount();
    fireEvent.change(await screen.findByLabelText('Price in KD — Blow-dry'), {
      target: { value: '9' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    const alert = await screen.findByText(/no longer on the menu/);
    expect(alert.textContent).not.toMatch(/on our side/);
  });
});

/* ================================================================= money == */

describe('KD becomes integer fils exactly', () => {
  async function typeDraftPrice(value: string) {
    onWrite = (_p, options) => service({ id: 'SV-3', ...(options.body as object) });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: '+ Add service' }));
    fireEvent.change(screen.getByLabelText('New service name'), { target: { value: 'Gel' } });
    fireEvent.change(screen.getByLabelText('New service price in KD'), { target: { value } });
  }

  it.each([
    ['8.5', 8500],
    ['8.500', 8500],
    ['1.005', 1005], // 1.005 * 1000 is 1004.9999999999999 in floating point
    ['0.001', 1],
    ['120', 120000],
  ])('%s KD is sent as %i fils', async (typed, expected) => {
    await typeDraftPrice(typed);
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    const sent = writes()[0]![2].body.priceFils as number;
    expect(sent).toBe(expected);
    expect(Number.isInteger(sent)).toBe(true);
  });

  it.each(['8.5005', '8.5001', '1e3', '0', '0.000', '-2'])(
    '%s is refused before any request, not rounded',
    async (typed) => {
      await typeDraftPrice(typed);
      expect(screen.getByRole('button', { name: 'Add' })).toHaveProperty('disabled', true);
      fireEvent.click(screen.getByRole('button', { name: 'Add' }));
      expect(writes()).toHaveLength(0);
    },
  );

  it('a four-decimal reprice is refused on the row, with no Save to press', async () => {
    mount();
    fireEvent.change(await screen.findByLabelText('Price in KD — Blow-dry'), {
      target: { value: '8.5005' },
    });
    expect(screen.getByRole('alert').textContent).toMatch(/up to 3 decimals/);
    expect(screen.getByRole('button', { name: 'Save changes' })).toHaveProperty('disabled', true);
    expect(writes()).toHaveLength(0);
  });

  it('no float touches the conversion — the path is parseKwdInput, never parseFloat or × 1000', () => {
    const files = ['routes/Services.tsx', 'api/services.ts', 'api/products.ts'].map((f) =>
      stripComments(readFileSync(join(__dirname, '..', f), 'utf8')),
    );
    for (const src of files) {
      expect(src).not.toMatch(/parseFloat|Number\.parseFloat|toFixed|\*\s*1000|\*\s*FILS_PER_KWD/);
    }
    expect(files[2]).toContain('parseKwdInput(');
    expect(files[0]).toContain('readPriceInput(');
  });
});

/* ======================================================= what she is told == */

describe('what a price change does is said before she saves', () => {
  it('renders the sentence as soon as the price differs — with no PATCH sent yet', async () => {
    mount();
    fireEvent.change(await screen.findByLabelText('Price in KD — Blow-dry'), {
      target: { value: '9' },
    });
    const group = screen.getByRole('group', { name: 'Save changes to Blow-dry' });
    const text = group.textContent ?? '';
    expect(text).toMatch(/Past charges and booking deposits don’t change/);
    expect(text).toMatch(/A basket that hasn’t been paid at the counter yet will be charged the new price/);
    expect(within(group).getByLabelText('8.500 Kuwaiti dinars')).not.toBeNull();
    expect(within(group).getByLabelText('9.000 Kuwaiti dinars')).not.toBeNull();
    expect(writes()).toHaveLength(0);
  });

  it('a rename alone does not claim the price moved', async () => {
    mount();
    fireEvent.change(await screen.findByLabelText('Service name — Blow-dry'), {
      target: { value: 'Blow-dry & style' },
    });
    const group = screen.getByRole('group', { name: 'Save changes to Blow-dry' });
    expect(group.textContent).not.toMatch(/basket/);
  });

  it('typing the price back to what it was is not a change', async () => {
    mount();
    const price = await screen.findByLabelText('Price in KD — Blow-dry');
    fireEvent.change(price, { target: { value: '9' } });
    fireEvent.change(price, { target: { value: '8.5' } });
    expect(screen.queryByRole('group', { name: 'Save changes to Blow-dry' })).toBeNull();
  });
});

describe('a service nobody is assigned to says so', () => {
  it('artistIds: [] reads "not bookable yet" on the row, and a staffed one names its staff', async () => {
    mount();
    const brows = await rowOf('Brow shape');
    expect(brows.textContent).toContain('Not bookable yet — assign staff');
    const blowDry = await rowOf('Blow-dry');
    await waitFor(() => expect(blowDry.textContent).toContain('Done by Noura'));
    expect(blowDry.textContent).not.toContain('Not bookable');
  });
});

/* ================================================================ states == */

describe('the four states', () => {
  it('empty is its own state', async () => {
    services = [];
    mount();
    expect(await screen.findByText('No services yet — add your first.')).not.toBeNull();
    expect(screen.getByText('0 services on the menu')).not.toBeNull();
  });

  it('pending paints rows, not a zero', () => {
    authedRequest.mockImplementation(() => new Promise(() => {}));
    const { container } = mount();
    expect(container.querySelectorAll('.avo-skeleton').length).toBeGreaterThan(0);
    expect(container.textContent).not.toMatch(/0 services/);
  });

  it('offline says so, and offers a retry', async () => {
    authedRequest.mockImplementation(() =>
      Promise.reject(new ApiError('offline', { status: 0, code: 'offline', offline: true })),
    );
    mount();
    expect(await screen.findByText('No connection')).not.toBeNull();
    expect(screen.getByRole('button', { name: /try again/i })).not.toBeNull();
  });

  it('a malformed list is a failed read, not a menu', async () => {
    services = [{ ...BLOW_DRY, priceFils: 8.5 }];
    mount();
    expect(await screen.findByText("Couldn't load the services")).not.toBeNull();
  });
});
