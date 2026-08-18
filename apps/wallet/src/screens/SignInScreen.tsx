/**
 * Sign in — design/AVO Wallet Home.dc.html:86-109.
 *
 * The wallet's first screen, and until now the wallet did not have one: it has
 * only ever run against `packages/mock`, which asks for no authentication, so
 * every screen worked while sending no credentials at all.
 *
 * WHAT DIFFERS FROM THE DESIGN, AND WHY. All three are reported, none invented.
 *
 * 1. THE IDENTITY IS A PHONE NUMBER, NOT A USERNAME. The design labels this field
 *    `t.username` with the placeholder `dana.k`; there is no member username in
 *    this system, and `api-contract.md` rule 1 says "Phone is the login identity"
 *    — as does the design's own profile screen, in both languages. The full
 *    conflict is written out in `api/auth.ts`. The label reuses `rowPhone`, which
 *    the bundle already carries verbatim in Arabic and English.
 *
 * 2. NO "FORGOT PASSWORD?" LINK (design:104). There is no member password-reset
 *    endpoint — `/auth/staff/password-reset` is staff-only, and
 *    `/members/me/password` is a change that requires being signed in already. A
 *    link that does nothing, on the one screen a customer reaches when she cannot
 *    get into her wallet, is worse than its absence.
 *
 * 3. NO "NEW HERE? CREATE ACCOUNT" LINK (design:107). There is no registration
 *    endpoint. Signup also carries the consent step that non-negotiable #10 needs
 *    — the accepted `policyVersion` stored against the member — so it is a slice
 *    of its own once the endpoint lands, not a link to add now.
 *
 * THE STATES, per interaction-spec §4 — the point being that these are three
 * different sentences and not one "something went wrong":
 *
 *   wrong password   the SERVER's message, inline, field kept, button live again.
 *                    A 401 here is not an outage and must not reach the failure
 *                    screen; she retypes and tries again.
 *   offline          its own sentence. `offlineBanner` would be a lie — it
 *                    promises her last update, and there is nothing to show yet.
 *   empty fields     caught before the request, so a blank submit is not a round
 *                    trip that comes back as "those details do not match".
 *
 * Non-negotiable #6: the password is component state for exactly as long as she is
 * typing it, is passed to `signIn()` as an argument, and is cleared the moment the
 * call resolves either way — the design does the same (`fPass: ''` at :1731). It is
 * never stored, never logged, and never put in a ref that outlives the screen.
 */

import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { ApiError } from '../api/client';
import { signIn } from '../api/auth';
import { SALON_ID } from '../config/salon';
import { useLanguage } from '../i18n/language';
import { PrimaryButton } from '../components/Buttons';
import { color, MIN_TAP_TARGET, radius, text } from '../theme';

type Status =
  | { state: 'idle' }
  | { state: 'working' }
  /** A sentence to show inline. Never a screen-level failure. */
  | { state: 'refused'; message: string };

