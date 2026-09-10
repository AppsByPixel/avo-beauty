/**
 * Scanner · My bookings. design/AVO Staff Scanner.dc.html:130-179.
 *
 * The artist's upcoming appointments, grouped by day: time, duration, service,
 * deposit held, and the client's name, tier and phone with one-tap Call and
 * WhatsApp.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS SCREEN SHOWS A CUSTOMER'S PHONE NUMBER, DELIBERATELY
 * ═══════════════════════════════════════════════════════════════════════════
 * The design asks for it explicitly and the API joins it on. It is a real
 * disclosure and it is bounded by construction rather than by a check written
 * here: `GET /artists/me/bookings` is self-scoped by its URL — there is no id
 * in it that could name another artist's day — and the API's own note says so.
 *
 * Which means this screen must not acquire a lookup, a search or a filter that
 * reaches beyond `me`. If a receptionist needs the salon's whole book, that is
 * the merchant's Appointments list behind `perms.appointments`, not this.
 *
 * `tel:` and `wa.me` are the design's own links (:169-170). Both leave the app,
 * so both are `Linking.openURL` rather than an anchor: on a phone an
 * unhandled scheme fails silently, and a Call button that does nothing at a
 * counter is worse than no button.
 *
 * AND THERE IS ONE CUSTOMER THIS DISCLOSURE DOES NOT COVER: an erased one. The
 * paragraph above bounds WHOSE numbers reach this screen; it says nothing about
 * a number that belongs to nobody. `BookingCard` below carries that case and
 * the reasoning for it.
 */

