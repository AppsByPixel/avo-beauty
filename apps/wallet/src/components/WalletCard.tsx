/**
 * The signature element: the brand-coloured wallet card.
 *
 * Non-negotiable #9 lives here more than anywhere else in the app. This card is
 * the one place white text sits on a brand colour, and it is allowed to because
 * the fill is a GRADIENT between `card.from` and `card.to` — surface colours,
 * generated from the brand hex, not `brand` itself. Every white-on-brand FILL in
 * the app (the buttons below) uses `brandDeep` instead.
 *
 * interaction-spec.md §2 documents the two translucent pills on this card
 * (rgba(255,255,255,0.18) tier pill, 0.22 progress track) as intentional
 * exceptions at roughly 3:1. They are reproduced as designed.
 */

import { StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { fils, type Fils } from '@avo/types';
import { cardGradient, frauncesLineHeight, radius, shadow, text, WHITE } from '../theme';
import { useLanguage } from '../i18n/language';
import { Money } from './Money';
import { type LoyaltyProgress } from '../domain/loyalty';

interface Props {
  balanceFils: number;
  pill: string | null;
  progress: LoyaltyProgress | null;
  /** Offline shows the last-known balance under a "last updated" stamp. */
  lastUpdated: string | null;
  /** The payment code panel, or its offline replacement. */
  children?: React.ReactNode;
}

export function WalletCard({ balanceFils, pill, progress, lastUpdated, children }: Props) {
  const { lang, copy } = useLanguage();
  // fils() throws on a float. If a gateway or a migration ever puts 24.5 on the
  // wire, this card fails loudly instead of rendering "24.500" from a number
  // that was never integer fils.
  const balance: Fils = fils(balanceFils);

  return (
    <LinearGradient
      colors={[cardGradient.from, cardGradient.to]}
      start={{ x: 0.15, y: 0 }}
      end={{ x: 0.85, y: 1 }}
      style={styles.card}
    >
      <View style={styles.head}>
        {/*
          `letterSpacing: 1.5` below is dropped in Arabic by the same rule that
          drops it from the `label` token: tracking breaks the cursive joins and
          the word stops reading as a word. See theme/index.ts § text().
        */}
        <Text style={[text('label', lang), lang === 'ar' ? styles.headLabelAr : styles.headLabel]}>
          {copy.balanceLabel}
        </Text>
        {pill ? (
          <View style={styles.pill}>
            <Text style={[text('bodyS', lang, '600'), styles.pillText]}>{pill}</Text>
          </View>
        ) : null}
      </View>

      <View style={styles.balanceRow}>
        {/*
          `text('displayXL')` WITH NO LANGUAGE, AND IT HAS TO BE. `Money` draws
          the figure with `fontFamily: moneyFigureFace()` layered over whatever
          `figureStyle` carries, so the family here is overwritten either way —
          but passing `lang` would still be wrong as a statement of intent. In
          Arabic `text('displayXL', 'ar')` resolves to IBM Plex Sans Arabic, and
          the figure is Western digits in the display face in both languages
          (non-negotiable #12). This call supplies the SIZE. The unit beside it
          is the half that changes script, and `Money` resolves its face from
          the language itself — this card supplies only the unit's size and
          weight.
        */}
        <Money
          amount={balance}
          color={WHITE}
          figureStyle={text('displayXL')}
          unitStyle={styles.unit}
          unitWeight="500"
        />
      </View>

      {lastUpdated ? (
        <Text style={[text('bodyS', lang), styles.stamp]}>{lastUpdated}</Text>
      ) : null}

      {progress ? <Progress progress={progress} /> : null}

      {children}
    </LinearGradient>
  );
}

function Progress({ progress }: { progress: LoyaltyProgress }) {
  const { lang, copy } = useLanguage();

  if (progress.mode === 'stamps') {
    return (
      <View>
        <View style={styles.stampRow}>
          {Array.from({ length: progress.target }, (_, i) => (
            <View key={i} style={[styles.stampDot, i < progress.have && styles.stampDotFilled]} />
          ))}
        </View>
        <View style={styles.progressLegend}>
          <Text style={[text('bodyS', lang), styles.legendText]}>
            {copy.stampsHint(progress.have, progress.target)}
          </Text>
          {/*
            GAP CLOSED, AND THE NOTE HERE HAD OUTLIVED IT. This said the contract
            carried the reward "in one language only" and that an Arabic wallet
            therefore rendered English. `SalonSchema` has carried `stampRewardAr`
            alongside `stampReward` for as long as the seed has set it, so the
            Arabic was on the wire and being dropped. `loyaltyProgress` now
            resolves it through `domain/names.ts#stampRewardName`, whose header
            carries the full account.
          */}
          {progress.reward ? (
            <Text style={[text('bodyS', lang), styles.legendText]}>{progress.reward}</Text>
          ) : null}
        </View>
      </View>
    );
  }

  return (
    <View>
      <View
        style={styles.track}
        accessibilityRole="progressbar"
        accessibilityValue={{ min: 0, max: 100, now: Math.round(progress.fraction * 100) }}
      >
        {/*
          THE FILL GROWS FROM THE READING EDGE, not from the physical left. A bar
          anchored left in an Arabic layout reads backwards — "almost none left"
          when it means "almost there". The anchor is in the stylesheet below,
          and the reason it takes no language conditional is measured, not
          assumed. See i18n/rtl.ts.
        */}
        <View style={[styles.trackFill, { width: `${progress.fraction * 100}%` }]} />
      </View>
      <View style={styles.progressLegend}>
        <Text style={[text('bodyS', lang), styles.legendText]}>
          {progress.next
            ? copy.tierHint(progress.visitsToNext, progress.next)
            : copy.tierName[progress.current]}
        </Text>
        {/* The ladder arrow follows the reading direction — → in EN, ← in AR. */}
        <Text style={[text('bodyS', lang), styles.legendText]}>
          {copy.tierLadder(progress.current, progress.next)}
        </Text>
      </View>
    </View>
  );
}

/**
 * THE LEADING `Money` HAS TO ADD TO THE BALANCE FIGURE, AND WHAT IT COSTS HERE.
 *
 * `displayXL` asks for a 47px box around a 52px figure. Fraunces needs 65px, so
 * `Money` raises the box (see `Money.tsx` § `fittedFigureBox`) and the figure
 * stops being clipped. That raise is 18px of extra leading, and a taller line
 * box would otherwise push the balance DOWN the card and everything under it
 * down with it — trading a clipped number for a moved one.
 *
 * A line box distributes its leading as half-leading: half above the glyphs and
 * half below. So giving back half of the raise at the top and half at the
 * bottom leaves the figure's baseline exactly where it is today and the row's
 * total height unchanged. Nothing moves; the apex simply stops being cut.
 *
 * DERIVED, NOT MEASURED ONCE AND TYPED. Every term comes from the token and the
 * font metric, so if either moves the compensation follows. If `displayXL` ever
 * stops declaring a `lineHeight`, this falls to 0 on its own — which is right,
 * because `Money` would have nothing to raise either.
 */
const BALANCE_TYPE = text('displayXL');
const BALANCE_SIZE = BALANCE_TYPE.fontSize ?? 0;
const BALANCE_HALF_LEADING =
  Math.max(0, frauncesLineHeight(BALANCE_SIZE) - (BALANCE_TYPE.lineHeight ?? Infinity)) / 2;

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.walletCard,
    padding: 22,
    // design/tokens/avo-tokens.json → shadow.walletCard, used verbatim. React
    // Native takes a CSS box-shadow string here, so the token needs no
    // translation into shadowOffset/shadowRadius and cannot drift from the web
    // surfaces that read the same value out of the CSS custom property.
    boxShadow: shadow.walletCard,
  },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headLabel: { color: WHITE, opacity: 0.85, letterSpacing: 1.5 },
  headLabelAr: { color: WHITE, opacity: 0.85 },
  pill: {
    paddingVertical: 5,
    paddingHorizontal: 11,
    borderRadius: radius.pill,
    // interaction-spec.md §2, documented exception — translucent white on the
    // gradient, ~3:1. Keep it; do not "fix" it to an opaque fill.
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  pillText: { color: WHITE },
  // 12 / 16 are the design's margins; the subtraction is the half-leading
  // `Money` adds to make the figure fit its face. See BALANCE_HALF_LEADING.
  balanceRow: {
    marginTop: 12 - BALANCE_HALF_LEADING,
    marginBottom: 16 - BALANCE_HALF_LEADING,
  },
  // The unit — "KD" / "د.ك" — takes its family from the language's type scale,
  // resolved inside `Money`; only the size and opacity are set here. THE WEIGHT
  // MOVED OUT TWICE, and both moves are worth keeping because they are the same
  // mistake at two altitudes. First: `fontWeight: '500'` lived in this object,
  // behind `text()`'s pinned single-weight family, and selected nothing — the
  // unit drew Regular in both languages. It became `text('bodyL', lang, '500')`
  // in the `unitStyle` array at the call site. That was correct HERE and was a
  // rule only this one caller followed; the other three passed a bare size and
  // drew the OS UI font. So the composition moved into `Money`, and this card
  // now passes `unitWeight="500"` — the same Inter_500Medium and
  // IBMPlexSansArabic_500Medium, chosen in the one place every caller goes
  // through.
  unit: { fontSize: 17, opacity: 0.82 },
  stamp: { color: 'rgba(255,255,255,0.78)', marginTop: -10, marginBottom: 16 },

  track: { height: 6, borderRadius: radius.pill, backgroundColor: 'rgba(255,255,255,0.22)', overflow: 'hidden' },
  // alignSelf: 'flex-start' is the CROSS-axis start of this column container,
  // which is the LEFT in English and the RIGHT in Arabic. Do not "fix" it to
  // flex-end for RTL — that double-flips it. Measured, see i18n/rtl.ts.
  trackFill: {
    height: '100%',
    borderRadius: radius.pill,
    backgroundColor: WHITE,
    alignSelf: 'flex-start',
  },
  progressLegend: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 8,
    gap: 10,
  },
  legendText: { color: WHITE, opacity: 0.88 },

  stampRow: { flexDirection: 'row', gap: 7 },
  stampDot: {
    flex: 1,
    height: 20,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255,255,255,0.22)',
  },
  stampDotFilled: { backgroundColor: WHITE },
});
