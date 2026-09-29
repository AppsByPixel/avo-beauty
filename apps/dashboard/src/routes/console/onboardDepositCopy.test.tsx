// @vitest-environment jsdom

/**
 * CONSOLE → ONBOARD A SALON → THE BOOKING DEPOSIT ROW SAYS SOMETHING TRUE.
 *
 * It read "Auto-returned an hour after a missed slot" — the design's line, and
 * true only of a salon with no booking policy. A new salon has none (the window
 * defaults to 60 minutes), but the sentence outlives onboarding: once the salon
 * publishes a policy, a missed slot keeps or returns the deposit by that policy
 * (migration 0066). The row now says both halves.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const authedRequest = vi.fn(async (_s: string, path: string) => {
  if (path.startsWith('/v1/platform/salons')) return { items: [], nextCursor: null };
  throw new Error(`unrouted ${path}`);
});
vi.mock('../../auth/authedRequest.js', () => ({
  authedRequest: (...args: Parameters<typeof authedRequest>) => authedRequest(...args),
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

const { Salons } = await import('./Salons.js');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the onboarding wizard’s deposit row', () => {
  it('names the policy that replaces the hour, instead of promising the hour forever', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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

    expect(
      screen.getByText(
        'Returned an hour after a missed slot, until the salon publishes its booking policy',
      ),
    ).toBeTruthy();
    expect(screen.queryByText('Auto-returned an hour after a missed slot')).toBeNull();
  });
});
