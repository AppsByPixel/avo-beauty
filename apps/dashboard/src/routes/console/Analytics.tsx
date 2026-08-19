import { fils } from '@avo/types';
import { Card, InfoBanner, Money, Skeleton, StatCard } from '@avo/ui';
import { usePlatformMetrics, type PlatformMetrics } from '../../api/platformConsole.js';
import { SectionError } from '../sectionState.js';

/**
 * Analytics — "How AVO is performing across every salon".
 *
 * `AVO Owner Console.dc.html:98` § ANALYTICS: four KPI tiles, then a 1.35fr/1fr
 * pair of an eight-month bar chart and a top-five salon list.
 *
 * =========================================================================
 * TWO OF THE DESIGN'S FIGURES DO NOT EXIST, AND THE API SAID SO FIRST
 * =========================================================================
 * `services/platformMetrics.ts` names both as schema gaps and refuses to guess
 * them. This screen follows that refusal rather than overriding it from the
 * design, because relabelling the data would reintroduce exactly the claim the
 * API declined to make:
 *
 *   "Salons live" → rendered as "Salons". `salon` has no active/suspended
 *   column, and the endpoint returns `total` for that reason: "a tile that says
 *   four salons are live when one is suspended is worse than a tile that says
 *   there are four salons." The design's own activity feed draws "System
 *   suspended Glow Bar · billing hold", so suspension is real in the design and
 *   absent from the schema — a trunk gap, reported, not papered over here.
 *
 *   "Top salons this month" rows draw "{city} · {n} members". There is no city
 *   column, so the row shows the member count alone.
 *
 * =========================================================================
 * MONEY IS NOT ABBREVIATED, AND THE DESIGN ABBREVIATES IT
 * =========================================================================
 * The design's tiles read "214.3k KD" and "12,850 KD" via its own `fmtK`
 * (`f / 1000`, one decimal). That is not used here, for two reasons that point the
 * same way.
 *
 * Non-negotiable #1 puts the display boundary in one place — `formatFils` inside
 * `<Money>` — and an abbreviation is a second money formatter with its own
 * rounding. "214.3k" hides up to 50 KD; on AVO's own revenue tile that is a figure
 * somebody reconciles against a bank statement.
 *
 * And the house pattern already answered it: `Overview.tsx`'s "Loaded today" tile
 * is the same `StatCard` with `<Money>` and a `KD` unit slot. Two KPI rows in one
 * product that format money differently is worse than either choice on its own.
 *
 * Both money tiles skeleton as a bar and NEVER render `0.000` while pending —
 * interaction-spec.md §4, and `StatCard`'s own `loading` branch does it.
 */
export function Analytics() {
  const metrics = usePlatformMetrics();

  if (metrics.isError) {
    return (
      <SectionError
        error={metrics.error}
        forbiddenTitle="You don't have access to analytics"
        failedTitle="Couldn't load the platform metrics"
        onRetry={() => void metrics.refetch()}
        retrying={metrics.isFetching}
      />
    );
  }

  const m = metrics.data;
  const loading = metrics.isPending || !m;

  return (
    <div className="analytics">
      <InfoBanner icon={<PulseGlyph />}>
        Every figure here is the current calendar month across every salon. AVO revenue is the
        commission actually recorded on settled top-ups, not a rate applied to volume.
      </InfoBanner>

      <div className="analytics__kpis">
        {loading ? (
          /*
           * The design's four labels, in its order. Rendered while pending so the
           * row does not reflow when the data lands — and so a money tile shows a
           * bar rather than a zero.
           */
          ['Salons', 'Members', 'Loaded this month', 'AVO revenue'].map((label) => (
            <StatCard key={label} label={label} value={null} loading />
          ))
        ) : (
          <>
            {/* "Salons live" in the design. See the header — the schema cannot say "live". */}
            <StatCard
              label="Salons"
              value={m.salons.total.toLocaleString('en-US')}
              {...(m.salons.addedThisMonth > 0
                ? { delta: `+${m.salons.addedThisMonth} this month` }
                : {})}
            />
            <StatCard
              label="Members"
              value={m.members.total.toLocaleString('en-US')}
              {...(m.members.addedThisMonth > 0
                ? { delta: `+${m.members.addedThisMonth.toLocaleString('en-US')} this month` }
                : {})}
            />
            {/*
              The design's label is "Loaded (Jul)" — the month baked into the string.
              It is derived from the data here instead: the endpoint has no `?period=`
              precisely because every figure is the current calendar month, so a
              hardcoded month would be a caption that goes stale on the 1st.
            */}
            <StatCard
              label={`Loaded (${currentMonthLabel(m)})`}
              value={<Money amount={fils(m.loaded.thisMonthFils)} />}
              unit="KD"
              {...(m.loaded.knetSharePercent > 0
                ? { delta: `${m.loaded.knetSharePercent}% via KNET` }
                : {})}
            />
            <StatCard
              label="AVO revenue"
              value={<Money amount={fils(m.revenue.thisMonthFils)} />}
              unit="KD"
              {...momentumDelta(m)}
            />
          </>
        )}
      </div>

      <div className="analytics__split">
        <LoadedChart data={m?.loadedByMonth} loading={loading} />
        <TopSalons rows={m?.topSalons} loading={loading} />
      </div>
    </div>
  );
}

