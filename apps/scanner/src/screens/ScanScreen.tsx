/**
 * The scanner — design/AVO Staff Scanner.dc.html:182-202.
 *
 * The one DARK screen in the app (`darkFrame: s.screen === 'scan'`, :767).
 * Everything else is `surface`.
 *
 * THE REDUCED-MOTION RULE IS THE IMPORTANT THING HERE
 * ==================================================
 * interaction-spec.md §3, and it is not the usual "make it shorter":
 *
 *   "Scanner line: **remove entirely** — replace with a static frame and the
 *    text 'Point at the customer's code'. A looping line is the exact motion
 *    that triggers people."
 *
 * So under reduced motion this screen renders no `Animated` value at all — the
 * line is not mounted, not at 0.01ms, not paused. The frame and the camera stay
 * exactly as they are, because "Never remove a state change — only the
 * animation carrying it": the scanner is still scanning and still says so.
 *
 * DEBOUNCING A CAMERA
 * ===================
 * A QR in frame fires `onBarcodeScanned` many times a second. Without the latch
 * below, one code in front of the lens submits `POST /scans` dozens of times,
 * and — far worse — a member card already on screen could be re-resolved
 * underneath the artist mid-selection. `handled` latches on the first readable
 * code and only clears when the screen is returned to.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { StatusBar } from 'expo-status-bar';
import * as Linking from 'expo-linking';
import { copy } from '../copy/en';
import { parsePaymentCode } from '../domain/paymentCode';
import { useReducedMotion } from '../motion/useReducedMotion';
import { color, dark, display, ui } from '../theme';
import { DarkButton, LinkButton, PrimaryButton } from '../components/Buttons';

const FRAME = 240;
/** design:194 — the line travels 214px inside a 240px frame. */
const TRAVEL = 214;

export function ScanScreen({
  onCode,
  onHome,
  onSignOut,
  onManualLookup,
  staffFirstName,
}: {
  onCode: (code: { memberId: string; token: string }) => void;
  onHome: () => void;
  onSignOut: () => void;
  onManualLookup: () => void;
  staffFirstName: string;
}) {
  const reduceMotion = useReducedMotion();
  const [permission, requestPermission] = useCameraPermissions();
  const [unreadable, setUnreadable] = useState(false);
  const handled = useRef(false);

  const accept = useCallback(
    (raw: string) => {
      if (handled.current) return;
      const parsed = parsePaymentCode(raw);
      if (!parsed) {
        // Not ours — a receipt, a product barcode, another salon's card. Say so
        // and keep scanning rather than sending it to the server to find out.
        setUnreadable(true);
        return;
      }
      handled.current = true;
      setUnreadable(false);
      onCode(parsed);
    },
    [onCode],
  );

  // Clear the latch whenever the screen is mounted afresh (Rescan / Next
  // customer both bring us back here).
  useEffect(() => {
    handled.current = false;
    setUnreadable(false);
  }, []);

  /**
   * THE SAME PAYMENT CODE, ARRIVING AS A DEEP LINK.
   *
   * `avo://pay?m=…&t=…` is a URI, so the OS can deliver it directly — from a
   * link in a message, from another app, or from `simctl openurl` on a
   * simulator, which is the only way to exercise this path on hardware with no
   * camera. It is handled by `accept`, the SAME function the camera calls, so
   * there is one code path into a charge and no test-only branch beside it.
   */
  useEffect(() => {
    const sub = Linking.addEventListener('url', ({ url }) => accept(url));
    void Linking.getInitialURL().then((url) => {
      if (url) accept(url);
    });
    return () => sub.remove();
  }, [accept]);

  const granted = permission?.granted === true;

  return (
    <View style={styles.screen}>
      {/* The one dark screen in the app, so the one that inverts the bar. */}
      <StatusBar style="light" />
      <View style={styles.header}>
        <LinkButton label={copy.home} onPress={onHome} onDark testID="scan-home" />
        <LinkButton label={copy.signOut} onPress={onSignOut} onDark muted testID="scan-signout" />
      </View>

      <View style={styles.titleBlock}>
        <Text style={[display(22), styles.title]}>{copy.scanTitle}</Text>
        <Text style={[ui(13), styles.sub]}>
          {reduceMotion ? copy.scanPromptReducedMotion : copy.scanPrompt}
        </Text>
      </View>

      <View style={styles.frame}>
        {granted && (
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={({ data }) => accept(data)}
          />
        )}
        <Corner style={styles.tl} />
        <Corner style={styles.tr} />
        <Corner style={styles.bl} />
        <Corner style={styles.br} />
        {/*
          Mounted only when motion is allowed. Under reduced motion nothing
          takes its place — the static frame above IS the replacement, together
          with the changed prompt.
        */}
        {!reduceMotion && <ScanLine />}
      </View>

      {/* Camera permission. No designed state — this is the honest minimum. */}
      {permission && !granted && (
        <View style={styles.permission} testID="scan-permission">
          <Text style={[ui(14, '600'), styles.title]}>{copy.cameraDenied}</Text>
          <Text style={[ui(12.5), styles.sub, styles.permissionBody]}>{copy.cameraDeniedBody}</Text>
          {permission.canAskAgain && (
            <PrimaryButton
              label={copy.cameraAsk}
              onPress={() => void requestPermission()}
              style={styles.permissionAction}
              testID="scan-permission-ask"
            />
          )}
        </View>
      )}

      {unreadable && (
        <Text
          style={[ui(12.5), styles.unreadable]}
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          testID="scan-unreadable"
        >
          {copy.scanUnreadable}
        </Text>
      )}

      <DarkButton
        label={copy.cantScan}
        onPress={onManualLookup}
        style={styles.manual}
        testID="scan-manual"
      />

      <View style={styles.footer}>
        <View style={styles.chip}>
          <View style={styles.chipAvatar}>
            <Text style={[ui(12, '600'), styles.title]}>
              {staffFirstName.charAt(0).toUpperCase()}
            </Text>
          </View>
          <Text style={[ui(13), styles.title]}>{copy.signedIn(staffFirstName)}</Text>
        </View>
      </View>
    </View>
  );
}

