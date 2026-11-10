/**
 * Before anyone signs in on this phone: which setup screen is showing.
 *
 * DECISIONS.md § "Staff phone pairing, phone sign-in, and a truthful receipt
 * line — Aftab, 2026-11-10". A hand-rolled switch for the reason ScannerFlow is
 * one: three screens, a short linear path, and no back-gesture model wanted.
 *
 *   setup   SetupScreen     scan the pairing code, or type number + six digits
 *   pin     ChoosePinScreen choose a PIN twice; POST /staff/pair
 *   manual  EnrolScreen     the old typed binding, for the seeded pilot only
 *
 * A pairing LINK (`avostaff://pair?t=…`, from the system camera or a message)
 * skips straight to `pin` with its token — the shell decides when a link counts
 * (App.tsx) and hands the token down once.
 *
 * WHERE A FAILED PAIRING LEAVES HER is decided by the refusal, not the screen:
 * `pairing_refused` and a 429 come back here with the sentence on show, to the
 * method she used — the typed form keeps her number, so only the new code needs
 * typing. Anything a retry could fix (offline, a server fault) keeps her on the
 * PIN pad with the code intact. domain/pairing.ts § pairingRefusal.
 */

import { useEffect, useState } from 'react';
import type { PairedPhone } from '../api/staff';
import type { EndedPairing } from '../domain/pairing';
import type { DeviceBinding } from '../state/device';
import { ChoosePinScreen, type PairingCredential } from './ChoosePinScreen';
import { EnrolScreen } from './EnrolScreen';
import { SetupScreen, type SetupMode } from './SetupScreen';

type Step =
  | { name: 'setup'; mode: SetupMode; phone: string; notice: EndedPairing | null }
  | { name: 'pin'; credential: PairingCredential }
  | { name: 'manual' };

const START: Step = { name: 'setup', mode: 'start', phone: '', notice: null };

export function SetupFlow({
  binding,
  linkToken,
  onLinkTokenTaken,
  onPaired,
  onManualDone,
  onCancel,
}: {
  /** The phone's current binding, if it has one — pre-fills the manual form. */
  binding: DeviceBinding | null;
  /** A pairing token from an opened link, waiting to be used. */
  linkToken: string | null;
  onLinkTokenTaken: () => void;
  onPaired: (paired: PairedPhone) => Promise<void>;
  onManualDone: (binding: DeviceBinding) => void;
  /** Back to the PIN screen. Only when there is a binding to go back to. */
  onCancel?: (() => void) | undefined;
}) {
  const [step, setStep] = useState<Step>(START);
  /*
    Bumped on every step change and used as the screen's key, so each visit
    starts from its props — the setup screen re-reads `mode` and `phone`, and a
    new credential (a second link arriving on the PIN step) gets a fresh pad
    rather than the last attempt's half-typed PIN.
  */
  const [seq, setSeq] = useState(0);

  const toSetup = (mode: SetupMode, phone: string, notice: EndedPairing | null) => {
    setSeq((n) => n + 1);
    setStep({ name: 'setup', mode, phone, notice });
  };

  const toPin = (credential: PairingCredential) => {
    setSeq((n) => n + 1);
    setStep({ name: 'pin', credential });
  };

  useEffect(() => {
    if (linkToken === null) return;
    setSeq((n) => n + 1);
    setStep({ name: 'pin', credential: { token: linkToken } });
    onLinkTokenTaken();
  }, [linkToken, onLinkTokenTaken]);

  if (step.name === 'manual') {
    return (
      <EnrolScreen
        initial={binding}
        onDone={onManualDone}
        onBack={() => toSetup('start', '', null)}
      />
    );
  }

  if (step.name === 'pin') {
    const { credential } = step;
    // A typed attempt goes back to the typed form with her number still in it;
    // a scanned or linked one goes back to the two choices.
    const back = (notice: EndedPairing | null) =>
      'phone' in credential ? toSetup('typed', credential.phone, notice) : toSetup('start', '', notice);
    return (
      <ChoosePinScreen
        key={seq}
        credential={credential}
        onPaired={onPaired}
        onEnded={back}
        onBack={() => back(null)}
      />
    );
  }

  return (
    <SetupScreen
      key={seq}
      initialMode={step.mode}
      initialPhone={step.phone}
      notice={step.notice}
      onCredential={toPin}
      onManual={() => setStep({ name: 'manual' })}
      onCancel={onCancel}
    />
  );
}
