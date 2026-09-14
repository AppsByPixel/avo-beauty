/**
 * The typed-price entry control — an amount in KD and the reason beside it.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * NO DESIGN SOURCE, AND THAT IS WORTH SAYING OUT LOUD.
 * ═════════════════════════════════════════════════════════════════════════════
 * `design/AVO Staff Scanner.dc.html` draws no custom-amount control. The scanner
 * it specifies can only charge what is on the service menu — which is precisely
 * the gap Aftab's ruling closes — so there is no drawn treatment to be faithful
 * to and none of the copy here can be verbatim.
 *
 * So this is BUILT FROM THE BUNDLE'S EXISTING PARTS rather than invented beside
 * them: the field frame, radius and focus colour are the service chip's
 * (:325-374), the reason field is the void sheet's reason block one level down
 * (:305-322), the refusal colour is the shortfall banner's (:364), and the
 * disclosure link is the same `LinkButton` the header uses. Nothing new is
 * styled; what is new is the arrangement. Marked rather than hidden — inventing
 * a treatment is a decision, and this is the decision.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THIS COMPONENT DECIDES NOTHING.
 * ═════════════════════════════════════════════════════════════════════════════
 * Every rule — what the field accepts, how KD becomes fils, the ceiling, whether
 * the button may be enabled — is in `domain/customAmount.ts`, where the
 * package's node-only vitest can reach it. A rule left in here is a rule nothing
 * in this package can test, which is the lesson `domain/deepLink.ts` was written
 * to record. This file renders a `TypedAmount` and calls back.
 */

import { StyleSheet, Text, TextInput, View } from 'react-native';
import { formatMoney } from '@avo/types';
import { copy } from '../copy/en';
import {
  CUSTOM_AMOUNT_MAX_FILS,
  REASON_MAX_CHARS,
  type TypedAmount,
} from '../domain/customAmount';
import { color, display, MIN_TAP_TARGET, radius, ui } from '../theme';

/**
 * The keyboard-side sentence for a refused figure, or null when there is
 * nothing to say yet.
 *
 * A COURTESY, NOT A CONTROL (non-negotiable #7 applied to a money field). The
 * server re-checks every one of these and answers `invalid_amount` /
 * `amount_above_ceiling` regardless of what this function returned. What it buys
 * is a sentence at the keyboard rather than a round trip in front of a customer
 * — which is a different thing from preventing the refusal, and
 * `MemberScreen`'s failure panel renders the server's version when it arrives.
 *
 * `empty` is silent on purpose: an untouched field is not a mistake.
 */
function fieldNote(amount: TypedAmount): string | null {
  switch (amount.state) {
    case 'empty':
      return null;
    case 'ok':
      return copy.typedPriceConfirm(formatMoney(amount.amountFils));
    case 'above-ceiling':
      return copy.typedPriceAboveCeiling(
        formatMoney(amount.amountFils),
        // The server's ceiling, formatted through the display boundary rather
        // than a hand-rolled `/1000 .toFixed(3)` — `formatMoney` groups
        // thousands, which is exactly what a figure this size needs.
        formatMoney(CUSTOM_AMOUNT_MAX_FILS),
      );
    case 'invalid':
      switch (amount.why) {
        case 'too-precise':
          return copy.typedPriceTooPrecise;
        case 'zero':
          return copy.typedPriceZero;
        default:
          return copy.typedPriceNotANumber;
      }
  }
}

