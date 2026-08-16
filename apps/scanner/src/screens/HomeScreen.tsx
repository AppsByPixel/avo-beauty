/**
 * The home hub — design/AVO Staff Scanner.dc.html:91-127.
 *
 * IT DELIBERATELY DOES NOT JUMP STRAIGHT TO SCANNING. The scanner is also the
 * phone a stylist checks her bookings and her hours on, and opening a live
 * camera every time she picks it up is both wrong for those tasks and a
 * privacy posture nobody chose.
 *
 * `Today's charges` is gated on `perms.charges`. The padlock and the locked
 * screen are a COURTESY (non-negotiable #7): the tile still navigates, the
 * screen behind it still calls `GET /charges`, and the server's 403 is the
 * actual control. See ChargesScreen.
 *
 * `My bookings` and `My schedule` are drawn and deliberately inert — see the
 * note on `comingSoon` below.
 */

import { ScrollView, StyleSheet, Text, View, Pressable } from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { LinearGradient } from 'expo-linear-gradient';
import { copy } from '../copy/en';
import { brand } from '../config/brand';
import { useSession } from '../state/session';
import { card, color, display, MIN_TAP_TARGET, radius, ui } from '../theme';
import { LinkButton } from '../components/Buttons';

export type HomeDestination = 'scan' | 'charges' | 'bookings' | 'schedule';

export function HomeScreen({
  onNavigate,
  onSignOut,
}: {
  onNavigate: (to: HomeDestination) => void;
  onSignOut: () => void;
}) {
  const { staff, can } = useSession();
  const first = staff?.name.split(' ')[0] ?? 'there';
  const canCharges = can('charges');
  const canVoid = can('void');

  const chargesSub = canCharges
    ? canVoid
      ? copy.chargesSubVoid
      : copy.chargesSubRead
    : copy.chargesSubLocked;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <View style={styles.identity}>
          <View style={styles.logo}>
            <Text style={[display(19, '600'), styles.logoText]}>{brand.initial}</Text>
          </View>
          <View>
            <Text style={display(18)}>{brand.salonName}</Text>
            <Text style={[ui(12), styles.muted]}>{copy.signedIn(first)}</Text>
          </View>
        </View>
        <LinkButton label={copy.signOut} onPress={onSignOut} muted testID="sign-out" />
      </View>

      <View style={styles.greetBlock}>
        <Text style={display(26)}>{copy.greeting(first)}</Text>
        <Text style={[ui(13.5), styles.muted, styles.greetSub]}>{copy.greetingSub}</Text>
      </View>

      <View style={styles.tiles}>
        {/* The primary action: filled with the card gradient, design:105. */}
        <Pressable
          onPress={() => onNavigate('scan')}
          accessibilityRole="button"
          accessibilityLabel={`${copy.scan}. ${copy.scanSub}`}
          testID="tile-scan"
          style={({ pressed }) => [styles.tile, styles.tileScanWrap, pressed && styles.pressed]}
        >
          <LinearGradient
            colors={[card.from, card.to]}
            start={{ x: 0.1, y: 0 }}
            end={{ x: 0.9, y: 1 }}
            style={styles.tileScanFill}
          >
            <View style={[styles.tileIcon, styles.tileIconOnBrand]}>
              <Svg width={24} height={24} viewBox="0 0 24 24" fill="none">
                <Path
                  d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16M4 12h16"
                  stroke={color.white}
                  strokeWidth={1.7}
                  strokeLinecap="round"
                />
              </Svg>
            </View>
            <View style={styles.tileTextWrap}>
              <Text style={[ui(18, '600'), styles.onBrandTitle]}>{copy.scan}</Text>
              <Text style={[ui(13), styles.onBrandSub]}>{copy.scanSub}</Text>
            </View>
          </LinearGradient>
        </Pressable>

        <Tile
          title={copy.bookings}
          subtitle={copy.bookingsSub}
          onPress={() => onNavigate('bookings')}
          testID="tile-bookings"
          icon={
            <Svg width={24} height={24} viewBox="0 0 24 24" fill="none">
              <Rect
                x={3.5}
                y={5}
                width={17}
                height={15}
                rx={2.5}
                stroke={color.brandDeep}
                strokeWidth={1.7}
              />
              <Path
                d="M3.5 9.5h17M8 3.5V6.5M16 3.5V6.5"
                stroke={color.brandDeep}
                strokeWidth={1.7}
                strokeLinecap="round"
              />
              <Path
                d="M8.5 14.5l2.2 2.2 4-4.2"
                stroke={color.brandDeep}
                strokeWidth={1.7}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </Svg>
          }
        />

        <Tile
          title={copy.schedule}
          subtitle={copy.scheduleSub}
          onPress={() => onNavigate('schedule')}
          testID="tile-schedule"
          icon={
            <Svg width={24} height={24} viewBox="0 0 24 24" fill="none">
              <Circle cx={12} cy={12} r={8.3} stroke={color.brandDeep} strokeWidth={1.7} />
              <Path
                d="M12 7.5V12l3 1.8"
                stroke={color.brandDeep}
                strokeWidth={1.7}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </Svg>
          }
        />

        <Tile
          title={copy.charges}
          subtitle={chargesSub}
          onPress={() => onNavigate('charges')}
          testID="tile-charges"
          // design:121 — the padlock, and its tooltip, when charges is off.
          locked={!canCharges}
          icon={
            <Svg width={24} height={24} viewBox="0 0 24 24" fill="none">
              <Path
                d="M6 3.5h12v17l-3-2-3 2-3-2-3 2v-17Z"
                stroke={color.brandDeep}
                strokeWidth={1.7}
                strokeLinejoin="round"
              />
              <Path
                d="M9.5 9h5M9.5 13h5"
                stroke={color.brandDeep}
                strokeWidth={1.7}
                strokeLinecap="round"
              />
            </Svg>
          }
        />
      </View>

      <Text style={[ui(11.5), styles.footer]}>{copy.appFooter}</Text>
    </ScrollView>
  );
}

