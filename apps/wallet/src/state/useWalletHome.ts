/**
 * The Home screen's state machine.
 *
 * interaction-spec.md §4 asks for four states, and the important part is that
 * three of them are not mutually exclusive with having data:
 *
 *   loading   no data yet          → skeletons. Never a rendered 0.000.
 *   ready     data, fresh          → the screen
 *   stale     data, refresh failed → the screen, plus a banner saying so
 *   offline   data, no connection  → the screen, QR hidden, "last updated" stamp
 *   error     no data, we failed   → the failure screen, with Try again
 *   blocked   no data, you can't   → the failure screen, no Try again
 *
 * "empty" is not a state here. A brand-new member is a successful load whose
 * transaction list happens to be empty, and the emptiness belongs to the section
 * that is empty — the activity feed — not to the whole screen.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, type FailureKind } from '../api/client';
import { getMember, getPromotions, getSalon, getTransactions } from '../api/wallet';
import { readSnapshot, writeSnapshot, type WalletSnapshot } from './cache';

export type HomeStatus = 'loading' | 'ready' | 'stale' | 'offline' | 'error' | 'blocked';

export interface HomeState {
  status: HomeStatus;
  /** Present whenever we have ever had a good read. Null only while loading or failed-cold. */
  snapshot: WalletSnapshot | null;
  /** Epoch ms the snapshot was read from the server. */
  fetchedAt: number | null;
  /** Populated on any failure, for the banner or the failure screen. */
  failure: { kind: FailureKind; message: string; reference: string } | null;
  /** True while a retry or refresh is in flight over data already on screen. */
  refreshing: boolean;
}

const INITIAL: HomeState = {
  status: 'loading',
  snapshot: null,
  fetchedAt: null,
  failure: null,
  refreshing: false,
};

async function loadSnapshot(signal: AbortSignal): Promise<WalletSnapshot> {
  // The member carries the salon id, so it has to land first. Everything that
  // depends on it goes out together rather than in a chain.
  const member = await getMember(signal);
  const [salon, transactions, promotions] = await Promise.all([
    getSalon(member.salonId, signal),
    getTransactions(signal),
    getPromotions(member.salonId, signal),
  ]);
  return { member, salon, transactions, promotions };
}

function statusForFailure(kind: FailureKind, hasData: boolean): HomeStatus {
  if (kind === 'offline') return hasData ? 'offline' : 'error';
  if (kind === 'forbidden') return 'blocked';
  return hasData ? 'stale' : 'error';
}

export function useWalletHome(): HomeState & { retry: () => void } {
  const [state, setState] = useState<HomeState>(INITIAL);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const load = useCallback(async (options: { seedFromCache: boolean }) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setState((prev) => ({
      ...prev,
      // A retry over existing data must not blank the screen. A cold start has
      // nothing to keep, so it goes to the skeletons.
      status: prev.snapshot ? prev.status : 'loading',
      refreshing: true,
    }));

    // On a cold start, warm the state from the cache first. If the network then
    // fails we already have something to keep on screen and stamp, instead of a
    // customer who reopened the app on a plane seeing a failure page.
    let cachedAt: number | null = null;
    if (options.seedFromCache) {
      const cached = await readSnapshot();
      if (cached && mountedRef.current && !controller.signal.aborted) {
        cachedAt = cached.fetchedAt;
        setState((prev) =>
          prev.snapshot
            ? prev
            : { ...prev, snapshot: cached.snapshot, fetchedAt: cached.fetchedAt },
        );
      }
    }

    try {
      const snapshot = await loadSnapshot(controller.signal);
      if (!mountedRef.current || controller.signal.aborted) return;
      const fetchedAt = Date.now();
      void writeSnapshot(snapshot, fetchedAt);
      setState({
        status: 'ready',
        snapshot,
        fetchedAt,
        failure: null,
        refreshing: false,
      });
    } catch (err) {
      if (!mountedRef.current || controller.signal.aborted) return;
      const apiError =
        err instanceof ApiError
          ? err
          : new ApiError('server', 'Something went wrong.', 'WLT-0000-0000', null);
      setState((prev) => {
        const hasData = prev.snapshot !== null;
        return {
          status: statusForFailure(apiError.kind, hasData),
          snapshot: prev.snapshot,
          fetchedAt: prev.fetchedAt ?? cachedAt,
          failure: {
            kind: apiError.kind,
            message: apiError.message,
            reference: apiError.reference,
          },
          refreshing: false,
        };
      });
    }
  }, []);

  useEffect(() => {
    void load({ seedFromCache: true });
  }, [load]);

  const retry = useCallback(() => {
    void load({ seedFromCache: false });
  }, [load]);

  return { ...state, retry };
}
