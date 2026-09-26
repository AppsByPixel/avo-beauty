import { useEffect, useMemo, useState } from 'react';
import { Card, EmptyState, ErrorState, Skeleton } from '@avo/ui';
import { useSalonBookingStream, type MerchantBooking } from '../api/bookings.js';
import { formatWindowDay } from '../api/reports.js';
import { useSalon } from '../api/salon.js';
import { SectionError } from './sectionState.js';
import {
  STATUS_PILL,
  WALK_BUDGET,
  chipBox,
  chipDensity,
  chipLabel,
  chipShape,
  compactClockLabel,
  dayOfMonth,
  hourLabel,
  makeZoneClock,
  oldestLocalDate,
  rulerHours,
  rulerRange,
  weekColumns,
  weekWindow,
  weekdayLong,
  weekdayShort,
  windowCoverage,
  type DayColumn,
  type PlacedBooking,
  type ZoneClock,
} from './appointmentsWeekRules.js';

/**
 * Merchant → Appointments → Week. `GET /salons/{id}/bookings`, `perms.appointments`.
 *
 * NEW WORK; THERE IS NO CALENDAR VIEW IN THE DESIGN BUNDLE — every "calendar" in
 * `design/AVO Merchant Dashboard.dc.html` is Google Calendar as an AVAILABILITY
 * SOURCE, not a view of appointments. `appointmentsWeekRules.ts` carries the full
 * disclosure and every rule this file draws.
 *
 * ===========================================================================
 * IT JOINS THE LIST, IT DOES NOT REPLACE IT
 * ===========================================================================
 * `Appointments.tsx` owns a segmented List/Week control and each view is a whole
 * answer rather than half of one. Replacing would have cost two things a grid
 * cell has no room for and that have no second home: the DEPOSIT column, which
 * is the only figure a disputed no-show is argued over, and MARK NO-SHOW, which
 * is a real write behind `perms.void` with a confirmation and an idempotency
 * key. Losing a working control to gain a view is a bad trade, and a grid with a
 * 12px destructive link in a chip that is sometimes fifteen minutes tall is a
 * worse one.
 *
 * SO THIS VIEW IS READ-ONLY, deliberately, and a merchant who needs to mark
 * switches to List — which every state below that cannot draw also tells her,
 * because the list has no preconditions this view has.
 *
 * ===========================================================================
 * IT OWNS ITS OWN READ, WHICH IS WHY IT OWNS ITS OWN FOUR STATES
 * ===========================================================================
 * `useSalonBookingStream` is a different cache entry from the list's
 * `useSalonBookings` and walks the cursor where the list reads one page, so it
 * fails independently of its host. `stateCensus.test.ts` carries the entry and
 * the reasoning, on `SalesTrend.tsx`'s precedent.
 *
 * It also reads `GET /salons/{id}` for the TIME ZONE, which decides which column
 * a booking is in — `appointmentsWeekRules.ts § makeZoneClock` argues why that cannot
 * be the `Asia/Kuwait` pin the Overview uses for display.
 */
