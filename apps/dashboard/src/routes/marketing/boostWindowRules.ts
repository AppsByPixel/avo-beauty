import { isBoostLive, type Boost } from '@avo/types';
import { instantFromSalonLocal, salonLocalFields } from '../appointmentsWeekRules.js';
import { localDate, shiftDate } from '../salesTrendRules.js';
import { clock24, clockFrame, dayMonth, relativeDay } from '../salonTime.js';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A BRANCH BOOST'S DURATION AND STATE — NEW WORK, THE DESIGN DRAWS NEITHER
 * ═══════════════════════════════════════════════════════════════════════════
 * Aftab, 2026-09-29: "Duration and stop option in the branch boost in the
 * marketing on dashboard". Lane A's 6d102c5 gave `BoostSchema` a window
 * (`startsAt` inclusive, `endsAt` exclusive, `null` is no bound) and a stop
 * record (`stoppedAt`, `stoppedBy`). This module is the pure half of the screen:
 * which state a PUBLISHED row is in, how that state reads, and how the duration
 * fields become the two instants the PUT takes.
 *
 * THE STATE IS RESOLVED WITH `isBoostLive`, NEVER STORED. There is no `live`
 * flag on the wire, and the server decides the boost at charge time with the
 * same predicate (#2). The screen asks the predicate again every tick; it does
 * not remember an answer.
 *
 * THE FIELDS ARE THE SALON'S WALL CLOCK. `instantFromSalonLocal` is the bridge
 * `AppointmentForm` and the campaign scheduler already cross: a manager in
 * Karachi who types 18:00 for a Kuwait salon means 18:00 in Kuwait, and
 * `new Date('…T18:00')` would mean 18:00 in Karachi.
 */

/* ======================================================== the state == */

export type BoostState =
  | { kind: 'off' }
  | { kind: 'stopped'; by: string | null; at: string }
  | { kind: 'ended'; at: string }
  | { kind: 'scheduled'; startsAt: string; endsAt: string | null }
  | { kind: 'live'; endsAt: string | null };

const isNeutral = (b: { visit: number; stamp: number }) => b.visit === 1 && b.stamp === 1;

/**
 * THE ORDER IS THE ARGUMENT. A stop is checked first because a stopped row is
 * ALSO neutral (the server writes 1/0/1 and clears the window) — checking
 * neutral first would call a boost Noura stopped ten minutes ago "Off", and the
 * one thing the stop record exists to say would be gone. `topup` is not read at
 * all: branch boosts do not pay it (DECISIONS, 2026-09-29).
 */
export function boostState(boost: Boost | undefined, now: Date): BoostState {
  if (!boost) return { kind: 'off' };
  if (boost.stoppedAt !== null) return { kind: 'stopped', by: boost.stoppedBy, at: boost.stoppedAt };
  if (isNeutral(boost)) return { kind: 'off' };
  if (isBoostLive(boost, now)) return { kind: 'live', endsAt: boost.endsAt };
  if (boost.startsAt !== null && now.getTime() < Date.parse(boost.startsAt)) {
    return { kind: 'scheduled', startsAt: boost.startsAt, endsAt: boost.endsAt };
  }
  // Not live and not yet started: the only bound left is an end that has passed.
  return { kind: 'ended', at: boost.endsAt ?? boost.startsAt ?? now.toISOString() };
}

/** A running or scheduled boost is the only kind the Stop endpoint accepts. */
export const canStop = (state: BoostState) => state.kind === 'live' || state.kind === 'scheduled';

/**
 * "today, 18:00" / "tomorrow, 09:00" / "6 Oct, 18:00" — in the SALON's clock,
 * 24-hour, as the feeds and the audit log speak. An unusable zone reads in UTC
 * and says so (`salonTime.ts § clockFrame`).
 */
export function whenLabel(iso: string, timezone: string | null, now: Date): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'at an unknown time';
  const frame = clockFrame(timezone);
  const day = relativeDay(at, now, frame.zone);
  const date =
    day === 'today' ? 'today' : day === 'tomorrow' ? 'tomorrow' : day === 'yesterday' ? 'yesterday' : dayMonth(at, frame);
  return `${date}, ${clock24(at, frame)}`;
}

/** The row's state line, exactly as the brief names the five. */
export function boostStateLabel(state: BoostState, timezone: string | null, now: Date): string {
  switch (state.kind) {
    case 'live':
      return state.endsAt === null
        ? 'Live · runs until stopped'
        : `Live · ends ${whenLabel(state.endsAt, timezone, now)}`;
    case 'scheduled':
      return `Scheduled · starts ${whenLabel(state.startsAt, timezone, now)}`;
    case 'ended':
      return `Ended ${whenLabel(state.at, timezone, now)}`;
    case 'stopped':
      return `Stopped${state.by ? ` by ${state.by}` : ''} ${whenLabel(state.at, timezone, now)}`;
    case 'off':
      return 'Off';
  }
}

/* ===================================================== the duration == */

export type DurationMode = 'open' | 'today' | 'week' | 'month' | 'custom';

