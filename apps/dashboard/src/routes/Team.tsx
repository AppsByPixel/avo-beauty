import { useEffect, useMemo, useState } from 'react';
import { Button, Card, Chip, EmptyState, InfoBanner, Pill, Segmented, Skeleton, Stepper } from '@avo/ui';
import {
  SLOT_MINUTES,
  useArtists,
  useSaveAvailability,
  type ArtistWindows,
  type DashboardArtist,
  type DayKey,
  type DayWindow,
  type SlotMinutes,
} from '../api/artists.js';
import { SectionError, WriteError } from './sectionState.js';

/**
 * Merchant → Team. `GET /salons/{id}/artists`, `PUT /artists/{id}/availability`.
 *
 * Two views, as the design has them: a grid of artist cards, and a per-artist
 * hours editor that replaces the grid in place.
 *
 * THE GOOGLE REFUSAL IS THE SERVER'S, NOT THIS SCREEN'S.
 *
 * A Google-sourced artist draws her week as read-only rows with a Synced pill —
 * that is the design, and it is honest, because those windows really are
 * overwritten by the next calendar sync. But the disabled input is a courtesy
 * (non-negotiable #7), and the editor deliberately does not pre-block the one
 * path that reaches the refusal: switch to Manual, edit a day, switch back to
 * Google, save. That request carries `windows` with `availabilitySource:
 * 'google'`, and the API answers 409 `availability_is_synced` with a sentence
 * naming the fix. It is rendered verbatim rather than prevented, because a
 * merchant who is told "switch to Manual hours to set them here" learns the
 * rule, and a merchant whose button was quietly disabled learns nothing.
 */

const DAYS: ReadonlyArray<{ key: DayKey; short: string; name: string }> = [
  { key: '0', short: 'S', name: 'Sunday' },
  { key: '1', short: 'M', name: 'Monday' },
  { key: '2', short: 'T', name: 'Tuesday' },
  { key: '3', short: 'W', name: 'Wednesday' },
  { key: '4', short: 'T', name: 'Thursday' },
  { key: '5', short: 'F', name: 'Friday' },
  { key: '6', short: 'S', name: 'Saturday' },
];

/** The design's From/To steppers move in half hours. */
const STEP_MINUTES = 30;

function toMinutes(hhmm: string): number {
  const [h = '0', m = '0'] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

function toHhmm(minutes: number): string {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, minutes));
  return `${String(Math.floor(clamped / 60)).padStart(2, '0')}:${String(clamped % 60).padStart(2, '0')}`;
}

/** "6.5" not "6.50", "7" not "7.0" — the design's own rounding. */
function hours(totalMinutes: number): string {
  const h = totalMinutes / 60;
  return Number.isInteger(h) ? String(h) : h.toFixed(1);
}

interface WeekSummary {
  openDays: number;
  minutes: number;
  slots: number;
}

function summarise(windows: ArtistWindows, slotMinutes: number): WeekSummary {
  let openDays = 0;
  let minutes = 0;
  let slots = 0;
  for (const { key } of DAYS) {
    const day = windows[key];
    if (!day?.open) continue;
    const span = toMinutes(day.to) - toMinutes(day.from);
    openDays += 1;
    minutes += span;
    slots += Math.floor(span / slotMinutes);
  }
  return { openDays, minutes, slots };
}

/**
 * The API validates `windows` as a complete seven-day map and refuses a partial
 * one — a PUT is a replacement, and a merge dressed as a replace keeps the
 * Friday somebody just unticked. So the editor always holds all seven, and a
 * row the server omitted is filled from the salon's own default rather than
 * dropped.
 */
function normaliseWeek(windows: DashboardArtist['windows']): ArtistWindows {
  const out = {} as ArtistWindows;
  for (const { key } of DAYS) {
    const day = windows[key];
    out[key] = day
      ? { open: day.open, from: day.from, to: day.to }
      : { open: false, from: '10:00', to: '21:00' };
  }
  return out;
}