export function AppointmentsWeek({ onShowList }: { onShowList: () => void }) {
  const salon = useSalon();
  const [offset, setOffset] = useState(0);

  /**
   * THE BUDGET IS STATE BECAUSE THE MERCHANT CAN RAISE IT. `WALK_BUDGET` pages
   * are fetched without asking; past that the screen stops, says what it has,
   * and offers to carry on. Raising it rather than removing it keeps every
   * subsequent stop an explicit one too.
   */
  const [budget, setBudget] = useState(WALK_BUDGET);

  const zone = salon.data?.timezone ?? null;
  const clock = useMemo(() => (zone === null ? null : makeZoneClock(zone)), [zone]);

  const stream = useSalonBookingStream(salon.isSuccess && clock !== null);

  const pages = stream.data?.pages ?? [];
  const rows: MerchantBooking[] = pages.flatMap((page) => page.items);

  /*
   * EXHAUSTION IS READ OFF THE PAYLOAD, NOT OFF `hasNextPage`, AND THE
   * DIFFERENCE IS A WRONG EMPTY STATE.
   *
   * TanStack derives `hasNextPage` from `getNextPageParam(lastPage)`, and with
   * no pages yet there is no last page — so `hasNextPage` is FALSE on a query
   * that has not started. Reading it as "the stream ran out" makes a pending
   * screen claim a complete window, i.e. "Nothing booked this week" painted over
   * a week nobody has looked at. The payload's own `nextCursor: null` cannot say
   * that: it only exists on a page that arrived.
   */
  const last = pages[pages.length - 1];
  const walk = {
    oldestSeenDate: clock === null ? null : oldestLocalDate(rows, clock),
    exhausted: last !== undefined && last.nextCursor === null,
    fetching: stream.isFetchingNextPage,
    pages: pages.length,
    budget,
  };

  const window = clock === null ? null : weekWindow(clock, new Date(), offset);
  const coverage = window === null ? null : windowCoverage(walk, window.from);

  /**
   * THE WALK. One page at a time, and only while the window is provably
   * incomplete — so a week already covered by what is in hand costs no request
   * at all, and moving BACK a week resumes the same walk rather than restarting
   * it. `hasNextPage` is the right guard here (it is about whether a fetch is
   * possible, which is what it means) and `isFetchingNextPage` stops the effect
   * re-entering while a page is in flight.
   */
  const needsMore = coverage?.kind === 'walking';
  useEffect(() => {
    if (!needsMore) return;
    if (!stream.hasNextPage || stream.isFetchingNextPage) return;
    void stream.fetchNextPage();
  }, [needsMore, stream]);

  if (salon.isError || stream.isError) {
    const failed = salon.isError ? salon : stream;
    return (
      <WeekShell window={null} offset={offset} onOffset={setOffset}>
        <SectionError
          error={failed.error}
          forbiddenTitle="You don't have access to appointments"
          failedTitle="Couldn't load the week"
          onRetry={() => {
            void salon.refetch();
            void stream.refetch();
          }}
          retrying={salon.isFetching || stream.isFetching}
        />
      </WeekShell>
    );
  }

  /*
   * A ZONE ARRIVED AND `Intl` DOES NOT KNOW IT. Named rather than papered over,
   * and with no retry, because retrying returns the same zone — the fix is in
   * Settings and the sentence says so. `SalesTrend.tsx § UnusableZone` makes the
   * same refusal about the same field; this one adds the List, because unlike a
   * chart of days the list needs no zone to be correct.
   */
  if (salon.isSuccess && (clock === null || window === null)) {
    return (
      <WeekShell window={null} offset={offset} onOffset={setOffset}>
        <UnusableZone zone={zone ?? ''} onShowList={onShowList} />
      </WeekShell>
    );
  }

  if (salon.isPending || window === null || coverage === null || stream.isPending) {
    return (
      <WeekShell window={window} offset={offset} onOffset={setOffset}>
        <WeekSkeleton />
      </WeekShell>
    );
  }

  /*
   * STILL WALKING. A SKELETON AND NOT A PARTIAL GRID, which is the decision this
   * whole view turns on: what is in hand right now is the FURTHEST-FUTURE end of
   * the salon's book, so drawing it would show a week with its later days filled
   * and its earlier ones empty — and every one of those empty hours would be a
   * claim nobody checked. The count is shown so the wait is legible rather than
   * silent.
   */
  if (coverage.kind === 'walking') {
    return (
      <WeekShell window={window} offset={offset} onOffset={setOffset}>
        <WeekWalking seen={rows.length} pages={pages.length} />
        <WeekSkeleton />
      </WeekShell>
    );
  }

  if (coverage.kind === 'short') {
    return (
      <WeekShell window={window} offset={offset} onOffset={setOffset}>
        <WeekTooDeep
          seen={rows.length}
          oldestSeenDate={walk.oldestSeenDate}
          from={window.from}
          onKeepLoading={() => setBudget((b) => b + WALK_BUDGET)}
          onShowList={onShowList}
        />
      </WeekShell>
    );
  }

  const { columns, unplaceable } = weekColumns(rows, clock as ZoneClock, window.days);
  const drawn = columns.reduce((n, column) => n + column.items.length, 0);
  const today = (clock as ZoneClock).at(new Date())?.date ?? null;

  return (
    <WeekShell window={window} offset={offset} onOffset={setOffset}>
      {unplaceable > 0 ? <UnplaceableNotice count={unplaceable} onShowList={onShowList} /> : null}
      {drawn === 0 ? (
        <WeekEmpty from={window.from} to={window.to} />
      ) : (
        <WeekGrid
          columns={columns}
          hours={salon.data?.businessHours}
          today={today}
          count={drawn}
          from={window.from}
          to={window.to}
        />
      )}
    </WeekShell>
  );
}

