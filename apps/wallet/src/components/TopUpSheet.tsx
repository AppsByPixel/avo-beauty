/**
 * The top-up sheet: choose → redirect → result.
 *
 * Three things in here are rules rather than layout, and each is commented at
 * the point it is enforced:
 *
 *   · the calculation card renders the intent's numbers and never its own
 *   · the redirect stage has no dismissal control of any kind
 *   · the four outcomes are four screens, and only two of them offer a retry
 *
 * `feeFils` is on every intent this file receives and is never read. See
 * domain/topup.ts for why.
 */

import { ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  fils,
  formatMoney,
  moneyAriaLabel,
  type Fils,
  type TierName,
  type TopUpIntent,
} from '@avo/types';
import { color, MIN_TAP_TARGET, onBrandFill, radius, text, WHITE } from '../theme';
import { useCopy, useLanguage } from '../i18n/language';
import type { Copy } from '../copy/types';
import { canRetry, PAYMENT_METHODS, type TopUpOutcome } from '../domain/topup';
import type { TopUpController, TopUpStage } from '../state/useTopUp';
import { Sheet } from './Sheet';
import { PrimaryButton, SecondaryButton, TappableRow } from './Buttons';

interface Props {
  stage: TopUpStage;
  controller: TopUpController;
  /**
   * The balance after a successful top-up, or null while the re-read is in
   * flight or has failed. Null renders a skeleton, never `0.000` —
   * interaction-spec.md §4. It is the *server's* number: non-negotiable #2
   * forbids adding creditFils to the old balance to produce it.
   */
  newBalanceFils: Fils | null;
  /**
   * The tier that funded the bonus, for the calculation card's middle row.
   * A `TierName` and not a label, because Arabic inflects it — copy/types.ts.
   */
  tier: TierName | null;
}

export function TopUpSheet({ stage, controller, newBalanceFils, tier }: Props) {
  const copy = useCopy();
  const open = stage.name !== 'closed';
  const dismissible = stage.name !== 'redirect';

  return (
    <Sheet
      open={open}
      dismissible={dismissible}
      onDismiss={controller.close}
      label={copy.payTitle}
      testID="topup-sheet"
    >
      {stage.name === 'redirect' ? (
        <RedirectStage intent={stage.intent} />
      ) : stage.name === 'result' ? (
        <ResultStage
          intent={stage.intent}
          outcome={stage.outcome}
          newBalanceFils={newBalanceFils}
          controller={controller}
        />
      ) : stage.name === 'quoteFailed' ? (
        <QuoteFailedStage controller={controller} />
      ) : stage.name === 'closed' ? null : (
        <ChooseStage stage={stage} controller={controller} tier={tier} />
      )}
    </Sheet>
  );
}

// ------------------------------------------------------------------ choose --