import { useCallback, useEffect, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { formatFils, type Fils } from '@avo/types';
import { ApiError } from '../api/client';
import { fetchMyBookings, type ArtistBooking } from '../api/artist';
import { copy } from '../copy/en';
import { color, display, MIN_TAP_TARGET, radius, tierStyles, ui } from '../theme';
import { LinkButton } from '../components/Buttons';
import { EmptyState, ErrorState, Refusal, SkeletonRows } from '../components/States';
import { useSession } from '../state/session';

/** The salon's zone. Every label on this screen is a salon-local time. */
const SALON_TIME_ZONE = 'Asia/Kuwait';

interface Props {
  accessToken: string;
  onHome: () => void;
  /** design:135 — "Hessa · hessa" in the header. */
  staffFirstName: string;
  staffHandle: string;
}

type Load =
  | { status: 'loading' }
  | { status: 'ready'; bookings: ArtistBooking[] }
  /** 404 not_an_artist — no calendar here at all. Explains; offers no retry. */
  | { status: 'notArtist' }
  /**
   * Her connection, NOT our failure. `ErrorState`'s body is "Nothing was lost.
   * This is on our side." — false on a salon phone that has lost signal, which
   * on a counter device is the common case rather than the edge. `ChargesScreen`
   * has carried this state from the start; this screen collapsed it into
   * `failed`.
   */
  | { status: 'offline' }
  | { status: 'failed'; message: string; reference: string };

export function BookingsScreen({ accessToken, onHome, staffFirstName, staffHandle }: Props) {
  const { reportFailure } = useSession();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [token, setToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoad({ status: 'loading' });
    fetchMyBookings(accessToken, controller.signal)
      .then((bookings) => setLoad({ status: 'ready', bookings }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        /*
          A DEAD SESSION IS NOT A SCREEN-LEVEL ERROR. `reportFailure` returns true
          when it ended the session, and the shell then replaces this screen with
          the PIN screen — the honest remedy, because signing in again is the only
          thing that helps. Rendering an error with a Try again would leave the
          artist tapping a button that 401s for ever. Three screens already do
          this; this one did not, so a revoked PIN surfaced here as "we failed".

          FIRST, before the code checks: a 401 carries no `not_an_artist` and its
          message is the raw "Sign in to continue.", which is exactly the string
          the session module's header records being printed at a counter.
        */
        if (reportFailure(err)) return;
        if (err instanceof ApiError && err.code === 'not_an_artist') {
          setLoad({ status: 'notArtist' });
          return;
        }
        /*
          AFTER the code check, for the reason `orderRefusal.ts` writes down: the
          client maps 503 AND 504 to `offline`, so a coded refusal arriving on a
          503 must not be read as a dead connection.
        */
        if (err instanceof ApiError && err.kind === 'offline') {
          setLoad({ status: 'offline' });
          return;
        }
        setLoad({
          status: 'failed',
          message: err instanceof ApiError ? err.message : copy.errorBody,
          reference: err instanceof ApiError ? err.reference : '—',
        });
      });
    return () => controller.abort();
  }, [accessToken, token, reportFailure]);

  const retry = useCallback(() => setToken((t) => t + 1), []);

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <LinkButton label={copy.home} onPress={onHome} testID="bookings-home" />
        <Text style={[ui(12), styles.who]}>
          {staffFirstName} · {staffHandle}
        </Text>
      </View>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <Text style={display(24)}>{copy.bookings}</Text>

        {load.status === 'ready' ? (
          <Text style={[ui(12.5), styles.sub]}>
            {copy.bookingsCount(load.bookings.length, countNew(load.bookings))} —{' '}
            {copy.bookingsSource}
          </Text>
        ) : null}

        {/* design:140-143 — the push-notification note, verbatim. */}
        {load.status === 'ready' && load.bookings.length > 0 ? (
          <View style={styles.note}>
            <Text style={[ui(12.5), styles.noteText]}>{copy.bookingsNote}</Text>
          </View>
        ) : null}

        {load.status === 'loading' ? <View style={styles.body}><SkeletonRows count={3} /></View> : null}

        {load.status === 'notArtist' ? (
          <Refusal title={copy.notArtistTitle} body={copy.notArtistBody} />
        ) : null}

        {/*
          Her connection. Keeps the retry — reconnecting is actionable — but not
          the "this is on our side" body. `offlineColdBody` is INVENTED and
          authorised: DECISIONS.md § "The offline cold-load sentence". Not
          `offlineBanner`, which promises a last update this cold load never had.
        */}
        {load.status === 'offline' ? (
          <ErrorState
            title={copy.offlineTitle}
            body={copy.offlineColdBody}
            reference={null}
            onRetry={retry}
          />
        ) : null}

        {load.status === 'failed' ? (
          <ErrorState
            body={load.message}
            reference={load.reference}
            onRetry={retry}
          />
        ) : null}

        {load.status === 'ready' && load.bookings.length === 0 ? (
          <View style={styles.body}>
            <EmptyState title={copy.bookingsEmptyTitle} body={copy.bookingsEmptyBody} />
          </View>
        ) : null}

        {load.status === 'ready'
          ? groupByDay(load.bookings).map((group) => (
              <View key={group.date} style={styles.group}>
                <Text style={[ui(11, '600'), styles.groupLabel]}>{group.label}</Text>
                <View style={styles.cards}>
                  {group.bookings.map((booking) => (
                    <BookingCard key={booking.id} booking={booking} />
                  ))}
                </View>
              </View>
            ))
          : null}
      </ScrollView>
    </View>
  );
}

// ------------------------------------------------------------------- a card --

