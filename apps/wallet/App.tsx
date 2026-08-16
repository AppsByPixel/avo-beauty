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
import { View, StyleSheet } from 'react-native';
import { color } from './src/theme';
import { HomeScreen } from './src/screens/HomeScreen';
import { LanguageProvider } from './src/i18n/language';
import { initialLanguage } from './src/i18n/initialLanguage';

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

  if (!fontsLoaded) return <View style={styles.blank} />;

  return (
    <LanguageProvider initial={initialLanguage()}>
      <StatusBar style="dark" />
      <HomeScreen />
    </LanguageProvider>
  );
}

const styles = StyleSheet.create({
  blank: { flex: 1, backgroundColor: color.canvas },
});
