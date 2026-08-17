/**
 * Home · the upcoming appointment. design/AVO Wallet Home.dc.html:312-322.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ONE-HOUR RULE IS STATED, NOT ENFORCED, BY THIS COMPONENT
 * ═══════════════════════════════════════════════════════════════════════════
 * Both buttons stay live right up to the appointment and the refusal comes from
 * the server as `409 change_window_closed`. Disabling them on a client-side
 * clock comparison would be wrong in both directions and invisibly so:
 *
 *   phone four minutes fast  → a cancel the salon would still have honoured is
 *                              hidden, and her deposit stays with the salon.
 *   phone four minutes slow  → a cancel is offered that the server refuses, and
 *                              the button appears broken.
 *
 * The client's clock is not the one that counts. `changeableUntil` is on the
 * booking so the sentence can be accurate; the decision is still the server's.
 *
 * design:321 states the rule inline — "Free until an hour before. After that the
 * deposit stays with the salon." — and that string is the designer's, verbatim,
 * in both languages.
 */

import { StyleSheet, Text, View } from 'react-native';
import { formatMoney, type Fils, type Salon } from '@avo/types';
import { MICRO_LABEL_COLOR, MIN_TAP_TARGET, color, radius, text } from '../theme';
import { useLanguage } from '../i18n/language';
import { focusable } from '../theme/focus';
import { TappableRow } from './Buttons';
import type { BookingView } from '../api/booking';
import { formatWhen } from '../domain/booking';

interface Props {
  booking: BookingView;
  salon: Salon;
  /** The artist's display name, resolved by the caller — it needs the roster. */
  artistLabel: string | null;
  /** The service's name, resolved by the caller for the same reason. */
  serviceLabel: string | null;
  onReschedule: () => void;
  onCancel: () => void;
  busy: boolean;
  /** A refused change — `change_window_closed` is the one worth its own words. */
  failure: { code: string | null; message: string } | null;
}

