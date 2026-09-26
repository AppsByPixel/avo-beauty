// @vitest-environment jsdom

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * "NO-SHOW — DEPOSIT RETURNED", OVER AN APPOINTMENT SHE NEVER PAID A DEPOSIT ON
 * ═════════════════════════════════════════════════════════════════════════════
 * A front desk can now create an appointment on an EXISTING member's account.
 * `BookingSchema § source` settles what that means for the money: a `merchant`
 * booking is always zero-deposit, "nothing is held and nothing is returned",
 * and a client must render the pill from `depositFils` rather than from
 * `status`, which keeps its four values and whose two money-shaped ones
 * (`deposit_held`, `no_show_returned`) now mean only "live" and "missed".
 *
 * The booking appears in her app like any other. So every sentence the wallet
 * says about holding, returning or carrying over a deposit had to be checked
 * against a row where none of it happened, and the defect this file exists to
 * prevent is a single class: telling a customer she is getting money back that
 * she never paid.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT PINS BOTH SIDES, AND THE DEPOSIT-BEARING SIDE IS THE LOAD-BEARING HALF
 * ─────────────────────────────────────────────────────────────────────────────
 * Every spec below runs twice: once on a `merchant` row at 0 and once on an
 * `app` row at 5000. The zero case asserts the new behaviour; the non-zero case
 * asserts the EXISTING copy, character for character, including the design's
 * own 24h/1h contradiction which this slice deliberately did not resolve.
 *
 * That second assertion is not padding. A fix of this shape is one careless
 * ternary away from being a copy rewrite for everybody — the easiest way to
 * stop the wallet promising a refund on a zero-deposit booking is to stop it
 * promising one at all, and that would sail through a test that only looked at
 * the zero case. The design strings are quoted as literals here rather than
 * read off `copy`, so an edit to en.ts trips this file instead of being
 * mirrored by it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AND THE ARABIC, BECAUSE THE VARIANTS ARE CUTS AND A CUT CAN BE MADE WRONGLY
 * ─────────────────────────────────────────────────────────────────────────────
 * Non-negotiable #12: Arabic is a first-class layout, not a translation pass.
 * Each variant is the designer's own Arabic with its deposit clause removed, so
 * the thing that can go wrong is not a bad translation but a cut in the wrong
 * place — one that leaves عربون standing in a sentence about a booking that has
 * none. The Arabic specs assert on that word directly.
 */

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Salon } from '@avo/types';

import { UpcomingCard } from './UpcomingCard';
import { LanguageProvider } from '../i18n/language';
import { BookingViewSchema, type BookingView } from '../api/booking';

/** The word the whole file is about, in the language the design wrote it in. */
const AR_DEPOSIT = 'عربون';

const SALON = { timezone: 'Asia/Kuwait' } as unknown as Salon;

/**
 * THROUGH THE SCHEMA, not a hand-built object — so the parse is under test too.
 *
 * The guest fields are omitted deliberately and in every fixture: that is the
 * body `serialiseBooking` actually sends today (api/src/services/booking.ts:128
 * emits neither `guestName` nor `guestPhone`), and `BookingViewSchema`'s
 * tolerance is what stops it throwing. A fixture that supplied them would be a
 * payload no server produces, and this file would go green while Home's
 * Upcoming section resolved to its failure card for every real customer.
 */
function booking(over: Record<string, unknown> = {}): BookingView {
  return BookingViewSchema.parse({
    id: 'BK-1',
    memberId: 'M-1',
    artistId: 'AR-001',
    branchId: 'BR-1',
    serviceId: 'SV-1',
    startsAt: '2026-09-28T13:45:00.000Z',
    endsAt: '2026-09-28T14:45:00.000Z',
    durationMin: 60,
    depositFils: 5000,
    status: 'deposit_held',
    source: 'app',
    changeableUntil: '2026-09-28T12:45:00.000Z',
    noShowReturnDueAt: '2026-09-28T15:45:00.000Z',
    rescheduledCount: 0,
    calendarSyncState: 'not_applicable',
    ...over,
  });
}

