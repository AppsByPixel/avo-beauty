/**
 * Edit profile, and the 4-digit confirmation that a phone change goes through.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE PHONE NUMBER IS THE LOGIN IDENTITY, SO IT IS NOT AN EDITABLE FIELD THAT
 * HAPPENS TO ASK A QUESTION AFTERWARDS.
 *
 * api-contract.md rule 1: "`PATCH /members/me` must reject a `phone` field. A
 * change goes through the challenge endpoints." So this sheet has two shapes and
 * the fork is decided by comparing the typed number against the member's:
 *
 *   phone unchanged   PATCH /members/me { name, email } → done.
 *   phone changed     POST /members/me/phone-change { phone } → a challenge, the
 *                     verify step, and the Member comes back from
 *                     POST …/verify. Name and email ride along with the verify
 *                     only after the number is confirmed, so a customer cannot
 *                     rename herself by starting a phone change and abandoning
 *                     it half way.
 *
 * The design does the same fork at design:1802 — `if (phone !== acctPhone) {
 * pfStep: 'verify' }` — and it is the reason `pfPhoneNote` exists as copy: the
 * customer is told why this one field behaves differently before she edits it.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Member } from '@avo/types';
import { color, text } from '../../theme';
import { useLanguage } from '../../i18n/language';
import { patchProfile, startPhoneChange, verifyPhoneChange } from '../../api/account';
import { ApiError } from '../../api/client';
import { Sheet } from '../Sheet';
import { PrimaryButton, SecondaryButton, TappableRow } from '../Buttons';
import { CodeField, Field, FieldLabel, InlineError } from './Fields';

interface Props {
  open: boolean;
  member: Member;
  onClose: () => void;
  onSaved: (member: Member, message: string) => void;
  onToast: (message: string) => void;
}

/** design:1799 — eight digits after stripping separators is the floor. */
function isPlausiblePhone(value: string): boolean {
  return value.replace(/\D/g, '').length >= 8;
}

/** design:1801 — the design's own expression, not a stricter one invented here. */
function isPlausibleEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

