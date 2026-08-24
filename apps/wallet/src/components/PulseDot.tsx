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
 * written on top of it.
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
}

export function PulseDot({ size, durationMs }: Props) {
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
      style={[styles.dot, { width: size, height: size, opacity: value }]}
    />
  );
}

const styles = StyleSheet.create({
  dot: { borderRadius: radius.pill, backgroundColor: color.brand, flexShrink: 0 },
});
