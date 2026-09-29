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

import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { fils, formatMoney, type Fils, type Salon } from '@avo/types';
import { MICRO_LABEL_COLOR, MIN_TAP_TARGET, color, radius, text } from '../theme';
import { useLanguage } from '../i18n/language';
import { focusable } from '../theme/focus';
import { TappableRow } from './Buttons';
import type { BookingView } from '../api/booking';
import { formatWhen, holdsDeposit } from '../domain/booking';
import { failureCopy, type LoadFailure } from '../domain/loadFailure';
import { cancelPreview, type CancelPreview } from '../domain/bookingPolicy';
import type { CancelBookingResult } from '../api/booking';
import { PolicyBlock, SettlementLines } from './booking/PolicyBlock';

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
  const started = failure?.code === 'appointment_started';
  /*
    ONE DERIVATION, READ BY THREE PLACES BELOW: the pill, the note under the
    buttons, and the refused-change body. Splitting the check across the three
    is how one of them survives the next edit still promising a refund.

    `depositFils`, never `source`, and never `status` — see
    `domain/booking.ts` § holdsDeposit.
  */
  const held = holdsDeposit(booking);
  /*
    THE POLICY THIS BOOKING WAS MADE UNDER (migration 0066), stamped on it at
    booking — never the salon's current one, which a later publish changes and
    this booking does not follow. `null` is a legacy booking: every sentence on
    this card is then exactly what it was. Drawn only when a deposit is held,
    because a policy decides nothing else.
  */
  const stamped = held ? booking.policy : null;

  /*
    THE CANCEL PREVIEW, and the instant it was computed. A policy cancel can keep
    money, so the first tap opens this rather than cancelling: what comes back
    at THIS moment under the stamped rule, in integer fils rounded down exactly
    as the server rounds. It is a sentence, not a decision (#2) — the cancel is
    sent regardless, and the cancelled card shows the server's own figures. A
    legacy booking returns everything and keeps its one-tap cancel.
  */
  const [preview, setPreview] = useState<CancelPreview | null>(null);
  const onCancelPress = () => {
    if (stamped === null) {
      onCancel();
      return;
    }
    setPreview(
      cancelPreview(
        stamped.cancellation,
        booking.startsAt,
        new Date(),
        booking.depositFils,
        // After a late move the server pays the smaller of this and the rule.
        booking.returnCapPercent,
      ),
    );
  };

  return (
    <View style={styles.card} testID="upcoming-card">
      <View style={styles.head}>
        <Text style={[text('label', lang), styles.headLabel]}>{copy.upcomingLabel}</Text>
        {/*
          ===================================================================
          THE PILL SAYS WHAT IS HELD, AND ON A MERCHANT BOOKING NOTHING IS
          ===================================================================
          A front desk can now create an appointment on an existing member's
          account, and `BookingSchema` § source makes it ALWAYS zero-deposit.
          This pill rendered `upDeposit` unconditionally, so that appointment
          arrived in her app wearing "0.000 KD held" — a figure that is not
          wrong so much as meaningless, sitting in the one slot on the card
          that is supposed to tell her where her money is.

          So at zero it says what the contract says it should say: "Booked".
          Not nothing — an empty slot where every other card carries a pill
          reads as an amount that failed to load, and this section already has
          a card whose whole existence is about not making that mistake
          (`UpcomingFailedCard`).

          The deposit still goes through `formatMoney` — the unit changes with
          the language along with the figure. A local 'KD' here is exactly how
          an Arabic build ends up reading "5.000 KD".
        */}
        <View style={held ? styles.depositPill : styles.statePill} testID="upcoming-pill">
          <Text
            style={[text('bodyS', lang, '600'), held ? styles.depositPillText : styles.statePillText]}
          >
            {held ? copy.upDeposit(formatMoney(booking.depositFils as Fils, lang)) : copy.upBooked}
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
          <Text style={[text('body', lang, '600'), styles.actionText]}>{copy.reschedule}</Text>
        </TappableRow>
        <TappableRow
          onPress={onCancelPress}
          disabled={busy || preview !== null}
          accessibilityRole="button"
          accessibilityLabel={copy.cancel}
          dataSet={focusable}
          testID="upcoming-cancel"
          style={[styles.action, styles.actionDanger, busy && styles.actionBusy]}
        >
          <Text style={[text('body', lang, '600'), styles.actionDangerText]}>{copy.cancel}</Text>
        </TappableRow>
      </View>

      {/*
        design:321 — the rule, stated inline, in the designer's own words.

        AND ITS SECOND SENTENCE IS DROPPED WHEN THERE IS NO DEPOSIT. "After that
        the deposit stays with the salon" is the cancellation consequence, and on
        a merchant-created appointment there is no deposit to stay anywhere. The
        first sentence — the rule itself — is true either way and is the
        designer's own, unedited. See copy/en.ts § reschedNoteNoDeposit.
      */}
      <Text style={[text('bodyS', lang), styles.note]} testID="upcoming-note">
        {stamped !== null ? copy.reschedNotePolicy : held ? copy.reschedNote : copy.reschedNoteNoDeposit}
      </Text>

      {stamped !== null ? <PolicyBlock terms={stamped} testID="upcoming-policy" /> : null}

      {/* Where the deposit went, once the server has settled it. */}
      {booking.settlement ? (
        <SettlementLines
          returnedFils={booking.settlement.returnedFils}
          keptFils={booking.settlement.keptFils}
          testID="upcoming-settlement"
        />
      ) : null}

      {preview !== null ? (
        <View style={styles.preview} testID="upcoming-cancel-preview">
          <Text style={[text('body', lang, '600'), styles.previewTitle]}>{copy.cancelPreviewTitle}</Text>
          <Text style={[text('bodyS', lang), styles.previewLine]} testID="upcoming-preview-back">
            {preview.returnedFils > 0
              ? copy.cancelPreviewBack(formatMoney(fils(preview.returnedFils), lang))
              : copy.cancelPreviewNothing}
          </Text>
          {preview.keptFils > 0 ? (
            <Text style={[text('bodyS', lang), styles.previewLine]} testID="upcoming-preview-kept">
              {copy.cancelPreviewKept(formatMoney(fils(preview.keptFils), lang))}
            </Text>
          ) : null}
          <View style={styles.previewActions}>
            <TappableRow
              onPress={() => setPreview(null)}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={copy.cancelKeep}
              dataSet={focusable}
              testID="upcoming-cancel-keep"
              style={[styles.action, busy && styles.actionBusy]}
            >
              <Text style={[text('body', lang, '600'), styles.actionText]}>{copy.cancelKeep}</Text>
            </TappableRow>
            <TappableRow
              onPress={() => {
                setPreview(null);
                onCancel();
              }}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={copy.cancelConfirm}
              dataSet={focusable}
              testID="upcoming-cancel-confirm"
              style={[styles.action, styles.actionDanger, busy && styles.actionBusy]}
            >
              <Text style={[text('body', lang, '600'), styles.actionDangerText]}>{copy.cancelConfirm}</Text>
            </TappableRow>
          </View>
        </View>
      ) : null}

      {failure ? (
        <View style={styles.refusal} accessibilityRole="alert" testID="upcoming-refusal">
          <Text style={[text('body', lang, '600'), styles.refusalTitle]}>
            {windowClosed ? copy.changeClosedTitle : started ? copy.cancelStartedTitle : copy.errorTitle}
          </Text>
          <Text style={[text('bodyS', lang), styles.refusalBody]}>
            {/*
              The refusal carries the same clause, and the same cut. A server
              that refuses a change on a zero-deposit booking is refusing the
              CHANGE; it is not keeping a deposit, because there is none.
            */}
            {windowClosed
              ? held && stamped === null
                ? copy.changeClosedBody
                : copy.changeClosedBodyNoDeposit
              : started
                ? copy.cancelStartedBody
                : failure.message}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/**
 * AFTER SHE CANCELS A POLICY BOOKING: what came back and what the salon kept,
 * in the SERVER's figures from the cancel result — never the preview she read
 * before tapping. If she crossed a cut-off in between, this is where she finds
 * out, and it is the true answer (#2).
 *
 * It stands where the booking stood until she taps Done, rather than in a
 * 3.4-second toast: a toast is fine for "your deposit is back", and not for
 * money she did not get back. A legacy cancel returns everything and keeps its
 * toast.
 */
export function CancelledCard({
  result,
  salon,
  serviceLabel,
  onDone,
}: {
  result: CancelBookingResult;
  salon: Salon;
  serviceLabel: string | null;
  onDone: () => void;
}) {
  const { lang, copy } = useLanguage();
  return (
    <View style={styles.card} testID="upcoming-cancelled">
      <Text style={[text('label', lang), styles.headLabel]}>{copy.upcomingLabel}</Text>
      <Text style={[text('displayS', lang), styles.emptyTitle]}>{copy.cancelledToastNoDeposit}</Text>
      <Text style={[text('body', lang), styles.meta]}>
        {serviceLabel ? `${serviceLabel} · ` : ''}
        {formatWhen(result.booking.startsAt, salon.timezone, lang)}
      </Text>
      <SettlementLines
        returnedFils={result.refundedFils}
        keptFils={result.keptFils}
        testID="cancelled-settlement"
      />
      <TappableRow
        onPress={onDone}
        accessibilityRole="button"
        dataSet={focusable}
        testID="upcoming-cancelled-done"
        style={[styles.action, styles.emptyAction]}
      >
        <Text style={[text('body', lang, '600'), styles.actionText]}>{copy.done}</Text>
      </TappableRow>
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
        <Text style={[text('body', lang, '600'), styles.actionText]}>{copy.noUpcomingAction}</Text>
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
/**
 * The appointment read failed — and WHICH failure decides what this says.
 *
 * This hardcoded `copy.errorTitle` / `copy.errorBody` and took no kind at all,
 * so an offline customer was told "This is on our side" about her own signal,
 * and a `forbidden` got a Try again that could only fail again. Driven against
 * lane B with the API answering 503: the card read "We couldn't load your wallet
 * · Your balance and history are safe. This is on our side." with the wallet
 * card rendered, correctly, immediately above it.
 *
 * `useUpcoming` had been carrying `failure: LoadFailure` the whole time; the
 * kind simply was not being asked for. See `failureCopy` in domain/loadFailure.ts
 * — the resolution is shared with `FailureScreen` so the two cannot drift.
 */
export function UpcomingFailedCard({
  failure,
  onRetry,
}: {
  /** Null only if a caller has none; treated as ours, which offers the retry. */
  failure: LoadFailure | null;
  onRetry: () => void;
}) {
  const { lang, copy } = useLanguage();
  const { title, body, canRetry } = failureCopy(
    failure?.kind ?? 'server',
    failure?.message ?? copy.errorBody,
    copy,
  );
  return (
    <View style={styles.card} accessibilityRole="alert" testID="upcoming-failed">
      <Text style={[text('label', lang), styles.headLabel]}>{copy.upcomingLabel}</Text>
      <Text style={[text('displayS', lang), styles.emptyTitle]}>{title}</Text>
      <Text style={[text('body', lang), styles.meta]}>{body}</Text>
      {canRetry ? (
        <TappableRow
          onPress={onRetry}
          accessibilityRole="button"
          dataSet={focusable}
          testID="upcoming-retry"
          style={[styles.action, styles.emptyAction]}
        >
          <Text style={[text('body', lang, '600'), styles.actionText]}>{copy.tryAgain}</Text>
        </TappableRow>
      ) : null}
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
  depositPillText: { color: color.brandDeep },
  /*
    THE ZERO-DEPOSIT PILL IS NEUTRAL, NOT BRANDED, and the geometry is identical
    so the card does not move when the pill changes word.

    The brand tint is this card's way of pointing at money — it is the same
    treatment the balance and the top-up tiles wear. "Booked" is a state, not an
    amount, and dressing it in the money colour would make a merchant-created
    appointment look like it carries a figure the customer has not read yet.
    `surfaceAlt2` + `textMutedStrong` is the pair the scanner's own source pill
    uses and it is already measured against AA.
  */
  statePill: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: radius.pill,
    backgroundColor: color.surfaceAlt2,
  },
  statePillText: { color: color.textMutedStrong },
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
  actionText: { color: color.ink },
  // design:319 — the cancel button carries the danger outline, not a red fill.
  // Returning a deposit is deliberate, not alarming.
  actionDanger: { borderColor: 'rgba(176,115,111,0.4)' },
  actionDangerText: { color: color.dangerText },
  emptyAction: { flex: 0, alignSelf: 'flex-start', marginTop: 14, paddingHorizontal: 22 },

  note: { color: color.textMutedSoft, marginTop: 9, lineHeight: 18 },

  // The cancel preview: the refusal panel's geometry on a neutral wash — it is a
  // question, not an error.
  preview: {
    marginTop: 12,
    padding: 12,
    borderRadius: 12,
    backgroundColor: color.surfaceAlt2,
  },
  previewTitle: { color: color.ink },
  previewLine: { color: color.textMutedStrong, marginTop: 3, lineHeight: 18 },
  previewActions: { flexDirection: 'row', gap: 9, marginTop: 12 },

  refusal: {
    marginTop: 12,
    padding: 12,
    borderRadius: 12,
    backgroundColor: color.dangerBg,
  },
  refusalTitle: { color: color.dangerText },
  refusalBody: { color: color.dangerText, marginTop: 3, lineHeight: 18 },

  bar: { height: 12, borderRadius: 6, backgroundColor: color.surfaceAlt2 },
  barThin: { height: 10 },
});
