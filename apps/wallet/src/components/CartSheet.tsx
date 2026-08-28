/**
 * The cart — design/AVO Wallet Home.dc.html:940-978.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT THIS SHEET MAY AND MAY NOT OFFER.
 *
 * NO UNDO, EVER. `OrderResult.voidable` is a `z.literal(false)` and that is a
 * statement rather than a default: `performVoid` refuses anything whose kind is
 * not `charge`, and the legal set says what happens instead — a damaged or wrong
 * item is replaced or returned as wallet credit, which is a merchant
 * reimbursement and not a reversal. So there is no cancel affordance here on the
 * strength of that field, and a server that ever sent `true` fails the parse
 * rather than quietly growing one.
 *
 * NO RETRY ON AN UNKNOWN OUTCOME. An order moves money with ONE concurrency guard
 * where a charge has two, so the rule the scanner's charge screen carries applies
 * with more force: a client that could not read the response does not know whether
 * the money moved. The shortfall and stale-product refusals ARE safe to act on —
 * both are refusals the server definitely made before debiting — and they keep
 * their buttons. `failed` and `offline` do not.
 *
 * THE SHORTFALL SHOWN IS THE SERVER'S. `useShop` replaces its own local figure
 * with the 402's `shortfallFils` the moment one arrives (#2 gives the server the
 * difference as well as the balance). The local one exists only to pick the CTA
 * before submission.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { fils, formatMoney, moneyAriaLabel, type Fils } from '@avo/types';
import { useLanguage } from '../i18n/language';
import { type PricedLine } from '../domain/cart';
import type { CheckoutRefusal } from '../state/useShop';
import { ProductImage } from './ProductImage';
import { Sheet } from './Sheet';
import { PrimaryButton } from './Buttons';
import { color, MIN_TAP_TARGET, radius, text } from '../theme';
import { focusable } from '../theme/focus';
import { alignEnd } from '../i18n/rtl';

interface Props {
  open: boolean;
  lines: PricedLine[];
  count: number;
  total: Fils;
  balanceFils: number;
  canAfford: boolean;
  /** Local before submission; the server's after a 402. */
  shortfall: Fils;
  stale: string[];
  busy: boolean;
  refusal: CheckoutRefusal | null;
  onClose: () => void;
  onAdd: (productId: string) => void;
  onRemove: (productId: string) => void;
  onCheckout: () => void;
  onTopUp: () => void;
}

