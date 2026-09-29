/**
 * "Earning by branch", and the line the whole product hangs off:
 * "One wallet — valid at all branches."
 *
 * The multipliers are read from the platform promotion set — ONE source of
 * truth, shared with the dashboard (packages/types § PromotionSet). This screen
 * never keeps its own copy of a boost value, and there is no `live` flag: a
 * boost is whatever the published set says it is right now.
 *
 * TWO RULINGS, 2026-09-29 (DECISIONS.md):
 *
 *   · NO TOP-UP CHIP. Aftab: "Remove it from boosts". A top-up happens in the
 *     app and has no branch, so the server never paid a branch boost's `topup`
 *     — the design's "+10% top-ups" chip was a promise of money nobody kept.
 *     The wire field stays (always 0) so installed apps parse; this reads it
 *     nowhere, so an old cached set or a server that still says 30 cannot
 *     bring the chip back. Top-up bonuses are stated where they are paid:
 *     tiers and happy hours (`domain/topupPreview.ts`).
 *
 *   · THE BOOST WINDOW. A boost applies from `startsAt` until `endsAt` and can
 *     be stopped (lane A, 6d102c5). A chip is shown only while `isBoostLive`
 *     says the boost runs at this instant, only when it carries no stop record,
 *     and only when its multiplier is above 1. That is DISPLAY (#2): the charge
 *     resolves the same predicate on the server, and what she earns is its.
 *
 *     The design draws no "until <date>" on a branch chip — the only "until" on
 *     Home is the happy-hour banner's — so the end is not shown. No copy is
 *     invented for it.
 */

import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { isBoostLive, type Boost, type Branch, type PromotionSet, type Salon } from '@avo/types';
import { color, ARABIC_FAMILY, FRAUNCES_ITALIC, MICRO_LABEL_COLOR, radius, text } from '../theme';
import { useLanguage } from '../i18n/language';
import { branchName } from '../domain/names';
import type { Copy } from '../copy/types';
import { brandedStyles } from '../theme/live';

interface Props {
  salon: Salon;
  /** Null when the promotions read failed — `useWalletHome § loadSnapshot`. */
  promotions: PromotionSet | null;
}

/** Whether a boost may be drawn at `now`: running, not stopped. Display only. */
function boostOnDisplay(boost: Boost | undefined, now: Date): boost is Boost {
  if (!boost) return false;
  // The server writes neutral values with the stop, so this is belt and braces:
  // a stop record is the fact to believe, whatever the multipliers say.
  if (boost.stoppedAt !== null) return false;
  return isBoostLive(boost, now);
}

/**
 * The multiplier badge. The multiplier is a COUNT, so Arabic renders it Eastern
 * — design/AVO Wallet Home.dc.html:1157 writes `زيارات ×٢`. The copy module owns
 * that; this only picks which string. At most one badge now: the design's
 * second, the top-up percentage (design:1158), is removed by ruling (header).
 */
function badgesFor(
  branch: Branch,
  promotions: PromotionSet,
  mode: Salon['loyaltyMode'],
  copy: Copy,
  now: Date,
): string[] {
  const boost = promotions.boosts[branch.id];
  if (!boostOnDisplay(boost, now)) return [];
  const multiplier = mode === 'stamps' ? boost.stamp : boost.visit;
  if (multiplier <= 1) return [];
  return [mode === 'stamps' ? copy.stampsMultiplier(multiplier) : copy.visitsMultiplier(multiplier)];
}

/**
 * The next instant any boost starts or ends, so the chips change at the
 * boundary rather than on the next unrelated re-render. Null when none is
 * ahead, or when it is further than a timer can wait (setTimeout's 32-bit
 * delay) — a Home that stays open for 24 days re-renders long before then.
 */
const MAX_TIMER_MS = 2 ** 31 - 1;
function nextBoundaryMs(promotions: PromotionSet | null, now: number): number | null {
  if (!promotions) return null;
  let next: number | null = null;
  for (const b of Object.values(promotions.boosts)) {
    for (const edge of [b.startsAt, b.endsAt]) {
      if (edge === null) continue;
      const t = Date.parse(edge);
      if (t > now && (next === null || t < next)) next = t;
    }
  }
  return next !== null && next - now < MAX_TIMER_MS ? next - now : null;
}

