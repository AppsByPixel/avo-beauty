import type { BookingPolicy } from '@avo/types';
import type { MerchantBooking } from '../api/bookings.js';
import { settlementText } from './appointmentsWeekRules.js';
import { formatReturnWindow } from './noShowWindow.js';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SALON'S NO-SHOW RULE, AS THE MERCHANT READS IT — FROM ITS POLICY
 * ═══════════════════════════════════════════════════════════════════════════
 * Two screens state the rule: the Appointments banner, where she acts on a
 * no-show, and the foot of Settings → Booking deposit. Both used to say the
 * deposit auto-returns `formatReturnWindow(noShowReturnMinutes)` after a missed
 * slot. Since migration 0066 that is false for any salon with a published policy:
 * the salon chooses keep or return (DECISIONS, "Booking deposit: the salon's own
 * policy replaces the return window"), and the merchant can no longer set the
 * window at all — it is console-only, kept for legacy bookings.
 *
 * So the sentence follows the PUBLISHED policy, and the legacy line survives only
 * for a salon that has never published one — which is exactly the salon whose
 * bookings still follow `noShowReturnMinutes`.
 *
 * WHEN IT SETTLES: 60 minutes after the slot ends, or when staff mark it — trunk's
 * ruling ("Booking policy: trunk's calls on lane A's build"). The number is the
 * ruling's and is not served by the API (`BOOKING_SETTLE_GRACE_MINUTES` is
 * server-only), so it is written once, here.
 */
export const SETTLE_GRACE_LABEL = '1 hour';

export const NO_SHOW_RULE: Record<BookingPolicy['noShow'], string> = {
  keep: 'No-shows: you keep the deposit.',
  return: 'No-shows: the deposit returns to her wallet.',
};

/** The Appointments banner's copy. `legacyMinutes` is read only when there is no policy. */
export function NoShowBannerCopy({
  policy,
  legacyMinutes,
}: {
  policy: BookingPolicy | null;
  legacyMinutes: number;
}) {
  if (policy === null) {
    // `AVO Merchant Dashboard.dc.html:169`, verbatim — still true of a salon with no policy.
    return (
      <>
        Deposits auto-return to the customer&rsquo;s wallet{' '}
        <b>{formatReturnWindow(legacyMinutes)}</b> after a missed slot — the money never leaves
        the ecosystem. Use <b>Mark no-show</b> only for edge cases.
      </>
    );
  }
  return (
    <>
      <b>{NO_SHOW_RULE[policy.noShow]}</b> It settles {SETTLE_GRACE_LABEL} after the slot ends, or
      as soon as you use <b>Mark no-show</b>.
    </>
  );
}

/** Settings → Booking deposit, the foot line. */
export function NoShowFootCopy({
  policy,
  legacyMinutes,
}: {
  policy: BookingPolicy | null;
  legacyMinutes: number;
}) {
  if (policy === null) {
    // `AVO Merchant Dashboard.dc.html:1059`, verbatim, with the salon's own window.
    return (
      <>
        No-show: deposit returns to the wallet <b>{formatReturnWindow(legacyMinutes)}</b> after a
        missed slot.
      </>
    );
  }
  return (
    <>
      {NO_SHOW_RULE[policy.noShow]} It settles <b>{SETTLE_GRACE_LABEL}</b> after the slot ends, or
      when you mark it.
    </>
  );
}

/**
 * WHERE THE DEPOSIT WENT, once it has settled — `booking.settlement`, the
 * server's split. Shown under the deposit on the list and in the week popover.
 * Nothing before it settles, and nothing on a booking that never held one.
 */
export function SettlementNote({ booking }: { booking: Pick<MerchantBooking, 'depositFils' | 'settlement'> }) {
  const text = settlementText(booking);
  return text === null ? null : <span className="appts__settled">{text}</span>;
}
