/**
 * The salon's current booking policy, opened from the bell's `booking_policy`
 * row ("<Salon> updated its booking policy").
 *
 * The notice carries a version and no text: the bell is a pointer, and the
 * policy is read here, fresh, from `GET /salons/{id}/booking-policy`. So what she
 * reads is the salon's CURRENT version — the one her next booking would be made
 * under — even when a second publish the same day was coalesced into the notice.
 *
 * Four states, like every read (interaction-spec.md §4): a skeleton bar while
 * it loads, the failure with a retry, `null` said in words, and the policy.
 */

import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { BookingPolicy } from '@avo/types';
import { color, text } from '../theme';
import { useLanguage } from '../i18n/language';
import { getBookingPolicy } from '../api/booking';
import { toLoadFailure, type LoadFailure } from '../domain/loadFailure';
import { Sheet } from './Sheet';
import { SecondaryButton } from './Buttons';
import { PolicyBlock } from './booking/PolicyBlock';

type Read =
  | { status: 'loading' }
  | { status: 'ready'; policy: BookingPolicy | null }
  | { status: 'failed'; failure: LoadFailure };

export function BookingPolicySheet({
  salonId,
  onClose,
}: {
  /** The salon whose policy to read; `null` is closed. */
  salonId: string | null;
  onClose: () => void;
}) {
  const { lang, copy } = useLanguage();
  const [read, setRead] = useState<Read>({ status: 'loading' });
  const [token, setToken] = useState(0);

  useEffect(() => {
    if (salonId === null) return;
    const controller = new AbortController();
    setRead({ status: 'loading' });
    getBookingPolicy(salonId, controller.signal)
      .then((policy) => setRead({ status: 'ready', policy }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setRead({ status: 'failed', failure: toLoadFailure(err) });
      });
    return () => controller.abort();
  }, [salonId, token]);

  return (
    <Sheet
      open={salonId !== null}
      dismissible
      onDismiss={onClose}
      label={copy.policyTitle}
      testID="booking-policy-sheet"
    >
      {read.status === 'loading' ? (
        <View accessibilityLabel={copy.loadingAria} testID="booking-policy-loading">
          <View style={[styles.bar, { width: '48%' }]} />
          <View style={[styles.bar, { width: '82%', marginTop: 10 }]} />
        </View>
      ) : read.status === 'failed' ? (
        <View accessibilityRole="alert" testID="booking-policy-failed">
          <Text style={[text('body', lang), styles.failed]}>{copy.policyLoadFailed}</Text>
          <SecondaryButton
            label={copy.tryAgain}
            onPress={() => setToken((t) => t + 1)}
            testID="booking-policy-retry"
          />
        </View>
      ) : read.policy === null ? (
        <Text style={[text('body', lang), styles.none]} testID="booking-policy-none">
          {copy.policyNone}
        </Text>
      ) : (
        <PolicyBlock terms={read.policy} testID="bell-policy" />
      )}
      <View style={styles.footer}>
        <SecondaryButton label={copy.txClose} onPress={onClose} testID="booking-policy-close" />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  bar: { height: 12, borderRadius: 6, backgroundColor: color.surfaceAlt2 },
  failed: { color: color.dangerText, marginBottom: 12 },
  none: { color: color.textMuted },
  footer: { paddingTop: 14 },
});
