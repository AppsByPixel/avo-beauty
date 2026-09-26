// @vitest-environment jsdom

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MERCHANT → APPOINTMENTS → THE ROW. THE FOUR CONTROLS, AND THE PILL OVER THEM.
 * ═══════════════════════════════════════════════════════════════════════════
 * `noShowMarkRender.test.tsx` owns the no-show link and holds these four off.
 * This file is the other half, and it renders rather than scanning source for
 * the reason that file gives: every property below is about what a merchant
 * READS and what a click actually sends, and neither survives a grep.
 *
 * THE FOUR GUARANTEES:
 *
 *   1. THE PILL IS RENDERED FROM `depositFils`, NOT FROM `status` ALONE.
 *      `packages/types § BookingSchema.status` asks for exactly this: at 0 the
 *      labels are "Booked" and "No-show", with no mention of a deposit. A board
 *      that prints "No-show · returned" over an appointment that never had one
 *      is telling a merchant — and through her, a customer — that money came
 *      back that never went out. The DEPOSIT-BEARING copy is pinned in the same
 *      describe, verbatim, so the containment can be shown not to have touched
 *      it.
 *
 *   2. "Mark done" IS OFFERED ONLY WHERE THE SERVER WILL ALLOW IT.
 *      `completeBooking` refuses a booking with a hold against it — 409
 *      `deposit_completed_at_the_counter` — because completing a deposit-bearing
 *      appointment has to name the charge that CONSUMED the hold, and that
 *      happens at the scanner. `completed` is written in exactly one place in
 *      the whole API and it is inside the charge transaction.
 *
 *   3. EACH CONTROL IS GATED ON THE READER'S OWN PERMISSION, AND THE GATE IS NOT
 *      THE CONTROL. #7. Two permissions, not one: create/reschedule/reassign/
 *      complete are `perms.appointments`, cancel is `perms.void`, and
 *      `db/seed.ts § ST-002` (Hessa, frontdesk) is the account the split
 *      protects — she should be able to move a 16:45 and must not be able to
 *      return a deposit. The refusal is asserted with the SERVER's sentence,
 *      because paraphrasing drops the half that says who can grant it back.
 *
 *   4. `slot_taken` IS A RECOVERABLE REFUSAL AND NAMES WHAT TO DO NEXT. The
 *      exclusion constraint spans hand-written and app bookings deliberately, so
 *      this is the ordinary answer when a customer took that hour from her phone
 *      while the front desk was typing. Rendered as an answer, not a failure.
 *
 * Cleanup is manual: no `globals: true` in this project.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StaffPerms } from '@avo/types';
import { ApiError } from '../api/client.js';
import type { MerchantBooking } from '../api/bookings.js';

/* ------------------------------------------------------------- the mocks -- */

/**
 * `BookingRow` takes everything as props, so only the module-level imports need
 * standing in for. `isSlotTaken` is the REAL one — it is a pure predicate over
 * an `ApiError`, and stubbing it would make the branch it selects unreachable
 * from this file without anything saying so.
 */
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../api/salon.js', () => ({ useSalon: () => ({ data: undefined }) }));
vi.mock('../api/artists.js', () => ({ useBookableArtists: () => ({ data: undefined }) }));
vi.mock('./AppointmentForm.js', () => ({ AppointmentForm: () => null }));
vi.mock('../auth/AuthProvider.js', () => ({ useSession: () => ({ perms: ALL_PERMS }) }));

const ALL_PERMS = {
  dashboard: true,
  appointments: true,
  shop: true,
  loyalty: true,
  team: true,
  scanner: true,
  charges: true,
  void: true,
  marketing: true,
} as StaffPerms;

const {
  BookingRow,
  canCancel,
  canComplete,
  canReassign,
  canReschedule,
} = await import('./Appointments.js');
type ControlKind = import('./Appointments.js').ControlKind;
type RowControls = import('./Appointments.js').RowControls;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/* --------------------------------------------------------------- fixtures -- */

/**
 * AN APP BOOKING WITH A REAL HELD DEPOSIT. 5.000 KD in integer fils — #1; no
 * float reaches this field.
 */
