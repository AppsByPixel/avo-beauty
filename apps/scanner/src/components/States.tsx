/**
 * Loading, empty, error and offline — built with the screens, not after
 * (CLAUDE.md § How to work, interaction-spec.md §4).
 *
 * The rules these encode, from the spec:
 *
 *   Loading  skeletons shaped like the real layout, never a centred spinner on
 *            a full page. Money skeletons as a bar — "never render 0.000 before
 *            data arrives".
 *   Empty    name the thing, offer the one action that fills it. No
 *            illustration.
 *   Error    distinguish *we failed* (retry) from *you can't do that* (explain,
 *            no retry button). `Refusal` is the second kind and deliberately
 *            has no retry.
 *   Offline  keep the last-known data visible with a stale banner rather than
 *            blanking.
 *
 * Layouts and copy come from design/AVO States.dc.html; each is cited.
 */

import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { color, display, radius, ui } from '../theme';
import { copy } from '../copy/en';
import { PrimaryButton, SecondaryButton } from './Buttons';

// ------------------------------------------------------------------ loading --

/**
 * A skeleton bar. States:173 — `#EDEAE3`, 12px tall, 6px radius.
 *
 * TOKEN GAP (reported): `#EDEAE3` is the skeleton fill used throughout
 * AVO States.dc.html and has no name in design/tokens/avo-tokens.json.
 */
const SKELETON_FILL = '#EDEAE3';

export function SkeletonBar({
  width,
  height = 12,
  style,
}: {
  width: number | `${number}%`;
  height?: number;
  style?: object;
}) {
  return (
    <View
      // A skeleton is not content. Hiding it from the reader stops it
      // announcing a screenful of empty boxes while data is in flight.
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[{ width, height, borderRadius: 6, backgroundColor: SKELETON_FILL }, style]}
    />
  );
}

/** A card-shaped skeleton, for the charge list and the lookup results. */
export function SkeletonRows({ count = 4 }: { count?: number }) {
  return (
    <View accessibilityLabel="Loading" style={styles.rows}>
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={styles.card}>
          <SkeletonBar width="55%" />
          <SkeletonBar width="35%" style={{ marginTop: 9 }} />
          <SkeletonBar width="25%" height={10} style={{ marginTop: 9 }} />
        </View>
      ))}
    </View>
  );
}

// -------------------------------------------------------------------- empty --

/** States:112-119 — icon tile, title, body, and the one action. */
export function EmptyState({
  title,
  body,
  actionLabel,
  onAction,
}: {
  title: string;
  body: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <View style={styles.card}>
      <View style={styles.emptyInner}>
        <View style={styles.emptyIcon}>
          <Svg width={19} height={19} viewBox="0 0 24 24" fill="none">
            <Path
              d="M4 7h16M4 12h16M4 17h9"
              stroke="rgba(28,27,25,0.32)"
              strokeWidth={1.7}
              strokeLinecap="round"
            />
          </Svg>
        </View>
        <Text style={[display(19), styles.centreTitle]}>{title}</Text>
        <Text style={[ui(13), styles.centreBody]}>{body}</Text>
        {actionLabel && onAction && (
          <PrimaryButton label={actionLabel} onPress={onAction} style={styles.emptyAction} />
        )}
      </View>
    </View>
  );
}

// -------------------------------------------------------------------- error --

/**
 * "We failed" — States:128-139. Offers a retry and shows the reference.
 */
export function ErrorState({
  title,
  body,
  reference,
  onRetry,
  retryLabel,
}: {
  title?: string;
  body?: string;
  reference?: string | null;
  onRetry: () => void;
  retryLabel?: string;
}) {
  return (
    <View style={styles.centre}>
      <View style={[styles.badge, { backgroundColor: color.dangerBg }]}>
        <Svg width={26} height={26} viewBox="0 0 24 24" fill="none">
          <Path
            d="M12 8v5M12 16.5v.5"
            stroke={color.dangerDot}
            strokeWidth={2}
            strokeLinecap="round"
          />
          <Circle cx={12} cy={12} r={9} stroke={color.dangerDot} strokeWidth={1.7} />
        </Svg>
      </View>
      <Text style={[display(21), styles.centreTitle]}>{title ?? copy.errorTitle}</Text>
      <Text style={[ui(13), styles.centreBody, styles.narrow]}>{body ?? copy.errorBody}</Text>
      <PrimaryButton
        label={retryLabel ?? copy.tryAgain}
        onPress={onRetry}
        style={styles.fullAction}
      />
      {reference && <Text style={[ui(11.5), styles.reference]}>{copy.reference(reference)}</Text>}
    </View>
  );
}

/**
 * "You can't do that" — the other kind. No retry: a 403 does not improve by
 * being asked twice, and offering a button that cannot work is worse than
 * explaining. interaction-spec.md §4.
 */
