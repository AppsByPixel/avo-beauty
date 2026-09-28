// @vitest-environment jsdom

/**
 * Settings → Branches → Hours (W8, the merchant half), and the salon's own
 * hours read-back.
 *
 *   - a branch on the salon's hours says "Using the salon's hours", read off the
 *     server's `businessHoursSource` rather than inferred;
 *   - setting its own hours PATCHes `{ businessHours: {…} }`; going back PATCHes
 *     `{ businessHours: null }`;
 *   - an evening with `to <= from` is NOT a window: it renders as "No evening
 *     session", never "21:00 – 21:00", and switching the evening off writes the
 *     established zero-length spelling rather than a key the schema lacks.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { fils, type Salon } from '@avo/types';
import { afterEach, describe, expect, it, vi } from 'vitest';

const authedRequest = vi.fn();
vi.mock('../auth/authedRequest.js', () => ({
  authedRequest: (...args: unknown[]) => authedRequest(...args),
}));
vi.mock('../auth/AuthProvider.js', () => ({
  useSalonId: () => 'SAL-AMARA',
  useSession: () => ({ perms: {} }),
}));

const { BranchesPanel, BusinessHoursPanel, HoursRows } = await import('./Settings.js');
const { salonKeys } = await import('../api/salon.js');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

type Hours = { morning: [string, string]; evening: [string, string] };
const SPLIT: Hours = { morning: ['10:00', '13:00'], evening: ['16:00', '21:00'] };
const STRAIGHT: Hours = { morning: ['10:00', '22:00'], evening: ['22:00', '22:00'] };

const SALMIYA = {
  id: 'BR-SAL',
  salonId: 'SAL-AMARA',
  name: 'Salmiya',
  nameAr: null,
  businessHours: SPLIT,
  businessHoursSource: 'salon' as const,
};
const KUWAIT_CITY = {
  id: 'BR-KWT',
  salonId: 'SAL-AMARA',
  name: 'Kuwait City',
  nameAr: null,
  businessHours: STRAIGHT,
  businessHoursSource: 'branch' as const,
};

const SALON: Salon = {
  id: 'SAL-AMARA',
  name: 'Amara',
  nameAr: null,
  plan: 'growth',
  city: 'Kuwait City',
  brandColor: '#6E7F6C',
  modules: { booking: true, shop: true },
  loyaltyMode: 'tiers',
  tiers: [{ name: 'bronze', minVisits: 0, bonusPercent: 0 }],
  stampRewardAr: null,
  depositFils: fils(5000),
  noShowReturnMinutes: 60,
  timezone: 'Asia/Kuwait',
  businessHours: SPLIT,
  branches: [SALMIYA, KUWAIT_CITY],
  social: [],
  whatsappEnabled: true,
  emailEnabled: true,
} as Salon;

function mount(salon: Salon = SALON) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(salonKeys.detail('SAL-AMARA'), salon);
  const view = render(
    <QueryClientProvider client={client}>
      <BranchesPanel salon={salon} />
    </QueryClientProvider>,
  );
  return { ...view, client };
}

const rowOf = (name: string) =>
  screen.getByText(name, { selector: '.settings__branch-name' }).closest('li') as HTMLElement;

const patches = () =>
  authedRequest.mock.calls.filter(([, , options]) => options?.method === 'PATCH');

describe('where a branch’s hours come from', () => {
  it('a branch on the salon’s hours says so', () => {
    mount();
    expect(rowOf('Salmiya').textContent).toContain('Using the salon’s hours');
  });

  it('a branch with its own hours shows them — with no phantom evening', () => {
    mount();
    const text = rowOf('Kuwait City').textContent ?? '';
    expect(text).toContain('Own hours · 10:00–22:00');
    expect(text).not.toContain('22:00–22:00');
    expect(text).not.toContain('Using the salon');
  });
});

describe('setting and clearing an override', () => {
  it('sets a branch’s own hours: PATCH { businessHours } with both sittings', async () => {
    authedRequest.mockResolvedValue({ ...SALMIYA, businessHours: {
      morning: ['10:00', '13:30'], evening: ['16:00', '21:00'] }, businessHoursSource: 'branch' });
    const { client } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Set the hours for Salmiya' }));
    const editor = screen.getByRole('group', { name: 'Hours for Salmiya' });
    expect(editor.textContent).toContain('is using the salon’s hours');
    // No "go back" offered to a branch that is already on the salon's hours.
    expect(within(editor).queryByRole('button', { name: 'Use the salon’s hours' })).toBeNull();

    fireEvent.click(within(editor).getByRole('button', { name: 'Increase Salmiya morning closes at' }));
    fireEvent.click(within(editor).getByRole('button', { name: 'Save hours' }));

    await waitFor(() => expect(patches()).toHaveLength(1));
    const [scope, path, options] = patches()[0]!;
    expect(scope).toBe('merchant');
    expect(path).toBe('/salons/SAL-AMARA/branches/BR-SAL');
    expect(options.body).toEqual({
      businessHours: { morning: ['10:00', '13:30'], evening: ['16:00', '21:00'] },
    });
    // The parsed answer lands in the salon the shell reads.
    await waitFor(() => {
      const cached = client.getQueryData<Salon>(salonKeys.detail('SAL-AMARA'));
      expect(cached?.branches.find((b) => b.id === 'BR-SAL')?.businessHoursSource).toBe('branch');
    });
  });

  it('open straight through: the evening switched off is written as a zero-length span', async () => {
    authedRequest.mockResolvedValue({ ...SALMIYA, businessHoursSource: 'branch' });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Set the hours for Salmiya' }));
    const editor = screen.getByRole('group', { name: 'Hours for Salmiya' });
    fireEvent.click(within(editor).getByRole('switch', { name: 'Evening session' }));
    expect(editor.textContent).toContain('Open straight through — no second sitting.');
    fireEvent.click(within(editor).getByRole('button', { name: 'Save hours' }));

    await waitFor(() => expect(patches()).toHaveLength(1));
    const sent = patches()[0]![2].body.businessHours as Hours;
    expect(sent.morning).toEqual(['10:00', '13:00']);
    // `to <= from` — the established "no second sitting", at the morning's close.
    expect(sent.evening).toEqual(['13:00', '13:00']);
  });

  it('clears an override back to the salon: PATCH { businessHours: null }', async () => {
    authedRequest.mockResolvedValue({ ...KUWAIT_CITY, businessHours: SPLIT, businessHoursSource: 'salon' });
    const { client } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Set the hours for Kuwait City' }));
    const editor = screen.getByRole('group', { name: 'Hours for Kuwait City' });
    // A branch open straight through opens its editor with the evening OFF.
    expect(within(editor).getByRole('switch', { name: 'Evening session' }).getAttribute('aria-checked')).toBe('false');
    fireEvent.click(within(editor).getByRole('button', { name: 'Use the salon’s hours' }));

    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]![2].body).toEqual({ businessHours: null });
    await waitFor(() => {
      const cached = client.getQueryData<Salon>(salonKeys.detail('SAL-AMARA'));
      expect(cached?.branches.find((b) => b.id === 'BR-KWT')?.businessHoursSource).toBe('salon');
    });
  });

  it('an unchanged override has nothing to save', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Set the hours for Kuwait City' }));
    const editor = screen.getByRole('group', { name: 'Hours for Kuwait City' });
    expect(within(editor).getByRole('button', { name: 'Save hours' })).toHaveProperty('disabled', true);
  });

  it('a refused save says the hours are unchanged, in the server’s words', async () => {
    const { ApiError } = await import('../api/client.js');
    authedRequest.mockRejectedValue(
      new ApiError("You don't have permission to change loyalty settings. A manager can grant it.", {
        status: 403,
        code: 'forbidden',
      }),
    );
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Set the hours for Salmiya' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save hours' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain("You don't have permission to change loyalty settings");
    expect(alert.textContent).toContain('Salmiya’s hours are unchanged.');
  });
});

describe('a zero-length evening is no evening session', () => {
  it('HoursRows renders "No evening session", not 22:00 – 22:00', () => {
    const { container } = render(<HoursRows hours={STRAIGHT} />);
    const text = container.textContent ?? '';
    expect(text).toContain('No evening session');
    expect(text).not.toMatch(/22:00\s*–\s*22:00/);
    expect(text).toMatch(/10:00\s*–\s*22:00/);
  });

  it('a split day renders both sittings', () => {
    const { container } = render(<HoursRows hours={SPLIT} />);
    expect(container.textContent).toMatch(/16:00\s*–\s*21:00/);
    expect(container.textContent).not.toContain('No evening session');
  });

  it('the salon panel drops the afternoon-closure sentence when there is no afternoon closure', () => {
    const straight = render(<BusinessHoursPanel salon={{ ...SALON, businessHours: STRAIGHT }} />);
    expect(straight.container.textContent).toContain('No evening session');
    expect(straight.container.textContent).not.toContain('Afternoon closure');
    cleanup();
    const split = render(<BusinessHoursPanel salon={SALON} />);
    expect(split.container.textContent).toContain('Afternoon closure — typical of Kuwait retail.');
  });
});