/* ================================================================ the frame == */

/**
 * The head and the card around whatever the view can say today.
 *
 * THE WEEK NAV IS ALWAYS DRAWN, INCLUDING OVER A REFUSAL. A merchant who has
 * walked back four weeks and hit a state has to be able to walk forward again;
 * a head that disappears with its content strands her on the one week that
 * cannot draw.
 *
 * `window === null` IS THE ONE CASE WITH NO DATES TO NAME — no zone, so no
 * week. The nav still moves, and the state underneath explains why nothing is
 * named.
 */
export function WeekShell({
  window,
  offset,
  onOffset,
  children,
}: {
  window: { from: string; to: string } | null;
  offset: number;
  onOffset: (next: number) => void;
  children: React.ReactNode;
}) {
  return (
    <Card className="apweek">
      <div className="apweek__head">
        <div>
          <h2 className="apweek__title">{offset === 0 ? 'This week' : weekTitle(offset)}</h2>
          <p className="apweek__range">
            {window === null
              ? 'Dates unavailable'
              : `${formatWindowDay(window.from)} – ${formatWindowDay(window.to)}`}
          </p>
        </div>
        <div className="apweek__nav">
          <button
            type="button"
            className="apweek__navbtn"
            aria-label="Previous week"
            onClick={() => onOffset(offset - 1)}
          >
            <Chevron direction="left" />
          </button>
          <button
            type="button"
            className="apweek__today"
            onClick={() => onOffset(0)}
            disabled={offset === 0}
          >
            Today
          </button>
          <button
            type="button"
            className="apweek__navbtn"
            aria-label="Next week"
            onClick={() => onOffset(offset + 1)}
          >
            <Chevron direction="right" />
          </button>
        </div>
      </div>
      {children}
    </Card>
  );
}

/** "Last week", "Next week", "3 weeks ahead", "2 weeks back". */
export function weekTitle(offset: number): string {
  if (offset === -1) return 'Last week';
  if (offset === 1) return 'Next week';
  const n = Math.abs(offset);
  return `${n} weeks ${offset < 0 ? 'back' : 'ahead'}`;
}

