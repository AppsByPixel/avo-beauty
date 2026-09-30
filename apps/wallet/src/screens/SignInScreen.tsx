/**
 * Sign in — design/AVO Wallet Home.dc.html:86-109.
 *
 * The wallet's first screen, and until now the wallet did not have one: it has
 * only ever run against `packages/mock`, which asks for no authentication, so
 * every screen worked while sending no credentials at all.
 *
 * WHAT DIFFERS FROM THE DESIGN, AND WHY. Both are reported, neither invented.
 *
 * 1. THE IDENTITY IS A PHONE NUMBER, NOT A USERNAME. The design labels this field
 *    `t.username` with the placeholder `dana.k`; there is no member username in
 *    this system, and `api-contract.md` rule 1 says "Phone is the login identity"
 *    — as does the design's own profile screen, in both languages. The full
 *    conflict is written out in `api/auth.ts`. The label reuses `rowPhone`, which
 *    the bundle already carries verbatim in Arabic and English.
 *
 * 2. THE "FORGOT PASSWORD?" LINK IS BUILT, AND THIS ENTRY USED TO BE ITS ABSENCE.
 *    It read: "There is no member password-reset endpoint … A link that does
 *    nothing, on the one screen a customer reaches when she cannot get into her
 *    wallet, is worse than its absence." Correct then, answered since:
 *    `POST /auth/member/password-reset/request` and its redeem sibling landed
 *    (api/src/routes/auth.ts:835, :943), so design:104's link is below the
 *    fields, right-aligned as drawn, into `ForgotPasswordScreen`. Second entry
 *    in this header to go through the absence-then-built cycle — the third
 *    paragraph records the first.
 *
 * THE THIRD ENTRY IS NOW BUILT AND IS NO LONGER A DIFFERENCE. It read: "NO 'NEW
 * HERE? CREATE ACCOUNT' LINK (design:107). There is no registration endpoint.
 * Signup also carries the consent step that non-negotiable #10 needs — the accepted
 * `policyVersion` stored against the member — so it is a slice of its own once the
 * endpoint lands, not a link to add now." `POST /auth/member/signup` landed; the
 * link is below, both its strings are the design's own in both languages
 * (:1249/:1356), and #10's consent step lives on the screen it opens.
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
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { ApiError } from '../api/client';
import { signIn, workspaceChoices, type WorkspaceChoice } from '../api/auth';
import { salonName } from '../domain/names';
import { useLanguage } from '../i18n/language';
import { workspaceName } from '../state/workspaceName';
import { enterWorkspace } from '../state/workspace';
import { PrimaryButton } from '../components/Buttons';
import { color, MIN_TAP_TARGET, radius, text } from '../theme';
import { focusable } from '../theme/focus';
import { brandedStyles } from '../theme/live';

type Status =
  | { state: 'idle' }
  | { state: 'working' }
  /** A sentence to show inline. Never a screen-level failure. */
  | { state: 'refused'; message: string }
  /** `409 choose_workspace` — her phone and password open more than one. */
  | { state: 'choosing'; workspaces: WorkspaceChoice[] };