export function Refusal({
  title,
  body,
  children,
}: {
  title: string;
  body: string;
  children?: React.ReactNode;
}) {
  return (
    <View style={styles.centre}>
      <View style={[styles.badge, { backgroundColor: color.surfaceAlt2 }]}>
        <Svg width={26} height={26} viewBox="0 0 20 20" fill="none">
          <Path
            d="M3.5 8.5h13v8.5h-13z"
            stroke="rgba(28,27,25,0.45)"
            strokeWidth={1.6}
            strokeLinejoin="round"
          />
          <Path d="M6.6 8.5V6.6a3.4 3.4 0 0 1 6.8 0v1.9" stroke="rgba(28,27,25,0.45)" strokeWidth={1.6} />
        </Svg>
      </View>
      <Text style={[display(22), styles.centreTitle]}>{title}</Text>
      <Text style={[ui(13.5), styles.centreBody, styles.narrow]}>{body}</Text>
      {children}
    </View>
  );
}

/**
 * The amber "code expired" state — States:142-157, the one scanner state the
 * states file draws in full, including the "Nothing was charged." reassurance.
 */
export function CodeRefusedState({
  title,
  body,
  onScanAgain,
  onManualLookup,
}: {
  title: string;
  body: string;
  onScanAgain: () => void;
  onManualLookup?: () => void;
}) {
  return (
    <View style={styles.centre}>
      <View style={[styles.badge, { backgroundColor: color.warnBg }]}>
        <Svg width={26} height={26} viewBox="0 0 24 24" fill="none">
          <Circle cx={12} cy={12} r={8.6} stroke={color.warnText} strokeWidth={1.8} />
          <Path
            d="M12 7.5V12l3 2"
            stroke={color.warnText}
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Svg>
      </View>
      <Text style={[display(21), styles.centreTitle]}>{title}</Text>
      <Text style={[ui(13), styles.centreBody, styles.narrow]}>{body}</Text>
      <PrimaryButton label={copy.scanAgain} onPress={onScanAgain} style={styles.fullAction} />
      {onManualLookup && (
        <SecondaryButton
          label={copy.cantScan}
          onPress={onManualLookup}
          style={styles.secondAction}
        />
      )}
      {/* States:152-155 — the first thing the artist needs to know. */}
      <View style={styles.reassure}>
        <View style={styles.reassureDot} />
        <Text style={[ui(12.5), styles.reassureText]}>{copy.nothingCharged}</Text>
      </View>
    </View>
  );
}

// ------------------------------------------------------------------ offline --

/**
 * States:83-86, verbatim. Sits above content that is still shown — the spec is
 * explicit that a network failure "keeps the last-known data visible with a
 * stale banner rather than blanking".
 *
 * TOKEN GAP (reported): the banner's dot is `#8A867E` in the design and has no
 * name in the token file. It is the only neutral status dot in the bundle.
 */
const OFFLINE_DOT = '#8A867E';

export function OfflineBanner({ label }: { label?: string }) {
  return (
    <View
      style={styles.offline}
      accessibilityRole="alert"
      accessibilityLabel={label ?? copy.offlineBanner}
    >
      <View style={styles.offlineDot} />
      <Text style={[ui(12.5), styles.offlineText]}>{label ?? copy.offlineBanner}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  rows: { gap: 10 },
  card: {
    backgroundColor: color.white,
    borderWidth: 1,
    borderColor: color.hairline,
    borderRadius: radius.cardLg,
    padding: 15,
  },
  emptyInner: { alignItems: 'center', paddingVertical: 29, paddingHorizontal: 9 },
  emptyIcon: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: color.surfaceAlt2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyAction: { marginTop: 20, paddingHorizontal: 22 },
  centre: { alignItems: 'center', justifyContent: 'center', paddingVertical: 30 },
  badge: {
    width: 62,
    height: 62,
    borderRadius: 31,
    alignItems: 'center',
    justifyContent: 'center',
  },
  centreTitle: { color: color.ink, marginTop: 18, textAlign: 'center' },
  centreBody: {
    color: color.textMuted,
    marginTop: 7,
    textAlign: 'center',
    lineHeight: 20,
  },
  narrow: { maxWidth: 260 },
  fullAction: { alignSelf: 'stretch', marginTop: 24 },
  secondAction: { alignSelf: 'stretch', marginTop: 10 },
  reference: { color: color.textMutedSoft, marginTop: 16 },
  reassure: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    backgroundColor: color.brandTint2,
    borderWidth: 1,
    borderColor: 'rgba(110,127,108,0.22)',
    borderRadius: 13,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginTop: 18,
  },
  reassureDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: color.brand },
  reassureText: { color: color.brandDeeper, flex: 1, lineHeight: 18 },
  offline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    backgroundColor: color.surfaceAlt2,
    borderWidth: 1,
    borderColor: 'rgba(28,27,25,0.09)',
    borderRadius: 12,
    paddingVertical: 11,
    paddingHorizontal: 13,
  },
  offlineDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: OFFLINE_DOT },
  offlineText: { color: color.textMutedStrong, flex: 1, lineHeight: 18 },
});
