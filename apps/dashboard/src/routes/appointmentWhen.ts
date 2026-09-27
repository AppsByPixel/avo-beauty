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
 * THE API SENDS AN ISO INSTANT ON PURPOSE. The relative phrasing depends on the
 * READER's clock, and non-negotiable #12 makes the Arabic surfaces a real layout
 * rather than a string swap — so the server declines to compose the sentence and
 * this is where it gets composed for the English-only merchant surfaces.
 *
 * APPOINTMENTS LOOK FORWARD AS WELL AS BACK, so this carries "Tomorrow", which
 * the audit log's past-only equivalent does not. The deposit queue only ever
 * looks back — every row it draws has `starts_at < now` — and it still uses this
 * function rather than a trimmed copy, because a formatter with an unreachable
 * arm is cheaper than two formatters that can disagree about "Yesterday".
 */
export function whenLabel(iso: string): string {
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
