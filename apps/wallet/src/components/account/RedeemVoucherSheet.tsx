/**
 * Wallet · Account → "Redeem a voucher code".
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE DESIGN DRAWS NONE OF THIS, AND THAT IS RECORDED RATHER THAN HIDDEN.
 * ═════════════════════════════════════════════════════════════════════════════
 * Lane C grepped `coupon|voucher|compensat|gift card` across the whole bundle
 * and found nothing — console, dashboard or wallet. A second grep for
 * `promo|redeem|discount|enter code` finds one hit in the entire bundle, in
 * `api-contract.md`, and it is not this. So the layout below is composed out of
 * furniture the design DID settle — `Sheet`, `FieldLabel`/`Field`/`InlineError`
 * from the three account sheets, `PrimaryButton` — and invents no new treatment.
 * Every string it renders is an AR GAP; see `copy/ar.ts`.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * SHE REDEEMS. IT DOES NOT ARRIVE. THE API SETTLES THIS, TWICE OVER.
 * ═════════════════════════════════════════════════════════════════════════════
 * FIRST, mechanically: money moves only inside `POST /members/me/vouchers/redeem`,
 * which is `requireMember` and takes a code in the body. There is no push, no
 * notification hook, and no `GET /members/me/vouchers` for a screen to poll — the
 * three list/issue/void routes are `requirePlatform(req, 'accounts')` and a
 * member token cannot reach them. A wallet that wanted credit to "just appear"
 * has no endpoint to make it appear from.
 *
 * SECOND, and this is the stronger half: THE PRODUCT ALREADY HAS THE ARRIVING
 * FORM AND BUILT THIS TO BE THE OTHER ONE. `POST /members/{id}/adjustments` is a
 * complete compensation path — same gate, same money, a required reason — and it
 * pushes credit straight into her balance with nothing for her to do.
 * `routes/vouchers.ts` opens by saying so: "The new thing is the OBJECT — a code
 * the customer redeems when she chooses, rather than a credit an admin pushes
 * into her wallet."
 *
 * So building "it arrives" in the wallet would not be a second reading of the
 * feature. It would be a reimplementation of adjustments, and it would leave the
 * four voucher endpoints exactly as unused as this slice found them. The reading
 * loses on its own merits too: an apology that lands silently as a number is not
 * an apology, and the act of redeeming is the only moment in the flow where AVO
 * gets to say why.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE FOUR STATES (design/AVO States.dc.html, interaction-spec.md §4)
 * ═════════════════════════════════════════════════════════════════════════════
 * This surface performs no read, so its four states are not a screen's four —
 * they are a write's, and the mapping is stated rather than assumed:
 *
 *   empty     the sheet as it opens. `vchSub` names what a voucher IS, because
 *             the design drew no surface she could have learned it from. Redeem
 *             is disabled until the field has content (`canSubmitCode`).
 *   loading   `busy`: the button reads "Redeeming…" and is disabled, and the
 *             field is locked. One in-flight attempt, one idempotency key.
 *   error     three treatments, not one — see `domain/voucher.ts`. A refusal
 *             gets NO retry, because 409 `voucher_not_redeemable` is a "you
 *             can't"; offline and server failures keep the key and retry.
 *   offline   its own message, and the load-bearing clause is "Nothing has been
 *             used". She is holding a code she may believe she has just spent.
 *
 * The SECTION on the Account screen has no fifth state of its own and needs
 * none: it reads nothing, so it renders offline exactly as it renders online.
 * That is why it sits outside the `support`-conditional Help block.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * NON-NEGOTIABLE #2 — THE SUCCESS SCREEN SHOWS THE SERVER'S TWO NUMBERS.
 * ═════════════════════════════════════════════════════════════════════════════
 * `creditedFils` and `balanceAfterFils` both come off the redeem response, which
 * the API computes inside the same transaction as the credit and the ledger pair.
 * Nothing here adds one to the other, and nothing adds either to the balance the
 * screen behind is holding. `onRedeemed` then re-reads the member so the Account
 * screen agrees with the server rather than with this sheet.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * NON-NEGOTIABLE #1 — `formatMoney`/`moneyAriaLabel` FROM @avo/types, BOTH.
 * ═════════════════════════════════════════════════════════════════════════════
 * Not `/1000` and not `.toFixed(3)`. And the label is asserted alongside the
 * visible string in the spec, because a hand-rolled figure that happens to read
 * correctly still announces "five" instead of "five Kuwaiti dinars" to a screen
 * reader — which is the half a screenshot review cannot see.
 */