function Chevron({ direction }: { direction: 'left' | 'right' }) {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d={direction === 'left' ? 'M12.5 4.5 7 10l5.5 5.5' : 'M7.5 4.5 13 10l-5.5 5.5'}
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* ================================================================= the grid == */

/**
 * SEVEN DAY COLUMNS AGAINST AN HOUR RULER, and the artists are inside the chips
 * rather than being the columns.
 *
 * ARTIST COLUMNS WERE THE OTHER CANDIDATE and they answer a different question.
 * "Who is free on Tuesday" is a day view, one day at a time; a salon opening
 * this screen is asking "what does the week look like", and a grid whose columns
 * are artists can only show one day, so the week would need seven of them. The
 * artist's name is on every chip and a day column with two lanes already reads
 * as two people at once. A per-artist day view is the natural next slice and is
 * reported rather than taken.
 *
 * NOT A `<table>`, AND THAT IS THE OPPOSITE OF THE LIST'S RULING ON PURPOSE.
 * `Appointments.tsx` is a real table because its data IS rows and columns with
 * headers. This is not: a chip spans a range and sits beside another chip in the
 * same hour, so the "cell" it would occupy does not exist. Modelled as a table it
 * announces a lattice of empty cells; modelled as SEVEN LISTS IN TIME ORDER it
 * reads the way a person would say it — "Sunday the 27th: 10:00, Noura,
 * balayage with Dana, deposit held". The DOM order is the time order, so that is
 * true without any aria wiring beyond the day's name.
 */
export function WeekGrid({
  columns,
  hours,
  today,
  count,
  from,
  to,
}: {
  columns: DayColumn[];
  hours: Parameters<typeof rulerRange>[1];
  today: string | null;
  count: number;
  from: string;
  to: string;
}) {
  const range = rulerRange(columns, hours);
  const marks = rulerHours(range);

  return (
    <div className="apweek__scroll">
      <p className="avo-sr-only">
        {`${count} ${count === 1 ? 'appointment' : 'appointments'} from ${formatWindowDay(from)} to ${formatWindowDay(to)}, salon time.`}
      </p>
      <div
        className="apweek__grid"
        style={{ ['--apweek-rows' as string]: String(marks.length) }}
      >
        <div className="apweek__ruler" aria-hidden="true">
          {marks.map((minute) => (
            <span key={minute} className="apweek__hour">
              {hourLabel(minute)}
            </span>
          ))}
        </div>

        {columns.map((column) => (
          <section
            key={column.date}
            className={`apweek__col${column.date === today ? ' apweek__col--today' : ''}`}
            aria-label={`${weekdayLong(column.date)} ${dayOfMonth(column.date)}, ${
              column.items.length === 0
                ? 'nothing booked'
                : `${column.items.length} ${column.items.length === 1 ? 'appointment' : 'appointments'}`
            }`}
          >
            <h3 className="apweek__colhead">
              <span className="apweek__colday">{weekdayShort(column.date)}</span>
              <span className="apweek__colnum">{dayOfMonth(column.date)}</span>
            </h3>
            <ol className="apweek__slots">
              {column.items.map((item) => (
                <Chip key={item.booking.id} item={item} range={range} />
              ))}
            </ol>
          </section>
        ))}
      </div>
    </div>
  );
}

/**
 * ONE APPOINTMENT.
 *
 * THE BOX IS THE APPOINTMENT'S LENGTH AND THE LABEL IS THE TRUTH. A fifteen
 * minute slot is a fifteen minute box, which at the grid's scale is too short
 * for three lines of text — so the visible content is clipped by the box and the
 * accessible name carries everything (`appointmentsWeekRules.ts § chipLabel`). CSS
 * gives the box a minimum height so it stays clickable and legible; that floor
 * can make a very short appointment LOOK slightly longer than it is, which is
 * the one place this grid rounds in a direction it should say out loud. It never
 * rounds the times themselves.
 *
 * THE STATUS IS A SHAPE AND A WORD, NEVER A COLOUR ALONE — see
 * `appointmentsWeekRules.ts § ChipShape` for why a released slot drawn as a booked
 * one is the same class of lie as a missing chip.
 */
export function Chip({ item, range }: { item: PlacedBooking; range: { startMin: number; endMin: number } }) {
  const box = chipBox(item, range);
  const shape = chipShape(item.booking.status);
  const density = chipDensity(item.startMin, item.endMin);
  const b = item.booking;

  return (
    <li
      className={`apweek__chip apweek__chip--${shape} apweek__chip--${density}`}
      style={{
        top: `${box.top}%`,
        height: `${box.height}%`,
        left: `${box.left}%`,
        width: `${box.width}%`,
      }}
      aria-label={chipLabel(item)}
      title={chipLabel(item)}
    >
      {/*
        THE FIRST LINE IS THE ONE NO CHIP IS EVER TOO SHORT FOR, which is why the
        STATUS is on it rather than under the service. `chipDensity` drops whole
        lines from the bottom up; a status on the last line would be dropped on
        exactly the short appointments where a released slot most needs to not
        read as a booked one.

        `held` SPENDS NO WORDS. A chip that says nothing about its status is the
        appointment that is simply on, and "Deposit held" repeated down a week is
        the least surprising fact on the grid. It is in the accessible name,
        which is where that guarantee lives.
      */}
      <span className="apweek__chip-line" aria-hidden="true">
        <span className="apweek__chip-time">{compactClockLabel(item.startMin)}</span>
        {shape === 'held' ? null : (
          <span className="apweek__chip-status">{STATUS_PILL[b.status].label}</span>
        )}
      </span>
      <span className="apweek__chip-who" aria-hidden="true">
        {b.memberName}
      </span>
      <span className="apweek__chip-what" aria-hidden="true">
        {b.serviceName} · {b.artistName}
      </span>
      {/*
        The branch was a guess, not a fact — the same marker the list and every
        transaction carry, surfaced for the same reason. The chip is small, so
        this is an abbreviation with the full phrase in the accessible name.
      */}
      {b.branchAssumed ? (
        <span className="apweek__chip-assumed" aria-hidden="true">
          Branch assumed
        </span>
      ) : null}
      {b.calendarSyncState === 'failed' ? (
        <span className="apweek__chip-sync" aria-hidden="true">
          Not on their calendar
        </span>
      ) : null}
    </li>
  );
}

/* =============================================================== the states == */

/**
 * THE WALK IN PROGRESS. Not a spinner: it says WHAT it is doing and how far it
 * has got, because the wait is proportional to how much further into the future
 * this salon's book runs and a merchant deserves to see that it is moving.
 *
 * THE NUMBER IS THE ROWS READ, NOT A PERCENTAGE. There is no denominator — the
 * API does not publish how many bookings exist — and a progress bar with an
 * invented total is a confident-looking lie about a screen whose whole subject
 * is not making one.
 */
export function WeekWalking({ seen, pages }: { seen: number; pages: number }) {
  return (
    <p className="apweek__walking" role="status">
      <span className="apweek__walking-dot" aria-hidden="true" />
      Reading the whole week — {seen.toLocaleString('en-US')} appointments so far
      {pages > 1 ? `, ${pages} pages` : ''}. The grid draws once nothing can be missing.
    </p>
  );
}

/**
 * THE WALK STOPPED SHORT. The state this entire view was designed around.
 *
 * IT DRAWS NO GRID. A week grid missing its Thursday afternoon looks like a free
 * Thursday afternoon, and a salon acts on that by selling the hour twice. The
 * list has no such failure — it is visibly a list of the most recent page — so
 * the refusal names it as the way to see the same data, and offers to keep
 * walking for the merchant who would rather wait.
 *
 * IT SAYS HOW FAR IT GOT. "Back to 12 Oct" is the fact that makes the offer
 * decidable: a merchant looking at the first week of October can see she is one
 * more load away, and one looking at last January can see she is not.
 */
export function WeekTooDeep({
  seen,
  oldestSeenDate,
  from,
  onKeepLoading,
  onShowList,
}: {
  seen: number;
  oldestSeenDate: string | null;
  from: string;
  onKeepLoading: () => void;
  onShowList: () => void;
}) {
  return (
    <div className="apweek__state">
      <ErrorState
        title="We can't show this week yet"
        body={
          `This salon has more appointments booked ahead than we've read so far — ` +
          `${seen.toLocaleString('en-US')} of them, ` +
          `${oldestSeenDate === null ? 'none of them' : `back as far as ${formatWindowDay(oldestSeenDate)}`}` +
          `, and the week starting ${formatWindowDay(from)} is further back than that. ` +
          `Rather than draw a week with hours missing from it — which would read as free time — ` +
          `we've stopped here.`
        }
      />
      <div className="apweek__state-acts">
        <button type="button" className="apweek__state-go" onClick={onKeepLoading}>
          Keep loading
        </button>
        <button type="button" className="apweek__state-alt" onClick={onShowList}>
          Switch to List
        </button>
      </div>
    </div>
  );
}

/**
 * A ZONE `Intl` CANNOT USE. `SalesTrend.tsx § UnusableZone`'s refusal, with the
 * list named as the way through: a list of instants needs no salon zone to be
 * correct, so unlike the chart there is somewhere to send her.
 */
export function UnusableZone({ zone, onShowList }: { zone: string; onShowList: () => void }) {
  return (
    <div className="apweek__state">
      <ErrorState
        title="Couldn't work out your salon's days"
        body={`This salon's time zone is set to “${zone}”, which we don't recognise, so we can't tell which day an appointment falls on. Set it in Settings and the week will draw.`}
      />
      <div className="apweek__state-acts">
        <button type="button" className="apweek__state-alt" onClick={onShowList}>
          Switch to List
        </button>
      </div>
    </div>
  );
}

/**
 * NOTHING BOOKED, AND IT IS A DIFFERENT EMPTY FROM THE LIST'S TWO.
 *
 * `Appointments.tsx` has "Booking is switched off" and "No appointments this
 * week" — the second of which is about the whole board. This one is about SEVEN
 * NAMED DAYS and it is only reachable once `windowCoverage` says the week is
 * whole, so it is the one empty on this screen that is a measured fact rather
 * than the absence of an answer. It names the dates so that a merchant who has
 * paged to the wrong week can see that she has.
 */
export function WeekEmpty({ from, to }: { from: string; to: string }) {
  return (
    <div className="apweek__state">
      <EmptyState
        title="Nothing booked this week"
        body={`No appointments between ${formatWindowDay(from)} and ${formatWindowDay(to)}. Bookings from the customer app land here as soon as they're made.`}
      />
    </div>
  );
}

/**
 * A ROW THE GRID COULD NOT POSITION. Said out loud rather than dropped, for the
 * cap's reason: the difference between an hour nobody booked and an hour the
 * screen could not read is invisible on a grid, so the screen has to say which.
 * It should not happen — `startsAt` is the server's own ISO instant.
 */
export function UnplaceableNotice({ count, onShowList }: { count: number; onShowList: () => void }) {
  return (
    <p className="apweek__notice" role="status">
      {count === 1
        ? '1 appointment has a time we could not read, so it is not on the grid.'
        : `${count} appointments have times we could not read, so they are not on the grid.`}{' '}
      <button type="button" className="apweek__notice-link" onClick={onShowList}>
        See them in the list
      </button>
    </p>
  );
}

/**
 * THE PENDING GRID, AND ITS SHAPE IS THE SHAPE OF WHAT REPLACES IT — seven
 * columns against a ruler, with blocks where chips go. interaction-spec.md §4.
 *
 * THE BLOCKS ARE PLACED AT FIXED POSITIONS AND NOT AT RANDOM ONES. A skeleton
 * whose blocks move between renders reads as content arriving and rearranging;
 * one whose blocks are in the same place every time reads as a placeholder,
 * which is what it is. It also claims nothing about how BUSY the week is: three
 * blocks a column, every column the same, so no one can read a rhythm off a
 * loading state (`SalesTrend.tsx § TrendSkeleton` refuses the same thing about
 * bar heights).
 */
export function WeekSkeleton() {
  const HOURS = 10;
  return (
    <div className="apweek__scroll" aria-hidden="true">
      <div className="apweek__grid" style={{ ['--apweek-rows' as string]: String(HOURS) }}>
        <div className="apweek__ruler">
          {Array.from({ length: HOURS }, (_, i) => (
            <span key={i} className="apweek__hour">
              <Skeleton width={34} height={10} />
            </span>
          ))}
        </div>
        {Array.from({ length: 7 }, (_, day) => (
          <section key={day} className="apweek__col">
            <h3 className="apweek__colhead">
              <Skeleton width={46} height={12} />
            </h3>
            <ol className="apweek__slots">
              {[
                { top: 6, height: 11 },
                { top: 30, height: 16 },
                { top: 62, height: 11 },
              ].map((box, i) => (
                <li
                  key={i}
                  className="apweek__chip apweek__chip--loading"
                  style={{ top: `${box.top}%`, height: `${box.height}%`, left: '0%', width: '100%' }}
                >
                  <Skeleton width="100%" height="100%" />
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>
    </div>
  );
}