export const DURATION_OPTIONS: Array<{ value: DurationMode; label: string }> = [
  { value: 'open', label: 'Runs until stopped' },
  { value: 'today', label: 'Today only' },
  { value: 'week', label: '7 days' },
  { value: 'month', label: '30 days' },
  { value: 'custom', label: 'Custom' },
];

/** The four native fields — `<input type="date">` and `<input type="time">` values. */
export interface WindowFields {
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
}

export const EMPTY_WINDOW: WindowFields = { startDate: '', startTime: '', endDate: '', endTime: '' };

const PRESET_DAYS: Record<'today' | 'week' | 'month', number> = { today: 1, week: 7, month: 30 };

/**
 * A preset FILLS THE FIELDS rather than hiding them, so what she publishes is
 * on the screen in the salon's clock before she presses anything.
 *
 * CALENDAR DAYS IN THE SALON, ENDING AT ITS MIDNIGHT. "Today only" runs until
 * 00:00 tomorrow salon time; "7 days" is today and the six after it. The end is
 * exclusive on the server (`endsAt` is the first instant it no longer applies),
 * so a midnight end is the whole of the last day with no minute lost. The start
 * is left empty — "from the moment it is published" — because a preset picked
 * at 15:00 means from now, not from a midnight that has already gone.
 *
 * `null` on an unusable zone: there is no salon "today" to count from, and the
 * browser's would be the silent wrong answer.
 */
export function presetWindow(
  mode: 'today' | 'week' | 'month',
  now: Date,
  timezone: string | null,
): WindowFields | null {
  if (timezone === null) return null;
  const today = localDate(now, timezone);
  if (today === null) return null;
  return { ...EMPTY_WINDOW, endDate: shiftDate(today, PRESET_DAYS[mode]), endTime: '00:00' };
}

/** A live instant back into the fields, for seeding the editor from the published row. */
export function fieldsFromInstants(
  startsAt: string | null,
  endsAt: string | null,
  timezone: string | null,
): WindowFields {
  const read = (iso: string | null) =>
    iso === null || timezone === null ? null : salonLocalFields(iso, timezone);
  const start = read(startsAt);
  const end = read(endsAt);
  return {
    startDate: start?.date ?? '',
    startTime: start?.time ?? '',
    endDate: end?.date ?? '',
    endTime: end?.time ?? '',
  };
}

export type ResolvedWindow =
  | { ok: true; startsAt: string | null; endsAt: string | null }
  | { ok: false; message: string };

/**
 * The fields as the two instants the PUT takes — ISO with a zone (`…Z`), never
 * the zone-less wall clock the API refuses as `invalid_boost_window`.
 *
 * `seed` is the published row the fields were filled from. A pair she has not
 * touched returns the SEEDED instant rather than a round trip through the
 * fields, because the fields hold minutes and an instant published elsewhere
 * may carry seconds — and a boost that reads as edited when nobody touched it
 * would republish itself, and a republished boost loses its stop record.
 *
 * THE REFUSALS ARE LOCAL COURTESIES. The server refuses the same things
 * (`invalid_boost_window`, `boost_already_ended`) and its sentence still maps
 * to the row; these stop a request that cannot succeed from being sent.
 */
export function resolveWindow(
  fields: WindowFields,
  timezone: string | null,
  seed?: { fields: WindowFields; startsAt: string | null; endsAt: string | null },
): ResolvedWindow {
  const pair = (
    date: string,
    time: string,
    which: 'start' | 'end',
    seeded: { date: string; time: string; iso: string | null } | null,
  ): { ok: true; iso: string | null } | { ok: false; message: string } => {
    if (date === '' && time === '') return { ok: true, iso: null };
    if (date === '' || time === '') {
      return { ok: false, message: `Pick both a date and a time for the ${which}, or leave both empty.` };
    }
    if (seeded && seeded.date === date && seeded.time === time && seeded.iso !== null) {
      return { ok: true, iso: seeded.iso };
    }
    const iso = timezone === null ? null : instantFromSalonLocal(date, time, timezone);
    if (iso === null) {
      return {
        ok: false,
        message: `That is not a time we can read in ${timezone ?? 'the salon’s time zone'}. Check the ${which}, and check the salon's time zone in Settings.`,
      };
    }
    return { ok: true, iso };
  };

  const start = pair(
    fields.startDate,
    fields.startTime,
    'start',
    seed ? { date: seed.fields.startDate, time: seed.fields.startTime, iso: seed.startsAt } : null,
  );
  if (!start.ok) return start;
  const end = pair(
    fields.endDate,
    fields.endTime,
    'end',
    seed ? { date: seed.fields.endDate, time: seed.fields.endTime, iso: seed.endsAt } : null,
  );
  if (!end.ok) return end;
  if (start.iso !== null && end.iso !== null && Date.parse(end.iso) <= Date.parse(start.iso)) {
    return { ok: false, message: 'A boost has to end after it starts.' };
  }
  return { ok: true, startsAt: start.iso, endsAt: end.iso };
}

/** Two instants, or two absences, that name the same moment. */
export function sameInstant(a: string | null, b: string | null): boolean {
  return a === null || b === null ? a === b : Date.parse(a) === Date.parse(b);
}
