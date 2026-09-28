// @vitest-environment jsdom

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MERCHANT → APPOINTMENTS → THE STATUS ACTIONS ARE ICON BUTTONS. Aftab,
 * 2026-09-29: "The change status buttons on the appointment lists should be
 * more visible like icons".
 * ═══════════════════════════════════════════════════════════════════════════
 *   1. EACH OF THE FIVE IS A REAL <button> with an icon, a visible short word
 *      and an accessible name that names the customer.
 *   2. THE ICON IS DECORATIVE — `aria-hidden`, so the name is not read twice.
 *   3. CANCEL AND NO-SHOW ARE VISIBLY DISTINCT (the danger tone); the other
 *      three are not.
 *   4. THE CONFIRM STEPS SURVIVE: pressing cancel or no-show still arms rather
 *      than writes.
 *   5. THE WEEK POPOVER GETS THE SAME BUTTONS — it renders the same component.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StaffPerms } from '@avo/types';
import type { MerchantBooking } from '../api/bookings.js';

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../api/salon.js', () => ({ useSalon: () => ({ data: undefined }) }));
vi.mock('../api/artists.js', () => ({ useBookableArtists: () => ({ data: undefined }) }));
vi.mock('./AppointmentForm.js', () => ({ AppointmentForm: () => null }));
vi.mock('../auth/AuthProvider.js', () => ({ useSession: () => ({ perms: {} }) }));

const { BookingActions, BookingRow } = await import('./Appointments.js');
const { BookingPopover } = await import('./AppointmentsWeek.js');
type BookingActionsProps = import('./Appointments.js').BookingActionsProps;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const noop = () => {};

/** A walk-in at 0 fils that has started: every one of the five is offered. */
const WALK_IN: MerchantBooking = {
  id: 'BK-4e7b2a10-8c33-4f0d-b1a6-9d5c2e4f7a81',
  memberId: null,
  guestName: 'Mariam Al-Ajmi',
  guestPhone: '+96590011223',
  artistId: 'AR-1a2b3c4d5e',
  branchId: 'BR-1a2b3c4d5e',
  serviceId: 'SV-1a2b3c4d5e',
  startsAt: '2026-09-17T10:00:00.000Z',
  endsAt: '2026-09-17T11:00:00.000Z',
  durationMin: 60,
  depositFils: 0,
  status: 'deposit_held',
  source: 'merchant',
  changeableUntil: '2026-09-17T09:00:00.000Z',
  noShowReturnDueAt: '2026-09-17T12:00:00.000Z',
  rescheduledCount: 0,
  calendarSyncState: 'not_applicable',
  policy: null,
  settlement: null,
  returnCapPercent: null,
  branchAssumed: false,
  memberName: 'Mariam Al-Ajmi',
  memberPhone: '+96590011223',
  memberErased: false,
  memberTier: null,
  artistName: 'Noura Al-Rashid',
  serviceName: 'Blow-dry',
};

function props(over: Partial<BookingActionsProps> = {}): BookingActionsProps {
  return {
    booking: WALK_IN,
    controls: {
      can: { reschedule: true, reassign: true, cancel: true, complete: true },
      open: null,
      pending: false,
      error: null,
      artists: [],
      timezone: 'Asia/Kuwait',
      onOpen: vi.fn(),
      onDismiss: noop,
      onReschedule: noop,
      onReassign: noop,
      onCancel: vi.fn(),
      onComplete: noop,
    },
    canMark: true,
    armed: false,
    marking: false,
    markError: null,
    onArm: vi.fn(),
    onCancel: noop,
    onConfirm: vi.fn(),
    ...over,
  };
}

function renderRow(p: BookingActionsProps = props()) {
  return render(
    <table>
      <tbody>
        <BookingRow {...p} />
      </tbody>
    </table>,
  );
}

const FIVE = [
  { name: 'Change the date or time for Mariam Al-Ajmi', word: 'Change time', danger: false },
  { name: 'Reassign Mariam Al-Ajmi to another artist', word: 'Reassign', danger: false },
  { name: "Mark Mariam Al-Ajmi's appointment as done", word: 'Mark done', danger: false },
  { name: "Cancel Mariam Al-Ajmi's appointment", word: 'Cancel appointment', danger: true },
  { name: 'Mark no-show for Mariam Al-Ajmi', word: 'Mark no-show', danger: true },
] as const;

describe('the five status actions are icon buttons', () => {
  it.each(FIVE)('$word: a button with an icon, its word, and a name', ({ name, word }) => {
    renderRow();
    const button = screen.getByRole('button', { name });
    expect(button.tagName).toBe('BUTTON');
    expect(button.className).toContain('avo-iconbtn');
    expect(button.textContent).toBe(word);
    const svg = button.querySelector('svg');
    expect(svg, 'no icon').not.toBeNull();
    expect(svg!.getAttribute('aria-hidden')).toBe('true');
  });

  it.each(FIVE)('$word: danger tone only where the action cannot be undone', ({ name, danger }) => {
    renderRow();
    const button = screen.getByRole('button', { name });
    expect(button.className.includes('avo-iconbtn--danger')).toBe(danger);
  });

  it('the icons are one set: five different glyphs, same 20×20 frame', () => {
    renderRow();
    const svgs = FIVE.map(({ name }) => screen.getByRole('button', { name }).querySelector('svg')!);
    expect(new Set(svgs.map((s) => s.getAttribute('viewBox')))).toEqual(new Set(['0 0 20 20']));
    expect(new Set(svgs.map((s) => s.innerHTML)).size).toBe(5);
  });
});

describe('the confirm steps survive the restyle', () => {
  it('cancel opens its step and writes nothing', () => {
    const p = props();
    renderRow(p);
    fireEvent.click(screen.getByRole('button', { name: "Cancel Mariam Al-Ajmi's appointment" }));
    expect(p.controls.onOpen).toHaveBeenCalledWith('cancel');
    expect(p.controls.onCancel).not.toHaveBeenCalled();
  });

  it('no-show arms and does not confirm', () => {
    const p = props();
    renderRow(p);
    fireEvent.click(screen.getByRole('button', { name: 'Mark no-show for Mariam Al-Ajmi' }));
    expect(p.onArm).toHaveBeenCalledTimes(1);
    expect(p.onConfirm).not.toHaveBeenCalled();
  });
});

describe('the week popover carries the same buttons', () => {
  it('renders BookingActions, so the five are there by the same names', () => {
    render(
      <BookingPopover booking={WALK_IN} timezone="Asia/Kuwait" onClose={noop}>
        <BookingActions {...props()} />
      </BookingPopover>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Mariam Al-Ajmi' });
    for (const { name } of FIVE) {
      expect(within(dialog).getByRole('button', { name }).className).toContain('avo-iconbtn');
    }
  });
});