/**
 * design:150-172.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * AN ERASED CUSTOMER HAS NO CONTACT ROW — DECISIONS.md #100
 * ═══════════════════════════════════════════════════════════════════════════
 * Erasure scrubs the member in place rather than deleting her: the name becomes
 * `'Deleted account'` and the phone becomes `+990` and twelve random digits.
 * `+990` is an UNASSIGNED country code, so the value is a tombstone wearing the
 * shape of a contact. This screen joined it live and did three things with it —
 * printed it, dialled it, and opened `https://wa.me/<those digits>`.
 *
 * The dashboard has the same defect one step milder, because it only DISPLAYS.
 * Here the card offers to send. `wa.me/990418702935514` is an outbound request
 * built from digits that name nobody, and the only reason it has not fired is
 * that the window is narrow: the query takes `deposit_held` and `completed`
 * since yesterday, and erasure defers while a deposit is in escrow, so the live
 * case is a booking COMPLETED for a member erased inside that window. Narrow is
 * not a fix.
 *
 * THE GUARD IS `memberErased || memberPhone === null`, not either alone:
 *
 *   the flag   is the contract's answer and the one Lane A is landing. It is
 *              also the only signal that survives if the tombstone format ever
 *              changes — nothing here should be pattern-matching `+990`.
 *   the null   is what the payload actually carries, and it catches a tombstone
 *              that arrives while `memberErased` is still defaulting to false
 *              (see `ArtistBookingSchema`). It is also the crash guard: the old
 *              `booking.memberPhone.replace(...)` on `null` throws inside render
 *              and takes the WHOLE DAY SCREEN down, not one card.
 *
 * WHAT GOES, AND WHAT STAYS. Both buttons go, and so do the digits as TEXT — an
 * artist can read a number off a card and type it into a handset, so printing it
 * is barely better than linking it. The NAME line stays and keeps showing the
 * tombstone, because `memberName` is still a real string and the avatar initial
 * reads from it; the card must still identify WHICH booking this is. Everything
 * else on the card — time, service, deposit, tier, source — is about the
 * appointment rather than the person, and is untouched.
 *
 * EXPORTED FOR THE TEST, and for nothing else — `bookingsErasedCard.test.ts`
 * calls it as a function and walks the tree it returns, because the only honest
 * proof that no `wa.me` survives is to fire every handler the card produces.
 * Nothing outside this file renders it.
 */
