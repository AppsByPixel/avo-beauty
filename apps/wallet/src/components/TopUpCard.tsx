/**
 * Wallet · Home → "Top up".
 *
 * WHY THERE IS NO "+2.500" UNDER EACH AMOUNT, and no you-pay→you-get card here.
 *
 * design/AVO Wallet Home.dc.html prints a bonus figure on each amount tile and a
 * calculation card on Home, both computed in the prototype as
 * `Math.round(amount * RATE)` from the member's tier. Reproducing that means the
 * client deciding what a top-up is worth, and the client is not allowed to know:
 *
 *   - api-contract.md § TopUpIntent puts `bonusFils` on the intent, server-side.
 *   - The bonus does not exist at all in stamps mode.
 *   - A branch top-up boost (`promotions.boosts[branch].topup`, 0–30%) can stack
 *     on the tier bonus. The mock's POST /topups applies the tier bonus only, so
 *     a client-side 10% and the server's number can already disagree today — and
 *     the number the customer was shown before paying is the one she will hold
 *     the salon to.
 *
 * So the tiles carry amounts, the badge carries the *percentage* the server sent
 * with the salon (a rate, not a computed sum), and the calculation card lives in
 * the sheet where it renders a real TopUpIntent. The customer still sees what she
 * gets before she commits to anything — one tap later, and from the server.
 */

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { formatFils, moneyAriaLabel, type Fils, type Member, type Salon } from '@avo/types';
import { color, MIN_TAP_TARGET, onBrandFill, radius, text } from '../theme';
import { useLanguage } from '../i18n/language';
import type { Copy } from '../copy/types';
import { TOP_UP_AMOUNTS } from '../domain/topup';

interface Props {
  member: Member;
  salon: Salon;
  selected: Fils;
  onSelect: (amount: Fils) => void;
  onContinue: () => void;
}

/**
 * The badge and the line under the title, both modes.
 *
 * The tier goes in as a `TierName`, not as a rendered label, because Arabic
 * needs the noun in one of these strings and the adjective in the other —
 * `فضية · مكافأة +١٠٪` against `مستواكِ الفضي يضيف ١٠٪ …`. See copy/types.ts.
 */
function bonusHeading(
  member: Member,
  salon: Salon,
  copy: Copy,
): { badge: string; explain: string } | null {
  if (salon.loyaltyMode === 'stamps') {
    const target = salon.stampTarget ?? 0;
    if (target <= 0) return null;
    return { badge: copy.stampsBadge(target), explain: copy.stampsExplain };
  }
  const tier = salon.tiers?.find((t) => t.name === member.tier);
  if (!tier || tier.bonusPercent <= 0) return null;
  return {
    badge: copy.tierBonusBadge(tier.name, tier.bonusPercent),
    explain: copy.tierBonusExplain(tier.name, tier.bonusPercent),
  };
}

export function TopUpCard({ member, salon, selected, onSelect, onContinue }: Props) {
  const { lang, copy } = useLanguage();
  const heading = bonusHeading(member, salon, copy);

  return (
    <View style={styles.card} testID="topup-card">
      <View style={styles.headRow}>
        <Text style={[text('displayS', lang), styles.title]}>{copy.topupTitle}</Text>
        {heading ? (
          <View style={styles.badge}>
            <View style={styles.badgeDot} />
            <Text style={[text('bodyS', lang), styles.badgeText]}>{heading.badge}</Text>
          </View>
        ) : null}
      </View>
      {heading ? (
        <Text style={[text('bodyS', lang), styles.explain]}>{heading.explain}</Text>
      ) : null}

      <View style={styles.grid}>
        {TOP_UP_AMOUNTS.map((amount) => {
          const on = amount === selected;
          return (
            <Pressable
              key={amount}
              onPress={() => onSelect(amount)}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              // Non-negotiable #1: money reads as dinars, not as a bare number.
              accessibilityLabel={moneyAriaLabel(amount, lang)}
              testID={`topup-amount-${amount}`}
              style={[styles.amount, on && styles.amountOn]}
            >
              <Text style={[styles.amountText, on && styles.amountTextOn]}>
                {formatFils(amount)}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <Pressable
        onPress={onContinue}
        accessibilityRole="button"
        testID="topup-continue"
        style={styles.cta}
      >
        <Text style={[text('bodyL', lang), styles.ctaText]}>{copy.continuePay}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: 22,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.hairline,
    borderRadius: radius.walletCard,
    padding: 19,
  },
  headRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    marginBottom: 5,
  },
  title: { color: color.ink, flexShrink: 1 },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: color.brandTint,
    paddingVertical: 5,
    paddingHorizontal: 11,
    borderRadius: radius.pill,
  },
  // `brand` as a surface: a dot, not a text fill. Non-negotiable #9.
  badgeDot: { width: 6, height: 6, borderRadius: radius.pill, backgroundColor: color.brand },
  badgeText: { color: color.brandDeep, fontWeight: '600' },
  explain: { color: color.textMuted, marginBottom: 15 },

  grid: { flexDirection: 'row', gap: 9 },
  amount: {
    flex: 1,
    minHeight: MIN_TAP_TARGET,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.input,
    borderWidth: 1,
    borderColor: color.borderControl,
    backgroundColor: color.surface,
  },
  amountOn: { borderColor: color.brandDeep, backgroundColor: color.brandTint },
  amountText: {
    fontFamily: 'Fraunces_600SemiBold',
    fontWeight: '600',
    fontSize: 16,
    color: color.ink,
  },
  amountTextOn: { color: color.brandDeep },

  cta: {
    marginTop: 13,
    minHeight: MIN_TAP_TARGET,
    paddingVertical: 15,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.button,
    // Non-negotiable #9 — white on brandDeep, never on brand.
    backgroundColor: onBrandFill.backgroundColor,
  },
  ctaText: { color: onBrandFill.color, fontWeight: '600' },
});
