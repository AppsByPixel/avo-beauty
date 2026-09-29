// @vitest-environment jsdom

/**
 * CONSOLE → ONBOARD A SALON → STEP 3 → THE WALLET CARD, BESIDE THE BRAND.
 *
 * `Salon.walletCard` (trunk, fd6edc8) decides whether the wallet's main card
 * takes the member's tier metal or the salon's own colour. The wizard is the one
 * console surface where a brand is chosen, so the choice sits beside it.
 *
 *   - Forest is drawn, because the swatches are the token file's presets
 *   - the default sends no key — absent means `tier` on the server, and today's
 *     `parseOnboardInput` refuses a key it does not know
 *   - "Our colour" sends `walletCard: 'brand'`, and the review says so
 *   - the preview follows the choice AND the swatch
 *   - the wallet card's own refusal comes back to its field, verbatim
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { brandPresets, deriveBrandSet, tier } from '@avo/tokens';

type Call = [string, string, { method?: string; body?: Record<string, unknown> }?];
const authedRequest = vi.fn(async (..._args: Call): Promise<unknown> => {
  throw new Error('unrouted');
});
vi.mock('../../auth/authedRequest.js', () => ({
  authedRequest: (...args: Call) => authedRequest(...args),
}));
vi.mock('../../auth/AuthProvider.js', () => ({
  useConsoleSections: () => ({ salons: true, controls: false }),
  useSession: () => ({ adminId: 'AD-1', perms: {} }),
  useSalonId: () => 'SAL-AMARA',
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a>,
  useNavigate: () => vi.fn(),
}));

const { Salons, WALLET_CARD_REFUSAL } = await import('./Salons.js');
const { ApiError } = await import('../../api/client.js');

const CREATED = {
  salon: { id: 'SAL-NOOR', name: 'Noor Studio', city: 'Salmiya', brandColor: brandPresets.forest.brand },
  owner: { staffId: 'ST-9', name: 'Owner', handle: '@noor.owner', role: 'owner', passwordSet: false },
  invite: { channel: 'whatsapp', to: '+96599124408', expiresAt: '2026-10-06T00:00:00Z', delivered: false },
};

function route(onCreate: (body: Record<string, unknown>) => unknown) {
  authedRequest.mockImplementation(async (_scope, path, init) => {
    if (path === '/v1/platform/salons' && init?.method === 'POST') return onCreate(init.body ?? {});
    if (path.startsWith('/v1/platform/salons')) return { items: [], nextCursor: null };
    throw new Error(`unrouted ${path}`);
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function toStep3() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Salons />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: '+ Onboard a salon' }));
  fireEvent.change(screen.getByLabelText('Salon name'), { target: { value: 'Noor Studio' } });
  fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Salmiya' } });
  fireEvent.change(screen.getByLabelText('Owner contact (WhatsApp)'), {
    target: { value: '+96599124408' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
}

const walletGroup = () => screen.getByRole('radiogroup', { name: 'Wallet card' });
const createPosts = () =>
  authedRequest.mock.calls.filter(([, path, init]) => path === '/v1/platform/salons' && init?.method === 'POST');

describe('the onboarding wizard’s wallet card', () => {
  it('draws the Forest swatch, read from the token file', async () => {
    route(() => CREATED);
    await toStep3();
    const brand = screen.getByRole('radiogroup', { name: 'Brand colour' });
    expect(within(brand).getByRole('radio', { name: brandPresets.forest.brand })).toBeTruthy();
    expect(within(brand).getAllByRole('radio')).toHaveLength(Object.keys(brandPresets).length);
  });

  it('starts on “Tier colours”, and a default onboarding sends no walletCard key', async () => {
    route(() => CREATED);
    await toStep3();
    expect(within(walletGroup()).getByRole('radio', { name: 'Tier colours' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('Tier colours')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create salon & send invite' }));
    await waitFor(() => expect(createPosts()).toHaveLength(1));
    expect(createPosts()[0]?.[2]?.body).not.toHaveProperty('walletCard');
  });

  it('sends walletCard: brand for “Our colour”, with the forest brand, and the review says so', async () => {
    route(() => CREATED);
    await toStep3();
    fireEvent.click(screen.getByRole('radio', { name: brandPresets.forest.brand }));
    fireEvent.click(within(walletGroup()).getByRole('radio', { name: 'Our colour' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('Our colour')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create salon & send invite' }));
    await waitFor(() => expect(createPosts()).toHaveLength(1));
    expect(createPosts()[0]?.[2]?.body).toMatchObject({
      brandColor: brandPresets.forest.brand,
      walletCard: 'brand',
    });
  });

  it('previews the metals under “Tier colours” and the chosen swatch under “Our colour”', async () => {
    route(() => CREATED);
    await toStep3();
    const cards = () => within(screen.getByRole('figure')).getAllByTestId('wallet-card-preview-card');
    expect(cards()[1]?.style.getPropertyValue('--wcard-from')).toBe(tier.gold.cardFrom);

    fireEvent.click(screen.getByRole('radio', { name: brandPresets.forest.brand }));
    fireEvent.click(within(walletGroup()).getByRole('radio', { name: 'Our colour' }));
    const forest = deriveBrandSet(brandPresets.forest.brand);
    if (!forest.ok) throw new Error('forest must derive');
    for (const card of cards()) {
      expect(card.style.getPropertyValue('--wcard-from')).toBe(forest.set.cardFrom);
      expect(card.style.getPropertyValue('--wcard-to')).toBe(forest.set.cardTo);
    }
  });

  it('brings the wallet card’s refusal back to its field, verbatim', async () => {
    route(() => {
      throw new ApiError('walletCard must be tier or brand.', { status: 400, code: WALLET_CARD_REFUSAL });
    });
    await toStep3();
    fireEvent.click(within(walletGroup()).getByRole('radio', { name: 'Our colour' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create salon & send invite' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('walletCard must be tier or brand.');
    // Back on step 3, beside the control that caused it.
    expect(walletGroup()).toBeTruthy();
  });

  it('renders a refusal it does not know on review, still verbatim', async () => {
    route(() => {
      throw new ApiError('These fields cannot be set when onboarding a salon: walletCard.', {
        status: 400,
        code: 'not_settable_here',
      });
    });
    await toStep3();
    fireEvent.click(within(walletGroup()).getByRole('radio', { name: 'Our colour' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create salon & send invite' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'These fields cannot be set when onboarding a salon: walletCard.',
    );
  });
});
