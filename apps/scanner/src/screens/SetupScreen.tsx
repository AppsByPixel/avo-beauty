/**
 * Set up this phone — NOT A DESIGNED SCREEN.
 *
 * DECISIONS.md § "Staff phone pairing, phone sign-in, and a truthful receipt
 * line — Aftab, 2026-11-10", ruling 1. A fresh phone (no device binding) opens
 * here, and so does a bound one whose PIN-screen link was tapped. Two ways in,
 * in the ruling's order, because a camera does not always cooperate:
 *
 *   1. Scan the pairing code — the manager's QR, `${STAFF_PAIRING_URL}?t=<token>`.
 *   2. Enter mobile number and code — her own number and the six digits shown
 *      under the QR. A number alone is never enough; it is not a secret.
 *
 * Either one hands a credential to ChoosePinScreen, which redeems it. Nothing on
 * this screen talks to the server: the camera and the form only READ a code, and
 * domain/pairing.ts decides whether what they read is one.
 *
 * The old typed binding form (EnrolScreen) survives only as the muted
 * "Set up manually" link at the bottom, for the seeded pilot.
 *
 * Deliberately plain: no design exists, so it is the app's tokens and existing
 * components (Buttons, the EnrolScreen field style, PinScreen's notice box) and
 * nothing invented visually. English only (design/README.md § Known gaps 1).
 *
 * THE CAMERA, BEFORE SIGN-IN. Until now the camera mounted only inside the
 * signed-in flow (ScanScreen). Here it mounts before any session, reads only a
 * pairing code, and QUIETLY ignores everything else — a customer's wallet code
 * included. Unlike ScanScreen there is no "That isn't an AVO wallet code": a
 * stylist setting up her phone in a busy salon has no use for a sentence about
 * whatever else drifted past the lens.
 */

