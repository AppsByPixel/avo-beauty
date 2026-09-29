import { useEffect, useState } from 'react';
import type { Boost, Branch, PromotionSet } from '@avo/types';
import { Button, Card, InfoBanner, InlineError, Pill, Segmented, Skeleton, Stepper, TextField } from '@avo/ui';
import type { PillTone } from '@avo/ui';
import {
  BOOST_BOUNDS,
  NEUTRAL_BOOST,
  summariseBoost,
  usePublishBoosts,
  useStopBoost,
  type BoostPublishRow,
} from '../../api/promotions.js';
import { ApiError } from '../../api/client.js';
import { clockFrame, dayMonth } from '../salonTime.js';
import { WriteError } from '../sectionState.js';
import {
  boostState,
  boostStateLabel,
  canStop,
  DURATION_OPTIONS,
  EMPTY_WINDOW,
  fieldsFromInstants,
  presetWindow,
  resolveWindow,
  sameInstant,
  whenLabel,
  type BoostState,
  type DurationMode,
  type ResolvedWindow,
  type WindowFields,
} from './boostWindowRules.js';

/**
 * Marketing → Branch boosts.
 *
 * The steppers and the wallet's "2× visits" chips are two views of one `boosts`
 * object — api-contract.md § Promotion set. Nothing is duplicated here; the
 * draft below is the merchant's *unpublished edit*, which is a different thing
 * from a second copy of the live value, and the screen says which is which.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TOP-UP BONUS IS GONE, AND A DURATION AND A STOP ARE NEW
 * ═══════════════════════════════════════════════════════════════════════════
 * The design draws three steppers; this draws two. Aftab ruled 2026-09-29 that
 * branch boosts lose the top-up bonus, because the server never paid it — a
 * top-up has no branch (DECISIONS, "Branch boosts lose the top-up bonus"). The
 * PUT always carries `topup: 0` (`api/promotions.ts § publishBody`).
 *
 * The duration editor, the state line and Stop are Aftab's request of the same
 * day ("Duration and stop option in the branch boost"), built on lane A's
 * 6d102c5. The design draws none of them, so their copy is this lane's and is
 * listed in the lane report. `boostWindowRules.ts` is the pure half.
 *
 * THE STATE LINE IS THE PUBLISHED ROW; THE STEPPERS AND FIELDS ARE THE DRAFT.
 * A merchant mid-edit sees "Live · ends today, 23:00" for what customers earn
 * now, and the foot says there are unpublished changes. Collapsing the two would
 * show a boost as running before anyone pressed Publish.
 */

export interface BoostsProps {
  branches: Branch[];
  promotions: PromotionSet | undefined;
  loading: boolean;
  /** The salon's zone — "published 12 Sep" and every duration field are the salon's clock. */
  timezone: string | null;
}

interface DraftRow {
  visit: number;
  stamp: number;
  mode: DurationMode;
  window: WindowFields;
  /** The published row this draft was filled from — see `seedRow`. */
  seed: { fields: WindowFields; startsAt: string | null; endsAt: string | null; fingerprint: string };
}

type Draft = Record<string, DraftRow>;

const isNeutral = (v: { visit: number; stamp: number }) =>
  v.visit === NEUTRAL_BOOST.visit && v.stamp === NEUTRAL_BOOST.stamp;

/**
 * WHAT A BRANCH'S DRAFT WAS SEEDED FROM, as one comparable string.
 *
 * The draft used to reseed on `boostsPublishedAt` alone. A stop does not bump
 * it (lane A: "reseed your cache from its response"), so after Stop the cache
 * would say neutral and the draft would still hold 2× visits — and the next
 * Publish would quietly start the boost she had just stopped. So each branch
 * reseeds when ITS OWN published row changes: its values, its window, its stop
 * record — or the set's publish identity, which keeps the old behaviour after a
 * publish — and a branch whose row did not change keeps her edit.
 */
