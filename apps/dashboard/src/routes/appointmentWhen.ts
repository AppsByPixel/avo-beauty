import { clock12, clockFrame, dayMonth, relativeDay } from './salonTime.js';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHEN A BOOKING'S SLOT IS, AS THE MERCHANT READS IT — ONE FUNCTION, TWO SCREENS
 * ═══════════════════════════════════════════════════════════════════════════
 * "Today · 4:30 PM", "Yesterday · 11:00 AM", "9 Jul · 7:00 PM".
 *
 * WHY THIS IS ITS OWN MODULE, and it is `noShowWindow.ts`'s reason exactly. It
 * lived in `Appointments.tsx` and was private to it, which is where it belonged
 * while the list was the only view that named a slot. The deposit queue names
 * the same slots — the overdue subset of the same board — and two views of one
 * booking that phrase its time differently are worse than one view.
 *
 * `DepositHealth.tsx` importing a formatter out of a sibling ROUTE would make
 * one screen's copy depend on the other being its library, AND would be a cycle:
 * `Appointments.tsx` mounts `DepositHealth`. So both import from here and
 * neither owns the wording of the other's column.
 *
 * THE API SENDS AN ISO INSTANT ON PURPOSE. The relative phrasing depends on WHEN it
 * is read, and non-negotiable #12 makes the Arabic surfaces a real layout
 * rather than a string swap — so the server declines to compose the sentence and
 * this is where it gets composed for the English-only merchant surfaces.
 *
 * APPOINTMENTS LOOK FORWARD AS WELL AS BACK, so this carries "Tomorrow", which
 * the audit log's past-only equivalent does not. The deposit queue only ever
 * looks back — every row it draws has `starts_at < now` — and it still uses this
 * function rather than a trimmed copy, because a formatter with an unreachable
 * arm is cheaper than two formatters that can disagree about "Yesterday".
 *
 * IN THE SALON'S CLOCK, AND "TODAY" IS THE SALON'S TODAY. This used to call
 * `toLocaleTimeString` with no `timeZone` and count days between browser-local
 * midnights, so it answered in the READER's zone. `AppointmentForm` builds the
 * instant from the salon's zone and names it on the field, so a merchant who
 * typed 10:00 read "12:00 PM" back from Pakistan. Found live on BK-10000005;
 * `salonTime.ts` carries the argument and `whenLabelZone.test.ts` pins it from
 * Karachi. The zone is an argument with no default so no caller can forget it.
 *
 * AN UNPARSEABLE INSTANT DEGRADES TO "unknown", `Customers.tsx § whenLabel`'s
 * word, rather than to "Invalid Date · Invalid Date".
 */
export function whenLabel(iso: string, timezone: string | null, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'unknown';
  const frame = clockFrame(timezone);
  const time = clock12(at, frame);

  switch (relativeDay(at, now, frame.zone)) {
    case 'today':
      return `Today · ${time}`;
    case 'yesterday':
      return `Yesterday · ${time}`;
    case 'tomorrow':
      return `Tomorrow · ${time}`;
    default:
      return `${dayMonth(at, frame)} · ${time}`;
  }
}