function ChooseStage({
  stage,
  controller,
  tier,
}: {
  stage: Extract<TopUpStage, { name: 'quoting' | 'ready' }>;
  controller: TopUpController;
  tier: TierName | null;
}) {
  const { lang, copy } = useLanguage();
  const intent = stage.name === 'ready' ? stage.intent : null;
  const method = stage.name === 'ready' ? stage.intent.method : stage.method;
  // The amounts arrive off the wire as plain numbers. `fils()` re-brands them and
  // throws on a float, so a contract violation surfaces here rather than as a
  // wrong figure on the card the customer reads before she pays.
  const quote = intent
    ? {
        pay: fils(intent.amountFils),
        bonus: fils(intent.bonusFils),
        credit: fils(intent.creditFils),
      }
    : null;

  return (
    <ScrollView showsVerticalScrollIndicator={false} testID="topup-choose">
      <Text style={[text('displayS', lang), styles.sheetTitle]}>{copy.payTitle}</Text>

      {/*
        THE CALCULATION CARD. Every figure below comes off the TopUpIntent the
        server just issued — `amountFils`, `bonusFils`, `creditFils`. Nothing is
        multiplied by a tier percentage here, and while the quote is in flight the
        rows are bars rather than zeroes.
      */}
      <View style={styles.calcCard} testID="topup-calc">
        <CalcRow label={copy.youPay} amount={quote ? quote.pay : null} testID="calc-pay" />
        {/*
          The row exists only when the server sent a bonus — in stamps mode
          `bonusFils` is 0 and there is nothing to show.

          The label falls back to the neutral wording when there is no tier to
          name. A stamps member has `tier: null`, and "` bonus`" with a hole in
          front of it is what a naive `${tier} bonus` produces. The amount is
          still whatever the intent said: if a bonus arrives that we cannot
          attribute, showing it unattributed is right, and inventing a tier name
          to fill the gap would be worse.
        */}
        {quote && quote.bonus > 0 ? (
          <CalcRow
            label={copy.bonusRow(tier)}
            amount={quote.bonus}
            signed
            tone="brand"
            testID="calc-bonus"
          />
        ) : null}
        <View style={styles.calcDivider} />
        <CalcRow
          label={copy.lands}
          amount={quote ? quote.credit : null}
          tone="brand"
          strong
          testID="calc-credit"
        />
      </View>

      <Text style={[text('label', lang), styles.methodLabel]}>{copy.methodLabel}</Text>
      <View style={styles.methodList}>
        {PAYMENT_METHODS.map((option) => {
          const on = option.id === method;
          return (
            <TappableRow
              key={option.id}
              onPress={() => controller.chooseMethod(option.id)}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              accessibilityLabel={copy.payMethod[option.id]}
              testID={`topup-method-${option.id}`}
              style={[styles.method, on && styles.methodOn]}
            >
              <View style={styles.methodTag}>
                <Text style={styles.methodTagText}>{option.tag}</Text>
              </View>
              <View style={styles.methodBody}>
                <View style={styles.methodNameRow}>
                  <Text style={[text('bodyL', lang), styles.methodName]}>
                    {copy.payMethod[option.id]}
                  </Text>
                  {option.mostUsed ? (
                    <View style={styles.notePill}>
                      <Text style={[text('bodyS', lang), styles.noteText]}>{copy.mostUsed}</Text>
                    </View>
                  ) : null}
                </View>
                {/*
                  No fee line. api-contract.md § Commission is merchant-visible and
                  customer-never; the prototype's "150 fils fee" / "2.5% + 50 fils"
                  are those rates and are deliberately not rendered.
                */}
              </View>
              <View style={[styles.radio, on && styles.radioOn]}>
                {on ? <View style={styles.radioDot} /> : null}
              </View>
            </TappableRow>
          );
        })}
      </View>

      <PrimaryButton
        label={quote ? `${copy.payBtn} ${formatMoney(quote.pay, lang)}` : copy.payBtn}
        accessibilityLabel={
          quote ? `${copy.payBtn} ${moneyAriaLabel(quote.pay, lang)}` : copy.payBtn
        }
        onPress={controller.pay}
        disabled={!quote}
        testID="topup-pay"
        style={styles.payButton}
      />
    </ScrollView>
  );
}

function CalcRow({
  label,
  amount,
  signed,
  tone,
  strong,
  testID,
}: {
  label: string;
  amount: Fils | null;
  signed?: boolean;
  tone?: 'brand';
  strong?: boolean;
  testID: string;
}) {
  const { lang, copy } = useLanguage();
  const tint = tone === 'brand' ? color.brandDeep : color.ink;
  return (
    <View style={styles.calcRow} testID={testID}>
      <Text
        style={[
          text('body', lang),
          { color: tone === 'brand' ? color.brandDeeper : color.textMuted },
        ]}
      >
        {label}
      </Text>
      {amount === null ? (
        // Never `0.000` before the number exists — interaction-spec.md §4.
        <View style={styles.moneySkeleton} testID={`${testID}-skeleton`} />
      ) : (
        <Text
          // "plus" is a word, so it is copy rather than an inline literal — the
          // exact shape of string that ships in English inside an Arabic build.
          accessibilityLabel={
            signed ? copy.plus(moneyAriaLabel(amount, lang)) : moneyAriaLabel(amount, lang)
          }
          style={[strong ? styles.calcValueStrong : styles.calcValue, { color: tint }]}
        >
          {signed ? '+' : ''}
          {formatMoney(amount, lang)}
        </Text>
      )}
    </View>
  );
}

// ---------------------------------------------------------------- redirect --

/**
 * At the bank.
 *
 * THERE IS NO CLOSE CONTROL IN THIS FUNCTION, and that is the requirement rather
 * than an oversight: interaction-spec.md §2 names the KNET redirect state as the
 * single exception to Esc-closes. `Sheet` blocks the backdrop, Esc, Android back
 * and the browser back gesture while `dismissible` is false; this component's
 * job is simply not to reintroduce an exit as a button.
 *
 * There is also no Cancel. Cancelling here would only close our screen — the
 * payment at the bank would carry on, and the customer would be looking at a
 * wallet that has forgotten about it.
 */
