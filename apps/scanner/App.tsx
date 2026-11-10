/**
 * App shell.
 *
 * Fonts load before anything renders, for the same reason as the wallet: the
 * design's display face is Fraunces and a screen that flashes system-serif
 * before swapping is worse than a beat of blank canvas.
 *
 * NO ARABIC FACE HERE, deliberately. design/README.md § Known gaps 1 — Arabic
 * is the customer app only. The scanner is a staff surface and the bundle
 * writes it in English alone, so there is no language provider and no Plex
 * Arabic (see src/copy/en.ts).
 *
 * THREE STATES, IN ORDER:
 *   unenrolled  the device has no salon/handle/device binding  → SetupFlow
 *   signed out  it has one, but no session                     → PinScreen
 *   signed in                                                  → ScannerFlow
 *
 * SetupFlow is the pairing ruling's (DECISIONS.md § "Staff phone pairing, phone
 * sign-in, and a truthful receipt line — Aftab, 2026-11-10"): scan the pairing
 * code or type number + six digits, choose a PIN, and `POST /staff/pair` both
 * binds the phone and signs her in — so a paired phone goes from the first state
 * straight to the third. The old typed form (EnrolScreen) sits behind it as
 * "Set up manually".
 */

import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useFonts } from 'expo-font';
import * as Linking from 'expo-linking';
import {
  Fraunces_400Regular,
  Fraunces_500Medium,
  Fraunces_600SemiBold,
} from '@expo-google-fonts/fraunces';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from '@expo-google-fonts/inter';
import { StatusBar } from 'expo-status-bar';
import { color } from './src/theme';
import { useBrandRepaint } from './src/theme/live';
import { readDeviceBinding, writeDeviceBinding, type DeviceBinding } from './src/state/device';
import { SessionProvider, useSession } from './src/state/session';
import type { PairedPhone } from './src/api/staff';
import { parsePairingLink } from './src/domain/pairing';
import { PinScreen } from './src/screens/PinScreen';
import { ScannerFlow } from './src/screens/ScannerFlow';
import { SetupFlow } from './src/screens/SetupFlow';

export default function App() {
  /*
    THE SALON'S BRAND, LIVE. When a sign-in's salon read applies the hex,
    `src/theme/live.ts` rebuilds every brand stylesheet in place and bumps this;
    the re-render here reaches every screen, because each is created in this
    tree's render and nothing below is memoised. A repaint, not a re-mount: a
    charge in progress keeps its state.
  */
  useBrandRepaint();
  const [fontsLoaded] = useFonts({
    Fraunces_400Regular,
    Fraunces_500Medium,
    Fraunces_600SemiBold,
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  if (!fontsLoaded) return <View style={styles.blank} />;

  return (
    <SessionProvider>
      <Shell />
    </SessionProvider>
  );
}

function Shell() {
  const { session, adoptPairedSession } = useSession();
  const [binding, setBinding] = useState<DeviceBinding | null>(null);
  const [checked, setChecked] = useState(false);
  /** A bound phone sent back to setup by the PIN screen's muted link. */
  const [settingUp, setSettingUp] = useState(false);
  /** A pairing token from an opened `avostaff://pair?t=…` link, not yet used. */
  const [linkToken, setLinkToken] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const b = await readDeviceBinding();
      /*
        THE LAUNCH LINK, read once, here, and honoured only on an UNBOUND phone —
        the brief: "opened with avostaff://pair?t=… and has no binding, go
        straight to Choose a PIN". A bound phone opened by a pairing link shows
        its PIN screen as always: a link must not silently re-bind a till that
        belongs to someone. She can still choose "Set up this phone" there and
        scan the code in the app. Read here rather than in the setup screen
        because `getInitialURL()` answers the same URL for the life of the
        process, and a screen that mounted later would replay it.

        Anything that is not a pairing link — Expo Go's `exp://`, a payment
        code, null — is nothing here (domain/pairing.ts#parsePairingLink).
      */
      const launch = b ? null : parsePairingLink(await Linking.getInitialURL().catch(() => null));
      setBinding(b);
      setLinkToken(launch);
      setChecked(true);
    })();
  }, []);

  const setupShowing = checked && (!binding || settingUp);

  /*
    A link that arrives WHILE the setup screen is up — the app already open,
    and the staff member scans the manager's QR with the system camera instead
    of the in-app one. Listened for only while setup is showing; signed in, the
    same link reaches ScanScreen's listener, which ignores it (domain/deepLink.ts).
  */
  useEffect(() => {
    if (!setupShowing) return;
    const sub = Linking.addEventListener('url', ({ url }) => {
      const token = parsePairingLink(url);
      if (token !== null) setLinkToken(token);
    });
    return () => sub.remove();
  }, [setupShowing]);

  const takeLinkToken = useCallback(() => setLinkToken(null), []);

  /**
   * A redeemed code: bind the phone, then sign her in — exactly what the PIN
   * screen's success does, minus the PIN she has just chosen twice.
   *
   * The binding is `{ salonId, deviceId, handle: staff.handle }` off the
   * response, the device id being the one the SERVER issued. It is written
   * before anything changes on screen, and then the binding and the session are
   * set in one synchronous run so React draws one frame: setup → scanner, never
   * setup → PIN → scanner.
   *
   * A failed WRITE does not stop her. The code is spent on the server whatever
   * happens here, and refusing to continue would leave her with a used code and
   * no session. The binding is right in memory for this run; if storage really
   * is broken, the next launch opens setup again and a manager issues a new
   * code — the same remedy as any refused one.
   */
  const onPaired = useCallback(
    async (paired: PairedPhone) => {
      try {
        await writeDeviceBinding(paired.binding);
      } catch {
        /* see above */
      }
      setBinding(paired.binding);
      setSettingUp(false);
      setLinkToken(null);
      adoptPairedSession(paired.session);
    },
    [adoptPairedSession],
  );

  // Reading one key out of AsyncStorage. A spinner here would flash.
  if (!checked) return <View style={styles.blank} />;

  if (!binding || settingUp) {
    return (
      <>
        <StatusBar style="dark" />
        <SetupFlow
          binding={binding}
          linkToken={linkToken}
          onLinkTokenTaken={takeLinkToken}
          onPaired={onPaired}
          onManualDone={(b) => {
            setBinding(b);
            setSettingUp(false);
          }}
          onCancel={binding ? () => setSettingUp(false) : undefined}
        />
      </>
    );
  }

  if (!session) {
    return (
      <>
        <StatusBar style="dark" />
        <PinScreen binding={binding} onReconfigure={() => setSettingUp(true)} />
      </>
    );
  }

  return (
    <>
      {/*
        Dark bar content is the default because every screen but one is light.
        The scan screen is the exception and sets its own — see ScanScreen.
      */}
      <StatusBar style="dark" />
      <ScannerFlow />
    </>
  );
}

const styles = StyleSheet.create({
  blank: { flex: 1, backgroundColor: color.canvas },
});
