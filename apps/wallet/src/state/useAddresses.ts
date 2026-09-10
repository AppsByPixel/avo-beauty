/**
 * The address book's state: read it, add one, replace one, remove one.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * FOUR STATES, AND THE EMPTY ONE IS THE COMMON CASE.
 *
 * `status` follows the same five-value shape `useShop` and `useWalletHome` use,
 * through the same `statusForFailure(kind, hasData)` rule — a refresh that fails
 * over a list already on screen goes to `stale`/`offline` and keeps the list,
 * rather than blanking it (interaction-spec.md §4). `forbidden` is `failed` in
 * both cases: continuing to render addresses she has just been refused, tappable
 * and choosable, would be the UI overriding the server (#7).
 *
 * EMPTY IS NOT A STATUS. `addresses: []` at `ready` is the first-run case and
 * the one a real customer hits — she has never saved an address — and it is a
 * different fact from "we could not read your book". Conflating them would tell
 * a customer with a working connection to add an address she already has, or
 * offer a Try again to a customer who simply has none.
 *
 * `null` UNTIL THE FIRST SUCCESS, never `[]` standing in for it. `useShop`
 * states the rule for products and it matters more here: an empty array before
 * the read lands would paint the "no saved addresses" empty state for a moment
 * on every open, and that empty state carries a call to action.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * NO MONEY, SO NO IDEMPOTENCY KEY, AND `busy` IS THE DOUBLE-TAP GUARD.
 *
 * There is no delivery fee anywhere in this feature, so none of these four
 * calls moves anything. A double-tapped Save would create two identical rows in
 * her book — visible, harmless and hers to delete — and `busy` is what actually
 * stops it. That is a deliberately weaker guard than the cart's key, because
 * the thing being guarded is weaker: the cart's double-tap is a second debit.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * A WRITE RE-READS THE LIST RATHER THAN PATCHING IT LOCALLY.
 *
 * `POST` and `PUT` both answer the stored row and it would be easy to splice
 * that into the array. This refetches instead, for `useShop`'s reason about
 * `balanceAfterFils`: the server owns the ordering (`created_at DESC`) and the
 * normalisation (it trims, and maps an empty optional field to NULL), and a
 * client that maintained its own copy would be right today and would be the seam
 * through which a locally-invented row arrives later. An address book is three
 * rows; the refetch is free.
 *
 * The one thing kept from the response is the NEW ADDRESS'S ID, handed back to
 * the caller so the checkout sheet can select what she just saved. That is not
 * state this hook holds — it is the answer to "which one", returned once.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, type FailureKind } from '../api/client';
import { toLoadFailure, type LoadFailure } from '../domain/loadFailure';
import {
  createAddress,
  listAddresses,
  removeAddress,
  updateAddress,
  type MemberAddress,
} from '../api/addresses';
import { UNKNOWN_ADDRESS } from '../domain/orderRefusal';
import type { AddressPayload } from '../domain/address';

export type AddressBookStatus = 'loading' | 'ready' | 'stale' | 'offline' | 'failed';

/**
 * Which status a failure produces, given whether anything is already on screen.
 * Exported and pure so it has a spec — `shopStatusForFailure`'s reasoning, and
 * this is deliberately a second copy of that four-line rule rather than a shared
 * helper: the two hooks return different unions, and the day one of them needs a
 * different answer for `forbidden` a shared function would make that a change to
 * both.
 */
export function addressStatusForFailure(
  kind: FailureKind,
  hasData: boolean,
): AddressBookStatus {
  if (kind === 'forbidden') return 'failed';
  if (!hasData) return 'failed';
  return kind === 'offline' ? 'offline' : 'stale';
}

/** What a write did. `null` on success; a reason otherwise. */
export type AddressWriteError =
  /** Her connection. The write may or may not have landed — see `save`. */
  | 'offline'
  /** The row is gone. Only reachable on `PUT`/`DELETE`. */
  | 'gone'
  /** Anything else, including a 400 the form should have prevented. */
  | 'failed';

export interface AddressBookState {
  status: AddressBookStatus;
  /** Null until the first successful read. Never `[]` standing in for it. */
  addresses: MemberAddress[] | null;
  failure: LoadFailure | null;
  /** Epoch ms the list on screen was read. Null before the first success. */
  fetchedAt: number | null;
  /** A write is in flight. Disables Save and Delete. */
  busy: boolean;
  writeError: AddressWriteError | null;
}

export interface AddressBookActions {
  retry: () => void;
  clearWriteError: () => void;
  /** Resolves with the saved address's id, or null on any refusal. */
  save: (payload: AddressPayload, id: string | null) => Promise<string | null>;
  /** Resolves true when the row is gone — including when it already was. */
  remove: (id: string) => Promise<boolean>;
}

export type AddressBookController = AddressBookState & AddressBookActions;