function RedirectStage({ intent }: { intent: TopUpIntent }) {
  const { lang, copy } = useLanguage();
  return (
    <View style={styles.centred} testID="topup-redirect">
      <View style={styles.methodMark}>
        <Text style={styles.methodMarkText}>
          {PAYMENT_METHODS.find((m) => m.id === intent.method)?.tag ?? ''}
        </Text>
      </View>
      <Text style={[text('displayS', lang), styles.resultTitle]}>
        {copy.payRedirectTitle(copy.payMethod[intent.method])}
      </Text>
      <Text
        style={[text('body', lang), styles.resultBody]}
        accessibilityLiveRegion="polite"
      >
        {copy.payRedirectSub}
      </Text>

      <View style={styles.dots}>
        <View style={styles.dot} />
        <View style={styles.dot} />
        <View style={styles.dot} />
      </View>

      <View style={styles.holdNote}>
        <View style={styles.holdDot} />
        <Text style={[text('bodyS', lang), styles.holdText]}>{copy.payDontClose}</Text>
      </View>
    </View>
  );
}

// ------------------------------------------------------------------ result --

/**
 * The four outcomes' words.
 *
 * A function of the copy set rather than a module constant: a constant is
 * evaluated once at import and would freeze whichever language happened to load
 * first, which is the classic way a language switch "mostly" works.
 */
function outcomeWords(copy: Copy): Record<TopUpOutcome, { title: string; message: string }> {
  return {
    success: { title: copy.doneTitle, message: copy.doneMsg },
    declined: { title: copy.failTitle, message: copy.failMsg },
    cancelled: { title: copy.cancelTitle, message: copy.cancelMsg },
    pending: { title: copy.pendingTitle, message: copy.pendingMsg },
  };
}

function ResultStage({
  intent,
  outcome,
  newBalanceFils,
  controller,
}: {
  intent: TopUpIntent;
  outcome: TopUpOutcome;
  newBalanceFils: Fils | null;
  controller: TopUpController;
}) {
  const { lang, copy } = useLanguage();
  const words = outcomeWords(copy)[outcome];
  const retryable = canRetry(outcome);
  // Re-branded off the wire; `fils()` throws on a float rather than rendering one.
  const paid = fils(intent.amountFils);
  const credited = fils(intent.creditFils);

  return (
    <ScrollView showsVerticalScrollIndicator={false} testID={`topup-result-${outcome}`}>
      <View style={styles.centred}>
        <View
          style={[
            styles.resultMark,
            outcome === 'success'
              ? styles.resultMarkGood
              : outcome === 'pending'
                ? styles.resultMarkWait
                : styles.resultMarkBad,
          ]}
        >
          <Text style={styles.resultGlyph}>
            {outcome === 'success' ? '✓' : outcome === 'pending' ? '◷' : '✕'}
          </Text>
        </View>

        <Text style={[text('displayM', lang), styles.resultTitle]} accessibilityRole="header">
          {words.title}
        </Text>
        <Text style={[text('body', lang), styles.resultBody]}>{words.message}</Text>

        <View style={styles.rowsCard}>
          {outcome === 'success' ? (
            <>
              {/* creditFils — what the server says landed, not amount + a local bonus. */}
              <ResultRow
                label={copy.rAmount}
                value={formatMoney(credited, lang)}
                valueLabel={moneyAriaLabel(credited, lang)}
                strong
              />
              <ResultRow label={copy.rMethod} value={copy.payMethod[intent.method]} />
              <ResultRow
                label={copy.rBalance}
                value={newBalanceFils === null ? null : formatMoney(newBalanceFils, lang)}
                {...(newBalanceFils === null
                  ? {}
                  : { valueLabel: moneyAriaLabel(newBalanceFils, lang) })}
                strong
                last
              />
            </>
          ) : outcome === 'pending' ? (
            <>
              <ResultRow
                label={copy.rAmount}
                value={formatMoney(paid, lang)}
                valueLabel={moneyAriaLabel(paid, lang)}
                strong
              />
              <ResultRow label={copy.rStatus} value={copy.vPending} tone="warn" />
              {/* Shown so support can trace a payment nobody can yet account for. */}
              <ResultRow label={copy.rRef} value={intent.reference} mono last />
            </>
          ) : (
            <>
              <ResultRow
                label={copy.rAmount}
                value={formatMoney(paid, lang)}
                valueLabel={moneyAriaLabel(paid, lang)}
                strong
              />
              <ResultRow label={copy.rMethod} value={copy.payMethod[intent.method]} />
              <ResultRow label={copy.rCharged} value={copy.vNothing} tone="good" />
              {/* api-contract.md § Transaction: the gateway ref, shown on failure. */}
              <ResultRow label={copy.rRef} value={intent.reference} mono last />
            </>
          )}
        </View>

        <View style={styles.resultActions}>
          {/*
            PENDING GETS ONE BUTTON AND IT IS NOT A RETRY.
            `canRetry('pending')` is false in domain/topup.ts. A retry here is how
            a customer pays twice for one top-up: the first payment may have
            succeeded and simply not been confirmed yet.
          */}
          <PrimaryButton
            label={
              outcome === 'success'
                ? copy.done
                : outcome === 'pending'
                  ? copy.backToWallet
                  : copy.tryAgain
            }
            onPress={retryable ? () => controller.tryAgain() : controller.close}
            testID={retryable ? 'topup-try-again' : 'topup-result-done'}
          />
          {retryable ? (
            <SecondaryButton
              label={copy.otherMethod}
              onPress={() => controller.tryAgain()}
              testID="topup-other-method"
            />
          ) : null}
        </View>
      </View>
    </ScrollView>
  );
}

