/**
 * WHEN THE WALLET RE-READS ITSELF — after she pays, and when she comes back.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE DEFECT. A charge happens on the SALON's device: the cashier scans her code
 * and the scanner calls `POST /charges`. Nothing on this phone takes part, so
 * nothing here learned that her balance had moved — Home kept the figure it read
 * before she walked to the counter until something remounted it. `useBell`'s
 * header claimed "a charge that re-read the wallet also re-reads the bell"; no
 * charge re-read anything.
 *
 * THE FIX IS TWO MOMENTS AND A GESTURE, all of them one `home.retry()`:
 *
 *   1. THE PAYMENT CODE CLOSES. The only moment this app can connect to a charge
 *      is the one right after she held the code up to be scanned. (App.tsx.)
 *   2. THE APP COMES BACK TO THE FOREGROUND — `AppState` `active`. She paid,
 *      pocketed the phone, and opened it later; or topped up from another
 *      device; or the salon voided a charge while she was away.
 *   3. PULL-TO-REFRESH on Home, the platform's own `RefreshControl`. No copy.
 *
 * `home.retry()` re-reads the member (balance, tier, stamps), the salon, the
 * activity and the promotions; the bell follows `fetchedAt`; the Upcoming card
 * follows `generation` below. Non-negotiable #2: the balance on screen after any
 * of these is the server's answer to `GET /members/me`, never a figure this app
 * worked out.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * NO REFETCH STORM. At most one re-read per `REFRESH_MIN_INTERVAL_MS`, counted
 * from the last one this gate let through — and the gate is PRIMED AT MOUNT,
 * because the mount load is a read too. iOS flips `inactive → active` for a
 * Face ID prompt, a pulled-down notification centre, a control-centre swipe; she
 * can open and close the code three times while the cashier finds the scanner.
 * Each of those is an event and none of them is a reason for a second read.
 *
 * Three seconds, not more, because the event that matters most — the code
 * closing after a charge — follows a foreground re-read by the length of a
 * scan, an amount and a confirm at the till, which is longer than that.
 *
 * A request is also dropped, WITHOUT spending the slot, when there is no wallet
 * on screen (the skeleton and the failure screen have their own paths and their
 * own Try again) or a read is already in flight: `retry()` aborts and restarts,
 * so a second request would throw away a read that was about to land.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE STATES ARE `useWalletHome`'s, UNCHANGED. A re-read over data never blanks
 * the screen; one that fails keeps the last good snapshot and lands on `stale`
 * (the banner, with its own Try again) or `offline` (the QR hidden, the stamp),
 * exactly as a Try again that failed always has. This hook decides WHEN, never
 * what a failure looks like.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

export const REFRESH_MIN_INTERVAL_MS = 3_000;

/** The three fields of `useWalletHome()` this needs, and nothing it could change. */
export interface RefreshableHome {
  snapshot: unknown;
  refreshing: boolean;
  retry: () => void;
}

/**
 * The throttle, as a pure function of time. `startedAt` is the mount — the
 * first load counts as the last read.
 */
export function createRefreshGate(
  minIntervalMs: number,
  startedAt: number,
): (now: number) => boolean {
  let last = startedAt;
  return (now) => {
    if (now - last < minIntervalMs) return false;
    last = now;
    return true;
  };
}

export interface WalletRefresh {
  /**
   * Ask for a re-read. True when one was started — the pull-to-refresh spinner
   * reads that, so a throttled pull lets go at once instead of spinning over a
   * read that is not happening.
   */
  requestRefresh: () => boolean;
  /**
   * Counts the re-reads this hook started. Home hands it to `useUpcoming` as a
   * refresh key, so the Upcoming card is re-read at the same moments.
   */
  generation: number;
}

export function useWalletRefresh(home: RefreshableHome): WalletRefresh {
  const homeRef = useRef(home);
  homeRef.current = home;

  const gate = useRef<((now: number) => boolean) | null>(null);
  if (gate.current === null) gate.current = createRefreshGate(REFRESH_MIN_INTERVAL_MS, Date.now());

  const [generation, setGeneration] = useState(0);

  const requestRefresh = useCallback((): boolean => {
    const h = homeRef.current;
    if (h.snapshot === null || h.refreshing) return false;
    if (!gate.current?.(Date.now())) return false;
    setGeneration((g) => g + 1);
    h.retry();
    return true;
  }, []);

  useEffect(() => {
    let last: AppStateStatus = AppState.currentState;
    const sub = AppState.addEventListener('change', (next) => {
      const was = last;
      last = next;
      // A transition INTO active. `active → active` is not her coming back.
      if (next === 'active' && was !== 'active') requestRefresh();
    });
    // react-native-web returns nothing where the Page Visibility API is absent.
    return () => sub?.remove();
  }, [requestRefresh]);

  return { requestRefresh, generation };
}