export function useAddresses(): AddressBookController {
  const [status, setStatus] = useState<AddressBookStatus>('loading');
  const [addresses, setAddresses] = useState<MemberAddress[] | null>(null);
  const [failure, setFailure] = useState<LoadFailure | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [writeError, setWriteError] = useState<AddressWriteError | null>(null);
  const [reload, setReload] = useState(0);

  const abortRef = useRef<AbortController | null>(null);
  const aliveRef = useRef(true);
  /**
   * The list, readable from inside a callback without making it a dependency.
   * `useShop` reads `products` out of the effect's closure for the same
   * "blank or keep" decision; a ref is the honest version of that when the
   * reader is an async callback rather than an effect body.
   */
  const listRef = useRef<MemberAddress[] | null>(null);
  listRef.current = addresses;

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    // A retry over an existing list must not blank it. Only a cold start has
    // nothing to keep.
    setStatus((prev) => (listRef.current === null ? 'loading' : prev));

    listAddresses(controller.signal)
      .then((items) => {
        if (!aliveRef.current) return;
        setAddresses(items);
        setFailure(null);
        setFetchedAt(Date.now());
        setStatus('ready');
      })
      .catch((err: unknown) => {
        if (!aliveRef.current || controller.signal.aborted) return;
        const next = toLoadFailure(err);
        setFailure(next);
        setStatus(addressStatusForFailure(next.kind, listRef.current !== null));
      });
  }, [reload]);

  const refetch = useCallback(() => setReload((n) => n + 1), []);

  /**
   * Save a new address, or replace an existing one.
   *
   * `id === null` is a create. That is the only distinction, and it is the
   * caller's — a sheet opened blank creates, a sheet opened on a row replaces —
   * so this function has no heuristic about "does it look new".
   *
   * ON AN OFFLINE WRITE THE LIST IS STILL REFETCHED. The POST may have landed
   * and we may simply not have read the answer, so leaving the local list alone
   * would hide a saved address until the next open. The refetch will itself fail
   * while she is offline, which resolves to `offline` over the existing list — a
   * banner, not a blank — and succeeds the moment the connection returns.
   */
  const save = useCallback(
    async (payload: AddressPayload, id: string | null): Promise<string | null> => {
      if (busy) return null;
      setBusy(true);
      setWriteError(null);
      try {
        const { address } =
          id === null ? await createAddress(payload) : await updateAddress(id, payload);
        refetch();
        return address.id;
      } catch (err) {
        setWriteError(classifyWrite(err));
        // See above: an unknown outcome is a reason to re-read, not to assume.
        if (err instanceof ApiError && err.kind === 'offline') refetch();
        return null;
      } finally {
        if (aliveRef.current) setBusy(false);
      }
    },
    [busy, refetch],
  );

  /**
   * Remove one. Resolves TRUE when the row is gone, and a 404 counts as gone.
   *
   * `unknown_address` here means it was already deleted — on another device, or
   * by a double tap that raced. Reporting that as a failure would leave her
   * looking at an error over a book that no longer contains the row, so the
   * outcome she cares about ("is it gone") is what this reports. The refetch
   * below is what makes it true on screen either way.
   *
   * This is the deliberate exception `deleteNoContent`'s header names: "a caller
   * that wants 'gone either way' has to treat `unknown_address` as success
   * itself".
   */
  const remove = useCallback(
    async (id: string): Promise<boolean> => {
      if (busy) return false;
      setBusy(true);
      setWriteError(null);
      try {
        await removeAddress(id);
        refetch();
        return true;
      } catch (err) {
        if (err instanceof ApiError && err.code === UNKNOWN_ADDRESS) {
          refetch();
          return true;
        }
        setWriteError(classifyWrite(err));
        if (err instanceof ApiError && err.kind === 'offline') refetch();
        return false;
      } finally {
        if (aliveRef.current) setBusy(false);
      }
    },
    [busy, refetch],
  );

  return {
    status,
    addresses,
    failure,
    fetchedAt,
    busy,
    writeError,
    retry: refetch,
    clearWriteError: useCallback(() => setWriteError(null), []),
    save,
    remove,
  };
}

/**
 * A thrown write, classified. Pure and exported so it has a spec — the same
 * argument `orderRefusal.ts` makes at length about a branch left inline in a
 * hook being a branch no test can reach.
 *
 * `unknown_address` BEFORE the offline check, for `orderRefusal`'s reason:
 * `classify()` maps 503 and 504 to `offline`, so a coded refusal arriving with
 * that status must not be read as a dead connection.
 */
export function classifyWrite(err: unknown): AddressWriteError {
  if (!(err instanceof ApiError)) return 'failed';
  if (err.code === UNKNOWN_ADDRESS) return 'gone';
  if (err.kind === 'offline') return 'offline';
  return 'failed';
}