/** design:194 — a 2px bar sweeping the frame, 2s, alternating. */
function ScanLine() {
  const travel = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(travel, {
          toValue: 1,
          duration: 2000,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(travel, {
          toValue: 0,
          duration: 2000,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [travel]);

  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.line,
        { transform: [{ translateY: travel.interpolate({ inputRange: [0, 1], outputRange: [0, TRAVEL] }) }] },
      ]}
    />
  );
}

function Corner({ style }: { style: object }) {
  return <View style={[styles.corner, style]} />;
}

const styles = StyleSheet.create({
  // design:183 — #131511, padding 76/26/34.
  screen: {
    flex: 1,
    backgroundColor: dark.surface,
    alignItems: 'center',
    paddingTop: 76,
    paddingHorizontal: 26,
    paddingBottom: 34,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
  },
  titleBlock: { alignItems: 'center', marginTop: 44 },
  title: { color: dark.text },
  sub: { color: dark.textMuted, marginTop: 6, textAlign: 'center' },
  frame: {
    position: 'relative',
    width: FRAME,
    height: FRAME,
    marginTop: 34,
    borderRadius: 26,
    backgroundColor: dark.frame,
    overflow: 'hidden',
  },
  corner: {
    position: 'absolute',
    width: 34,
    height: 34,
    borderColor: dark.accent,
  },
  tl: { top: 0, left: 0, borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: 16 },
  tr: { top: 0, right: 0, borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: 16 },
  bl: { bottom: 0, left: 0, borderBottomWidth: 3, borderLeftWidth: 3, borderBottomLeftRadius: 16 },
  br: { bottom: 0, right: 0, borderBottomWidth: 3, borderRightWidth: 3, borderBottomRightRadius: 16 },
  line: {
    position: 'absolute',
    left: 16,
    right: 16,
    top: 12,
    height: 2,
    borderRadius: 2,
    backgroundColor: dark.accent,
  },
  permission: { alignItems: 'center', marginTop: 20, maxWidth: 300 },
  permissionBody: { lineHeight: 18 },
  permissionAction: { marginTop: 14, alignSelf: 'stretch' },
  unreadable: { color: dark.accent, marginTop: 16, textAlign: 'center' },
  manual: { width: '100%', marginTop: 26 },
  footer: { marginTop: 'auto', alignItems: 'center', gap: 14 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    backgroundColor: dark.fill,
    borderRadius: 999,
    paddingVertical: 8,
    paddingHorizontal: 15,
  },
  chipAvatar: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: color.brandDeep,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
