import { useNavigate } from '@tanstack/react-router';
import { formatMoney, parseFils } from '@avo/types';
import { Card, EmptyState, InfoBanner, Pill, Skeleton, type PillTone } from '@avo/ui';
import { useSalonBookings, type BookingStatus, type MerchantBooking } from '../api/bookings.js';
import { useSalon } from '../api/salon.js';
import { SectionError } from './sectionState.js';

/**
 * Merchant → Appointments. `GET /salons/{id}/bookings`, `perms.appointments`.
 *
 * NO COURTESY PERMISSION GATE, DELIBERATELY. The read is
 * `requireDashboardPerm(req, 'appointments')` server-side, so the refusal arrives
 * on its own and `SectionError` explains it; this section writes nothing. Stated
 * rather than left blank — the ledger in sectionState.tsx says why an unexplained
 * absence is not good enough here.
 *
 * A REAL <table>, for the reason the audit log is one: interaction-spec.md §2,
 * "Data tables: `<table>` with real `<th scope="col">`. Not divs." The design
 * draws six unlabelled grid columns, which read to a screen reader as one
 * run-on sentence per booking.
 *
 * THE TWO EMPTIES ARE THE POINT OF THIS SCREEN'S STATE WORK.
 * `AVO States.dc.html`: "Two different empties: nothing booked yet, versus the
 * Booking module switched off. Never show the same copy for both." They are not
 * two phrasings of one condition — they are different facts with different
 * fixes. "No appointments this week" tells a salon that takes bookings that
 * nobody has booked; shown to a salon with the module off it is a lie, because
 * nobody *can* book. The switched-off empty carries the action that resolves it.
 */

/**
 * The status pills, verbatim from the design's `stat` map.
 *
 * TOKEN NOTE — `no_show_returned` is the only one that needs a colour the design
 * names and the tokens do: #F6EAE8 on #B0736F is `--avo-danger-bg` on
 * `--avo-danger-dot`. `Pill`'s `danger` tone pairs `--avo-danger-bg` with
 * `--avo-danger-text` (#8f5a56), which is the same family a shade darker and
 * carries more contrast than the design's own value. Taken deliberately: the
 * design's #B0736F on #F6EAE8 is about 3.0:1, under the 4.5:1 the brand rules
 * demand of text, and this pill is text.
 *
 * `cancelled` has no designed pill at all — the dashboard mock never renders one
 * — but the API can return the status, so it gets the quiet tone rather than an
 * unlabelled row. Reported to trunk: a cancelled booking needs designed copy.
 */
const STATUS_PILL: Record<BookingStatus, { label: string; tone: PillTone }> = {
  deposit_held: { label: 'Deposit held', tone: 'brand' },
  completed: { label: 'Completed', tone: 'quiet' },
  no_show_returned: { label: 'No-show · returned', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'quiet' },
};

/**
 * "Today · 4:30 PM", "Tomorrow · 11:00 AM", "9 Jul · 7:00 PM".
 *
 * The API sends an ISO instant on purpose — the relative phrasing depends on the
 * reader's clock, and non-negotiable #12 makes the Arabic dashboard a real
 * layout rather than a string swap. Appointments look forward as well as back,
 * so this carries "Tomorrow", which the audit log's past-only equivalent does
 * not.
 */
function whenLabel(iso: string): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(at) - midnight(new Date())) / 86_400_000);

  if (days === 0) return `Today · ${time}`;
  if (days === -1) return `Yesterday · ${time}`;
  if (days === 1) return `Tomorrow · ${time}`;
  return `${at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · ${time}`;
}

