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
import type { WalletToken } from '@avo/types';
import { color, radius, text, MIN_TAP_TARGET, WHITE } from '../theme';
import { useCopy, useLanguage } from '../i18n/language';
import { toEasternDigits } from '../i18n/digits';

const QR_SIZE = 92;

interface Props {
  memberId: string;
  token: WalletToken | null;
  secondsRemaining: number;
  unavailable: 'offline' | 'failed' | null;
  onPress: () => void;
}

/**
 * The member id, held left-to-right inside an Arabic column.
 *
 * "AVO-1204" is a Latin identifier and bidi will happily reorder the run around
 * it in an RTL paragraph. U+2066/U+2069 (LRI…PDI) isolate it so it reads the
 * same in both languages — the design does the same thing with `direction:ltr`
 * on its id and phone rows (AVO Wallet Home.dc.html:403, :455).
 */
function MemberId({ memberId, prefix }: { memberId: string; prefix: string }) {
  return (
    <Text style={[text('displayS'), styles.panelId]}>
      {prefix}
      {'⁦'}
      {memberId}
      {'⁩'}
    </Text>
  );
}

export function PaymentCode({ memberId, token, secondsRemaining, unavailable, onPress }: Props) {
  const { lang, copy } = useLanguage();

  if (unavailable) {
    return (
      <View style={styles.unavailable} accessibilityRole="summary">
        <Text style={[text('body', lang), styles.unavailableTitle]}>
          {unavailable === 'offline' ? copy.qrOfflineTitle : copy.qrFailedTitle}
        </Text>
        <Text style={[text('bodyS', lang), styles.unavailableBody]}>
          {unavailable === 'offline' ? copy.qrOfflineBody : copy.qrFailedBody}
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
          <Text style={[text('label', lang), styles.panelLabel]}>{copy.qrTitle}</Text>
          <MemberId memberId={memberId} prefix={copy.memberIdPrefix} />
        </View>
      </View>
    );
  }

  // The countdown is a COUNT, not money, so Arabic gets Eastern digits — the
  // rule the whole i18n/digits module exists for.
  const seconds = lang === 'ar' ? toEasternDigits(secondsRemaining) : String(secondsRemaining);

  return (
    <>
      <Countdown secondsRemaining={secondsRemaining} memberId={memberId} />
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={copy.qrAria(memberId, secondsRemaining)}
        accessibilityHint={copy.tapEnlarge}
        style={styles.panel}
      >
        <View style={styles.qrBox}>
          {/*
            The SERVER's string, not one composed here. `uri` was being stripped
            by the contract, so this re-derived it with walletTokenUri() — two
            implementations of a bearer credential's format, and the scanner
            parsing whichever one it met. The server mints the token; it mints
            how the token is written down too.
          */}
          <QRCode
            value={token.uri}
            size={QR_SIZE}
            color={color.ink}
            backgroundColor={WHITE}
          />
        </View>
        <View style={styles.panelText}>
          <Text style={[text('label', lang), styles.panelLabel]}>{copy.qrTitle}</Text>
          <MemberId memberId={memberId} prefix={copy.memberIdPrefix} />
          <Text style={[text('bodyS', lang), styles.panelHint]}>
            {copy.qrHint} {seconds}
            {copy.sec} · {copy.tapEnlarge}
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
  const copy = useCopy();
  const lastAnnounced = useRef<number | null>(null);
  // Read through a ref so a language switch does not re-run the effect and fire
  // a duplicate announcement at the same second count.
  const copyRef = useRef(copy);
  copyRef.current = copy;

  useEffect(() => {
    if (secondsRemaining % 15 !== 0 || secondsRemaining === 0) return;
    if (lastAnnounced.current === secondsRemaining) return;
    lastAnnounced.current = secondsRemaining;
    AccessibilityInfo.announceForAccessibility(copyRef.current.qrAria(memberId, secondsRemaining));
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