function ResultRow({
  label,
  value,
  valueLabel,
  strong,
  mono,
  tone,
  last,
}: {
  label: string;
  value: string | null;
  valueLabel?: string;
  strong?: boolean;
  mono?: boolean;
  tone?: 'warn' | 'good';
  last?: boolean;
}) {
  const { lang } = useLanguage();
  const tint =
    tone === 'warn' ? color.warnText : tone === 'good' ? color.positive : color.ink;
  return (
    <View style={[styles.resultRow, last && styles.resultRowLast]}>
      <Text style={[text('body', lang), styles.resultRowLabel]}>{label}</Text>
      {value === null ? (
        <View style={styles.moneySkeleton} />
      ) : (
        <Text
          accessibilityLabel={valueLabel}
          style={[
            strong ? styles.calcValueStrong : styles.resultRowValue,
            // A text value (a method name, a status word) needs the Arabic face;
            // a money value and a reference stay in the Latin display face.
            !strong && !mono && lang === 'ar' && styles.resultRowValueAr,
            mono && styles.reference,
            { color: strong ? color.ink : tint },
          ]}
        >
          {value}
        </Text>
      )}
    </View>
  );
}

// ------------------------------------------------------------ quote failed --

/**
 * The POST that asks for an intent failed. No intent exists, so nothing has been
 * charged and nothing can be — this is a plain "we failed", and it retries with
 * the SAME idempotency key in case the request did reach the server.
 */
