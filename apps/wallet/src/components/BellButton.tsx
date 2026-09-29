/**
 * The bell — client ask W4. NOT IN THE WALLET DESIGN, placed by argument.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHERE IT LIVES, AND WHY THERE.
 *
 * design:195-198 draws Home's header as the greeting at the reading edge and a
 * row of controls at the far edge: the language switch, then the avatar. That
 * row is the wallet's ONE idiom for a header control — a 34pt bordered circle
 * on a 44pt target — and it is on Home only; Shop and Book draw a title, not a
 * control row. So the bell is a third circle in that row, drawn exactly as the
 * avatar is (`AccountButton`), BETWEEN the switch and the avatar: the avatar
 * stays the row's end, as the design has it, and the bell sits with the
 * account it belongs to.
 *
 * Rejected: a fifth nav tab (the design draws four, and a tab is a place, not
 * a feed); a bell on every screen's header (Shop and Book have no control row to
 * put it in, and inventing one is restyling); a row inside Account (the ask is
 * to SEE notifications, and a badge nobody sees until they open Account is not
 * a notification).
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * IT MIRRORS WITHOUT A CONDITIONAL. The header row is `flexDirection: 'row'`,
 * which is already logical on both targets (i18n/rtl.ts), so in Arabic the bell
 * moves with its siblings to the left edge. The badge is pinned with `end`, a
 * LOGICAL inset, so it sits on the reading-far shoulder of the circle in both
 * languages. The bell glyph is symmetric and is not flipped — flipping a glyph
 * that has no direction would be the double-flip rtl.ts warns about.
 *
 * #9: the badge is WHITE ON `brandDeep`, never on `brand`.
 */

import { Pressable, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { color, CONTROL_BORDER, MIN_TAP_TARGET, radius, text, WHITE } from '../theme';
import { useLanguage } from '../i18n/language';
import { focusable } from '../theme/focus';
import { brandedStyles } from '../theme/live';

export function BellButton({
  unreadCount,
  onPress,
}: {
  /** The server's figure. Null = unknown: no badge, and no "0" either. */
  unreadCount: number | null;
  onPress: () => void;
}) {
  const { lang, copy } = useLanguage();
  const unread = unreadCount ?? 0;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={copy.bellAria(unread)}
      dataSet={focusable}
      testID="bell-open"
      style={styles.target}
    >
      <View style={styles.circle}>
        <Svg width={17} height={17} viewBox="0 0 24 24" fill="none">
          {/* brandDeep on white — the stroke the avatar beside it uses. */}
          <Path
            d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15l1.5-2Z"
            stroke={color.brandDeep}
            strokeWidth={1.7}
            strokeLinejoin="round"
          />
          <Path
            d="M10 20.5a2.2 2.2 0 0 0 4 0"
            stroke={color.brandDeep}
            strokeWidth={1.7}
            strokeLinecap="round"
          />
        </Svg>
        {unread > 0 ? (
          <View style={styles.badge} testID="bell-badge">
            <Text style={[text('bodyS', lang, '700'), styles.badgeText]}>{copy.bellBadge(unread)}</Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = brandedStyles(() => ({
  target: {
    minWidth: MIN_TAP_TARGET,
    minHeight: MIN_TAP_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  circle: {
    width: 34,
    height: 34,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: CONTROL_BORDER,
    backgroundColor: color.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    top: -5,
    // LOGICAL, so the badge mirrors with the layout. Never `right`.
    end: -6,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    // #9 — white text sits on brandDeep, never on brand.
    backgroundColor: color.brandDeep,
  },
  badgeText: { color: WHITE, fontSize: 10, lineHeight: 12 },
}));
