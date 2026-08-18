import { useEffect, useState } from 'react';
import {
  formatCountdown,
  hhmmToMinutes,
  isHappyHourLive,
  minutesRemaining,
  minutesUntilNext,
  salonClock,
  type Branch,
  type HappyHour,
  type PromotionSet,
  type RewardKey,
} from '@avo/types';
import { Button, Card, Chip, Pill, Skeleton, Toggle } from '@avo/ui';
import {
  DAY_SHORT,
  HAPPY_REWARDS,
  REWARD_LABEL,
  daysLabel,
  useAddHappyHour,
  useRemoveHappyHour,
  useUpdateHappyHour,
} from '../../api/promotions.js';
import { WriteError } from '../sectionState.js';

/**
 * Marketing → Happy hours.
 *
 * EVERY LIVE STATUS ON THIS SCREEN IS DERIVED FROM THE CLOCK, NEVER STORED.
 *
 * api-contract.md § Promotion set: "There is no `live` flag. A window is live if
 * and only if `days.includes(now.getDay()) && from <= now < to` in salon-local
 * time." `isHappyHourLive`, `minutesRemaining` and `minutesUntilNext` are
 * imported from `@avo/types` — the same functions the API calls to gate the
 * earning multiplier at charge time and the same ones the wallet calls to draw
 * its banner.
 *
 * They are IMPORTED rather than reimplemented because three implementations of
 * "is this window open" is three answers, and only one of them prices a charge.
 * A dashboard that drew its own half-open interval — or forgot that the interval
 * IS half-open, `from <= now < to` — would show a salon a window it believes is
 * live while the server refuses the multiplier.
 */

export interface HappyHoursProps {
  branches: Branch[];
  promotions: PromotionSet | undefined;
  loading: boolean;
}

