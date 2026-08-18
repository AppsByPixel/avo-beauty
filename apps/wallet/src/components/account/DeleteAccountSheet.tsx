/**
 * Request account deletion — an App Store requirement, not a nicety.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THIS SHEET NOW REACHES A SERVER, AND THAT CHANGED WHAT IT HAS TO SAY.
 *
 * The design's version calls no endpoint: both buttons run `closeDelete`
 * (design/AVO Wallet Home.dc.html:902-903), so the prototype has copy for the
 * question and for none of the answers. `POST /members/me/deletion` has three,
 * and collapsing them into one "try again" would make two of them useless:
 *
 *   201/200  the clock is running. `graceDays` comes back, so the confirmation
 *            states the SERVER's window rather than a 30 hard-coded next to a
 *            legal document that also says 30.
 *   401      the password did not match AND NOTHING HAPPENED. No clock started.
 *            She retypes. This must not read like an outage.
 *   409      she still holds credit. Refused, deliberately — see below.
 *
 * The two refusals show the SERVER's own message, following ChangePasswordSheet:
 * "That password does not match." tells her to retype; a generic failure tells
 * her to give up. Only the confirmed state needed new copy, and it is in
 * AR_GAPS with the other two.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * THE 409 IS THE NORMAL CASE, because a wallet with money in it is the normal
 * state of a wallet. Non-negotiable #5 makes every refund wallet credit, and the
 * terms make a closing salon settle the remainder with her — so erasing the
 * account that NAMES the money while the money is still owed is the one outcome
 * nobody can undo. The balance shown on the refusal is the server's
 * `details.balanceFils`, not the prop this sheet was opened with: non-negotiable
 * #2 says the server owns the balance, and the prop may be minutes stale from
 * the Account screen's last read. Telling her to spend 0.000 when she holds
 * 24.500 would send her to the salon for nothing.
 *
 * NON-NEGOTIABLE #6 — the password is `secure`, is never logged (the `catch`
 * below deliberately reads only `err.message`, `code` and `status`), is dropped
 * from state the moment the sheet closes, and is sent for exactly one request.
 *
 * THE CANCEL DOOR. The API does not revoke her sessions on request, precisely so
 * the grace window is usable, and `DELETE /members/me/deletion` is the door. It
 * is offered here the moment the request lands.
 *
 * WHAT IS STILL MISSING, AND IT IS NOT THIS FILE'S TO FIX: `Member` carries no
 * deletion state and there is no GET for it, so a customer who requests deletion
 * and reopens the app sees an Account screen with no sign that her account is
 * scheduled, and no way back to this cancel door. Reported to trunk — it needs
 * either `deletionRequestedAt`/`deletionDueAt` on the member payload or a GET,
 * and both are lane A's shape to decide.
 */

import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { fils } from '@avo/types';
import { color, radius, text, WHITE } from '../../theme';
import { useLanguage } from '../../i18n/language';
import { cancelAccountDeletion, requestAccountDeletion } from '../../api/account';
import { Sheet } from '../Sheet';
import { TappableRow } from '../Buttons';
import { Money } from '../Money';
import { Field, FieldLabel, InlineError } from './Fields';
import { deletionSubmitFailure, isAlreadyCancelled } from './deletionOutcome';

interface Props {
  open: boolean;
  balanceFils: number;
  onClose: () => void;
  /** The cancellation confirmation. The request itself confirms in-sheet. */
  onToast?: (message: string) => void;
}

