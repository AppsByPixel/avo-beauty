/**
 * Scanner · My bookings. design/AVO Staff Scanner.dc.html:130-179.
 *
 * The artist's day, grouped by date: time, duration, service, deposit, status,
 * and the client's name, tier and phone with one-tap Call and WhatsApp.
 *
 * NOT ONLY "UPCOMING", WHICH IS WHAT THIS HEADER USED TO SAY AND WHAT THE SCREEN
 * DREW. `GET /artists/me/bookings` returns rows from `Date.now() - 24h` onward
 * — the route's own comment says "from the start of today", and the code says a
 * rolling twenty-four hours, which is wider — and the charge path marks a settled
 * booking `completed` inside the money transaction. So roughly half a working
 * day's rows are appointments that have already happened, and until this change
 * nothing on the card or in the count line said so. `STATUS_PILL` below carries
 * that, and `dayTally` stops the header calling finished work upcoming.
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

  /*
    Non-null exactly when the load is ready, which is why the count line below
    branches on IT rather than on `load.status` — one condition, and TypeScript
    narrows the value the line actually reads.
  */
  const tally = load.status === 'ready' ? dayTally(load.bookings) : null;

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

        {tally ? (
          <Text style={[ui(12.5), styles.sub]}>
            {copy.bookingsCount(tally.upcoming, tally.isNew, tally.paid, tally.voided)} —{' '}
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

// --------------------------------------------------------------- the status --

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * FOUR STATES ARE DEFINED HERE; TWO OF THEM CAN REACH THIS SCREEN TODAY
 * ═══════════════════════════════════════════════════════════════════════════
 * This card drew no status at all, and the server has always sent one. A charge
 * that settles a held deposit sets the booking to `completed` inside the money
 * transaction — `api/src/services/charge.ts:781`, the ONLY place in the API that
 * writes that status — and `GET /artists/me/bookings` returns rows from
 * `Date.now() - 24h` onward. So an appointment she charged at 11:00 was still on
 * her screen at 15:00, byte-identical to one she had not touched, and she had to
 * remember which of the morning she had rung up.
 *
 * WHY A MAP RATHER THAN A TERNARY. Written when only two statuses could arrive;
 * THREE CAN NOW, and the arm this paragraph called dead is the live one.
 *
 * The route used to filter her day to `deposit_held` and `completed` only, so a
 * void - which sets the booking to `cancelled` - made an appointment she had
 * just been paid for DISAPPEAR. Lane A fixed the server half: the predicate now
 * also admits `cancelled`, but ONLY when the settling transaction carries
 * `reverses_transaction_id` (api/src/routes/bookings.ts § where). So
 * `cancelled` is reachable today, `no_show_returned` still is not, and the one
 * `cancelled` case that arrives is always a reversal.
 *
 * WHICH IS WHY THE MAP IS NO LONGER THE WHOLE ANSWER - see `pillFor` below. A
 * neutral grey "Cancelled" at the same visual weight as "Paid" is what this map
 * alone would now draw, and it is the flat labelling Lane A's fix exists to
 * avoid. The map stays keyed by status because it is the exhaustiveness ratchet
 * (`bookingsDoneState.test.ts` fails the day the contract grows a fifth status,
 * and an unhandled status renders not as nothing but as an ordinary live
 * appointment), and `cancelled`'s entry stays "Cancelled" because that word is
 * RIGHT for the customer's own cancellation on the day Lane A widens the
 * predicate to admit it. `pillFor` intercepts before it.
 *
 * `deposit_held` IS NULL ON PURPOSE. The merchant's Appointments board needs a
 * "Deposit held" pill because it is a table with a status column; this card
 * already says "Deposit 5.000" in that exact position. A second pill repeating
 * it would land on the majority of rows and carry nothing.
 *
 * 600, NOT 700 — DECISIONS.md #115. #115 freezes 700 to badges and this file is
 * where its one 700 lives, so the call needs making rather than assuming. Inside
 * this very card the deposit pill is `ui(11, '600')`, the tier pill `ui(10,
 * '600')` and the source pill `ui(10.5, '600')`; the single 700 is `NEW`. So the
 * file's own line is not badge-versus-prose, it is ALERT versus DESCRIPTION —
 * and a finished row is the least alerting thing on the screen. Drawing "Paid"
 * at 700 would give completed work the same visual urgency as new work landing,
 * which is exactly backwards. The proof that this landed on 600 is that
 * `emphasisWeight.test.ts`'s frozen 700 set still has one member.
 *
 * The colours are existing pairs, not new ones: `surfaceAlt2` + `textMutedStrong`
 * is the source pill's own pair, and `dangerBg` + `dangerText` is the pair Lane C
 * already took for `no-show · returned` on the merchant's board. Both are
 * computed against AA in the test rather than asserted in a comment.
 */
export const STATUS_PILL: Record<
  ArtistBooking['status'],
  { label: string; bg: string; text: string } | null
> = {
  deposit_held: null,
  completed: {
    label: copy.bookingsStatusPaid,
    bg: color.surfaceAlt2,
    text: color.textMutedStrong,
  },
  no_show_returned: {
    label: copy.bookingsStatusNoShow,
    bg: color.dangerBg,
    text: color.dangerText,
  },
  cancelled: {
    label: copy.bookingsStatusCancelled,
    bg: color.surfaceAlt2,
    text: color.textMutedStrong,
  },
};

/**
 * ===========================================================================
 * THE REVERSAL. NOT A STATUS, SO NOT IN THE MAP ABOVE.
 * ===========================================================================
 * `chargeVoided` is the server's answer to a question the booking row cannot
 * answer: `cancelled` has two writers meaning opposite things, and only the
 * settling transaction's `reverses_transaction_id` - one writer in the whole
 * API, behind a unique index - tells them apart. Non-negotiable #2: it is read,
 * never re-derived. In particular it is NOT inferred from `status ===
 * 'cancelled'`, which happens to be equivalent today only because the route's
 * predicate admits no other kind of cancellation, and which Lane A has said it
 * may widen.
 *
 * WHY THIS IS THE ONLY SURFACE THAT CAN CARRY IT. The seeded artist with a login
 * is a scanner principal with `permDashboard: false`, `permCharges: false` and
 * `permVoid: false` (api/src/db/seed.ts § ST-002). She cannot open the audit
 * log, and `Today's charges` draws its padlock for her. If her day does not say
 * this, nothing she can reach ever will.
 *
 * ---------------------------------------------------------------------------
 * THE WEIGHT, WHICH IS THE HARDER HALF - AND IT IS NOT A FONT WEIGHT
 * ---------------------------------------------------------------------------
 * DECISIONS #115 in this file's own reading is ALERT versus DESCRIPTION: inside
 * this card the deposit, tier and source pills are all 600 and the single 700 is
 * `NEW`. So: is a reversal an alert?
 *
 * It is a DESCRIPTION, and the pill stays 600. `NEW` means "this arrived, look
 * at it" - it is about her queue and it implies something to do. A void is
 * finished, it is somebody else's action, and there is no affordance on this
 * card or anywhere she can reach: she holds neither `perms.void` nor
 * `perms.charges`. Drawing it at `NEW`'s weight would promise a response she
 * cannot make, and it would put two 700s in one row's worth of slots, which is
 * how a frozen set stops meaning anything. `emphasisWeight.test.ts`'s 700 set
 * still has exactly one member, and that is the proof.
 *
 * BUT IT MUST NOT RECEDE, which is the part the pill cannot do on its own. The
 * settled card deliberately drops off the white lift onto `surfaceAlt` and mutes
 * its ink, because a finished row should not compete with the next appointment.
 * A reversed row is NOT finished: it is neither done nor upcoming, it is her
 * completed work in an unresolved state. So `receded` below is narrower than
 * `settled` - the reversal keeps the white lift and full ink, and the pill takes
 * `dangerBg`/`dangerText`, which is this app's existing pair for "money went
 * BACK to the customer" and already carries `no-show · returned`. Colour and
 * elevation do the work; the type scale is left alone.
 *
 * Using the same pair as `no_show_returned` rather than inventing a third is
 * deliberate: both mean the customer's money was returned, and a colour
 * distinction between them would be a semantic nobody defined. The WORDS
 * separate them.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS MISSING, AND IT IS NOT MINE TO INVENT
 * ---------------------------------------------------------------------------
 * The void carries a reason - `copy.voidReasons`, three of them - and one of the
 * three is "Customer did not receive service", which is a claim about THIS
 * artist's work, recorded against a staff name in an append-only log she has no
 * permission to read. The other two ("Wrong amount or service", "Duplicate
 * charge") mean something entirely different to her: a correction and a piece of
 * housekeeping. `GET /artists/me/bookings` does not serve the reason, so this
 * pill cannot distinguish them and deliberately says nothing rather than
 * implying the worst reading. That is an ask for Lane A, written up in the
 * report; no placeholder is rendered here.
 */
const VOIDED_PILL = {
  label: copy.bookingsStatusVoided,
  bg: color.dangerBg,
  text: color.dangerText,
} as const;

/**
 * The one place that decides which pill a booking wears.
 *
 * Exported for the test. The reversal is checked FIRST and unconditionally: a
 * future `no_show_returned` that somehow also carried a reversal would say
 * "Payment voided", because that is the fact about money and the other is a fact
 * about attendance.
 */
export function pillFor(
  booking: Pick<ArtistBooking, 'status' | 'chargeVoided'>,
): { label: string; bg: string; text: string } | null {
  if (booking.chargeVoided) return VOIDED_PILL;
  return STATUS_PILL[booking.status];
}

/**
 * ===========================================================================
 * AND NOW IT SAYS WHICH OF THE THREE. The paragraph above asked for this.
 * ===========================================================================
 * `VOIDED_PILL`'s note closes "GET /artists/me/bookings does not serve the
 * reason, so this pill cannot distinguish them and deliberately says nothing
 * rather than implying the worst reading. That is an ask for Lane A." Lane A
 * built it — `voidReason`, one of three codes, never the words — so the silence
 * that was correct while the field did not exist stops being correct here.
 *
 * SAYING NOTHING IS NOT NEUTRAL ONCE THE ANSWER EXISTS. "Payment voided" with no
 * why leaves her to pick among a correction, a piece of housekeeping, and an
 * assertion that she did not do the job; the one a person picks when the screen
 * will not say is the worst one. Two of three reversals are not about her at
 * all, and she currently has no way to learn that.
 *
 * ---------------------------------------------------------------------------
 * REPORTED, NOT ASSERTED — which is the whole design
 * ---------------------------------------------------------------------------
 * `copy.bookingsVoidReason` wraps the label: "Reason given: Customer did not
 * receive service". The frame is load-bearing. The bare label on her own card is
 * this SCREEN stating she did not do the job; framed, it is the screen reporting
 * what was recorded at the till, which is the only thing it actually knows.
 *
 * It names no actor. `created_by_staff_id` sits on the same reversal row and
 * Lane A deliberately does not select it: who voided a charge is a different
 * disclosure from why, and it belongs to a surface with an appeal attached to
 * it, which this is not.
 *
 * ---------------------------------------------------------------------------
 * `cust` IS CATEGORICALLY DIFFERENT AND IS DELIBERATELY NOT DRAWN DIFFERENTLY
 * ---------------------------------------------------------------------------
 * It is. "Wrong amount or service" and "Duplicate charge" are statements about
 * the TILL; "Customer did not receive service" is a statement about HER. That
 * asymmetry is real and it is why this line exists at all.
 *
 * It still gets no colour, no weight and no icon of its own, for two reasons and
 * the second is the one that decides it:
 *
 *   A screen that marks one reason as the serious one is taking a position on a
 *   dispute it is not party to, and telling her how to feel about a sentence
 *   before she has read it.
 *
 *   And the moment `cust` is styled as the bad one, the other two acquire a
 *   meaning by contrast: "Duplicate charge" in the quiet style reads as
 *   EXONERATING. It is not. A void for a wrong amount is still her money and
 *   still contestable. Marking one is editorialising twice, in opposite
 *   directions, and the second is invisible until somebody relies on it.
 *
 * So: one form, three labels. The difference between "Duplicate charge" and
 * "Customer did not receive service" is not subtle and does not need a colour to
 * land — which is exactly what Lane A meant by keeping the words client-side.
 *
 * ---------------------------------------------------------------------------
 * NULL IS SILENCE, AND THE SCHEMA IS WHAT DECIDED THAT
 * ---------------------------------------------------------------------------
 * `voidReason` is `.default(null)` (api/artist.ts), so `null` means EITHER "this
 * void recorded no code" — every void before migration 0050, and any client that
 * sends none — OR "this API is too old to say". The two are indistinguishable
 * here by construction.
 *
 * Which is why nothing is drawn. "No reason recorded" is the sentence one wants,
 * and it would be false against a rolled-back server; it would also be false in
 * a subtler way even on a current one, because a reason in WORDS was recorded on
 * the reversal row — `transaction.note` — and this screen is deliberately not
 * served it. Silence is not an omission here, it is the only statement that is
 * true of every null.
 *
 * ---------------------------------------------------------------------------
 * AND IT OFFERS HER NOTHING TO PRESS
 * ---------------------------------------------------------------------------
 * She cannot reply, cannot see who, and cannot open the audit log. There is no
 * endpoint on this API by which an artist contests a void, so there is no
 * control here — not a chevron, not "ask a manager", not a support deep link.
 * An affordance with nothing behind it is worse than none: it looks like she has
 * been heard. The gap is real and it is escalated as a product question, not
 * filled in with a button that does nothing.
 */
export function voidReasonLine(
  booking: Pick<ArtistBooking, 'chargeVoided' | 'voidReason'>,
): string | null {
  /*
    GATED ON THE REVERSAL, not on the reason alone. `voidReason` non-null implies
    `chargeVoided` and the database enforces it
    (`transaction_void_reason_code_is_reversal_only`), so the other row cannot
    arrive — which is the same "cannot happen today" that let `status` stand in
    for `chargeVoided` until it could. A reason without "Payment voided" above it
    is an accusation with no subject; the card draws neither rather than the
    dangling half.
  */
  if (!booking.chargeVoided || booking.voidReason === null) return null;
  const label = copy.voidReasons.find((r) => r.id === booking.voidReason)?.label;
  /*
    NO FALLBACK TO THE CODE. `copy.voidReasons.find(...)` cannot miss — the wire
    enum and these three ids are the same closed set — but if it ever does, the
    answer is silence, not "cust". `POST /voids` accepted `she_is_lazy` and
    returned 200 until this session; the id is a database value and must never be
    a string this screen is capable of drawing on a named artist's card.
  */
  return label === undefined ? null : copy.bookingsVoidReason(label);
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
 * that the window is narrow: the query reaches back twenty-four hours, and
 * erasure defers while a deposit is in escrow, so the live case is a booking
 * already SETTLED for a member erased inside that window. Narrow is not a fix -
 * and it got wider after this was written, because the query now also admits a
 * settled booking whose charge was voided.
 *
 * (It used to say "the query takes `deposit_held` and `completed`". That stopped
 * being true when Lane A admitted reversed cancellations to her day. The window
 * is what the argument rests on, not the status list, so the sentence names the
 * window.)
 *
 * THE GUARD IS `memberErased || memberPhone === null`, not either alone:
 *
 *   the flag   is the contract's answer, and it has LANDED —
 *              `api/src/http/serialise.ts § serialiseMemberContact` computes it
 *              from `erasedAt` on every item. (It read "the one Lane A is
 *              landing" long after that merge.) It is also the only signal that
 *              survives if the tombstone format ever changes — nothing here
 *              should be pattern-matching `+990`.
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
  const status = pillFor(booking);
  const voidReason = voidReasonLine(booking);
  /*
    Settled means the deposit is resolved — charged, returned or cancelled — and
    it is read from the SERVER'S status, never from a timestamp or from a charge
    this device happens to have watched. Non-negotiable #2.
  */
  const settled = booking.status !== 'deposit_held';
  /*
    AND RECESSION IS NARROWER THAN SETTLEMENT, which is the whole visual argument
    for a reversal. `settled` still governs the things that are about the DEPOSIT
    being resolved — it is what suppresses `NEW` below, and a voided booking must
    not read NEW either. `receded` governs the things that are about the row
    being FINISHED: dropping off the white lift onto `surfaceAlt` and muting the
    ink, so the next appointment wins the eye.

    A reversal is settled and is not finished. Her completed work has been undone
    and there is nothing she can do about it from any screen she can open, so the
    row keeps its elevation and its ink and lets the pill's colour carry the
    fact. See VOIDED_PILL above for why this is elevation rather than weight.
  */
  const receded = settled && !booking.chargeVoided;
  /*
    AND IT SUPPRESSES `NEW`, which is not tidiness but a collision this change
    exposed. `isRecent` is `startsAt - now < 12h` with NO LOWER BOUND, so every
    past booking in the 24-hour window reads NEW — this morning's charged
    appointment included. A card wearing NEW and Paid at once is nonsense.
    REPORTED and deliberately not fixed here: a booking from yesterday evening
    that is still `deposit_held` also reads NEW, and that half wants either a
    `createdAt` on `Booking` or an artist-side seen marker rather than a wider
    guess in this file.
  */
  const isNew = !settled && isRecent(booking);

  const open = useCallback((url: string) => {
    // Deliberately not awaited into a UI state: the OS takes over the screen.
    // A rejection means no app can handle the scheme, which on a real phone
    // with a SIM does not happen for `tel:` and, for `wa.me`, falls back to the
    // browser — which is the correct outcome rather than an error to render.
    void Linking.openURL(url).catch(() => {});
  }, []);

  return (
    <View style={[styles.card, receded && styles.cardSettled]} testID={`booking-${booking.id}`}>
      <View style={styles.cardTop}>
        <View style={styles.timeRow}>
          <Text style={[display(17, '600'), receded && styles.settledInk]}>
            {clockLabel(booking.startsAt)}
          </Text>
          <Text style={[ui(12), styles.dim]}>· {copy.bookingsDuration(booking.durationMin)}</Text>
          {isNew ? (
            <View style={styles.newPill}>
              <Text style={[ui(10, '700'), styles.newPillText]}>{copy.bookingsNew}</Text>
            </View>
          ) : null}
          {/*
            In the slot `NEW` would have taken, because the two can never both
            be here. Same cluster as the time: this is a fact about THIS
            appointment's state, sitting beside when it was.
          */}
          {status ? (
            <View
              style={[styles.statusPill, { backgroundColor: status.bg }]}
              testID={`booking-status-${booking.id}`}
            >
              <Text style={[ui(10, '600'), { color: status.text }]}>{status.label}</Text>
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

      {/*
        DIRECTLY UNDER THE PILL IT EXPLAINS, above the service name. The pill
        says "Payment voided"; this is the rest of that sentence, and adjacency
        to the claim matters more than adjacency to the work. A screen reader
        reaches it immediately after the pill for the same reason.

        `textMutedStrong`, NOT `styles.dim` — and this is the one place this line
        departs from the phone line above it, deliberately and by measurement.
        `textMutedSoft` is rgba(28,27,25,0.45), which composites to #999898 and
        measures 2.88:1 on white: it FAILS AA, as the token file's own
        `mutedLabel` note records ("0.45 measures ~3.3:1 and fails"). It is an
        acceptable treatment for a phone number sitting beside a Call button that
        renders the same digits; it is not one for the single most consequential
        sentence on this card, which is a claim about her work that she may be
        reading upset and cannot get a second opinion on. 0.7 measures 6.37:1 and
        is already this card's own muted ink — the source pill's text and
        `settledInk`.

        Not `dangerText`: red is the pill's job, and saying it twice would turn
        reporting into alarm, which is the one thing this line must not do on
        `cust`. See `voidReasonLine` above.
      */}
      {voidReason === null ? null : (
        <Text
          style={[ui(12), styles.voidReason]}
          testID={`booking-void-reason-${booking.id}`}
        >
          {voidReason}
        </Text>
      )}

      <Text style={[ui(14.5, '600'), styles.service, receded && styles.settledInk]}>
        {booking.serviceName}
      </Text>

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

/**
 * The three numbers the count line reads.
 *
 * `upcoming` USED TO BE `bookings.length`, and that was the header telling the
 * same lie the cards were: the endpoint returns the last 24 hours as well as the
 * day ahead, so two charged clients made "5 upcoming" out of three. Counting
 * only the still-held ones is what lets the word keep its meaning, and `paid`
 * names what the rest are instead of hiding them.
 *
 * `voided` IS THE FOURTH, AND IT EXISTS TO STOP A SILENT DECREMENT. A reversed
 * booking is `cancelled` on the server, so without this it counts in none of the
 * other three: a manager voids this morning's charge and "2 paid" becomes "1
 * paid" while a card she has not seen before appears below, with nothing above
 * connecting the two. Same defect the `upcoming` fix closed, running the other
 * way - the line stops lying and starts omitting.
 *
 * IT IS COUNTED OFF `chargeVoided`, NOT OFF `status === 'cancelled'`, for the
 * reason `pillFor` gives: those are equivalent only because of a route predicate
 * Lane A may widen, and the day it does, a customer's cancellation would start
 * being counted as a reversal by a header nobody re-read.
 *
 * Exported for the test, and for nothing else.
 */
export function dayTally(bookings: ArtistBooking[]): {
  upcoming: number;
  isNew: number;
  paid: number;
  voided: number;
} {
  const held = bookings.filter((b) => b.status === 'deposit_held');
  return {
    upcoming: held.length,
    // `isRecent` is only consulted on held rows now — same rule the card uses.
    isNew: held.filter(isRecent).length,
    // A reversed charge is no longer `completed`, so it leaves `paid` on its
    // own. That is correct - she was not, in the end, paid for it - and the
    // segment below is what makes the subtraction visible rather than spooky.
    paid: bookings.filter((b) => b.status === 'completed').length,
    voided: bookings.filter((b) => b.chargeVoided).length,
  };
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
  /*
    THE SETTLED ROW RECEDES, and this is the part that works at scan distance.
    A 10px pill is a thing you read once you have stopped on a row; an artist
    running her eye down the day needs the NEXT appointment to be the one that
    stands out. `surface` is #FBFAF8 and a card is white, so every live row LIFTS
    off the page; `surfaceAlt` (#F6F4EE) sits below it instead, and a finished
    appointment stops competing without disappearing.

    Nothing else on the card is restyled. The hairline, the radius, the padding
    and every child's geometry are untouched — a row does not move when it is
    charged, it only changes weight.
  */
  cardSettled: { backgroundColor: color.surfaceAlt },
  /*
    `textMutedStrong` on `surfaceAlt` is 6.08:1, computed in the test rather than
    claimed here. It is the only muted token on this card that clears AA:
    `textMutedSoft`, which `styles.dim` already uses for the duration and the
    phone line, is 2.88:1 on WHITE before this change and 2.82:1 on the settled
    card. That is a pre-existing failure and it is reported rather than deepened
    — de-emphasis here moves ink DOWN from full black, never further down from an
    already-failing grey.
  */
  settledInk: { color: color.textMutedStrong },
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
  /*
    Geometry copied from `newPill` deliberately: the two occupy the same slot and
    can never both be present, so a row must not change height or rhythm
    depending on which one it carries. Only the colours differ, and they come off
    `STATUS_PILL` rather than from here — three statuses, two palettes.
  */
  statusPill: { paddingVertical: 2, paddingHorizontal: 7, borderRadius: radius.pill },
  depositPill: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: radius.pill,
    backgroundColor: color.brandTint,
  },
  depositPillText: { color: color.brandDeeper },
  /*
    `marginTop` only. Everything else about this line comes from `ui(12)` and
    `styles.dim`, so it is the same body treatment the phone line has and cannot
    drift from it — see `voidReasonLine` on why it must not become its own
    visual thing.
  */
  voidReason: { color: color.textMutedStrong, marginTop: 7, lineHeight: 17 },
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