export function TypedAmountCard({
  raw,
  amount,
  reason,
  onRawChange,
  onReasonChange,
}: {
  raw: string;
  amount: TypedAmount;
  reason: string;
  onRawChange: (next: string) => void;
  onReasonChange: (next: string) => void;
}) {
  const note = fieldNote(amount);
  const bad = amount.state === 'invalid' || amount.state === 'above-ceiling';

  return (
    <View style={styles.card} testID="typed-amount-card">
      <View style={styles.head}>
        <Text style={display(17)}>{copy.typedPriceTitle}</Text>
        {/*
          Names the authority on the control itself. The padlock elsewhere in
          this app explains an ABSENCE; this explains a presence, so a staff
          member who has it knows the charge is attributed to her before she
          types rather than after a manager asks about it.
        */}
        <Text style={[ui(11.5), styles.authority]}>{copy.typedPriceAuthority}</Text>
      </View>

      <Text style={[ui(11.5, '600'), styles.label]}>
        {copy.typedPriceAmountLabel.toUpperCase()}
      </Text>
      <TextInput
        value={raw}
        onChangeText={onRawChange}
        /*
          `decimal-pad`, NOT `numeric` and NOT `number-pad`.

          `number-pad` has no decimal point at all on iOS, which would make
          18.500 untypeable; `numeric` adds a sign and, on some locales, a
          grouping separator — both of which `parseTypedKd` refuses, so the
          keyboard would be offering keys that produce a refusal. `decimal-pad`
          is digits and one separator, which is exactly the accepted alphabet.

          The separator that pad emits is still LOCALE-DEPENDENT: a device set
          to a comma locale produces `18,5`, which is refused as not-a-number
          rather than silently read as 18.500. Refusing is right — guessing which
          of two marks a user meant is guessing about money — but the sentence
          she gets should eventually name the point. Reported.
        */
        keyboardType="decimal-pad"
        inputMode="decimal"
        placeholder={copy.typedPriceAmountPlaceholder}
        placeholderTextColor={color.textMutedSoft}
        accessibilityLabel={copy.typedPriceAmountLabel}
        testID="typed-amount-input"
        style={[display(30, '600'), styles.amountField, bad ? styles.fieldBad : styles.fieldOk]}
      />

      {note && (
        <Text
          style={[ui(12.5), bad ? styles.noteBad : styles.noteOk]}
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          testID="typed-amount-note"
        >
          {note}
        </Text>
      )}

      <View style={styles.reasonHead}>
        <Text style={[ui(11.5, '600'), styles.label]}>
          {copy.typedPriceReasonLabel.toUpperCase()}
        </Text>
        <Text style={[ui(11), styles.counter]} testID="typed-reason-count">
          {copy.typedPriceReasonCount(reason.trim().length, REASON_MAX_CHARS)}
        </Text>
      </View>
      <TextInput
        value={reason}
        onChangeText={onReasonChange}
        placeholder={copy.typedPriceReasonPlaceholder}
        placeholderTextColor={color.textMutedSoft}
        accessibilityLabel={copy.typedPriceReasonLabel}
        testID="typed-reason-input"
        multiline
        /*
          CAPPED AT THE FIELD, not truncated at submit. `requireString(…, 300)`
          answers a longer string with `400 invalid_request` — "reason is too
          long" — and silently cutting her sentence to fit would send words she
          did not write into the audit log. The counter above shows the budget.
        */
        maxLength={REASON_MAX_CHARS}
        style={[ui(14), styles.reasonField]}
      />
      <Text style={[ui(11.5), styles.why]}>{copy.typedPriceReasonWhy}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.card,
    backgroundColor: color.white,
    borderWidth: 1,
    borderColor: color.hairline,
    padding: 16,
    marginTop: 16,
    gap: 8,
  },
  head: { gap: 3, marginBottom: 4 },
  authority: { color: color.textMutedSoft },
  /*
    `textMutedLabel` (0.65), NOT `textMutedSoft` (0.45).

    These two are uppercase micro-labels, and the token file names that case
    explicitly: 0.45 measures ~3.3:1 at this size and fails, 0.65 clears 4.5:1 on
    the darkest surface a label lands on. Small uppercase text is the hardest
    case to read, not a large-text exemption.
  */
  label: { color: color.textMutedLabel, letterSpacing: 0.6 },
  amountField: {
    minHeight: MIN_TAP_TARGET + 12,
    borderRadius: radius.input,
    borderWidth: 1.5,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: color.surface,
    color: color.ink,
  },
  fieldOk: { borderColor: color.borderControl },
  fieldBad: { borderColor: color.dangerText },
  noteOk: { color: color.textMuted, lineHeight: 18 },
  noteBad: { color: color.dangerText, lineHeight: 18 },
  reasonHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  counter: { color: color.textMuted },
  reasonField: {
    minHeight: MIN_TAP_TARGET + 18,
    borderRadius: radius.input,
    borderWidth: 1.5,
    borderColor: color.borderControl,
    paddingHorizontal: 14,
    paddingVertical: 11,
    backgroundColor: color.surface,
    color: color.ink,
    textAlignVertical: 'top',
  },
  why: { color: color.textMutedSoft, lineHeight: 17 },
});
