import type { Salon } from '@avo/types';
import type { PillTone } from '@avo/ui';
import type { BookingStatus, MerchantBooking } from '../api/bookings.js';
import { enumerateDays, shiftDate } from './salesTrendRules.js';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MERCHANT → APPOINTMENTS → WEEK. THE ARITHMETIC. NEW WORK; THERE IS NO
 * CALENDAR VIEW IN THE DESIGN BUNDLE.
 * ═══════════════════════════════════════════════════════════════════════════
 * SAID PLAINLY SO A LATER READER DOES NOT GO LOOKING FOR AN ARTBOARD. Every
 * occurrence of "calendar" in `design/AVO Merchant Dashboard.dc.html` is GOOGLE
 * CALENDAR AS AN AVAILABILITY SOURCE and none of them is a view of appointments:
 * `:197` "Availability comes from each artist's Google Calendar", `:236` the
 * source toggle, `:1139` the "Calendar disconnected" alert. It is not in
 * `design/README.md` § Known gaps either, so no prior decision is being
 * overridden — this is Aftab extending his own design ("Show appointments in a
 * calendar like view"), which is the case CLAUDE.md § "Do not add features"
 * defers to. Same disclosure `salesTrendRules.ts` makes about the chart.
 *
 * The RENDERING lives in `AppointmentsWeek.tsx`. Everything here is a pure
 * function over rows, a zone and a date, so every rule below is assertable
 * without a query client, a session or a clock.
 */

/* ============================================================ the statuses == */

/**
 * The contract's four, in the order the design lists its pills.
 *
 * MOVED HERE FROM `Appointments.tsx`, WHERE IT LIVED UNTIL THE WEEK VIEW
 * EXISTED, and the move is the whole point: two views of one board that label a
 * status differently are worse than one view, because a merchant reading "Done"
 * on the grid and "Completed" in the list has to decide whether they are the
 * same fact. The list imports it from here and so does the grid, so there is one
 * table and no second place to edit.
 *
 * TONE NOTE — `no_show_returned` is the only one that needs a colour the design
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
export const STATUS_PILL: Record<BookingStatus, { label: string; tone: PillTone }> = {
  deposit_held: { label: 'Deposit held', tone: 'brand' },
  completed: { label: 'Completed', tone: 'quiet' },
  no_show_returned: { label: 'No-show · returned', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'quiet' },
};

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A STATUS IS NOT DECORATION, AND ON A GRID IT IS LOAD-BEARING IN A WAY IT IS
 * NOT IN A LIST
 * ═══════════════════════════════════════════════════════════════════════════
 * The list draws a labelled pill in its own column, so the status is READ. A
 * grid cell has no column: a chip sitting in Tuesday at 4pm asserts, by being
 * there at all, that Tuesday at 4pm is taken — and for two of the four statuses
 * that is false. `booking_artist_slot_no_overlap` excludes BOTH
 * `no_show_returned` and `cancelled`, so the artist is bookable at that hour and
 * a chip that reads as booked is a chip that hides free time.
 *
 * So each status gets a MODIFIER CLASS and a WORD, never a colour alone:
 *
 *   held       the live booking. Brand tint, the only filled chip.
 *   completed  it happened. Quiet, and the word says so.
 *   released   `no_show_returned` and `cancelled` — the slot came back. Hollow
 *              and dashed, and the name struck through, so the difference is
 *              visible without colour at all (interaction-spec.md §2: meaning
 *              never carried by colour alone).
 *
 * `released` GROUPS TWO STATUSES AND DOES NOT MERGE THEM. The silhouette is
 * shared because the fact about the SLOT is shared; the word on the chip is
 * `STATUS_PILL[status].label`, so "Cancelled" and "No-show · returned" are still
 * distinguishable and the reason a no-show is not an attendance is still on the
 * chip.
 */
export type ChipShape = 'held' | 'completed' | 'released';

export function chipShape(status: BookingStatus): ChipShape {
  if (status === 'deposit_held') return 'held';
  if (status === 'completed') return 'completed';
  return 'released';
}

/* ================================================================ the zone == */

/** A salon-local calendar date and the minute of that day. */
export interface LocalStamp {
  /** `YYYY-MM-DD`, salon-local. */
  date: string;
  /** Minutes since salon-local midnight, 0…1439. */
  minutes: number;
}

export interface ZoneClock {
  /** The IANA id this clock was built from, for a state that has to name it. */
  timezone: string;
  /** `null` for an instant `Date` cannot represent. */
  at(instant: Date): LocalStamp | null;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ZONE IS THE SALON'S OWN, READ OFF `GET /salons/{id}`, NOT PINNED
 * ═══════════════════════════════════════════════════════════════════════════
 * `salesTrendRules.ts § localDate` made this argument for the chart and it
 * reaches further here, not less far. `Overview.tsx § nextAtLabel` pins
 * `Asia/Kuwait` and is right to: a pin THERE decides how an instant the server
 * already chose is DISPLAYED. A pin HERE decides WHICH COLUMN A BOOKING IS IN.
 * A salon three hours off the browser's zone would find its 10pm Thursday drawn
 * in Friday's column, on a grid whose whole claim is which day a thing is on.
 *
 * ONE `Intl.DateTimeFormat`, BUILT ONCE AND REUSED, because this is called once
 * per booking and a formatter per row on a 200-row page is the difference
 * between a grid that paints and one that stutters.
 *
 * NULL ON AN UNUSABLE ZONE rather than a fallback. `Intl.DateTimeFormat` throws
 * `RangeError` on a zone id it does not know, and the tempting rescue — drop the
 * `timeZone` and use the browser's — is the silent wrong answer this whole
 * docblock exists to refuse. The caller renders a state that names the zone.
 *
 * `hourCycle: 'h23'` EXPLICITLY. `hour12: false` is the trap: several engines
 * render midnight as "24" under it, which would put a 00:15 booking at minute
 * 1455 of the PREVIOUS day and off the bottom of the grid. `h23` is the cycle
 * that means 00…23 and it is a stated cycle rather than an inferred one.
 */
export function makeZoneClock(timezone: string): ZoneClock | null {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    return null;
  }

  /*
   * A ZONE THAT CONSTRUCTS AND THEN CANNOT FORMAT IS STILL AN UNUSABLE ZONE.
   * The constructor is where a bad id is meant to throw, but "meant to" is the
   * kind of claim this codebase checks: one probe against a fixed instant, and
   * a clock that cannot answer it is no clock.
   */
  const probe = readStamp(fmt, new Date(0));
  if (probe === null) return null;

  return {
    timezone,
    at: (instant) => readStamp(fmt, instant),
  };
}

function readStamp(fmt: Intl.DateTimeFormat, instant: Date): LocalStamp | null {
  if (Number.isNaN(instant.getTime())) return null;

  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = fmt.formatToParts(instant);
  } catch {
    return null;
  }

  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';

  const [year, month, day, hour, minute] = [
    get('year'),
    get('month'),
    get('day'),
    get('hour'),
    get('minute'),
  ];
  if ([year, month, day, hour, minute].some((v) => v === '')) return null;

  const h = Number(hour);
  const m = Number(minute);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return null;

  return {
    date: `${year.padStart(4, '0')}-${month}-${day}`,
    /*
     * `h % 24` is the belt to `h23`'s braces. If some engine ever answers 24 for
     * midnight the booking lands at minute 0 of its own date — which is where it
     * belongs — instead of 1440 minutes into a day that has 1439.
     */
    minutes: (h % 24) * 60 + m,
  };
}

