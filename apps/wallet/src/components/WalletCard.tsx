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
import { cardGradient, radius, shadow, text, WHITE } from '../theme';
import { en } from '../copy/en';
import { Money } from './Money';
import { tierLabel, type LoyaltyProgress } from '../domain/loyalty';

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
        <Text style={[text('label'), styles.headLabel]}>{en.balanceLabel}</Text>
        {pill ? (
          <View style={styles.pill}>
            <Text style={[text('bodyS'), styles.pillText]}>{pill}</Text>
          </View>
        ) : null}
      </View>

      <View style={styles.balanceRow}>
        <Money
          amount={balance}
          color={WHITE}
          figureStyle={text('displayXL')}
          unitStyle={styles.unit}
        />
      </View>

      {lastUpdated ? <Text style={[text('bodyS'), styles.stamp]}>{lastUpdated}</Text> : null}

      {progress ? <Progress progress={progress} /> : null}

      {children}
    </LinearGradient>
  );
}

function Progress({ progress }: { progress: LoyaltyProgress }) {
  if (progress.mode === 'stamps') {
    return (
      <View>
        <View style={styles.stampRow}>
          {Array.from({ length: progress.target }, (_, i) => (
            <View key={i} style={[styles.stampDot, i < progress.have && styles.stampDotFilled]} />
          ))}
        </View>
        <View style={styles.progressLegend}>
          <Text style={[text('bodyS'), styles.legendText]}>
            {en.stampsHint(progress.have, progress.target)}
          </Text>
          {progress.reward ? (
            <Text style={[text('bodyS'), styles.legendText]}>{progress.reward}</Text>
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
        <View style={[styles.trackFill, { width: `${progress.fraction * 100}%` }]} />
      </View>
      <View style={styles.progressLegend}>
        <Text style={[text('bodyS'), styles.legendText]}>
          {progress.next
            ? en.tierHint(progress.visitsToNext, tierLabel(progress.next))
            : tierLabel(progress.current)}
        </Text>
        <Text style={[text('bodyS'), styles.legendText]}>
          {tierLabel(progress.current)}
          {progress.next ? ` → ${tierLabel(progress.next)}` : ''}
        </Text>
      </View>
    </View>
  );
}

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
  pill: {
    paddingVertical: 5,
    paddingHorizontal: 11,
    borderRadius: radius.pill,
    // interaction-spec.md §2, documented exception — translucent white on the
    // gradient, ~3:1. Keep it; do not "fix" it to an opaque fill.
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  pillText: { color: WHITE, fontWeight: '600' },
  balanceRow: { marginTop: 12, marginBottom: 16 },
  unit: { fontSize: 17, opacity: 0.82, fontWeight: '500' },
  stamp: { color: 'rgba(255,255,255,0.78)', marginTop: -10, marginBottom: 16 },

  track: { height: 6, borderRadius: radius.pill, backgroundColor: 'rgba(255,255,255,0.22)', overflow: 'hidden' },
  trackFill: { height: '100%', borderRadius: radius.pill, backgroundColor: WHITE },
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