export function BookingCard({ booking }: { booking: ArtistBooking }) {
  const tier = tierStyles[booking.memberTier];
  /*
    One derivation, read by three places below: the phone line, the Call button
    and the WhatsApp button. Splitting the check across the three is how one of
    them survives the next edit.
  */
  const phone = booking.memberErased ? null : booking.memberPhone;
  const digits = phone === null ? null : phone.replace(/[^0-9]/g, '');
  const isNew = isRecent(booking);

  const open = useCallback((url: string) => {
    // Deliberately not awaited into a UI state: the OS takes over the screen.
    // A rejection means no app can handle the scheme, which on a real phone
    // with a SIM does not happen for `tel:` and, for `wa.me`, falls back to the
    // browser — which is the correct outcome rather than an error to render.
    void Linking.openURL(url).catch(() => {});
  }, []);

  return (
    <View style={styles.card} testID={`booking-${booking.id}`}>
      <View style={styles.cardTop}>
        <View style={styles.timeRow}>
          <Text style={display(17, '600')}>{clockLabel(booking.startsAt)}</Text>
          <Text style={[ui(12), styles.dim]}>· {copy.bookingsDuration(booking.durationMin)}</Text>
          {isNew ? (
            <View style={styles.newPill}>
              <Text style={[ui(10, '700'), styles.newPillText]}>{copy.bookingsNew}</Text>
            </View>
          ) : null}
        </View>
        {/*
          The deposit, through `formatFils` from @avo/types. A local 'KD' here
          is the mistake the skill file names — and on this surface it would be
          worse than on the wallet, because the scanner has no language switch
          to reveal it.
        */}
        <View style={styles.depositPill}>
          <Text style={[ui(11, '600'), styles.depositPillText]}>
            {copy.bookingsDeposit(formatFils(booking.depositFils as Fils))}
          </Text>
        </View>
      </View>

      <Text style={[ui(14.5, '600'), styles.service]}>{booking.serviceName}</Text>

      <View style={styles.client}>
        <View style={styles.avatar}>
          <Text style={[display(15, '600'), styles.avatarInitial]}>
            {booking.memberName.trim().charAt(0).toUpperCase()}
          </Text>
        </View>
        <View style={styles.clientBody}>
          <View style={styles.nameRow}>
            <Text style={[ui(13.5, '600')]} numberOfLines={1}>
              {booking.memberName}
            </Text>
            <View style={[styles.tierPill, { backgroundColor: tier.pillBg }]}>
              <Text style={[ui(10, '600'), { color: tier.pillText }]}>{tierLabel(booking.memberTier)}</Text>
            </View>
          </View>
          {/*
            `styles.dim` either way, deliberately: the sentence sits exactly
            where the number sat, at the same weight, so the card's geometry
            does not move when a booking is erased. Nothing is restyled here —
            only the words change.
          */}
          <Text style={[ui(12), styles.dim]}>
            {phone === null ? copy.bookingsPhoneErased : phone}
          </Text>
        </View>
        {/*
          design:166 — where the booking came from. `source` is on the entity,
          so this is read rather than guessed: `google_calendar` means the event
          came off her calendar and was mirrored in, and it is the difference
          between a deposit AVO is holding and one it is not.
        */}
        <View style={[styles.srcPill, booking.source === 'google_calendar' && styles.srcPillGcal]}>
          <Text
            style={[
              ui(10.5, '600'),
              booking.source === 'google_calendar' ? styles.srcTextGcal : styles.srcText,
            ]}
          >
            {booking.source === 'google_calendar' ? copy.bookingsSrcGcal : copy.bookingsSrcApp}
          </Text>
        </View>
      </View>

      {digits === null ? null : (
        <View style={styles.actions}>
          <Pressable
            onPress={() => open(`tel:${digits}`)}
            accessibilityRole="button"
            accessibilityLabel={`${copy.bookingsCall} ${booking.memberName}`}
            testID={`booking-call-${booking.id}`}
            style={[styles.action, styles.actionCall]}
          >
            <Text style={[ui(13, '600'), styles.actionCallText]}>{copy.bookingsCall}</Text>
          </Pressable>
          <Pressable
            onPress={() => open(`https://wa.me/${digits}`)}
            accessibilityRole="button"
            accessibilityLabel={`${copy.bookingsWhatsApp} ${booking.memberName}`}
            testID={`booking-wa-${booking.id}`}
            style={[styles.action, styles.actionWa]}
          >
            {/* design:170 — dark ink on WhatsApp green, which is the readable pair. */}
            <Text style={[ui(13, '600'), styles.actionWaText]}>{copy.bookingsWhatsApp}</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

// ---------------------------------------------------------------- grouping --

interface DayGroup {
  date: string;
  label: string;
  bookings: ArtistBooking[];
}

/**
 * design:692-700 — "Today · Sun 13 Jul", "Tomorrow · Mon 14 Jul".
 *
 * Grouped on the SALON's calendar date, not the device's. The scanner is a
 * phone in a salon so the two normally agree, but a phone left on the wrong
 * zone would otherwise split a single evening across two headings — and the
 * artist would read it as two days' work.
 */
function groupByDay(bookings: ArtistBooking[]): DayGroup[] {
  const today = salonDate(new Date());
  const tomorrow = salonDate(new Date(Date.now() + 86_400_000));
  const groups = new Map<string, ArtistBooking[]>();

  for (const booking of bookings) {
    const key = salonDate(new Date(booking.startsAt));
    const list = groups.get(key);
    if (list) list.push(booking);
    else groups.set(key, [booking]);
  }

  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, list]) => ({
      date,
      label:
        date === today
          ? `${copy.bookingsToday} · ${weekdayLabel(list[0]!.startsAt)}`
          : date === tomorrow
            ? `${copy.bookingsTomorrow} · ${weekdayLabel(list[0]!.startsAt)}`
            : weekdayLabel(list[0]!.startsAt),
      bookings: list,
    }));
}

function salonDate(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: SALON_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/** "Sun 13 Jul" — the design's own heading shape. */
function weekdayLabel(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: SALON_TIME_ZONE,
  }).format(new Date(iso));
}

