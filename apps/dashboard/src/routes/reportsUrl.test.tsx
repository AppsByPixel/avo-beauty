// @vitest-environment jsdom

/**
 * MERCHANT → REPORTS — the window is in the URL.
 *
 * Reports already filtered every table SERVER-side (branch, period, a date range,
 * a comparison), and the export is built from the same `filters`. What it did
 * not do is survive Back or a shared link. These pin that the six keys
 * round-trip, that defaults leave the URL bare, and that what the cards ask the
 * server for is what the URL says.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authedRequest = vi.fn();
vi.mock('../auth/authedRequest.js', () => ({
  authedRequest: (...args: unknown[]) => authedRequest(...args),
}));
vi.mock('../auth/AuthProvider.js', () => ({
  useSalonId: () => 'SAL-AMARA',
  useSession: () => ({ perms: { dashboard: true } }),
}));
vi.mock('../api/salon.js', () => ({
  useSalon: () => ({
    isSuccess: true,
    isPending: false,
    isError: false,
    data: { id: 'SAL-AMARA', timezone: 'Asia/Kuwait', branches: [] },
  }),
}));
vi.mock('../shell/BranchScope.js', () => ({
  ALL_BRANCHES: 'all',
  useBranchScope: () => ({ selected: 'all', select: () => {}, selectedName: null, branches: [], status: 'ready' }),
}));

const { Reports, selectionFromUrl, selectionToUrl, DEFAULT_WINDOW_SELECTION } = await import('./Reports.js');

beforeEach(() => {
  window.history.replaceState(null, '', '/reports');
  authedRequest.mockImplementation(() => new Promise(() => {}));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Reports />
    </QueryClientProvider>,
  );
}

const reportPaths = () =>
  authedRequest.mock.calls
    .map(([, path]) => path as string)
    .filter((p) => p.startsWith('/salons/SAL-AMARA/reports/'));

describe('the report window in the URL', () => {
  it('the default window writes nothing', () => {
    expect(Object.values(selectionToUrl(DEFAULT_WINDOW_SELECTION)).every((v) => v === '')).toBe(true);
  });

  it('round-trips every key', () => {
    const s = {
      periodSeg: 'custom' as const,
      periodFrom: '2026-09-01',
      periodTo: '2026-09-15',
      compareSeg: 'dates' as const,
      compareFrom: '2026-08-01',
      compareTo: '2026-08-15',
    };
    expect(selectionFromUrl(selectionToUrl(s))).toEqual(s);
  });

  it('a shared ?period=7d asks every card for the week', async () => {
    window.history.replaceState(null, '', '/reports?period=7d');
    mount();
    await waitFor(() => expect(reportPaths().length).toBeGreaterThan(0));
    expect(reportPaths().every((p) => p.includes('period=7d'))).toBe(true);
  });

  it('choosing Quarter writes ?period=90d and asks for it; Back returns to the month', async () => {
    mount();
    await waitFor(() => expect(reportPaths().length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('radio', { name: 'Quarter' }));
    await waitFor(() => expect(window.location.search).toBe('?period=90d'));
    await waitFor(() => expect(reportPaths().some((p) => p.includes('period=90d'))).toBe(true));
    await act(async () => {
      window.history.back();
      await new Promise((r) => setTimeout(r, 30));
    });
    await waitFor(() =>
      expect((screen.getByRole('radio', { name: 'Month' }) as HTMLElement).getAttribute('aria-checked')).toBe('true'),
    );
  });
});