/* ============================================================== the window == */

export const WEEK_DAYS = 7;

/**
 * THE WEEK STARTS ON SUNDAY, AND IN KUWAIT THAT IS NOT AN ARBITRARY CHOICE.
 * The working week is Sunday to Thursday and the weekend is Friday–Saturday, so
 * a Monday-start grid splits the salon's quiet pair across two columns at
 * opposite ends and puts its busiest run in the middle of nothing. 0 is
 * `Date.prototype.getUTCDay()`'s Sunday, so the constant is the same number the
 * arithmetic below uses rather than a second convention to convert between.
 *
 * NOT READ FROM THE SALON, because there is no field for it: `SalonSchema`
 * carries `timezone` and `businessHours` and nothing about week start. A salon
 * outside the Gulf would want Monday; that is a contract change and this is
 * lane C. Reported, not taken here.
 */
export const WEEK_STARTS_ON = 0;

export interface WeekWindow {
  /** `YYYY-MM-DD`, the Sunday. */
  from: string;
  /** `YYYY-MM-DD`, the Saturday. */
  to: string;
  /** Seven dates, ascending. The grid's columns, in order. */
  days: string[];
}

/** `2026-09-30` → 3 (Wednesday). Decided calendar text, anchored at UTC midnight. */
export function weekdayIndex(ymd: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return 0;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
}

