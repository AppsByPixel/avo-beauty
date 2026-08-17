/**
 * The confirmation toast — design:979-984.
 *
 * Used for the four account confirmations the design fires through `showToast`:
 * "Profile updated", "Password updated", "Code sent", and the language switch.
 *
 * It is an ANNOUNCEMENT, not a control. It carries no action, nothing is lost if
 * it is missed, and it never reports a failure — a failure that a customer needs
 * to act on goes in the sheet as an `InlineError`, where it stays on screen.
 * A toast that disappears after three seconds is the wrong place to tell someone
 * her password did not change.
 *
 * `accessibilityLiveRegion="polite"` is the whole accessibility story here: the
 * text is read when it appears, and the toast is not focusable, so it cannot
 * strand keyboard focus somewhere that is about to unmount.
 */

import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { color, radius, text, WHITE } from '../theme';
import { useLanguage } from '../i18n/language';

/** design:1112 — the design holds it for 3400ms. */
const VISIBLE_MS = 3400;

export function useToast(): {
  message: string | null;
  show: (message: string) => void;
} {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return {
    message,
    show: (next: string) => {
      if (timer.current) clearTimeout(timer.current);
      setMessage(next);
      timer.current = setTimeout(() => setMessage(null), VISIBLE_MS);
    },
  };
}

export function Toast({ message }: { message: string | null }) {
  const { lang } = useLanguage();
  if (!message) return null;
  return (
    <View
      style={styles.toast}
      accessibilityLiveRegion="polite"
      accessibilityRole="alert"
      pointerEvents="none"
      testID="toast"
    >
      <View style={styles.check}>
        <Svg width={16} height={16} viewBox="0 0 24 24" fill="none">
          <Path
            d="M6 12.5 10.5 17 18 8"
            stroke={WHITE}
            strokeWidth={2.4}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Svg>
      </View>
      <Text style={[text('bodyS', lang), styles.text]}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  toast: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 40,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: color.ink,
    borderRadius: radius.card,
    paddingVertical: 15,
    paddingHorizontal: 18,
    zIndex: 40,
  },
  // A tick on a filled circle. White on `brandDeep`, never on `brand` — #9.
  check: {
    width: 30,
    height: 30,
    borderRadius: radius.pill,
    backgroundColor: color.brandDeep,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: { color: WHITE, flex: 1, lineHeight: 18 },
});