export function BranchEarning({ salon, promotions }: Props) {
  const { lang, copy } = useLanguage();
  // Re-read the clock at the next window edge. `now` is read at render, never
  // stored, so the chips are a function of the clock and the published set.
  const [, setTick] = useState(0);
  const now = new Date();
  const wait = nextBoundaryMs(promotions, now.getTime());
  useEffect(() => {
    if (wait === null) return undefined;
    const id = setTimeout(() => setTick((n) => n + 1), wait + 1);
    return () => clearTimeout(id);
  }, [wait]);
  /**
   * NO PROMOTION SET, NO SECTION — not a section full of "Standard earning".
   *
   * Every chip here is a claim about how much a visit is worth at a branch.
   * `badgesFor` returns no badges both when a branch genuinely has no boost and
   * when there is no set to look in, and those two must not render the same
   * thing: telling a customer she earns standard at Kuwait City, on a day the
   * merchant published 2× there, is a wrong statement about her money made from
   * an absent read. The whole section is absent instead.
   */
  if (!promotions) return null;
  return (
    <View style={styles.section}>
      <Text style={[text('label', lang), styles.sectionLabel]}>{copy.branchEarnLabel}</Text>
      <View style={styles.row}>
        {salon.branches.map((branch) => {
          const badges = badgesFor(branch, promotions, salon.loyaltyMode, copy, now);
          return (
            <View key={branch.id} style={styles.chip}>
              {/*
                THE GAP THIS NOTE REPORTED IS CLOSED. It said `Branch.name` is a
                single string and "an Arabic wallet shows 'Kuwait City' here" —
                which it did, long after `BranchSchema.nameAr` landed in
                `packages/types` and `GET /salons/{id}` started serving
                `"السالمية"` and `"مدينة الكويت"`. See `branchName` in
                domain/activity.ts for the whole history and the fallback.
              */}
              <Text style={[text('bodyL', lang, '600'), styles.chipName]} numberOfLines={1}>
                {branchName(branch, lang)}
              </Text>
              <View style={styles.badgeRow}>
                {badges.length === 0 ? (
                  <Text style={[text('bodyS', lang), styles.plain]}>{copy.standardEarning}</Text>
                ) : (
                  badges.map((badge) => (
                    <View key={badge} style={styles.badge}>
                      <Text style={[text('bodyS', lang, '600'), styles.badgeText]}>{badge}</Text>
                    </View>
                  ))
                )}
              </View>
            </View>
          );
        })}
      </View>
      {/*
        Fraunces has no Arabic glyphs, so the italic display note falls back to
        IBM Plex Sans Arabic. Plex has no true italic either; RN would synthesise
        an oblique, which for a cursive script is a distortion rather than a
        style. The Arabic note is therefore upright — the emphasis carries
        through size and colour, which is how the design's Arabic reads anyway.
      */}
      <Text style={[styles.note, lang === 'ar' && styles.noteAr]}>{copy.branchNote}</Text>
    </View>
  );
}

const styles = brandedStyles(() => ({
  section: { marginTop: 16 },
  sectionLabel: { color: MICRO_LABEL_COLOR, marginHorizontal: 4, marginBottom: 9 },
  row: { flexDirection: 'row', gap: 9 },
  chip: {
    flex: 1,
    minWidth: 0,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.hairline,
    borderRadius: radius.card,
    paddingVertical: 12,
    paddingHorizontal: 13,
  },
  chipName: { color: color.ink },
  badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  badge: {
    backgroundColor: color.brandTint,
    borderRadius: radius.pill,
    paddingVertical: 4,
    paddingHorizontal: 9,
  },
  // Brand-coloured text on a light surface is brandDeep, never brand.
  badgeText: { color: color.brandDeep },
  plain: { color: color.textMutedSoft, paddingVertical: 4 },
  note: {
    marginTop: 11,
    marginHorizontal: 4,
    fontFamily: FRAUNCES_ITALIC,
    fontStyle: 'italic',
    fontSize: 13.5,
    color: color.textMuted,
  },
  noteAr: { fontFamily: `${ARABIC_FAMILY}_400Regular`, fontStyle: 'normal' },
}));
