// @vitest-environment jsdom

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MERCHANT → CUSTOMERS → ONE CARD → RECENT ACTIVITY FOLDS. Aftab, 2026-09-29:
 * "activity part is huge".
 * ═══════════════════════════════════════════════════════════════════════════
 * Lane B's wallet fold (544a4b8) is the precedent: the newest five, then ONE
 * control that reads "Show all" / "Show less" and says `aria-expanded`, so focus
 * stays on it across the toggle. "Show more" — the next server page — is a
 * separate control and is only offered where its answer can be seen.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth/AuthProvider.js', () => ({ useSalonId: () => 'SAL-AMARA' }));

const { History, HISTORY_FOLD } = await import('./Customers.js');
type HistoryProps = Parameters<typeof History>[0];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function item(n: number) {
  return {
    id: `TX-${n}`,
    stream: 'transaction' as const,
    at: new Date(Date.UTC(2026, 8, 28 - n, 9, 0)).toISOString(),
    who: 'Latifa A.',
    memberId: 'MB-1',
    salonId: 'SAL-AMARA',
    what: `charge number ${n}`,
    kind: 'charge',
    amountFils: -1000,
  };
}

function history(count: number, hasNextPage = false) {
  return {
    isError: false,
    isPending: false,
    error: null,
    isFetching: false,
    isFetchingNextPage: false,
    hasNextPage,
    fetchNextPage: vi.fn(),
    refetch: vi.fn(),
    data: { pages: [{ items: Array.from({ length: count }, (_, i) => item(i)), nextCursor: null }] },
  } as unknown as HistoryProps['history'];
}

function mount(h: HistoryProps['history']) {
  return render(<History history={h} timezone="Asia/Kuwait" suppressed={false} />);
}

const rows = () => document.querySelectorAll('.cust-card__feed-row');

describe('the fold', () => {
  it('opens on the newest five, with "Show all"', () => {
    mount(history(12));
    expect(HISTORY_FOLD).toBe(5);
    expect(rows()).toHaveLength(5);
    expect(screen.getByText('charge number 0')).toBeTruthy();
    expect(screen.queryByText('charge number 5')).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Show all' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('unfolds and folds back with ONE control whose label and state change', () => {
    mount(history(12));
    const toggle = screen.getByRole('button', { name: 'Show all' });
    fireEvent.click(toggle);
    expect(rows()).toHaveLength(12);
    // The same element, not a replacement — focus would otherwise be lost.
    expect(screen.getByRole('button', { name: 'Show less' })).toBe(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-controls')).toBe(document.querySelector('.cust-card__feed')!.id);
    fireEvent.click(toggle);
    expect(rows()).toHaveLength(5);
    expect(toggle.textContent).toBe('Show all');
  });

  it('draws no fold for five or fewer', () => {
    mount(history(5));
    expect(rows()).toHaveLength(5);
    expect(screen.queryByRole('button', { name: 'Show all' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show less' })).toBeNull();
  });
});

describe('"Show more" is the server’s next page, and a different control', () => {
  it('is not offered while folded — its rows would land out of sight', () => {
    mount(history(12, true));
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(screen.getByRole('button', { name: 'Show more' })).toBeTruthy();
  });

  it('is offered on a short first page, so it is never a dead end', () => {
    const h = history(3, true);
    mount(h);
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(h.fetchNextPage).toHaveBeenCalledTimes(1);
  });
});
