/**
 * The happy-hour banner — design/AVO Wallet Home.dc.html:201-231.
 *
 * Two renderings and an absence:
 *
 *   live     tinted, a pulsing dot, the countdown as a filled pill, and the
 *            salon's wall clock underneath (design:202-214)
 *   next     white, a grey dot, the countdown as a muted pill (design:217-226)
 *   neither  nothing at all. Not a placeholder and not a "no offers today" card:
 *            a salon that has never run a happy hour must not have a
 *            happy-hour-shaped hole on its customers' home screens.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE ONE-SECOND TICK IS WHAT MAKES THE BANNER SAFE, NOT WHAT MAKES IT PRETTY.
 *
 * There is no `live` flag on the wire and no push when a window closes. The
 * banner is a pure function of `promotions` and the current instant, re-run
 * every second, so it expires on its own at `to` — which is also the second the
 * server stops applying the multiplier. `domain/happyHour.ts` carries the rest,
 * including why the clock is the salon's and not this phone's.
 *
 * The tick lives HERE rather than on `HomeScreen`, so a per-second re-render
 * touches one leaf instead of the whole wallet. Same reasoning as
 * `useWalletToken`'s countdown.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { PromotionSet, Salon } from '@avo/types';
import { color, radius, text, WHITE } from '../theme';
import { useLanguage } from '../i18n/language';
import { happyBanner } from '../domain/happyHour';
import { PulseDot } from './PulseDot';

interface Props {
  /** Null when the promotions read failed — see `useWalletHome`. */
  promotions: PromotionSet | null;
  salon: Salon;
}

export function HappyHourBanner({ promotions, salon }: Props) {
  const { lang, copy } = useLanguage();
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const banner = happyBanner(promotions, salon.branches, salon.timezone, now, lang, copy);
  if (!banner) return null;

  const live = banner.kind === 'live';

  return (
    // A summary rather than a live region: a screen reader announcing a
    // re-rendered countdown every second, over whatever else is being read,
    // would make the screen unusable. The same judgement `PaymentCode` makes
    // about its 45-second countdown.
    <View style={[styles.banner, live ? styles.bannerLive : styles.bannerNext]}
      accessibilityRole="summary"
    >
      {live ? (
        <PulseDot size={8} durationMs={1600} />
      ) : (
        <View style={styles.dotIdle} />
      )}

      <View style={styles.body}>
        <Text style={[text('bodyL', lang), live ? styles.titleLive : styles.titleNext]}>
          {banner.title}
        </Text>
        <Text style={[text('bodyS', lang), styles.sub]}>{banner.sub}</Text>
      </View>

      <View style={styles.trailing}>
        <View style={live ? styles.pillLive : styles.pillNext}>
          <Text style={[text('bodyS', lang), live ? styles.pillLiveText : styles.pillNextText]}>
            {banner.countdown}
          </Text>
        </View>
        {/*
          design:211 — the salon's wall clock under the live pill. It is there so
          a customer can see WHICH clock the countdown is being kept by, which is
          the whole point on a phone that may be roaming in another zone.
        */}
        {banner.clock ? (
          <Text style={[text('bodyS', lang), styles.clock]}>{banner.clock}</Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    borderWidth: 1,
    borderRadius: radius.card,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 14,
  },
  // `brandTint` is a SURFACE use of the brand — non-negotiable #9's own list.
  bannerLive: { backgroundColor: color.brandTint, borderColor: 'rgba(110,127,108,0.28)' },
  bannerNext: { backgroundColor: color.surface, borderColor: color.hairline },
  dotIdle: {
    width: 8,
    height: 8,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(28,27,25,0.2)',
    flexShrink: 0,
  },
  body: { flex: 1, minWidth: 0 },
  // Brand-coloured text on a light surface is brandDeeper here, matching
  // design:206 — never `brand`.
  titleLive: { color: color.brandDeeper, fontWeight: '600' },
  titleNext: { color: color.ink, fontWeight: '600' },
  sub: { color: color.textMuted, marginTop: 2 },
  trailing: { alignItems: 'flex-end', gap: 2, flexShrink: 0 },
  pillLive: {
    backgroundColor: color.brandDeep,
    borderRadius: radius.pill,
    paddingVertical: 5,
    paddingHorizontal: 10,
  },
  pillNext: {
    backgroundColor: color.surfaceAlt2,
    borderRadius: radius.pill,
    paddingVertical: 5,
    paddingHorizontal: 10,
  },
  // Non-negotiable #9: white on brandDeep, which is what the filled pill is.
  pillLiveText: { color: WHITE, fontWeight: '600' },
  pillNextText: { color: color.textMutedStrong, fontWeight: '600' },
  clock: { color: color.textMutedSoft, fontWeight: '600' },
});