function QuoteFailedStage({ controller }: { controller: TopUpController }) {
  const { lang, copy } = useLanguage();
  return (
    <View style={styles.centred} testID="topup-quote-failed">
      <View style={[styles.resultMark, styles.resultMarkBad]}>
        <Text style={styles.resultGlyph}>✕</Text>
      </View>
      <Text style={[text('displayM', lang), styles.resultTitle]}>{copy.quoteFailedTitle}</Text>
      <Text style={[text('body', lang), styles.resultBody]}>{copy.quoteFailedBody}</Text>
      <View style={styles.resultActions}>
        <PrimaryButton
          label={copy.tryAgain}
          onPress={controller.retryQuote}
          testID="topup-retry-quote"
        />
        <SecondaryButton label={copy.txClose} onPress={controller.close} testID="topup-cancel" />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  sheetTitle: { color: color.ink },

  calcCard: {
    marginTop: 14,
    backgroundColor: color.brandTint2,
    borderWidth: 1,
    borderColor: 'rgba(110,127,108,0.22)',
    borderRadius: radius.card,
    paddingHorizontal: 17,
    paddingVertical: 9,
  },
  calcRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 8,
  },
  calcDivider: {
    borderTopWidth: 1,
    borderTopColor: 'rgba(110,127,108,0.3)',
    borderStyle: 'dashed',
    marginVertical: 2,
  },
  calcValue: { fontFamily: 'Fraunces_600SemiBold', fontWeight: '600', fontSize: 17 },
  calcValueStrong: { fontFamily: 'Fraunces_600SemiBold', fontWeight: '600', fontSize: 20 },
  moneySkeleton: {
    width: 86,
    height: 18,
    borderRadius: 6,
    backgroundColor: color.surfaceAlt2,
  },

  methodLabel: { color: color.textMutedLabel, marginTop: 20, marginBottom: 10, marginStart: 2 },
  methodList: { gap: 9 },
  method: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: MIN_TAP_TARGET,
    paddingVertical: 12,
    paddingHorizontal: 13,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: color.borderControl,
    backgroundColor: color.surface,
  },
  methodOn: { borderColor: color.brandDeep, backgroundColor: color.brandTint },
  methodTag: {
    width: 38,
    height: 26,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    // White on brandDeep — never on brand. Non-negotiable #9.
    backgroundColor: color.brandDeep,
  },
  methodTagText: { color: WHITE, fontSize: 10, fontWeight: '700', fontFamily: 'Inter_700Bold' },
  methodBody: { flex: 1 },
  methodNameRow: { flexDirection: 'row', alignItems: 'center', gap: 7, flexWrap: 'wrap' },
  methodName: { color: color.ink, fontWeight: '600' },
  notePill: {
    backgroundColor: color.brandTint,
    paddingVertical: 2,
    paddingHorizontal: 8,
    borderRadius: radius.pill,
  },
  noteText: { color: color.brandDeep, fontWeight: '600' },
  radio: {
    width: 20,
    height: 20,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: color.borderControl,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioOn: { borderColor: color.brandDeep, backgroundColor: color.brandDeep },
  radioDot: { width: 8, height: 8, borderRadius: radius.pill, backgroundColor: WHITE },

  payButton: { marginTop: 18 },

  centred: { alignItems: 'center', paddingTop: 22, paddingBottom: 6 },
  methodMark: {
    width: 64,
    height: 64,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.brandDeep,
  },
  methodMarkText: { color: WHITE, fontSize: 13, fontWeight: '700', fontFamily: 'Inter_700Bold' },
  dots: { flexDirection: 'row', gap: 7, marginTop: 26 },
  dot: { width: 8, height: 8, borderRadius: radius.pill, backgroundColor: color.brand },
  holdNote: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    alignSelf: 'stretch',
    marginTop: 28,
    padding: 13,
    borderRadius: radius.input,
    backgroundColor: color.brandTint2,
    borderWidth: 1,
    borderColor: 'rgba(110,127,108,0.22)',
  },
  holdDot: { width: 7, height: 7, borderRadius: radius.pill, backgroundColor: color.brand },
  holdText: { color: color.brandDeeper, flex: 1, lineHeight: 18 },

  resultMark: {
    width: 66,
    height: 66,
    borderRadius: 33,
    alignItems: 'center',
    justifyContent: 'center',
  },
  resultMarkGood: { backgroundColor: color.brandDeep },
  resultMarkWait: { backgroundColor: color.warnText },
  resultMarkBad: { backgroundColor: color.dangerDot },
  resultGlyph: { color: WHITE, fontSize: 28, lineHeight: 34 },
  resultTitle: { color: color.ink, marginTop: 19, textAlign: 'center' },
  resultBody: {
    color: color.textMuted,
    marginTop: 7,
    textAlign: 'center',
    maxWidth: 290,
    lineHeight: 20,
  },

  rowsCard: {
    alignSelf: 'stretch',
    marginTop: 22,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.hairline,
    borderRadius: radius.card,
    paddingHorizontal: 17,
  },
  resultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
    paddingVertical: 13,
    borderBottomWidth: 1,
    borderBottomColor: color.hairlineInner,
  },
  resultRowLast: { borderBottomWidth: 0 },
  resultRowLabel: { color: color.textMutedLabel },
  resultRowValue: { fontSize: 13, fontWeight: '600', fontFamily: 'Inter_600SemiBold' },
  resultRowValueAr: { fontFamily: 'IBMPlexSansArabic_600SemiBold' },
  reference: { fontFamily: 'Fraunces_500Medium', letterSpacing: 0.4 },

  resultActions: { alignSelf: 'stretch', marginTop: 20, gap: 9 },
});
