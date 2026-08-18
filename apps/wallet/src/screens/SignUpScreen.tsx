/**
 * Create account — design/AVO Wallet Home.dc.html:110-152.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * NON-NEGOTIABLE #10 LIVES ON THIS SCREEN, SO READ IT BEFORE EDITING IT.
 *
 * "The customer app holds no legal copy. It renders the published policy set from
 *  the API and stamps the version. Store the accepted version against the member."
 *
 * Three consequences, and each of them is a state below rather than a comment:
 *
 * 1. THE TERMS ARE FETCHED BEFORE THE FORM CAN BE SUBMITTED. There is no bundled
 *    set to fall back to, so a failed `GET /v1/platform/policies` is not a
 *    cosmetic gap — the screen cannot honestly offer a consent checkbox above
 *    links that open nothing. It shows `signUpTermsFailed*` and Try again, and no
 *    form.
 *
 * 2. THE VERSION SUBMITTED IS THE VERSION RENDERED. `policyVersion` comes off the
 *    set this screen fetched and drew, never off a constant, never off the 409's
 *    `publishedVersion`. A server stamping "whatever is current" would satisfy
 *    the letter of #10 and reproduce exactly what design/README.md gap 5 forbids;
 *    so would a client resubmitting a number it was handed but never displayed.
 *
 * 3. `policy_version_stale` IS A RENDERED STATE, NOT AN EDGE CASE. A publish
 *    landing between the render and the tap is the ordinary race. The recovery is
 *    to re-fetch, re-render, and CLEAR THE TICK — a box ticked against v3 is not
 *    consent to v4 — and to say so in a sentence that reads as "the terms
 *    changed" rather than "something went wrong". See `domain/signup.ts`.
 *
 * WHAT DIFFERS FROM THE DESIGN, all settled in DECISIONS.md § "Member signup" and
 * § "Wallet sign-in identity", none invented here:
 *
 *   NO USERNAME FIELD (design:122). There is no member username in this system —
 *   no column, no `MemberSchema` field — and the design contradicts itself, saying
 *   in both languages at :1187/:1294 that "your phone number is how you log in".
 *   A PHONE FIELD replaces it, labelled with the bundle's own `rowPhone`.
 *
 *   THE NAME IS REQUIRED, where design:118 marks it `optional`. It sat beside a
 *   required username; with the username gone it is the only human label on the
 *   record — the scanner shows it to staff, the receipt carries it, and the audit
 *   log names her. `PATCH /members/me` already refuses a blank name, so accepting
 *   one here would create a row its own edit endpoint could not round-trip.
 *
 *   THE WHATSAPP BOX DEFAULTS TICKED (design:1021 `consentWa: true`), and it is
 *   the SERVICE channel — receipts and appointment confirmations — not marketing.
 *   Whatever it is set to is sent EXPLICITLY: `notify_wa` is `NOT NULL DEFAULT
 *   true`, so an omitted field would record the opposite of an unticked box, and
 *   the API refuses an absent value rather than defaulting it.
 *
 * THE PASSWORD, #6. Two fields' worth of component state for exactly as long as
 * she is typing, passed to `signUp()` as an argument, and cleared the moment the
 * call resolves either way — success included, exactly as the design does at
 * :1731. Never stored, never logged, never in a ref that outlives the screen.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import type { LegalDoc } from '@avo/types';
import { ApiError } from '../api/client';
import { signUp } from '../api/auth';
import { getPolicies, localiseDoc, type PublishedPolicies } from '../api/account';
import { MIN_PASSWORD_LENGTH, signupRefusal, type SignupRecovery } from '../domain/signup';
import { SALON_ID } from '../config/salon';
import { useLanguage } from '../i18n/language';
import { PrimaryButton } from '../components/Buttons';
import { PolicySheet } from '../components/account/PolicySheet';
import { color, MIN_TAP_TARGET, radius, text } from '../theme';
import { focusable } from '../theme/focus';

/**
 * The terms, and whether they are here yet.
 *
 * `failed` carries the API's error CODE so the 503 `policies_not_published` can be
 * told from a 500 — the first means no account can be created at all, the second
 * is worth a retry. Both hide the form; only one of them offers the button.
 */