import { useCallback, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { STAFF_PAIRING_TTL_MINUTES } from '@avo/types';
import { copy } from '../copy/en';
import {
  isPairingDigits,
  normaliseStaffPhone,
  parsePairingLink,
  type EndedPairing,
} from '../domain/pairing';
import { color, display, radius, ui } from '../theme';
import { LinkButton, PrimaryButton, SecondaryButton } from '../components/Buttons';
import { brandedStyles } from '../theme/branded';
import type { PairingCredential } from './ChoosePinScreen';

export type SetupMode = 'start' | 'scan' | 'typed';

/** ScanScreen's frame size, reused: the one camera box this app already draws. */
const FRAME = 240;

export function SetupScreen({
  initialMode = 'start',
  initialPhone = '',
  notice,
  onCredential,
  onManual,
  onCancel,
}: {
  initialMode?: SetupMode;
  /** Kept when a typed attempt is refused, so only the code needs typing again. */
  initialPhone?: string;
  /** Why she is back here: the code was refused, or the attempt budget is spent. */
  notice: EndedPairing | null;
  onCredential: (credential: PairingCredential) => void;
  onManual: () => void;
  /** Present only when the phone already has a binding to go back to. */
  onCancel?: (() => void) | undefined;
}) {
  const [mode, setMode] = useState<SetupMode>(initialMode);
  // The refusal belongs to the attempt that earned it. Moving on clears it.
  const [showNotice, setShowNotice] = useState(true);
  const go = (next: SetupMode) => {
    setShowNotice(false);
    setMode(next);
  };

  if (mode === 'scan') {
    return (
      <PairingCamera
        onToken={(token) => onCredential({ token })}
        onBack={() => go('start')}
        onTyped={() => go('typed')}
      />
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
      <View style={styles.header}>
        {mode === 'typed' ? (
          <LinkButton label={copy.setupBack} onPress={() => go('start')} muted testID="setup-back" />
        ) : onCancel ? (
          <LinkButton label={copy.setupBackToSignIn} onPress={onCancel} muted testID="setup-cancel" />
        ) : null}
      </View>

      <Text style={display(24)}>{copy.setupTitle}</Text>
      <Text style={[ui(12.5), styles.body]}>{copy.setupBody(STAFF_PAIRING_TTL_MINUTES)}</Text>

      {notice && showNotice && <Notice notice={notice} />}

      {mode === 'start' ? (
        <View style={styles.choices}>
          <PrimaryButton
            label={copy.setupScan}
            onPress={() => go('scan')}
            testID="setup-scan"
          />
          <SecondaryButton
            label={copy.setupTyped}
            onPress={() => go('typed')}
            testID="setup-typed"
          />
        </View>
      ) : (
        <TypedCode
          initialPhone={initialPhone}
          onSubmit={(phone, code) => onCredential({ phone, code })}
        />
      )}

      {/* The old typed form, for the seeded pilot only. Muted, at the bottom. */}
      <View style={styles.manual}>
        <LinkButton label={copy.setupManual} onPress={onManual} muted testID="setup-manual" />
      </View>
    </ScrollView>
  );
}

/** PinScreen's refusal box: a title for a 429, one line for a refused code. */
function Notice({ notice }: { notice: EndedPairing }) {
  const throttled = notice.kind === 'throttled';
  return (
    <View
      style={[styles.notice, throttled && styles.noticeStrong]}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      testID="setup-notice"
    >
      {notice.kind === 'throttled' && (
        <Text style={[ui(13.5, '600'), styles.noticeTitle]}>{notice.title}</Text>
      )}
      <Text style={[ui(12.5), styles.noticeText]}>{notice.message}</Text>
    </View>
  );
}

// -------------------------------------------------------- the typed path --

function TypedCode({
  initialPhone,
  onSubmit,
}: {
  initialPhone: string;
  onSubmit: (phone: string, code: string) => void;
}) {
  const [phone, setPhone] = useState(initialPhone);
  const [code, setCode] = useState('');
  const normalised = normaliseStaffPhone(phone);
  const ready = normalised !== null && isPairingDigits(code);

  return (
    <View>
      <View style={styles.field}>
        <Text style={[ui(11, '600'), styles.label]}>{copy.setupPhoneLabel.toUpperCase()}</Text>
        <TextInput
          value={phone}
          onChangeText={setPhone}
          keyboardType="phone-pad"
          textContentType="telephoneNumber"
          autoComplete="tel"
          autoCorrect={false}
          accessibilityLabel={copy.setupPhoneLabel}
          accessibilityHint={copy.setupPhoneHint}
          testID="setup-phone"
          style={[ui(15), styles.input]}
        />
        <Text style={[ui(11.5), styles.hint]}>{copy.setupPhoneHint}</Text>
      </View>
      <View style={styles.field}>
        <Text style={[ui(11, '600'), styles.label]}>{copy.setupCodeLabel.toUpperCase()}</Text>
        <TextInput
          value={code}
          onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))}
          keyboardType="number-pad"
          textContentType="oneTimeCode"
          autoComplete="one-time-code"
          autoCorrect={false}
          maxLength={6}
          accessibilityLabel={copy.setupCodeLabel}
          testID="setup-code"
          style={[ui(15), styles.input, styles.codeInput]}
        />
      </View>
      <PrimaryButton
        label={copy.setupContinue}
        onPress={() => {
          if (normalised !== null && ready) onSubmit(normalised, code);
        }}
        disabled={!ready}
        style={styles.action}
        testID="setup-continue"
      />
    </View>
  );
}

// ------------------------------------------------------ the camera path --

/**
 * The camera, reading pairing codes only.
 *
 * The latch is ScanScreen's: a QR in frame fires `onBarcodeScanned` many times a
 * second, and without it one code would push the PIN step several times. It
 * latches on the first PAIRING code only — anything else leaves it open, so a
 * wallet code drifting past first does not stop the real one being read.
 */
