/**
 * App shell.
 *
 * Fonts are loaded before anything renders. The design's display face is
 * Fraunces and its UI face is Inter (design/tokens/avo-tokens.json → font), and
 * a wallet card that flashes system-serif before swapping is worse than a beat
 * of blank canvas.
 *
 * IBM Plex Sans Arabic — the Arabic face named in non-negotiable #12 — is not
 * loaded here because the language switch is not yet built. It lands with the
 * RTL layout, not before it.
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
import { StatusBar } from 'expo-status-bar';
import { View, StyleSheet } from 'react-native';
import { color } from './src/theme';
import { HomeScreen } from './src/screens/HomeScreen';

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
  });

  if (!fontsLoaded) return <View style={styles.blank} />;

  return (
    <>
      <StatusBar style="dark" />
      <HomeScreen />
    </>
  );
}

const styles = StyleSheet.create({
  blank: { flex: 1, backgroundColor: color.canvas },
});