function fingerprint(
  live: Boost | undefined,
  publishedAt: string | null | undefined,
  timezone: string | null,
): string {
  return JSON.stringify([
    publishedAt ?? null,
    timezone,
    live?.visit ?? 1,
    live?.stamp ?? 1,
    live?.startsAt ?? null,
    live?.endsAt ?? null,
    live?.stoppedAt ?? null,
  ]);
}

function seedRow(
  live: Boost | undefined,
  publishedAt: string | null | undefined,
  timezone: string | null,
): DraftRow {
  const visit = live?.visit ?? NEUTRAL_BOOST.visit;
  const stamp = live?.stamp ?? NEUTRAL_BOOST.stamp;
  const startsAt = live?.startsAt ?? null;
  const endsAt = live?.endsAt ?? null;
  const fields = fieldsFromInstants(startsAt, endsAt, timezone);
  return {
    visit,
    stamp,
    mode: startsAt === null && endsAt === null ? 'open' : 'custom',
    window: fields,
    seed: { fields, startsAt, endsAt, fingerprint: fingerprint(live, publishedAt, timezone) },
  };
}

function draftFrom(
  branches: Branch[],
  promotions: PromotionSet | undefined,
  timezone: string | null,
  prev: Draft = {},
): Draft {
  return Object.fromEntries(
    branches.map((b) => {
      const live = promotions?.boosts[b.id];
      const kept = prev[b.id];
      const fp = fingerprint(live, promotions?.boostsPublishedAt, timezone);
      return [b.id, kept && kept.seed.fingerprint === fp ? kept : seedRow(live, promotions?.boostsPublishedAt, timezone)];
    }),
  );
}

/** The draft's window as instants. A neutral row has none, as the server has it. */
function draftWindow(row: DraftRow, timezone: string | null): ResolvedWindow {
  if (isNeutral(row) || row.mode === 'open') return { ok: true, startsAt: null, endsAt: null };
  return resolveWindow(row.window, timezone, row.seed);
}

function rowChanged(row: DraftRow, live: Boost | undefined, timezone: string | null): boolean {
  const liveVisit = live?.visit ?? 1;
  const liveStamp = live?.stamp ?? 1;
  const liveNeutral = liveVisit === 1 && liveStamp === 1;
  if (row.visit !== liveVisit || row.stamp !== liveStamp) return true;
  const w = draftWindow(row, timezone);
  if (!w.ok) return true;
  return (
    !sameInstant(w.startsAt, liveNeutral ? null : (live?.startsAt ?? null)) ||
    !sameInstant(w.endsAt, liveNeutral ? null : (live?.endsAt ?? null))
  );
}

/** The state line re-reads the clock, so a boost that starts or ends while the screen is open says so. */
function useNow(periodMs: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), periodMs);
    return () => clearInterval(timer);
  }, [periodMs]);
  return now;
}

const STATE_TONE: Record<BoostState['kind'], PillTone> = {
  live: 'brand',
  scheduled: 'neutral',
  ended: 'quiet',
  stopped: 'quiet',
  off: 'quiet',
};

/**
 * WHICH ROW A PUBLISH REFUSAL BELONGS TO. The PUT is one request for the whole
 * grid, but its refusals are about one branch — `boost_already_ended` and
 * `invalid_boost` carry `branchId`, and every sentence it writes starts with
 * "BR-…:" — so the sentence goes under the branch it names, verbatim, including
 * whatever code lane A gives the non-zero `topup` refusal. A refusal that names
 * no branch stays at the foot.
 */
function refusedBranch(error: unknown, branches: Branch[]): string | null {
  if (!(error instanceof ApiError) || error.status !== 400) return null;
  const named = error.details.branchId;
  if (typeof named === 'string' && branches.some((b) => b.id === named)) return named;
  return branches.find((b) => error.message.startsWith(`${b.id}:`))?.id ?? null;
}

