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
import { color, FRAUNCES_ITALIC, MICRO_LABEL_COLOR, radius, text } from '../theme';
import { en } from '../copy/en';

interface Props {
  salon: Salon;
  promotions: PromotionSet;
}

function badgesFor(
  branch: Branch,
  promotions: PromotionSet,
  mode: Salon['loyaltyMode'],
): string[] {
  const boost = promotions.boosts[branch.id];
  if (!boost) return [];
  const multiplier = mode === 'stamps' ? boost.stamp : boost.visit;
  const badges: string[] = [];
  if (multiplier > 1) {
    badges.push(
      mode === 'stamps' ? en.stampsMultiplier(multiplier) : en.visitsMultiplier(multiplier),
    );
  }
  if (boost.topup > 0) badges.push(en.topupBoost(boost.topup));
  return badges;
}

export function BranchEarning({ salon, promotions }: Props) {
  return (
    <View style={styles.section}>
      <Text style={[text('label'), styles.sectionLabel]}>{en.branchEarnLabel}</Text>
      <View style={styles.row}>
        {salon.branches.map((branch) => {
          const badges = badgesFor(branch, promotions, salon.loyaltyMode);
          return (
            <View key={branch.id} style={styles.chip}>
              <Text style={[text('bodyL'), styles.chipName]} numberOfLines={1}>
                {branch.name}
              </Text>
              <View style={styles.badgeRow}>
                {badges.length === 0 ? (
                  <Text style={[text('bodyS'), styles.plain]}>{en.standardEarning}</Text>
                ) : (
                  badges.map((badge) => (
                    <View key={badge} style={styles.badge}>
                      <Text style={[text('bodyS'), styles.badgeText]}>{badge}</Text>
                    </View>
                  ))
                )}
              </View>
            </View>
          );
        })}
      </View>
      <Text style={styles.note}>{en.branchNote}</Text>
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
});
