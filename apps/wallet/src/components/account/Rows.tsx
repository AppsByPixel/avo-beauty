/**
 * The Account screen's list furniture: a section label, a white rounded card,
 * a tappable row with a value and a chevron, and a switch row.
 *
 * These exist because the design repeats the same three shapes eleven times
 * across the screen (five profile rows, five switches, N policy rows) and a
 * screen that restates the padding eleven times drifts by a pixel somewhere.
 *
 * Two things are resolved here rather than at every call site:
 *
 *   the chevron   is a directional glyph. It points at the reading edge, so it
 *                 is mirrored in Arabic — design:413 does exactly this with
 *                 `transform: scaleX(-1)`.
 *   the divider   the design draws a hairline under every row INCLUDING the
 *                 last one inside each card. That is the design, not an
 *                 oversight (design:411, :434), so `last` is opt-in and used
 *                 only where a row genuinely ends a card with no rule.
 */

import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { color, MIN_TAP_TARGET, MICRO_LABEL_COLOR, radius, text, theme, WHITE } from '../../theme';
import { useLanguage } from '../../i18n/language';
import { alignEnd } from '../../i18n/rtl';
import { TappableRow } from '../Buttons';

export function SectionLabel({ children }: { children: string }) {
  const { lang } = useLanguage();
  return <Text style={[text('label', lang), styles.sectionLabel]}>{children}</Text>;
}