type Terms =
  | { state: 'loading' }
  | { state: 'ready'; set: PublishedPolicies }
  | { state: 'failed'; code: string | null };

type Status =
  | { state: 'idle' }
  | { state: 'working' }
  /** A sentence to show inline, and what she can do about it. */
  | { state: 'refused'; message: string; recovery: SignupRecovery };

export function SignUpScreen({
  onSignedUp,
  onLogIn,
}: {
  /** Registered AND signed in — the 201 carries a session. */
  onSignedUp: () => void;
  /** design:151 — "Already have an account? Log in". Also the `login` recovery. */
  onLogIn: () => void;
}) {
  const { lang, copy } = useLanguage();

  const [terms, setTerms] = useState<Terms>({ state: 'loading' });
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  // design:1021 — the design's own default. The service channel starts on; the
  // value is sent explicitly whatever it is.
  const [wa, setWa] = useState(true);
  const [openDoc, setOpenDoc] = useState<LegalDoc | null>(null);
  const [status, setStatus] = useState<Status>({ state: 'idle' });

  /**
   * Fetch the published set.
   *
   * A counter rather than a boolean, so the `reterms` recovery can force a
   * re-fetch of a set it already has. Returning to `loading` first is deliberate:
   * leaving the old documents on screen while the new ones are in flight would
   * put her one tap from accepting a version this screen no longer intends to
   * submit.
   */
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    setTerms({ state: 'loading' });
    getPolicies(controller.signal)
      .then((set) => {
        if (alive) setTerms({ state: 'ready', set });
      })
      .catch((err: unknown) => {
        if (!alive) return;
        /*
          The code, not the error. Nothing on this screen renders the server's
          sentence — the copy is ours in both languages — so the only thing worth
          keeping is which refusal it was. This is also why the effect depends on
          `reload` alone and reads no copy: a language switch mid-fetch must not
          re-request the set.
        */
        setTerms({ state: 'failed', code: err instanceof ApiError ? err.code : null });
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [reload]);

  const submit = useCallback(async () => {
    if (status.state === 'working') return;
    // Unreachable from the UI — the button is not rendered without a version —
    // and checked anyway, because `policyVersion` is the one field that must
    // never be guessed.
    if (terms.state !== 'ready') return;

    /*
      Caught before the request, in the design's own order (:1730-1735): fields,
      then the password rules, then consent. A blank submit is not a round trip
      that comes back as an error about something she can see for herself.
    */
    if (name.trim() === '' || phone.trim() === '' || password === '') {
      setStatus({ state: 'refused', message: copy.signUpErrEmpty, recovery: 'retype' });
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setStatus({ state: 'refused', message: copy.signUpErrShort, recovery: 'retype' });
      return;
    }
    /*
      The confirm field is the design's (:129) and is NOT sent. It exists so that
      a typo in a password she cannot see does not lock her out of a wallet she
      has just funded — there is no member password-reset endpoint to rescue her
      with.
    */
    if (confirm !== password) {
      setStatus({ state: 'refused', message: copy.signUpErrMismatch, recovery: 'retype' });
      return;
    }
    if (!acceptedTerms) {
      setStatus({ state: 'refused', message: copy.signUpErrConsent, recovery: 'retype' });
      return;
    }

    setStatus({ state: 'working' });
    try {
      await signUp({
        salonId: SALON_ID,
        name: name.trim(),
        phone: phone.trim(),
        password,
        // #10. The version this screen rendered, off the set it fetched.
        policyVersion: terms.set.version,
        // Explicit, always. An omitted value would store the opposite of an
        // unticked box.
        wa,
      });
      // Cleared before the parent swaps the screen out — the same reasoning as
      // SignInScreen: unmounting would drop it anyway, and relying on that makes
      // #6 a side effect of the navigation shape.
      setPassword('');
      setConfirm('');
      onSignedUp();
    } catch (err) {
      setPassword('');
      setConfirm('');
      const refusal = signupRefusal(err, copy);
      setStatus({ state: 'refused', ...refusal });
      /*
        THE TERMS MOVED. Re-fetch and re-render them, and drop the tick: she has
        to accept the version she is now being shown. The refusal sentence stays
        up through the reload so the screen explains why the box emptied.
      */
      if (refusal.recovery === 'reterms') {
        setAcceptedTerms(false);
        setReload((n) => n + 1);
      }
    }
  }, [
    status.state,
    terms,
    name,
    phone,
    password,
    confirm,
    acceptedTerms,
    wa,
    copy,
    onSignedUp,
  ]);

  /** Any keystroke clears the refusal — design:1754 does the same. */
  const clearRefusal = useCallback(() => {
    setStatus((s) => (s.state === 'refused' ? { state: 'idle' } : s));
  }, []);

  const working = status.state === 'working';

  // ------------------------------------------------------------ terms failed --
  /*
    #10 again: no set, no form. `policies_not_published` is a 503 the deployment
    has to fix, so it gets no Try again — a button that will fail identically
    teaches her the app is broken. Anything else is worth one.
  */
  if (terms.state === 'failed') {
    const unpublished = terms.code === 'policies_not_published';
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <Brand />
        <View style={styles.termsFailed} accessibilityRole="alert">
          <Text style={[text('displayS', lang), styles.title]}>
            {unpublished ? copy.signUpErrTermsMissing : copy.signUpTermsFailedTitle}
          </Text>
          {unpublished ? null : (
            <Text style={[text('bodyS', lang), styles.sub]}>{copy.signUpTermsFailedBody}</Text>
          )}
          {unpublished ? null : (
            <PrimaryButton
              label={copy.tryAgain}
              onPress={() => setReload((n) => n + 1)}
              testID="signup-terms-retry"
              style={styles.submit}
            />
          )}
          <Pressable
            onPress={onLogIn}
            accessibilityRole="link"
            dataSet={focusable}
            testID="signup-to-login"
            style={styles.footerLink}
          >
            <Text style={[text('bodyS', lang), styles.footerLinkText]}>{copy.signUpLogIn}</Text>
          </Pressable>
        </View>
      </ScrollView>
    );
  }

  const ready = terms.state === 'ready' ? terms.set : null;
  /**
   * design:146 — the links beside the box, and only the documents AVO flagged as
   * consent documents. `consent` is the API's own field; the owner console decides
   * which documents are "required at signup" and this screen renders that decision
   * rather than a list of its own.
   */
  const consentDocs = (ready?.docs ?? []).filter((d) => d.consent);

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Brand />

      <Text style={[text('displayS', lang), styles.title]}>{copy.signUpTitle}</Text>
      <Text style={[text('bodyS', lang), styles.sub]}>{copy.signUpSub}</Text>

      <View style={styles.fields}>
        {/* design:118, minus the `optional` marker — the name is required here. */}
        <Field
          label={copy.rowName}
          value={name}
          onChange={(v) => {
            setName(v);
            clearRefusal();
          }}
          lang={lang}
          testID="signup-name"
          autoComplete="name"
        />
        {/* Replaces design:122's Username. See the header. */}
        <Field
          label={copy.rowPhone}
          value={phone}
          onChange={(v) => {
            setPhone(v);
            clearRefusal();
          }}
          lang={lang}
          testID="signup-phone"
          keyboardType="phone-pad"
          autoComplete="tel"
        />
        <Field
          label={copy.rowPassword}
          value={password}
          onChange={(v) => {
            setPassword(v);
            clearRefusal();
          }}
          lang={lang}
          testID="signup-password"
          placeholder={copy.signUpPassHint}
          secureTextEntry
          autoComplete="new-password"
        />
        <Field
          label={copy.signUpConfirmPass}
          value={confirm}
          onChange={(v) => {
            setConfirm(v);
            clearRefusal();
          }}
          lang={lang}
          testID="signup-confirm"
          secureTextEntry
          autoComplete="new-password"
        />
      </View>

      {/* design:133 — the inline refusal, never a failure screen. */}
      {status.state === 'refused' && (
        <View
          style={styles.refusal}
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          testID="signup-refusal"
        >
          <View style={styles.refusalDot} />
          <Text style={[text('bodyS', lang), styles.refusalText]}>{status.message}</Text>
        </View>
      )}

      {/*
        design:134-144 — the two boxes. The required one first, in the design's
        order, and they are separate controls because they are separate facts:
        one is the acceptance #10 stores against her, the other is a notification
        preference.
      */}
      <View style={styles.consents}>
        <Checkbox
          checked={acceptedTerms}
          onToggle={() => {
            setAcceptedTerms((v) => !v);
            clearRefusal();
          }}
          label={copy.signUpConsentTerms}
          lang={lang}
          testID="signup-consent-terms"
        />
        <Checkbox
          checked={wa}
          onToggle={() => setWa((v) => !v)}
          label={copy.signUpConsentWa}
          lang={lang}
          testID="signup-consent-wa"
        />
      </View>

      {/*
        design:145-149 — one link per consent document, opening the real text.
        The label is the document's own localised title from the API; #10 means
        there is no hard-coded "Terms & conditions" string anywhere here.
      */}
      {consentDocs.length > 0 ? (
        <View style={styles.links}>
          {consentDocs.map((doc) => (
            <Pressable
              key={doc.id}
              onPress={() => setOpenDoc(doc)}
              accessibilityRole="link"
              dataSet={focusable}
              testID={`signup-doc-${doc.id}`}
              style={styles.link}
            >
              <Text style={[text('bodyS', lang), styles.linkText]}>
                {localiseDoc(doc, lang).title}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {/*
        DISABLED UNTIL THE TERMS ARE HERE, which is the loading state doing real
        work rather than decoration: without a version there is nothing valid to
        submit, and a live button would mint a request the server must refuse.

        Also disabled on an `unavailable` refusal — an hourly ceiling, an
        unpublished set, a salon the API does not have. Not a trap: any keystroke
        clears the refusal and the button comes back, so she is stopped from
        immediately re-tapping something that cannot work without being stranded
        on a dead screen.
      */}
      <PrimaryButton
        label={working ? copy.signUpWorking : copy.signUpAction}
        onPress={() => void submit()}
        disabled={
          working ||
          ready === null ||
          (status.state === 'refused' && status.recovery === 'unavailable')
        }
        testID="signup-submit"
        style={styles.submit}
      />

      {/* design:151 — and the destination for the `login` recovery. */}
      <View style={styles.footer}>
        <Text style={[text('bodyS', lang), styles.footerText]}>{copy.signUpHaveAccount}</Text>
        <Pressable
          onPress={onLogIn}
          accessibilityRole="link"
          dataSet={focusable}
          testID="signup-to-login"
          style={styles.footerLink}
        >
          <Text style={[text('bodyS', lang), styles.footerLinkText]}>{copy.signUpLogIn}</Text>
        </Pressable>
      </View>

      {/*
        The same sheet the Account screen uses, and the same stamp: the version
        she is being asked to accept is on screen with the document, which is what
        api-contract.md wants it visible for.
      */}
      <PolicySheet
        doc={openDoc}
        effectiveFrom={ready?.effectiveFrom ?? null}
        version={ready?.version ?? null}
        onClose={() => setOpenDoc(null)}
      />
    </ScrollView>
  );
}

/** design:113 — the salon, then the word Wallet. Shared shape with sign-in. */
function Brand() {
  const { lang, copy } = useLanguage();
  return (
    <View style={styles.brand}>
      <Text style={[text('displayM', lang), styles.salon]}>{copy.salonName}</Text>
      <Text style={[text('bodyS', lang), styles.walletWord]}>{copy.walletWord}</Text>
    </View>
  );
}

/** One labelled field — design:116-131, the same shape sign-in draws. */
function Field({
  label,
  value,
  onChange,
  lang,
  testID,
  placeholder,
  secureTextEntry,
  keyboardType,
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  lang: 'en' | 'ar';
  testID: string;
  placeholder?: string;
  secureTextEntry?: boolean;
  keyboardType?: 'phone-pad';
  autoComplete?: 'name' | 'tel' | 'new-password';
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
        {...(placeholder === undefined ? {} : { placeholder })}
        {...(secureTextEntry === undefined ? {} : { secureTextEntry })}
        {...(keyboardType === undefined ? {} : { keyboardType })}
        {...(autoComplete === undefined ? {} : { autoComplete })}
      />
    </View>
  );
}

/**
 * design:135-143 — a box and a sentence, as one control.
 *
 * `accessibilityRole="checkbox"` with the checked state, not a Pressable with a
 * tick drawn in it: the required consent box is the control that blocks account
 * creation, and a screen reader has to be able to say whether it is ticked.
 *
 * The tick is `WHITE` on `brandDeep` and never on `brand` — non-negotiable #9.
 * The box is `MIN_TAP_TARGET` tall as a whole row, so the 44pt rule is met by the
 * control rather than by the 20pt square inside it.
 */
function Checkbox({
  checked,
  onToggle,
  label,
  lang,
  testID,
}: {
  checked: boolean;
  onToggle: () => void;
  label: string;
  lang: 'en' | 'ar';
  testID: string;
}) {
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={label}
      dataSet={focusable}
      testID={testID}
      style={styles.consentRow}
    >
      <View style={[styles.box, checked && styles.boxChecked]}>
        {checked ? (
          <Svg width={11} height={11} viewBox="0 0 14 14" fill="none">
            <Path
              d="M3 7.5 6 10.5 11 4"
              stroke={color.white}
              strokeWidth={2.2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </Svg>
        ) : null}
      </View>
      <Text style={[text('bodyS', lang), styles.consentText]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.surface },
  content: { paddingTop: 56, paddingHorizontal: 24, paddingBottom: 40, flexGrow: 1 },
  brand: { alignItems: 'center' },
  salon: { color: color.ink },
  walletWord: { color: color.textMuted, marginTop: 3 },
  title: { textAlign: 'center', color: color.ink, marginTop: 30 },
  sub: { textAlign: 'center', color: color.textMuted, marginTop: 6 },
  fields: { gap: 12, marginTop: 24 },
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
  // design:133 — the same refusal chip the sign-in screen uses.
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
  // design:134 — gap 11, margin-top 18.
  consents: { gap: 11, marginTop: 18 },
  consentRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 11,
    minHeight: MIN_TAP_TARGET,
    paddingVertical: 6,
  },
  box: {
    width: 20,
    height: 20,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: color.borderControl,
    backgroundColor: color.white,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    marginTop: 1,
  },
  // #9: a filled control is brandDeep, because the tick inside it is white.
  boxChecked: { backgroundColor: color.brandDeep, borderColor: color.brandDeep },
  consentText: { color: color.textMuted, flex: 1, lineHeight: 19 },
  // design:145 — the row of document links, gap 14.
  links: { flexDirection: 'row', flexWrap: 'wrap', gap: 14, marginTop: 12 },
  link: { paddingVertical: 6 },
  // Brand text on a light surface is brandDeep, never brand (#9).
  linkText: { color: color.brandDeep, fontWeight: '600', textDecorationLine: 'underline' },
  submit: { marginTop: 20 },
  footer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 6,
    marginTop: 20,
  },
  footerText: { color: color.textMuted },
  footerLink: { minHeight: MIN_TAP_TARGET, justifyContent: 'center', paddingHorizontal: 4 },
  footerLinkText: { color: color.brandDeep, fontWeight: '600' },
  termsFailed: { marginTop: 40, alignItems: 'stretch' },
});
