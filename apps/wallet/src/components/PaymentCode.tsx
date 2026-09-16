/**
 * The payment code panel that sits inside the wallet card.
 *
 * Three renderings, and which one shows is decided entirely by facts the server
 * supplied:
 *
 *   a live token   → the QR, the member id, and the real countdown to expiry
 *   offline        → the dashed "unavailable offline" panel from AVO States
 *   token failed   → the same panel, with retry copy AND a retry
 *
 * There is no fourth branch where the client shows something plausible. A code
 * that will not scan is worse than no code, because the customer finds out at
 * the counter and it looks like the salon's fault (interaction-spec.md §4).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE TAP USED TO REFRESH THE CODE WHILE PROMISING TO ENLARGE IT.
 *
 * `accessibilityHint` was `copy.tapEnlarge`, the panel read "Refreshes in 37s ·
 * Tap to enlarge", and `onPress` was bound to `walletToken.refresh`. Driven:
 * tapping moved the countdown 36s → 45s and rendered no overlay. So a customer
 * holding her code up to a cashier and tapping to make it bigger silently got a
 * DIFFERENT code — while the cashier was scanning the one that had just been
 * replaced. The overlay the design specifies (design:641-643) simply did not
 * exist, and the affordance for it had been wired to the nearest available verb.
 *
 * WHERE REFRESH WENT, AND WHY. A token is now replaced in exactly two ways, and
 * neither is a tap on a working code:
 *
 *   1. automatically, when the server's `expiresAt` passes. `useWalletToken`
 *      already does this and always did; the 45 seconds is the server's number,
 *      not a constant here. This is the only refresh a live code needs, and
 *      non-negotiable #2 is why: the client does not decide when a bearer
 *      credential is replaced.
 *   2. explicitly, on the FAILED panel, where `qrFailedBody` already said "Try
 *      again to show a valid code at the salon" and — until now — gave her
 *      nothing to tap.
 *
 * ASSUMPTION, FLAGGED: the design specifies no manual refresh for a WORKING
 * code, so removing one is not covered by anything written down. It is the
 * least surprising reading — every description of this control is "regenerates/
 * rotates token every 45s with countdown; tap to enlarge" (README:189) — and a
 * customer has no reason to prefer a different code to the one she is already
 * holding up. If a manual rotate is wanted for a code a scanner keeps refusing,
 * that is a product decision and a second control, not this tap.
 *
 * The offline panel deliberately has NO retry: `qrOfflineBody` says "Reconnect",
 * a token fetch on a dead connection only fails again, and Home already carries
 * a screen-level "Try again".
 *
 * WHERE THE OVERLAY ITSELF LIVES. Not here — `HomeScreen`'s `Shell` renders it
 * as a sibling of the ScrollView. It was a child of this panel for one driven
 * run, and the result is the failure `Shell`'s own comment describes: `position:
 * absolute` resolves against the wallet card, so a "full-screen" overlay came up
 * clipped inside the card with the branch chips showing through it. `Shell` had
 * written that down; this had to rediscover it.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { useEffect, useRef } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { color, radius, text, MIN_TAP_TARGET, WHITE } from '../theme';
import { useCopy, useLanguage } from '../i18n/language';
import { toEasternDigits } from '../i18n/digits';
import type { PaymentCodeView } from '../domain/paymentCode';

const QR_SIZE = 92;

interface Props {
  memberId: string;
  /**
   * Resolved by `HomeScreen`, not here — `QrOverlay` has to be a sibling of the
   * ScrollView rather than a descendant of the wallet card (see `Shell`), so the
   * screen and this panel have to agree about which rendering is on. One
   * `paymentCodeView()` call, read by both.
   */
  view: PaymentCodeView;
  secondsRemaining: number;
  /** Opens the enlarged overlay. Called only from the `ready` branch. */
  onEnlarge: () => void;
  /** Re-asks the server for a token. Reachable only from the FAILED panel. */
  onRetry: () => void;
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

export function PaymentCode({ memberId, view, secondsRemaining, onEnlarge, onRetry }: Props) {
  const { lang, copy } = useLanguage();

  if (view.kind === 'unavailable') {
    const body = (
      <>
        <Text style={[text('body', lang, '600'), styles.unavailableTitle]}>
          {view.reason === 'offline' ? copy.qrOfflineTitle : copy.qrFailedTitle}
        </Text>
        <Text style={[text('bodyS', lang), styles.unavailableBody]}>
          {view.reason === 'offline' ? copy.qrOfflineBody : copy.qrFailedBody}
        </Text>
      </>
    );
    return view.canRetry ? (
      <Pressable
        onPress={onRetry}
        accessibilityRole="button"
        accessibilityLabel={copy.qrFailedTitle}
        accessibilityHint={copy.qrFailedBody}
        style={styles.unavailable}
        testID="payment-code-retry"
      >
        {body}
      </Pressable>
    ) : (
      <View style={styles.unavailable} accessibilityRole="summary" testID="payment-code-offline">
        {body}
      </View>
    );
  }

  if (view.kind === 'pending') {
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
        // The tap now does what the hint has always said it does. It is reached
        // only from the `ready` branch, so it cannot ask for an overlay over a
        // code that does not exist.
        onPress={onEnlarge}
        accessibilityRole="button"
        accessibilityLabel={copy.qrAria(memberId, secondsRemaining)}
        accessibilityHint={copy.tapEnlarge}
        style={styles.panel}
        testID="payment-code-panel"
      >
        <View style={styles.qrBox}>
          {/*
            The SERVER's string, not one composed here. `uri` was being stripped
            by the contract, so this re-derived it with walletTokenUri() — two
            implementations of a bearer credential's format, and the scanner
            parsing whichever one it met. The server mints the token; it mints
            how the token is written down too.
          */}
          <QRCode value={view.token.uri} size={QR_SIZE} color={color.ink} backgroundColor={WHITE} />
        </View>
        <View style={styles.panelText}>
          <Text style={[text('label', lang), styles.panelLabel]}>{copy.qrTitle}</Text>
          <MemberId memberId={memberId} prefix={copy.memberIdPrefix} />
          <Text style={[text('bodyS', lang, '600'), styles.panelHint]}>
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
  panelHint: { color: color.brandDeep, marginTop: 9 },

  unavailable: {
    marginTop: 18,
    // The failed panel is now a control, so it carries the tap-target floor.
    minHeight: MIN_TAP_TARGET,
    backgroundColor: 'rgba(255,255,255,0.14)',
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: 'rgba(255,255,255,0.4)',
    borderRadius: radius.card,
    paddingVertical: 20,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  unavailableTitle: { color: WHITE, textAlign: 'center' },
  unavailableBody: { color: 'rgba(255,255,255,0.85)', marginTop: 5, textAlign: 'center' },
});
