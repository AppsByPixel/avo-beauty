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
 * the grace window is usable, and `DELETE /members/me/deletion` is the door.
 *
 * IT IS NO LONGER ONLY REACHABLE IN THE SECONDS AFTER REQUESTING. That was a real
 * gap and this header used to describe it as unfixable here: `Member` carried no
 * deletion state and there was no GET, so a customer who requested deletion and
 * reopened the app saw an ordinary Account screen. `GET /members/me/deletion`
 * exists now, Account reads it on every mount, and a pending request renders
 * `DeletionScheduled` with the erasure date and a route back into this sheet —
 * which is why this sheet takes a `pending` prop and can open straight into the
 * cancel state rather than asking a question she has already answered.
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
import { erasureDueOn } from '../../domain/deletion';

interface Props {
  open: boolean;
  balanceFils: number;
  /**
   * A deletion the SERVER already has, from `GET /members/me/deletion`.
   *
   * Non-null means she is mid-grace-window and opened this from the scheduled
   * card, so the sheet opens on the cancel door instead of asking a question she
   * answered days ago. Null is the ordinary path.
   */
  pending?: { graceDays: number; erasureDueAt: string | null } | null;
  onClose: () => void;
  /**
   * A request or a cancel landed, so whatever is showing the deletion state
   * outside this sheet is now stale. The Account screen re-reads.
   */
  onDeletionChanged?: () => void;
  /** The cancellation confirmation. The request itself confirms in-sheet. */
  onToast?: (message: string) => void;
}

export function DeleteAccountSheet({
  open,
  balanceFils,
  pending: alreadyPending = null,
  onClose,
  onDeletionChanged,
  onToast,
}: Props) {
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
      // The clock is running now, so the Account screen behind this sheet is
      // showing the wrong one of its three states until it re-reads.
      onDeletionChanged?.();
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
      onDeletionChanged?.();
      close();
    } catch (err) {
      // Nothing pending is not a failure — it is the outcome she asked for, and
      // the only way to reach it is if the request was already cancelled.
      if (isAlreadyCancelled(err)) {
        onToast?.(copy.deleteCancelled);
        // Still a change from this screen's point of view: it was showing a
        // pending state that is not pending, which is what the 404 proves.
        onDeletionChanged?.();
        close();
        return;
      }
      setBusy(false);
      setError(deletionSubmitFailure(err, copy.errorBody).message);
    }
  };

  const shownBalance = serverBalanceFils ?? balanceFils;
  /**
   * Either she just requested it, or the server already had one.
   *
   * `graceDays` state wins so the freshly-requested case still reads from the
   * response it just got; `alreadyPending` covers the cold start, which is what
   * makes this sheet reachable as a cancel door at all.
   */
  const effectiveGraceDays = graceDays ?? alreadyPending?.graceDays ?? null;
  const pending = effectiveGraceDays !== null;

  /**
   * "within 30 days" IS ONLY TRUE ON THE DAY SHE ASKS.
   *
   * `deletePendingBody(days)` is the confirmation for a request that just
   * landed, and it reads correctly there. Opened three weeks later from the
   * scheduled card it would say "removed within 30 days" all over again — the
   * window restated from a start date that is in the past, which overstates how
   * long she has and is exactly the kind of client-side arithmetic about a legal
   * clock that #2's habit is meant to keep out. So when the server already had
   * the request, the sentence names its `erasureDueAt` instead.
   */
  const bodyText = !pending
    ? copy.deleteBody
    : graceDays !== null
      ? copy.deletePendingBody(graceDays)
      : alreadyPending?.erasureDueAt
        ? copy.deleteScheduledBody(erasureDueOn(alreadyPending.erasureDueAt))
        : copy.deletePendingBody(effectiveGraceDays);

  return (
    <Sheet open={open} dismissible onDismiss={close} label={copy.deleteTitle} testID="delete-sheet">
      <ScrollView showsVerticalScrollIndicator={false}>
        <Text style={[text('displayS', lang), styles.title]}>
          {pending ? copy.deletePendingTitle : copy.deleteTitle}
        </Text>
        <Text style={[text('body', lang), styles.body]}>{bodyText}</Text>

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
              <Text style={[text('bodyL', lang, '600'), styles.keepText]}>{copy.cSentDone}</Text>
            </TappableRow>
            <TappableRow
              onPress={() => void cancel()}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={copy.deleteCancel}
              testID="delete-cancel"
              style={[styles.action, styles.confirm, busy && styles.actionBusy]}
            >
              <Text style={[text('bodyL', lang, '600'), styles.confirmText]}>{copy.deleteCancel}</Text>
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
                unitWeight="600"
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
                <Text style={[text('bodyL', lang, '600'), styles.keepText]}>{copy.deleteKeep}</Text>
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
                <Text style={[text('bodyL', lang, '600'), styles.confirmText]}>{copy.deleteGo}</Text>
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
  /**
   * THE WEIGHT MOVED TO `unitWeight="600"`, AND IT WAS THE ONLY ONE OF THE
   * THREE FACELESS UNITS THAT WAS ACTUALLY DRAWING ITS WEIGHT.
   *
   * That is worth recording, because it is the opposite of the inert-override
   * defect next door. This object named a weight and no family, so the node
   * fell back to the OS UI stack — a multi-weight font, which honoured 600
   * (measured: "KD" at 12px is 16.63px at 400 and 17.20px at 600 in that
   * stack). The weight was real; the FACE was wrong. Now `text('bodyS', lang,
   * '600')` resolves Inter_600SemiBold / IBMPlexSansArabic_600SemiBold, which
   * are single-weight faces — so the `fontWeight` had to leave this object
   * rather than stay beside the size, or it would become the inert kind.
   */
  balanceUnit: { fontSize: 12 },
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
  keepText: { color: color.ink },
  confirm: { backgroundColor: color.dangerText },
  confirmText: { color: WHITE },
  fine: {
    color: color.textMutedSoft,
    textAlign: 'center',
    marginTop: 12,
    lineHeight: 18,
  },
});
