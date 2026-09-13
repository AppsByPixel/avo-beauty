/**
 * Wallet · Home → "Top up".
 *
 * WHY THERE *IS* A "+0.500" UNDER EACH AMOUNT NOW, AND A PAY→GET CARD.
 *
 * This file used to open with the opposite heading and an argument against both.
 * That argument is worth restating, because the half of it that was right is
 * still load-bearing and the figures below only exist because the other half was
 * answered rather than ignored:
 *
 *   > design/AVO Wallet Home.dc.html prints a bonus figure on each amount tile
 *   > and a calculation card on Home, both computed in the prototype as
 *   > `Math.round(amount * RATE)` from the member's tier. Reproducing that means
 *   > the client deciding what a top-up is worth, and the client is not allowed
 *   > to know … the number the customer was shown before paying is the one she
 *   > will hold the salon to.
 *
 * Every word of that about `Math.round(amount * RATE)` stands. What it got wrong
 * was treating "the client must not INVENT this number" and "the client must not
 * SHOW this number" as one decision. Non-negotiable #2 is the first; it has
 * never been the second. `domain/topupPreview.ts` shows the number without
 * inventing it: it runs the server's own sequence — `services/topup.ts` read
 * line by line, not summarised — over the same published inputs, using the same
 * shared functions from `@avo/types` that `POST /topups` uses. The old comment's
 * three specific objections are each answered there and each has a spec:
 *
 *   - stamps mode has no bonus → `bonusPercents` returns null in stamps mode,
 *     for BOTH halves, and nothing prints.
 *   - a branch top-up boost could stack → it cannot, on this path. The server
 *     passes `branch = null` for a top-up, which makes `decideEarning` skip
 *     branch boosts entirely; so does the preview. The old comment had this
 *     backwards, and that is precisely the drift it warned about, sitting in the
 *     warning itself.
 *   - the mock's POST applies the tier bonus only → the real one applies the
 *     tier bonus PLUS a live `topup10`/`topup20` window, and so does the
 *     preview. `topupPreviewParity.test.ts` pins the promotion half against the
 *     server's own `decideEarning`, imported, not re-typed.
 *
 * AND THE SHEET IS STILL THE AUTHORITY. Nothing here is a promise. The preview
 * is resolved against this device's clock at render; the server locks its answer
 * inside the `POST /topups` transaction. A window closing in between makes them
 * disagree — by design, not by defect — and the sheet wins: `useTopUp` renders
 * its calculation card from a real `TopUpIntentPublic`, and `pay()` fires only
 * from the `ready` stage, so the server's locked `creditFils` is on screen
 * before she commits. This card helps her pick a tile. The intent is the number
 * she is held to.
 *
 * THE CLOCK IS THE REASON THIS COMPONENT HAS STATE. A window opens or closes
 * while Home is on screen and the figures have to follow it, exactly as
 * `HappyHourBanner` does. Ticking is what keeps a stale render from being the
 * thing she taps — it does not make the preview authoritative, and nothing here
 * should be read as if it did.
 */

import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { formatFils, moneyAriaLabel, type Fils, type Member, type PromotionSet, type Salon } from '@avo/types';
import { color, MIN_TAP_TARGET, onBrandFill, radius, text } from '../theme';
import { useLanguage } from '../i18n/language';
import type { Copy } from '../copy/types';
import { TOP_UP_AMOUNTS } from '../domain/topup';
import { topUpPreview, type TopUpPreview } from '../domain/topupPreview';
import { Money } from './Money';

interface Props {
  member: Member;
  salon: Salon;
  /** Null when the promotions read failed — then no figure is shown at all. */
  promotions: PromotionSet | null;
  selected: Fils;
  onSelect: (amount: Fils) => void;
  onContinue: () => void;
}

