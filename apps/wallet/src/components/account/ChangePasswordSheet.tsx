/**
 * Change password.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE SUBTITLE IS A SECURITY PROMISE AND THE PROMISE IS KEPT.
 *
 * "You stay logged in on this phone. Other devices are signed out."
 * "ستبقين مسجّلة الدخول على هذا الهاتف، وتُسجَّل الأجهزة الأخرى خارجاً."
 *
 * `POST /members/me/password` revokes every other session for the member and
 * leaves the caller's alone (api/src/routes/auth.ts), and lane D's suite proves
 * it end to end: the caller stays 200, a second device's next request is 401 and
 * its refresh is 401 too. So the sentence is true — and the one thing this file
 * must never do is show the confirmation before the call has returned. The
 * promise is about a server-side effect; announcing it optimistically would make
 * it a lie for however long the request takes, which is exactly the window in
 * which a stolen session matters.
 *
 * Hence: `await changePassword(...)`, THEN close, THEN toast.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * NON-NEGOTIABLE #6 — "never shown in a UI", and nothing here logs one either.
 * The three fields are `secure` by default; the design's Show/Hide control
 * (design:867) flips all three together, because checking one you have typed
 * while the other two stay masked is not the thing anyone wants.
 *
 * All four validations are client-side COURTESIES. The server enforces the same
 * rules — minimum 6, `next !== current`, and `current` actually verified — and
 * a client that skipped them would be rejected, not obeyed.
 */

import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { color, radius, text } from '../../theme';
import { useLanguage } from '../../i18n/language';
import { changePassword } from '../../api/account';
import { ApiError } from '../../api/client';
import { Sheet } from '../Sheet';
import { PrimaryButton, TappableRow } from '../Buttons';
import { Field, FieldLabel, InlineError } from './Fields';

interface Props {
  open: boolean;
  onClose: () => void;
  onChanged: (message: string) => void;
  /** "I forgot my current password" — drops into the reset-link flow. */
  onForgot: () => void;
}

/** api-contract.md rule 4 and design:1198 agree on six. */
const MIN_LENGTH = 6;

export function ChangePasswordSheet({ open, onClose, onChanged, onForgot }: Props) {
  const { lang, copy } = useLanguage();

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setCurrent('');
    setNext('');
    setConfirm('');
    setVisible(false);
    setError(null);
    setBusy(false);
  };

  // Clearing on every open matters more here than on the profile sheet: a
  // password left in component state survives the sheet closing, and the next
  // person to pick up the phone would find the field populated.
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
    // design:1815-1818, in the design's own order.
    if (!current) return setError(copy.pwErrCur);
    if (next.length < MIN_LENGTH) return setError(copy.pwErrShort);
    if (next === current) return setError(copy.pwErrSame);
    if (next !== confirm) return setError(copy.pwErrMatch);

    setBusy(true);
    setError(null);
    try {
      // Awaited. See the header: the other devices are signed out by the time
      // the confirmation appears, or the confirmation does not appear.
      await changePassword(current, next);
      reset();
      onChanged(copy.pwSaved);
    } catch (err) {
      // The server's own message ("That password does not match.") is better
      // than a generic one — it distinguishes a wrong current password from an
      // outage, which is the difference between retyping and giving up.
      setError(err instanceof ApiError ? err.message : copy.errorBody);
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} dismissible onDismiss={close} label={copy.pwTitle} testID="password-sheet">
      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={styles.head}>
          <View style={styles.headText}>
            <Text style={[text('displayS', lang), styles.title]}>{copy.pwTitle}</Text>
            <Text style={[text('body', lang), styles.sub]}>{copy.pwSub}</Text>
          </View>
          <TappableRow
            onPress={() => setVisible((v) => !v)}
            accessibilityRole="button"
            accessibilityState={{ expanded: visible }}
            accessibilityLabel={visible ? copy.pwHide : copy.pwShow}
            testID="password-visibility"
            style={styles.showBtn}
          >
            <Text style={[text('bodyS', lang, '600'), styles.showText]}>
              {visible ? copy.pwHide : copy.pwShow}
            </Text>
          </TappableRow>
        </View>

        <FieldLabel>{copy.pwCurLabel}</FieldLabel>
        <Field
          value={current}
          onChangeText={(v) => {
            setCurrent(v);
            setError(null);
          }}
          placeholder="••••••••"
          secure={!visible}
          autoComplete="current-password"
          ltr
          accessibilityLabel={copy.pwCurLabel}
          testID="password-current"
        />

        <FieldLabel>{copy.pwNewLabel}</FieldLabel>
        <Field
          value={next}
          onChangeText={(v) => {
            setNext(v);
            setError(null);
          }}
          placeholder="••••••••"
          secure={!visible}
          autoComplete="new-password"
          ltr
          accessibilityLabel={copy.pwNewLabel}
          testID="password-new"
        />
        <Text style={[text('bodyS', lang), styles.hint]}>{copy.passHint}</Text>

        <FieldLabel>{copy.pwConfLabel}</FieldLabel>
        <Field
          value={confirm}
          onChangeText={(v) => {
            setConfirm(v);
            setError(null);
          }}
          placeholder="••••••••"
          secure={!visible}
          autoComplete="new-password"
          ltr
          accessibilityLabel={copy.pwConfLabel}
          testID="password-confirm"
        />

        {error ? <InlineError message={error} testID="password-error" /> : null}

        <PrimaryButton
          label={copy.pwSave}
          onPress={() => void submit()}
          disabled={busy}
          style={styles.primary}
          testID="password-save"
        />

        {/*
          api-contract.md rule 5: "Forgot my current password" drops into the
          existing WhatsApp reset-link flow; it is NOT a bypass of `current`.
          So it leaves this sheet entirely rather than unlocking anything in it.
        */}
        <TappableRow
          onPress={() => {
            reset();
            onForgot();
          }}
          accessibilityRole="link"
          accessibilityLabel={copy.pwForgot}
          testID="password-forgot"
          style={styles.forgot}
        >
          <Text style={[text('bodyS', lang, '600'), styles.forgotText]}>{copy.pwForgot}</Text>
        </TappableRow>
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  headText: { flex: 1, minWidth: 0 },
  title: { color: color.ink },
  sub: { color: color.textMutedLabel, marginTop: 6, lineHeight: 21 },
  showBtn: {
    minHeight: 44,
    justifyContent: 'center',
    backgroundColor: color.surfaceAlt2,
    borderRadius: radius.pill,
    paddingHorizontal: 14,
  },
  showText: { color: color.ink },
  hint: { color: color.textMutedSoft, marginTop: 8, marginHorizontal: 2 },
  primary: { marginTop: 20 },
  forgot: { alignSelf: 'center', minHeight: 44, justifyContent: 'center', paddingHorizontal: 8, marginTop: 8 },
  forgotText: { color: color.brandDeep },
});
