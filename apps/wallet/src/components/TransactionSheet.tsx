/**
 * The transaction detail sheet — every activity row opens it.
 *
 * The rows come from domain/receipt.ts, which documents which of the designed
 * rows the contract can actually supply and which are not built rather than
 * faked. The two things this file adds on top of them:
 *
 *   · the reference, always, in its own footer row — it is what support traces a
 *     payment by, so it is never conditional on the outcome
 *   · "Report a problem with this payment", which hands that reference to the
 *     contact form (src/support/contact.ts)
 *
 * Dismissible, unlike the redirect stage: nothing is in flight here.
 */

import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Transaction } from '@avo/types';
import { color, radius, text } from '../theme';
import { en } from '../copy/en';
import { buildReceipt } from '../domain/receipt';
import { startPaymentReport } from '../support/contact';
import { Sheet } from './Sheet';
import { SecondaryButton } from './Buttons';

interface Props {
  transaction: Transaction | null;
  branches: { id: string; name: string }[];
  onClose: () => void;
}

export function TransactionSheet({ transaction, branches, onClose }: Props) {
  const receipt = transaction ? buildReceipt(transaction, branches) : null;

  return (
    <Sheet
      open={receipt !== null}
      dismissible
      onDismiss={onClose}
      label={receipt?.title ?? ''}
      testID="tx-sheet"
    >
      {receipt ? (
        <ScrollView showsVerticalScrollIndicator={false}>
          <View style={styles.head}>
            <Text
              accessibilityLabel={receipt.amountLabel}
              style={[
                styles.amount,
                { color: receipt.positive ? color.positive : color.ink },
              ]}
            >
              {receipt.amount}
            </Text>
            <Text style={[text('displayS'), styles.title]}>{receipt.title}</Text>
            <Text style={[text('bodyS'), styles.subtitle]}>{receipt.subtitle}</Text>
            {/*
              interaction-spec.md §2: a status pill must carry its meaning as
              text, not as colour alone. The word is the status; the tint only
              reinforces it.
            */}
            <View
              style={[
                styles.pill,
                receipt.statusTone === 'warn'
                  ? styles.pillWarn
                  : receipt.statusTone === 'bad'
                    ? styles.pillBad
                    : styles.pillGood,
              ]}
              testID="tx-status"
            >
              <View
                style={[
                  styles.pillDot,
                  receipt.statusTone === 'warn'
                    ? styles.pillDotWarn
                    : receipt.statusTone === 'bad'
                      ? styles.pillDotBad
                      : styles.pillDotGood,
                ]}
              />
              <Text
                style={[
                  text('bodyS'),
                  styles.pillText,
                  receipt.statusTone === 'warn'
                    ? styles.pillTextWarn
                    : receipt.statusTone === 'bad'
                      ? styles.pillTextBad
                      : styles.pillTextGood,
                ]}
              >
                {receipt.status}
              </Text>
            </View>
          </View>

          <View style={styles.rowsCard} testID="tx-rows">
            {receipt.rows.map((row) => (
              <View key={row.label} style={styles.row}>
                <Text style={[text('body'), styles.rowLabel]}>{row.label}</Text>
                <Text
                  accessibilityLabel={row.valueLabel}
                  style={[row.emphasis ? styles.rowValueMoney : styles.rowValue]}
                >
                  {row.value}
                </Text>
              </View>
            ))}
            <View style={[styles.row, styles.rowLast]}>
              <Text style={[text('body'), styles.rowLabel]}>{en.txRefLabel}</Text>
              <Text style={styles.reference} testID="tx-reference">
                {receipt.reference}
              </Text>
            </View>
          </View>

          <Text style={[text('bodyS'), styles.help]}>{en.txHelp}</Text>

          <SecondaryButton
            label={en.txReport}
            testID="tx-report"
            style={styles.report}
            onPress={() => {
              // Hands the reference over; the form is the next slice.
              startPaymentReport(receipt.reference);
              onClose();
            }}
          />
          <SecondaryButton
            label={en.txClose}
            testID="tx-close"
            style={styles.close}
            onPress={onClose}
          />
        </ScrollView>
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  head: { alignItems: 'center', gap: 6, paddingTop: 2 },
  amount: { fontFamily: 'Fraunces_600SemiBold', fontWeight: '600', fontSize: 30 },
  title: { color: color.ink },
  subtitle: { color: color.textMuted },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 6,
    paddingVertical: 5,
    paddingHorizontal: 12,
    borderRadius: radius.pill,
  },
  pillGood: { backgroundColor: color.brandTint },
  pillWarn: { backgroundColor: color.warnBg },
  pillBad: { backgroundColor: color.dangerBg },
  pillDot: { width: 6, height: 6, borderRadius: radius.pill },
  pillDotGood: { backgroundColor: color.brand },
  pillDotWarn: { backgroundColor: color.warnText },
  pillDotBad: { backgroundColor: color.dangerDot },
  pillText: { fontWeight: '600' },
  pillTextGood: { color: color.brandDeep },
  pillTextWarn: { color: color.warnText },
  pillTextBad: { color: color.dangerText },

  rowsCard: {
    marginTop: 20,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.hairline,
    borderRadius: radius.cardLg,
    paddingHorizontal: 18,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
    paddingVertical: 13,
    borderBottomWidth: 1,
    borderBottomColor: color.hairlineInner,
  },
  rowLast: { borderBottomWidth: 0 },
  rowLabel: { color: color.textMutedLabel },
  rowValue: {
    fontSize: 13.5,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
    color: color.ink,
    textAlign: 'right',
  },
  rowValueMoney: {
    fontFamily: 'Fraunces_600SemiBold',
    fontWeight: '600',
    fontSize: 15,
    color: color.ink,
    textAlign: 'right',
  },
  reference: {
    fontFamily: 'Fraunces_500Medium',
    fontSize: 13,
    letterSpacing: 0.4,
    color: color.textMutedStrong,
  },

  help: { color: color.textMutedSoft, marginTop: 12, marginHorizontal: 4, lineHeight: 18 },
  report: { marginTop: 12, backgroundColor: color.surface },
  close: { marginTop: 12, borderColor: 'transparent', backgroundColor: color.surfaceAlt2 },
});