/**
 * How often the preview re-resolves against the clock.
 *
 * THIRTY SECONDS, NOT ONE. `HappyHourBanner` ticks at 1s because it renders a
 * live countdown whose seconds change. Nothing here counts seconds: the figures
 * change only when a window opens or closes, which is a minute boundary. A
 * 1s interval would re-render four money nodes sixty times a minute to show the
 * same digits, on the screen that is most often left open.
 *
 * The half-minute of staleness this admits costs nothing, because the preview is
 * not what she is charged — see the header. The sheet re-asks the server.
 */
const PREVIEW_TICK_MS = 30_000;

/**
 * The badge and the line under the title, both modes.
 *
 * The tier goes in as a `TierName`, not as a rendered label, because Arabic
 * needs the noun in one of these strings and the adjective in the other —
 * `فضية · مكافأة +١٠٪` against `مستواكِ الفضي يضيف ١٠٪ …`. See copy/types.ts.
 *
 * NOTE WHAT THIS STILL DOES NOT DO: it reads the tier's PERCENTAGE and never a
 * computed sum, and it deliberately does not fold in a live promotion window.
 * The badge states a standing fact about her tier — "Silver · +10% bonus" — and
 * design:1174 writes it that way. The window's extra points show up where they
 * are actually earned, in the figures below, which is also where the sheet will
 * confirm them.
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

/**
 * "Pay 10.000 KD → Get 11.000 KD" — design:299-305.
 *
 * Built from `Money` rather than from a formatted string, because the design
 * sets the figure and its unit at different sizes and the unit has to be the one
 * `formatMoney` appended: a literal "KD" here is how an Arabic build renders
 * "11.000 KD" (non-negotiable #12). `Money` already owns that split and the
 * combined screen-reader label.
 *
 * THE ARROW IS A GLYPH, AND IT MIRRORS. The design draws an SVG and flips it
 * with `scaleX(-1)` (design:1889); in this stack the equivalent is the directional
 * character, chosen by language exactly as `tierBonusIllustration` already does
 * for the tier ladder — `10 → 10` in English, `10 ← 10` in Arabic (design:1716 /
 * :1722). i18n/rtl.ts § "directional glyphs" is the rule. The row itself needs
 * no mirroring: `flexDirection: 'row'` is already a logical direction, so Pay
 * and Get swap sides on their own.
 */
function PayGetCard({ amount, preview }: { amount: Fils; preview: TopUpPreview }) {
  const { lang, copy } = useLanguage();
  return (
    <View style={styles.payGet} testID="topup-pay-get">
      <View style={styles.payGetRow}>
        <View style={styles.payGetSide}>
          <Text style={[text('bodyS', lang), styles.payLabel]}>{copy.youPay}</Text>
          <Money
            amount={amount}
            color={color.ink}
            figureStyle={styles.payFigure}
            unitStyle={styles.payUnit}
          />
        </View>

        <Text style={styles.arrow} accessibilityElementsHidden importantForAccessibility="no">
          {lang === 'ar' ? '←' : '→'}
        </Text>

        <View style={styles.payGetSide}>
          <Text style={[text('bodyS', lang), styles.getLabel]}>{copy.topupGet}</Text>
          <Money
            amount={preview.creditFils}
            color={color.brandDeep}
            figureStyle={styles.getFigure}
            unitStyle={styles.getUnit}
          />
        </View>
      </View>
    </View>
  );
}

