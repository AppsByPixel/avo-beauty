// @vitest-environment jsdom

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SETTINGS → BUSINESS HOURS IS WHERE THE HOURS ARE EDITED, BRANCH BY BRANCH.
 * Aftab, 2026-09-29: "Business hours should be editable and branch wise".
 * ═══════════════════════════════════════════════════════════════════════════
 * The card is mounted over the REAL `useSalon` cache and the REAL write hooks;
 * `authedRequest` is the only stand-in, so every assertion is about what reaches
 * the wire and what the server's answer does to the screen.
 *
 *   1. A SELECTOR: "Salon default" and every branch, each showing its hours.
 *   2. SALON DEFAULT SAVES through `PATCH /salons/{id}` with `{ businessHours }`.
 *   3. A BRANCH SAVES through `PATCH /salons/{id}/branches/{bid}` — the same
 *      editor the Branches card opens — and "uses the salon's hours" is the
 *      server's `businessHoursSource`, before and after.
 *   4. A REFUSAL SAYS THE HOURS ARE UNCHANGED, in the server's words.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authedRequest = vi.fn();
vi.mock('../auth/authedRequest.js', () => ({
  authedRequest: (...args: unknown[]) => authedRequest(...args),
}));
vi.mock('../auth/AuthProvider.js', () => ({
  useSalonId: () => 'SAL-AMARA',
  useSession: () => ({ perms: { loyalty: true } }),
}));

const { BusinessHoursPanel } = await import('./Settings.js');
const { useSalon } = await import('../api/salon.js');

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

/** `serialiseSalon`'s shape — `parseSalon` runs over the PATCH answer. */
const SALON_BODY = {
  id: 'SAL-AMARA',
  name: 'Amara',
  nameAr: null,
  plan: 'growth',
  city: 'Kuwait City',
  brandColor: '#6E7F6C',
  modules: { booking: true, shop: true },
  loyaltyMode: 'tiers',
  tiers: [{ name: 'bronze', minVisits: 0, bonusPercent: 0 }],
  stampTarget: null,
  stampReward: null,
  stampRewardAr: null,
  depositFils: 5000,
  noShowReturnMinutes: 60,
  timezone: 'Asia/Kuwait',
  businessHours: SPLIT,
  branches: [SALMIYA, KUWAIT_CITY],
  social: [],
  whatsappEnabled: true,
  emailEnabled: true,
};

function Card() {
  const salon = useSalon();
  return <BusinessHoursPanel salon={salon.data} />;
}

