/**
 * The charge result — design:377-394.
 *
 * Every number on this screen comes off the charge response: the amount, the
 * new balance, the returned deposit, the loyalty outcome. Nothing is recomputed
 * from what the screen before it believed (non-negotiable #2).
 *
 * THE RETURNED DEPOSIT IS THE ONE ROW THAT IS NOT IN THE DESIGN, and it is here
 * because the design's result panel cannot explain a balance that went UP during
 * a charge. See the comment on the row itself and DECISIONS.md § "Five calls made
 * without asking", call 4.
 *
 * MOTION, per interaction-spec.md §3:
 *   - the success mark uses `avopop` (400ms, ease-out). Under reduced motion it
 *     renders at its final size with no animation — the mark still appears,
 *     because removing the state change is explicitly forbidden.
 *   - the receipt dot uses `avopulse` (1.1s loop). Under reduced motion the
 *     pulse is replaced by static text, exactly as the spec prescribes for
 *     pending dots.
 */

import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { fils } from '@avo/types';
import { copy } from '../copy/en';
import { loyaltySentence } from '../domain/loyalty';
import { useReducedMotion } from '../motion/useReducedMotion';
import { color, display, radius, ui } from '../theme';
import { DangerButton, PrimaryButton } from '../components/Buttons';
import { Money, moneyOf } from '../components/Money';
import type { ChargeAttempt } from './MemberScreen';

export function ResultScreen({
  attempt,
  onVoid,
  onNext,
}: {
  attempt: ChargeAttempt;
  onVoid: () => void;
  onNext: () => void;
}) {
  const reduceMotion = useReducedMotion();
  const { result, memberName, loyaltyPillText } = attempt;

  // The amount charged is the transaction's amount. It is stored negative (a
  // debit), so it is shown by magnitude — the word "Charged" carries the sign.
  const chargedFils = fils(Math.abs(result.transaction.amountFils));

  return (
    <View style={styles.screen}>
      <SuccessMark reduceMotion={reduceMotion} />

      <Text style={[display(26), styles.title]} testID="result-amount">
        {copy.charged(moneyOf(chargedFils))}
      </Text>
      <Text style={[ui(13.5), styles.sub]}>
        {memberName} · {loyaltyPillText}
      </Text>

      <View style={styles.panel}>
        {/*
          THE RETURNED DEPOSIT — DECISIONS.md § "Five calls made without asking",
          call 4.

          A 5.000 hold meeting a 3.000 basket is capped at the basket, and the
          remaining 2.000 goes back to her wallet as its own `deposit_return`
          transaction (non-negotiable #5 — it never became salon revenue). So the
          New balance below is 2.000 HIGHER than it was a moment ago, on a screen
          whose headline has just said "Charged". Without this row the artist
          watching the balance rise has nothing to tell her, and the only number
          the counter can see contradicts the only word above it.

          THE SERVER'S FIGURE, never `held − basket` computed here: non-negotiable
          #2 owns the difference as well as the balance, and `charge.ts` says the
          same thing from its end — "she held 5.000, spent 3.000, and 2.000 came
          back — three figures, and she is entitled to see all three."

          Rendered only when there IS a remainder. `depositReturnedFils` is 0 on
          every ordinary charge, and a "Deposit returned 0.000" row would be noise
          on almost every visit — 0 means "no remainder", which is exactly why the
          API sends it as 0-not-absent rather than omitting it.

          `depositAppliedFils` is deliberately NOT duplicated here: MemberScreen
          already showed it before the charge as the design's own "Deposit applied"
          total (design:369). The RETURN is the half no staff screen has ever shown.
        */}
        {result.depositReturnedFils > 0 ? (
          <View style={styles.panelRow} testID="result-deposit-returned">
            <Text style={[ui(13.5), styles.rowLabel]}>{copy.depositReturned}</Text>
            <Money
              amount={fils(result.depositReturnedFils)}
              figureStyle={display(13.5, '600')}
              unitStyle={[ui(13.5), styles.rowLabel]}
            />
          </View>
        ) : null}

        {/*
          The divider follows the row above rather than being fixed to this one:
          with no returned deposit this is the panel's FIRST row, and design:378's
          panel does not open with a rule.
        */}
        <View style={[styles.panelRow, result.depositReturnedFils > 0 && styles.divided]}>
          <Text style={[ui(13.5), styles.rowLabel]}>{copy.newBalance}</Text>
          <Money
            amount={fils(result.balanceAfterFils)}
            figureStyle={display(13.5, '600')}
            unitStyle={[ui(13.5), styles.rowLabel]}
          />
        </View>

        <View style={[styles.panelRow, styles.divided]}>
          <Text style={[ui(13.5), styles.rowLabel]}>{copy.loyalty}</Text>
          <Text style={[ui(13.5, '500'), styles.loyalty]} testID="result-loyalty">
            {loyaltySentence(result.loyalty)}
          </Text>
        </View>

        {/*
          The receipt. It is queued server-side inside the charge transaction
          (non-negotiable #3), so by the time this screen renders the job
          exists — which is what the design asserts by showing it as done.
        */}
        <View style={[styles.panelRow, styles.divided, styles.receiptRow]}>
          <ReceiptDot reduceMotion={reduceMotion} />
          <Text style={[ui(13.5), styles.rowLabel]}>
            {reduceMotion ? copy.receiptPending : copy.receiptSent}
          </Text>
        </View>
      </View>

      <View style={styles.actions}>
        <DangerButton label={copy.voidLast} onPress={onVoid} testID="result-void" />
        <PrimaryButton label={copy.nextCustomer} onPress={onNext} testID="result-next" />
      </View>
    </View>
  );
}

