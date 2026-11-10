/**
 * Choose a PIN — the last step of pairing a phone. NOT A DESIGNED SCREEN.
 *
 * DECISIONS.md § "Staff phone pairing, phone sign-in, and a truthful receipt
 * line — Aftab, 2026-11-10". The code has been read (QR, link, or mobile number
 * and six digits); here the staff member chooses her own four digits, twice,
 * and the phone redeems the code with them in ONE request — `POST /staff/pair`.
 * The server claims the code, issues the device id, stores the PIN's hash
 * against it and answers with a scanner session, so on success she lands in
 * the scanner without typing the PIN a third time.
 *
 * Deliberately plain: no design exists, so it is the PIN screen's keypad
 * (components/PinPad.tsx, the same values) under a title and one prompt line,
 * in the app's tokens. English only (design/README.md § Known gaps 1).
 *
 * WHAT THIS SCREEN DOES NOT DO, ON PURPOSE:
 *
 *  - It does not call `reportFailure`. There is no session yet; this is a door,
 *    like PinScreen, and a dead-session drop would be circular.
 *  - It does not explain a refusal. The server answers every refusal with one
 *    body so the endpoint cannot be used to learn which numbers are staff, and
 *    the screen does not try to be more helpful than the server chose to be
 *    (PinScreen's stance on `invalid_credentials`). See domain/pairing.ts
 *    § pairingRefusal for every branch and where each one leaves her.
 *  - It does not keep the PIN. Component state only, sent once, dropped on
 *    every failure (non-negotiable #6).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { pairPhone, type PairedPhone, type StaffPairRequest } from '../api/staff';
import { copy } from '../copy/en';
import {
  PIN_CHOICE_START,
  chosenPin,
  pairingRefusal,
  pinChoiceStage,
  refusalEndsPairing,
  stepPinChoice,
  type EndedPairing,
  type PairingRefusal,
  type PinChoiceInput,
} from '../domain/pairing';
import { color, display, radius, ui } from '../theme';
import { LinkButton } from '../components/Buttons';
import { PinDots, PinPad } from '../components/PinPad';
import { brandedStyles } from '../theme/branded';

/** What the code was read as. The PIN is added here, and only here. */
export type PairingCredential = { token: string } | { phone: string; code: string };

export function ChoosePinScreen({
  credential,
  onPaired,
  onEnded,
  onBack,
}: {
  credential: PairingCredential;
  /** Writes the binding and starts the session. Awaited, so a slow write keeps the pad busy. */
  onPaired: (paired: PairedPhone) => Promise<void>;
  /** `pairing_refused` or a 429: back to setup, with the sentence to show there. */
  onEnded: (refusal: EndedPairing) => void;
  onBack: () => void;
}) {
  const [choice, setChoice] = useState(PIN_CHOICE_START);
  const [busy, setBusy] = useState(false);
  /** A failure that keeps her on the pad: offline, a server fault, a bad format. */
  const [problem, setProblem] = useState<PairingRefusal | null>(null);
  const submitting = useRef(false);

  const submit = useCallback(
    async (pin: string) => {
      if (submitting.current) return;
      submitting.current = true;
      setBusy(true);
      try {
        const request: StaffPairRequest = { ...credential, pin };
        const paired = await pairPhone(request);
        /*
          On success the shell swaps this screen for the scanner. The latch is
          deliberately NOT released: the code is spent, and the matched PIN is
          still in `choice` until the swap renders, so an open latch would let
          the effect below send it again on any re-render in between.
        */
        await onPaired(paired);
      } catch (err) {
        const refusal = pairingRefusal(err);
        // The PIN goes in every failure branch, before anything else.
        setChoice(PIN_CHOICE_START);
        submitting.current = false;
        setBusy(false);
        if (refusalEndsPairing(refusal)) {
          onEnded(refusal);
          return;
        }
        setProblem(refusal);
      }
    },
    [credential, onPaired, onEnded],
  );

  // Submits the moment the second entry matches, as PinScreen submits on the
  // fourth digit (design:519-521) — no confirm button to add.
  useEffect(() => {
    const pin = chosenPin(choice);
    if (pin !== null && !submitting.current) void submit(pin);
  }, [choice, submit]);

  const apply = useCallback((input: PinChoiceInput) => {
    setProblem(null);
    setChoice((s) => stepPinChoice(s, input));
  }, []);

  const stage = pinChoiceStage(choice);

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <LinkButton label={copy.setupBack} onPress={onBack} muted testID="pairpin-back" />
      </View>

      <View style={styles.centre}>
        <Text style={display(21)}>{copy.pairPinTitle}</Text>
        <Text style={[ui(14), styles.prompt]} accessibilityLiveRegion="polite">
          {stage === 'choose' ? copy.pairPinChoose : copy.pairPinConfirm}
        </Text>
      </View>

      <PinDots filled={choice.entry.length} />

      {choice.mismatch && (
        <View style={styles.notice} accessibilityRole="alert" testID="pairpin-mismatch">
          <Text style={[ui(12.5), styles.noticeText]}>{copy.pairPinMismatch}</Text>
        </View>
      )}

      {problem && (
        <View style={styles.notice} accessibilityRole="alert" testID="pairpin-problem">
          <Text style={[ui(12.5), styles.noticeText]}>{problem.message}</Text>
          {problem.kind === 'server' && problem.reference !== null && (
            <Text style={[ui(11.5), styles.noticeRef]}>{copy.reference(problem.reference)}</Text>
          )}
        </View>
      )}

      <PinPad
        value={choice.entry}
        disabled={busy}
        onDigit={(digit) => apply({ type: 'digit', digit })}
        onDelete={() => apply({ type: 'delete' })}
        onHardwareText={(value) => apply({ type: 'replace', value })}
        testIDPrefix="pairpin"
      />
    </View>
  );
}

const styles = brandedStyles(() => ({
  // PinScreen's frame — design:73, padding 74/26/30 on the light surface —
  // less the top, which the back link takes.
  screen: {
    flex: 1,
    backgroundColor: color.surface,
    paddingTop: 54,
    paddingHorizontal: 26,
    paddingBottom: 30,
  },
  header: { flexDirection: 'row', alignItems: 'center' },
  centre: { alignItems: 'center', marginTop: 24 },
  prompt: { color: color.textMutedLabel, textAlign: 'center', marginTop: 10 },
  // PinScreen's refusal box, the same tokens.
  notice: {
    marginTop: 20,
    alignSelf: 'center',
    maxWidth: 300,
    backgroundColor: color.dangerBg,
    borderRadius: radius.chip,
    paddingVertical: 11,
    paddingHorizontal: 14,
  },
  noticeText: { color: color.dangerText, textAlign: 'center', lineHeight: 18 },
  noticeRef: { color: color.textMutedSoft, textAlign: 'center', marginTop: 5 },
}));