export function DeleteAccountSheet({ open, balanceFils, onClose, onToast }: Props) {
  const { lang, copy } = useLanguage();

  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Non-null once the request has landed — carries the server's grace window. */
  const [graceDays, setGraceDays] = useState<number | null>(null);
  const [serverBalanceFils, setServerBalanceFils] = useState<number | null>(null);

  const reset = () => {
    setPassword('');
    setError(null);
    setBusy(false);
    setGraceDays(null);
    setServerBalanceFils(null);
  };

  // Same reasoning as ChangePasswordSheet: a password left in component state
  // survives the sheet closing, and the next person to pick up the phone would
  // find the field populated.
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
    if (!password) return setError(copy.pwErrCur);

    setBusy(true);
    setError(null);
    try {
      const state = await requestAccountDeletion(password);
      // The password has done its one job. Drop it before rendering anything.
      setPassword('');
      setGraceDays(state.graceDays);
      setBusy(false);
    } catch (err) {
      setPassword('');
      setBusy(false);
      // A 409 is the only branch that changes what is on screen besides the
      // message — it corrects the balance she is being told to spend.
      const outcome = deletionSubmitFailure(err, copy.errorBody);
      if (outcome.serverBalanceFils !== null) setServerBalanceFils(outcome.serverBalanceFils);
      setError(outcome.message);
    }
  };

  const cancel = async () => {
    setBusy(true);
    setError(null);
    try {
      await cancelAccountDeletion();
      onToast?.(copy.deleteCancelled);
      close();
    } catch (err) {
      // Nothing pending is not a failure — it is the outcome she asked for, and
      // the only way to reach it is if the request was already cancelled.
      if (isAlreadyCancelled(err)) {
        onToast?.(copy.deleteCancelled);
        close();
        return;
      }
      setBusy(false);
      setError(deletionSubmitFailure(err, copy.errorBody).message);
    }
  };

  const shownBalance = serverBalanceFils ?? balanceFils;
  const pending = graceDays !== null;

  return (
    <Sheet open={open} dismissible onDismiss={close} label={copy.deleteTitle} testID="delete-sheet">
      <ScrollView showsVerticalScrollIndicator={false}>
        <Text style={[text('displayS', lang), styles.title]}>
          {pending ? copy.deletePendingTitle : copy.deleteTitle}
        </Text>
        <Text style={[text('body', lang), styles.body]}>
          {pending ? copy.deletePendingBody(graceDays) : copy.deleteBody}
        </Text>

        {pending ? (
          // No balance card: the server refuses a non-zero balance, so by
          // definition there is nothing left to warn her about.
          <View style={styles.actions}>
            <TappableRow
              onPress={close}
              accessibilityRole="button"
              accessibilityLabel={copy.cSentDone}
              testID="delete-done"
              style={[styles.action, styles.keep]}
            >
              <Text style={[text('bodyL', lang), styles.keepText]}>{copy.cSentDone}</Text>
            </TappableRow>
            <TappableRow
              onPress={() => void cancel()}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={copy.deleteCancel}
              testID="delete-cancel"
              style={[styles.action, styles.confirm, busy && styles.actionBusy]}
            >
              <Text style={[text('bodyL', lang), styles.confirmText]}>{copy.deleteCancel}</Text>
            </TappableRow>
          </View>
        ) : (
          <>
            <View style={styles.balanceCard} testID="delete-balance">
              <Text style={[text('body', lang), styles.balanceLabel]}>{copy.deleteBalance}</Text>
              <Money
                amount={fils(shownBalance)}
                color={color.dangerText}
                figureStyle={styles.balanceFigure}
                unitStyle={styles.balanceUnit}
              />
            </View>

            {/*
              Her own password, which is what `pwCurLabel` says. Reused rather
              than adding a near-duplicate key: the design supplies no label for
              this field, and a reused string has real Arabic where a new one
              would be one more AR_GAP on the most legally loaded sheet here.
            */}
            <FieldLabel>{copy.pwCurLabel}</FieldLabel>
            <Field
              value={password}
              onChangeText={(v) => {
                setPassword(v);
                setError(null);
              }}
              placeholder="••••••••"
              secure
              autoComplete="current-password"
              ltr
              accessibilityLabel={copy.pwCurLabel}
              testID="delete-password"
            />

            {error ? <InlineError message={error} testID="delete-error" /> : null}

            <View style={styles.actions}>
              <TappableRow
                onPress={close}
                accessibilityRole="button"
                accessibilityLabel={copy.deleteKeep}
                testID="delete-keep"
                style={[styles.action, styles.keep]}
              >
                <Text style={[text('bodyL', lang), styles.keepText]}>{copy.deleteKeep}</Text>
              </TappableRow>
              <TappableRow
                onPress={() => void submit()}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel={copy.deleteGo}
                testID="delete-confirm"
                style={[styles.action, styles.confirm, busy && styles.actionBusy]}
              >
                {/*
                  White on `dangerText`, the design's own destructive fill
                  (design:903). Not on `brand` — #9 is about the brand ramp, and
                  this control is deliberately not brand-coloured.
                */}
                <Text style={[text('bodyL', lang), styles.confirmText]}>{copy.deleteGo}</Text>
              </TappableRow>
            </View>

            <Text style={[text('bodyS', lang), styles.fine]}>{copy.deleteFine}</Text>
          </>
        )}
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  title: { color: color.ink },
  body: { color: color.textMutedLabel, marginTop: 8, lineHeight: 21 },
  balanceCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    backgroundColor: color.dangerBg,
    borderRadius: radius.button,
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginTop: 16,
  },
  balanceLabel: { color: color.dangerText },
  balanceFigure: { fontSize: 17, fontWeight: '600' },
  balanceUnit: { fontSize: 12, fontWeight: '600' },
  actions: { flexDirection: 'row', gap: 10, marginTop: 20 },
  action: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 15,
    borderRadius: radius.button,
  },
  // In flight. Dimmed rather than swapped for a spinner: the label has to stay
  // readable, because on this sheet the label is the difference between
  // "Request deletion" and "Cancel deletion request".
  actionBusy: { opacity: 0.6 },
  keep: { backgroundColor: color.surfaceAlt2 },
  keepText: { color: color.ink, fontWeight: '600' },
  confirm: { backgroundColor: color.dangerText },
  confirmText: { color: WHITE, fontWeight: '600' },
  fine: {
    color: color.textMutedSoft,
    textAlign: 'center',
    marginTop: 12,
    lineHeight: 18,
  },
});