import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { fils, formatMoney, moneyAriaLabel } from '@avo/types';
import { color, radius, text } from '../../theme';
import { useLanguage } from '../../i18n/language';
import { ApiError } from '../../api/client';
import { newIdempotencyKey, redeemVoucher, type VoucherRedemption } from '../../api/vouchers';
import {
  CODE_MAX_LENGTH,
  canRetryRedeem,
  canSubmitCode,
  classifyRedeemFailure,
  redeemFailureMessage,
  type RedeemFailure,
} from '../../domain/voucher';
import { Sheet } from '../Sheet';
import { PrimaryButton } from '../Buttons';
import { Field, FieldLabel, InlineError } from './Fields';

interface Props {
  open: boolean;
  onClose: () => void;
  /**
   * Re-read the member. NOT "apply this balance": the sheet holds the server's
   * `balanceAfterFils` for its own confirmation line, and the screen behind it
   * has to hear the number from the server too (#2). Called after the credit has
   * committed, never optimistically.
   */
  onRedeemed: () => void;
}

export function RedeemVoucherSheet({ open, onClose, onRedeemed }: Props) {
  const { lang, copy } = useLanguage();

  const [code, setCode] = useState('');
  const [failure, setFailure] = useState<RedeemFailure | null>(null);
  const [emptyError, setEmptyError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<VoucherRedemption | null>(null);
  /**
   * ONE KEY PER ATTEMPT, HELD ACROSS RETRIES — non-negotiable #4, and the
   * lifetime is the whole of it.
   *
   * A redeem that timed out may well have committed. Retrying with a FRESH key
   * would present a code the server has already marked `redeemed_at`, and the
   * atomic claim would refuse it: she would be told a voucher that worked did
   * not, and the credit would be sitting in her balance unexplained. Holding the
   * key means the retry hits `awaitCommittedKey` and replays the winner's
   * response verbatim.
   *
   * Driven against avo_lane_b: the same key twice returned byte-identical 200s,
   * `balanceAfterFils: 29500` both times, and the balance moved once.
   *
   * It is minted per ATTEMPT and not per sheet, so editing the code after a
   * refusal starts a genuinely new request — `hashRequestBody({ code })` is part
   * of the stored key, and a different body on the same key is a 422 rather than
   * a replay.
   */
  const [attemptKey, setAttemptKey] = useState<string | null>(null);

  const reset = () => {
    setCode('');
    setFailure(null);
    setEmptyError(false);
    setBusy(false);
    setDone(null);
    setAttemptKey(null);
  };

  // Clearing on every open, the pattern `ChangePasswordSheet` establishes. A code
  // is not a password, but a spent one left in the field invites a second tap
  // that can only ever be refused.
  const [openedWith, setOpenedWith] = useState(open);
  if (open !== openedWith) {
    setOpenedWith(open);
    reset();
  }

  const close = () => {
    reset();
    onClose();
  };

  const submit = async () => {
    if (!canSubmitCode(code)) {
      setFailure(null);
      setEmptyError(true);
      return;
    }
    /*
      A retry reuses the key; a first attempt mints one. `??=` in one expression
      would read the state it is about to set, so it is written out.
    */
    const key = attemptKey ?? newIdempotencyKey();
    setAttemptKey(key);
    setBusy(true);
    setFailure(null);
    setEmptyError(false);
    try {
      /*
        Awaited before anything is shown. The confirmation names a balance, and a
        balance announced before the transaction committed is a lie for however
        long the request takes — the rule `ChangePasswordSheet` states for its
        security promise, and money is at least as unforgiving.

        The code is sent AS TYPED. `normaliseCode` upper-cases and strips spaces
        and dashes server-side; doing it here too would be the same rule in two
        places. Driven: "vmq5-cxmc-ggk3" redeemed VMQ5CXMCGGK3.
      */
      const result = await redeemVoucher(code, key);
      setDone(result);
      setBusy(false);
      /*
        AFTER the credit, never before. The screen behind re-reads `/members/me`
        rather than being handed this sheet's number — two surfaces asking the
        server the same question is cheaper than two surfaces disagreeing.
      */
      onRedeemed();
    } catch (err) {
      const classified = classifyRedeemFailure(err);
      setFailure(classified);
      setBusy(false);
      /*
        A REFUSAL BURNS THE KEY. The code is dead, so this attempt is over; the
        next tap is a different question and must not replay a stored 409.
        `rejected` likewise. Offline and server failures KEEP it, which is the
        whole point of holding one.
      */
      if (!canRetryRedeem(classified)) setAttemptKey(null);
      /*
        `err` is deliberately not rendered. On a refusal its message is the
        server's English and carries nothing the code does not — see
        `domain/voucher.ts` on why that is a #12 problem rather than a preference.
      */
      void (err instanceof ApiError);
    }
  };

  const message = emptyError
    ? copy.vchErrEmpty
    : failure !== null
      ? redeemFailureMessage(failure, copy)
      : null;

  return (
    <Sheet
      open={open}
      dismissible={!busy}
      onDismiss={close}
      label={copy.vchTitle}
      testID="voucher-sheet"
    >
      <ScrollView showsVerticalScrollIndicator={false}>
        {done === null ? (
          <>
            <Text style={[text('displayS', lang), styles.title]}>{copy.vchTitle}</Text>
            <Text style={[text('body', lang), styles.sub]}>{copy.vchSub}</Text>

            <FieldLabel>{copy.vchLabel}</FieldLabel>
            <Field
              value={code}
              onChangeText={(v) => {
                setCode(v);
                setFailure(null);
                setEmptyError(false);
                /*
                  A NEW CODE IS A NEW ATTEMPT. The stored key hashes the body, so
                  reusing it with different text is a 422 and not a replay —
                  api-contract.md's addendum, and `useTopUp` mints per attempt for
                  the same reason.
                */
                setAttemptKey(null);
              }}
              placeholder={copy.vchPlaceholder}
              /*
                LTR IN BOTH LANGUAGES. The alphabet is Latin — `mintCode` draws
                from A–Z minus I and O, and 2–9 — so an Arabic layout must not
                mirror the field the way it mirrors a name.
              */
              ltr
              maxLength={CODE_MAX_LENGTH}
              accessibilityLabel={copy.vchLabel}
              testID="voucher-code"
            />

            {message ? <InlineError message={message} testID="voucher-error" /> : null}

            <PrimaryButton
              label={busy ? copy.vchWorking : copy.vchSubmit}
              onPress={() => void submit()}
              /*
                Disabled while in flight AND while the field is empty. The first
                is the double-submit guard the idempotency key backs up rather
                than replaces; the second spares a round trip whose only possible
                answer is `invalid_code`.
              */
              disabled={busy || !canSubmitCode(code)}
              style={styles.primary}
              testID="voucher-submit"
            />
          </>
        ) : (
          <View testID="voucher-done">
            <Text style={[text('displayS', lang), styles.title]}>{copy.vchDoneTitle}</Text>
            {/*
              THE CREDIT, AS THE SERVER REPORTED IT. `fils()` re-brands the wire
              number and throws on a float, so a contract violation surfaces here
              rather than as a wrong figure on a customer's screen — the rule
              `domain/activity.ts` states for the feed, applied to the one number
              this sheet exists to show.

              `accessibilityLabel` is not decoration. Without it a reader says
              "five point zero zero zero"; interaction-spec.md §2 requires dinars.
            */}
            <Text
              style={[text('displayM', lang), styles.amount]}
              accessibilityLabel={moneyAriaLabel(fils(done.creditedFils), lang)}
              testID="voucher-credited"
            >
              {formatMoney(fils(done.creditedFils), lang)}
            </Text>
            <Text style={[text('body', lang), styles.sub]}>{copy.vchDoneBody}</Text>

            <View style={styles.balanceRow}>
              <Text style={[text('body', lang), styles.balanceLabel]}>{copy.vchDoneBalance}</Text>
              {/*
                THE SERVER'S BALANCE, NOT A SUM. `balanceAfterFils` is written
                inside the redeem transaction; adding `creditedFils` to whatever
                this device last saw would be the client deciding what she has,
                and would be wrong the moment a charge settled in between (#2).
              */}
              <Text
                style={[text('bodyL', lang), styles.balanceValue]}
                accessibilityLabel={moneyAriaLabel(fils(done.balanceAfterFils), lang)}
                testID="voucher-balance"
              >
                {formatMoney(fils(done.balanceAfterFils), lang)}
              </Text>
            </View>

            <PrimaryButton
              label={copy.vchDoneClose}
              onPress={close}
              style={styles.primary}
              testID="voucher-done-close"
            />
          </View>
        )}
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  title: { color: color.ink },
  sub: { color: color.textMutedLabel, marginTop: 6, lineHeight: 21 },
  amount: { color: color.ink, marginTop: 12 },
  balanceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: color.surfaceAlt2,
    borderRadius: radius.card,
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginTop: 18,
  },
  balanceLabel: { color: color.textMutedLabel },
  balanceValue: { color: color.ink, fontWeight: '600' },
  primary: { marginTop: 20 },
});
