// @vitest-environment jsdom

/**
 * HER WALLET REFRESHES AFTER SHE PAYS — driven through the real hooks.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * A charge is made on the salon's scanner, so this phone is never told of one.
 * Before this slice nothing re-read Home after a charge: the balance on screen
 * was the one read before she walked to the counter. The re-read now happens
 * when the payment code closes, when the app returns to the foreground, and on
 * pull-to-refresh, through ONE throttled gate (`useWalletRefresh`).
 *
 * `useWalletHome` and `useWalletRefresh` are mounted together, as App.tsx
 * mounts them, over a mocked `api/wallet`. The foreground is the real
 * react-native-web `AppState`, which reads the Page Visibility API, so the test
 * flips `document.visibilityState` and fires `visibilitychange` exactly as a
 * browser returning to the tab would. Time is `Date.now`, stubbed, because the
 * gate is a function of it.
 *
 *   1. closing the payment code re-reads, and the balance is the server's
 *   2. returning to the foreground re-reads
 *   3. a second event inside the throttle window does not
 *   4. a re-read that fails keeps the last balance and lands on `stale`
 *   5. the Upcoming card follows the same re-read, quietly
 * ═════════════════════════════════════════════════════════════════════════════
 */

import fs from 'node:fs';
import path from 'node:path';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getMember, getSalon, getTransactions, getPromotions, getBookings } = vi.hoisted(() => ({
  getMember: vi.fn(),
  getSalon: vi.fn(),
  getTransactions: vi.fn(),
  getPromotions: vi.fn(),
  getBookings: vi.fn(),
}));

vi.mock('../api/wallet', () => ({ getMember, getSalon, getTransactions, getPromotions }));
vi.mock('../api/booking', () => ({ getBookings, cancelBooking: vi.fn() }));
vi.mock('./cache', () => ({
  readSnapshot: vi.fn(async () => null),
  writeSnapshot: vi.fn(async () => undefined),
}));
vi.mock('./brandCache', () => ({ cacheBrandColor: vi.fn(async () => undefined) }));

/* eslint-disable import/first */
import { ApiError } from '../api/client';
import { useWalletHome } from './useWalletHome';
import { REFRESH_MIN_INTERVAL_MS, createRefreshGate, useWalletRefresh } from './useWalletRefresh';
import { useUpcoming } from './useBooking';
/* eslint-enable import/first */

/** Only the fields `loadSnapshot` reads; the snapshot is passed through whole. */
function member(balanceFils: number, tier = 'silver') {
  return { id: '8842', salonId: 'SAL-AMARA', name: 'Latifa Al-Sabah', balanceFils, tier };
}
const SALON = { id: 'SAL-AMARA', brandColor: '#8A6A4F', branches: [], modules: { booking: true } };

let clock = 0;
let visibility: DocumentVisibilityState = 'visible';

function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event('visibilitychange'));
}

/** Leave, come back — one `background → active` transition. */
function foreground() {
  act(() => {
    setVisibility('hidden');
    setVisibility('visible');
  });
}

function mountWallet() {
  return renderHook(() => {
    const home = useWalletHome();
    const refresh = useWalletRefresh(home);
    return { home, refresh };
  });
}

async function mountReady(balance = 24500) {
  getMember.mockResolvedValueOnce(member(balance));
  const hook = mountWallet();
  await waitFor(() => expect(hook.result.current.home.status).toBe('ready'));
  expect(getMember).toHaveBeenCalledTimes(1);
  // Past the window the mount load primed, so the first event is not throttled.
  clock += REFRESH_MIN_INTERVAL_MS + 1;
  return hook;
}

const balanceOf = (h: ReturnType<typeof mountWallet>) =>
  h.result.current.home.snapshot?.member.balanceFils;

beforeEach(() => {
  vi.clearAllMocks();
  clock = 1_800_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
  visibility = 'visible';
  getSalon.mockResolvedValue(SALON);
  getTransactions.mockResolvedValue([]);
  getPromotions.mockResolvedValue({ boosts: {}, boostsPublishedAt: null, boostsPublishedBy: null, happy: [] });
  getBookings.mockResolvedValue([]);
});

afterEach(() => {
  // No vitest globals here, so testing-library does not unmount on its own — and a
  // harness left mounted keeps its AppState listener, which the next test's
  // foreground would wake.
  cleanup();
  vi.restoreAllMocks();
});

describe('closing the payment code re-reads the wallet', () => {
  it('re-reads GET /members/me and shows the balance the SERVER now holds', async () => {
    const hook = await mountReady(24500);
    // The cashier charged 3.000 on the scanner. Only the server knows.
    getMember.mockResolvedValueOnce(member(21500));

    // What App.tsx's `PaymentCodeLayer onClose` calls.
    let started = false;
    act(() => {
      started = hook.result.current.refresh.requestRefresh();
    });

    expect(started).toBe(true);
    await waitFor(() => expect(balanceOf(hook)).toBe(21500));
    expect(getMember).toHaveBeenCalledTimes(2);
    // The salon and activity are re-read with it — the new charge row, the tier.
    expect(getTransactions).toHaveBeenCalledTimes(2);
    expect(hook.result.current.home.status).toBe('ready');
  });

  it('App.tsx wires the close of the enlarged code to that re-read', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', '..', 'App.tsx'), 'utf8');
    const layer = app.slice(app.indexOf('<PaymentCodeLayer'));
    const onClose = layer.slice(layer.indexOf('onClose={'), layer.indexOf('/>'));
    expect(onClose).toContain('setPayRequested(false)');
    expect(onClose).toContain('walletRefresh.requestRefresh()');
  });
});

