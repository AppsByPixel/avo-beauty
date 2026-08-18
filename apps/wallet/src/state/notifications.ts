/**
 * The five notification toggles — now the server's, which four of them always
 * were.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE USED TO BE, AND WHY THAT WAS REPORTED RATHER THAN SHIPPED
 *
 * These persisted to `AsyncStorage` and went no further, because no contract
 * carried them: api-contract.md had no `NotificationPreferences` shape and no
 * route, packages/mock served none, api/src/routes had none. The design
 * prototype holds them in component state (AVO Wallet Home.dc.html:1023), which
 * is what a prototype does and not what a product can do.
 *
 * The escalation's argument was that the switches are not equivalent:
 *
 *   push, remind   the client is a plausible owner — a device permission and a
 *                  local schedule are device-scoped by nature. But held ONLY on
 *                  the client they are lost on reinstall, which silently
 *                  re-enables everything the customer turned off.
 *   wa, receipt    the server sends these. The receipt outbox does not consult
 *                  a phone before it queues a message, so a local "off" does
 *                  not stop a receipt — and the customer has been told it did.
 *                  That is not a lost setting, it is a false statement made to
 *                  her.
 *   offers         MARKETING CONSENT. Non-negotiable #8 puts delivery and caps
 *                  on the platform send path, so consent has to be readable
 *                  THERE. A local-only opt-out is not an opt-out.
 *
 * Lane A built it as four columns and one append-only consent event stream
 * behind one screen-shaped response. `offers` is flattened to a boolean for the
 * switch to bind to, with `offersConsent` beside it carrying when she answered,
 * from where, and under which version of the terms.
 *
 * NO EVENT AT ALL MEANS NO CONSENT — not "unknown", not "assume yes". So the
 * design's `offers: false` default is now the server's answer rather than this
 * file's constant, and it is right for the same reason it was right before.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ONE SWITCH IS PATCHED, NOT FIVE. The API records a consent event only when the
 * answer CHANGES; sending all five on every toggle would be indistinguishable
 * from the customer deliberately re-answering four questions she did not touch.
 *
 * THE SWITCH FOLLOWS THE SERVER, NOT THE FINGER. It moves optimistically so the
 * screen does not feel dead, and it moves BACK if the PATCH fails. A switch that
 * stays where it was tapped after the write failed is the same false statement
 * the device-local version made, just faster.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import {
  getNotifications,
  patchNotifications,
  type NotificationPreferencesResponse,
} from '../api/account';

/** The five, in the order the design lists them. */
export const NOTIFICATION_KEYS = ['push', 'wa', 'remind', 'receipt', 'offers'] as const;

export type NotificationKey = (typeof NOTIFICATION_KEYS)[number];

export type NotificationPreferences = Record<NotificationKey, boolean>;

/**
 * Shown only until the first response arrives, and `offers: false` is the
 * load-bearing half — an unsent preference that starts off cannot leak a
 * message, while one that starts on could. The server is the authority the
 * moment it answers.
 */
export const DEFAULT_PREFERENCES: NotificationPreferences = {
  push: true,
  wa: true,
  remind: true,
  receipt: true,
  offers: false,
};

/**
 * The AsyncStorage key the device-local version wrote to.
 *
 * Kept, and still exported, because log-out has to be able to DROP it. A
 * customer who signed out on a shared handset left a row behind that nothing
 * reads any more; leaving it there is a stale copy of a consent answer sitting
 * in storage on a device that may not be hers. Nothing writes it now.
 */
export const PREFERENCES_KEY = 'avo.wallet.notifications.v1';

function toPreferences(res: NotificationPreferencesResponse): NotificationPreferences {
  return {
    push: res.push,
    wa: res.wa,
    remind: res.remind,
    receipt: res.receipt,
    offers: res.offers,
  };
}

