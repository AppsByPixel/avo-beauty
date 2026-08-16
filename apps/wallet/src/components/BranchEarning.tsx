/**
 * "Earning by branch", and the line the whole product hangs off:
 * "One wallet — valid at all branches."
 *
 * The multipliers are read from the platform promotion set — ONE source of
 * truth, shared with the dashboard (packages/types § PromotionSet). This screen
 * never keeps its own copy of a boost value, and there is no `live` flag: a
 * boost is whatever the published set says it is right now.
 */

import { StyleSheet, Text, View } from 'react-native';
import type { Branch, PromotionSet, Salon } from '@avo/types';
import { color, ARABIC_FAMILY, FRAUNCES_ITALIC, MICRO_LABEL_COLOR, radius, text } from '../theme';
import { useLanguage } from '../i18n/language';
import type { Copy } from '../copy/types';

interface Props {
  salon: Salon;
  promotions: PromotionSet;
}

/**
 * The multiplier badges. Both the multiplier and the boost percentage are
 * COUNTS, so Arabic renders them Eastern with the Arabic percent sign —
 * design/AVO Wallet Home.dc.html:1157-1158 writes `زيارات ×٢` and `+١٠٪ على
 * الشحن`. The copy module owns that; this only picks which string.
 */
function badgesFor(
  branch: Branch,
  promotions: PromotionSet,
  mode: Salon['loyaltyMode'],
  copy: Copy,
): string[] {
  const boost = promotions.boosts[branch.id];
  if (!boost) return [];
  const multiplier = mode === 'stamps' ? boost.stamp : boost.visit;
  const badges: string[] = [];
  if (multiplier > 1) {
    badges.push(
      mode === 'stamps' ? copy.stampsMultiplier(multiplier) : copy.visitsMultiplier(multiplier),
    );
  }
  if (boost.topup > 0) badges.push(copy.topupBoost(boost.topup));
  return badges;
}

export function BranchEarning({ salon, promotions }: Props) {
  const { lang, copy } = useLanguage();
  return (
    <View style={styles.section}>
      <Text style={[text('label', lang), styles.sectionLabel]}>{copy.branchEarnLabel}</Text>
      <View style={styles.row}>
        {salon.branches.map((branch) => {
          const badges = badgesFor(branch, promotions, salon.loyaltyMode, copy);
          return (
            <View key={branch.id} style={styles.chip}>
              {/*
                CONTRACT GAP (reported, not filled): `Branch.name` is a single
                string. The design's own reference implementation carries
                `nameAr` for every branch and for the salon
                (design/avo-promotions.js:33, :42-43) and renders it in AR, but
                api-contract.md's Branch and Salon have no Arabic field. So an
                Arabic wallet shows "Kuwait City" here. That is a shared-package
                change and belongs on trunk.
              */}
              <Text style={[text('bodyL', lang), styles.chipName]} numberOfLines={1}>
                {branch.name}
              </Text>
              <View style={styles.badgeRow}>
                {badges.length === 0 ? (
                  <Text style={[text('bodyS', lang), styles.plain]}>{copy.standardEarning}</Text>
                ) : (
                  badges.map((badge) => (
                    <View key={badge} style={styles.badge}>
                      <Text style={[text('bodyS', lang), styles.badgeText]}>{badge}</Text>
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

const styles = StyleSheet.create({
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
  chipName: { color: color.ink, fontWeight: '600' },
  badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  badge: {
    backgroundColor: color.brandTint,
    borderRadius: radius.pill,
    paddingVertical: 4,
    paddingHorizontal: 9,
  },
  // Brand-coloured text on a light surface is brandDeep, never brand.
  badgeText: { color: color.brandDeep, fontWeight: '600' },
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
});