beforeEach(() => {
  authedRequest.mockImplementation((_scope: string, path: string, options?: { method?: string }) => {
    if (options?.method === undefined && path === '/salons/SAL-AMARA') {
      return Promise.resolve(SALON_BODY);
    }
    return Promise.reject(new Error(`unexpected ${options?.method ?? 'GET'} ${path}`));
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <Card />
    </QueryClientProvider>,
  );
  return { ...view, client };
}

const patches = () =>
  authedRequest.mock.calls.filter(([, , options]) => options?.method === 'PATCH');

const scopeSelect = () => screen.getByLabelText('Hours for') as HTMLSelectElement;

describe('one card, every scope', () => {
  it('offers the salon default and every branch', async () => {
    mount();
    await screen.findByText('Business hours');
    const select = await waitFor(() => scopeSelect());
    expect([...select.options].map((o) => o.textContent)).toEqual([
      'Salon default',
      'Salmiya',
      'Kuwait City',
    ]);
    expect(select.value).toBe('salon');
  });

  it('a branch on the salon’s hours says so, from the server’s answer', async () => {
    mount();
    fireEvent.change(await waitFor(() => scopeSelect()), { target: { value: 'BR-SAL' } });
    expect(screen.getByText('Salmiya uses the salon’s hours.')).toBeTruthy();
  });

  it('a branch with its own hours shows them, with no phantom evening', async () => {
    const { container } = mount();
    fireEvent.change(await waitFor(() => scopeSelect()), { target: { value: 'BR-KWT' } });
    expect(screen.getByText('Kuwait City keeps its own hours.')).toBeTruthy();
    expect(container.textContent).toMatch(/10:00\s*–\s*22:00/);
    expect(container.textContent).toContain('No evening session');
  });
});

describe('the salon default is editable, and writable', () => {
  it('saves PATCH /salons/{id} with { businessHours }', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit the salon’s hours' }));
    const editor = screen.getByRole('group', { name: 'The salon’s hours' });
    const save = within(editor).getByRole('button', { name: 'Save hours' }) as HTMLButtonElement;
    // Nothing changed yet: nothing to save.
    expect(save.disabled).toBe(true);

    authedRequest.mockResolvedValueOnce({
      ...SALON_BODY,
      businessHours: { morning: ['10:00', '13:30'], evening: ['16:00', '21:00'] },
    });
    fireEvent.click(within(editor).getByRole('button', { name: 'Increase Salon morning closes at' }));
    fireEvent.click(save);

    await waitFor(() => expect(patches()).toHaveLength(1));
    const [, path, options] = patches()[0]!;
    expect(path).toBe('/salons/SAL-AMARA');
    expect(options.body).toEqual({
      businessHours: { morning: ['10:00', '13:30'], evening: ['16:00', '21:00'] },
    });
    // The editor closes on the server's answer, and the card reads it back.
    await waitFor(() => expect(screen.queryByRole('group', { name: 'The salon’s hours' })).toBeNull());
    expect(document.body.textContent).toMatch(/10:00\s*–\s*13:30/);
  });

  it('a refused save says the salon’s hours are unchanged, in the server’s words', async () => {
    const { ApiError } = await import('../api/client.js');
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit the salon’s hours' }));
    authedRequest.mockRejectedValueOnce(
      new ApiError("You don't have permission to change loyalty settings. A manager can grant it.", {
        status: 403,
        code: 'forbidden',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Increase Salon morning closes at' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save hours' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain("You don't have permission to change loyalty settings");
    expect(alert.textContent).toContain('The salon’s hours are unchanged.');
  });
});

describe('a branch is edited here with the Branches card’s own editor', () => {
  it('saves a branch’s own hours: PATCH /salons/{id}/branches/{bid}', async () => {
    mount();
    fireEvent.change(await waitFor(() => scopeSelect()), { target: { value: 'BR-SAL' } });
    fireEvent.click(screen.getByRole('button', { name: 'Edit the hours for Salmiya' }));
    const editor = screen.getByRole('group', { name: 'Hours for Salmiya' });

    authedRequest.mockResolvedValueOnce({
      ...SALMIYA,
      businessHours: { morning: ['10:00', '13:30'], evening: ['16:00', '21:00'] },
      businessHoursSource: 'branch',
    });
    fireEvent.click(within(editor).getByRole('button', { name: 'Increase Salmiya morning closes at' }));
    fireEvent.click(within(editor).getByRole('button', { name: 'Save hours' }));

    await waitFor(() => expect(patches()).toHaveLength(1));
    const [, path, options] = patches()[0]!;
    expect(path).toBe('/salons/SAL-AMARA/branches/BR-SAL');
    expect(options.body).toEqual({
      businessHours: { morning: ['10:00', '13:30'], evening: ['16:00', '21:00'] },
    });
    await screen.findByText('Salmiya keeps its own hours.');
  });

  it('sends a branch back to the salon’s hours: PATCH { businessHours: null }', async () => {
    mount();
    fireEvent.change(await waitFor(() => scopeSelect()), { target: { value: 'BR-KWT' } });
    fireEvent.click(screen.getByRole('button', { name: 'Edit the hours for Kuwait City' }));
    authedRequest.mockResolvedValueOnce({
      ...KUWAIT_CITY,
      businessHours: SPLIT,
      businessHoursSource: 'salon',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Use the salon’s hours' }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]![1]).toBe('/salons/SAL-AMARA/branches/BR-KWT');
    expect(patches()[0]![2].body).toEqual({ businessHours: null });
    await screen.findByText('Kuwait City uses the salon’s hours.');
  });
});