/**
 * "+9% MoM" in the design. Computed from `priorMonthFils`, and OMITTED when the
 * prior month is zero rather than rendered as a percentage of nothing.
 *
 * A month-on-month change against a zero base is not "+100%", it is undefined —
 * and on a seeded or first-month platform that is the normal case, so the tile
 * would otherwise open its life with a fabricated figure. Integer arithmetic on
 * integer fils; no float touches it.
 */
function momentumDelta(m: PlatformMetrics): { delta?: string } {
  const now = m.revenue.thisMonthFils;
  const before = m.revenue.priorMonthFils;
  if (before <= 0) return {};
  const pct = Math.round(((now - before) * 100) / before);
  return { delta: `${pct >= 0 ? '+' : ''}${pct}% MoM` };
}

/**
 * The short month name for the newest bar, which IS the current month — the API
 * returns `loadedByMonth` oldest-first and its last entry is this month.
 *
 * Parsed from the `YYYY-MM` the wire carries, with `Date.UTC` on day 1 so the
 * label cannot slide a month backwards in a negative-offset timezone. Falls back
 * to the raw string rather than throwing: a wrong caption must not take the whole
 * section to an error boundary.
 */
function currentMonthLabel(m: PlatformMetrics): string {
  const last = m.loadedByMonth[m.loadedByMonth.length - 1];
  if (!last) return 'this month';
  return monthShort(last.month);
}

function monthShort(iso: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(iso);
  if (!match) return iso;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isInteger(year) || month < 1 || month > 12) return iso;
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString('en-GB', {
    month: 'short',
    timeZone: 'UTC',
  });
}

/* --------------------------------------------------------------- the chart -- */

/** The design's own bar height budget, in px. */
const CHART_MAX_PX = 128;

/**
 * "Wallet loaded across platform · Last 8 months · KD".
 *
 * HEIGHTS ARE A PROPORTION OF THE LARGEST BAR, which is what the design does
 * (`Math.round((v / bmax) * 128)`). The division is presentation geometry and not
 * money: the FIGURE each bar represents is never derived from its height, and the
 * value is read out in the tooltip and the aria-label from the integer fils
 * through `formatFils`. So no float reaches a money field — #1 is about the
 * number, not the pixel.
 *
 * ALL-ZERO IS A REAL STATE AND NOT AN EMPTY ONE. A platform with no settled
 * top-ups this half-year returns eight zeroes, and `v / 0` would be `NaN` height
 * on every bar. It renders as eight baselines with the months still labelled,
 * because "no wallet loaded in March" is information and a blank card is not.
 */
