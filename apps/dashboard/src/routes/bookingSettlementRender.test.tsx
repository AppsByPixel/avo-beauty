// @vitest-environment jsdom

/**
 * Appointments → where a settled deposit went — `booking.settlement`.
 *
 * Under a salon policy (migration 0066) a cancel can return part of a deposit
 * and a no-show can keep all of it, so the deposit figure alone no longer says
 * what happened to the money. The split is the server's; the screen formats it
 * with `formatMoney` and nothing else.
 */

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fils } from '@avo/types';
import type { MerchantBooking } from '../api/bookings.js';

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));

const { BookingRow } = await import('./Appointments.js');
const { BookingPopover } = await import('./AppointmentsWeek.js');
const { chipLabel, pillFor, settlementText } = await import('./appointmentsWeekRules.js');
const { patchBookingStatus } = await import('../api/bookings.js');

afterEach(cleanup);

const STAMP = {
  id: 'BP-1',
  version: 1,
  noShow: 'keep' as const,
  cancellation: [{ hoursBefore: 24, returnPercent: 50 }],
  text: { en: 'Half back a day ahead.', ar: '' },
};

const BASE: MerchantBooking = {
  id: 'BK-1',
  memberId: 'MB-1',
  guestName: null,
  guestPhone: null,
  artistId: 'AR-1',
  branchId: 'BR-1',
  serviceId: 'SV-1',
  startsAt: '2026-09-17T10:00:00.000Z',
  endsAt: '2026-09-17T11:00:00.000Z',
  durationMin: 60,
  depositFils: fils(5005),
  status: 'deposit_held',
  source: 'app',
  changeableUntil: '2026-09-17T09:00:00.000Z',
  noShowReturnDueAt: '2026-09-17T11:00:00.000Z',
  rescheduledCount: 0,
  calendarSyncState: 'synced',
  policy: STAMP,
  settlement: null,
  branchAssumed: false,
  memberName: 'Dana Al-Sabah',
  memberPhone: '+96599124408',
  memberErased: false,
  memberTier: 'gold',
  artistName: 'Noura Al-Rashid',
  serviceName: 'Balayage',
};

const settled = (over: Partial<MerchantBooking>): MerchantBooking => ({ ...BASE, ...over });

const noop = () => {};
const CONTROLS: Parameters<typeof BookingRow>[0]['controls'] = {
  can: { reschedule: false, reassign: false, cancel: false, complete: false },
  open: null,
  pending: false,
  error: null,
  artists: [],
  timezone: 'Asia/Kuwait',
  onOpen: noop,
  onDismiss: noop,
  onReschedule: noop,
  onReassign: noop,
  onCancel: noop,
  onComplete: noop,
};

function renderRow(booking: MerchantBooking) {
  return render(
    <table>
      <tbody>
        <BookingRow
          booking={booking}
          controls={CONTROLS}
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

describe('the settlement line', () => {
  it('names a full return, a keep, and a split, in formatMoney’s words', () => {
    expect(settlementText(settled({ settlement: { returnedFils: fils(5005), keptFils: fils(0) } }))).toBe(
      'Returned 5.005 KD',
    );
    expect(settlementText(settled({ settlement: { returnedFils: fils(0), keptFils: fils(5005) } }))).toBe(
      'Kept 5.005 KD',
    );
    // 50% of 5.005 KD rounds DOWN to 2.502; the salon keeps the remainder fil.
    expect(settlementText(settled({ settlement: { returnedFils: fils(2502), keptFils: fils(2503) } }))).toBe(
      'Returned 2.502 KD · kept 2.503 KD',
    );
  });

  it('says nothing before it settles, or on a booking that never held a deposit', () => {
    expect(settlementText(BASE)).toBeNull();
    expect(
      settlementText(
        settled({ depositFils: fils(0), settlement: { returnedFils: fils(0), keptFils: fils(0) } }),
      ),
    ).toBeNull();
  });

  it('draws under the deposit on the list', () => {
    const { container } = renderRow(
      settled({ status: 'cancelled', settlement: { returnedFils: fils(2502), keptFils: fils(2503) } }),
    );
    const cell = container.querySelector('.appts__deposit') as HTMLElement;
    expect(within(cell).getByText('Returned 2.502 KD · kept 2.503 KD')).toBeTruthy();
  });

  it('draws under the deposit in the week popover', () => {
    render(
      <BookingPopover
        booking={settled({
          status: 'no_show_returned',
          settlement: { returnedFils: fils(0), keptFils: fils(5005) },
        })}
        timezone="Asia/Kuwait"
        onClose={noop}
      >
        {null}
      </BookingPopover>,
    );
    const deposit = screen.getByText('Deposit').parentElement as HTMLElement;
    expect(within(deposit).getByText('Kept 5.005 KD')).toBeTruthy();
  });
});

describe('a kept no-show is not called returned', () => {
  const keptNoShow = settled({
    status: 'no_show_returned',
    settlement: { returnedFils: fils(0), keptFils: fils(5005) },
  });

  it('labels the pill "No-show · kept" on the list and on the grid', () => {
    expect(pillFor(keptNoShow).label).toBe('No-show · kept');
    const { container } = renderRow(keptNoShow);
    expect(container.textContent).toContain('No-show · kept');
    expect(container.textContent).not.toContain('No-show · returned');
  });

  it('keeps "No-show · returned" where the deposit did go back', () => {
    expect(
      pillFor(settled({ status: 'no_show_returned', settlement: { returnedFils: fils(5005), keptFils: fils(0) } }))
        .label,
    ).toBe('No-show · returned');
  });

  it('names the keep in the chip’s accessible label too', () => {
    const label = chipLabel({
      booking: keptNoShow,
      date: '2026-09-17',
      startMin: 780,
      endMin: 840,
      continues: false,
    } as Parameters<typeof chipLabel>[0]);
    expect(label).toContain('No-show · kept');
  });
});

describe('the deadline line follows the booking’s own stamp', () => {
  it('says "Kept … if missed" under a keep stamp, and "Returns … if missed" otherwise', () => {
    const { container, unmount } = renderRow(BASE);
    expect(container.querySelector('.appts__due')?.textContent).toMatch(/^Kept .* if missed$/);
    unmount();
    const legacy = renderRow(settled({ policy: null }));
    expect(legacy.container.querySelector('.appts__due')?.textContent).toMatch(/^Returns .* if missed$/);
  });
});

describe('a settling write patches the settlement with the status', () => {
  it('writes both fields onto the row, and leaves the settlement alone when none is given', () => {
    const page = { items: [BASE], nextCursor: null };
    const split = { returnedFils: fils(0), keptFils: fils(5005) };
    const next = patchBookingStatus(page, 'BK-1', 'no_show_returned', split) as typeof page;
    expect(next.items[0]).toMatchObject({ status: 'no_show_returned', settlement: split });
    const only = patchBookingStatus(page, 'BK-1', 'completed') as typeof page;
    expect(only.items[0]?.settlement).toBeNull();
  });
});
