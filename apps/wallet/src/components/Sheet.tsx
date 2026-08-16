/**
 * The bottom sheet, and the one place dismissal is decided.
 *
 * interaction-spec.md §2: "Sheets and modals: focus moves to the sheet on open,
 * is trapped while open, and returns to the trigger on close. `Esc` closes —
 * **except** the KNET redirect state, which is deliberately not dismissible."
 *
 * `dismissible={false}` is not a styling flag. It closes four separate exits,
 * and all four have to be closed or the exception is decorative:
 *
 *   1. the backdrop press           — no handler is attached at all
 *   2. Esc                          — the key is swallowed, not ignored
 *   3. the Android hardware back    — BackHandler returns true
 *   4. the browser/OS back gesture  — a history entry is held and re-pushed
 *
 * A sheet that blocks (1) and (2) but not (4) is still dismissible; the customer
 * just uses a different gesture, and lands on a wallet that has forgotten it has
 * a live payment at the bank.
 */

import { useEffect, useRef } from 'react';
import { BackHandler, Platform, Pressable, StyleSheet, View } from 'react-native';
import { color, radius } from '../theme';
import { useCopy } from '../i18n/language';

interface Props {
  /** Rendered only when true; there is no hidden-but-mounted state. */
  open: boolean;
  dismissible: boolean;
  onDismiss: () => void;
  /** Announced as the sheet's name. */
  label: string;
  testID?: string;
  children: React.ReactNode;
}

export function Sheet({ open, dismissible, onDismiss, label, testID, children }: Props) {
  const copy = useCopy();
  // Held in a ref so the listeners below can be registered once per open and
  // still see the current value — re-registering a keydown handler on every
  // stage change would drop the keystroke that arrives during the swap.
  const dismissibleRef = useRef(dismissible);
  dismissibleRef.current = dismissible;
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  // --- Esc, and the web back gesture -------------------------------------
  useEffect(() => {
    if (!open || Platform.OS !== 'web') return;
    if (typeof document === 'undefined' || typeof window === 'undefined') return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Swallowed either way: while the sheet is up, Esc is the sheet's key and
      // must not fall through to whatever is behind it.
      event.preventDefault();
      event.stopPropagation();
      if (dismissibleRef.current) onDismissRef.current();
    };
    document.addEventListener('keydown', onKeyDown, true);

    // Hold a history entry for the life of the sheet. Back then pops *this*
    // entry rather than navigating away: if the sheet may be dismissed, that is
    // a dismissal; if it may not, the entry is immediately re-pushed and the
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

  // --- Android hardware back ----------------------------------------------
  useEffect(() => {
    if (!open || Platform.OS === 'web') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (dismissibleRef.current) {
        onDismissRef.current();
        return true;
      }
      // true = handled. CLAUDE.md says follow the platform on Android back, and
      // this is the documented exception: the payment is live at the bank.
      return true;
    });
    return () => sub.remove();
  }, [open]);

  if (!open) return null;

  return (
    <View style={styles.overlay} testID={testID}>
      {dismissible ? (
        <Pressable
          style={styles.backdrop}
          onPress={onDismiss}
          accessibilityRole="button"
          accessibilityLabel={copy.txClose}
          testID={testID ? `${testID}-backdrop` : undefined}
        />
      ) : (
        // Still a backdrop, just not a control: it takes the press so it cannot
        // reach the screen underneath, and it has no press handler to attach a
        // dismissal to.
        <View style={styles.backdrop} pointerEvents="auto" />
      )}
      <View
        style={styles.sheet}
        accessibilityViewIsModal
        accessibilityRole="none"
        accessibilityLabel={label}
      >
        <View style={styles.grabber} />
        {children}
      </View>
    </View>
  );
}

/** RN 0.86's typings no longer expose `StyleSheet.absoluteFillObject`. */
const FILL = { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 } as const;

const styles = StyleSheet.create({
  overlay: { ...FILL, justifyContent: 'flex-end', zIndex: 30 },
  backdrop: { ...FILL, backgroundColor: 'rgba(20,21,17,0.5)' },
  sheet: {
    width: '100%',
    maxHeight: '88%',
    backgroundColor: color.surface,
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    paddingHorizontal: 22,
    paddingTop: 12,
    paddingBottom: 30,
  },
  grabber: {
    width: 40,
    height: 5,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(28,27,25,0.15)',
    alignSelf: 'center',
    marginBottom: 16,
  },
});
