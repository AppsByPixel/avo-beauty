/**
 * "Follow Amara" — the four-up icon grid at the foot of Account.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * STORE THE HANDLE, DERIVE THE URL.
 *
 * api-contract.md § SocialLink: "Never persist a URL: a salon that edits its
 * handle would leave the icon pointing at a dead profile." `Salon.social` is
 * therefore `{ id, label, handle, on }` with no url on it at all, and the link
 * comes from `visibleSocialLinks()` in @avo/types — the shared implementation,
 * so the wallet, the dashboard and the owner console cannot disagree about what
 * `@amara.kw` on TikTok points at.
 *
 * `visibleSocialLinks` also applies the two hiding rules in one place:
 *
 *   `on: false`     the salon switched the channel off. Hidden, handle kept.
 *   empty handle    nothing to link to. Hidden — a tile that opens
 *                   `instagram.com/` is worse than no tile.
 *
 * So a channel that should not render never reaches this component, and this
 * component has no opinion about which four exist. A salon with one channel
 * gets one tile.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { Linking, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { visibleSocialLinks, type SocialLink } from '@avo/types';
import { color, radius, text } from '../../theme';
import { useLanguage } from '../../i18n/language';
import { TappableRow } from '../Buttons';

/**
 * design/avo-promotions.js:523-528 — the design's own icon set, lifted verbatim.
 * Drawn as one stroked path each, which is why they are outline marks and not
 * the platforms' filled brand logos.
 */
const ICON: Record<SocialLink['id'], string> = {
  instagram:
    'M7 3.5h10a3.5 3.5 0 0 1 3.5 3.5v10a3.5 3.5 0 0 1-3.5 3.5H7A3.5 3.5 0 0 1 3.5 17V7A3.5 3.5 0 0 1 7 3.5ZM12 8.2a3.8 3.8 0 1 1 0 7.6 3.8 3.8 0 0 1 0-7.6ZM17.1 6.7h.01',
  tiktok: 'M14 3.5v10.2a3.4 3.4 0 1 1-2.7-3.33M14 3.5c.45 2.3 1.95 3.6 4.1 3.8',
  snapchat:
    'M12 3.2c3 0 4.6 2 4.6 4.6 0 .9-.1 1.7.3 2 .5.4 1.4 0 1.7.5.3.6-.9 1.2-1.7 1.6-.5.3.4 1.9 2 2.4.5.2.3.8-.4 1-1 .3-1.6.2-1.9.6-.2.3-.1.9-.7.9-1 0-1.8-.4-2.8.3-.8.6-1.4 1.1-2.6 1.1s-1.8-.5-2.6-1.1c-1-.7-1.8-.3-2.8-.3-.6 0-.5-.6-.7-.9-.3-.4-.9-.3-1.9-.6-.7-.2-.9-.8-.4-1 1.6-.5 2.5-2.1 2-2.4-.8-.4-2-1-1.7-1.6.3-.5 1.2-.1 1.7-.5.4-.3.3-1.1.3-2C7.4 5.2 9 3.2 12 3.2Z',
  whatsapp:
    'M20 12a8 8 0 0 1-11.9 7L4 20l1.1-4A8 8 0 1 1 20 12ZM9.2 8.9c.4-.2.9 0 1 .4l.6 1.3-.7.9c.5 1 1.3 1.8 2.3 2.2l.9-.7 1.3.6c.4.2.6.6.4 1-.3.8-1.2 1.2-2 1-2.4-.6-4.3-2.5-4.9-4.9-.2-.8.3-1.6 1.1-1.8Z',
};

export function FollowSalon({ social }: { social: SocialLink[] }) {
  const { lang } = useLanguage();
  const links = visibleSocialLinks(social);

  // No channels on, or none with a handle: no section at all, not an empty grid
  // with a heading over it.
  if (links.length === 0) return null;

  return (
    <View style={styles.grid} testID="follow-grid">
      {links.map((link) => (
        <TappableRow
          key={link.id}
          onPress={() => void Linking.openURL(link.url)}
          accessibilityRole="link"
          accessibilityLabel={`${link.label} ${link.handle}`}
          testID={`social-${link.id}`}
          style={styles.tile}
        >
          <View style={styles.iconWrap}>
            <Svg width={21} height={21} viewBox="0 0 24 24" fill="none">
              <Path
                d={ICON[link.id]}
                stroke={color.brandDeep}
                strokeWidth={1.6}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </Svg>
          </View>
          <Text numberOfLines={1} style={[text('bodyS', lang), styles.label]}>
            {link.label}
          </Text>
          {/* A handle is a Latin identifier — LTR in both languages (design:468). */}
          <Text numberOfLines={1} style={[text('bodyS', lang), styles.handle]}>
            {link.handle}
          </Text>
        </TappableRow>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 9 },
  tile: {
    // Four across with 9pt gutters, and it wraps rather than squeezing when a
    // salon has fewer than four or the frame is narrower than the reference.
    flexBasis: '22%',
    flexGrow: 1,
    minWidth: 74,
    alignItems: 'center',
    gap: 7,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.hairline,
    borderRadius: 18,
    paddingVertical: 14,
    paddingHorizontal: 6,
  },
  iconWrap: {
    width: 38,
    height: 38,
    borderRadius: 12,
    backgroundColor: color.brandTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: { color: color.textMutedLabel, fontWeight: '600', fontSize: 10.5, maxWidth: '100%' },
  handle: {
    color: color.textMutedSoft,
    fontSize: 10,
    maxWidth: '100%',
    writingDirection: 'ltr',
  },
});
