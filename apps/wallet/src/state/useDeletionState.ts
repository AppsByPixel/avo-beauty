/**
 * Is a deletion scheduled? The Account screen asks on every mount.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THERE IS NO SAFE DEFAULT HERE, WHICH IS WHY THE FAILURE STATE IS EXPLICIT.
 *
 * The notification hook next door learned this the expensive way: five switches
 * drawn from constants look exactly like her settings and are not. The same
 * shape of mistake is available here and both directions of it are harmful:
 *
 *   assume `none` when it is pending   she sees an ordinary "Delete my account"
 *                                      row, no sign of the clock, and no route
 *                                      to the cancel door. That is precisely the
 *                                      bug this hook exists to fix, re-created
 *                                      by a default.
 *   assume `pending` when it is none   the screen tells her her account is
 *                                      scheduled for deletion when it is not.
 *
 * So `state` is null until the server answers, `loadFailed` says the read
 * failed, and the section renders a retry rather than guessing. Unknown is a
 * state, not a value to fill in.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../api/client';
import { getDeletionState, type DeletionState } from '../api/account';

export interface DeletionStateView {
  /** Null until the server has answered, or if the read failed. Never guessed. */
  state: DeletionState | null;
  /** False until the first answer, so nothing flickers into place. */
  loaded: boolean;
  /** The read failed. The section shows the failure and a retry. */
  loadFailed: boolean;
  /** Re-read. Also what the sheet calls after a request or a cancel lands. */
  reload: () => void;
}

export function useDeletionState(enabled = true): DeletionStateView {
  const [state, setState] = useState<DeletionState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setLoadFailed(false);
    getDeletionState(controller.signal)
      .then((next) => {
        setState(next);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        // Deliberately NOT `setState({ status: 'none', … })`. See the header.
        setState(null);
        setLoadFailed(true);
        setLoaded(true);
        if (__DEV__ && err instanceof ApiError) {
          console.warn(`[avo] deletion state read failed: ${err.kind} ${err.reference}`);
        }
      });
    return () => controller.abort();
  }, [enabled, reloadToken]);

  return {
    state,
    loaded,
    loadFailed,
    /**
     * Re-READ rather than accepting a state object from the caller.
     *
     * The sheet has just been handed a `DeletionState` by the server and could
     * pass it up, which would save a round trip. Non-negotiable #2's habit is
     * worth more than the round trip: this screen shows what the server says it
     * has, so after anything that changes it the screen asks again. It is also
     * self-correcting if a request and a cancel race.
     */
    reload: useCallback(() => setReloadToken((t) => t + 1), []),
  };
}
