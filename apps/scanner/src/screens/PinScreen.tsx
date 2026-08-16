/**
 * PIN sign-in — design/AVO Staff Scanner.dc.html:72-88.
 *
 * Four things this screen has to get right that the prototype does not model,
 * because the prototype accepts any four digits (:53) and never talks to a
 * server:
 *
 * 1. **The physical keyboard.** interaction-spec.md §2: "The 4-digit PIN pad
 *    must accept physical keyboard digits and Backspace." See the hidden input
 *    below for how, and why it is not a software keyboard.
 *
 * 2. **The lockout, shown properly.** The API rate-limits per device and locks
 *    the account after `PIN_MAX_ATTEMPTS` failures, and the two are different
 *    refusals with different remedies:
 *      429 pin_locked        — the account is locked; a manager unlocks it
 *      429 too_many_attempts — this device is throttled; wait
 *      401 invalid_credentials — wrong PIN, wrong handle, or wrong device
 *    Collapsing them into "something went wrong" would leave a stylist tapping
 *    at a locked account with no idea who can help her.
 *
 * 3. **The PIN never persists.** It lives in component state, is sent, and is
 *    cleared. Non-negotiable #6.
 *
 * 4. **No enumeration help.** The API deliberately answers the same way for a
 *    wrong PIN, an unknown handle and a right PIN on the wrong device
 *    (api/src/routes/auth.ts). This screen shows the API's message verbatim and
 *    does not try to be more helpful than the server chose to be.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type NativeSyntheticEvent,
  type TextInputKeyPressEventData,
} from 'react-native';
import { ApiError } from '../api/client';
import { copy } from '../copy/en';
import { brand } from '../config/brand';
import { useSession } from '../state/session';
import type { DeviceBinding } from '../state/device';
import { color, display, MIN_TAP_TARGET, radius, ui } from '../theme';
import { LinkButton } from '../components/Buttons';

const PIN_LENGTH = 4;

/**
 * design:589 — `rgba(28,27,25,0.04)`, the keypad key fill.
 * TOKEN GAP (reported): the token file's lightest neutral is `hairlineInner`
 * at 0.06; there is no name for 0.04.
 */
const KEYPAD_FILL = 'rgba(28,27,25,0.04)';
/** design:587 — the empty PIN dot's border. */
const DOT_EMPTY_BORDER = 'rgba(28,27,25,0.25)';

type Refusal =
  | { kind: 'wrong'; message: string }
  | { kind: 'locked'; message: string }
  | { kind: 'throttled'; message: string }
  | { kind: 'offline'; message: string }
  | { kind: 'server'; message: string; reference: string };

