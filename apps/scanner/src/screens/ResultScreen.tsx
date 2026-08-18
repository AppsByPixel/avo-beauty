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
  const depositApplied = fils(result.depositAppliedFils);

  /**
   * "CHARGED 0.000 KD" WAS ACCURATE AND SAID THE OPPOSITE OF WHAT HAPPENED.
   *
   * `transaction.amountFils` is the WALLET DEBIT, not the basket — which is what
   * the design's worked example means by charged (8.000 service − 5.000 deposit =
   * 3.000 charged, AVO Staff Scanner.dc.html:354). When the held deposit covers
   * the whole basket that debit is genuinely 0, so the headline read "Charged
   * 0.000 KD" directly above a returned-deposit row and a balance that had gone
   * UP. Every figure was right and the sentence was wrong.
   *
   * THE FIGURE IS NOT RECOMPUTED — the frame is. Putting the gross under the word
   * "Charged" would be this screen inventing a debit the server never made
   * (non-negotiable #2), so no amount is swapped for a bigger one; the words change
   * instead.
   *
   * AND THE DESIGN ALREADY DECIDED THIS, which is why nothing is invented here.
   * `AVO Wallet Home.dc.html:1707` renders exactly this case as the label
   * `rCharged` ("Charged") carrying the VALUE `vNothing` — "Nothing charged" at
   * :1271, "لم يُخصم شيء" at :1378. The bundle's own idiom for a zero debit is the
   * words rather than a 0.000 figure. This screen is English-only
   * (design/README.md:273) so it lifts the English; the Arabic already reaches the
   * customer through her own receipt.
   *
   * Conditioned on a deposit having been applied. A zero debit with no deposit is
   * not reachable — a basket must hold a priced service — and were it ever to
   * become so it would be a different fact, so it keeps the ordinary headline
   * rather than borrowing this explanation.
   */
  const settledByDeposit = chargedFils === 0 && depositApplied > 0;

  return (
    <View style={styles.screen}>
      <SuccessMark reduceMotion={reduceMotion} />

      <Text style={[display(26), styles.title]} testID="result-amount">
        {settledByDeposit ? copy.chargedNothing : copy.charged(moneyOf(chargedFils))}
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

          THE APPLIED HALF IS NOW HERE TOO, and that reverses an earlier call worth
          naming rather than quietly changing. It was left out because MemberScreen
          shows it BEFORE the charge as the design's own "Deposit applied" total
          (design:369), so repeating it looked redundant. It is not, once the
          headline can read "Nothing charged": that sentence says no money left her
          wallet and the panel then has to say what DID pay for the visit. Without
          it the three figures do not reconcile on screen — 6.000 of services,
          nothing charged, 4.000 back — and the artist cannot answer the only
          question a customer asks here.

          Shown whenever a deposit was applied, not only in the fully-covered case:
          on a partial one it is why the headline says 3.000 and not 8.000.
        */}
        {depositApplied > 0 ? (
          <View style={styles.panelRow} testID="result-deposit-applied">
            <Text style={[ui(13.5), styles.rowLabel]}>{copy.totalDeposit}</Text>
            <Money
              amount={depositApplied}
              figureStyle={display(13.5, '600')}
              unitStyle={[ui(13.5), styles.rowLabel]}
            />
          </View>
        ) : null}

        {result.depositReturnedFils > 0 ? (
          <View
            style={[styles.panelRow, depositApplied > 0 && styles.divided]}
            testID="result-deposit-returned"
          >
            <Text style={[ui(13.5), styles.rowLabel]}>{copy.depositReturned}</Text>
            <Money
              amount={fils(result.depositReturnedFils)}
              figureStyle={display(13.5, '600')}
              unitStyle={[ui(13.5), styles.rowLabel]}
            />
          </View>
        ) : null}

        {/*
          Each divider belongs to the row BELOW it and is conditional on something
          having been rendered above — design:378's panel does not open with a rule,
          and on an ordinary charge with no deposit at all this is still the first
          row. Two optional rows above it means the condition is "either one".
        */}
        <View
          style={[
            styles.panelRow,
            (depositApplied > 0 || result.depositReturnedFils > 0) && styles.divided,
          ]}
        >
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