export function Team() {
  const artists = useArtists();
  const [editingId, setEditingId] = useState<string | null>(null);

  const items = artists.data?.items;
  const editing = items?.find((a) => a.id === editingId) ?? null;

  // An artist who vanishes from the roster while her editor is open (removed in
  // another tab) must not strand the screen on an editor with nothing behind it.
  useEffect(() => {
    if (editingId && items && !items.some((a) => a.id === editingId)) setEditingId(null);
  }, [editingId, items]);

  if (artists.isError) {
    return (
      <SectionError
        error={artists.error}
        forbiddenTitle="You don't have access to the team"
        failedTitle="Couldn't load the team"
        onRetry={() => void artists.refetch()}
        retrying={artists.isFetching}
      />
    );
  }

  if (editing) {
    return (
      <HoursEditor
        key={editing.id}
        artist={editing}
        onClose={() => setEditingId(null)}
      />
    );
  }

  return (
    <>
      <InfoBanner icon={<CalendarGlyph />}>
        Availability comes from each artist&rsquo;s <b>Google Calendar</b>, or from{' '}
        <b>manual hours</b> — which the artist sets in the Staff Scanner app, or{' '}
        <b>you (or a receptionist) set here</b>. Set an open window per day and any booking
        slot length.
      </InfoBanner>

      {artists.isPending ? (
        <div className="team__grid">
          {[0, 1, 2, 3].map((n) => (
            <ArtistCardSkeleton key={n} />
          ))}
        </div>
      ) : !items || items.length === 0 ? (
        <EmptyState
          title="No artists yet"
          body="Artists appear here once they are added to the salon. Each one carries her own weekly hours and booking slot length."
        />
      ) : (
        <div className="team__grid">
          {items.map((artist) => (
            <ArtistCard key={artist.id} artist={artist} onEdit={() => setEditingId(artist.id)} />
          ))}
        </div>
      )}
    </>
  );
}

/* -------------------------------------------------------------- artist card */

function ArtistCard({ artist, onEdit }: { artist: DashboardArtist; onEdit: () => void }) {
  const google = artist.availabilitySource === 'google';
  const week = normaliseWeek(artist.windows);
  const { openDays, minutes } = summarise(week, artist.slotMinutes);

  return (
    <Card className="team-card">
      <div className="team-card__head">
        <span className="team-card__avatar" aria-hidden="true">
          {artist.name.slice(0, 1)}
        </span>
        <div className="team-card__ident">
          <div className="team-card__name">{artist.name}</div>
          {/*
            The design puts a job title here ("Senior colorist", "Stylist"). The
            Artist entity carries no such field, so it is not invented — flagged
            in the lane report. What the API does carry, and says is for exactly
            this screen, is whether a staff login is linked: it is the difference
            between an artist who can set her own week from the scanner and one
            whose hours only reception can change.
          */}
          <div className="team-card__sub">
            {artist.hasOwnLogin ? 'Sets her own hours in the scanner' : 'Hours set by reception'}
          </div>
        </div>
        <Pill tone={google ? 'brand' : 'warn'}>{google ? 'Google Calendar' : 'Manual hours'}</Pill>
      </div>

      <div className="team-card__status">
        <span
          className="team-card__dot"
          data-source={artist.availabilitySource}
          aria-hidden="true"
        />
        <span className="team-card__status-text">
          {google ? 'Live availability · Google Calendar' : 'Manual hours · set by staff or reception'}
        </span>
      </div>

      <WeekStrip week={week} />

      <div className="team-card__foot">
        <span className="team-card__summary">
          {openDays} days · {hours(minutes)} hrs · {artist.slotMinutes}m slots
        </span>
        <Button onClick={onEdit}>Edit hours</Button>
      </div>
    </Card>
  );
}