export function PinScreen({
  binding,
  onReconfigure,
}: {
  binding: DeviceBinding;
  onReconfigure: () => void;
}) {
  const { signInWithPin } = useSession();
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const hiddenInput = useRef<TextInput>(null);
  const submitting = useRef(false);

  const submit = useCallback(
    async (value: string) => {
      if (submitting.current) return;
      submitting.current = true;
      setBusy(true);
      try {
        await signInWithPin({
          salonId: binding.salonId,
          deviceId: binding.deviceId,
          handle: binding.handle,
          pin: value,
        });
        // On success this screen unmounts. Nothing to clear.
      } catch (err) {
        setPin('');
        if (err instanceof ApiError) {
          if (err.code === 'pin_locked') {
            setRefusal({ kind: 'locked', message: err.message });
          } else if (err.code === 'too_many_attempts') {
            setRefusal({ kind: 'throttled', message: err.message });
          } else if (err.kind === 'offline') {
            setRefusal({ kind: 'offline', message: copy.offlineTitle });
          } else if (err.kind === 'refused') {
            setRefusal({ kind: 'wrong', message: err.message });
          } else {
            setRefusal({ kind: 'server', message: err.message, reference: err.reference });
          }
        } else {
          setRefusal({ kind: 'wrong', message: copy.pinWrong });
        }
      } finally {
        submitting.current = false;
        setBusy(false);
      }
    },
    [binding, signInWithPin],
  );

  // The design submits as soon as the fourth digit lands (:519-521): there is no
  // confirm button on this screen, and adding one would be a redesign.
  useEffect(() => {
    if (pin.length === PIN_LENGTH && !submitting.current) void submit(pin);
  }, [pin, submit]);

  const press = useCallback((digit: string) => {
    setRefusal(null);
    setPin((p) => (p.length >= PIN_LENGTH ? p : p + digit));
  }, []);

  const del = useCallback(() => {
    setRefusal(null);
    setPin((p) => p.slice(0, -1));
  }, []);

  /**
   * PHYSICAL KEYBOARD SUPPORT — interaction-spec.md §2.
   *
   * React Native has no global key handler on iOS, so the accepted way to reach
   * a hardware keyboard is a focused TextInput. This one is present and focused
   * but visually empty and zero-sized, and crucially it sets
   * `showSoftInputOnFocus={false}`: the ON-SCREEN keyboard must never appear,
   * because the designed keypad IS the on-screen keyboard. A Bluetooth keyboard
   * (or the simulator's hardware keyboard) types straight into it.
   *
   * `onChangeText` handles digits; `onKeyPress` handles Backspace, which does
   * not always produce a change event when the field is already empty.
   */
  const onHardwareText = useCallback((value: string) => {
    const digits = value.replace(/\D/g, '').slice(0, PIN_LENGTH);
    setRefusal(null);
    setPin(digits);
  }, []);

  const onHardwareKey = useCallback(
    (e: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      if (e.nativeEvent.key === 'Backspace') del();
    },
    [del],
  );

  const locked = refusal?.kind === 'locked' || refusal?.kind === 'throttled';

  return (
    <View style={styles.screen}>
      <TextInput
        ref={hiddenInput}
        value={pin}
        onChangeText={onHardwareText}
        onKeyPress={onHardwareKey}
        keyboardType="number-pad"
        showSoftInputOnFocus={false}
        caretHidden
        autoFocus
        maxLength={PIN_LENGTH}
        editable={!busy && !locked}
        style={styles.hiddenInput}
        // The visible dots carry the meaning; this input is a keyboard sink.
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        testID="pin-hardware-input"
      />

      <View style={styles.brandBlock}>
        <View style={styles.logo}>
          <Text style={[display(22, '600'), styles.logoText]}>{brand.initial}</Text>
        </View>
        <View style={styles.centre}>
          <Text style={display(21)}>{brand.salonName}</Text>
          <Text style={[ui(12.5), styles.subtitle]}>{copy.pinSubtitle}</Text>
        </View>
      </View>

      <Text style={[ui(14), styles.prompt]}>{copy.pinPrompt}</Text>

      <View
        style={styles.dots}
        accessible
        accessibilityRole="text"
        accessibilityLabel={`PIN, ${pin.length} of ${PIN_LENGTH} digits entered`}
      >
        {Array.from({ length: PIN_LENGTH }, (_, i) => (
          <View key={i} style={[styles.dot, i < pin.length ? styles.dotOn : styles.dotOff]} />
        ))}
      </View>

      {/*
        The refusal. A locked account gets a title and the remedy; a wrong PIN
        gets one line. Both are announced, because a stylist looking at the
        keypad will not see a message appear above it.
      */}
      {refusal && (
        <View
          style={[styles.refusal, locked && styles.refusalStrong]}
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          testID="pin-refusal"
        >
          {locked && (
            <Text style={[ui(13.5, '600'), styles.refusalTitle]}>
              {refusal.kind === 'locked' ? copy.pinLockedTitle : copy.pinTooManyTitle}
            </Text>
          )}
          <Text style={[ui(12.5), styles.refusalText]}>{refusal.message}</Text>
          {refusal.kind === 'server' && (
            <Text style={[ui(11.5), styles.refusalRef]}>{copy.reference(refusal.reference)}</Text>
          )}
        </View>
      )}

      <View style={styles.keypad}>
        {['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'].map((key, i) => {
          if (key === '') return <View key={`gap-${i}`} style={styles.key} />;
          const isDel = key === 'del';
          return (
            <Pressable
              key={key}
              onPress={isDel ? del : () => press(key)}
              disabled={busy || locked}
              accessibilityRole="button"
              accessibilityLabel={isDel ? 'Delete' : key}
              testID={isDel ? 'pin-del' : `pin-${key}`}
              style={({ pressed }) => [
                styles.key,
                !isDel && styles.keyFilled,
                pressed && styles.keyPressed,
                (busy || locked) && styles.keyDisabled,
              ]}
            >
              <Text style={isDel ? [ui(22), styles.keyGlyph] : [display(25), styles.keyGlyph]}>
                {isDel ? '⌫' : key}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <Text style={[ui(11.5), styles.footnote]}>{copy.pinFootnote}</Text>

      {/*
        Re-enrolment. Not on the design, and deliberately understated: it is how
        a phone moved between salons or staff is re-bound, and it clears the
        binding rather than editing it in place. See state/device.ts.
      */}
      <View style={styles.reconfigure}>
        <LinkButton label={copy.enrolChange} onPress={onReconfigure} muted testID="pin-enrol" />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // design:73 — padding 74/26/30, on the light surface.
  screen: {
    flex: 1,
    backgroundColor: color.surface,
    paddingTop: 74,
    paddingHorizontal: 26,
    paddingBottom: 30,
  },
  hiddenInput: { position: 'absolute', width: 1, height: 1, opacity: 0, top: 0, left: 0 },
  brandBlock: { alignItems: 'center', gap: 12 },
  logo: {
    width: 44,
    height: 44,
    borderRadius: 13,
    backgroundColor: color.brandDeep,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoText: { color: color.white },
  centre: { alignItems: 'center' },
  subtitle: { color: color.textMuted, marginTop: 2 },
  prompt: { color: color.textMutedLabel, textAlign: 'center', marginTop: 38 },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 16, marginTop: 18 },
  dot: { width: 13, height: 13, borderRadius: 7 },
  dotOn: { backgroundColor: color.brand },
  dotOff: { borderWidth: 1.5, borderColor: DOT_EMPTY_BORDER },
  refusal: {
    marginTop: 20,
    alignSelf: 'center',
    maxWidth: 300,
    backgroundColor: color.dangerBg,
    borderRadius: radius.chip,
    paddingVertical: 11,
    paddingHorizontal: 14,
  },
  refusalStrong: { backgroundColor: color.warnBg },
  refusalTitle: { color: color.warnText, marginBottom: 3, textAlign: 'center' },
  refusalText: { color: color.dangerText, textAlign: 'center', lineHeight: 18 },
  refusalRef: { color: color.textMutedSoft, textAlign: 'center', marginTop: 5 },
  // design:83 — 3 columns, gap 10, max 280 wide, pinned to the bottom.
  keypad: {
    marginTop: 'auto',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    maxWidth: 280,
    width: '100%',
    alignSelf: 'center',
  },
  key: {
    // (280 - 2 gaps of 10) / 3
    width: 86.66,
    height: 58,
    minHeight: MIN_TAP_TARGET,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyFilled: { backgroundColor: KEYPAD_FILL },
  keyPressed: { opacity: 0.55 },
  keyDisabled: { opacity: 0.4 },
  keyGlyph: { color: color.ink },
  // design:86 — the footnote sits under the keypad. The re-enrolment link is
  // below it again and needs its own room: at 44pt the link's touch target
  // overlapped the footnote's text in the first simulator run.
  footnote: { color: color.textMutedSoft, textAlign: 'center', marginTop: 22 },
  reconfigure: { alignItems: 'center', marginTop: 16 },
});
