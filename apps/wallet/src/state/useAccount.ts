/**
 * The Account screen's state machine.
 *
 * Same six statuses as `useWalletHome`, and for the same reason — a screen that
 * can only render "has data" is not done (interaction-spec.md §4). What differs
 * is what "having data" means here, and it is deliberately partial:
 *
 *   member + salon    REQUIRED. Without them there is no profile card, no
 *                     balance for the delete warning and no social list, so a
 *                     failure to read them is a failure of the screen.
 *   policies          OPTIONAL, and null is a rendered state. Non-negotiable
 *                     #10: the wallet holds no legal copy, so if this read
 *                     fails the section is empty. It is NOT backfilled from a
 *                     cache, because a cached clause is still a clause the app
 *                     is asserting on its own authority.
 *   support           OPTIONAL. No config, no topics, no contact form — the same
 *                     argument: the topic list decides where a message is
 *                     routed, and a stale one routes a wallet dispute wrongly.
 *
 * So the three reads are not one `Promise.all` that fails together. The two that
 * decide whether the screen exists are awaited; the two that decide whether a
 * section exists are allowed to come back empty without taking the screen down.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Member, Salon, SupportConfig } from '@avo/types';
import { ApiError, type FailureKind } from '../api/client';
import { getMember, getSalon } from '../api/wallet';
import { getPolicies, getSupportConfig, type PublishedPolicies } from '../api/account';

export type AccountStatus = 'loading' | 'ready' | 'stale' | 'offline' | 'error' | 'blocked';

export interface AccountData {
  member: Member;
  salon: Salon;
  /** Null when the policy read failed. The section then renders nothing. */
  policies: PublishedPolicies | null;
  /** Null when the support read failed. Contact us is then unavailable. */
  support: SupportConfig | null;
}

export interface AccountState {
  status: AccountStatus;
  data: AccountData | null;
  fetchedAt: number | null;
  failure: { kind: FailureKind; message: string; reference: string } | null;
  refreshing: boolean;
}

const INITIAL: AccountState = {
  status: 'loading',
  data: null,
  fetchedAt: null,
  failure: null,
  refreshing: false,
};

function statusForFailure(kind: FailureKind, hasData: boolean): AccountStatus {
  if (kind === 'offline') return hasData ? 'offline' : 'error';
  if (kind === 'forbidden') return 'blocked';
  return hasData ? 'stale' : 'error';
}

async function load(signal: AbortSignal): Promise<AccountData> {
  const member = await getMember(signal);
  // The salon is required; the other two are allowed to fail on their own.
  const [salon, policies, support] = await Promise.all([
    getSalon(member.salonId, signal),
    getPolicies(signal).catch(() => null),
    getSupportConfig(signal).catch(() => null),
  ]);
  return { member, salon, policies, support };
}

export function useAccount(): AccountState & {
  retry: () => void;
  /** Applied after a profile edit or a phone confirmation returns a Member. */
  applyMember: (member: Member) => void;
} {
  const [state, setState] = useState<AccountState>(INITIAL);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const run = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setState((prev) => ({
      ...prev,
      status: prev.data ? prev.status : 'loading',
      refreshing: true,
    }));

    try {
      const data = await load(controller.signal);
      if (!mountedRef.current || controller.signal.aborted) return;
      setState({
        status: 'ready',
        data,
        fetchedAt: Date.now(),
        failure: null,
        refreshing: false,
      });
    } catch (err) {
      if (!mountedRef.current || controller.signal.aborted) return;
      const apiError =
        err instanceof ApiError
          ? err
          : new ApiError('server', 'Something went wrong.', 'WLT-0000-0000', null);
      setState((prev) => ({
        status: statusForFailure(apiError.kind, prev.data !== null),
        data: prev.data,
        fetchedAt: prev.fetchedAt,
        failure: {
          kind: apiError.kind,
          message: apiError.message,
          reference: apiError.reference,
        },
        refreshing: false,
      }));
    }
  }, []);

  useEffect(() => {
    void run();
  }, [run]);

  /**
   * The server's Member, straight onto the screen.
   *
   * `PATCH /members/me` and the phone verify both return the updated entity, so
   * the screen shows what the server stored rather than what the form was
   * holding — the same argument as non-negotiable #2 applied to a profile: if
   * the server normalised the phone or cleared `emailVerified`, that is the
   * truth and the local form value is not.
   */
  const applyMember = useCallback((member: Member) => {
    setState((prev) => (prev.data ? { ...prev, data: { ...prev.data, member } } : prev));
  }, []);

  const retry = useCallback(() => {
    void run();
  }, [run]);

  return { ...state, retry, applyMember };
}
