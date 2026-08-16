/**
 * The void confirmation sheet — design:305-322.
 *
 * A void moves money back into a wallet, so it carries the same guarantees as a
 * charge: an idempotency key (#4 — a retried void with no key is a double
 * refund) and a reason, which the API requires and writes into the audit log.
 *
 * Refunds are wallet credit. Non-negotiable #5, and the copy says so plainly:
 * "The full amount goes straight back to her wallet".
 *
 * Focus is trapped and Esc closes, per interaction-spec.md §2 — on a phone that
 * reduces to the modal's own dismissal and the back gesture, which
 * `onRequestClose` wires up.
 */

import { useCallback, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { ApiError, newIdempotencyKey } from '../api/client';
import { voidCharge } from '../api/charges';
import { copy } from '../copy/en';
import { color, display, MIN_TAP_TARGET, radius, ui } from '../theme';
import { DangerFilledButton, SecondaryButton } from './Buttons';

type ReasonId = (typeof copy.voidReasons)[number]['id'];

export function VoidSheet({
  transactionId,
  accessToken,
  onClose,
  onVoided,
}: {
  transactionId: string;
  accessToken: string;
  onClose: () => void;
  onVoided: (refundedFils: number, reason: string) => void;
}) {
  const [reason, setReason] = useState<ReasonId>('wrong');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // One key per void attempt, stable across a retry of that attempt.
  const attemptKey = useRef(newIdempotencyKey());

  const confirm = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    const label = copy.voidReasons.find((r) => r.id === reason)?.label ?? reason;
    try {
      // The reason is sent as the written LABEL, not the id: it lands in the
      // audit log's `detail` and in the customer's notice, where "wrong" would
      // be meaningless (api/src/routes/charges.ts § performVoid).
      const result = await voidCharge(
        { transactionId, reason: label },
        attemptKey.current,
        accessToken,
      );
      onVoided(result.refundedFils, label);
    } catch (err) {
      if (err instanceof ApiError) {
        setFailure(
          err.code === 'void_window_closed' ? copy.voidWindowClosed : err.message,
        );
      } else {
        setFailure(copy.errorBody);
      }
      setBusy(false);
    }
  }, [busy, reason, transactionId, accessToken, onVoided]);

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      onRequestClose={onClose}
      accessibilityViewIsModal
    >
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close">
        {/* Stops a tap inside the sheet from dismissing it — design:307. */}
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.grabber} />
          <Text style={display(21)}>{copy.voidSheetTitle}</Text>
          <Text style={[ui(13), styles.body]}>{copy.voidSheetBody}</Text>

          <View style={styles.reasons}>
            {copy.voidReasons.map((r) => {
              const on = reason === r.id;
              return (
                <Pressable
                  key={r.id}
                  onPress={() => setReason(r.id)}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on }}
                  accessibilityLabel={r.label}
                  testID={`void-reason-${r.id}`}
                  style={[styles.reason, on ? styles.reasonOn : styles.reasonOff]}
                >
                  <View style={[styles.radio, on ? styles.radioOn : styles.radioOff]} />
                  <Text style={on ? ui(13.5, '600') : ui(13.5)}>{r.label}</Text>
                </Pressable>
              );
            })}
          </View>

          {failure && (
            <Text
              style={[ui(12.5), styles.failure]}
              accessibilityRole="alert"
              testID="void-failure"
            >
              {failure}
            </Text>
          )}

          <View style={styles.actions}>
            <SecondaryButton
              label={copy.voidKeep}
              onPress={onClose}
              style={styles.action}
              testID="void-keep"
            />
            <DangerFilledButton
              label={copy.voidConfirm}
              onPress={() => void confirm()}
              disabled={busy}
              style={styles.action}
              testID="void-confirm"
            />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(20,21,17,0.55)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: color.surface,
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    paddingTop: 14,
    paddingHorizontal: 22,
    paddingBottom: 30,
  },
  grabber: {
    width: 40,
    height: 5,
    borderRadius: 999,
    backgroundColor: 'rgba(28,27,25,0.15)',
    alignSelf: 'center',
    marginBottom: 16,
  },
  body: { color: color.textMuted, marginTop: 6, lineHeight: 19 },
  reasons: { gap: 9, marginTop: 18 },
  reason: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: MIN_TAP_TARGET,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: radius.chip,
    backgroundColor: color.white,
    borderWidth: 1.5,
  },
  reasonOn: { borderColor: color.brand },
  reasonOff: { borderColor: 'rgba(28,27,25,0.1)' },
  radio: { width: 16, height: 16, borderRadius: 8 },
  radioOn: { borderWidth: 5, borderColor: color.brand },
  radioOff: { borderWidth: 1.5, borderColor: 'rgba(28,27,25,0.25)' },
  failure: { color: color.dangerText, marginTop: 14, lineHeight: 18 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 20 },
  action: { flex: 1 },
});