/** design:379 — `avopop`, 400ms ease-out, scale 0.6 → 1.08 → 1. */
function SuccessMark({ reduceMotion }: { reduceMotion: boolean }) {
  const scale = useRef(new Animated.Value(reduceMotion ? 1 : 0.6)).current;
  const opacity = useRef(new Animated.Value(reduceMotion ? 1 : 0)).current;

  useEffect(() => {
    if (reduceMotion) return;
    Animated.parallel([
      Animated.timing(scale, {
        toValue: 1,
        duration: 400,
        easing: Easing.out(Easing.back(1.4)),
        useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue: 1,
        duration: 200,
        easing: Easing.out(Easing.ease),
        useNativeDriver: true,
      }),
    ]).start();
  }, [reduceMotion, scale, opacity]);

  return (
    <Animated.View style={[styles.mark, { transform: [{ scale }], opacity }]}>
      <Svg width={34} height={34} viewBox="0 0 34 34" fill="none">
        <Path
          d="M8 17.5 14.5 24 26 11"
          stroke={color.white}
          strokeWidth={3.2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Svg>
    </Animated.View>
  );
}

/** design:386 — `avopulse`, 1.4s. Static under reduced motion (spec §3). */
function ReceiptDot({ reduceMotion }: { reduceMotion: boolean }) {
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (reduceMotion) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 0.35,
          duration: 700,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 1,
          duration: 700,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [reduceMotion, pulse]);

  return <Animated.View style={[styles.receiptDot, reduceMotion ? null : { opacity: pulse }]} />;
}

const styles = StyleSheet.create({
  // design:378 — padding 96/30/34, centred.
  screen: {
    flex: 1,
    backgroundColor: color.surface,
    alignItems: 'center',
    paddingTop: 96,
    paddingHorizontal: 30,
    paddingBottom: 34,
  },
  mark: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: color.brandDeep,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { marginTop: 22, textAlign: 'center' },
  sub: { color: color.textMuted, marginTop: 6, textAlign: 'center' },
  panel: {
    width: '100%',
    backgroundColor: color.white,
    borderWidth: 1,
    borderColor: color.hairline,
    borderRadius: radius.cardLg,
    paddingHorizontal: 18,
    marginTop: 28,
  },
  panelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 13,
    gap: 14,
  },
  divided: { borderTopWidth: 1, borderTopColor: color.hairlineInner },
  rowLabel: { color: color.textMutedLabel },
  loyalty: { flex: 1, textAlign: 'right', color: color.ink },
  receiptRow: { justifyContent: 'flex-start', gap: 8 },
  receiptDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: color.success },
  actions: { marginTop: 'auto', width: '100%', gap: 10 },
});
