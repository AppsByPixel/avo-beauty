/**
 * The cold failure screen — no data to keep, so there is nothing to keep.
 *
 * interaction-spec.md §4 draws the line this component encodes: distinguish
 * "we failed" (offer Try again) from "you can't do that" (explain, and do not
 * offer a button that will fail again). A retry on a 403 teaches a customer that
 * the app is broken; the honest answer is that this is not something retrying
 * fixes.
 *
 * THERE ARE THREE ANSWERS, NOT TWO. `FailureKind` has always had three members
 * and this component branched on one of them, so `offline` fell through to the
 * `server` copy — "Your balance and history are safe. This is on our side."
 * asserting OUR failure to a customer whose phone simply has no signal. Shop and
 * Book both cold-load through here, so both said it. The kind was reaching this
 * component from all five call sites; the branch was the missing half.
 *
 *   forbidden  explain, NO retry — asking again cannot change the answer.
 *   offline     her connection, WITH a retry — reconnecting is something she can
 *               actually do, which is what separates it from `forbidden`.
 *   server      ours, with a retry.
 *
 * `offlineBanner` is deliberately NOT the sentence here: it promises a last
 * update, and on a cold load there is nothing to show. `offlineColdTitle` /
 * `offlineColdBody` exist for exactly this state — INVENTED and marked, per
 * DECISIONS.md § "The offline cold-load sentence".
 */

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { color, MIN_TAP_TARGET, onBrandFill, radius, text } from '../theme';
import { useLanguage } from '../i18n/language';
import type { FailureKind } from '../api/client';
import { failureCopy } from '../domain/loadFailure';

interface Props {
  kind: FailureKind;
  message: string;
  reference: string;
  onRetry: () => void;
  retrying: boolean;
}

export function FailureScreen({ kind, message, reference, onRetry, retrying }: Props) {
  const { lang, copy } = useLanguage();
  /*
    The three-way decision lives in `domain/loadFailure.ts` so it has a spec —
    this workspace has no renderer, so a branch written inline here is a branch
    no test can reach, which is how `offline` came to render the `server` copy.
  */
  const { title, body: bodyText, canRetry } = failureCopy(kind, message, copy);

  return (
    <View style={styles.wrap} accessibilityRole="alert">
      <View style={styles.icon}>
        <View style={styles.iconRing} />
        <View style={styles.iconBar} />
        <View style={styles.iconDot} />
      </View>

      <Text style={[text('displayM', lang), styles.title]}>{title}</Text>
      <Text style={[text('body', lang), styles.body]}>{bodyText}</Text>

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