export function TopUpCard({
  member,
  salon,
  promotions,
  selected,
  onSelect,
  onContinue,
}: Props) {
  const { lang, copy } = useLanguage();
  const heading = bonusHeading(member, salon, copy);

  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), PREVIEW_TICK_MS);
    return () => clearInterval(id);
  }, []);

  const selectedPreview = topUpPreview(selected, member, salon, promotions, now);

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
          /**
           * PER TILE, not `selectedPreview` scaled. Each tile is a different
           * amount and therefore a different `percentOf` — and `percentOf`
           * rounds, so deriving three tiles from the fourth by ratio would be
           * the client doing money arithmetic of its own. Every figure on this
           * screen comes back through the same shared call.
           */
          const preview = topUpPreview(amount, member, salon, promotions, now);
          return (
            <Pressable
              key={amount}
              onPress={() => onSelect(amount)}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              // Non-negotiable #1: money reads as dinars, not as a bare number —
              // and that goes for the bonus too, which is a second amount on the
              // tile and must not reach a screen reader as a loose "+0.500".
              accessibilityLabel={
                preview
                  ? `${moneyAriaLabel(amount, lang)} ${copy.topupTileBonus(
                      moneyAriaLabel(preview.totalBonusFils, lang),
                    )}`
                  : moneyAriaLabel(amount, lang)
              }
              testID={`topup-amount-${amount}`}
              style={[styles.amount, on && styles.amountOn]}
            >
              <Text style={[styles.amountText, on && styles.amountTextOn]}>
                {formatFils(amount)}
              </Text>
              {preview ? (
                <View style={[styles.bonusPill, on && styles.bonusPillOn]}>
                  <Text
                    style={styles.bonusPillText}
                    testID={`topup-bonus-${amount}`}
                    accessibilityElementsHidden
                    importantForAccessibility="no"
                  >
                    {copy.topupTileBonus(formatFils(preview.totalBonusFils))}
                  </Text>
                </View>
              ) : null}
            </Pressable>
          );
        })}
      </View>

      {selectedPreview ? <PayGetCard amount={selected} preview={selectedPreview} /> : null}

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
    // design:1389 stacks the amount and its bonus pill with a 4px gap.
    paddingVertical: 12,
    gap: 4,
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

  /**
   * The bonus pill — design:1392 for the metrics.
   *
   * ITS SELECTED VARIANT IS NOT THE DESIGN'S, ON PURPOSE, AND THIS IS THE ONE
   * PLACE THE TWO PART COMPANY. The design's selected tile is a FILLED
   * `brand-deep` block with white text (design:1389), so its pill can be
   * translucent white on white. This build's selected tile is a `brandTint`
   * block with `brandDeep` text — a pre-existing divergence, not introduced
   * here and not mine to restyle — and translucent white on `brandTint` is
   * unreadable. So the pill inverts instead: tinted on the white tile, white on
   * the tinted tile, `brandDeep` text throughout. That preserves what the
   * design's pill is FOR, which is a chip that separates from the tile it sits
   * on, against the tile this app actually draws.
   */
  bonusPill: {
    paddingVertical: 1,
    paddingHorizontal: 7,
    borderRadius: radius.pill,
    backgroundColor: color.brandTint,
  },
  bonusPillOn: { backgroundColor: color.surface },
  bonusPillText: { fontSize: 10.5, fontWeight: '600', color: color.brandDeep },

  // --- the pay→get card. design:299, `margin-top:15px`.
  payGet: {
    marginTop: 15,
    // design uses `--brand-wash, #F6F7F3`, which is token `brandTint2` exactly.
    backgroundColor: color.brandTint2,
    borderWidth: 1,
    borderColor: color.brandTint,
    borderRadius: radius.input,
    paddingVertical: 15,
    paddingHorizontal: 16,
  },
  payGetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  payGetSide: { flexDirection: 'row', alignItems: 'baseline', gap: 5, flexShrink: 1 },
  payLabel: { color: color.textMuted },
  payFigure: { fontSize: 18, fontWeight: '600' },
  // `Money` applies ONE colour to the figure and its unit, so the design's muted
  // unit is not expressible through it. A colour set here would be overridden
  // and would read as a live rule that isn't one, so: size only.
  payUnit: { fontSize: 11.5 },
  getLabel: { color: color.brandDeeper, fontWeight: '600' },
  getFigure: { fontSize: 22, fontWeight: '600' },
  getUnit: { fontSize: 11.5 },
  arrow: { fontSize: 18, color: color.brandDeep, opacity: 0.5 },

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
