// @vitest-environment jsdom

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE DEPOSIT QUEUE IS REACHABLE, AND IT IS REACHABLE FROM APPOINTMENTS
 * ═══════════════════════════════════════════════════════════════════════════
 * WRITTEN BECAUSE THE REST OF THIS SLICE COULD NOT HAVE CAUGHT THE OPPOSITE.
 * `depositHealthRender.test.tsx` mounts `<DepositHealth />` directly — which is
 * right for what it asserts — so the view could be mounted behind a condition
 * that never fires, or behind no condition at all, and all forty-eight of those
 * specs would still pass over a screen no merchant can open. A feature that is
 * unreachable is indistinguishable from a feature that is broken, and neither
 * shows up in a test that renders the component itself.
 *
 * WHERE IT GOES WAS A DECISION AND THIS IS THE HALF OF IT THAT CAN ROT.
 * `DepositHealth.tsx § WHY IT IS A VIEW OF APPOINTMENTS` argues it: the endpoint
 * is `requireDashboardPerm(req, 'appointments')`, the same gate this board has
 * already passed, and the front desk (`db/seed.ts § ST-002`, Hessa) holds that
 * permission and not `dashboard`. So it is a third view of this board rather
 * than a card on Overview or a tenth nav item.
 *
 * FOUR GUARANTEES:
 *
 *   1. THE CONTROL OFFERS IT, beside List and Week, in one radiogroup.
 *   2. CHOOSING IT MOUNTS THE VIEW.
 *   3. IT IS NOT THE DEFAULT. The door opens on the view with no preconditions —
 *      `Appointments.tsx` argues this for the week and the argument survives a
 *      third option.
 *   4. IT IS NOT OFFERED WITH BOOKING SWITCHED OFF. A salon with
 *      `modules.booking` off has no bookings by construction and therefore no
 *      deposits; "No deposits on hold" shown there would be the switched-off
 *      empty's sentence told wrong, and `AVO States.dc.html` is explicit that the
 *      two empties must never share copy.
 *
 * `DepositHealth` IS STUBBED, for the reason `noShowMarkRender.test.tsx` stubs
 * `AppointmentForm`: this file's subject is whether the host reaches it, and the
 * real component's read, parser and branch context belong to the file that
 * drives them. The stub renders a sentinel, so "mounted" is a fact about the DOM
 * rather than about a mock's call count.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffPerms } from '@avo/types';

const useSalon = vi.fn();
const useSalonBookings = vi.fn();
const perms = { appointments: true, void: true } as StaffPerms;

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../api/salon.js', () => ({ useSalon: () => useSalon() }));

const idleWrite = () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null });
vi.mock('../api/bookings.js', async () => {
  const real = await vi.importActual<typeof import('../api/bookings.js')>('../api/bookings.js');
  return {
    isSlotTaken: real.isSlotTaken,
    useSalonBookings: () => useSalonBookings(),
    useMarkNoShow: idleWrite,
    useRescheduleBooking: idleWrite,
    useReassignArtist: idleWrite,
    useCancelBooking: idleWrite,
    useCompleteBooking: idleWrite,
  };
});
vi.mock('../api/artists.js', () => ({ useBookableArtists: () => ({ data: undefined }) }));
vi.mock('./AppointmentForm.js', () => ({ AppointmentForm: () => null }));
/** The week grid owns four reads of its own; this file never opens it. */
vi.mock('./AppointmentsWeek.js', () => ({
  AppointmentsWeek: () => <div data-testid="week-view" />,
}));
vi.mock('./DepositHealth.js', () => ({
  DepositHealth: () => <div data-testid="deposits-view" />,
}));
vi.mock('../auth/AuthProvider.js', () => ({ useSession: () => ({ perms }) }));

const { Appointments } = await import('./Appointments.js');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  useSalonBookings.mockReturnValue({
    data: { items: [], nextCursor: null },
    isPending: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  });
});

