/**
 * The five notification toggles — and the endpoint that does not exist.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THIS IS DEVICE-LOCAL, AND THAT IS A REPORTED GAP, NOT A DESIGN.
 *
 * `design/README.md:114` specifies the five switches and `design/build-plan.md`
 * puts them in the Account slice, but **no contract carries them**:
 * api-contract.md has no `NotificationPreferences` shape and no route that reads
 * or writes one, packages/mock serves none, and api/src/routes has none. The
 * design prototype holds them in component state
 * (AVO Wallet Home.dc.html:1023 — `notifs: { push: true, wa: true, remind:
 * true, receipt: true, offers: false }`), which is what a prototype does and not
 * what a product can do.
 *
 * So they persist to this device and go no further, which matters differently
 * per switch and the difference is the reason this is escalated rather than
 * quietly shipped:
 *
 *   push, remind   the client is a plausible owner — a device permission and a
 *                  local schedule are device-scoped by nature.
 *   wa, receipt    the server sends these. A device-local "off" does not stop a
 *                  receipt email; the customer will believe it did.
 *   offers         MARKETING CONSENT. Non-negotiable #8 puts delivery and caps
 *                  on the platform send path, so consent has to be readable
 *                  there. A local-only opt-out is not an opt-out.
 *
 * `offers` therefore defaults OFF here as the design requires, and the default
 * is the only part of it that is currently load-bearing: an unsent preference
 * that starts off cannot leak a message, while one that starts on could.
 *
 * WHAT THE API OWES (reported to lane A):
 *   GET   /members/me/notifications  → NotificationPreferences
 *   PATCH /members/me/notifications  { push?, wa?, remind?, receipt?, offers? }
 * with `offers` stored as a consent event — timestamp and source — rather than a
 * bare boolean, because that is what a marketing cap has to be able to audit.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { z } from 'zod';

/** The five, in the order the design lists them. */
export const NOTIFICATION_KEYS = ['push', 'wa', 'remind', 'receipt', 'offers'] as const;

export type NotificationKey = (typeof NOTIFICATION_KEYS)[number];

export type NotificationPreferences = Record<NotificationKey, boolean>;

/**
 * design/AVO Wallet Home.dc.html:1023, verbatim. `offers: false` is the one that
 * is a rule rather than a preference — design/README.md:114 calls it out
 * separately ("salon offers — offers off by default") and the design's own
 * Arabic subtitle says so on the row: "مغلقة افتراضياً".
 */
export const DEFAULT_PREFERENCES: NotificationPreferences = {
  push: true,
  wa: true,
  remind: true,
  receipt: true,
  offers: false,
};

/** Exported so log-out can drop it without restating the string. */
export const PREFERENCES_KEY = 'avo.wallet.notifications.v1';
const KEY = PREFERENCES_KEY;

const PreferencesSchema = z.object({
  push: z.boolean(),
  wa: z.boolean(),
  remind: z.boolean(),
  receipt: z.boolean(),
  offers: z.boolean(),
});

async function read(): Promise<NotificationPreferences> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return DEFAULT_PREFERENCES;
    const parsed = PreferencesSchema.safeParse(JSON.parse(raw));
    // A stored value that no longer parses falls back to the DEFAULTS and not to
    // "everything on": the safe direction for a consent flag is off.
    return parsed.success ? parsed.data : DEFAULT_PREFERENCES;
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

async function write(prefs: NotificationPreferences): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Storage failing must not break the screen; the toggle still reads correctly
    // for this session.
  }
}

export function useNotificationPreferences(): {
  prefs: NotificationPreferences;
  toggle: (key: NotificationKey) => void;
  /** False until the stored value has been read, so no switch flickers. */
  loaded: boolean;
} {
  const [prefs, setPrefs] = useState<NotificationPreferences>(DEFAULT_PREFERENCES);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    void read().then((stored) => {
      if (!alive) return;
      setPrefs(stored);
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  const toggle = useCallback((key: NotificationKey) => {
    setPrefs((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      void write(next);
      return next;
    });
  }, []);

  return { prefs, toggle, loaded };
}