function PairingCamera({
  onToken,
  onBack,
  onTyped,
}: {
  onToken: (token: string) => void;
  onBack: () => void;
  onTyped: () => void;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  // Fresh on every mount: Back then Scan again remounts this, and reads anew.
  const handled = useRef(false);

  const read = useCallback(
    (raw: string) => {
      if (handled.current) return;
      const token = parsePairingLink(raw);
      if (token === null) return; // not a pairing code — keep looking, say nothing
      handled.current = true;
      onToken(token);
    },
    [onToken],
  );

  const granted = permission?.granted === true;

  return (
    <View style={[styles.screen, styles.cameraScreen]}>
      <View style={styles.header}>
        <LinkButton label={copy.setupBack} onPress={onBack} muted testID="setup-scan-back" />
      </View>

      <Text style={display(24)}>{copy.setupScan}</Text>
      <Text style={[ui(12.5), styles.body]}>{copy.setupScanPrompt}</Text>

      <View style={styles.frame} testID="setup-camera-frame">
        {granted && (
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={({ data }) => read(data)}
          />
        )}
      </View>

      {/* Camera permission — ScanScreen's honest minimum, with this screen's way out. */}
      {permission && !granted && (
        <View style={styles.permission} testID="setup-camera-permission">
          <Text style={[ui(14, '600'), styles.permissionTitle]}>{copy.cameraDenied}</Text>
          <Text style={[ui(12.5), styles.body, styles.centred]}>{copy.setupCameraDeniedBody}</Text>
          {permission.canAskAgain && (
            <PrimaryButton
              label={copy.cameraAsk}
              onPress={() => void requestPermission()}
              style={styles.permissionAction}
              testID="setup-camera-ask"
            />
          )}
        </View>
      )}

      <SecondaryButton
        label={copy.setupTyped}
        onPress={onTyped}
        style={styles.action}
        testID="setup-scan-typed"
      />
    </View>
  );
}

const styles = brandedStyles(() => ({
  // EnrolScreen's frame: the light surface, padding 74/26/40 — less the top,
  // which the back link takes.
  screen: {
    flexGrow: 1,
    backgroundColor: color.surface,
    paddingTop: 54,
    paddingHorizontal: 26,
    paddingBottom: 40,
  },
  cameraScreen: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', minHeight: 20, marginBottom: 20 },
  body: { color: color.textMuted, marginTop: 6, lineHeight: 19 },
  centred: { textAlign: 'center' },
  choices: { marginTop: 30, gap: 12 },
  notice: {
    marginTop: 20,
    backgroundColor: color.dangerBg,
    borderRadius: radius.chip,
    paddingVertical: 11,
    paddingHorizontal: 14,
  },
  noticeStrong: { backgroundColor: color.warnBg },
  noticeTitle: { color: color.warnText, marginBottom: 3 },
  noticeText: { color: color.dangerText, lineHeight: 18 },
  // EnrolScreen's field, the same tokens.
  field: { marginTop: 20 },
  label: { color: color.textMutedLabel, letterSpacing: 0.9, marginBottom: 7 },
  input: {
    borderWidth: 1,
    borderColor: color.borderControl,
    borderRadius: radius.input,
    backgroundColor: color.white,
    paddingHorizontal: 16,
    paddingVertical: 15,
    color: color.ink,
  },
  codeInput: { letterSpacing: 4 },
  hint: { color: color.textMutedSoft, marginTop: 6, lineHeight: 16 },
  action: { marginTop: 30 },
  frame: {
    width: FRAME,
    height: FRAME,
    alignSelf: 'center',
    marginTop: 30,
    borderRadius: 26,
    borderWidth: 1,
    borderColor: color.borderControl,
    backgroundColor: color.white,
    overflow: 'hidden',
  },
  permission: { alignItems: 'center', marginTop: 20 },
  permissionTitle: { color: color.ink, textAlign: 'center' },
  permissionAction: { marginTop: 14, alignSelf: 'stretch' },
  manual: { alignItems: 'center', marginTop: 'auto', paddingTop: 30 },
}));
