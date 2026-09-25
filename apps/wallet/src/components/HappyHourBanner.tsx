/**
 * The happy-hour banner — design/AVO Wallet Home.dc.html:201-231.
 *
 * Two renderings and an absence:
 *
 *   live     an AMBER ground, a pulsing amber dot, the countdown as a filled
 *            amber pill, and the salon's wall clock underneath (design:202-214).
 *            The design drew this state as a brand tint; it is amber now, and
 *            the styles below carry the reason.
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
import { color, radius, text, WHITE, withAlpha } from '../theme';
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
        <PulseDot size={8} durationMs={1600} fill={color.happyHourAccent} />
      ) : (
        <View style={styles.dotIdle} />
      )}

      <View style={styles.body}>
        <Text style={[text('bodyL', lang, '600'), live ? styles.titleLive : styles.titleNext]}>
          {banner.title}
        </Text>
        <Text style={[text('bodyS', lang), styles.sub]}>{banner.sub}</Text>
      </View>

      <View style={styles.trailing}>
        <View style={live ? styles.pillLive : styles.pillNext}>
          <Text style={[text('bodyS', lang, '600'), live ? styles.pillLiveText : styles.pillNextText]}>
            {banner.countdown}
          </Text>
        </View>
        {/*
          design:211 — the salon's wall clock under the live pill. It is there so
          a customer can see WHICH clock the countdown is being kept by, which is
          the whole point on a phone that may be roaming in another zone.
        */}
        {banner.clock ? (
          <Text style={[text('bodyS', lang, '600'), styles.clock]}>{banner.clock}</Text>
        ) : null}
      </View>
    </View>
  );
}

/**
 * The live banner's hairline, DERIVED FROM THE AMBER RATHER THAN TYPED.
 *
 * It was the literal `rgba(110,127,108,0.28)` — a 28% alpha of the old brand
 * `#6E7F6C`, sampled by hand off the design. Two things were wrong with that
 * even before the ramp moved: it is a re-typed hex, which CLAUDE.md forbids, and
 * it cannot follow the token it was sampled from. When the live state became
 * amber it would have been the one green thing left in an amber card.
 *
 * `happyHourAccent` at the same 28% keeps the design's weight — a hairline that
 * reads as a tint of its own ground rather than as a border — while tracking the
 * token. The alpha is the design's; only the hue it is taken from has moved.
 */
const LIVE_BORDER = withAlpha(color.happyHourAccent, 0.28);

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
  /*
    THE LIVE STATE IS AMBER, AND THAT IS THE WHOLE POINT OF IT.

    It was `brandTint` with a `brandDeeper` title and a `brandDeep` pill — the
    brand ramp, on a screen where everything else is already the brand ramp. A
    tint of the house colour does not read as "something is happening right now";
    it reads as another card. Happy hour is the one state on this screen that is
    time-boxed and that expires while you are looking at it, so it takes the one
    palette group that is NOT green.

    All three are trunk-owned tokens and the pairings are bounded by the
    packages/tokens audit: `happyHourText` on `happyHourBg` is 5.38:1 and white
    on the `happyHourAccent` pill is 5.07:1, both clear of AA. Non-negotiable #9
    is untouched by this — #9 governs `--avo-brand`, and after this change the
    live banner does not use the brand family at all.

    The NEXT state stays on `surface` deliberately. It is the quiet "coming
    later" rendering and it is not a happy hour happening; colouring it amber
    would spend the alarm on a state that has nothing to announce, and it reads
    on `surface` rather than on a tint precisely so the live one can be loud.
  */
  bannerLive: { backgroundColor: color.happyHourBg, borderColor: LIVE_BORDER },
  bannerNext: { backgroundColor: color.surface, borderColor: color.hairline },
  dotIdle: {
    width: 8,
    height: 8,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(28,27,25,0.2)',
    flexShrink: 0,
  },
  body: { flex: 1, minWidth: 0 },
  // The amber title on the amber ground — 5.38:1. design:206 asked for the
  // deepest brand step on a tint; the amber group's text step is its analogue,
  // and it is the same "darkest member of the group carries the text" rule.
  titleLive: { color: color.happyHourText },
  titleNext: { color: color.ink },
  sub: { color: color.textMuted, marginTop: 2 },
  trailing: { alignItems: 'flex-end', gap: 2, flexShrink: 0 },
  pillLive: {
    backgroundColor: color.happyHourAccent,
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
  // White on `happyHourAccent`, 5.07:1. Nothing about #9 changes here: the pill
  // no longer touches the brand family at all, and the amber it does use is
  // audited for white by packages/tokens exactly as `brandDeep` is.
  pillLiveText: { color: WHITE },
  pillNextText: { color: color.textMutedStrong },
  clock: { color: color.textMutedSoft },
});