function Tile({
  title,
  subtitle,
  icon,
  onPress,
  locked,
  testID,
}: {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  onPress: () => void;
  locked?: boolean;
  testID?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${subtitle}`}
      // The padlock must carry its meaning as text, not colour or shape alone
      // (interaction-spec.md §2 § Screen readers).
      {...(locked ? { accessibilityHint: copy.chargesLockedHint } : {})}
      testID={testID}
      style={({ pressed }) => [styles.tile, styles.tilePlain, pressed && styles.pressed]}
    >
      <View style={[styles.tileIcon, styles.tileIconTint]}>{icon}</View>
      <View style={styles.tileTextWrap}>
        <Text style={ui(18, '600')}>{title}</Text>
        <Text style={[ui(13), styles.muted]}>{subtitle}</Text>
      </View>
      {locked && (
        <View accessibilityLabel={copy.chargesLockedHint} testID="tile-charges-lock">
          <Svg width={18} height={18} viewBox="0 0 20 20" fill="none">
            <Rect
              x={4}
              y={9}
              width={12}
              height={8}
              rx={2}
              stroke="rgba(28,27,25,0.35)"
              strokeWidth={1.6}
            />
            <Path
              d="M7 9V6.8a3 3 0 0 1 6 0V9"
              stroke="rgba(28,27,25,0.35)"
              strokeWidth={1.6}
            />
          </Svg>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.surface },
  // design:92 — padding 70/26/30.
  content: { paddingTop: 70, paddingHorizontal: 26, paddingBottom: 30, flexGrow: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  identity: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  logo: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: color.brandDeep,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoText: { color: color.white },
  muted: { color: color.textMuted },
  greetBlock: { marginTop: 40 },
  greetSub: { marginTop: 5 },
  tiles: { gap: 14, marginTop: 24 },
  tile: {
    borderRadius: radius.walletCard,
    minHeight: MIN_TAP_TARGET,
    overflow: 'hidden',
  },
  tileScanWrap: {},
  tileScanFill: { flexDirection: 'row', alignItems: 'center', gap: 16, padding: 22 },
  tilePlain: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    padding: 22,
    backgroundColor: color.white,
    borderWidth: 1,
    borderColor: 'rgba(28,27,25,0.1)',
  },
  pressed: { opacity: 0.85 },
  tileIcon: {
    width: 48,
    height: 48,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileIconOnBrand: { backgroundColor: 'rgba(255,255,255,0.16)' },
  tileIconTint: { backgroundColor: color.brandTint },
  tileTextWrap: { flex: 1, minWidth: 0 },
  onBrandTitle: { color: color.white },
  onBrandSub: { color: 'rgba(255,255,255,0.85)' },
  footer: { color: color.textMutedSoft, textAlign: 'center', marginTop: 'auto', paddingTop: 30 },
});