export function SettingsCard({
  children,
  style,
  testID,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  return (
    <View style={[styles.card, style]} testID={testID}>
      {children}
    </View>
  );
}

/** The muted note the design sets under a card (design:441, :458). */
export function CardNote({ children }: { children: string }) {
  const { lang } = useLanguage();
  return <Text style={[text('bodyS', lang), styles.cardNote]}>{children}</Text>;
}

function Chevron({ rtl }: { rtl: boolean }) {
  return (
    <Svg
      width={7}
      height={12}
      viewBox="0 0 7 12"
      fill="none"
      opacity={0.3}
      // design:413 — mirrored in Arabic, because it points at the reading edge.
      style={rtl ? styles.chevronRtl : undefined}
    >
      <Path
        d="M1 1l5 5-5 5"
        stroke={color.ink}
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export function SettingsRow({
  label,
  value,
  onPress,
  last,
  testID,
  /** LTR-forced value column — a phone number or an email inside Arabic. */
  ltrValue,
}: {
  label: string;
  value?: string;
  onPress: () => void;
  last?: boolean;
  testID?: string;
  ltrValue?: boolean;
}) {
  const { lang, rtl } = useLanguage();
  return (
    <TappableRow
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={value ? `${label}, ${value}` : label}
      testID={testID}
      style={[styles.row, last && styles.rowLast]}
    >
      <Text style={[text('body', lang), styles.rowLabel]}>{label}</Text>
      <View style={styles.rowEnd}>
        {value ? (
          <Text
            numberOfLines={1}
            style={[
              text('bodyS', lang),
              styles.rowValue,
              { textAlign: alignEnd(lang) },
              // `writingDirection` is the RN equivalent of `direction: ltr`, which
              // the design applies to the phone row (design:403) and the email
              // field. Without it a `+965…` sits with its sign on the wrong side.
              ltrValue && styles.ltr,
            ]}
          >
            {value}
          </Text>
        ) : null}
        <Chevron rtl={rtl} />
      </View>
    </TappableRow>
  );
}

/**
 * The switch itself.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS NOT `<Switch>`. It was, and react-native-web's Switch is broken
 * under `dir="rtl"`: it positions its ON thumb with `left: 40px; right: -40px`,
 * and in RTL the `right` declaration wins, so the thumb travels the wrong way
 * and lands OUTSIDE its own track. Measured in the Arabic build — the track sat
 * at x=37 with a width of 40, and the thumb at x=97. On screen it reads as a
 * green pill with a loose white dot floating beside it.
 *
 * Non-negotiable #12 makes Arabic a first-class layout, so a control that only
 * assembles correctly in English is a defect and not a rough edge. This is the
 * design's own construction instead (design:1599-1602): a track, a knob, and
 * `justifyContent` deciding which end the knob sits at.
 *
 * ACCESSIBILITY IS NOT LOST BY DROPPING THE PLATFORM CONTROL. The reason to
 * prefer `<Switch>` is that it announces itself as a switch with a state, and
 * `accessibilityRole="switch"` plus `accessibilityState={{ checked }}` gives
 * exactly that on a Pressable — react-native-web emits `role="switch"` and
 * `aria-checked`, and native maps it to the platform's switch trait.
 *
 * THE KNOB MIRRORS, AND THAT IS A DELIBERATE DIVERGENCE FROM THE PROTOTYPE.
 * `justifyContent: 'flex-end'` for ON needs no language conditional, because
 * flexbox already resolves `flex-end` against the inline direction on both
 * targets — so Arabic gets ON at the reading end, which is what iOS and Android
 * both do with a system switch in RTL. The design prototype explicitly
 * un-flips it (design:1600 picks `flex-start` for ON when `isAr`), which would
 * keep the knob on the physical right in both languages. CLAUDE.md: "If a
 * platform idiom conflicts with the design, follow the platform and note it."
 * Noted, and reported for the designer to confirm.
 * ═════════════════════════════════════════════════════════════════════════════
 */
function Toggle({
  value,
  onToggle,
  label,
  hint,
  testID,
}: {
  value: boolean;
  onToggle: () => void;
  label: string;
  hint: string;
  testID?: string;
}) {
  return (
    <TappableRow
      onPress={onToggle}
      accessibilityRole="switch"
      // BOTH, and they are not redundant. `accessibilityState` is what native
      // reads; react-native-web emits `role="switch"` from the role but does NOT
      // map `state.checked` to `aria-checked` — verified on the rendered element,
      // whose attributes were role/aria-label/tabindex and nothing else. A switch
      // that announces no state is worse than a checkbox, so the ARIA attribute
      // is set directly for the web build.
      accessibilityState={{ checked: value }}
      aria-checked={value}
      accessibilityLabel={label}
      accessibilityHint={hint}
      testID={testID}
      style={styles.toggleTarget}
    >
      {/*
        `brand` for the ON track: a track is a SURFACE, and non-negotiable #9
        reserves `brandDeep` for the case where white TEXT sits on a fill. There
        is no text on a switch.
      */}
      <View
        style={[
          styles.track,
          value ? styles.trackOn : styles.trackOff,
          // No `lang` conditional. See the header — flexbox flips this for free,
          // and adding one would double-flip it.
          { justifyContent: value ? 'flex-end' : 'flex-start' },
        ]}
      >
        <View style={styles.knob} />
      </View>
    </TappableRow>
  );
}

export function ToggleRow({
  label,
  sub,
  value,
  onToggle,
  last,
  testID,
}: {
  label: string;
  sub: string;
  value: boolean;
  onToggle: () => void;
  last?: boolean;
  testID?: string;
}) {
  const { lang } = useLanguage();
  return (
    <View style={[styles.toggleRow, last && styles.rowLast]}>
      <View style={styles.toggleText}>
        <Text style={[text('body', lang), styles.rowLabel]}>{label}</Text>
        <Text style={[text('bodyS', lang), styles.toggleSub]}>{sub}</Text>
      </View>
      <Toggle
        value={value}
        onToggle={onToggle}
        label={label}
        hint={sub}
        {...(testID ? { testID } : {})}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  sectionLabel: { color: MICRO_LABEL_COLOR, marginTop: 24, marginBottom: 10, marginHorizontal: 4 },
  card: {
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.hairline,
    borderRadius: radius.cardLg,
    paddingHorizontal: 16,
  },
  cardNote: { color: color.textMutedSoft, marginTop: 12, marginHorizontal: 4, lineHeight: 18 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    minHeight: MIN_TAP_TARGET,
    paddingVertical: 15,
    borderBottomWidth: 1,
    borderBottomColor: color.hairlineInner,
  },
  rowLast: { borderBottomWidth: 0 },
  rowLabel: { color: color.ink, flexShrink: 1 },
  rowEnd: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1, minWidth: 0 },
  rowValue: { color: color.textMutedSoft, flexShrink: 1 },
  ltr: { writingDirection: 'ltr' },
  chevronRtl: { transform: [{ scaleX: -1 }] },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14,
    minHeight: MIN_TAP_TARGET,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: color.hairlineInner,
  },
  toggleText: { flex: 1, minWidth: 0 },
  toggleSub: { color: color.textMutedSoft, marginTop: 2, lineHeight: 18 },

  // The track is 44×26 (design/tokens/avo-tokens.json → control.toggleTrack) and
  // 26 is under the 44pt minimum, so the TARGET is padded out around it rather
  // than the control being drawn larger than the design.
  toggleTarget: { minHeight: MIN_TAP_TARGET, justifyContent: 'center' },
  track: {
    width: theme.control.toggleTrack[0],
    height: theme.control.toggleTrack[1],
    borderRadius: radius.pill,
    padding: 3,
    flexDirection: 'row',
    alignItems: 'center',
  },
  trackOn: { backgroundColor: color.brand },
  trackOff: { backgroundColor: color.toggleOff },
  knob: {
    width: theme.control.toggleKnob,
    height: theme.control.toggleKnob,
    borderRadius: radius.pill,
    backgroundColor: WHITE,
  },
});
