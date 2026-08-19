/**
 * Reset your password — the design's `authScreen === 'forgot'`, sibling of
 * sign-in and signup, with the `resetSent` sub-state. design § FORGOT.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE 202 IS NOT A CONFIRMATION, AND THIS SCREEN IS BUILT SO IT CANNOT BECOME
 * ONE. The server answers 202 with an identical body whether or not the pair
 * matched — unknown phone and right-phone-wrong-salon are byte-identical,
 * deliberately, so this form cannot be used as a customer-list oracle. The
 * client's half of that property is structural, in three places:
 *
 *   - `requestPasswordReset` resolves void: nothing in the answer to branch on.
 *   - `ResetRequestRefusal` has no member that could carry "unknown phone", and
 *     resetRequest.test.ts asserts the union stays that shape.
 *   - The sent state renders ONE sentence (`resetSentSub`) on every 202. There
 *     is no code path from "who she is" to "what this screen says".
 *
 * THE THROTTLE IS THE FLOW WORKING. The server rate-limits by IP and answers
 * BEFORE validation, so under repeat the refusal is a 429 in the server's own
 * words ("Wait a moment and try again") — rendered inline, with the submit
 * button left enabled but the sentence telling her to wait. It must never read
 * as an our-side failure; that is the classifier's job and its spec.
 *
 * TWO ENTRY POINTS, ONE EXIT. Sign-in's "Forgot password?" (design:104) and
 * Account → Change password → "I forgot my current password" (contract rule 5:
 * that link "drops into the existing WhatsApp reset-link flow; it is not a
 * bypass of `current`"). Both land here; `onBack` returns to sign-in in both
 * cases, which is the design's own exit ("Back to log in") and the honest one —
 * she came here because she cannot remember the password, and the link she is
 * about to redeem will revoke every session anyway.
 *
 * WHAT THIS SCREEN DOES NOT DO: redeem. The design draws no set-new-password
 * screen (authScreen is login/signup/forgot only), no sender is wired
 * (`sent_at` stays NULL — the standing client escalation), and the deep-link
 * shape into a redeem screen is undecided. Reported, not invented.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { requestPasswordReset } from '../api/auth';
import { resetRequestRefusal } from '../domain/resetRequest';
import { MIN_TAP_TARGET, WHITE, color, radius, text } from '../theme';
import { useLanguage } from '../i18n/language';
import { focusable } from '../theme/focus';
import { PrimaryButton } from '../components/Buttons';

type Status =
  | { state: 'idle' }
  | { state: 'working' }
  /** Inline sentence. Never a screen-level failure — she is mid-form. */
  | { state: 'refused'; message: string }
  | { state: 'sent' };

export function ForgotPasswordScreen({ onBack }: { onBack: () => void }) {
  const { lang, copy } = useLanguage();
  const [phone, setPhone] = useState('');
  const [status, setStatus] = useState<Status>({ state: 'idle' });

  const submit = useCallback(async () => {
    if (status.state === 'working') return;
    if (phone.trim() === '') {
      // Inline, per the design's own forgot-screen validation — but its string
      // names a username and a password, so this is the corrected one
      // (INVENTED, recorded in copy/types.ts beside signInErrEmpty's identical
      // history).
      setStatus({ state: 'refused', message: copy.resetErrEmpty });
      return;
    }
    setStatus({ state: 'working' });
    try {
      await requestPasswordReset(phone.trim());
      setStatus({ state: 'sent' });
    } catch (err) {
      const refusal = resetRequestRefusal(err);
      /*
        The server's sentence for everything it wrote one for — the throttle
        names the wait, the validator names the format, a 500 says what it says.
        Only `offline` substitutes ours, because a transport failure has no
        server sentence and "No connection." under this form needs the reconnect
        guidance `offlineColdBody` carries.
      */
      setStatus({
        state: 'refused',
        message: refusal.kind === 'offline' ? copy.offlineColdBody : refusal.message,
      });
    }
  }, [status.state, phone, copy]);

  const working = status.state === 'working';

  if (status.state === 'sent') {
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.sentContent}>
        <SentMark />
        <Text
          style={[text('displayS', lang), styles.sentTitle]}
          accessibilityRole="header"
          testID="reset-sent-title"
        >
          {copy.resetSentTitle}
        </Text>
        {/*
          ONE SENTENCE, EVERY 202 — see the header. This block must never learn
          whether the phone matched, because the wire does not say and the type
          cannot carry it.
        */}
        <Text style={[text('bodyS', lang), styles.sentSub]}>{copy.resetSentSub}</Text>
        <PrimaryButton
          label={copy.backToLogin}
          onPress={onBack}
          testID="reset-back"
          style={styles.sentBack}
        />
      </ScrollView>
    );
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={[text('displayS', lang), styles.title]} accessibilityRole="header">
        {copy.resetTitle}
      </Text>
      <Text style={[text('bodyS', lang), styles.sub]}>{copy.resetSub}</Text>

      {/* The identity is the phone — the label sign-in already uses, verbatim
          in both languages. The design's username field is the settled conflict
          copy/en.ts § resetSub records. */}
      <View style={styles.field}>
        <Text style={[text('label', lang), styles.fieldLabel]}>{copy.rowPhone}</Text>
        <TextInput
          value={phone}
          onChangeText={(v) => {
            setPhone(v);
            // design:1728 — the error clears on any keystroke.
            if (status.state === 'refused') setStatus({ state: 'idle' });
          }}
          style={[text('bodyL', lang), styles.input]}
          accessibilityLabel={copy.rowPhone}
          testID="reset-phone"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="phone-pad"
          autoComplete="tel"
        />
      </View>

      {status.state === 'refused' && (
        <View
          style={styles.refusal}
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          testID="reset-refusal"
        >
          <View style={styles.refusalDot} />
          <Text style={[text('bodyS', lang), styles.refusalText]}>{status.message}</Text>
        </View>
      )}

      <PrimaryButton
        label={working ? copy.resetWorking : copy.resetBtn}
        onPress={() => void submit()}
        disabled={working}
        testID="reset-submit"
        style={styles.submit}
      />

      <View style={styles.footer}>
        <Pressable
          onPress={onBack}
          accessibilityRole="link"
          dataSet={focusable}
          testID="reset-back-to-login"
          style={styles.footerLink}
        >
          <Text style={[text('bodyS', lang), styles.footerLinkText]}>{copy.backToLogin}</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