/** Re-render every second so the countdown is real rather than a page-load snapshot. */
function useTick(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * "3h 24m" — the *duration* form, for "Opens in …".
 *
 * Not `formatCountdown`, which appends "left": "Opens in 3h 24m left" is not a
 * sentence. Same numbers, different frame, so the shared helper stays the one
 * that renders "42m left" on the live row and in the wallet banner.
 *
 * DAYS ARE ADDED ABOVE 24 HOURS, which the reference `countdown` in
 * avo-promotions.js does not do — it runs hours up indefinitely. The design
 * never shows the case because its fixture always has a window opening the same
 * day; a real salon with one Thursday window looking at it on a Friday gets
 * "Opens in 159h 36m", and no merchant converts that in her head. The predicate
 * is untouched; this is the sentence around it.
 */
function durationLabel(mins: number): string {
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${h}h`;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function HappyHours({ branches, promotions, loading }: HappyHoursProps) {
  const now = useTick();
  const windows = promotions?.happy ?? [];

  /*
   * WHICH window gets a countdown to its opening: exactly one, the soonest.
   *
   * The design shows "Opens in 3h 24m" against the single next window to open
   * and "Scheduled" against every other future one — `resolveHappy` returns one
   * `next` for the whole set, not one per row. That distinction is the useful
   * one: a merchant wants to know what happens NEXT, and five rows each
   * counting down to a different day is five numbers she has to sort herself.
   * A window whose next occurrence is six days out is "Scheduled".
   *
   * Paused windows are excluded because `minutesUntilNext` returns null for
   * them — a switched-off window has no next opening, which is the point of
   * switching it off.
   */
  const nextToOpenId = windows.reduce<{ id: string; mins: number } | null>((best, w) => {
    if (isHappyHourLive(w, now)) return best;
    const mins = minutesUntilNext(w, now);
    if (mins === null) return best;
    return best === null || mins < best.mins ? { id: w.id, mins } : best;
  }, null)?.id;

  const clock = salonClock(now);
  const clockLabel = `Salon clock ${String(Math.floor(clock.minutes / 60)).padStart(2, '0')}:${String(
    clock.minutes % 60,
  ).padStart(2, '0')} · ${DAY_SHORT[clock.day]}`;

  return (
    <div className="mk__happy">
      <Card>
        <div className="mk__cardhead">
          <h2 className="mk__cardtitle">Windows</h2>
          {/*
            The clock the rows are resolved against, shown so a merchant reading
            "Opens in 3h" can check it against her own watch. `salonClock` is the
            shared one: Kuwait is UTC+3 year-round, and a browser in another zone
            must not shift these rows.
          */}
          <span className="mk__clock" role="status">
            {loading ? '' : clockLabel}
          </span>
        </div>
        <p className="mk__cardsub">
          A window raises earning inside its hours and, if you want, tells customers the moment it
          opens. Wallets read the same windows and count down to the minute.
        </p>

        {loading ? (
          <div className="mk__skeletons">
            {[0, 1].map((n) => (
              <Skeleton key={n} width="100%" height={64} />
            ))}
          </div>
        ) : windows.length === 0 ? (
          <p className="mk__none">
            {/*
              Was "Add one on the right". `.mk__happy` is two columns at base and
              one at tablet (app.css §mk__happy), so at the narrower widths the
              "Add a window" card sits BELOW this one and the direction was simply
              wrong. Naming the panel is correct at every breakpoint — which is
              what §1's reflow means for copy, not just for layout.
            */}
            No windows yet. Add one in <b>Add a window</b> and it goes live at its next start
            time.
          </p>
        ) : (
          windows.map((w) => (
            <WindowRow
              key={w.id}
              window={w}
              now={now}
              branches={branches}
              isNext={w.id === nextToOpenId}
            />
          ))
        )}
      </Card>

      <AddWindow branches={branches} />
    </div>
  );
}

function branchName(branches: Branch[], branchId: string): string {
  if (branchId === 'all') return 'All branches';
  return branches.find((b) => b.id === branchId)?.name ?? branchId;
}

function WindowRow({
  window: w,
  now,
  branches,
  isNext,
}: {
  window: HappyHour;
  now: Date;
  branches: Branch[];
  /** True for the one window opening soonest across the whole set. */
  isNext: boolean;
}) {
  const update = useUpdateHappyHour();
  const remove = useRemoveHappyHour();

  /*
   * THE FOUR ROW STATES, ALL DERIVED. Nothing here reads a stored flag:
   *
   *   Paused           `on` is false — the merchant switched it off.
   *   Live · 42m left  the shared predicate says yes, right now.
   *   Opens in 3h 24m  not live, but its next start is known.
   *   Scheduled        on, with no next start inside the search window.
   */
  const live = isHappyHourLive(w, now);
  const untilNext = isNext && !live ? minutesUntilNext(w, now) : null;

  const label = !w.on
    ? 'Paused'
    : live
      ? `Live · ${formatCountdown(minutesRemaining(w, now))}`
      : untilNext !== null
        ? `Opens in ${durationLabel(untilNext)}`
        : 'Scheduled';

  return (
    <div className="mk__window" data-off={w.on ? undefined : ''}>
      <div className="mk__windowtop">
        <span className="mk__windowtime">
          {w.from} – {w.to}
        </span>
        {/*
          The pill carries its meaning as text, not colour — interaction-spec.md
          §2. `aria-live` because this one changes on its own while the merchant
          is looking at it, which no other pill in the dashboard does.
        */}
        <span role="status" aria-live="polite">
          <Pill tone={w.on && live ? 'brand' : 'quiet'}>{label}</Pill>
        </span>
        <div className="mk__windowactions">
          <Toggle
            checked={w.on}
            onChange={(next) => update.mutate({ id: w.id, patch: { on: next } })}
            label={w.on ? 'Switch this window off' : 'Switch this window on'}
            disabled={update.isPending}
          />
          <Button
            variant="secondary"
            className="mk__remove"
            onClick={() => remove.mutate(w.id)}
            disabled={remove.isPending}
            aria-label={`Remove the ${w.from} to ${w.to} window`}
          >
            ✕
          </Button>
        </div>
      </div>

      <div className="mk__windowchips">
        <span className="mk__chip">{branchName(branches, w.branchId)}</span>
        <span className="mk__chip">{daysLabel(w.days)}</span>
        <span className="mk__chip mk__chip--reward">{REWARD_LABEL[w.reward]}</span>
        <span className="mk__chip">{w.notify ? 'Notifies on open' : 'Silent'}</span>
      </div>

      {/*
        The 409 the API answers when a window has already priced a charge names
        the alternative — "Switch it off instead." Rendered verbatim.
      */}
      {remove.isError ? (
        <WriteError error={remove.error} reassurance="The window is still live." />
      ) : null}
      {update.isError ? (
        <WriteError error={update.error} reassurance="Nothing changed." />
      ) : null}
    </div>
  );
}

const DEFAULT_DAYS = [false, false, false, false, false, false, false];

function AddWindow({ branches }: { branches: Branch[] }) {
  const add = useAddHappyHour();
  const [branchId, setBranchId] = useState('all');
  const [days, setDays] = useState<boolean[]>(DEFAULT_DAYS);
  const [from, setFrom] = useState('16:00');
  const [to, setTo] = useState('18:00');
  const [reward, setReward] = useState<RewardKey>('x2stamp');
  const [notify, setNotify] = useState(true);
  const [error, setError] = useState('');

  const picked = days.flatMap((on, i) => (on ? [i] : []));

  /*
   * A WINDOW MAY NOT CROSS MIDNIGHT, AND THE FORM REFUSES IT AT ENTRY.
   *
   * The shared predicate is `from <= now < to`, which is empty whenever
   * `to <= from` — a 22:00–02:00 window would store fine and never once be live.
   * Refusing here rather than letting the server take it is the difference
   * between a merchant fixing a typo and a merchant wondering for a week why her
   * late-night double stamps never fired.
   *
   * Compared as MINUTES through the shared `hhmmToMinutes`, not as strings:
   * "9:00" > "10:00" lexically, and a browser that renders a 24h time input
   * without the leading zero would make the string form wrong.
   */
  function submit() {
    if (picked.length === 0) {
      setError('Pick at least one day.');
      return;
    }
    if (hhmmToMinutes(to) <= hhmmToMinutes(from)) {
      setError('The end time must be after the start — a window cannot cross midnight.');
      return;
    }
    setError('');
    add.mutate(
      { branchId, days: picked, from, to, reward, on: true, notify },
      { onSuccess: () => setDays(DEFAULT_DAYS) },
    );
  }

  return (
    <Card>
      <h2 className="mk__cardtitle">Add a window</h2>
      <div className="mk__form">
        <label className="mk__field">
          <span className="avo-label">Branch</span>
          <select
            className="avo-input"
            value={branchId}
            onChange={(e) => setBranchId(e.target.value)}
          >
            <option value="all">All branches</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>

        <div className="mk__field">
          <span className="avo-label" id="mk-days">
            Days
          </span>
          <div className="mk__days" role="group" aria-labelledby="mk-days">
            {DAY_SHORT.map((d, i) => (
              <Chip
                key={d}
                role="switch"
                on={days[i] ?? false}
                label={d}
                onClick={() => {
                  setDays((prev) => prev.map((v, j) => (j === i ? !v : v)));
                  setError('');
                }}
              />
            ))}
          </div>
        </div>

        <div className="mk__times">
          <label className="mk__field">
            <span className="avo-label">From</span>
            <input
              className="avo-input"
              type="time"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                setError('');
              }}
            />
          </label>
          <label className="mk__field">
            <span className="avo-label">To</span>
            <input
              className="avo-input"
              type="time"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                setError('');
              }}
            />
          </label>
        </div>

        <label className="mk__field">
          <span className="avo-label">Reward inside the window</span>
          <select
            className="avo-input"
            value={reward}
            onChange={(e) => setReward(e.target.value as RewardKey)}
          >
            {HAPPY_REWARDS.map((r) => (
              <option key={r} value={r}>
                {REWARD_LABEL[r]}
              </option>
            ))}
          </select>
        </label>

        <div className="mk__notify">
          <div>
            <div className="mk__notifytitle">Notify when it opens</div>
            <div className="mk__notifysub">One push per window, per person</div>
          </div>
          <Toggle checked={notify} onChange={setNotify} label="Notify when it opens" />
        </div>

        {error ? (
          <p className="mk__formerror" role="alert">
            {error}
          </p>
        ) : null}
        {add.isError ? <WriteError error={add.error} reassurance="No window was added." /> : null}

        <Button block onClick={submit} disabled={add.isPending}>
          {add.isPending ? 'Adding…' : 'Add window'}
        </Button>
      </div>
    </Card>
  );
}