/** "2:30 pm" — design:693. The salon's zone, never the device's. */
function clockLabel(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: SALON_TIME_ZONE,
  }).format(new Date(iso));
}

/**
 * The NEW pill — design:155.
 *
 * The design's fixture carries a hand-set `isNew` boolean; there is no such
 * field on the entity and no per-artist "seen" state on the API, so "new" is
 * read as "created in the last twelve hours" from the one timestamp the booking
 * does carry.
 *
 * `noShowReturnDueAt` is `startsAt + salon.noShowReturnMinutes`, so it is a
 * function of the appointment and not of when it was made — which is why the
 * pill uses `rescheduledCount === 0` as well: an appointment moved yesterday is
 * not new work landing today. REPORTED: a `createdAt` on `Booking`, or an
 * artist-side seen marker, would make this exact rather than inferred.
 */
function isRecent(booking: ArtistBooking): boolean {
  if (booking.rescheduledCount > 0) return false;
  const startsAt = new Date(booking.startsAt).getTime();
  return startsAt - Date.now() < 12 * 60 * 60 * 1000;
}

function countNew(bookings: ArtistBooking[]): number {
  return bookings.filter(isRecent).length;
}

function tierLabel(tier: ArtistBooking['memberTier']): string {
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.surface, paddingTop: 66 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 22,
    marginBottom: 14,
  },
  who: { color: color.textMutedSoft },
  scroll: { paddingHorizontal: 22, paddingBottom: 40 },
  sub: { color: color.textMuted, marginTop: 5, lineHeight: 19 },
  body: { marginTop: 20 },

  note: {
    flexDirection: 'row',
    gap: 9,
    marginTop: 16,
    paddingVertical: 11,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: color.brandTint,
  },
  noteText: { color: color.brandDeeper, flex: 1, lineHeight: 18 },

  group: { marginTop: 20 },
  groupLabel: { color: color.textMutedLabel, letterSpacing: 0.88, textTransform: 'uppercase' },
  cards: { gap: 10, marginTop: 10 },

  card: {
    padding: 16,
    borderRadius: radius.card,
    backgroundColor: color.white,
    borderWidth: 1,
    borderColor: color.hairline,
  },
  cardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  timeRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  dim: { color: color.textMutedSoft },
  newPill: {
    paddingVertical: 2,
    paddingHorizontal: 7,
    borderRadius: radius.pill,
    // White on brandDeep, never on brand — non-negotiable #9.
    backgroundColor: color.brandDeep,
  },
  newPillText: { color: color.white },
  depositPill: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: radius.pill,
    backgroundColor: color.brandTint,
  },
  depositPillText: { color: color.brandDeeper },
  service: { color: color.ink, marginTop: 9 },

  client: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: color.hairlineInner,
  },
  avatar: {
    width: 38,
    height: 38,
    borderRadius: 11,
    backgroundColor: color.brandTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: { color: color.brandDeep },
  clientBody: { flex: 1, minWidth: 0 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  tierPill: { paddingVertical: 2, paddingHorizontal: 8, borderRadius: radius.pill },
  srcPill: {
    paddingVertical: 4,
    paddingHorizontal: 9,
    borderRadius: radius.pill,
    backgroundColor: color.surfaceAlt2,
  },
  srcPillGcal: { backgroundColor: color.brandTint },
  srcText: { color: color.textMutedStrong },
  srcTextGcal: { color: color.brandDeep },

  actions: { flexDirection: 'row', gap: 9, marginTop: 13 },
  action: {
    flex: 1,
    minHeight: MIN_TAP_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderRadius: 11,
  },
  actionCall: { borderWidth: 1, borderColor: color.borderControl, backgroundColor: color.white },
  actionCallText: { color: color.ink },
  actionWa: { backgroundColor: color.success },
  actionWaText: { color: color.whatsappOnGreen },
});