const HELD: MerchantBooking = {
  id: 'BK-9d0c1f6a-2b44-4d1e-9f77-5a2e3c8b1d40',
  memberId: 'MB-1a2b3c4d5e',
  guestName: null,
  guestPhone: null,
  artistId: 'AR-1a2b3c4d5e',
  branchId: 'BR-1a2b3c4d5e',
  serviceId: 'SV-1a2b3c4d5e',
  startsAt: '2026-09-17T10:00:00.000Z',
  endsAt: '2026-09-17T11:00:00.000Z',
  durationMin: 60,
  depositFils: 5000,
  status: 'deposit_held',
  source: 'app',
  changeableUntil: '2026-09-17T09:00:00.000Z',
  noShowReturnDueAt: '2026-09-17T12:00:00.000Z',
  rescheduledCount: 0,
  calendarSyncState: 'synced',
  branchAssumed: false,
  memberName: 'Dana Al-Sabah',
  memberPhone: '+96599124408',
  memberErased: false,
  memberTier: 'gold',
  artistName: 'Noura Al-Rashid',
  serviceName: 'Balayage',
};

/**
 * THE HAND-WRITTEN ONE. `source: 'merchant'`, `depositFils: 0`, `memberId: null`
 * and a `guestName` — the shape `booking_merchant_is_zero_deposit` and
 * `booking_identity_exactly_one` guarantee together.
 *
 * `memberName` CARRIES THE GUEST'S NAME, which is not this client's doing: the
 * board's own serialiser is `memberName: r.memberName ?? r.b.guestName`, one
 * field meaning "who is this appointment for". The row must draw it.
 */
const WALK_IN: MerchantBooking = {
  ...HELD,
  id: 'BK-4e7b2a10-8c33-4f0d-b1a6-9d5c2e4f7a81',
  memberId: null,
  guestName: 'Mariam Al-Ajmi',
  guestPhone: '+96590011223',
  depositFils: 0,
  source: 'merchant',
  calendarSyncState: 'not_applicable',
  memberName: 'Mariam Al-Ajmi',
  memberTier: null,
};

const noop = () => {};

/**
 * `can` IS COMPUTED FROM THE REAL PREDICATES BY DEFAULT, not hard-coded true.
 *
 * A fixture that asserts every control is allowed would render every control on
 * every row and prove nothing about the gating — the first version of this file
 * did exactly that and "Mark done is not offered on a deposit-bearing booking"
 * failed, correctly, against a `can.complete: true` nobody had thought about.
 * Deriving it means the render tests below exercise the same four functions the
 * screen calls, and an override is an explicit statement about one control.
 */
function controls(booking: MerchantBooking, over: Partial<RowControls> = {}): RowControls {
  return {
    can: {
      reschedule: canReschedule(booking, ALL_PERMS),
      reassign: canReassign(booking, ALL_PERMS),
      cancel: canCancel(booking, ALL_PERMS),
      complete: canComplete(booking, ALL_PERMS),
    },
    open: null,
    pending: false,
    error: null,
    artists: [
      { id: 'AR-1a2b3c4d5e', name: 'Noura Al-Rashid' },
      { id: 'AR-9f8e7d6c5b', name: 'Shaikha Al-Otaibi' },
    ],
    timezone: 'Asia/Kuwait',
    onOpen: noop,
    onDismiss: noop,
    onReschedule: noop,
    onReassign: noop,
    onCancel: noop,
    onComplete: noop,
    ...over,
  };
}

function renderRow(booking: MerchantBooking, over: Partial<RowControls> = {}) {
  return render(
    <table>
      <tbody>
        <BookingRow
          booking={booking}
          controls={controls(booking, over)}
          canMark={false}
          armed={false}
          marking={false}
          markError={null}
          onArm={noop}
          onCancel={noop}
          onConfirm={noop}
        />
      </tbody>
    </table>,
  );
}

/** Everything the row draws, as one string — for the "the word is absent" checks. */
function rowText(): string {
  return document.body.textContent ?? '';
}

/** The open arm-then-confirm step, so an assertion cannot land on the Deposit column. */
function confirmStep(): HTMLElement {
  const step = document.querySelector('.appts__confirm');
  expect(step, 'no confirmation step is open').toBeTruthy();
  return step as HTMLElement;
}

/* ================================= 1 · the pill, and the word "deposit" ==== */

