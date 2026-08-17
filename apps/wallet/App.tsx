/**
 * App shell.
 *
 * Fonts are loaded before anything renders. The design's display face is
 * Fraunces and its UI face is Inter (design/tokens/avo-tokens.json → font), and
 * a wallet card that flashes system-serif before swapping is worse than a beat
 * of blank canvas.
 *
 * IBM PLEX SANS ARABIC IS LOADED UNCONDITIONALLY, not on the language switch.
 *
 * Loading it lazily would mean the first Arabic frame renders in whatever the OS
 * substitutes and swaps a moment later — and a silent system substitution is
 * exactly the failure this is meant to prevent. It is four weights against a
 * one-off cost at startup, and the switch has to be instant on web because on
 * web it is instant (see src/i18n/language.tsx).
 *
 * `useFonts` returns true only once every named face has actually registered, so
 * a missing Arabic face fails visibly at startup rather than quietly falling back
 * at the moment somebody switches language.
 */

import { useFonts } from 'expo-font';
import {
  Fraunces_400Regular,
  Fraunces_400Regular_Italic,
  Fraunces_500Medium,
  Fraunces_600SemiBold,
} from '@expo-google-fonts/fraunces';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from '@expo-google-fonts/inter';
import {
  IBMPlexSansArabic_400Regular,
  IBMPlexSansArabic_500Medium,
  IBMPlexSansArabic_600SemiBold,
  IBMPlexSansArabic_700Bold,
} from '@expo-google-fonts/ibm-plex-sans-arabic';
import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { View, StyleSheet } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { color } from './src/theme';
import { installFocusRing } from './src/theme/focus';
import { SNAPSHOT_KEY } from './src/state/cache';
import { PREFERENCES_KEY } from './src/state/notifications';
import { HomeScreen } from './src/screens/HomeScreen';
import { AccountScreen } from './src/screens/AccountScreen';
import { LanguageProvider } from './src/i18n/language';
import { initialLanguage } from './src/i18n/initialLanguage';

/**
 * The two built screens.
 *
 * NO ROUTER, DELIBERATELY, AND ONLY UNTIL THERE ARE MORE THAN TWO. The design's
 * wallet has five destinations (home, book, shop, pay, account) plus the auth
 * set, and that is a router's job — but installing one to switch between two
 * screens would add a dependency, a navigation container and a set of typed
 * route params to the tree before anything needs them. The seam is this union:
 * when Book and Shop land, this becomes a navigator and the two screens keep
 * their props unchanged.
 */
type Screen = 'home' | 'account';

// interaction-spec.md §2's focus ring, as real CSS. At module scope so the rule
// exists before the first control paints. Idempotent and a no-op off web.
installFocusRing();

export default function App() {
  const [fontsLoaded] = useFonts({
    Fraunces_400Regular,
    Fraunces_400Regular_Italic,
    Fraunces_500Medium,
    Fraunces_600SemiBold,
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    // design/README.md § Typography — "IBM Plex Sans Arabic (400–700)".
    IBMPlexSansArabic_400Regular,
    IBMPlexSansArabic_500Medium,
    IBMPlexSansArabic_600SemiBold,
    IBMPlexSansArabic_700Bold,
  });

  const [screen, setScreen] = useState<Screen>('home');

  if (!fontsLoaded) return <View style={styles.blank} />;

  return (
    <LanguageProvider initial={initialLanguage()}>
      <StatusBar style="dark" />
      {screen === 'home' ? (
        <HomeScreen onOpenAccount={() => setScreen('account')} />
      ) : (
        <AccountScreen
          onBack={() => setScreen('home')}
          /**
           * THERE IS NO SESSION TO END YET, AND THE BUTTON SAYS SO BY DOING THE
           * ONE REAL THING AVAILABLE.
           *
           * The wallet has no auth slice: no login screen, and `api/client.ts`
           * sends no bearer token — it reads an implicitly-authenticated mock.
           * So "log out" cannot revoke anything. What it CAN honestly do is drop
           * the local copies of this customer's data — the cached wallet
           * snapshot and the notification preferences — and return to a cold
           * Home, which is the part of logging out that protects the next person
           * to pick up the phone.
           *
           * When the auth slice lands this also calls POST /auth/sign-out, which
           * already exists on the API. Reported.
           */
          onLogOut={() => {
            void clearLocalState();
            setScreen('home');
          }}
          /**
           * The WhatsApp reset-link flow lives on the auth screens, which are
           * not built. api-contract.md rule 5 is explicit that this is a
           * separate flow and not a bypass of `current`, so it must not quietly
           * unlock the password sheet. Until the reset screen exists it returns
           * to Home rather than pretending to send a link. Reported.
           */
          onForgotPassword={() => setScreen('home')}
        />
      )}
    </LanguageProvider>
  );
}

/**
 * Drops every device-local copy of the customer's data. See `onLogOut`.
 *
 * The keys are imported rather than restated: a cache key that drifts from the
 * module that owns it leaves data behind after a log-out, which is the one
 * failure mode this function exists to prevent.
 */
async function clearLocalState(): Promise<void> {
  try {
    await AsyncStorage.multiRemove([SNAPSHOT_KEY, PREFERENCES_KEY]);
  } catch {
    // Nothing to recover: the screen has already navigated away.
  }
}

const styles = StyleSheet.create({
  blank: { flex: 1, backgroundColor: color.canvas },
});