function LoadedChart({
  data,
  loading,
}: {
  data: PlatformMetrics['loadedByMonth'] | undefined;
  loading: boolean;
}) {
  const max = data ? Math.max(...data.map((d) => d.loadedFils), 0) : 0;

  return (
    <Card className="analytics__chart">
      <div className="analytics__cardhead">
        <span className="analytics__h2 avo-display">Wallet loaded across platform</span>
        <span className="analytics__cardmeta">Last 8 months &middot; KD</span>
      </div>

      {loading || !data ? (
        <div className="analytics__bars" aria-hidden="true">
          {[68, 82, 54, 96, 74, 110, 88, 120].map((h, i) => (
            <div className="analytics__barcol" key={i}>
              <Skeleton width="100%" height={h} />
            </div>
          ))}
        </div>
      ) : (
        <ul className="analytics__bars">
          {data.map((d, i) => {
            const isLatest = i === data.length - 1;
            const height = max > 0 ? Math.round((d.loadedFils / max) * CHART_MAX_PX) : 0;
            return (
              <li className="analytics__barcol" key={d.month}>
                <div
                  className="analytics__bar"
                  data-latest={isLatest || undefined}
                  /*
                   * The one inline style on this screen, and it is a computed
                   * geometry rather than a colour — a per-bar height cannot live in
                   * a stylesheet. Every colour comes from a token in app.css.
                   * `max(height, 2px)` keeps a zero month visible as a baseline
                   * instead of vanishing, so eight labelled months always read as
                   * eight months.
                   */
                  style={{ height: `${Math.max(height, 2)}px` }}
                />
                <span className="analytics__barmonth">{monthShort(d.month)}</span>
                {/*
                  The figure itself, for a screen reader and on hover. `<Money>`
                  carries the aria-label that makes "12.500" read as dinars rather
                  than twelve thousand five hundred — interaction-spec.md §2.
                */}
                <span className="analytics__barvalue">
                  <Money amount={fils(d.loadedFils)} />
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/* ----------------------------------------------------------- top salons ---- */

/**
 * "Top salons this month" — five rows of rank, name, member count and money.
 *
 * THE DESIGN'S "{city} · {n} members" LOSES ITS CITY. `salon` has no city column
 * and `platformMetrics.ts` omitted it "rather than guessed from the name", so the
 * secondary line is the member count alone.
 *
 * EMPTY IS REACHABLE HERE, unlike the admin list: `topSalons` is ordered by money
 * and a platform with no salons onboarded returns `[]`. It names what is missing
 * rather than rendering an empty card.
 */
function TopSalons({
  rows,
  loading,
}: {
  rows: PlatformMetrics['topSalons'] | undefined;
  loading: boolean;
}) {
  return (
    <Card className="analytics__top">
      <div className="analytics__h2 avo-display analytics__tophead">Top salons this month</div>

      {loading || !rows ? (
        <ul className="analytics__toplist">
          {[0, 1, 2, 3, 4].map((i) => (
            <li className="analytics__toprow" key={i}>
              <Skeleton width={24} height={24} />
              <span className="analytics__topwho">
                <Skeleton width="55%" height={13} />
                <Skeleton width="35%" height={11} />
              </span>
              <Skeleton width={58} height={14} />
            </li>
          ))}
        </ul>
      ) : rows.length === 0 ? (
        <p className="analytics__topempty">
          No salons have loaded a wallet this month. Figures appear here once a top-up settles.
        </p>
      ) : (
        <ul className="analytics__toplist">
          {rows.map((s, i) => (
            <li className="analytics__toprow" key={s.salonId}>
              <span className="analytics__rank avo-display" aria-hidden="true">
                {i + 1}
              </span>
              <span className="analytics__topwho">
                <span className="analytics__topname">{s.name}</span>
                {/* The design's city is absent from the schema — see the header. */}
                <span className="analytics__topmeta">
                  {s.members.toLocaleString('en-US')} member{s.members === 1 ? '' : 's'}
                </span>
              </span>
              <span className="analytics__topmoney avo-display">
                <Money amount={fils(s.loadedFils)} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function PulseGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true" fill="none">
      <path
        d="M2.5 10h4l2-5 3 10 2-5h4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
