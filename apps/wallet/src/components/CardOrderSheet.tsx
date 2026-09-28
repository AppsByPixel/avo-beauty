/**
 * The shop's card payment, from "opening KNET" to what happened — client ask W2.
 *
 * Every screen here is rendered from `GET /orders/payments/{id}` (via
 * `useCardCheckout`) and nothing else. Four rules live in this file:
 *
 *   · the redirect stage has no dismissal of any kind — she is at her bank;
 *   · THE RACE SCREEN SAYS WHERE HER MONEY IS FIRST, then why the order did not
 *     go through, from `order.refusal.code` through the copy module — never the
 *     server's English `message`. Getting this wrong tells a customer she lost
 *     money she did not lose, or that she has an order she does not have;
 *   · only a decline or a cancel offers "Try again" — pending never does, and
 *     its one action re-reads the SAME payment;
 *   · no fee row. The customer projection carries none and the merchant bears
 *     it today.
 *
 * `placed` has no screen here: the sheet closes and the shop opens the same
 * invoice a wallet-paid order opens, built from the server's `OrderResult`.
 */

import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { fils, formatMoney, moneyAriaLabel } from '@avo/types';
import { useLanguage } from '../i18n/language';
import { alignEnd } from '../i18n/rtl';
import { BRAND_BORDER, color, radius, text } from '../theme';
import { refusalReason } from '../domain/cardCheckout';
import type { CardCheckoutController, CardStage } from '../state/useCardCheckout';
import { Sheet } from './Sheet';
import { PrimaryButton, SecondaryButton } from './Buttons';

export function CardOrderSheet({ card }: { card: CardCheckoutController }) {
  const { copy } = useLanguage();
  const { stage } = card;
  return (
    <Sheet
      open={stage.name !== 'closed'}
      dismissible={stage.name !== 'redirect'}
      onDismiss={card.close}
      label={copy.methodLabel}
      testID="card-sheet"
    >
      <ScrollView showsVerticalScrollIndicator={false}>
        <Body stage={stage} card={card} />
      </ScrollView>
    </Sheet>
  );
}

function Body({ stage, card }: { stage: CardStage; card: CardCheckoutController }) {
  const { lang, copy } = useLanguage();

  switch (stage.name) {
    case 'closed':
      return null;

    case 'starting':
    case 'checking':
    case 'redirect': {
      const method =
        stage.name === 'starting'
          ? stage.method
          : stage.name === 'redirect'
            ? stage.view.intent.method
            : null;
      return (
        <View style={styles.centred} testID={`card-${stage.name}`}>
          <Text style={[text('displayS', lang), styles.title]}>
            {method ? copy.payRedirectTitle(copy.payMethod[method]) : copy.pendingTitle}
          </Text>
          {stage.name === 'redirect' ? (
            <>
              <Text style={[text('body', lang), styles.body]}>{copy.payRedirectSub}</Text>
              <View style={styles.hold}>
                <View style={styles.holdDot} />
                <Text style={[text('bodyS', lang), styles.holdText]}>{copy.payDontClose}</Text>
              </View>
            </>
          ) : null}
          <View style={styles.dots}>
            <View style={styles.dot} />
            <View style={styles.dot} />
            <View style={styles.dot} />
          </View>
        </View>
      );
    }

    case 'startFailed':
      return (
        <Outcome
          testID="card-start-failed"
          title={copy.cardOrderStartFailedTitle}
          body={copy.cardOrderStartFailedBody}
          reference={stage.failure.reference}
        >
          <PrimaryButton label={copy.tryAgain} onPress={card.retryStart} testID="card-retry-start" />
          <SecondaryButton label={copy.txClose} onPress={card.close} testID="card-close" />
        </Outcome>
      );

    case 'attemptOpen':
      return (
        <Outcome testID="card-attempt-open" title={copy.cardOrderCheck} body={copy.cardOrderAttemptOpen}>
          <PrimaryButton label={copy.cardOrderCheck} onPress={card.check} testID="card-check" />
          <SecondaryButton label={copy.txClose} onPress={card.close} testID="card-close" />
        </Outcome>
      );

    case 'gatewayFailed':
      return (
        <Outcome
          testID="card-gateway-failed"
          title={copy.cardOrderGatewayFailedTitle}
          body={copy.cardOrderGatewayFailedBody}
          rows={[
            [copy.rAmount, money(stage.view.intent.amountFils, lang)],
            [copy.rCharged, { text: copy.vNothing }],
          ]}
        >
          <PrimaryButton label={copy.cardOrderOpenPage} onPress={card.retryOpen} testID="card-retry-open" />
          <SecondaryButton label={copy.txClose} onPress={card.close} testID="card-close" />
        </Outcome>
      );

    case 'result': {
      const { intent, order } = stage.view;
      if (stage.outcome === 'refused') {
        /*
          THE RACE. Paid, credited, refused. Title first: where the money is.
          `creditFils` is what landed — the payment plus any bonus, exactly what
          her balance rose by (driven: 25.350 → 38.550 on a 12.000 card payment
          with a 1.200 Silver bonus). The reason comes from the CODE.
        */
        return (
          <Outcome
            testID="card-refused"
            title={copy.cardOrderRefusedTitle}
            body={copy.cardOrderRefusedBody(formatMoney(fils(intent.creditFils), lang))}
            reason={copy.cardOrderRefusal[refusalReason(order.refusal?.code)]}
            rows={[
              [copy.rAmount, money(intent.amountFils, lang)],
              [copy.rMethod, { text: copy.payMethod[intent.method] }],
              [copy.cardOrderInWallet, money(intent.creditFils, lang)],
              [copy.rRef, { text: intent.reference }],
            ]}
          >
            <PrimaryButton label={copy.cardOrderBackToCart} onPress={card.close} testID="card-back" />
          </Outcome>
        );
      }
      if (stage.outcome === 'pending') {
        return (
          <Outcome
            testID="card-pending"
            title={copy.pendingTitle}
            body={copy.cardOrderPending}
            rows={[
              [copy.rAmount, money(intent.amountFils, lang)],
              [copy.rStatus, { text: copy.vPending }],
              [copy.rRef, { text: intent.reference }],
            ]}
          >
            {/* NO "Try again" — a retry on a payment that may land is a second charge. */}
            <PrimaryButton label={copy.cardOrderCheck} onPress={card.check} testID="card-check" />
            <SecondaryButton label={copy.txClose} onPress={card.close} testID="card-close" />
          </Outcome>
        );
      }
      const declined = stage.outcome === 'declined';
      return (
        <Outcome
          testID={declined ? 'card-declined' : 'card-cancelled'}
          title={declined ? copy.failTitle : copy.cancelTitle}
          body={declined ? copy.cardOrderDeclined : copy.cardOrderCancelled}
          rows={[
            [copy.rAmount, money(intent.amountFils, lang)],
            [copy.rCharged, { text: copy.vNothing }],
            [copy.rRef, { text: intent.reference }],
          ]}
        >
          <PrimaryButton label={copy.tryAgain} onPress={card.tryAgain} testID="card-try-again" />
          <SecondaryButton label={copy.otherMethod} onPress={card.close} testID="card-close" />
        </Outcome>
      );
    }
  }
}