export function SignInScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const { lang, copy } = useLanguage();
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<Status>({ state: 'idle' });

  const submit = useCallback(async () => {
    if (status.state === 'working') return;

    if (phone.trim() === '' || password === '') {
      setStatus({ state: 'refused', message: copy.signInErrEmpty });
      return;
    }

    setStatus({ state: 'working' });
    try {
      await signIn({ salonId: SALON_ID, phone: phone.trim(), password });
      /*
        Cleared before the parent swaps the screen out. Unmounting would drop the
        state anyway, but relying on that would make the guarantee a side effect of
        the navigation shape rather than something this screen does.
      */
      setPassword('');
      onSignedIn();
    } catch (err) {
      setPassword('');
      if (err instanceof ApiError) {
        setStatus({
          state: 'refused',
          message: err.kind === 'offline' ? copy.signInOffline : err.message,
        });
        return;
      }
      setStatus({ state: 'refused', message: copy.signInOffline });
    }
  }, [status.state, phone, password, copy, onSignedIn]);

  const working = status.state === 'working';

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      {/* design:86 — the salon, then the word Wallet. */}
      <View style={styles.brand}>
        <Text style={[text('displayM', lang), styles.salon]}>{copy.salonName}</Text>
        <Text style={[text('bodyS', lang), styles.walletWord]}>{copy.walletWord}</Text>
      </View>

      <Text style={[text('displayS', lang), styles.title]}>{copy.signInTitle}</Text>
      <Text style={[text('bodyS', lang), styles.sub]}>{copy.signInSub}</Text>

      <View style={styles.fields}>
        <Field
          label={copy.rowPhone}
          value={phone}
          onChange={(v) => {
            setPhone(v);
            // The design clears the error on any keystroke (:1728). Leaving it up
            // while she corrects the thing it complained about is nagging.
            if (status.state === 'refused') setStatus({ state: 'idle' });
          }}
          lang={lang}
          testID="signin-phone"
          keyboardType="phone-pad"
          autoComplete="tel"
        />
        <Field
          label={copy.rowPassword}
          value={password}
          onChange={(v) => {
            setPassword(v);
            if (status.state === 'refused') setStatus({ state: 'idle' });
          }}
          lang={lang}
          testID="signin-password"
          secureTextEntry
          autoComplete="current-password"
        />
      </View>

      {/* design:105 — the inline refusal, not a failure screen. */}
      {status.state === 'refused' && (
        <View
          style={styles.refusal}
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          testID="signin-refusal"
        >
          <View style={styles.refusalDot} />
          <Text style={[text('bodyS', lang), styles.refusalText]}>{status.message}</Text>
        </View>
      )}

      <PrimaryButton
        label={working ? copy.signInWorking : copy.signInAction}
        onPress={() => void submit()}
        disabled={working}
        testID="signin-submit"
        style={styles.submit}
      />
    </ScrollView>
  );
}

/**
 * One labelled field — design:97-102. The label is an uppercase micro-label, which
 * is `textMutedLabel`'s reason for existing as a token.
 */
function Field({
  label,
  value,
  onChange,
  lang,
  testID,
  secureTextEntry,
  keyboardType,
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  lang: 'en' | 'ar';
  testID: string;
  secureTextEntry?: boolean;
  keyboardType?: 'phone-pad';
  autoComplete?: 'tel' | 'current-password';
}) {
  return (
    <View style={styles.field}>
      <Text style={[text('label', lang), styles.fieldLabel]}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        style={[text('bodyL', lang), styles.input]}
        accessibilityLabel={label}
        testID={testID}
        autoCapitalize="none"
        autoCorrect={false}
        {...(secureTextEntry === undefined ? {} : { secureTextEntry })}
        {...(keyboardType === undefined ? {} : { keyboardType })}
        {...(autoComplete === undefined ? {} : { autoComplete })}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.surface },
  content: { paddingTop: 72, paddingHorizontal: 24, paddingBottom: 32, flexGrow: 1 },
  brand: { alignItems: 'center' },
  salon: { color: color.ink },
  walletWord: { color: color.textMuted, marginTop: 3 },
  title: { textAlign: 'center', color: color.ink, marginTop: 36 },
  sub: { textAlign: 'center', color: color.textMuted, marginTop: 6 },
  fields: { gap: 13, marginTop: 28 },
  field: { gap: 7 },
  fieldLabel: { color: color.textMutedLabel, textTransform: 'uppercase', letterSpacing: 1 },
  input: {
    minHeight: MIN_TAP_TARGET,
    borderWidth: 1.5,
    borderColor: color.borderControl,
    backgroundColor: color.white,
    borderRadius: radius.input,
    paddingVertical: 14,
    paddingHorizontal: 15,
    color: color.ink,
  },
  refusal: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    backgroundColor: color.dangerBg,
    borderRadius: radius.chip,
    paddingVertical: 11,
    paddingHorizontal: 14,
    marginTop: 14,
  },
  refusalDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: color.dangerDot,
    flexShrink: 0,
  },
  refusalText: { color: color.dangerText, flex: 1 },
  submit: { marginTop: 20 },
});
