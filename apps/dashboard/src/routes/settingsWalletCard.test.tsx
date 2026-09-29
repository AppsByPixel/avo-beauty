// @vitest-environment jsdom

/**
 * Merchant → Settings → Wallet card: tier colours, or the salon's own colour.
 *
 * Aftab, 2026-09-29: "if … that workspace has a dark green theme chosen then it
 * should override this tier coloring for that workspace." Trunk's fd6edc8 made
 * that a stored choice — `Salon.walletCard: 'tier' | 'brand'`, default `tier` —
 * rather than something keyed off the hex, so any theme can keep its colour.
 *
 * WHAT THIS FILE PINS
 *   - the choice sends `walletCard` through `PATCH /salons/{id}`, and nothing else
 *   - without `perms.loyalty` it is read-only and says why
 *   - a server refusal renders verbatim, and the choice does not move
 *   - saving is a visible state, and the control cannot be pressed twice
 *   - the preview follows the choice, painted from the token file
 *
 * WHAT IT DOES NOT: that the API accepts the key. At the time of writing Lane A
 * is adding `walletCard` to `MERCHANT_EDITABLE` in parallel, and today's API
 * answers `400 not_editable` — which is exactly the refusal the third spec
 * renders. The code is lane A's to name; this panel renders the sentence whatever
 * the code, so nothing here depends on it.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { brandPresets, deriveBrandSet, tier } from '@avo/tokens';
import { fils, type Salon } from '@avo/types';

const authedRequest = vi.fn();
vi.mock('../auth/authedRequest.js', () => ({
  authedRequest: (...args: unknown[]) => authedRequest(...args),
}));
vi.mock('../auth/AuthProvider.js', () => ({
  useSalonId: () => 'SAL-AMARA',
  useSession: () => ({ perms: { loyalty: true, dashboard: true } }),
}));

const { WalletCardPanel } = await import('./Settings.js');
const { ApiError } = await import('../api/client.js');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const FOREST = brandPresets.forest.brand;

const SALON: Salon = {
  id: 'SAL-AMARA',
  name: 'Amara',
  nameAr: 'أمارا',
  plan: 'growth',
  city: 'Kuwait City',
  brandColor: FOREST,
  walletCard: 'tier',
  modules: { booking: false, shop: false },
  loyaltyMode: 'tiers',
  tiers: [
    { name: 'bronze', minVisits: 0, bonusPercent: 0 },
    { name: 'silver', minVisits: 4, bonusPercent: 10 },
    { name: 'gold', minVisits: 10, bonusPercent: 20 },
    { name: 'black', minVisits: 20, bonusPercent: 30 },
  ],
  depositFils: fils(5000),
  noShowReturnMinutes: 60,
  timezone: 'Asia/Kuwait',
  businessHours: { morning: ['10:00', '13:00'], evening: ['16:00', '21:00'] },
  branches: [],
  social: [],
  whatsappEnabled: true,
  emailEnabled: true,
} as unknown as Salon;

function renderPanel(salon: Salon | undefined, canEdit = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrap = (node: ReactNode) => <QueryClientProvider client={client}>{node}</QueryClientProvider>;
  const view = render(wrap(<WalletCardPanel salon={salon} canEdit={canEdit} />));
  return { ...view, rerenderWith: (next: Salon) => view.rerender(wrap(<WalletCardPanel salon={next} canEdit={canEdit} />)) };
}

const option = (name: 'Tier colours' | 'Our colour') => screen.getByRole('radio', { name });

describe('the wallet card setting', () => {
  it('offers the two choices, with the server’s value selected', () => {
    renderPanel(SALON);
    expect(option('Tier colours').getAttribute('aria-checked')).toBe('true');
    expect(option('Our colour').getAttribute('aria-checked')).toBe('false');
  });

  it('skeletons until the salon arrives, and offers nothing to press', () => {
    renderPanel(undefined);
    expect(screen.queryByRole('radio')).toBeNull();
  });

  /**
   * THE WIRE. One key, `walletCard`, through the one door `brandColor` uses —
   * not a pair, and not the whole salon echoed back.
   */
  it('sends walletCard through PATCH /salons/{id}, and nothing else', async () => {
    authedRequest.mockReturnValue(new Promise(() => {}));
    renderPanel(SALON);
    fireEvent.click(option('Our colour'));
    await waitFor(() => expect(authedRequest).toHaveBeenCalledTimes(1));
    expect(authedRequest).toHaveBeenCalledWith('merchant', '/salons/SAL-AMARA', {
      method: 'PATCH',
      body: { walletCard: 'brand' },
    });
  });

  /**
   * SAVING IS A STATE. No optimistic flip — the selection stays on the server's
   * value until the server says otherwise, for `ModuleRow`'s reason — and both
   * segments are disabled so a second press cannot race the first.
   */
  it('shows that it is saving, holds the server’s value, and cannot be pressed twice', async () => {
    authedRequest.mockReturnValue(new Promise(() => {}));
    renderPanel(SALON);
    fireEvent.click(option('Our colour'));
    expect(await screen.findByText('Saving…')).toBeTruthy();
    expect(option('Tier colours').getAttribute('aria-checked')).toBe('true');
    expect((option('Our colour') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(option('Our colour'));
    expect(authedRequest).toHaveBeenCalledTimes(1);
  });

  it('does not write when the choice is already the stored one', () => {
    renderPanel(SALON);
    fireEvent.click(option('Tier colours'));
    expect(authedRequest).not.toHaveBeenCalled();
  });

  /**
   * THE REFUSAL, VERBATIM. Lane A names the code for a bad value; today's API
   * answers `not_editable`. Either way the sentence is the server's, it sits on
   * this card rather than at the foot of the screen, and the choice has not moved.
   */
  it('renders the server’s refusal verbatim, on the card, and the choice does not move', async () => {
    authedRequest.mockRejectedValue(
      new ApiError('That is not a wallet card setting. Choose tier or brand.', {
        status: 400,
        code: 'invalid_wallet_card',
      }),
    );
    renderPanel(SALON);
    fireEvent.click(option('Our colour'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('That is not a wallet card setting. Choose tier or brand.');
    expect(alert.textContent).toContain('That setting is unchanged.');
    expect(option('Tier colours').getAttribute('aria-checked')).toBe('true');
  });

  it('renders today’s not_editable refusal the same way', async () => {
    authedRequest.mockRejectedValue(
      new ApiError('These fields cannot be edited here: walletCard.', {
        status: 400,
        code: 'not_editable',
      }),
    );
    renderPanel(SALON);
    fireEvent.click(option('Our colour'));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'These fields cannot be edited here: walletCard.',
    );
  });

  /**
   * READ-ONLY, NOT HIDDEN, AND IT SAYS WHY. The same gate as the brand —
   * `PATCH /salons/{id}` is `perms.loyalty` — and the server refuses without
   * it whatever this does. Non-negotiable #7: a courtesy, stated as one.
   */
  it('is read-only without the permission, says why, and never writes', () => {
    renderPanel(SALON, false);
    expect(
      screen.getByText(
        'You can see this setting but not change it — changing it needs the loyalty permission. A manager can grant it.',
      ),
    ).toBeTruthy();
    for (const name of ['Tier colours', 'Our colour'] as const) {
      expect((option(name) as HTMLButtonElement).disabled).toBe(true);
    }
    expect(option('Tier colours').getAttribute('aria-checked')).toBe('true');
    fireEvent.click(option('Our colour'));
    expect(authedRequest).not.toHaveBeenCalled();
  });
});

describe('the preview follows the choice', () => {
  const preview = () => screen.getByRole('figure');
  const cards = () => within(preview()).getAllByTestId('wallet-card-preview-card');

  it('paints silver as silver and gold as gold under “Tier colours”', () => {
    renderPanel(SALON);
    expect(preview().getAttribute('data-source')).toBe('tier');
    const [silver, gold] = cards();
    expect(silver?.getAttribute('data-fill')).toBe('silver');
    expect(silver?.style.getPropertyValue('--wcard-from')).toBe(tier.silver.cardFrom);
    expect(silver?.style.getPropertyValue('--wcard-to')).toBe(tier.silver.cardTo);
    expect(gold?.getAttribute('data-fill')).toBe('gold');
    expect(gold?.style.getPropertyValue('--wcard-from')).toBe(tier.gold.cardFrom);
    expect(gold?.style.getPropertyValue('--wcard-to')).toBe(tier.gold.cardTo);
  });

  it('paints every card in the salon’s own gradient under “Our colour”', () => {
    const { rerenderWith } = renderPanel(SALON);
    rerenderWith({ ...SALON, walletCard: 'brand' });
    expect(preview().getAttribute('data-source')).toBe('brand');
    const derived = deriveBrandSet(FOREST);
    if (!derived.ok) throw new Error('forest must derive');
    for (const card of cards()) {
      expect(card.getAttribute('data-fill')).toBe('brand');
      expect(card.style.getPropertyValue('--wcard-from')).toBe(derived.set.cardFrom);
      expect(card.style.getPropertyValue('--wcard-to')).toBe(derived.set.cardTo);
    }
  });

  /**
   * STAMPS MODE HAS NO TIER TO PAINT. The wallet draws a stamps salon's card in
   * its brand whatever this says (`apps/wallet/src/theme/cardInk.ts`), so the
   * preview does too, and the card says so rather than showing a metal nobody
   * will see.
   */
  it('shows the brand card for a stamps salon, and says why', () => {
    renderPanel({ ...SALON, loyaltyMode: 'stamps' } as Salon);
    expect(preview().getAttribute('data-source')).toBe('brand');
    expect(
      screen.getByText('Your salon uses stamps, so every card shows your colour.'),
    ).toBeTruthy();
  });
});
