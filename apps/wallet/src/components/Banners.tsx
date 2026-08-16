/**
 * The two banners that sit above data that is still on screen.
 *
 * interaction-spec.md §4: "Network failure keeps the last-known data visible
 * with a stale banner rather than blanking." Blanking a wallet someone is
 * looking at is worse than showing yesterday's figure, labelled as such.
 */

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { color, MIN_TAP_TARGET, radius, text } from '../theme';
import { useLanguage } from '../i18n/language';

export function OfflineBanner() {
  const { lang, copy } = useLanguage();
  return (
    <View style={[styles.banner, styles.offline]} accessibilityRole="alert">
      <View style={[styles.dot, styles.offlineDot]} />
      <Text style={[text('body', lang), styles.offlineText]}>{copy.offlineBanner}</Text>
    </View>
  );
}

export function StaleBanner({ at, onRetry }: { at: number; onRetry: () => void }) {
  const { lang, copy } = useLanguage();
  return (
    <View style={[styles.banner, styles.stale]} accessibilityRole="alert">
      <View style={[styles.dot, styles.staleDot]} />
      <Text style={[text('body', lang), styles.staleText]}>{copy.staleBanner(at)}</Text>
      <Pressable onPress={onRetry} accessibilityRole="button" style={styles.staleAction}>
        <Text style={[text('bodyS', lang), styles.staleActionText]}>{copy.tryAgain}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    borderRadius: radius.input,
    paddingVertical: 11,
    paddingHorizontal: 13,
    marginBottom: 18,
  },
  dot: { width: 8, height: 8, borderRadius: radius.pill },

  offline: {
    backgroundColor: color.surfaceAlt2,
    // The design sets rgba(28,27,25,0.09) here; the token set has 0.08
    // (`hairline`) and no 0.09. One hundredth of an alpha is below the
    // threshold of visibility, and a token that every other hairline in the app
    // already uses is worth more than the last 0.01.
    borderColor: color.hairline,
  },
  // AVO States.dc.html sets this dot to a flat #8A867E, which is NOT in the
  // token set — there is no opaque mid-neutral in design/tokens/avo-tokens.json.
  // It does not need to be: this dot only ever sits on this banner's own
  // `surfaceAlt2` ground, and `textMuted` (rgba(28,27,25,0.5)) composites over
  // #F0EEE9 to rgb(134,132,129) — within ~2/255 per channel of #8A867E. So the
  // designed colour is reproduced from a token rather than re-typed.
  //
  // SHARED-PACKAGE GAP (reported, not fixed): if this dot ever has to sit on a
  // different ground, avo-tokens.json needs a flat `color.neutralDot: #8A867E`.
  offlineDot: { backgroundColor: color.textMuted },
  offlineText: { flex: 1, color: color.textMutedStrong, lineHeight: 18 },

  stale: { backgroundColor: color.warnBg },
  staleDot: { backgroundColor: color.warnText },
  staleText: { flex: 1, color: color.warnText },
  staleAction: { minHeight: MIN_TAP_TARGET, justifyContent: 'center', paddingHorizontal: 6 },
  staleActionText: { color: color.warnText, fontWeight: '600', textDecorationLine: 'underline' },
});