export function Boosts({ branches, promotions, loading, timezone }: BoostsProps) {
  const publish = usePublishBoosts();
  const stop = useStopBoost();
  const now = useNow(15_000);
  const [draft, setDraft] = useState<Draft>(() => draftFrom(branches, promotions, timezone));
  /** The one row whose Stop is open — the confirm and its error are scoped to it. */
  const [stopping, setStopping] = useState<{ branchId: string; confirming: boolean } | null>(null);

  useEffect(() => {
    setDraft((prev) => draftFrom(branches, promotions, timezone, prev));
  }, [branches, promotions, timezone]);

  const dirty =
    promotions !== undefined &&
    branches.some((b) => {
      const row = draft[b.id];
      return row !== undefined && rowChanged(row, promotions.boosts[b.id], timezone);
    });

  const localErrors = Object.fromEntries(
    branches.flatMap((b) => {
      const row = draft[b.id];
      if (!row) return [];
      const w = draftWindow(row, timezone);
      return w.ok ? [] : [[b.id, w.message]];
    }),
  ) as Record<string, string>;
  const blocked = Object.keys(localErrors).length > 0;

  const publishRefusedAt = publish.isError ? refusedBranch(publish.error, branches) : null;

  function update(branchId: string, patch: (row: DraftRow) => DraftRow) {
    publish.reset();
    setDraft((prev) => {
      const row = prev[branchId];
      return row ? { ...prev, [branchId]: patch(row) } : prev;
    });
  }

  function chooseMode(branchId: string, mode: DurationMode) {
    update(branchId, (row) => {
      if (mode === 'open') return { ...row, mode, window: EMPTY_WINDOW };
      if (mode === 'custom') return { ...row, mode };
      return { ...row, mode, window: presetWindow(mode, new Date(), timezone) ?? EMPTY_WINDOW };
    });
  }

  function setField(branchId: string, key: keyof WindowFields, value: string) {
    // Touching a field IS a custom window — the preset no longer describes it.
    update(branchId, (row) => ({ ...row, mode: 'custom', window: { ...row.window, [key]: value } }));
  }

  function onPublish() {
    const rows: Record<string, BoostPublishRow> = {};
    for (const b of branches) {
      const row = draft[b.id];
      if (!row) continue;
      const w = draftWindow(row, timezone);
      if (!w.ok) return;
      rows[b.id] = { visit: row.visit, stamp: row.stamp, startsAt: w.startsAt, endsAt: w.endsAt };
    }
    publish.mutate(rows);
  }

  function confirmStop(branchId: string) {
    stop.mutate(branchId, {
      onSuccess: () => setStopping(null),
      // A 409 means the row was stale; the set is being re-read, so the question
      // she was asked no longer describes it. Any other failure keeps it open.
      onError: (error) => {
        if (error instanceof ApiError && error.status === 409) {
          setStopping({ branchId, confirming: false });
        }
      },
    });
  }

  return (
    <Card className="mk__boosts">
      <InfoBanner>
        Push a quieter branch by paying more for the same behaviour there. The wallet stays one
        balance — only what a visit <i>earns</i> changes.
      </InfoBanner>

      {loading ? (
        <div className="mk__skeletons">
          {[0, 1].map((n) => (
            <Skeleton key={n} width="100%" height={120} />
          ))}
        </div>
      ) : branches.length === 0 ? (
        /*
         * Named the thing but not the action, which is the half of the rule that
         * is easy to miss — the merchant is told why the screen is empty and left
         * to work out where branches come from. They come from one place.
         */
        <p className="mk__none">
          This salon has no branches yet, so there is nothing to boost. Add one in{' '}
          <b>Settings → Branches</b> and it appears here.
        </p>
      ) : (
        branches.map((branch) => {
          const row = draft[branch.id] ?? seedRow(undefined, null, timezone);
          const state = boostState(promotions?.boosts[branch.id], now);
          const neutral = isNeutral(row);
          const w = draftWindow(row, timezone);
          const open = stopping?.branchId === branch.id ? stopping : null;
          return (
            <div key={branch.id} className="mk__boost" data-branch={branch.id}>
              <div className="mk__boosthead">
                <span className="mk__boostname">{branch.name}</span>
                <span className="mk__boostid">{branch.id}</span>
                <Pill tone={STATE_TONE[state.kind]}>{boostStateLabel(state, timezone, now)}</Pill>
                {canStop(state) && !open?.confirming ? (
                  <Button
                    variant="secondary"
                    className="mk__booststop"
                    onClick={() => {
                      stop.reset();
                      setStopping({ branchId: branch.id, confirming: true });
                    }}
                  >
                    Stop
                  </Button>
                ) : null}
              </div>

              {open?.confirming ? (
                <div className="mk__boostconfirm" role="group" aria-label={`Stop the boost at ${branch.name}`}>
                  <span className="mk__boostconfirmtext">
                    Stop the boost at {branch.name} now?{' '}
                    {state.kind === 'scheduled'
                      ? 'It will not start.'
                      : 'Visits there earn the salon’s base rate from the next charge.'}
                  </span>
                  <Button onClick={() => confirmStop(branch.id)} disabled={stop.isPending}>
                    {stop.isPending ? 'Stopping…' : 'Yes, stop it'}
                  </Button>
                  <Button
                    variant="quiet"
                    disabled={stop.isPending}
                    onClick={() => {
                      stop.reset();
                      setStopping(null);
                    }}
                  >
                    Keep it
                  </Button>
                </div>
              ) : null}

              {open && stop.isError ? (
                <StopRefusal error={stop.error} state={state} timezone={timezone} now={now} />
              ) : null}

              <div className="mk__boostgrid">
                <div className="mk__boostcell">
                  <div className="mk__boostlabel">Visit value</div>
                  <Stepper
                    value={row.visit}
                    {...BOOST_BOUNDS.visit}
                    onChange={(v) => update(branch.id, (r) => ({ ...r, visit: v }))}
                    format={(v) => `${v}×`}
                    label={`Visit value at ${branch.name}`}
                    valueText={`${row.visit} times`}
                  />
                </div>
                <div className="mk__boostcell">
                  <div className="mk__boostlabel">Stamps per visit</div>
                  <Stepper
                    value={row.stamp}
                    {...BOOST_BOUNDS.stamp}
                    onChange={(v) => update(branch.id, (r) => ({ ...r, stamp: v }))}
                    format={(v) => `${v}×`}
                    label={`Stamps per visit at ${branch.name}`}
                    valueText={`${row.stamp} times`}
                  />
                </div>
              </div>

              <div className="mk__boostwindow">
                <div className="mk__boostlabel">Duration</div>
                <Segmented
                  options={DURATION_OPTIONS.map((o) => ({ ...o, disabled: neutral }))}
                  value={row.mode}
                  onChange={(mode) => chooseMode(branch.id, mode)}
                  label={`Duration at ${branch.name}`}
                />
                {neutral ? (
                  <p className="mk__boostwhen">
                    Raise the visit value or the stamps to give this branch a boost to time.
                  </p>
                ) : row.mode === 'open' ? null : (
                  /*
                    THE ZONE IS NAMED ON THE FIELD, as `AppointmentForm` names it.
                    The instants are built in the SALON's zone and the merchant may
                    not be in it — saying which clock she is typing on is the
                    difference between a correct conversion and a correct-looking one.
                  */
                  <div className="mk__boostfields">
                    <TextField
                      label="Start date"
                      type="date"
                      value={row.window.startDate}
                      onChange={(e) => setField(branch.id, 'startDate', e.target.value)}
                    />
                    <TextField
                      label={`Start time (${timezone ?? 'salon time'})`}
                      type="time"
                      value={row.window.startTime}
                      onChange={(e) => setField(branch.id, 'startTime', e.target.value)}
                    />
                    <TextField
                      label="End date"
                      type="date"
                      value={row.window.endDate}
                      onChange={(e) => setField(branch.id, 'endDate', e.target.value)}
                    />
                    <TextField
                      label={`End time (${timezone ?? 'salon time'})`}
                      type="time"
                      value={row.window.endTime}
                      onChange={(e) => setField(branch.id, 'endTime', e.target.value)}
                    />
                  </div>
                )}
                {!neutral && w.ok ? (
                  <p className="mk__boostwhen">{windowSentence(w, timezone, now)}</p>
                ) : null}
                {!neutral && !w.ok ? <InlineError message={w.message} /> : null}
              </div>

              {/* The plain-language summary the design puts under each branch. */}
              <p className="mk__boostsummary">{summariseBoost(branch.name, row)}</p>

              {publishRefusedAt === branch.id ? (
                <WriteError
                  error={publish.error}
                  reassurance="Nothing was published — your branches are still earning at the rates above."
                />
              ) : null}
            </div>
          );
        })
      )}

      <div className="mk__boostfoot">
        <span className="mk__boostnote">
          {dirty
            ? 'Higher earning costs you margin on every visit at that branch.'
            : publishedNote(promotions, timezone)}
        </span>
        <Button
          onClick={onPublish}
          disabled={!dirty || blocked || publish.isPending}
          aria-disabled={!dirty || blocked || publish.isPending}
        >
          {publish.isPending ? 'Publishing…' : dirty ? 'Publish changes' : 'Published'}
        </Button>
      </div>

      {publish.isError && publishRefusedAt === null ? (
        <WriteError
          error={publish.error}
          reassurance="Nothing was published — your branches are still earning at the rates above."
        />
      ) : null}
    </Card>
  );
}