function mount(booking = true) {
  useSalon.mockReturnValue({
    data: { modules: { booking }, noShowReturnMinutes: 60, timezone: 'Asia/Kuwait' },
    isPending: false,
    isError: false,
    isSuccess: true,
    isFetching: false,
    refetch: vi.fn(),
  });
  return render(<Appointments />);
}

describe('Deposits is the board’s third view', () => {
  it('is offered beside List and Week, in one radiogroup', () => {
    mount();
    const group = screen.getByRole('radiogroup', { name: 'Appointments view' });
    expect([...group.querySelectorAll('[role="radio"]')].map((r) => r.textContent)).toEqual([
      'List',
      'Week',
      'Deposits',
    ]);
  });

  it('mounts the deposit queue when it is chosen', () => {
    mount();
    expect(screen.queryByTestId('deposits-view')).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: 'Deposits' }));

    expect(screen.getByTestId('deposits-view')).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Deposits' }).getAttribute('aria-checked')).toBe(
      'true',
    );
  });

  /**
   * IT REPLACES THE LIST RATHER THAN SITTING UNDER IT. Three views of one board
   * drawn at once is three answers to one question, and the two tables would
   * duplicate every row the queue is about.
   */
  it('replaces the other two views rather than joining them', () => {
    mount();
    fireEvent.click(screen.getByRole('radio', { name: 'Deposits' }));

    expect(screen.queryByTestId('week-view')).toBeNull();
    expect(document.querySelector('.appts__table')).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: 'List' }));
    expect(screen.queryByTestId('deposits-view')).toBeNull();
    expect(document.querySelector('.appts__table')).toBeTruthy();
  });

  /**
   * NOT THE DEFAULT. `Appointments.tsx` argues it for the week: the door opens on
   * the view with no preconditions, and a section whose default view can answer
   * "not yet" sometimes greets a merchant with an explanation instead of her
   * appointments. The deposit queue has a read that can fail like any other.
   */
  it('is not what the section opens on', () => {
    mount();
    expect(screen.queryByTestId('deposits-view')).toBeNull();
    expect(document.querySelector('.appts__table')).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'List' }).getAttribute('aria-checked')).toBe('true');
  });

  /**
   * SWITCHED-OFF BOOKING HIDES THE WHOLE CONTROL, and with it this view. A salon
   * that cannot take bookings holds no deposits, so the queue would answer "No
   * deposits on hold" — true, and the wrong sentence: the fact she needs is that
   * booking is off and where to turn it on, which is the empty the list already
   * owns.
   */
  it('is not offered at all when booking is switched off', () => {
    mount(false);
    expect(screen.queryByRole('radiogroup', { name: 'Appointments view' })).toBeNull();
    expect(screen.queryByRole('radio', { name: 'Deposits' })).toBeNull();
    expect(screen.queryByTestId('deposits-view')).toBeNull();
    expect(screen.getByText('Booking is switched off')).toBeTruthy();
  });

  /**
   * THE STRIP ABOVE STAYS, AND THE QUEUE DEPENDS ON IT.
   *
   * `DEPOSIT_FRAMING.awaiting_arrival` says her deposit is held "until the window
   * above runs out" and deliberately does not repeat the number — a figure
   * stated twice on one screen is a figure that can disagree with itself. That
   * sentence is only true while the auto-return strip is actually above it, so
   * the dependency is pinned rather than left to a reader to notice.
   */
  it('keeps the auto-return strip above the queue, which the copy relies on', () => {
    const { container } = mount();
    fireEvent.click(screen.getByRole('radio', { name: 'Deposits' }));

    const strip = container.querySelector('.avo-info__text');
    expect(strip).toBeTruthy();
    expect(strip?.textContent).toContain('Deposits auto-return to the customer’s wallet');
    expect(strip?.textContent).toContain('1 hour');

    // …and it is genuinely ABOVE the view, not merely present somewhere.
    const view = screen.getByTestId('deposits-view');
    const position = (strip as Element).compareDocumentPosition(view);
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