export function SignInScreen({
  onSignedIn,
  onCreateAccount,
  onForgotPassword,
}: {
  onSignedIn: () => void;
  /** design:107 — into the Create account screen. */
  onCreateAccount: () => void;
  /** design:104 — into the reset-link flow. */
  onForgotPassword: () => void;
}) {
  const { lang, copy } = useLanguage();
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<Status>({ state: 'idle' });

  /**
   * ONE DOOR, TWO KNOCKS. The first post sends phone and password ALONE — the
   * account decides the workspace, not the build (`api/auth.ts`). If they open
   * more than one, the server answers `choose_workspace` and the second post is
   * the same pair WITH the `salonId` she picked.
   *
   * #6, AND THE ONE PLACE THE PASSWORD OUTLIVES A CALL. It is cleared the moment
   * a call resolves — except on `choose_workspace`, where the re-post needs it
   * and she has not finished signing in. It stays component state, exactly as it
   * was while she typed it, and any keystroke in either field drops the picker
   * (the choice is for THOSE credentials). The re-post clears it either way.
   */
  const submit = useCallback(async (picked: WorkspaceChoice | null = null) => {
    if (status.state === 'working') return;

    if (phone.trim() === '' || password === '') {
      setStatus({ state: 'refused', message: copy.signInErrEmpty });
      return;
    }

    setStatus({ state: 'working' });
    try {
      const member = await signIn(
        picked === null
          ? { phone: phone.trim(), password }
          : { salonId: picked.salonId, phone: phone.trim(), password },
      );
      /*
        Cleared before the parent swaps the screen out. Unmounting would drop the
        state anyway, but relying on that would make the guarantee a side effect of
        the navigation shape rather than something this screen does.
      */
      setPassword('');
      /*
        Into the workspace the SERVER named, before the wallet mounts: its
        palette, and no other workspace's cached wallet — so a Forest sign-in
        never paints a frame of Amara. `state/workspace.ts`.
      */
      await enterWorkspace(
        { salonId: member.salonId, memberId: member.id },
        picked === null ? null : { ...picked, nameAr: picked.nameAr ? picked.nameAr : null },
      );
      onSignedIn();
    } catch (err) {
      const workspaces = picked === null ? workspaceChoices(err) : null;
      if (workspaces !== null) {
        // The password is kept for the re-post — see above.
        setStatus({ state: 'choosing', workspaces });
        return;
      }
      setPassword('');
      /*
        `choose_workspace` WITHOUT A LIST WE CAN READ — a contract break, not a
        state the server means to send (lane A serves two to four rows). Its
        `message` is English only, and this state is ours to word in both
        languages, so the server's sentence is never shown for it; the
        picker's own line says what is true.
      */
      if (err instanceof ApiError && err.code === 'choose_workspace') {
        setStatus({ state: 'refused', message: copy.workspacePickerSub });
        return;
      }
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
  /*
    WHOSE SIGN-IN SCREEN THIS IS: the workspace she was last in, remembered
    across sign-out (`state/lastWorkspace.ts`), or the build's default name when
    the phone has never been signed in. Boot painted the same workspace's hex.
    There is no session here, so no salon: `workspaceName(null)`.
  */
  const salonLabel = workspaceName(null, lang);

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      {/* design:86 — the salon, then the word Wallet. */}
      <View style={styles.brand}>
        <Text style={[text('displayM', lang), styles.salon]} testID="signin-salon">
          {salonLabel}
        </Text>
        <Text style={[text('bodyS', lang), styles.walletWord]}>{copy.walletWord}</Text>
      </View>

      <Text style={[text('displayS', lang), styles.title]}>{copy.signInTitle}</Text>
      <Text style={[text('bodyS', lang), styles.sub]}>{copy.signInSub(salonLabel)}</Text>

      <View style={styles.fields}>
        <Field
          label={copy.rowPhone}
          value={phone}
          onChange={(v) => {
            setPhone(v);
            // The design clears the error on any keystroke (:1728). Leaving it up
            // while she corrects the thing it complained about is nagging.
            if (status.state === 'refused' || status.state === 'choosing') setStatus({ state: 'idle' });
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
            if (status.state === 'refused' || status.state === 'choosing') setStatus({ state: 'idle' });
          }}
          lang={lang}
          testID="signin-password"
          secureTextEntry
          autoComplete="current-password"
        />
      </View>

      {/* design:104 — right-aligned under the fields; flex-end mirrors in RTL. */}
      <Pressable
        onPress={onForgotPassword}
        accessibilityRole="link"
        dataSet={focusable}
        testID="signin-forgot"
        style={styles.forgot}
      >
        <Text style={[text('bodyS', lang, '600'), styles.forgotText]}>{copy.signInForgot}</Text>
      </Pressable>

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

      {status.state === 'choosing' ? (
        <WorkspacePicker
          workspaces={status.workspaces}
          lang={lang}
          title={copy.workspacePickerTitle}
          sub={copy.workspacePickerSub}
          onPick={(ws) => void submit(ws)}
        />
      ) : (
        <PrimaryButton
          label={working ? copy.signInWorking : copy.signInAction}
          onPress={() => void submit()}
          disabled={working}
          testID="signin-submit"
          style={styles.submit}
        />
      )}

      {/* design:107 — "New here? · Create account". */}
      <View style={styles.footer}>
        <Text style={[text('bodyS', lang), styles.footerText]}>{copy.signInNoAccount}</Text>
        <Pressable
          onPress={onCreateAccount}
          accessibilityRole="link"
          dataSet={focusable}
          testID="signin-create-account"
          style={styles.footerLink}
        >
          <Text style={[text('bodyS', lang, '600'), styles.footerLinkText]}>{copy.signInCreateOne}</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

/**
 * The workspace picker — `409 choose_workspace`. NO DESIGN SOURCE: the design
 * has one salon per build and so never drew it. Kept as small as the question:
 * a title, one line, and a row per workspace — its own name in the reading
 * language (`salonName`, so Arabic falls back to the Latin name only when the
 * salon has none) beside a dot in its own brand colour.
 *
 * THE DOT IS A SURFACE, NOT INK. #9 keeps white text off a brand fill; a dot
 * carries no text, and it is the workspace's OWN hex rather than the palette
 * on screen, which is still the last workspace's. The name is `ink`.
 *
 * RTL: the row is `flexDirection: 'row'`, which Yoga and CSS both lay along the
 * inline axis — so the dot leads on the right in Arabic with no conditional.
 */
function WorkspacePicker({
  workspaces,
  lang,
  title,
  sub,
  onPick,
}: {
  workspaces: WorkspaceChoice[];
  lang: 'en' | 'ar';
  title: string;
  sub: string;
  onPick: (ws: WorkspaceChoice) => void;
}) {
  return (
    <View style={styles.picker} testID="signin-workspaces">
      <Text style={[text('bodyL', lang, '600'), styles.pickerTitle]} accessibilityRole="header">
        {title}
      </Text>
      <Text style={[text('bodyS', lang), styles.pickerSub]}>{sub}</Text>
      {workspaces.map((ws) => {
        const name = salonName(ws, lang);
        return (
          <Pressable
            key={ws.salonId}
            onPress={() => onPick(ws)}
            accessibilityRole="button"
            accessibilityLabel={name}
            dataSet={focusable}
            testID={`signin-workspace-${ws.salonId}`}
            style={styles.pickerRow}
          >
            <View
              style={[styles.pickerDot, { backgroundColor: ws.brandColor }]}
              testID={`signin-workspace-dot-${ws.salonId}`}
            />
            <Text style={[text('bodyL', lang, '600'), styles.pickerName]}>{name}</Text>
          </Pressable>
        );
      })}
    </View>
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

const styles = brandedStyles(() => ({
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
  picker: { marginTop: 20, gap: 10 },
  pickerTitle: { color: color.ink, textAlign: 'center' },
  pickerSub: { color: color.textMuted, textAlign: 'center', marginBottom: 4 },
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: MIN_TAP_TARGET,
    borderWidth: 1.5,
    borderColor: color.borderControl,
    backgroundColor: color.white,
    borderRadius: radius.input,
    paddingVertical: 14,
    paddingHorizontal: 15,
  },
  pickerDot: { width: 12, height: 12, borderRadius: 6, flexShrink: 0 },
  pickerName: { color: color.ink, flex: 1 },
  // design:104 — text-align:right, margin-top 11. flex-end mirrors under RTL.
  forgot: {
    alignSelf: 'flex-end',
    minHeight: MIN_TAP_TARGET,
    justifyContent: 'center',
    paddingHorizontal: 4,
    marginTop: 11,
  },
  forgotText: { color: color.brandDeep },
  // design:107 — centred under the button, margin-top 20.
  footer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 6,
    marginTop: 20,
  },
  footerText: { color: color.textMuted },
  footerLink: { minHeight: MIN_TAP_TARGET, justifyContent: 'center', paddingHorizontal: 4 },
  // Brand text on a light surface is brandDeep, never brand (#9).
  footerLinkText: { color: color.brandDeep },
}));