describe('the pill is rendered from depositFils, not from status alone', () => {
  it('a zero-deposit live booking reads "Booked", and never "Deposit held"', () => {
    renderRow(WALK_IN);
    expect(screen.getByText('Booked')).toBeTruthy();
    expect(screen.queryByText('Deposit held')).toBeNull();
  });

  it('a zero-deposit no-show reads "No-show", and never "No-show · returned"', () => {
    renderRow({ ...WALK_IN, status: 'no_show_returned' });
    expect(screen.getByText('No-show')).toBeTruthy();
    expect(screen.queryByText('No-show · returned')).toBeNull();
  });

  /**
   * THE WHOLE POINT, STATED AS AN ABSENCE. Not "the label is different" but "the
   * word is not on the screen" — because the failure being prevented is a
   * merchant reading, anywhere in this cell, that money moved. The pill was one
   * of three places that said it: the pill, the "Returns … if missed" line under
   * it, and the no-show confirmation.
   */
  it.each([
    ['live', 'deposit_held'],
    ['missed', 'no_show_returned'],
  ] as const)('never says "deposit" anywhere on a %s zero-deposit row', (_n, status) => {
    renderRow({ ...WALK_IN, status });
    expect(rowText().toLowerCase()).not.toContain('deposit');
    expect(rowText()).not.toContain('Returns');
  });

  /**
   * AND THE DEPOSIT-BEARING ROW IS UNCHANGED, PINNED VERBATIM.
   *
   * This is the half that proves the containment is a containment and not a
   * rewrite. Every string here is what this board printed before hand-written
   * appointments existed; if the zero-deposit branch ever widens to swallow an
   * app booking, a customer's real 5.000 KD stops being named on the board where
   * a merchant decides what to do about it.
   */
  it('a deposit-bearing live booking still reads exactly what it read before', () => {
    renderRow(HELD);
    expect(screen.getByText('Deposit held')).toBeTruthy();
    expect(rowText()).toContain('Returns');
    expect(rowText()).toContain('if missed');
    expect(screen.queryByText('Booked')).toBeNull();
  });

  it('a deposit-bearing no-show still reads "No-show · returned"', () => {
    renderRow({ ...HELD, status: 'no_show_returned' });
    expect(screen.getByText('No-show · returned')).toBeTruthy();
    expect(screen.queryByText('No-show')).toBeNull();
  });

  /** The two statuses that assert nothing about money are untouched at either amount. */
  it.each([
    ['completed', 'Completed'],
    ['cancelled', 'Cancelled'],
  ] as const)('%s reads "%s" at both amounts', (status, label) => {
    renderRow({ ...WALK_IN, status });
    expect(screen.getByText(label)).toBeTruthy();
    cleanup();
    renderRow({ ...HELD, status });
    expect(screen.getByText(label)).toBeTruthy();
  });
});

/* ========================================== 2 · a guest is not a blank row == */

describe('a walk-in row names the person it is for', () => {
  it('renders the guest name the front desk wrote down', () => {
    renderRow(WALK_IN);
    expect(screen.getByText('Mariam Al-Ajmi')).toBeTruthy();
  });

  /**
   * AND SAYS THERE IS NO ACCOUNT BEHIND IT. A member can be looked up, messaged,
   * and has a wallet and a tier; a walk-in has a line in a diary. The marker is
   * `memberId === null` — `booking_identity_exactly_one` makes that exact — and
   * NOT `source === 'merchant'`, because a merchant may write an appointment
   * down for an existing member and that row does have an account.
   */
  it('marks her as having no account, and does not mark a member as one', () => {
    renderRow(WALK_IN);
    expect(screen.getByText('Walk-in · no account')).toBeTruthy();
    cleanup();

    renderRow({ ...HELD, source: 'merchant', depositFils: 0 });
    expect(screen.getByText('Dana Al-Sabah')).toBeTruthy();
    expect(screen.queryByText('Walk-in · no account')).toBeNull();
  });
});

/* ================================================ 3 · which controls appear */

describe('"Mark done" is offered only where the server will allow it', () => {
  it('is offered on a zero-deposit booking', () => {
    renderRow(WALK_IN);
    expect(
      screen.getByRole('button', { name: "Mark Mariam Al-Ajmi's appointment as done" }),
    ).toBeTruthy();
  });

  /**
   * AND NOT ON A DEPOSIT-BEARING ONE. The predicate, then the render — the
   * predicate because it is the thing other code will reuse, the render because
   * a predicate nobody consults is a true sentence with no effect.
   */
  it('is not offered on a deposit-bearing booking', () => {
    expect(canComplete(HELD, { appointments: true })).toBe(false);
    renderRow(HELD);
    expect(screen.queryByRole('button', { name: /as done$/ })).toBeNull();
  });

  it('is not offered once the booking is no longer live', () => {
    for (const status of ['completed', 'cancelled', 'no_show_returned'] as const) {
      expect(canComplete({ ...WALK_IN, status }, { appointments: true })).toBe(false);
    }
  });
});

