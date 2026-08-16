/**
 * The payment code.
 *
 * Non-negotiable #2: the client never mints a token. It asks the server for one,
 * counts down to the `expiresAt` the SERVER set, and asks for another when that
 * moment passes. The 45 seconds is not a constant in this file — it is whatever
 * the server's expiry says it is, which is the only version of the rule that
 * survives the server changing its mind.
 *
 * The countdown is cosmetic. Consumption and expiry are enforced in POST /scans
 * and POST /charges; a client that displayed the wrong number would embarrass
 * itself at the counter but could not spend anything.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { WalletToken } from '@avo/types';
import { ApiError } from '../api/client';
import { getWalletToken } from '../api/wallet';

export interface WalletTokenState {
  token: WalletToken | null;
  /** Whole seconds until the server's expiry. Never negative. */
  secondsRemaining: number;
  failed: boolean;
  loading: boolean;
}

function secondsUntil(iso: string): number {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 1000));
}

/**
 * @param enabled false offline — interaction-spec.md §4 hides the QR entirely
 *        rather than showing a stale one. A token that fails at the counter
 *        looks like the salon's fault.
 */
export function useWalletToken(enabled: boolean): WalletTokenState & { refresh: () => void } {
  const [token, setToken] = useState<WalletToken | null>(null);
  const [secondsRemaining, setSecondsRemaining] = useState(0);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const inFlight = useRef(false);

  const fetchToken = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      const next = await getWalletToken();
      setToken(next);
      setSecondsRemaining(secondsUntil(next.expiresAt));
      setFailed(false);
    } catch (err) {
      // A code we cannot mint is a code we do not show. Never fall back to the
      // previous one — it is single-use and may already be spent.
      setToken(null);
      setSecondsRemaining(0);
      setFailed(err instanceof ApiError);
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setToken(null);
      setSecondsRemaining(0);
      setFailed(false);
      return;
    }
    void fetchToken();
  }, [enabled, fetchToken]);

  // One ticker, driven off the server's expiry rather than a local counter, so a
  // backgrounded tab resumes with the real remaining time instead of a stale one.
  useEffect(() => {
    if (!enabled || !token) return;
    const id = setInterval(() => {
      const left = secondsUntil(token.expiresAt);
      setSecondsRemaining(left);
      if (left === 0) void fetchToken();
    }, 1000);
    return () => clearInterval(id);
  }, [enabled, token, fetchToken]);

  return { token, secondsRemaining, failed, loading, refresh: fetchToken };
}