export function CartSheet({
  open,
  lines,
  count,
  total,
  balanceFils,
  canAfford,
  shortfall,
  stale,
  busy,
  refusal,
  onClose,
  onAdd,
  onRemove,
  onCheckout,
  onTopUp,
}: Props) {
  const { lang, copy } = useLanguage();
  const empty = lines.length === 0;

  /*
    A stale product blocks checkout, and it is detected from the CATALOGUE rather
    than only from the refusal — she is holding something that has gone, and being
    told before she taps Pay is the difference between an explanation and a
    failure. The server's `invalid_products` is still handled below, because the
    catalogue this compares against can itself be stale.
  */
  const staleFromServer = refusal?.kind === 'stale' ? refusal.ids : [];
  const staleIdList = stale.length > 0 ? stale : staleFromServer;
  const blocked = staleIdList.length > 0;

  // The shortfall the server named, over the one computed locally.
  const shownShortfall = refusal?.kind === 'short' ? refusal.shortfallFils : shortfall;

  return (
    <Sheet open={open} dismissible onDismiss={onClose} label={copy.cartTitle} testID="cart-sheet">
      {/* design:945 — the title and the count, on one row. */}
      <View style={styles.head}>
        <Text style={[text('displayS', lang), styles.title]}>{copy.cartTitle}</Text>
        <Text style={[text('bodyS', lang), styles.count]}>{copy.cartItems(count)}</Text>
      </View>

      {empty ? (
        /* design:972 — the empty CART, which is not the empty catalogue. */
        <View style={styles.empty} testID="cart-empty">
          <Text style={[text('displayS', lang), styles.emptyTitle]}>{copy.cartEmptyTitle}</Text>
          <Text style={[text('bodyS', lang), styles.emptyBody]}>{copy.cartEmptyBody}</Text>
        </View>
      ) : (
        <>
          <ScrollView style={styles.lines} showsVerticalScrollIndicator={false}>
            {lines.map((line) => (
              <View key={line.product.id} style={styles.line} testID={`cart-line-${line.product.id}`}>
                {/*
                  The same square as the Shop row, 42 instead of 52. She saw a
                  photograph a tap ago; a cart that dropped back to a letter would
                  read as a different product. `ProductImage` § THE SWATCH IS THE
                  FLOOR — the states are identical here because the component is.
                */}
                <ProductImage
                  productId={line.product.id}
                  name={line.product.name}
                  image={line.product.image}
                  size={42}
                  radius={12}
                  letterSize={16}
                  testID={`cart-swatch-${line.product.id}`}
                />
                <View style={styles.lineText}>
                  <Text style={[text('bodyL', lang), styles.lineName]} numberOfLines={1}>
                    {line.product.name}
                  </Text>
                  {/*
                    MONEY IS WESTERN IN BOTH LANGUAGES (#12), and it goes through
                    `formatMoney` so the unit follows the language without a `KD`
                    literal existing in this app.
                  */}
                  <Text
                    style={[text('bodyS', lang), styles.lineTotal]}
                    accessibilityLabel={moneyAriaLabel(line.lineTotalFils, lang)}
                  >
                    {formatMoney(line.lineTotalFils, lang)}
                  </Text>
                </View>
                <Stepper
                  qty={line.qty}
                  lang={lang}
                  name={line.product.name}
                  onDec={() => onRemove(line.product.id)}
                  onInc={() => onAdd(line.product.id)}
                  testID={`cart-step-${line.product.id}`}
                />
              </View>
            ))}
          </ScrollView>

          {/* design:965-966 — the total, then where it is paid from. */}
          <View style={styles.totals}>
            <Row
              label={copy.cartTotal}
              value={formatMoney(total, lang)}
              aria={moneyAriaLabel(total, lang)}
              lang={lang}
              emphasis
            />
            <Row
              label={copy.cartPayFrom}
              value={formatMoney(balanceFilsAsFils(balanceFils), lang)}
              aria={moneyAriaLabel(balanceFilsAsFils(balanceFils), lang)}
              lang={lang}
              tone={canAfford ? 'ok' : 'bad'}
            />

            {/* design:968 — the shortfall chip. */}
            {!canAfford || refusal?.kind === 'short' ? (
              <Chip
                lang={lang}
                testID="cart-short"
                text={copy.cartShortBy(formatMoney(shownShortfall, lang))}
              />
            ) : null}

            {blocked ? (
              <Chip
                lang={lang}
                testID="cart-stale"
                text={copy.cartStaleBody(nameList(staleIdList, lines))}
              />
            ) : null}

            {/*
              The two refusals that must NOT offer a retry. `offline` and `failed`
              both mean the outcome is unknown; the sentence says so and the button
              below stays out of the way.
            */}
            {refusal?.kind === 'offline' ? (
              <Chip lang={lang} testID="cart-offline" text={copy.signUpOffline} />
            ) : null}
            {refusal?.kind === 'failed' ? (
              <Chip lang={lang} testID="cart-failed" text={copy.shopOrderFailed} />
            ) : null}

            {/*
              ONE BUTTON, THREE MEANINGS, and only two of them submit.

              Short → Top up, which is the one action that helps and is what the
              design does (:1460). Blocked by a stale product → no submit at all,
              because the server would refuse it and she has to remove it first.
              Otherwise → pay.
            */}
            {!canAfford ? (
              <PrimaryButton
                label={copy.cartTopUpCta}
                onPress={onTopUp}
                testID="cart-topup"
                style={styles.cta}
              />
            ) : (
              <PrimaryButton
                label={copy.cartPayCta(formatMoney(total, lang))}
                onPress={onCheckout}
                disabled={busy || blocked || refusal?.kind === 'offline' || refusal?.kind === 'failed'}
                testID="cart-pay"
                style={styles.cta}
              />
            )}
          </View>
        </>
      )}
    </Sheet>
  );
}

/* `balanceFils` arrives as a plain number from the member; re-brand at the edge. */
function balanceFilsAsFils(n: number): Fils {
  return fils(n);
}

/** The ids the catalogue lost, named if we still know the name. */
function nameList(ids: string[], lines: PricedLine[]): string {
  const byId = new Map(lines.map((l) => [l.product.id, l.product.name]));
  return ids.map((id) => byId.get(id) ?? id).join(', ');
}

function Row({
  label,
  value,
  aria,
  lang,
  emphasis,
  tone,
}: {
  label: string;
  value: string;
  aria: string;
  lang: 'en' | 'ar';
  emphasis?: boolean;
  tone?: 'ok' | 'bad';
}) {
  return (
    <View style={styles.row}>
      <Text style={[text('bodyS', lang), styles.rowLabel]}>{label}</Text>
      <Text
        accessibilityLabel={aria}
        style={[
          text(emphasis ? 'bodyL' : 'bodyS', lang),
          styles.rowValue,
          { textAlign: alignEnd(lang) },
          tone === 'bad' && styles.rowValueBad,
          tone === 'ok' && styles.rowValueOk,
        ]}
      >
        {value}
      </Text>
    </View>
  );
}

