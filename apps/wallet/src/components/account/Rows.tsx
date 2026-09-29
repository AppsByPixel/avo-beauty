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

import { Text, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { color, MIN_TAP_TARGET, MICRO_LABEL_COLOR, radius, text, theme, WHITE } from '../../theme';
import { useLanguage } from '../../i18n/language';
import { alignEnd } from '../../i18n/rtl';
import { TappableRow } from '../Buttons';
import { brandedStyles } from '../../theme/live';

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
export function CardNote({ children, testID }: { children: string; testID?: string }) {
  const { lang } = useLanguage();
  return (
    <Text style={[text('bodyS', lang), styles.cardNote]} testID={testID}>
      {children}
    </Text>
  );
}

/**
 * The "this goes somewhere" glyph. Exported so every row that navigates draws
 * the same one — `SettingsRow` and `ContactRow` both — rather than a second copy
 * that could forget the mirror.
 */
export function Chevron({ rtl, testID }: { rtl: boolean; testID?: string }) {
  return (
    <Svg
      width={7}
      height={12}
      viewBox="0 0 7 12"
      fill="none"
      opacity={0.3}
      // design:413 — mirrored in Arabic, because it points at the reading edge.
      style={rtl ? styles.chevronRtl : undefined}
      {...(testID ? { testID } : {})}
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
 * "Contact us" — the Help card's one control, drawn the way design:445-452
 * draws it: a brand-tinted icon tile, the title over its one-line explanation,
 * and the chevron every other navigating row on this screen ends with.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS (2026-09-28). Aftab: "contact us button — make it clearer
 * that it's clickable." It was not clear because the wallet had dropped both of
 * the design's cues: the row rendered two lines of text and nothing else, so
 * beside the WhatsApp row under it — also plain text, and NOT tappable —
 * nothing on it said "press me" except a heavier title.
 *
 * The fix is the design's own drawing, not a new idiom. The chevron is the one
 * this screen already uses to mean "this navigates" (`SettingsRow`, the policy
 * rows, the profile rows), so Contact us now reads as a member of that family;
 * the icon tile is design:446 verbatim — `brandTint` ground, `brandDeep` stroke.
 * No white text and no fill, so non-negotiable #9 does not arise: the stroke is
 * a graphic on a tint, 4.87:1 by `contrastRatio(brandDeep, brandTint)`.
 *
 * THE CHEVRON IS THE SHARED ONE, AT THE DESIGN'S 0.3 — and that measures 1.92:1
 * against the card (`ink` at 0.3 composited on `surface`), under WCAG 1.4.11's
 * 3:1 for a UI cue. It is not raised here, because raising it on one row makes
 * Contact us look unlike every other chevron row; raising it on all of them is
 * restyling the Account screen, which was not asked for. Reported to the client
 * with the measured alternative (0.5 → 3.26:1). The row does not rest on the
 * chevron alone: the icon tile, the weight and the role all say "control".
 *
 * `accessibilityRole="button"` so a screen reader announces it as actionable,
 * with the sub-line as its hint rather than folded into its name. The Arabic
 * layout mirrors the row through flexbox and the chevron through `Chevron`; the
 * speech-bubble glyph is NOT mirrored, and neither is it in the design.
 * ═════════════════════════════════════════════════════════════════════════════
 */
export function ContactRow({ onPress, testID }: { onPress: () => void; testID?: string }) {
  const { lang, rtl, copy } = useLanguage();
  return (
    <TappableRow
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={copy.contactCta}
      accessibilityHint={copy.contactCtaSub}
      {...(testID ? { testID } : {})}
      style={styles.contactRow}
    >
      <View style={styles.contactIcon}>
        <Svg width={18} height={18} viewBox="0 0 20 20" fill="none">
          <Path
            d="M3 5.5h14v9H8.5L5 17.5V14.5H3z"
            stroke={color.brandDeep}
            strokeWidth={1.7}
            strokeLinejoin="round"
          />
        </Svg>
      </View>
      <View style={styles.contactText}>
        <Text style={[text('body', lang, '600'), styles.contactTitle]}>{copy.contactCta}</Text>
        <Text style={[text('bodyS', lang), styles.contactSub]}>{copy.contactCtaSub}</Text>
      </View>
      <Chevron rtl={rtl} {...(testID ? { testID: `${testID}-chevron` } : {})} />
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
  disabled,
}: {
  value: boolean;
  onToggle: () => void;
  label: string;
  hint: string;
  testID?: string;
  /**
   * A PATCH for THIS switch is in flight. Only this row is inert — the other
   * four stay live, because one slow write is not a reason to freeze a section.
   * Both flags again, for the same reason as `checked` below: native reads
   * `accessibilityState`, the web build needs the ARIA attribute directly.
   */
  disabled?: boolean;
}) {
  return (
    <TappableRow
      onPress={disabled ? undefined : onToggle}
      disabled={disabled ?? false}
      aria-disabled={disabled ?? false}
      accessibilityRole="switch"
      // BOTH, and they are not redundant. `accessibilityState` is what native
      // reads; react-native-web emits `role="switch"` from the role but does NOT
      // map `state.checked` to `aria-checked` — verified on the rendered element,
      // whose attributes were role/aria-label/tabindex and nothing else. A switch
      // that announces no state is worse than a checkbox, so the ARIA attribute
      // is set directly for the web build.
      accessibilityState={{ checked: value, disabled: disabled ?? false }}
      aria-checked={value}
      accessibilityLabel={label}
      accessibilityHint={hint}
      testID={testID}
      style={[styles.toggleTarget, disabled && styles.toggleSaving]}
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
  saving,
}: {
  label: string;
  sub: string;
  value: boolean;
  onToggle: () => void;
  last?: boolean;
  testID?: string;
  /** This switch's write is in flight. See `Toggle` — only this row goes inert. */
  saving?: boolean;
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
        disabled={saving ?? false}
        {...(testID ? { testID } : {})}
      />
    </View>
  );
}

const styles = brandedStyles(() => ({
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
  // design:445 — gap 13, padding 14/0, a hairline under it (the WhatsApp row
  // follows inside the same card).
  contactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
    minHeight: MIN_TAP_TARGET,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: color.hairlineInner,
  },
  // design:446 — 36×36, radius 11, the brand tint.
  contactIcon: {
    width: 36,
    height: 36,
    borderRadius: 11,
    backgroundColor: color.brandTint,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  contactText: { flex: 1, minWidth: 0 },
  contactTitle: { color: color.ink },
  contactSub: { color: color.textMuted, marginTop: 2, lineHeight: 18 },
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
  // Dimmed, not hidden, and it keeps its tap target — the row still has to be
  // reachable and announceable while the write is in flight.
  toggleSaving: { opacity: 0.5 },
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
}));
