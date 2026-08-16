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
 *   unenrolled  the device has no salon/handle/device binding  → EnrolScreen
 *   signed out  it has one, but no session                     → PinScreen
 *   signed in                                                  → ScannerFlow
 */

import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useFonts } from 'expo-font';
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
import { readDeviceBinding, type DeviceBinding } from './src/state/device';
import { SessionProvider, useSession } from './src/state/session';
import { EnrolScreen } from './src/screens/EnrolScreen';
import { PinScreen } from './src/screens/PinScreen';
import { ScannerFlow } from './src/screens/ScannerFlow';

export default function App() {
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
  const { session } = useSession();
  const [binding, setBinding] = useState<DeviceBinding | null>(null);
  const [checked, setChecked] = useState(false);
  const [enrolling, setEnrolling] = useState(false);

  useEffect(() => {
    void readDeviceBinding().then((b) => {
      setBinding(b);
      setChecked(true);
    });
  }, []);

  // Reading one key out of AsyncStorage. A spinner here would flash.
  if (!checked) return <View style={styles.blank} />;

  if (!binding || enrolling) {
    return (
      <>
        <StatusBar style="dark" />
        <EnrolScreen
          initial={binding}
          onDone={(b) => {
            setBinding(b);
            setEnrolling(false);
          }}
        />
      </>
    );
  }

  if (!session) {
    return (
      <>
        <StatusBar style="dark" />
        <PinScreen binding={binding} onReconfigure={() => setEnrolling(true)} />
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
