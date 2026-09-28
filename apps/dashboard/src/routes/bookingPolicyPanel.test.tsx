// @vitest-environment jsdom

/**
 * Settings → Booking policy, mounted on the real Settings screen with the real
 * hooks. `authedRequest` is the only stand-in, so every assertion below is about
 * what went on the wire and what came back onto the screen.
 *
 *   GET /salons/{id}/booking-policy   → the panel's version line and draft
 *   PUT /salons/{id}/booking-policy   → noticesWritten / published: false
 *
 * `bookingPolicyRules.test.ts` holds the rules against the server's source; this
 * file holds the panel that applies them.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client.js';

const authedRequest = vi.fn();
vi.mock('../auth/authedRequest.js', () => ({
  authedRequest: (...args: unknown[]) => authedRequest(...args),
}));
const perms: Record<string, boolean> = { loyalty: true, dashboard: false };
vi.mock('../auth/AuthProvider.js', () => ({
  useSalonId: () => 'SAL-AMARA',
  useSession: () => ({ perms }),
}));

const { Settings } = await import('./Settings.js');

const HOURS = { morning: ['10:00', '13:00'], evening: ['16:00', '21:00'] };
const SALON_BODY = {
  id: 'SAL-AMARA',
  name: 'Amara',
  nameAr: null,
  plan: 'growth',
  city: 'Kuwait City',
  brandColor: '#7A5C8E',
  modules: { booking: true, shop: true },
  loyaltyMode: 'tiers',
  tiers: [{ name: 'bronze', minVisits: 0, bonusPercent: 0 }],
  stampTarget: null,
  stampReward: null,
  stampRewardAr: null,
  depositFils: 5000,
  noShowReturnMinutes: 60,
  timezone: 'Asia/Kuwait',
  businessHours: HOURS,
  branches: [
    {
      id: 'BR-SAL',
      salonId: 'SAL-AMARA',
      name: 'Salmiya',
      nameAr: null,
      businessHours: HOURS,
      businessHoursSource: 'salon',
    },
  ],
  social: [],
  whatsappEnabled: true,
  emailEnabled: true,
};

const POLICY = {
  id: 'BP-7',
  salonId: 'SAL-AMARA',
  version: 2,
  noShow: 'keep',
  cancellation: [
    { hoursBefore: 24, returnPercent: 100 },
    { hoursBefore: 2, returnPercent: 50 },
  ],
  text: { en: 'Cancel a day ahead for a full return.', ar: '' },
  publishedAt: '2026-09-29T09:05:00.000Z',
};

let policyBody: unknown = { policy: POLICY };
let putAnswer: () => Promise<unknown> = () => Promise.reject(new Error('no PUT expected'));

beforeEach(() => {
  perms.loyalty = true;
  policyBody = { policy: POLICY };
  authedRequest.mockImplementation((_scope: string, path: string, options?: { method?: string }) => {
    const method = options?.method ?? 'GET';
    if (method === 'GET' && path === '/salons/SAL-AMARA') return Promise.resolve(SALON_BODY);
    if (method === 'GET' && path === '/salons/SAL-AMARA/booking-policy') {
      return Promise.resolve(policyBody);
    }
    if (method === 'PUT' && path === '/salons/SAL-AMARA/booking-policy') return putAnswer();
    return Promise.reject(new Error(`unexpected ${method} ${path}`));
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
  return render(
    <QueryClientProvider client={client}>
      <Settings />
    </QueryClientProvider>,
  );
}

const puts = () =>
  authedRequest.mock.calls.filter(([, , options]) => (options as { method?: string })?.method === 'PUT');

const panel = async () => {
  const title = await screen.findByRole('heading', { name: 'Booking policy' });
  return title.closest('.settings__card') as HTMLElement;
};

describe('the panel reads the published policy', () => {
  it('shows the current version and when it was published, in the salon’s clock', async () => {
    mount();
    const card = await panel();
    await within(card).findByText(/^Version 2 · published /);
    // 09:05Z is 12:05 in Kuwait.
    expect(within(card).getByText(/^Version 2 · published /).textContent).toMatch(/12:05/);
    expect((within(card).getByLabelText('Cut-off 1: hours before the slot') as HTMLInputElement).value).toBe('24');
    expect(within(card).getByRole('radio', { name: 'Keep the deposit' }).getAttribute('aria-checked')).toBe('true');
  });

  it('previews the rule sentence as she edits', async () => {
    mount();
    const card = await panel();
    await within(card).findByText('Cancel 24h+ before: 100% back · 2h+: 50% back · later: nothing');
    fireEvent.change(within(card).getByLabelText('Cut-off 2: percent returned'), {
      target: { value: '25' },
    });
    expect(
      within(card).getByText('Cancel 24h+ before: 100% back · 2h+: 25% back · later: nothing'),
    ).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: 'Remove cut-off 2' }));
    expect(within(card).getByText('Cancel 24h+ before: 100% back · later: nothing')).toBeTruthy();
  });

  it('says a salon with no policy is on the full-return terms', async () => {
    policyBody = { policy: null };
    mount();
    const card = await panel();
    await within(card).findByText(
      'No policy published yet. Until you publish one, a cancel or a no-show returns her full deposit.',
    );
  });
});

describe('the form refuses what the server would, in the server’s words, before sending', () => {
  it('places an out-of-order cut-off on its row and does not PUT', async () => {
    mount();
    const card = await panel();
    await within(card).findByText(/^Version 2/);
    fireEvent.change(within(card).getByLabelText('Cut-off 2: hours before the slot'), {
      target: { value: '30' },
    });
    fireEvent.click(within(card).getByRole('button', { name: 'Publish policy' }));
    const row = within(card).getByLabelText('Cut-off 2: hours before the slot').closest('li')!;
    expect(within(row).getByRole('alert').textContent).toContain(
      'List the cancellation rules from the earliest cut-off to the latest',
    );
    expect(puts()).toHaveLength(0);
    expect(within(card).getByText('Fix the cut-offs above to see the rule.')).toBeTruthy();
  });

  it('requires the English text', async () => {
    mount();
    const card = await panel();
    await within(card).findByText(/^Version 2/);
    fireEvent.change(within(card).getByLabelText('Policy text (English)'), { target: { value: ' ' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Publish policy' }));
    expect(within(card).getByText('The policy needs its English text.')).toBeTruthy();
    expect(puts()).toHaveLength(0);
  });

  it('counts the English text against 1000 and tells her Arabic may be left empty', async () => {
    mount();
    const card = await panel();
    await within(card).findByText(/^Version 2/);
    expect(within(card).getAllByText(/\/ 1000/)[0]!.textContent).toBe(
      `${POLICY.text.en.length} / 1000`,
    );
    expect(within(card).getByText('Leave empty to show the English text.')).toBeTruthy();
  });
});

describe('a server 400 goes back onto the row it names', () => {
  it('shows the server’s message verbatim under that row', async () => {
    putAnswer = () =>
      Promise.reject(
        new ApiError('A later cancellation cannot return more (server says).', {
          status: 400,
          code: 'return_percent_increasing',
          details: { index: 1 },
        }),
      );
    mount();
    const card = await panel();
    await within(card).findByText(/^Version 2/);
    fireEvent.change(within(card).getByLabelText('Policy text (English)'), {
      target: { value: 'Changed.' },
    });
    fireEvent.click(within(card).getByRole('button', { name: 'Publish policy' }));
    const row = within(card).getByLabelText('Cut-off 2: percent returned').closest('li')!;
    await waitFor(() =>
      expect(within(row).getByRole('alert').textContent).toBe(
        'A later cancellation cannot return more (server says).',
      ),
    );
    expect(within(card).getByLabelText('Cut-off 2: percent returned').getAttribute('aria-invalid')).toBe('true');
  });
});

describe('publishing says what the server did', () => {
  it('sends the whole policy to PUT and says how many customers were notified', async () => {
    putAnswer = () =>
      Promise.resolve({
        policy: { ...POLICY, id: 'BP-8', version: 3, text: { en: 'Changed.', ar: '' } },
        published: true,
        noticesWritten: 14,
      });
    mount();
    const card = await panel();
    await within(card).findByText(/^Version 2/);
    fireEvent.change(within(card).getByLabelText('Policy text (English)'), {
      target: { value: '  Changed.  ' },
    });
    fireEvent.click(within(card).getByRole('button', { name: 'Publish policy' }));
    await within(card).findByText(/14 customers notified/);
    expect(within(card).getByRole('status').textContent).toBe(
      'Version 3 published. 14 customers notified. Notices go to the wallet bell only, at most one a day.',
    );
    expect(puts()).toHaveLength(1);
    expect((puts()[0]![2] as { body: unknown }).body).toEqual({
      noShow: 'keep',
      cancellation: POLICY.cancellation,
      text: { en: 'Changed.', ar: '' },
    });
    // The new version is what the panel now says it holds.
    await within(card).findByText(/^Version 3 · published /);
  });

  it('says "1 customer", not "1 customers"', async () => {
    putAnswer = () =>
      Promise.resolve({ policy: { ...POLICY, version: 3 }, published: true, noticesWritten: 1 });
    mount();
    const card = await panel();
    await within(card).findByText(/^Version 2/);
    fireEvent.click(within(card).getByRole('radio', { name: 'Return it to her wallet' }));
    fireEvent.click(within(card).getByRole('button', { name: 'Publish policy' }));
    await within(card).findByText(/1 customer notified\./);
  });

  it('an identical body publishes nothing, and it says so rather than claiming a change', async () => {
    putAnswer = () => Promise.resolve({ policy: POLICY, published: false, noticesWritten: 0 });
    mount();
    const card = await panel();
    await within(card).findByText(/^Version 2/);
    fireEvent.click(within(card).getByRole('button', { name: 'Publish policy' }));
    const status = await within(card).findByRole('status');
    expect(status.textContent).toBe(
      'Nothing changed. This is already the published policy (version 2), so nothing was published and no customers were notified.',
    );
    expect(status.textContent).not.toMatch(/published\./);
  });
});

describe('perms.loyalty gates the edit — the read stays', () => {
  it('without it, the panel is read-only and says why', async () => {
    perms.loyalty = false;
    mount();
    const card = await panel();
    await within(card).findByText(
      'You can read this policy but not change it — changing it needs the loyalty permission. A manager can grant it.',
    );
    expect(within(card).getByText('Keep the deposit')).toBeTruthy();
    expect(
      within(card).getByText('Cancel 24h+ before: 100% back · 2h+: 50% back · later: nothing'),
    ).toBeTruthy();
    expect(within(card).queryByRole('button', { name: 'Publish policy' })).toBeNull();
    expect(within(card).queryByRole('textbox')).toBeNull();
    expect(puts()).toHaveLength(0);
  });

  it('a 403 on the PUT renders the server’s sentence and says nothing was published', async () => {
    putAnswer = () =>
      Promise.reject(
        new ApiError("You don't have permission to change loyalty settings. A manager can grant it.", {
          status: 403,
          code: 'forbidden',
        }),
      );
    mount();
    const card = await panel();
    await within(card).findByText(/^Version 2/);
    fireEvent.click(within(card).getByRole('radio', { name: 'Return it to her wallet' }));
    fireEvent.click(within(card).getByRole('button', { name: 'Publish policy' }));
    const alert = await within(card).findByText(/You don't have permission to change loyalty settings/);
    expect(alert.closest('[role="alert"]')?.textContent).toContain('Nothing was published.');
    expect(within(card).queryByRole('status')).toBeNull();
  });
});