/** The front desk's version: a member's appointment, holding nothing. */
const MERCHANT = { source: 'merchant', depositFils: 0 } as const;

function draw(b: BookingView, lang: 'en' | 'ar' = 'en', failureCode: string | null = null) {
  return render(
    <LanguageProvider initial={lang}>
      <UpcomingCard
        booking={b}
        salon={SALON}
        artistLabel="Rana"
        serviceLabel="Balayage & gloss"
        onReschedule={() => {}}
        onCancel={() => {}}
        busy={false}
        failure={failureCode === null ? null : { code: failureCode, message: 'refused' }}
      />
    </LanguageProvider>,
  );
}

const textOf = (b: BookingView, lang: 'en' | 'ar' = 'en', code: string | null = null) =>
  draw(b, lang, code).container.textContent ?? '';

/**
 * The text of ONE element, by testID.
 *
 * Used by the note specs so that each one fails for its own reason. Asserting
 * "عربون appears nowhere on the card" is true and useful, but it makes the
 * note's spec go red when the PILL regresses — which reports the wrong defect
 * and, worse, would let the note's own fix be deleted without anything noticing
 * while the pill held the assertion up.
 */
const partOf = (testid: string, b: BookingView, lang: 'en' | 'ar' = 'en', code: string | null = null) =>
  draw(b, lang, code).container.querySelector(`[data-testid="${testid}"]`)?.textContent ?? '';

afterEach(cleanup);

// == 1. the pill ==============================================================

describe('the live pill', () => {
  /**
   * `BookingSchema § status`: "at 0 the labels are 'Booked' and 'No-show', with
   * no mention of a deposit."
   */
  it('a zero-deposit booking says Booked, and the word deposit appears nowhere', () => {
    const text = textOf(booking(MERCHANT));
    expect(text).toContain('Booked');
    expect(text.toLowerCase()).not.toContain('deposit');
    // Not merely the word — no money at all. `0.000 KD held` is the exact
    // string this rendered before, and `formatMoney` would still produce it.
    expect(text).not.toContain('0.000');
    expect(text).not.toContain('held');
  });

  /**
   * THE HALF THAT PROVES THE FIX WAS NOT A COPY REWRITE. design:1179 —
   * `upDeposit` is "5.000 KD held", and the pill is still the brand-tinted one.
   */
  it('a deposit-bearing booking still says exactly what it said before', () => {
    const text = textOf(booking());
    expect(text).toContain('5.000 KD held');
    expect(text).not.toContain('Booked');
  });

  it('renders the pill in both cases — the slot is never left empty', () => {
    for (const b of [booking(), booking(MERCHANT)]) {
      const { container } = draw(b);
      const pill = container.querySelector('[data-testid="upcoming-pill"]');
      expect(pill).not.toBeNull();
      expect((pill?.textContent ?? '').trim().length).toBeGreaterThan(0);
      cleanup();
    }
  });

  it('says the same thing in Arabic, and names no عربون at zero', () => {
    expect(textOf(booking(MERCHANT), 'ar')).not.toContain(AR_DEPOSIT);
    // design:1286 — `عربون 5.000 د.ك`. Western digits for money, #12.
    expect(textOf(booking(), 'ar')).toContain(`${AR_DEPOSIT} 5.000 د.ك`);
  });
});

// == 2. the cancellation consequence ==========================================