export interface NotificationState {
  prefs: NotificationPreferences;
  /** The evidence behind `offers` — when, from where, under which terms. */
  offersConsent: NotificationPreferencesResponse['offersConsent'] | null;
  toggle: (key: NotificationKey) => void;
  /** False until the server has answered, so no switch flickers. */
  loaded: boolean;
  /** The read failed. The section shows a retry rather than five wrong switches. */
  loadFailed: boolean;
  /** A write failed and the switch has been put back. Cleared on the next try. */
  writeFailed: NotificationKey | null;
  /** Keys with a PATCH in flight, so each row can disable just itself. */
  saving: NotificationKey[];
  reload: () => void;
}

export function useNotificationPreferences(enabled = true): NotificationState {
  const [prefs, setPrefs] = useState<NotificationPreferences>(DEFAULT_PREFERENCES);
  const [offersConsent, setOffersConsent] =
    useState<NotificationPreferencesResponse['offersConsent'] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [writeFailed, setWriteFailed] = useState<NotificationKey | null>(null);
  const [saving, setSaving] = useState<NotificationKey[]>([]);
  const [reloadToken, setReloadToken] = useState(0);

  /**
   * The latest prefs, readable synchronously.
   *
   * `toggle` needs the current value to compute the next one, and it must do
   * that OUTSIDE a state updater — see the comment on `toggle`. A ref is how it
   * reads them without taking `prefs` as a dependency and churning its identity
   * on every switch.
   */
  const prefsRef = useRef<NotificationPreferences>(DEFAULT_PREFERENCES);
  /** In-flight keys, synchronously — `saving` state lags by a render. */
  const savingRef = useRef<Set<NotificationKey>>(new Set());

  const applyPrefs = useCallback((next: NotificationPreferences) => {
    prefsRef.current = next;
    setPrefs(next);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setLoadFailed(false);
    getNotifications(controller.signal)
      .then((res) => {
        applyPrefs(toPreferences(res));
        setOffersConsent(res.offersConsent);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        // No last-known fallback. Five switches drawn from defaults look like
        // her settings and are not — the section says it could not read them.
        setLoadFailed(true);
        setLoaded(true);
        if (__DEV__ && err instanceof ApiError) {
          console.warn(`[avo] notifications read failed: ${err.kind} ${err.reference}`);
        }
      });
    return () => controller.abort();
  }, [enabled, reloadToken, applyPrefs]);

  /**
   * THE PATCH IS FIRED HERE, NOT INSIDE A `setPrefs` UPDATER.
   *
   * It used to be, and that was a defect: a state updater must be pure, and
   * React is free to invoke it twice — StrictMode does exactly that in
   * development. Two invocations meant TWO PATCHes for one tap, and on `offers`
   * that is two consent writes where the customer answered once.
   *
   * `savingRef` is the second half of the same problem. The row is disabled
   * while a write is in flight, but `saving` state lags a render behind the tap,
   * so a fast double-tap gets through. Two concurrent PATCHes on one key race,
   * and the loser's response overwrites the winner's — which on `offers` means
   * her consent ends up decided by whichever request returned last.
   */
  const toggle = useCallback(
    (key: NotificationKey) => {
      if (savingRef.current.has(key)) return;

      const next = !prefsRef.current[key];
      savingRef.current.add(key);
      setWriteFailed(null);
      setSaving((s) => (s.includes(key) ? s : [...s, key]));
      applyPrefs({ ...prefsRef.current, [key]: next });

      void patchNotifications({ [key]: next })
        .then((res) => {
          // The server's whole answer, not just the key we sent. `offers` going
          // through the consent path can come back differently from what was
          // asked, and this is the screen finding that out.
          applyPrefs(toPreferences(res));
          setOffersConsent(res.offersConsent);
        })
        .catch(() => {
          // Put it back. A switch left where the finger dropped it, after the
          // write failed, tells her something the server does not believe.
          applyPrefs({ ...prefsRef.current, [key]: !next });
          setWriteFailed(key);
        })
        .finally(() => {
          savingRef.current.delete(key);
          setSaving((s) => s.filter((k) => k !== key));
        });
    },
    [applyPrefs],
  );

  return {
    prefs,
    offersConsent,
    toggle,
    loaded,
    loadFailed,
    writeFailed,
    saving,
    reload: useCallback(() => setReloadToken((t) => t + 1), []),
  };
}
