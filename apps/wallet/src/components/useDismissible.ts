/**
 * The four exits from a modal layer, in one place.
 *
 * EXTRACTED FROM `Sheet.tsx`, WHOSE HEADER SAYS THIS IS "the one place
 * dismissal is decided". It was — while a sheet was the only modal layer in the
 * app. The enlarged payment code (design:641-643) is a centred overlay rather
 * than a bottom sheet, so it cannot reuse `Sheet`'s markup, and copying the Esc
 * / back handling into it would have made that sentence false. The behaviour
 * moved here; `Sheet` and `QrOverlay` both call it.
 *
 * interaction-spec.md §2: "focus moves to the sheet on open, is trapped while
 * open, and returns to the trigger on close. `Esc` closes — **except** the KNET
 * redirect state, which is deliberately not dismissible."
 *
 * `dismissible: false` is not a styling flag. It closes four separate exits, and
 * all four have to be closed or the exception is decorative:
 *
 *   1. the backdrop press           — the caller attaches no handler
 *   2. Esc                          — the key is swallowed, not ignored
 *   3. the Android hardware back    — BackHandler returns true
 *   4. the browser/OS back gesture  — a history entry is held and re-pushed
 *
 * A layer that blocks (1) and (2) but not (4) is still dismissible; the customer
 * just uses a different gesture, and lands on a wallet that has forgotten it has
 * a live payment at the bank.
 */

import { useEffect, useRef } from 'react';
import { BackHandler, Platform } from 'react-native';

export interface Dismissible {
  /** No listener is registered while this is false. */
  open: boolean;
  dismissible: boolean;
  onDismiss: () => void;
  /** Stored on the history entry so a stray popstate is identifiable. */
  label: string;
}

export function useDismissible({ open, dismissible, onDismiss, label }: Dismissible): void {
  // Held in refs so the listeners are registered once per open and still see the
  // current values — re-registering a keydown handler on every stage change
  // would drop the keystroke that arrives during the swap.
  const dismissibleRef = useRef(dismissible);
  dismissibleRef.current = dismissible;
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  // --- Esc, and the web back gesture ---------------------------------------
  useEffect(() => {
    if (!open || Platform.OS !== 'web') return;
    if (typeof document === 'undefined' || typeof window === 'undefined') return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Swallowed either way: while the layer is up, Esc is its key and must not
      // fall through to whatever is behind it.
      event.preventDefault();
      event.stopPropagation();
      if (dismissibleRef.current) onDismissRef.current();
    };
    document.addEventListener('keydown', onKeyDown, true);

    // Hold a history entry for the life of the layer. Back then pops *this*
    // entry rather than navigating away: if it may be dismissed, that is a
    // dismissal; if it may not, the entry is immediately re-pushed and the
    // customer stays exactly where she was.
    const marker = { avoSheet: label };
    window.history.pushState(marker, '');
    const onPopState = () => {
      if (dismissibleRef.current) {
        onDismissRef.current();
      } else {
        window.history.pushState(marker, '');
      }
    };
    window.addEventListener('popstate', onPopState);

    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('popstate', onPopState);
    };
  }, [open, label]);

  // --- Android hardware back ------------------------------------------------
  useEffect(() => {
    if (!open || Platform.OS === 'web') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (dismissibleRef.current) {
        onDismissRef.current();
        return true;
      }
      // true = handled. CLAUDE.md says follow the platform on Android back, and
      // the non-dismissible case is the documented exception: the payment is
      // live at the bank.
      return true;
    });
    return () => sub.remove();
  }, [open]);
}