export function EditProfileSheet({ open, member, onClose, onSaved, onToast }: Props) {
  const { lang, copy } = useLanguage();

  const [step, setStep] = useState<'form' | 'verify'>('form');
  const [name, setName] = useState(member.name);
  const [phone, setPhone] = useState(member.phone);
  const [email, setEmail] = useState(member.email ?? '');
  const [code, setCode] = useState('');
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Re-seed from the member each time the sheet opens, so a cancelled edit does
  // not leave stale values behind the next time it is opened.
  const [openedWith, setOpenedWith] = useState(open);
  if (open !== openedWith) {
    setOpenedWith(open);
    if (open) {
      setStep('form');
      setName(member.name);
      setPhone(member.phone);
      setEmail(member.email ?? '');
      setCode('');
      setChallengeId(null);
      setError(null);
    }
  }

  const save = async () => {
    const trimmedName = name.trim();
    const trimmedPhone = phone.trim();
    const trimmedEmail = email.trim();

    if (!trimmedName) return setError(copy.pfErrName);
    if (!isPlausiblePhone(trimmedPhone)) return setError(copy.pfErrPhone);
    if (trimmedEmail && !isPlausibleEmail(trimmedEmail)) return setError(copy.pfErrEmail);

    setBusy(true);
    setError(null);
    try {
      if (trimmedPhone !== member.phone) {
        // The identity change. Nothing else is saved yet.
        const challenge = await startPhoneChange(trimmedPhone);
        setChallengeId(challenge.challengeId);
        setCode('');
        setStep('verify');
        return;
      }
      const updated = await patchProfile({
        name: trimmedName,
        // Empty clears it. `null` rather than '' so the intent is unambiguous
        // to a server that distinguishes "unset" from "set to blank".
        email: trimmedEmail === '' ? null : trimmedEmail,
      });
      onSaved(updated, copy.pfSaved);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : copy.errorBody);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (code.length !== 4) return setError(copy.vfErr);
    if (!challengeId) return setError(copy.errorBody);

    setBusy(true);
    setError(null);
    try {
      const verified = await verifyPhoneChange(challengeId, code);
      const trimmedName = name.trim();
      const trimmedEmail = email.trim();
      // The name/email edit that was travelling with the phone change is applied
      // only now, and only if it actually differs — a needless PATCH would clear
      // `emailVerified` for nothing (api-contract.md rule 3).
      const alsoChanged =
        trimmedName !== verified.name || trimmedEmail !== (verified.email ?? '');
      const final = alsoChanged
        ? await patchProfile({
            name: trimmedName,
            email: trimmedEmail === '' ? null : trimmedEmail,
          })
        : verified;
      onSaved(final, copy.pfSaved);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : copy.errorBody);
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    setError(null);
    try {
      const challenge = await startPhoneChange(phone.trim());
      setChallengeId(challenge.challengeId);
      setCode('');
      onToast(copy.vfSent);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : copy.errorBody);
    }
  };

  return (
    <Sheet
      open={open}
      dismissible
      onDismiss={onClose}
      label={step === 'form' ? copy.pfTitle : copy.vfTitle}
      testID="profile-sheet"
    >
      {step === 'form' ? (
        <ScrollView showsVerticalScrollIndicator={false}>
          <Text style={[text('displayS', lang), styles.title]}>{copy.pfTitle}</Text>
          <Text style={[text('body', lang), styles.sub]}>{copy.pfSub}</Text>

          <FieldLabel>{copy.rowName}</FieldLabel>
          <Field
            value={name}
            onChangeText={(next) => {
              setName(next);
              setError(null);
            }}
            autoComplete="name"
            accessibilityLabel={copy.rowName}
            testID="profile-name"
          />

          <FieldLabel>{copy.rowPhone}</FieldLabel>
          <Field
            value={phone}
            onChangeText={(next) => {
              setPhone(next);
              setError(null);
            }}
            keyboardType="phone-pad"
            autoComplete="tel"
            ltr
            accessibilityLabel={copy.rowPhone}
            testID="profile-phone"
          />
          <Text style={[text('bodyS', lang), styles.note]}>{copy.pfPhoneNote}</Text>

          <FieldLabel hint={copy.cOptional}>{copy.rowEmail}</FieldLabel>
          <Field
            value={email}
            onChangeText={(next) => {
              setEmail(next);
              setError(null);
            }}
            placeholder={copy.pfEmailPh}
            keyboardType="email-address"
            autoComplete="email"
            ltr
            accessibilityLabel={copy.rowEmail}
            testID="profile-email"
          />

          {error ? <InlineError message={error} testID="profile-error" /> : null}

          <PrimaryButton
            label={copy.pfSave}
            onPress={() => void save()}
            disabled={busy}
            style={styles.primary}
            testID="profile-save"
          />
          <SecondaryButton
            label={copy.txClose}
            onPress={onClose}
            style={styles.cancel}
            testID="profile-cancel"
          />
        </ScrollView>
      ) : (
        <ScrollView showsVerticalScrollIndicator={false}>
          <Text style={[text('displayS', lang), styles.title]}>{copy.vfTitle}</Text>
          {/* The number the code went to — the NEW one, not the stored one. */}
          <Text style={[text('body', lang), styles.sub]}>{copy.vfSub(phone.trim())}</Text>

          <CodeField
            value={code}
            onChangeText={(next) => {
              setCode(next);
              setError(null);
            }}
            accessibilityLabel={copy.vfTitle}
            testID="profile-code"
          />

          {error ? <InlineError message={error} testID="verify-error" /> : null}

          <PrimaryButton
            label={copy.vfConfirm}
            onPress={() => void confirm()}
            disabled={busy}
            style={styles.primary}
            testID="profile-confirm"
          />
          <View style={styles.links}>
            <TappableRow
              onPress={() => void resend()}
              accessibilityRole="button"
              accessibilityLabel={copy.vfResend}
              testID="profile-resend"
              style={styles.link}
            >
              <Text style={[text('bodyS', lang), styles.linkText]}>{copy.vfResend}</Text>
            </TappableRow>
            <TappableRow
              onPress={() => {
                setStep('form');
                setCode('');
                setError(null);
              }}
              accessibilityRole="button"
              accessibilityLabel={copy.vfBack}
              testID="profile-back"
              style={styles.link}
            >
              <Text style={[text('bodyS', lang), styles.linkMuted]}>{copy.vfBack}</Text>
            </TappableRow>
          </View>
        </ScrollView>
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  title: { color: color.ink },
  sub: { color: color.textMutedLabel, marginTop: 6, lineHeight: 21 },
  note: { color: color.textMutedSoft, marginTop: 8, marginHorizontal: 2, lineHeight: 18 },
  primary: { marginTop: 20 },
  cancel: { marginTop: 10, borderColor: 'transparent' },
  links: { flexDirection: 'row', justifyContent: 'center', gap: 16, marginTop: 14 },
  link: { paddingVertical: 12, paddingHorizontal: 8, minHeight: 44, justifyContent: 'center' },
  linkText: { color: color.brandDeep, fontWeight: '600' },
  linkMuted: { color: color.textMuted, fontWeight: '600' },
});