/**
 * The week the grid draws. `offset` is whole weeks from the one containing
 * `now`: 0 is this week, −1 last week, +1 next.
 *
 * `null` WHEN THE ZONE CANNOT SAY WHAT DAY IT IS — the same refusal
 * `makeZoneClock` makes, propagated rather than papered over.
 */
export function weekWindow(clock: ZoneClock, now: Date, offset: number): WeekWindow | null {
  const today = clock.at(now);
  if (today === null) return null;

  const backToStart = (weekdayIndex(today.date) - WEEK_STARTS_ON + 7) % 7;
  const from = shiftDate(shiftDate(today.date, -backToStart), offset * WEEK_DAYS);
  const to = shiftDate(from, WEEK_DAYS - 1);
  return { from, to, days: enumerateDays(from, to) };
}

/* ========================================================== the completeness */

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * § THE 200 CAP, AND WHY A GRID MUST ANSWER IT DIFFERENTLY FROM A LIST
 * ═══════════════════════════════════════════════════════════════════════════
 * `GET /salons/{id}/bookings` HAS NO DATE RANGE. `routes/salons.ts` caps a page
 * at `BOOKINGS_PAGE = 200` and orders `starts_at DESC, id ASC`, so page one is
 * the two hundred FURTHEST-FUTURE appointments and everything nearer in time —
 * including today — is further down the stream.
 *
 * A LIST THAT STOPS AT 200 IS VISIBLY A LIST OF 200. A WEEK GRID THAT STOPS AT
 * 200 IS A FREE THURSDAY AFTERNOON. That is the whole difference: a missing row
 * reads as a row that does not exist, and a missing chip reads as an hour nobody
 * booked — which a salon acts on, by offering it to someone. This lane has paid
 * for the same class once already (`stateCensus.test.ts § a capped list does not
 * report itself as complete`: 211 further-out bookings, the client reported 0
 * deposit-held where the server said 3, because the rows dropped first were the
 * ones starting soonest).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SO THE GRID WALKS THE CURSOR AND REFUSES TO DRAW A WEEK IT CANNOT VOUCH FOR
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PROOF IS THE ORDERING, and it is worth stating as a proof because the
 * whole screen rests on it. The stream is `starts_at DESC`, so:
 *
 *   THE TOP OF THE WINDOW NEEDS NO CHECK. The walk begins at the furthest-future
 *   row in the salon, which is at or after every row in any window, so nothing
 *   above the window can be skipped past — only walked through.
 *
 *   THE BOTTOM IS THE ONLY QUESTION. Once a fetched row starts STRICTLY BEFORE
 *   the window's first day, every row still unfetched starts at or before that
 *   one, so every one of them is before the window too. Nothing in the window
 *   can still be out there.
 *
 *   OR THE STREAM RAN OUT. `nextCursor: null` is the server saying there is no
 *   further page — lane A made that field honest (`salons.ts` § "NULL ONLY WHEN
 *   IT IS TRUE"), which is what makes it usable as a proof rather than a hope.
 *
 * STRICTLY BEFORE, NOT AT-OR-BEFORE, and the `<` is the whole guarantee. Two
 * bookings can share an instant (two artists, one 10:00 slot) and the page
 * boundary can fall between them, so a walk that has reached the window's first
 * day has NOT necessarily seen all of it. `<=` would call that whole and drop
 * the second artist's morning.
 *
 * DATES AND NOT INSTANTS. Both sides are salon-local `YYYY-MM-DD` compared as
 * text, which is chronological for that format and needs no offset arithmetic at
 * all — the one place a zone conversion could go wrong is removed rather than
 * got right. Local date is monotonic in the instant for a fixed zone, so a
 * minimum over local dates is the minimum instant's date.
 */
export interface WalkState {
  /**
   * The earliest salon-local date the walk has reached, `null` before any row.
   * A row whose `startsAt` will not parse is EXCLUDED from this minimum, which
   * errs towards walking further rather than towards claiming completeness.
   */
  oldestSeenDate: string | null;
  /** The last page came back with `nextCursor: null`. */
  exhausted: boolean;
  /** A page is in flight. */
  fetching: boolean;
  /** Pages that have landed. */
  pages: number;
  /** Pages this screen fetches on its own before it stops and asks. */
  budget: number;
}

export type Coverage =
  /** Every booking in the window is in hand. The grid may draw. */
  | { kind: 'whole' }
  /** Not yet, and the walk is still going. The grid must not draw. */
  | { kind: 'walking' }
  /** Not yet, and the walk has stopped. The grid must not draw, and must say so. */
  | { kind: 'short' };

export function windowCoverage(walk: WalkState, from: string): Coverage {
  if (walk.exhausted) return { kind: 'whole' };
  if (walk.oldestSeenDate !== null && walk.oldestSeenDate < from) return { kind: 'whole' };
  if (walk.fetching || walk.pages < walk.budget) return { kind: 'walking' };
  return { kind: 'short' };
}

/**
 * TWELVE PAGES — 2 400 APPOINTMENTS — BEFORE THE SCREEN STOPS AND ASKS.
 *
 * A budget rather than an unbounded loop, because the walk's length is not a
 * property of the week being drawn: it is the number of bookings between now and
 * the furthest-future one in the salon, and a salon taking reservations a year
 * out has no bound a client can assume. Twelve is generous for the case this
 * view is for — a busy salon at thirty bookings a day books about seven days per
 * page, so a couple of months of forward book is four or five pages — and it is
 * small enough that an accidental full-table walk stops and says something
 * rather than hammering the API.
 *
 * WHAT HAPPENS AT THE BUDGET IS THE POINT: `short`, which draws NOTHING and
 * offers the merchant the choice. It is not a silent truncation.
 */
export const WALK_BUDGET = 12;

/** The minimum salon-local date across the rows in hand. Unparseable rows skipped. */
export function oldestLocalDate(
  rows: readonly MerchantBooking[],
  clock: ZoneClock,
): string | null {
  let oldest: string | null = null;
  for (const row of rows) {
    const stamp = clock.at(new Date(row.startsAt));
    if (stamp === null) continue;
    if (oldest === null || stamp.date < oldest) oldest = stamp.date;
  }
  return oldest;
}

/* =============================================================== the layout == */

export interface PlacedBooking {
  booking: MerchantBooking;
  /** The salon-local date of the START. The column this chip is drawn in. */
  date: string;
  /** Minutes from salon-local midnight. */
  startMin: number;
  /** Minutes from the same midnight, clipped to the end of the day. */
  endMin: number;
  /** The appointment runs past salon-local midnight and is clipped here. */
  continues: boolean;
  /** Which side-by-side column within the day, 0-based. */
  lane: number;
  /** How many the day needs. Every chip in a day carries the same number. */
  lanes: number;
}

export interface DayColumn {
  date: string;
  /** Ascending by start, then by end. */
  items: PlacedBooking[];
}

const DAY_MINUTES = 1440;

/**
 * One booking's place, before lanes.
 *
 * `null` when the instants will not parse — a row the grid cannot position is
 * not drawn at an invented time. `AppointmentsWeek.tsx` counts those and says
 * so, because a chip silently missing is the exact failure this whole file is
 * about; it is just arriving through a bad payload rather than through the cap.
 *
 * THE DAY IS THE START'S DAY. An appointment running past local midnight is
 * clipped at the column's foot and flagged `continues`, rather than being split
 * into a second chip on the next day: a split chip is two chips, and a merchant
 * counting her Thursday would count it twice.
 *
 * AN `endsAt` AT OR BEFORE `startsAt` IS CLAMPED, NOT DROPPED. The server
 * computes `endsAt` from `durationMin` so it should not happen; if it does, the
 * chip keeps its place on the grid and `chipBox` gives it a legible minimum
 * height. A zero-height chip is an appointment that vanishes, which is the
 * failure mode this whole file exists to refuse.
 */
export const MIN_SLOT_MINUTES = 5;

export function placeBooking(
  booking: MerchantBooking,
  clock: ZoneClock,
): Omit<PlacedBooking, 'lane' | 'lanes'> | null {
  const start = clock.at(new Date(booking.startsAt));
  if (start === null) return null;

  const end = clock.at(new Date(booking.endsAt));
  const sameDay = end !== null && end.date === start.date;
  const rawEnd = sameDay ? end.minutes : DAY_MINUTES;

  return {
    booking,
    date: start.date,
    startMin: start.minutes,
    /*
     * Never before the start, never past the column's foot. The MINUTE is the
     * truth and `chipBox` gives a very short appointment its legible floor at
     * the display boundary - a floor applied here would make `assignLanes`
     * reserve time the appointment does not take.
     */
    endMin: Math.min(DAY_MINUTES, Math.max(rawEnd, start.minutes)),
    continues: end === null || end.date !== start.date,
  };
}

/**
 * The seven columns, each holding the bookings whose salon-local START falls on
 * that day, laned so overlapping appointments sit side by side.
 *
 * ROWS OUTSIDE THE WINDOW ARE DROPPED HERE AND THAT IS NOT THE CAP'S SILENCE —
 * the stream is the whole salon's book and a week is seven of its days. What
 * makes the drop safe is `windowCoverage`: the grid only draws once every row
 * that COULD be in the window is in hand, so a day with no chips is a day the
 * server has been asked about.
 */
export function weekColumns(
  rows: readonly MerchantBooking[],
  clock: ZoneClock,
  days: readonly string[],
): { columns: DayColumn[]; unplaceable: number } {
  const byDate = new Map<string, Array<Omit<PlacedBooking, 'lane' | 'lanes'>>>();
  for (const date of days) byDate.set(date, []);

  let unplaceable = 0;
  for (const row of rows) {
    const placed = placeBooking(row, clock);
    if (placed === null) {
      unplaceable += 1;
      continue;
    }
    byDate.get(placed.date)?.push(placed);
  }

  return {
    columns: days.map((date) => ({ date, items: assignLanes(byDate.get(date) ?? []) })),
    unplaceable,
  };
}

/**
 * SIDE-BY-SIDE COLUMNS FOR OVERLAPPING APPOINTMENTS, because a salon with three
 * artists has three ten-o'clocks and stacking them draws one.
 *
 * Greedy by start: each booking takes the first lane whose previous occupant has
 * finished. The lane COUNT is the day's, not the group's — every chip in a
 * column is the same width, because a day whose chips change width partway down
 * reads as a day whose hours are differently important.
 *
 * TIES ARE BROKEN BY `id`, NOT LEFT TO SORT STABILITY. Two artists at 10:00 with
 * the same service have identical start and end; without a third key their
 * left-to-right order depends on the order the pages happened to arrive in, so
 * the same week drawn twice would shuffle. The id is the only field guaranteed
 * distinct, and it is what the API's own page ordering tiebreaks on.
 */
export function assignLanes(
  items: ReadonlyArray<Omit<PlacedBooking, 'lane' | 'lanes'>>,
): PlacedBooking[] {
  const sorted = [...items].sort(
    (a, b) =>
      a.startMin - b.startMin ||
      a.endMin - b.endMin ||
      (a.booking.id < b.booking.id ? -1 : a.booking.id > b.booking.id ? 1 : 0),
  );

  /** The minute each open lane is free from. */
  const freeFrom: number[] = [];
  const laned = sorted.map((item) => {
    let lane = freeFrom.findIndex((until) => until <= item.startMin);
    if (lane === -1) {
      lane = freeFrom.length;
      freeFrom.push(item.endMin);
    } else {
      freeFrom[lane] = item.endMin;
    }
    return { ...item, lane, lanes: 0 };
  });

  const lanes = Math.max(1, freeFrom.length);
  return laned.map((item) => ({ ...item, lanes }));
}

/* ================================================================ the ruler == */

/** `"10:00"` → 600. `null` on anything else. */
export function clockMinutes(hhmm: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * The vertical extent of the grid: the salon's own opening hours, WIDENED UNTIL
 * EVERY DRAWN BOOKING FITS INSIDE IT.
 *
 * THE WIDENING IS THE RULE AND THE HOURS ARE ONLY THE STARTING POINT. A grid
 * whose ruler is the business hours and nothing else hides the booking that sits
 * outside them — the 9am fitting before opening, the appointment that ran past
 * close — and that is the same defect as the cap, arriving through the y-axis
 * instead. So the hours decide how much EMPTY ruler surrounds the day; they
 * never decide what is drawn.
 *
 * WHICH IS ALSO WHY A BROKEN `businessHours` IS SURVIVABLE HERE AND NEEDS NO
 * STATE OF ITS OWN. Fall back to 08:00–20:00 and the widening still guarantees
 * every chip is on the grid; the only cost is a ruler that is longer or shorter
 * than the salon's day. Nothing is hidden by the fallback, so nothing has to be
 * said about it.
 *
 * WHOLE HOURS, because the ruler is drawn in hour rows and a grid that starts at
 * 09:47 has a first row that is not an hour.
 */
export const RULER_FALLBACK: { startMin: number; endMin: number } = {
  startMin: 8 * 60,
  endMin: 20 * 60,
};

export function rulerRange(
  columns: readonly DayColumn[],
  hours: Salon['businessHours'] | undefined,
): { startMin: number; endMin: number } {
  const openRaw = hours ? clockMinutes(hours.morning[0]) : null;
  const closeRaw = hours ? clockMinutes(hours.evening[1]) : null;

  let start = openRaw ?? RULER_FALLBACK.startMin;
  let end = closeRaw ?? RULER_FALLBACK.endMin;
  /* An evening that closes before the morning opens says nothing usable. */
  if (end <= start) {
    start = RULER_FALLBACK.startMin;
    end = RULER_FALLBACK.endMin;
  }

  for (const column of columns) {
    for (const item of column.items) {
      start = Math.min(start, item.startMin);
      end = Math.max(end, item.endMin);
    }
  }

  const floored = Math.max(0, Math.floor(start / 60) * 60);
  const ceiled = Math.min(DAY_MINUTES, Math.ceil(end / 60) * 60);
  /* One hour is the floor: a salon with a single 10:00–10:00 entry still rules. */
  return { startMin: floored, endMin: Math.max(ceiled, floored + 60) };
}

/** The hour marks on the ruler, inclusive of the top and exclusive of the foot. */
export function rulerHours(range: { startMin: number; endMin: number }): number[] {
  const out: number[] = [];
  for (let m = range.startMin; m < range.endMin; m += 60) out.push(m);
  return out;
}

/**
 * A chip's box, as percentages of the ruler. The display boundary, and the only
 * place a minute becomes a fraction.
 */
export function chipBox(
  item: Pick<PlacedBooking, 'startMin' | 'endMin' | 'lane' | 'lanes'>,
  range: { startMin: number; endMin: number },
): { top: number; height: number; left: number; width: number } {
  const span = Math.max(1, range.endMin - range.startMin);
  const top = ((item.startMin - range.startMin) / span) * 100;
  const height = ((Math.max(item.endMin, item.startMin + MIN_SLOT_MINUTES) - item.startMin) / span) * 100;
  const width = 100 / Math.max(1, item.lanes);
  return { top, height, left: width * item.lane, width };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW MUCH A CHIP CAN SAY, WHICH IS DECIDED BY HOW LONG THE APPOINTMENT IS
 * ═══════════════════════════════════════════════════════════════════════════
 * FOUND BY LOOKING AT IT, NOT BY READING IT. The first draft gave every chip the
 * same four lines under `overflow: hidden`, which on a thirty-minute slot sliced
 * the last line THROUGH THE GLYPHS — half a "CANCELLED" sitting under half a
 * customer's name. That is not a clipped detail, it reads as a broken render,
 * and the line it cut was the status: exactly the fact a released slot must not
 * lose.
 *
 * So the chip drops whole lines rather than fractions of one, and it drops them
 * from the BOTTOM UP, in the reverse of the order they matter:
 *
 *   tiny    the time (with the status beside it) and the customer's name.
 *   roomy   … plus the service and the artist.
 *   full    … plus the branch-assumed and calendar-sync markers.
 *
 * THE STATUS IS NEVER IN THE DROPPED PART. It rides the first line, next to the
 * time, precisely so that no appointment is ever short enough to lose it — the
 * whole argument in § ChipShape is that a released slot read as a booked one is
 * a lie about free time, and a lie that only appears on short appointments is
 * still a lie.
 *
 * ---------------------------------------------------------------------------
 * THE THRESHOLDS ARE IN MINUTES AND THE ROW HEIGHT IS IN CSS, SO THEY CAN DRIFT
 * ---------------------------------------------------------------------------
 * A chip's drawn height is `minutes / 60 × --apweek-row-h`, and this file cannot
 * read that custom property. `APWEEK_ROW_PX` is this side's copy of it and
 * `appointmentsWeekRender.test.tsx` READS `app.css` AND ASSERTS THE TWO AGREE —
 * because a row height changed in the stylesheet alone would silently re-break
 * the thing the buckets were added to fix, and a comment asking the next person
 * to remember is not a guard.
 */
export const APWEEK_ROW_PX = 56;

/** Lines cost about this much at the chip's 11px/1.25, plus 8px of padding. */
const LINE_PX = 14;
const CHIP_PADDING_PX = 8;
const CHIP_MIN_PX = 40;

export type ChipDensity = 'tiny' | 'roomy' | 'full';

export function chipDensity(startMin: number, endMin: number): ChipDensity {
  const drawn = Math.max(CHIP_MIN_PX, ((endMin - startMin) / 60) * APWEEK_ROW_PX);
  const lines = Math.floor((drawn - CHIP_PADDING_PX) / LINE_PX);
  if (lines >= 5) return 'full';
  if (lines >= 3) return 'roomy';
  return 'tiny';
}

/* ================================================================ the labels == */

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** `2026-09-27` → `Sun`. */
export function weekdayShort(ymd: string): string {
  return WEEKDAYS_SHORT[weekdayIndex(ymd)] ?? '';
}

/** `2026-09-27` → `Sunday`. The accessible name; the column head is the short one. */
export function weekdayLong(ymd: string): string {
  return WEEKDAYS[weekdayIndex(ymd)] ?? '';
}

/** `2026-09-27` → `27`. The month is the head's job, not the column's. */
export function dayOfMonth(ymd: string): string {
  const m = /^\d{4}-\d{2}-(\d{2})$/.exec(ymd);
  return m ? String(Number(m[1])) : ymd;
}

/**
 * 630 → `10:30 AM`, 600 → `10:00 AM`.
 *
 * FORMATTED FROM THE MINUTE AND NOT FROM THE INSTANT, which is the point: the
 * minute is already salon-local, and handing the instant to `toLocaleTimeString`
 * would print it in the BROWSER's zone — the exact mistake the grid's columns
 * exist to avoid, in the one place it would be least visible.
 */
export function clockLabel(minutes: number): string {
  const h24 = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const suffix = h24 < 12 ? 'AM' : 'PM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

/**
 * 630 → `10:30`. WHAT A CHIP ACTUALLY PRINTS.
 *
 * THE SUFFIX IS DROPPED BECAUSE THE RULER ALREADY CARRIES IT, and because it
 * does not fit: a day with three artists at ten o'clock is three lanes, which at
 * a normal window width is about forty pixels of text each — enough for `10:00`
 * and not for `10:00 AM`, so the suffix was not being read, it was being CUT
 * ("10:0" against the lane edge, found by looking at it). The hour rows down the
 * left say AM and PM, the chip sits on one of them, and `chipLabel` gives the
 * unabbreviated time to anyone who cannot see where it sits.
 */
export function compactClockLabel(minutes: number): string {
  const h24 = Math.floor(minutes / 60) % 24;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(minutes % 60).padStart(2, '0')}`;
}

/** 600 → `10 AM`. The ruler has no room for the minutes and does not need them. */
export function hourLabel(minutes: number): string {
  const h24 = Math.floor(minutes / 60) % 24;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12} ${h24 < 12 ? 'AM' : 'PM'}`;
}

/**
 * ONE CHIP'S ACCESSIBLE NAME, AND IT CARRIES EVERYTHING THE BOX CANNOT.
 *
 * A chip is as small as its appointment, so at fifteen minutes it holds a time
 * and a first name and the rest is clipped by the box. None of that is allowed
 * to be the only copy of a fact, so the name states the lot in reading order:
 * when, who, what, with whom, and — always — the STATUS, because a chip that
 * announces as an appointment without saying it was cancelled is the colour-only
 * failure arriving through the accessibility tree.
 *
 * `branchAssumed` RIDES IT TOO, for the reason it is surfaced everywhere else:
 * the branch was a guess, and a guess that only appears as a visual marker is a
 * guess a screen reader is told as a fact.
 */
export function chipLabel(item: PlacedBooking): string {
  const b = item.booking;
  const parts = [
    `${weekdayLong(item.date)} ${dayOfMonth(item.date)}`,
    `${clockLabel(item.startMin)} to ${clockLabel(item.endMin)}${item.continues ? ' next day' : ''}`,
    b.memberName,
    b.serviceName,
    `with ${b.artistName}`,
    STATUS_PILL[b.status].label,
  ];
  if (b.branchAssumed) parts.push('branch assumed');
  if (b.calendarSyncState === 'failed') parts.push('not on their calendar');
  return parts.join(', ');
}