describe('the note under the buttons — what cancelling will cost her', () => {
  /**
   * This is the CANCEL CONFIRMATION on this surface. There is no confirm
   * dialog: `UpcomingCard`'s Cancel button fires `DELETE /bookings/{id}`
   * directly, and design:321's note sitting directly above it is the whole of
   * what she is told before the money moves. It is therefore the one string
   * most able to promise a refund that will not arrive.
   */
  it('does not promise a refund, or mention a deposit, on a zero-deposit booking', () => {
    const text = partOf('upcoming-note', booking(MERCHANT));
    expect(text).toBe('Free until an hour before.');
    expect(text).not.toContain('the deposit stays with the salon');
    expect(text.toLowerCase()).not.toContain('deposit');
    expect(text.toLowerCase()).not.toContain('refund');
    expect(text.toLowerCase()).not.toContain('return');
  });

  /** design:1180, verbatim and entire. */
  it('still states the design sentence in full when there is a deposit', () => {
    expect(partOf('upcoming-note', booking())).toBe(
      'Free until an hour before. After that the deposit stays with the salon.',
    );
  });

  it('cuts the Arabic at the same place', () => {
    // design:1287, first sentence only. Scoped to the note, so this cannot be
    // held up (or knocked down) by the pill beside it.
    const zero = partOf('upcoming-note', booking(MERCHANT), 'ar');
    expect(zero).toBe('مجاناً حتى ساعة قبل الموعد.');
    expect(zero).not.toContain(AR_DEPOSIT);

    expect(partOf('upcoming-note', booking(), 'ar')).toBe(
      'مجاناً حتى ساعة قبل الموعد. بعدها يبقى العربون للصالون.',
    );
  });

  /**
   * AND THE REFUSAL SAYS IT AGAIN. `409 change_window_closed` renders its own
   * body, which carried the same clause — so a customer who cancelled one
   * minute too late was told a deposit she never paid now stays with the salon.
   */
  it('the refused-change body drops the deposit clause too', () => {
    const zero = textOf(booking(MERCHANT), 'en', 'change_window_closed');
    expect(zero).toContain('An appointment can be changed free until an hour before it starts.');
    expect(zero.toLowerCase()).not.toContain('deposit');

    expect(textOf(booking(), 'en', 'change_window_closed')).toContain(
      'After that the deposit stays with the salon.',
    );
  });
});

// == 3. the missed appointment ================================================

/**
 * `no_show_returned` MEANS "MISSED", AND ONLY THAT, ON A ZERO-DEPOSIT ROW.
 *
 * `nextAppointment` filters Home's card down to `deposit_held`, so a missed
 * booking does not reach `UpcomingCard` today — which is exactly why this spec
 * is written against the PREDICATE rather than the card. The claim is about the
 * status enum, it is true independently of which screen happens to read it, and
 * a future screen that lists past appointments must not have to rediscover it.
 *
 * The wallet has no such list yet; the scanner does, and its half of this rule
 * is `bookingsZeroDeposit.test.ts` in apps/scanner.
 */
describe('a zero-deposit no-show claims no return', () => {
  it('holdsDeposit is false for it, whatever the status says', async () => {
    const { holdsDeposit } = await import('../domain/booking');
    expect(holdsDeposit(booking({ ...MERCHANT, status: 'no_show_returned' }))).toBe(false);
    expect(holdsDeposit(booking({ status: 'no_show_returned' }))).toBe(true);
  });

  it('keys off the amount and not the source, so a 0-deposit salon is covered too', async () => {
    const { holdsDeposit } = await import('../domain/booking');
    // An `app` booking at a salon whose `depositFils` is 0 — a settings value,
    // not a schema change. `source === 'merchant'` would miss it.
    expect(holdsDeposit(booking({ depositFils: 0 }))).toBe(false);
  });

  /**
   * AND THE WORDS THAT WOULD BE WRONG ARE NOT IN THE WALLET'S COPY AT ALL.
   *
   * The wallet has no status-pill vocabulary for a finished booking — the only
   * booking state it renders is the live one. So the honest assertion is that
   * no English string in the whole copy set puts "no-show" and "returned"
   * together, which is what would have to exist before this defect could ship
   * here. It trips the day somebody adds one without a zero-deposit variant.
   */
  it('no copy string pairs no-show with a return', async () => {
    const { en } = await import('../copy/en');
    const strings = Object.values(en).filter((v): v is string => typeof v === 'string');
    const offending = strings.filter(
      (s) => /no.?show/i.test(s) && /(return|refund)/i.test(s),
    );
    expect(offending).toEqual([]);
  });
});