export function UpcomingCard({
  booking,
  salon,
  artistLabel,
  serviceLabel,
  onReschedule,
  onCancel,
  busy,
  failure,
}: Props) {
  const { lang, copy } = useLanguage();
  const windowClosed = failure?.code === 'change_window_closed';

  return (
    <View style={styles.card} testID="upcoming-card">
      <View style={styles.head}>
        <Text style={[text('label', lang), styles.headLabel]}>{copy.upcomingLabel}</Text>
        <View style={styles.depositPill}>
          {/*
            The deposit, through `formatMoney` — the unit changes with the
            language along with the figure. A local 'KD' here is exactly how an
            Arabic build ends up reading "5.000 KD".
          */}
          <Text style={[text('bodyS', lang), styles.depositPillText]}>
            {copy.upDeposit(formatMoney(booking.depositFils as Fils, lang))}
          </Text>
        </View>
      </View>

      {/*
        The service and artist names come from the caller because the booking
        carries ids alone. When the roster could not be read — `GET
        /salons/{id}/artists` is `perms.team` gated, see api/booking.ts — the
        row falls back to an em dash rather than to an id a customer cannot read.
      */}
      <Text style={[text('displayS', lang), styles.service]}>{serviceLabel ?? '—'}</Text>
      <Text style={[text('body', lang), styles.meta]}>
        {artistLabel ? `${copy.upWith(artistLabel)} · ` : ''}
        {formatWhen(booking.startsAt, salon.timezone, lang)}
      </Text>

      <View style={styles.actions}>
        <TappableRow
          onPress={onReschedule}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={copy.reschedule}
          dataSet={focusable}
          testID="upcoming-reschedule"
          style={[styles.action, busy && styles.actionBusy]}
        >
          <Text style={[text('body', lang), styles.actionText]}>{copy.reschedule}</Text>
        </TappableRow>
        <TappableRow
          onPress={onCancel}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={copy.cancel}
          dataSet={focusable}
          testID="upcoming-cancel"
          style={[styles.action, styles.actionDanger, busy && styles.actionBusy]}
        >
          <Text style={[text('body', lang), styles.actionDangerText]}>{copy.cancel}</Text>
        </TappableRow>
      </View>

      {/* design:321 — the rule, stated inline, in the designer's own words. */}
      <Text style={[text('bodyS', lang), styles.note]}>{copy.reschedNote}</Text>

      {failure ? (
        <View style={styles.refusal} accessibilityRole="alert" testID="upcoming-refusal">
          <Text style={[text('body', lang), styles.refusalTitle]}>
            {windowClosed ? copy.changeClosedTitle : copy.errorTitle}
          </Text>
          <Text style={[text('bodyS', lang), styles.refusalBody]}>
            {windowClosed ? copy.changeClosedBody : failure.message}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/**
 * The empty state — no appointment held.
 *
 * States:112-119: name the thing, offer the one action that fills it. It sits
 * where the card would be rather than the section disappearing, because a
 * section that vanishes reads as a screen that failed to load part of itself.
 */
export function NoUpcomingCard({ onBook }: { onBook: () => void }) {
  const { lang, copy } = useLanguage();
  return (
    <View style={styles.card} testID="upcoming-empty">
      <Text style={[text('label', lang), styles.headLabel]}>{copy.upcomingLabel}</Text>
      <Text style={[text('displayS', lang), styles.emptyTitle]}>{copy.noUpcomingTitle}</Text>
      <Text style={[text('body', lang), styles.meta]}>{copy.noUpcomingBody}</Text>
      <TappableRow
        onPress={onBook}
        accessibilityRole="button"
        dataSet={focusable}
        testID="upcoming-book"
        style={[styles.action, styles.emptyAction]}
      >
        <Text style={[text('body', lang), styles.actionText]}>{copy.noUpcomingAction}</Text>
      </TappableRow>
    </View>
  );
}

/**
 * The failed state — and it is NOT the empty state.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS EXISTS BECAUSE THE EMPTY CARD WAS SHOWN FOR A FAILED READ
 * ═══════════════════════════════════════════════════════════════════════════
 * Home rendered "No appointment booked" whenever `nextAppointment` came back
 * null, and a failed `GET /bookings` produces exactly that. It was caught by
 * driving a real booking with the API down: the deposit had left the balance,
 * the activity feed said "Deposit held −5.000", and the card underneath told
 * the customer she had no appointment.
 *
 * That is the worst possible reading of a network failure — it says her money
 * went somewhere and bought nothing. interaction-spec.md §4 separates "we
 * failed" from "there is nothing here" for exactly this reason, and the two
 * were collapsed. So a failure now says so, and offers the retry.
 */
export function UpcomingFailedCard({ onRetry }: { onRetry: () => void }) {
  const { lang, copy } = useLanguage();
  return (
    <View style={styles.card} accessibilityRole="alert" testID="upcoming-failed">
      <Text style={[text('label', lang), styles.headLabel]}>{copy.upcomingLabel}</Text>
      <Text style={[text('displayS', lang), styles.emptyTitle]}>{copy.errorTitle}</Text>
      <Text style={[text('body', lang), styles.meta]}>{copy.errorBody}</Text>
      <TappableRow
        onPress={onRetry}
        accessibilityRole="button"
        dataSet={focusable}
        testID="upcoming-retry"
        style={[styles.action, styles.emptyAction]}
      >
        <Text style={[text('body', lang), styles.actionText]}>{copy.tryAgain}</Text>
      </TappableRow>
    </View>
  );
}

/** The loading state. A bar, never a rendered amount — interaction-spec.md §4. */
export function UpcomingSkeleton() {
  const { lang, copy } = useLanguage();
  return (
    <View style={styles.card} accessibilityLabel={copy.loadingAria}>
      <Text style={[text('label', lang), styles.headLabel]}>{copy.upcomingLabel}</Text>
      <View style={[styles.bar, { width: '58%', marginTop: 10 }]} />
      <View style={[styles.bar, styles.barThin, { width: '40%', marginTop: 9 }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: 22,
    padding: 17,
    borderRadius: radius.cardLg,
    backgroundColor: color.white,
    borderWidth: 1,
    borderColor: color.hairline,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    marginBottom: 10,
  },
  headLabel: { color: MICRO_LABEL_COLOR },
  depositPill: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: radius.pill,
    backgroundColor: color.brandTint,
  },
  // Brand text on a light surface is brandDeep, never brand — #9.
  depositPillText: { color: color.brandDeep, fontWeight: '600' },
  service: { color: color.ink },
  emptyTitle: { color: color.ink, marginTop: 10 },
  meta: { color: color.textMuted, marginTop: 2 },

  actions: {
    // `row` is already a logical direction on both targets, so the pair mirrors
    // in Arabic with no conditional. See i18n/rtl.ts.
    flexDirection: 'row',
    gap: 9,
    marginTop: 13,
    paddingTop: 13,
    borderTopWidth: 1,
    borderTopColor: color.hairline,
  },
  action: {
    flex: 1,
    minHeight: MIN_TAP_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 11,
    borderRadius: 12,
    backgroundColor: color.white,
    borderWidth: 1,
    borderColor: color.borderControl,
  },
  actionBusy: { opacity: 0.5 },
  actionText: { color: color.ink, fontWeight: '600' },
  // design:319 — the cancel button carries the danger outline, not a red fill.
  // Returning a deposit is deliberate, not alarming.
  actionDanger: { borderColor: 'rgba(176,115,111,0.4)' },
  actionDangerText: { color: color.dangerText, fontWeight: '600' },
  emptyAction: { flex: 0, alignSelf: 'flex-start', marginTop: 14, paddingHorizontal: 22 },

  note: { color: color.textMutedSoft, marginTop: 9, lineHeight: 18 },

  refusal: {
    marginTop: 12,
    padding: 12,
    borderRadius: 12,
    backgroundColor: color.dangerBg,
  },
  refusalTitle: { color: color.dangerText, fontWeight: '600' },
  refusalBody: { color: color.dangerText, marginTop: 3, lineHeight: 18 },

  bar: { height: 12, borderRadius: 6, backgroundColor: color.surfaceAlt2 },
  barThin: { height: 10 },
});