/** design:968 — the danger chip, the same shape sign-in and signup use. */
function Chip({
  text: body,
  lang,
  testID,
}: {
  text: string;
  lang: 'en' | 'ar';
  testID: string;
}) {
  return (
    <View style={styles.chip} accessibilityRole="alert" accessibilityLiveRegion="polite" testID={testID}>
      <View style={styles.chipDot} />
      <Text style={[text('bodyS', lang), styles.chipText]}>{body}</Text>
    </View>
  );
}

/**
 * design:958-962 — − qty +.
 *
 * Both controls clear the 44pt minimum even though the design draws 30px boxes:
 * the token file's `minTapTarget` is a rule and a 30px tap target on a payment
 * screen is the kind of thing that gets mis-tapped into an extra bottle.
 */
function Stepper({
  qty,
  lang,
  name,
  onDec,
  onInc,
  testID,
}: {
  qty: number;
  lang: 'en' | 'ar';
  /**
   * THE PRODUCT, AND ITS ABSENCE WAS A DEFECT FOUND BY DRIVING. These announced
   * "Your cart −" and "Your cart +", so a cart with two lines gave a screen reader
   * four identically-named buttons and no way to tell which row it was changing.
   * The Shop list had it right — "Argan hair oil 100ml −" — and this did not.
   */
  name: string;
  onDec: () => void;
  onInc: () => void;
  testID: string;
}) {
  const { copy } = useLanguage();
  return (
    <View style={styles.stepper}>
      <Pressable
        onPress={onDec}
        accessibilityRole="button"
        accessibilityLabel={`${name} −`}
        dataSet={focusable}
        testID={`${testID}-dec`}
        style={[styles.stepBtn, styles.stepBtnGhost]}
      >
        {/* U+2212 MINUS, the character the design sets. */}
        <Text style={[text('bodyL', lang), styles.stepGhostText]}>−</Text>
      </Pressable>
      {/* A COUNT, so Eastern in Arabic — and the copy layer decides that, not this. */}
      <Text style={[text('bodyL', lang), styles.stepQty]} testID={`${testID}-qty`}>
        {copy.qtyValue(qty)}
      </Text>
      <Pressable
        onPress={onInc}
        accessibilityRole="button"
        accessibilityLabel={`${name} +`}
        dataSet={focusable}
        testID={`${testID}-inc`}
        style={[styles.stepBtn, styles.stepBtnSolid]}
      >
        <Text style={[text('bodyL', lang), styles.stepSolidText]}>+</Text>
      </Pressable>
    </View>
  );
}


const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: color.ink },
  count: { color: color.textMuted },
  lines: { marginTop: 14, maxHeight: 320 },
  // design:952 — a hairline under each line, gap 13.
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
    paddingVertical: 11,
    borderBottomWidth: 1,
    borderBottomColor: color.hairline,
  },
  lineText: { flex: 1, minWidth: 0 },
  lineName: { color: color.ink, fontWeight: '600' },
  lineTotal: { color: color.textMuted, marginTop: 1 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  stepBtn: {
    minWidth: MIN_TAP_TARGET,
    minHeight: MIN_TAP_TARGET,
    borderRadius: radius.chip,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepBtnGhost: { borderWidth: 1, borderColor: color.borderControl, backgroundColor: color.white },
  // #9: a filled control is brandDeep, because its glyph is white.
  stepBtnSolid: { backgroundColor: color.brandDeep },
  stepGhostText: { color: color.ink },
  stepSolidText: { color: color.white },
  stepQty: { minWidth: 16, textAlign: 'center', color: color.ink, fontWeight: '600' },
  totals: { marginTop: 14 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 3 },
  rowLabel: { color: color.textMuted },
  rowValue: { color: color.ink, fontWeight: '600' },
  rowValueOk: { color: color.brandDeep },
  rowValueBad: { color: color.dangerText },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    backgroundColor: color.dangerBg,
    borderRadius: radius.chip,
    paddingVertical: 11,
    paddingHorizontal: 14,
    marginTop: 12,
  },
  chipDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: color.dangerDot, flexShrink: 0 },
  chipText: { color: color.dangerText, flex: 1 },
  cta: { marginTop: 14 },
  empty: { alignItems: 'center', paddingTop: 40, paddingBottom: 30, paddingHorizontal: 10 },
  emptyTitle: { color: color.textMuted },
  emptyBody: { color: color.textMutedSoft, marginTop: 6 },
});