/**
 * What the draft's window will do, in the salon's clock. No start clause when
 * there is no start: "from when you publish" read wrongly under a boost that
 * had already been published and was running.
 */
function windowSentence(
  w: { startsAt: string | null; endsAt: string | null },
  timezone: string | null,
  now: Date,
): string {
  const from = w.startsAt === null ? '' : ` from ${whenLabel(w.startsAt, timezone, now)}`;
  const until = w.endsAt === null ? 'until you stop it' : `until ${whenLabel(w.endsAt, timezone, now)}`;
  return `Runs${from} ${until}.`;
}

/**
 * THE STOP'S REFUSALS, ON THE ROW THEY ARE ABOUT.
 *
 * The three 409s each mean the row was stale, and the set is re-read under this
 * line so the state beside it becomes true. `no_boost_running` and
 * `boost_already_ended` are the server's sentences, verbatim.
 * `boost_already_stopped` is the server's sentence with its ISO instant read in
 * the salon's clock — "at 2026-09-29T11:05:00.000Z" is the one part of it a
 * merchant cannot read, and the details carry the same two facts by name.
 * Anything else goes through `WriteError`, which keeps the confirm open for a retry.
 */
function StopRefusal({
  error,
  state,
  timezone,
  now,
}: {
  error: unknown;
  state: BoostState;
  timezone: string | null;
  now: Date;
}) {
  if (error instanceof ApiError && error.status === 409) {
    const by = error.details.stoppedBy;
    const at = error.details.stoppedAt;
    const text =
      error.code === 'boost_already_stopped' && typeof at === 'string'
        ? `This boost was already stopped${typeof by === 'string' ? ` by ${by}` : ''} ${whenLabel(at, timezone, now)}.`
        : error.message;
    return (
      <div className="section-write-error" role="alert">
        <span className="section-write-error__dot" aria-hidden="true" />
        <span className="section-write-error__text">
          {text} <b>Nothing else was changed.</b>
        </span>
      </div>
    );
  }
  return (
    <WriteError
      error={error}
      reassurance={
        state.kind === 'scheduled' ? 'The boost is still scheduled.' : 'The boost is still running.'
      }
    />
  );
}

/** "Live for all staff and scanners — published 12 Sep by Noura." */
function publishedNote(promotions: PromotionSet | undefined, timezone: string | null): string {
  if (!promotions?.boostsPublishedAt) return 'Live for all staff and scanners.';
  const at = new Date(promotions.boostsPublishedAt);
  const by = promotions.boostsPublishedBy;
  // The salon's calendar day, not the browser's — see `salonTime.ts`.
  return `Live for all staff and scanners — published ${dayMonth(at, clockFrame(timezone))}${by ? ` by ${by}` : ''}.`;
}