type Value = { text: string; aria?: string };

function money(amountFils: number, lang: 'en' | 'ar'): Value {
  const f = fils(amountFils);
  return { text: formatMoney(f, lang), aria: moneyAriaLabel(f, lang) };
}

function Outcome({
  testID,
  title,
  body,
  reason,
  reference,
  rows = [],
  children,
}: {
  testID: string;
  title: string;
  body: string;
  reason?: string;
  reference?: string;
  rows?: Array<[string, Value]>;
  children: React.ReactNode;
}) {
  const { lang, copy } = useLanguage();
  return (
    <View style={styles.centred} testID={testID}>
      <Text style={[text('displayS', lang), styles.title]} testID={`${testID}-title`}>
        {title}
      </Text>
      <Text style={[text('body', lang), styles.body]} testID={`${testID}-body`}>
        {body}
      </Text>
      {reason ? (
        <View style={styles.reason} testID={`${testID}-reason`}>
          <View style={styles.holdDot} />
          <Text style={[text('bodyS', lang), styles.holdText]}>{reason}</Text>
        </View>
      ) : null}
      {rows.length > 0 ? (
        <View style={styles.rows}>
          {rows.map(([label, value], i) => (
            <View key={label} style={[styles.row, i === rows.length - 1 && styles.rowLast]}>
              <Text style={[text('bodyS', lang), styles.rowLabel]}>{label}</Text>
              <Text
                accessibilityLabel={value.aria ?? value.text}
                style={[text('bodyS', lang, '600'), styles.rowValue, { textAlign: alignEnd(lang) }]}
              >
                {value.text}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      {reference ? (
        <Text style={[text('bodyS', lang), styles.reference]}>
          {copy.referencePrefix}
          {reference}
        </Text>
      ) : null}
      <View style={styles.actions}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  centred: { alignItems: 'center', paddingTop: 18, paddingBottom: 6 },
  title: { color: color.ink, textAlign: 'center' },
  body: { color: color.textMuted, marginTop: 8, textAlign: 'center', maxWidth: 300, lineHeight: 20 },
  hold: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    alignSelf: 'stretch',
    marginTop: 22,
    padding: 13,
    borderRadius: radius.input,
    backgroundColor: color.brandTint2,
    borderWidth: 1,
    borderColor: BRAND_BORDER,
  },
  reason: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    alignSelf: 'stretch',
    marginTop: 16,
    padding: 13,
    borderRadius: radius.input,
    backgroundColor: color.brandTint2,
    borderWidth: 1,
    borderColor: BRAND_BORDER,
  },
  holdDot: { width: 7, height: 7, borderRadius: radius.pill, backgroundColor: color.brand },
  holdText: { color: color.brandDeeper, flex: 1, lineHeight: 18 },
  dots: { flexDirection: 'row', gap: 7, marginTop: 24 },
  dot: { width: 8, height: 8, borderRadius: radius.pill, backgroundColor: color.brand },
  rows: {
    alignSelf: 'stretch',
    marginTop: 18,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.hairline,
    borderRadius: radius.card,
    paddingHorizontal: 17,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: color.hairlineInner,
  },
  rowLast: { borderBottomWidth: 0 },
  rowLabel: { color: color.textMutedLabel },
  rowValue: { color: color.ink },
  reference: { color: color.textMutedLabel, marginTop: 10, letterSpacing: 0.3 },
  actions: { alignSelf: 'stretch', marginTop: 20, gap: 9 },
});