export function Appointments() {
  const navigate = useNavigate();
  const salon = useSalon();

  /*
   * The module flag decides WHETHER TO ASK, not just what to draw. A salon with
   * booking off has no bookings by construction; asking would answer with an
   * empty list, which is the other empty's evidence. See useSalonBookings().
   */
  const bookingOn = salon.data?.modules.booking ?? false;
  const bookings = useSalonBookings(null, salon.isSuccess && bookingOn);

  // The salon read gates the module question, so its failure is this section's
  // failure — a 403 on `GET /salons/{id}` is still "you can't", and rendering
  // the table shell around an unknown module state would be a guess.
  const failed = salon.isError ? salon : bookings.isError ? bookings : null;
  if (failed) {
    return (
      <SectionError
        error={failed.error}
        forbiddenTitle="You don't have access to appointments"
        failedTitle="Couldn't load Appointments"
        onRetry={() => {
          void salon.refetch();
          void bookings.refetch();
        }}
        retrying={salon.isFetching || bookings.isFetching}
      />
    );
  }

  const loading = salon.isPending || (bookingOn && bookings.isPending);
  const rows = bookings.data?.items ?? [];

  return (
    <div className="appts">
      <InfoBanner icon={<ClockGlyph />}>
        Deposits auto-return to the customer&rsquo;s wallet <b>1 hour</b> after a missed slot — the
        money never leaves the ecosystem.
      </InfoBanner>

      {/*
        THE SWITCHED-OFF EMPTY. Its own copy, its own tone, and the one action
        that resolves it. It replaces the table rather than sitting inside it:
        an empty table with headers says "we looked and found none", which is
        the other empty's sentence.
      */}
      {salon.isSuccess && !bookingOn ? (
        <Card className="appts__off">
          <EmptyState
            title="Booking is switched off"
            body="Turn it on in Settings and your team's hours become bookable. Nothing changes for existing customers."
            action={{ label: 'Open Settings', onClick: () => void navigate({ to: '/settings' }) }}
          />
        </Card>
      ) : (
        <Card className="appts__card" flush>
          <div className="appts__scroll">
            <table className="appts__table">
              <caption className="avo-sr-only">
                Every booking and its deposit status, newest first.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Customer</th>
                  <th scope="col">Service</th>
                  <th scope="col">Artist</th>
                  <th scope="col">When</th>
                  <th scope="col">Deposit</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  [0, 1, 2, 3, 4, 5].map((n) => (
                    <tr key={n}>
                      {[0, 1, 2, 3, 4, 5].map((c) => (
                        <td key={c}>
                          <Skeleton width={`${80 - c * 7}%`} height={13} />
                        </td>
                      ))}
                    </tr>
                  ))
                ) : rows.length === 0 ? (
                  /*
                    THE NOTHING-BOOKED-YET EMPTY. Reached only when the module is
                    ON and the server genuinely returned no rows.
                  */
                  <tr>
                    <td colSpan={6} className="appts__empty">
                      <EmptyState
                        title="No appointments this week"
                        body="Bookings from the customer app land here as soon as they're made."
                      />
                    </td>
                  </tr>
                ) : (
                  rows.map((booking) => <BookingRow key={booking.id} booking={booking} />)
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

function BookingRow({ booking }: { booking: MerchantBooking }) {
  const pill = STATUS_PILL[booking.status];

  return (
    <tr>
      <td>
        <div className="appts__customer">{booking.memberName}</div>
        {/*
          `branchAssumed` — the branch was a guess. Same marker a transaction
          carries, surfaced for the same reason: a per-branch count resting on a
          guess should be visible as one.
        */}
        {booking.branchAssumed ? <div className="appts__assumed">Branch assumed</div> : null}
      </td>
      <td className="appts__muted">{booking.serviceName}</td>
      <td className="appts__muted">
        {booking.artistName}
        {/*
          A booking the artist's calendar never received. The salon needs to see
          this one — the artist is not expecting the customer.
        */}
        {booking.calendarSyncState === 'failed' ? (
          <div className="appts__syncfail">Not on their calendar</div>
        ) : null}
      </td>
      <td className="appts__when">
        <time dateTime={booking.startsAt} title={new Date(booking.startsAt).toISOString()}>
          {whenLabel(booking.startsAt)}
        </time>
        {booking.rescheduledCount > 0 ? (
          <div className="appts__moved">
            Moved {booking.rescheduledCount === 1 ? 'once' : `${booking.rescheduledCount} times`}
          </div>
        ) : null}
      </td>
      {/*
        Non-negotiable #1 — integer fils through `formatMoney`, three decimals,
        Western digits. `parseFils` is the branding boundary: the wire number is
        a plain integer until it is asserted to be one.
      */}
      <td className="appts__deposit">{formatMoney(parseFils(booking.depositFils))}</td>
      <td>
        <div className="appts__status">
          <Pill tone={pill.tone}>{pill.label}</Pill>
          {/*
            The auto-return rule, stated inline against the booking it applies
            to. The banner states the rule; this states the deadline, and the
            server computed it — a client doing `startsAt + 1h` would be deciding
            for itself when a deposit is at risk.
          */}
          {booking.status === 'deposit_held' ? (
            <span className="appts__due">
              Returns{' '}
              <time dateTime={booking.noShowReturnDueAt}>
                {whenLabel(booking.noShowReturnDueAt)}
              </time>{' '}
              if missed
            </span>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

function ClockGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M10 6v4l2.5 1.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
