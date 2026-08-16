/**
 * The loading state.
 *
 * interaction-spec.md §4: "skeletons that match the real layout's shape, never a
 * centered spinner on a full page. Money fields skeleton as a bar — never render
 * 0.000 before data arrives; a customer seeing a zero balance for 200ms will
 * call the salon."
 *
 * So there is deliberately no number anywhere in this file. The balance is a bar
 * of roughly the width the real figure occupies, and the card keeps its real
 * radius and padding so nothing jumps when the data lands.
 *
 * The shimmer is an opacity loop, which is what survives prefers-reduced-motion
 * being honoured (interaction-spec.md §3 removes transforms, not state).
 */

import { useEffect, useRef } from 'react';
import { AccessibilityInfo, Animated, Easing, Platform, StyleSheet, View } from 'react-native';
import { color, radius, space } from '../theme';
import { useCopy } from '../i18n/language';

function useShimmer(delayMs: number) {
  const value = useRef(new Animated.Value(0.55)).current;
  useEffect(() => {
    let cancelled = false;
    void AccessibilityInfo.isReduceMotionEnabled().then((reduced) => {
      if (cancelled || reduced) return; // reduced motion: a flat bar, still a skeleton
      const loop = Animated.loop(
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
      );
      loop.start();
    });
    return () => {
      cancelled = true;
      value.stopAnimation();
    };
  }, [value, delayMs]);
  return value;
}

/**
 * A skeleton bar. Two tones, both from tokens: `surfaceAlt2` on the page ground
 * and the darker `disabledBg` inside the wallet-card block, which is itself a
 * tinted surface — one flat tone there would be invisible.
 */
function Bar({
  width,
  height,
  onCard,
  style,
}: {
  width: number | string;
  height: number;
  onCard?: boolean;
  style?: object;
}) {
  return (
    <View
      style={[
        {
          width: width as number,
          height,
          borderRadius: 6,
          backgroundColor: onCard ? color.disabledBg : color.surfaceAlt2,
        },
        style,
      ]}
    />
  );
}

export function HomeSkeleton() {
  const copy = useCopy();
  const head = useShimmer(0);
  const card = useShimmer(100);
  const list = useShimmer(200);

  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={copy.loadingAria}
      // Announce once. A live region on a skeleton chatters.
      aria-busy
    >
      <Animated.View style={[styles.headBlock, { opacity: head }]}>
        <Bar width={96} height={11} />
        <Bar width={74} height={17} />
      </Animated.View>

      <Animated.View style={[styles.card, { opacity: card }]}>
        <View style={styles.cardHead}>
          <Bar width={88} height={10} onCard />
          <Bar width={52} height={20} onCard style={styles.pillBar} />
        </View>
        {/* The balance. A bar, never a zero. */}
        <Bar width={172} height={40} onCard style={styles.balanceBar} />
        <Bar width="100%" height={6} onCard style={styles.trackBar} />

        <View style={styles.qrPanel}>
          <Bar width={82} height={82} onCard style={styles.qrBar} />
          <View style={styles.qrText}>
            <Bar width="72%" height={10} onCard />
            <Bar width="52%" height={16} onCard />
          </View>
        </View>
      </Animated.View>

      <Animated.View style={[styles.listCard, { opacity: list }]}>
        <Bar width={110} height={11} style={styles.listLabel} />
        {[0, 1, 2, 3].map((i) => (
          <View key={i} style={styles.listRow}>
            <Bar width={34} height={34} style={styles.rowIcon} />
            <View style={styles.rowText}>
              <Bar width="60%" height={11} />
              <Bar width="38%" height={9} />
            </View>
            <Bar width={58} height={13} />
          </View>
        ))}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  headBlock: { gap: 7 },
  card: {
    marginTop: 20,
    borderRadius: radius.walletCard,
    padding: 22,
    backgroundColor: color.surfaceAlt2,
  },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between' },
  pillBar: { borderRadius: radius.pill },
  balanceBar: { marginTop: 16, marginBottom: 18, borderRadius: 9 },
  trackBar: { borderRadius: radius.pill },
  qrPanel: {
    marginTop: 20,
    backgroundColor: color.surfaceAlt,
    borderRadius: radius.card,
    padding: 15,
    flexDirection: 'row',
    gap: 15,
  },
  qrBar: { borderRadius: 8 },
  qrText: { flex: 1, gap: 8, paddingTop: 4 },
  listCard: {
    marginTop: space.sectionGap,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.hairline,
    borderRadius: radius.cardLg,
    padding: 16,
  },
  listLabel: { marginBottom: 14 },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: 13, paddingVertical: 13 },
  rowIcon: { borderRadius: 11 },
  rowText: { flex: 1, gap: 6 },
});
