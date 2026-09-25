/**
 * The `avopulse` dot — the design's "this is live right now" mark.
 *
 * Two places want it and they want it at different speeds: the live happy-hour
 * banner (design:203, 1.6s) and the enlarged payment code's countdown row
 * (design:643, 1.4s). One component rather than two copies of the same
 * `Animated.loop`.
 *
 * `--avo-brand` is a SURFACE colour, and a dot is exactly the use non-negotiable
 * #9 names as legitimate: "gradients, tints, dots, progress fills". Nothing is
 * written on top of it. The same holds for the amber the happy-hour banner
 * passes in: a dot is a non-text graphic, so the floor is WCAG 1.4.11's 3:1, and
 * `happyHourAccent` on `happyHourBg` measures 4.50:1.
 *
 * design/README.md §192: reduced motion **removes** the pulse rather than
 * shortening it. So under reduce-motion this is a plain, fully-opaque dot — the
 * information ("live") is carried by the countdown beside it, never by the
 * animation alone.
 */

import { useEffect, useRef } from 'react';
import { AccessibilityInfo, Animated, Easing, Platform, StyleSheet } from 'react-native';
import { color, radius } from '../theme';

interface Props {
  size: number;
  /** One full cycle. design:203 is 1600ms; design:643 is 1400ms. */
  durationMs: number;
  /**
   * The dot's fill. Defaults to `color.brand`, which is what the payment code's
   * countdown row wants and what both callers wanted when there was only one
   * brand group on screen.
   *
   * It became a prop when the live happy-hour banner moved to the amber group: a
   * brand-green dot pulsing inside an amber card is the one element still
   * arguing that happy hour is just more house colour, which is the thing the
   * move was for. A prop rather than a second component, because the animation,
   * the reduced-motion rule and the accessibility treatment are all identical —
   * only the fill differs.
   */
  fill?: string;
}

export function PulseDot({ size, durationMs, fill }: Props) {
  const value = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    let cancelled = false;
    void AccessibilityInfo.isReduceMotionEnabled().then((reduced) => {
      // A flat dot, still a dot. Not a faster pulse.
      if (cancelled || reduced) return;
      Animated.loop(
        Animated.sequence([
          Animated.timing(value, {
            toValue: 0.35,
            duration: durationMs / 2,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: Platform.OS !== 'web',
          }),
          Animated.timing(value, {
            toValue: 1,
            duration: durationMs / 2,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: Platform.OS !== 'web',
          }),
        ]),
      ).start();
    });
    return () => {
      cancelled = true;
      value.stopAnimation();
    };
  }, [value, durationMs]);

  return (
    <Animated.View
      // Decorative: the sentence next to it already says the window is live.
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.dot,
        { width: size, height: size, opacity: value },
        fill ? { backgroundColor: fill } : null,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  dot: { borderRadius: radius.pill, backgroundColor: color.brand, flexShrink: 0 },
});