function WeekStrip({ week }: { week: ArtistWindows }) {
  return (
    <ul className="team-week">
      {DAYS.map(({ key, short, name }) => {
        const open = week[key]?.open ?? false;
        return (
          <li key={key} className="team-week__cell">
            {/*
              The letter alone is ambiguous — two S's and two T's — and colour
              alone carries the open/closed state, which interaction-spec.md §2
              forbids. The visible glyph is decoration; the real label is here.
            */}
            <span className="team-week__badge" data-open={open ? '' : undefined}>
              <span aria-hidden="true">{short}</span>
              <span className="avo-sr-only">{open ? `${name}, open` : `${name}, closed`}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function ArtistCardSkeleton() {
  return (
    <Card className="team-card">
      <div className="team-card__head">
        <Skeleton width={46} height={46} radius={14} />
        <div className="team-card__ident">
          <Skeleton width="62%" height={15} />
          <Skeleton width="42%" height={12} />
        </div>
      </div>
      <div className="team-card__status">
        <Skeleton width="55%" height={12} />
      </div>
      <div className="team-card__foot">
        <Skeleton width="45%" height={12} />
        <Skeleton width={104} height={36} radius={10} />
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------ hours editor */

function HoursEditor({ artist, onClose }: { artist: DashboardArtist; onClose: () => void }) {
  const save = useSaveAvailability();

  const [source, setSource] = useState<'google' | 'manual'>(artist.availabilitySource);
  const [slotMinutes, setSlotMinutes] = useState<SlotMinutes>(artist.slotMinutes as SlotMinutes);
  const [week, setWeek] = useState<ArtistWindows>(() => normaliseWeek(artist.windows));

  const manual = source === 'manual';
  const summary = useMemo(() => summarise(week, slotMinutes), [week, slotMinutes]);

  const dirty =
    source !== artist.availabilitySource ||
    slotMinutes !== artist.slotMinutes ||
    JSON.stringify(week) !== JSON.stringify(normaliseWeek(artist.windows));

  function setDay(key: DayKey, next: Partial<DayWindow>) {
    setWeek((current) => ({ ...current, [key]: { ...current[key], ...next } }));
  }

  function onSave() {
    /*
     * Only what changed. The API rejects an empty body ("Nothing to change.")
     * and accepts source+windows together, which is the ordinary flow — the
     * segmented control moved to Manual and the rows became live in one gesture.
     */
    const patch: Parameters<typeof save.mutate>[0]['patch'] = {};
    if (source !== artist.availabilitySource) patch.availabilitySource = source;
    if (slotMinutes !== artist.slotMinutes) patch.slotMinutes = slotMinutes;
    if (JSON.stringify(week) !== JSON.stringify(normaliseWeek(artist.windows))) {
      patch.windows = week;
    }
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    save.mutate(
      { artistId: artist.id, patch },
      // Closes only on success. A 409 has to stay on screen next to the control
      // that caused it, or the merchant returns to a grid showing the old hours
      // with no idea why.
      { onSuccess: () => onClose() },
    );
  }

  return (
    <div className="hours-editor">
      <div className="hours-editor__head">
        <div>
          <button type="button" className="hours-editor__back" onClick={onClose}>
            &lsaquo; All artists
          </button>
          <h2 className="hours-editor__name avo-display">{artist.name}</h2>
          <div className="hours-editor__role">Working hours</div>
        </div>
        <Segmented
          label="Availability source"
          value={source}
          onChange={setSource}
          options={[
            {
              value: 'google',
              label: 'Google Calendar',
              /*
               * The API answers 409 `google_not_connected` for an artist with no
               * calendar linked — there are no synced hours to switch back to.
               * Disabled here so the option is visibly unavailable rather than
               * a refusal waiting to happen; the server still enforces it.
               */
              disabled: !artist.googleConnected,
            },
            { value: 'manual', label: 'Set manually' },
          ]}
        />
      </div>

      <div className="hours-editor__banner" data-manual={manual ? '' : undefined}>
        <span className="hours-editor__banner-dot" aria-hidden="true" />
        <span className="hours-editor__banner-text">
          {manual
            ? 'Manual hours — set the availability window for each day and the booking slot length. No fixed slots; any duration works.'
            : "Synced from this artist's Google Calendar. Switch to Manual to set hours here on their behalf."}
        </span>
      </div>

      {manual ? (
        <div className="hours-editor__slots">
          <div className="avo-label">Booking slot length</div>
          <div className="hours-editor__slot-row" role="radiogroup" aria-label="Booking slot length">
            {SLOT_MINUTES.map((minutes) => (
              <Chip
                key={minutes}
                role="radio"
                className="avo-chip--outline"
                on={minutes === slotMinutes}
                label={`${minutes}m`}
                onClick={() => setSlotMinutes(minutes)}
              />
            ))}
          </div>
        </div>
      ) : null}

      <ul className="hours-editor__week">
        {DAYS.map(({ key, short, name }) => {
          const day = week[key];
          const span = toMinutes(day.to) - toMinutes(day.from);
          const slots = day.open ? Math.floor(span / slotMinutes) : 0;

          return (
            <li key={key} className="hours-row">
              <div className="hours-row__day">
                <span className="hours-row__badge" data-open={day.open ? '' : undefined} aria-hidden="true">
                  {short}
                </span>
                <span className="hours-row__name">{name}</span>
              </div>

              <div className="hours-row__body">
                {!day.open ? (
                  <span className="hours-row__off">Day off</span>
                ) : manual ? (
                  <>
                    <Stepper
                      size="sm"
                      label={`${name} opens at`}
                      value={toMinutes(day.from)}
                      min={0}
                      max={toMinutes(day.to) - STEP_MINUTES}
                      step={STEP_MINUTES}
                      format={(v) => toHhmm(v)}
                      valueText={toHhmm(toMinutes(day.from))}
                      onChange={(v) => setDay(key, { from: toHhmm(v) })}
                    />
                    <span className="hours-row__arrow" aria-hidden="true">
                      &rarr;
                    </span>
                    <Stepper
                      size="sm"
                      label={`${name} closes at`}
                      value={toMinutes(day.to)}
                      min={toMinutes(day.from) + STEP_MINUTES}
                      max={23 * 60 + 30}
                      step={STEP_MINUTES}
                      format={(v) => toHhmm(v)}
                      valueText={toHhmm(toMinutes(day.to))}
                      onChange={(v) => setDay(key, { to: toHhmm(v) })}
                    />
                    <span className="hours-row__slots">
                      {slots} &times; {slotMinutes}m
                    </span>
                  </>
                ) : (
                  <>
                    <span className="hours-row__window">
                      {day.from} &ndash; {day.to}
                    </span>
                    <span className="hours-row__slots">
                      {slots} &times; {slotMinutes}m
                    </span>
                  </>
                )}
              </div>

              {manual ? (
                <button
                  type="button"
                  role="switch"
                  aria-checked={day.open}
                  aria-label={`${name} open`}
                  className="avo-toggle hours-row__toggle"
                  onClick={() => setDay(key, { open: !day.open })}
                >
                  <span className="avo-toggle__track">
                    <span className="avo-toggle__knob" />
                  </span>
                </button>
              ) : (
                <Pill tone={day.open ? 'brand' : 'quiet'}>{day.open ? 'Synced' : 'Off'}</Pill>
              )}
            </li>
          );
        })}
      </ul>

      {save.isError ? (
        <WriteError error={save.error} reassurance="Her hours are unchanged." />
      ) : null}

      <div className="hours-editor__foot">
        <span className="hours-editor__summary">
          {summary.openDays} open days · {hours(summary.minutes)} hrs · {summary.slots} slots / week
        </span>
        <Button onClick={onSave} disabled={save.isPending || !dirty}>
          {save.isPending ? 'Saving…' : 'Save hours'}
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ glyphs */

function CalendarGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="2.5" y="4" width="15" height="13" rx="2.2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M2.5 8h15" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}
