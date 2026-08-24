/**
 * The enlarged payment code — design/AVO Wallet Home.dc.html:641-643.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THIS IS THE SAME TOKEN, BIGGER. IT IS NOT A NEW ONE.
 *
 * Non-negotiable #2: the client never mints a QR token. This component takes the
 * `WalletToken` the server issued and the countdown `useWalletToken` derives
 * from the server's `expiresAt`, and renders `token.uri` verbatim — the string
 * the SERVER says the code is written in. It does not refresh, re-derive or
 * extend anything, and opening or closing it has no effect on the token's life.
 *
 * That is the whole point of the fix this component is: `PaymentCode` advertised
 * "Tap to enlarge" and bound the tap to `walletToken.refresh`, so a customer
 * holding her code up to a cashier and tapping to make it bigger silently got a
 * DIFFERENT code — the one on screen a moment earlier being the one the cashier
 * had already started scanning.
 *
 * Reachability is decided in `domain/paymentCode.ts`, not here: `canEnlarge` is
 * false for every state that has no scannable code, offline above all. See that
 * module's header.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ REPORTED, NOT BUILT: `qrBigSub` reads "Screen brightened for scanning" and
 * nothing here raises the screen brightness. Doing so needs `expo-brightness`,
 * a native module that is not in this app's dependency set, and adding one is a
 * bigger decision than a component. The copy is the design's, verbatim, in both
 * languages; the behaviour it names is outstanding. Flagged rather than quietly
 * dropped or quietly depended upon.
 */

import { useEffect, useRef } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import type { WalletToken } from '@avo/types';
import { color, MIN_TAP_TARGET, motion, radius, text, WHITE } from '../theme';
import { useLanguage } from '../i18n/language';
import { toEasternDigits } from '../i18n/digits';
import { useDismissible } from './useDismissible';
import { PulseDot } from './PulseDot';

/** design:643 — `width:246px;height:246px`. A content dimension, not a token. */
const QR_SIZE = 246;

interface Props {
  open: boolean;
  token: WalletToken;
  memberId: string;
  secondsRemaining: number;
  /** Already resolved to the reading language by `salonName()`. */
  salonLabel: string;
  onClose: () => void;
}

export function QrOverlay({
  open,
  token,
  memberId,
  secondsRemaining,
  salonLabel,
  onClose,
}: Props) {
  const { lang, copy } = useLanguage();

  // Always dismissible. The KNET redirect is the ONE non-dismissible layer in
  // this app, and it is non-dismissible because money is live at the bank;
  // nothing is live here beyond a code that expires on its own.
  useDismissible({ open, dismissible: true, onDismiss: onClose, label: copy.qrBig });
  const zoom = useZoomIn(open);

  if (!open) return null;

  // A COUNT, so Eastern in Arabic — the same rule as the panel behind it.
  const seconds = lang === 'ar' ? toEasternDigits(secondsRemaining) : String(secondsRemaining);
  // design:642 renders a logo when the salon has one. `Salon` carries no logo
  // URL in the contract, so the design's own default branch — the initial on a
  // brand-deep square, marked `hint-placeholder-val` — is the only one that can
  // be built. Reported in the lane notes, not invented here.
  const initial = [...salonLabel][0] ?? '';

  return (
    <View style={styles.overlay}>
      {/*
        The backdrop is the design's own dismissal (design:641 binds `closeQr` to
        the scrim). It is a control, so it is announced as one.
      */}
      <Pressable
        style={styles.backdrop}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel={copy.done}
        testID="qr-overlay-backdrop"
      />
      <Animated.View
        style={[styles.card, { opacity: zoom.opacity, transform: [{ scale: zoom.scale }] }]}
        accessibilityViewIsModal
        accessibilityRole="none"
        accessibilityLabel={copy.qrBig}
        testID="qr-overlay"
      >
        <View style={styles.salonRow}>
          <View style={styles.logo}>
            {/*
              `lang` IS LOAD-BEARING HERE AND WAS MISSING FOR ONE DRIVEN RUN.
              The initial is the first character of the SALON's name, so in
              Arabic it is an Arabic letter — and `text('bodyL')` without the
              language resolves to Inter, which has no Arabic glyph. Driven:
              أمارا's أ rendered as a substituted glyph that read as "1" on a
              brand-deep square. src/theme/index.ts documents exactly this trap.
            */}
            <Text style={[text('bodyL', lang), styles.logoInitial]}>{initial}</Text>
          </View>
          <Text style={[text('bodyL', lang), styles.salonName]} numberOfLines={1}>
            {salonLabel}
          </Text>
        </View>

        <Text style={[text('displayM', lang), styles.title]}>{copy.qrBig}</Text>
        <Text style={[text('body', lang), styles.sub]}>{copy.qrBigSub}</Text>

        <View style={styles.qrBox}>
          {/* The SERVER's string. Never re-derived — see the header. */}
          <QRCode value={token.uri} size={QR_SIZE} color={color.ink} backgroundColor={WHITE} />
        </View>

        {/*
          `text('displayM')` with no language: the member id is a Latin
          identifier in both languages and stays in Fraunces, exactly as the
          panel behind it does. design:643 sets `letter-spacing:0.04em` at 24px,
          which is 0.96pt.
        */}
        <Text style={[text('displayM'), styles.memberId]}>
          {copy.memberIdPrefix}
          {'⁦'}
          {memberId}
          {'⁩'}
        </Text>

        {/*
          The countdown is the SERVER's expiry counted down, and it is cosmetic:
          expiry is enforced in POST /scans and POST /charges. Not announced —
          `PaymentCode`'s live region already announces it every 15s, and two
          regions reciting the same number is worse than one.
        */}
        <View style={styles.countdownRow}>
          <PulseDot size={7} durationMs={1400} />
          <Text style={[text('bodyS', lang), styles.countdown]}>
            {copy.qrHint} {seconds}
            {copy.sec}
          </Text>
        </View>

        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          style={styles.doneButton}
          testID="qr-overlay-done"
        >
          <Text style={[text('bodyL', lang), styles.doneText]}>{copy.done}</Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

/**
 * `avozoom` — interaction-spec.md §3 assigns it to "QR enlarge" at 350ms with
 * `cubic-bezier(.2,.9,.3,1.05)`, and both numbers are tokens
 * (`motion.zoom` / `motion.easing`) rather than literals. The design's own
 * markup writes 0.24s inline; the spec table is the authority and is what this
 * follows.
 *
 * Under reduced motion the transform is dropped and only the opacity fade
 * remains — `avo-tokens.json § motion.reducedMotion`: "replace all transforms
 * with opacity fades". §3 removes the animation, never the state change, so the
 * overlay still appears at full size immediately.
 */
function useZoomIn(open: boolean) {
  const scale = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    scale.setValue(0.88);
    opacity.setValue(0);
    void AccessibilityInfo.isReduceMotionEnabled().then((reduced) => {
      if (cancelled) return;
      if (reduced) {
        scale.setValue(1);
        Animated.timing(opacity, {
          toValue: 1,
          duration: Number.parseInt(motion.fast, 10),
          useNativeDriver: Platform.OS !== 'web',
        }).start();
        return;
      }
      const duration = Number.parseInt(motion.zoom, 10);
      const easing = Easing.bezier(0.2, 0.9, 0.3, 1.05);
      Animated.parallel([
        Animated.timing(scale, {
          toValue: 1,
          duration,
          easing,
          useNativeDriver: Platform.OS !== 'web',
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: Number.parseInt(motion.fast, 10),
          useNativeDriver: Platform.OS !== 'web',
        }),
      ]).start();
    });
    return () => {
      cancelled = true;
    };
  }, [open, scale, opacity]);

  return { scale, opacity };
}

