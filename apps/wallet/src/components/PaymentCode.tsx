/**
 * The payment code panel that sits inside the wallet card.
 *
 * Three renderings, and which one shows is decided entirely by facts the server
 * supplied:
 *
 *   a live token   → the QR, the member id, and the real countdown to expiry
 *   offline        → the dashed "unavailable offline" panel from AVO States
 *   token failed   → the same panel with retry copy
 *
 * There is no fourth branch where the client shows something plausible. A code
 * that will not scan is worse than no code, because the customer finds out at
 * the counter and it looks like the salon's fault (interaction-spec.md §4).
 */

import { useEffect, useRef } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { walletTokenUri, type WalletToken } from '@avo/types';
import { color, radius, text, MIN_TAP_TARGET, WHITE } from '../theme';
import { en } from '../copy/en';

const QR_SIZE = 92;

interface Props {
  memberId: string;
  token: WalletToken | null;
  secondsRemaining: number;
  unavailable: 'offline' | 'failed' | null;
  onPress: () => void;
}

export function PaymentCode({ memberId, token, secondsRemaining, unavailable, onPress }: Props) {
  if (unavailable) {
    return (
      <View style={styles.unavailable} accessibilityRole="summary">
        <Text style={[text('body'), styles.unavailableTitle]}>
          {unavailable === 'offline' ? en.qrOfflineTitle : en.qrFailedTitle}
        </Text>
        <Text style={[text('bodyS'), styles.unavailableBody]}>
          {unavailable === 'offline' ? en.qrOfflineBody : en.qrFailedBody}
        </Text>
      </View>
    );
  }

  if (!token) {
    // The token is in flight. A grey square is honest; a fake QR is not.
    return (
      <View style={styles.panel}>
        <View style={styles.qrPlaceholder} />
        <View style={styles.panelText}>
          <Text style={[text('label'), styles.panelLabel]}>{en.qrTitle}</Text>
          <Text style={[text('displayS'), styles.panelId]}>
            {en.memberIdPrefix}
            {memberId}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <>
      <Countdown secondsRemaining={secondsRemaining} memberId={memberId} />
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`Payment code for member ${memberId}, refreshes in ${secondsRemaining} seconds`}
        accessibilityHint={en.tapEnlarge}
        style={styles.panel}
      >
        <View style={styles.qrBox}>
          <QRCode
            value={walletTokenUri(token.memberId, token.token)}
            size={QR_SIZE}
            color={color.ink}
            backgroundColor={WHITE}
          />
        </View>
        <View style={styles.panelText}>
          <Text style={[text('label'), styles.panelLabel]}>{en.qrTitle}</Text>
          <Text style={[text('displayS'), styles.panelId]}>
            {en.memberIdPrefix}
            {memberId}
          </Text>
          <Text style={[text('bodyS'), styles.panelHint]}>
            {en.qrHint} {secondsRemaining}
            {en.sec} · {en.tapEnlarge}
          </Text>
        </View>
      </Pressable>
    </>
  );
}

/**
 * interaction-spec.md §2: the countdown gets a polite live region, but it
 * announces every 15 seconds — not every tick. A screen reader reciting 45
 * numbers while someone stands at a till is unusable.
 */
function Countdown({ secondsRemaining, memberId }: { secondsRemaining: number; memberId: string }) {
  const lastAnnounced = useRef<number | null>(null);
  useEffect(() => {
    if (secondsRemaining % 15 !== 0 || secondsRemaining === 0) return;
    if (lastAnnounced.current === secondsRemaining) return;
    lastAnnounced.current = secondsRemaining;
    AccessibilityInfo.announceForAccessibility(
      `Payment code for member ${memberId} refreshes in ${secondsRemaining} seconds`,
    );
  }, [secondsRemaining, memberId]);
  return null;
}

const styles = StyleSheet.create({
  panel: {
    width: '100%',
    marginTop: 20,
    minHeight: MIN_TAP_TARGET,
    backgroundColor: WHITE,
    borderRadius: radius.card,
    padding: 15,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 15,
  },
  qrBox: {
    width: QR_SIZE,
    height: QR_SIZE,
    backgroundColor: WHITE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qrPlaceholder: {
    width: QR_SIZE,
    height: QR_SIZE,
    borderRadius: 8,
    backgroundColor: color.surfaceAlt2,
  },
  panelText: { flex: 1 },
  panelLabel: { color: color.textMuted },
  panelId: { color: color.ink, marginTop: 3 },
  panelHint: { color: color.brandDeep, marginTop: 9, fontWeight: '600' },

  unavailable: {
    marginTop: 18,
    backgroundColor: 'rgba(255,255,255,0.14)',
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: 'rgba(255,255,255,0.4)',
    borderRadius: radius.card,
    paddingVertical: 20,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  unavailableTitle: { color: WHITE, fontWeight: '600', textAlign: 'center' },
  unavailableBody: { color: 'rgba(255,255,255,0.85)', marginTop: 5, textAlign: 'center' },
});
