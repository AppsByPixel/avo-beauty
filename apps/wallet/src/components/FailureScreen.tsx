/**
 * The cold failure screen — no data to keep, so there is nothing to keep.
 *
 * interaction-spec.md §4 draws the line this component encodes: distinguish
 * "we failed" (offer Try again) from "you can't do that" (explain, and do not
 * offer a button that will fail again). A retry on a 403 teaches a customer that
 * the app is broken; the honest answer is that this is not something retrying
 * fixes.
 */

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { color, MIN_TAP_TARGET, onBrandFill, radius, text } from '../theme';
import { useLanguage } from '../i18n/language';
import type { FailureKind } from '../api/client';

interface Props {
  kind: FailureKind;
  message: string;
  reference: string;
  onRetry: () => void;
  retrying: boolean;
}

export function FailureScreen({ kind, message, reference, onRetry, retrying }: Props) {
  const { lang, copy } = useLanguage();
  const canRetry = kind !== 'forbidden';
  return (
    <View style={styles.wrap} accessibilityRole="alert">
      <View style={styles.icon}>
        <View style={styles.iconRing} />
        <View style={styles.iconBar} />
        <View style={styles.iconDot} />
      </View>

      <Text style={[text('displayM', lang), styles.title]}>
        {canRetry ? copy.errorTitle : copy.blockedTitle}
      </Text>
      <Text style={[text('body', lang), styles.body]}>{canRetry ? copy.errorBody : message}</Text>

      {canRetry ? (
        <Pressable
          onPress={onRetry}
          disabled={retrying}
          accessibilityRole="button"
          accessibilityState={{ disabled: retrying }}
          style={[styles.button, retrying && styles.buttonBusy]}
        >
          <Text style={[text('bodyL', lang), styles.buttonText]}>{copy.tryAgain}</Text>
        </Pressable>
      ) : null}

      <Text style={[text('bodyS', lang), styles.reference]}>
        {copy.referencePrefix}
        {reference}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20 },
  icon: {
    width: 62,
    height: 62,
    borderRadius: 31,
    backgroundColor: color.dangerBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconRing: {
    position: 'absolute',
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1.7,
    borderColor: color.dangerDot,
  },
  iconBar: { width: 2, height: 10, borderRadius: 1, backgroundColor: color.dangerDot, marginBottom: 3 },
  iconDot: { width: 2, height: 2, borderRadius: 1, backgroundColor: color.dangerDot },
  title: { color: color.ink, marginTop: 19, textAlign: 'center' },
  body: { color: color.textMuted, marginTop: 7, textAlign: 'center', maxWidth: 250, lineHeight: 20 },
  button: {
    width: '100%',
    marginTop: 24,
    minHeight: MIN_TAP_TARGET,
    paddingVertical: 16,
    borderRadius: radius.button,
    alignItems: 'center',
    justifyContent: 'center',
    // Non-negotiable #9 — white on brandDeep, never on brand.
    backgroundColor: onBrandFill.backgroundColor,
  },
  buttonBusy: { opacity: 0.6 },
  buttonText: { color: onBrandFill.color, fontWeight: '600' },
  reference: { color: color.textMutedSoft, marginTop: 16 },
});