/** RN 0.86's typings no longer expose `StyleSheet.absoluteFillObject`. */
const FILL = { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 } as const;

/*
 * Radii come from tokens rather than from the design's raw pixels, per
 * CLAUDE.md. Three land within 2pt rather than exactly: the card is 28 in the
 * design and `radius.sheet` is 26, the QR frame is 18 and `radius.cardLg` is 20,
 * the logo square is 9 and `radius.chip` is 10. The type scale has no 24pt
 * Fraunces step either, so the member id uses `displayM` (23). All four are
 * token gaps rather than deviations worth re-typing a literal for; reported, not
 * fixed here, because `packages/tokens` is trunk-owned.
 */
const styles = StyleSheet.create({
  overlay: { ...FILL, alignItems: 'center', justifyContent: 'center', zIndex: 40 },
  backdrop: { ...FILL, backgroundColor: 'rgba(20,21,17,0.55)' },
  card: {
    width: '100%',
    // design:641 — `padding:26px` on the scrim, so the card insets by that much.
    marginHorizontal: 26,
    maxWidth: 350,
    backgroundColor: WHITE,
    borderRadius: radius.sheet,
    paddingTop: 26,
    paddingHorizontal: 24,
    paddingBottom: 22,
    alignItems: 'center',
  },
  salonRow: { flexDirection: 'row', alignItems: 'center', gap: 9, marginBottom: 10 },
  logo: {
    width: 28,
    height: 28,
    borderRadius: radius.chip,
    // Non-negotiable #9: white text sits on brandDeep, never on brand.
    backgroundColor: color.brandDeep,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoInitial: { color: WHITE, fontWeight: '600' },
  salonName: { color: color.textMutedStrong, flexShrink: 1 },
  title: { color: color.ink, textAlign: 'center' },
  sub: { color: color.textMuted, marginTop: 4, textAlign: 'center' },
  qrBox: {
    width: QR_SIZE,
    height: QR_SIZE,
    maxWidth: '100%',
    marginTop: 22,
    backgroundColor: WHITE,
    borderRadius: radius.cardLg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  memberId: { color: color.ink, marginTop: 18, letterSpacing: 0.96 },
  countdownRow: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 8 },
  countdown: { color: color.textMuted },
  doneButton: {
    width: '100%',
    marginTop: 20,
    minHeight: MIN_TAP_TARGET,
    paddingVertical: 14,
    borderRadius: radius.button,
    backgroundColor: color.surfaceAlt2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  doneText: { color: color.ink, fontWeight: '600' },
});