describe('returning to the foreground re-reads the wallet', () => {
  it('re-reads on background → active and shows the new balance', async () => {
    const hook = await mountReady(24500);
    getMember.mockResolvedValueOnce(member(21500, 'gold'));

    foreground();

    await waitFor(() => expect(balanceOf(hook)).toBe(21500));
    expect(getMember).toHaveBeenCalledTimes(2);
    // Tier from the server too, never evaluated here.
    expect(hook.result.current.home.snapshot?.member.tier).toBe('gold');
  });

  it('does not re-read on a change that is not a return to active', async () => {
    await mountReady();
    act(() => setVisibility('hidden'));
    expect(getMember).toHaveBeenCalledTimes(1);
  });
});

describe('the throttle', () => {
  it('drops a second event inside the window, and lets one through after it', async () => {
    const hook = await mountReady(24500);
    getMember.mockResolvedValue(member(21500));

    // She closes the code: one re-read.
    act(() => {
      hook.result.current.refresh.requestRefresh();
    });
    await waitFor(() => expect(balanceOf(hook)).toBe(21500));
    expect(getMember).toHaveBeenCalledTimes(2);

    // A second later iOS flips inactive → active for the lock screen. No read.
    clock += 1_000;
    foreground();
    let pulled = true;
    act(() => {
      pulled = hook.result.current.refresh.requestRefresh();
    });
    expect(pulled).toBe(false);
    expect(getMember).toHaveBeenCalledTimes(2);

    // Past the window, the next event reads again.
    clock += REFRESH_MIN_INTERVAL_MS;
    foreground();
    await waitFor(() => expect(getMember).toHaveBeenCalledTimes(3));
  });

  it('the first event after mount is inside the window the mount load opened', async () => {
    getMember.mockResolvedValueOnce(member(24500));
    const hook = mountWallet();
    await waitFor(() => expect(hook.result.current.home.status).toBe('ready'));
    clock += 500;
    foreground();
    expect(getMember).toHaveBeenCalledTimes(1);
  });

  it('is a pure function of time', () => {
    const pass = createRefreshGate(3_000, 0);
    expect(pass(2_999)).toBe(false);
    expect(pass(3_000)).toBe(true);
    expect(pass(4_000)).toBe(false);
    expect(pass(6_000)).toBe(true);
  });
});

describe('a re-read that fails', () => {
  it('keeps the last good balance and shows stale — never an empty wallet', async () => {
    const hook = await mountReady(24500);
    const fetchedAt = hook.result.current.home.fetchedAt;
    getMember.mockRejectedValueOnce(
      new ApiError('server', 'Something went wrong.', 'WLT-0001-0002', 500),
    );

    foreground();

    await waitFor(() => expect(hook.result.current.home.status).toBe('stale'));
    expect(balanceOf(hook)).toBe(24500);
    expect(hook.result.current.home.snapshot).not.toBeNull();
    // The "last updated" the banner names is still the last GOOD read.
    expect(hook.result.current.home.fetchedAt).toBe(fetchedAt);
    expect(hook.result.current.home.refreshing).toBe(false);
  });

  it('offline keeps the wallet and lands on offline, as a Try again always has', async () => {
    const hook = await mountReady(24500);
    getMember.mockRejectedValueOnce(new ApiError('offline', 'No connection.', 'WLT-0000-0000', null));

    foreground();

    await waitFor(() => expect(hook.result.current.home.status).toBe('offline'));
    expect(balanceOf(hook)).toBe(24500);
  });
});

describe('the Upcoming card follows the same re-read', () => {
  const HELD = [{ id: 'BK-1', status: 'deposit_held' }];

  it('re-reads when the key moves, without going back to the skeleton', async () => {
    getBookings.mockResolvedValueOnce(HELD);
    const hook = renderHook(({ k }) => useUpcoming({ enabled: true, onChanged: () => {}, refreshKey: k }), {
      initialProps: { k: 0 },
    });
    await waitFor(() => expect(hook.result.current.status).toBe('ready'));

    // The charge applied her deposit, so the booking is no longer held.
    let resolve: (v: unknown[]) => void = () => {};
    getBookings.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    hook.rerender({ k: 1 });
    expect(hook.result.current.status).toBe('ready');
    expect(hook.result.current.bookings).toEqual(HELD);

    await act(async () => resolve([]));
    expect(getBookings).toHaveBeenCalledTimes(2);
    expect(hook.result.current.bookings).toEqual([]);
  });

  it('a quiet re-read that fails keeps the booking on screen', async () => {
    getBookings.mockResolvedValueOnce(HELD);
    const hook = renderHook(({ k }) => useUpcoming({ enabled: true, onChanged: () => {}, refreshKey: k }), {
      initialProps: { k: 0 },
    });
    await waitFor(() => expect(hook.result.current.status).toBe('ready'));

    getBookings.mockRejectedValueOnce(new ApiError('server', 'no', 'WLT-0000-0000', 500));
    hook.rerender({ k: 1 });
    await waitFor(() => expect(getBookings).toHaveBeenCalledTimes(2));
    await act(async () => {});

    expect(hook.result.current.status).toBe('ready');
    expect(hook.result.current.bookings).toEqual(HELD);
  });
});
