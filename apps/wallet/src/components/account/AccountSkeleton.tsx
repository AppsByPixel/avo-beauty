/**
 * Account · loading.
 *
 * interaction-spec.md §4 again: a skeleton shaped like the real layout, not a
 * spinner. The shapes that matter here are the profile card and the two
 * settings cards, because they are what jumps if the placeholder is the wrong
 * height.
 *
 * TWO THINGS ARE DELIBERATELY ABSENT.
 *
 *   No name, no initial.   The avatar is a blank rounded square rather than a
 *                          letter, for the same reason the home skeleton never
 *                          renders 0.000: a wrong initial is a wrong identity,
 *                          and on an account screen that reads as someone
 *                          else's account.
 *   No policy rows.        The number of documents is the API's answer, and a
 *                          skeleton with four rows in it would be this app
 *                          asserting that there are four — the same claim
 *                          non-negotiable #10 forbids, made in grey. The policy
 *                          and help blocks appear when they arrive.
 *
 * The shimmer is an opacity loop and it stops under reduced motion, matching
 * HomeSkeleton — interaction-spec.md §3 removes motion rather than shortening it.
 */

import { useEffect, useRef } from 'react';
import { AccessibilityInfo, Animated, Easing, Platform, StyleSheet, View } from 'react-native';
import { color, radius } from '../../theme';
import { useCopy } from '../../i18n/language';

function useShimmer(delayMs: number) {
  const value = useRef(new Animated.Value(0.55)).current;
  useEffect(() => {
    let cancelled = false;
    void AccessibilityInfo.isReduceMotionEnabled().then((reduced) => {
      if (cancelled || reduced) return;
      Animated.loop(
        Animated.sequence([
          Animated.timing(value, {
            toValue: 1,
            duration: 800,
            delay: delayMs,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: Platform.OS !== 'web',
          }),
          Animated.timing(value, {
            toValue: 0.55,
            duration: 800,
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
  }, [value, delayMs]);
  return value;
}

function Bar({ width, height, style }: { width: number | string; height: number; style?: object }) {
  return (
    <View
      style={[
        { width: width as number, height, borderRadius: 6, backgroundColor: color.surfaceAlt2 },
        style,
      ]}
    />
  );
}

function RowBar() {
  return (
    <View style={styles.row}>
      <Bar width={92} height={12} />
      <Bar width={64} height={12} />
    </View>
  );
}

export function AccountSkeleton() {
  const copy = useCopy();
  const head = useShimmer(0);
  const profile = useShimmer(100);
  const rows = useShimmer(200);

  return (
    <View accessibilityRole="progressbar" accessibilityLabel={copy.loadingAria} aria-busy>
      <Animated.View style={{ opacity: head }}>
        <Bar width={128} height={24} style={styles.title} />
      </Animated.View>

      <Animated.View style={[styles.card, styles.profileCard, { opacity: profile }]}>
        <View style={styles.avatar} />
        <View style={styles.profileText}>
          <Bar width="66%" height={16} />
          <Bar width="46%" height={11} style={styles.gapTop} />
        </View>
      </Animated.View>

      <Animated.View style={{ opacity: rows }}>
        <Bar width={70} height={10} style={styles.sectionLabel} />
        <View style={styles.card}>
          <RowBar />
          <RowBar />
          <RowBar />
        </View>

        <Bar width={94} height={10} style={styles.sectionLabel} />
        <View style={styles.card}>
          <RowBar />
          <RowBar />
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  title: { marginTop: 4, marginBottom: 18 },
  card: {
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.hairline,
    borderRadius: radius.cardLg,
    paddingHorizontal: 16,
  },
  profileCard: { flexDirection: 'row', alignItems: 'center', gap: 13, paddingVertical: 16 },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: radius.card,
    backgroundColor: color.surfaceAlt2,
  },
  profileText: { flex: 1, minWidth: 0 },
  gapTop: { marginTop: 6 },
  sectionLabel: { marginTop: 24, marginBottom: 10, marginStart: 4 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 18,
    borderBottomWidth: 1,
    borderBottomColor: color.hairlineInner,
  },
});
