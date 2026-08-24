/**
 * The bottom sheet.
 *
 * Dismissal — Esc, the Android hardware back, and the web back gesture — moved
 * to `useDismissible`, because the enlarged payment code needs exactly the same
 * four exits behind different markup, and this file's header used to claim to be
 * "the one place dismissal is decided". It still is; the place just moved. Read
 * that module for the whole argument, including why `dismissible: false` has to
 * close all four exits rather than two.
 */

import { Pressable, StyleSheet, View } from 'react-native';
import { color, radius } from '../theme';
import { useCopy } from '../i18n/language';
import { useDismissible } from './useDismissible';

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
  useDismissible({ open, dismissible, onDismiss, label });

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