describe('the four controls are gated on the reader, and the gate is not the control', () => {
  /** ST-002 Hessa: frontdesk. `appointments: true`, `void: false`. */
  const FRONT_DESK = { appointments: true, void: false };
  /** An artist-shaped reader who can see the board and change nothing. */
  const NEITHER = { appointments: false, void: false };

  it('gives the front desk change-time and reassign, and withholds cancel', () => {
    expect(canReschedule(HELD, FRONT_DESK)).toBe(true);
    expect(canReassign(HELD, FRONT_DESK)).toBe(true);
    expect(canComplete(WALK_IN, FRONT_DESK)).toBe(true);
    expect(canCancel(HELD, FRONT_DESK)).toBe(false);
  });

  it.each([
    ['reschedule', /Change the date or time/],
    ['reassign', /Reassign .* to another artist/],
    ['cancel', /^Cancel .*'s appointment$/],
    ['complete', /as done$/],
  ] as const)('%s is absent for a reader without the permission', (kind, name) => {
    renderRow(WALK_IN, { can: { ...controls(WALK_IN).can, [kind]: false } });
    expect(screen.queryByRole('button', { name })).toBeNull();
  });

  it('draws none of the four for a reader holding neither permission', () => {
    renderRow(WALK_IN, {
      can: {
        reschedule: canReschedule(WALK_IN, NEITHER),
        reassign: canReassign(WALK_IN, NEITHER),
        cancel: canCancel(WALK_IN, NEITHER),
        complete: canComplete(WALK_IN, NEITHER),
      },
    });
    expect(screen.queryByRole('button')).toBeNull();
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════
   * AND THE 403 IS BUILT ANYWAY, WHICH IS THE HALF #7 IS ACTUALLY ABOUT
   * ═══════════════════════════════════════════════════════════════════════
   * The reachable path is a mid-session revocation: `session.perms` is the
   * snapshot taken at sign-in, so a permission taken away in Accounts lands on a
   * board that is already open and still drawing the link. The server's own
   * sentence is rendered verbatim — it names the permission AND who can grant it
   * back, and a paraphrase here would drop the second half.
   */
  it('renders the server\'s refusal when a control is called anyway', () => {
    renderRow(HELD, {
      open: 'cancel',
      error: new ApiError(
        'You need the Void permission for this. A manager can grant it in Accounts.',
        { status: 403, code: 'forbidden' },
      ),
    });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('You need the Void permission for this.');
    expect(alert.textContent).toContain('A manager can grant it in Accounts.');
  });

  /**
   * THE REASSURANCE IS TRUE OF THE ROW IT IS UNDER. "The deposit is still held"
   * is correct on an app booking and is the pill's lie again on a hand-written
   * one — under a failure, which is the worst moment to tell a merchant
   * something reassuring and false.
   */
  it('reassures about a deposit only where there is one', () => {
    const refusal = new ApiError('That appointment can no longer be changed.', {
      status: 409,
      code: 'not_changeable',
    });

    renderRow(HELD, { open: 'cancel', error: refusal });
    expect(screen.getByRole('alert').textContent).toContain('The deposit is still held.');
    cleanup();

    renderRow(WALK_IN, { open: 'cancel', error: refusal });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Nothing has changed.');
    expect(alert.textContent?.toLowerCase()).not.toContain('deposit');
  });
});

/* ================================================== 4 · the recoverable 409 */

describe('slot_taken is a refusal a merchant can act on', () => {
  const TAKEN = new ApiError('That artist already has an appointment then.', {
    status: 409,
    code: 'slot_taken',
  });

  it('names a different time as the way out of a reschedule', () => {
    renderRow(HELD, { open: 'reschedule', error: TAKEN });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('That artist already has an appointment then.');
    expect(alert.textContent).toContain('Pick another time.');
    expect(alert.textContent).toContain('This appointment has not moved.');
  });

  it('names a different artist as the way out of a reassign', () => {
    renderRow(HELD, { open: 'reassign', error: TAKEN });
    expect(screen.getByRole('alert').textContent).toContain('Pick a different artist');
  });

  /**
   * AND IT IS NOT DRAWN AS A GENERIC FAILURE. `WriteError`'s reassurance is the
   * marker: a 409 that took the ordinary branch would carry "The deposit is
   * still held." beside it, which says nothing about what to do and reads as
   * "that didn't work".
   */
  it('does not take the generic write-error branch', () => {
    renderRow(HELD, { open: 'reschedule', error: TAKEN });
    expect(screen.getByRole('alert').textContent).not.toContain('The deposit is still held.');
  });

  /** The step stays open, so the retry is a correction and not a re-entry. */
  it('leaves the reschedule step on screen with its fields', () => {
    renderRow(HELD, { open: 'reschedule', error: TAKEN });
    expect(screen.getByLabelText('New date')).toBeTruthy();
    expect(screen.getByLabelText('New time (Asia/Kuwait)')).toBeTruthy();
  });
});

/* ===================================================== 5 · the steps behave */

describe('the in-row steps send what the merchant chose', () => {
  it('seeds the reschedule fields from the hour the booking is at, in the salon zone', () => {
    // 10:00Z is 13:00 in Asia/Kuwait (UTC+3, no DST).
    renderRow(HELD, { open: 'reschedule' });
    expect((screen.getByLabelText('New date') as HTMLInputElement).value).toBe('2026-09-17');
    expect((screen.getByLabelText('New time (Asia/Kuwait)') as HTMLInputElement).value).toBe(
      '13:00',
    );
  });

  it('converts the typed wall clock back to an instant in the salon zone', () => {
    const onReschedule = vi.fn();
    renderRow(HELD, { open: 'reschedule', onReschedule });

    fireEvent.change(screen.getByLabelText('New date'), { target: { value: '2026-09-20' } });
    fireEvent.change(screen.getByLabelText('New time (Asia/Kuwait)'), {
      target: { value: '16:45' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Move Dana/ }));

    expect(onReschedule).toHaveBeenCalledWith('2026-09-20T13:45:00.000Z');
  });

  /**
   * THE CURRENT ARTIST IS NOT IN THE LIST. `reassignArtist` answers 400
   * `same_artist` — offering her is offering a refusal.
   */
  it('offers every artist except the one the appointment is already with', () => {
    renderRow(HELD, { open: 'reassign' });
    const select = screen.getByLabelText('Hand it to') as HTMLSelectElement;
    const labels = [...select.options].map((o) => o.textContent);
    expect(labels).toContain('Shaikha Al-Otaibi');
    expect(labels).not.toContain('Noura Al-Rashid');
  });

  it('sends the chosen artist id', () => {
    const onReassign = vi.fn();
    renderRow(HELD, { open: 'reassign', onReassign });
    fireEvent.change(screen.getByLabelText('Hand it to'), {
      target: { value: 'AR-9f8e7d6c5b' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Reassign Dana/ }));
    expect(onReassign).toHaveBeenCalledWith('AR-9f8e7d6c5b');
  });

  /**
   * THE CANCEL QUESTION STATES THE MONEY WHERE THERE IS MONEY, AND DOES NOT
   * INVENT A REFUND WHERE THERE IS NONE. `<Money>` announces "5.000 Kuwaiti
   * dinars" rather than letting a screen reader read "five thousand" off the
   * digits — #1 and interaction-spec.md §2.
   */
  it('names the deposit it will return on an app booking', () => {
    renderRow(HELD, { open: 'cancel' });
    const step = confirmStep();
    expect(step.textContent).toContain('return');
    expect(step.textContent).toContain('5.000');
    /*
     * THE ANNOUNCED STRING, NOT THE DRAWN ONE. `<Money>` puts
     * `aria-label="5.000 Kuwaiti dinars"` on the wrapper and `aria-hidden` on
     * the glyphs, so this reads as an amount rather than as "five thousand" —
     * #1 and interaction-spec.md §2. Scoped to the step: the Deposit COLUMN
     * carries the same amount and the same label, which is correct of the board
     * and would make an unscoped lookup pass with no confirmation on screen.
     */
    expect(within(step).getByLabelText('5.000 Kuwaiti dinars')).toBeTruthy();
  });

  it('offers to return nothing on a hand-written one, and says why', () => {
    renderRow(WALK_IN, { open: 'cancel' });
    const step = confirmStep();
    expect(step.textContent).toContain('No deposit was taken.');
    /*
     * NO "return", AND NO AMOUNT. The Deposit column still prints "0.000 KD",
     * which is the true value of a field the board has — the defect this guards
     * against is an amount inside a SENTENCE about money moving.
     */
    expect(step.textContent).not.toContain('return');
    expect(step.textContent).not.toContain('0.000');
    expect(within(step).queryByLabelText(/Kuwaiti dinars/)).toBeNull();
  });

  /** A write in flight disables both halves of every step. */
  it.each(['cancel', 'complete', 'reassign', 'reschedule'] as const)(
    'disables the %s step while its write is in flight',
    (kind: ControlKind) => {
      renderRow(WALK_IN, { open: kind, pending: true });
      for (const button of screen.getAllByRole('button')) {
        expect((button as HTMLButtonElement).disabled).toBe(true);
      }
    },
  );
});