/**
 * The envelope in a circle — the design's own SVG, strokes verbatim.
 *
 * THE CIRCLE IS `brandDeep`, AND THAT IS THE DESIGN'S CHOICE, NOT A CORRECTION:
 * the bundle sets `background: var(--brand-deep)` on this exact element. White
 * strokes on `brand` would be §2's named audit-miss shape ("brand-filled
 * elements whose only white content is an SVG stroke"); the designer did not
 * make that mistake and neither does this.
 *
 * The design enters it with `avozoom` (0.4s scale-in). Under reduced motion the
 * mark renders at rest — §3 removes the animation, never the state change.
 */
function SentMark() {
  const scale = useRef(new Animated.Value(0.6)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    let cancelled = false;
    void AccessibilityInfo.isReduceMotionEnabled().then((reduced) => {
      if (cancelled) return;
      if (reduced) {
        scale.setValue(1);
        opacity.setValue(1);
        return;
      }
      Animated.parallel([
        Animated.spring(scale, {
          toValue: 1,
          speed: 18,
          bounciness: 9,
          useNativeDriver: Platform.OS !== 'web',
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 160,
          useNativeDriver: Platform.OS !== 'web',
        }),
      ]).start();
    });
    return () => {
      cancelled = true;
    };
  }, [scale, opacity]);

  return (
    <Animated.View style={[styles.mark, { transform: [{ scale }], opacity }]}>
      <Svg width={30} height={30} viewBox="0 0 24 24" fill="none">
        <Path d="M4 6h16v12H4z" stroke={WHITE} strokeWidth={1.8} strokeLinejoin="round" />
        <Path
          d="m4 7 8 6 8-6"
          stroke={WHITE}
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Svg>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.surface },
  content: { paddingTop: 96, paddingHorizontal: 24, paddingBottom: 32, flexGrow: 1 },
  title: { textAlign: 'center', color: color.ink },
  sub: { textAlign: 'center', color: color.textMuted, marginTop: 6 },
  field: { gap: 7, marginTop: 28 },
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
  refusalDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: color.dangerDot, flexShrink: 0 },
  refusalText: { color: color.dangerText, flex: 1 },
  submit: { marginTop: 20 },
  footer: { flexDirection: 'row', justifyContent: 'center', marginTop: 20 },
  footerLink: { minHeight: MIN_TAP_TARGET, justifyContent: 'center', paddingHorizontal: 4 },
  // Brand text on a light surface is brandDeep, never brand (#9).
  footerLinkText: { color: color.brandDeep, fontWeight: '600' },

  // ------------------------------------------------------------ sent state --
  sentContent: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  // design: 66px circle, --brand-deep fill — #9's sanctioned white-on-deep.
  mark: {
    width: 66,
    height: 66,
    borderRadius: 33,
    backgroundColor: color.brandDeep,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sentTitle: { color: color.ink, marginTop: 19, textAlign: 'center' },
  sentSub: { color: color.textMuted, marginTop: 7, textAlign: 'center', maxWidth: 260, lineHeight: 20 },
  sentBack: { marginTop: 24, alignSelf: 'stretch' },
});
