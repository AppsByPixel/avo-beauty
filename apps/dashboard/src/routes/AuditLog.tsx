import { useState } from 'react';
import {
  Button,
  Card,
  EmptyState,
  FilterBar,
  FilterChips,
  InfoBanner,
  Pill,
  Skeleton,
  type PillTone,
} from '@avo/ui';
import { AUDIT_KINDS, useAuditLog, type AuditEntry, type AuditKind } from '../api/audit.js';
import { useSalon } from '../api/salon.js';
import { clock24, clockFrame, dayMonth, relativeDay } from './salonTime.js';
import { SectionError } from './sectionState.js';
import { enumParam, useSearchText, useUrlFilters } from './listFilters.js';

/**
 * Merchant → Audit log. `GET /salons/{id}/audit`, `perms.dashboard`.
 *
 * NO COURTESY PERMISSION GATE, DELIBERATELY. The read is
 * `requireDashboardPerm(req, 'dashboard')`, so the refusal arrives on its own, and
 * there is no write here — there is no POST and there never will be. Ledger in
 * sectionState.tsx.
 *
 * A REAL <table>, NOT THE DESIGN'S GRID OF DIVS.
 * interaction-spec.md §2 is explicit — "Data tables: `<table>` with real
 * `<th scope="col">`. Not divs." — and §1 adds that a data table never drops
 * columns responsively, because a merchant reconciling money needs all of them;
 * it scrolls inside its card with the header row sticky. The design file draws
 * this with CSS grid, which is a prototype convenience: five unlabelled columns
 * of prose read as one run-on sentence to a screen reader.
 */

/** Exported: the console's Audit section renders the same chips — see api/audit.ts. */
export const KIND_LABEL: Record<AuditKind, string> = {
  money: 'Money',
  rules: 'Rules',
  access: 'Access',
  risk: 'Risk',
};

/**
 * The pill colour per kind.
 *
 * TOKEN NOTE. `money` and `risk` map exactly onto named tokens. `rules` and
 * `access` do not: the design paints them #ECEEF0/#5f6b73 and #EAE2D6/#8a6d3b,
 * which are `tier.silver` and `plan.pro` — a loyalty-tier token and a
 * subscription-plan token, neither of which means "an audit row about a rule
 * change". They are reported to trunk rather than borrowed; the nearest
 * semantically honest tone is used until a token exists. See @avo/ui Pill.
 *
 * The design's #8a6d3b above is the value as DRAWN, and it is no longer the
 * token: it measured 4.01:1 on #F3E9CF and 3.77:1 on #EAE2D6, failing AA at
 * pill sizes, and `color.warnText` / `plan.pro.text` / `tier.gold.pillText` are
 * now #7A6034. The design reference is left as the design drew it; what renders
 * comes from the token.
 */
export const KIND_TONE: Record<AuditKind, PillTone> = {
  money: 'brand',
  rules: 'neutral',
  access: 'warn',
  risk: 'danger',
};

/**
 * "Today · 6:42 PM", "Yesterday · 4:12 PM", "10 Jul · 9:40 AM".
 *
 * The API sends an ISO instant on purpose: the relative phrasing depends on the
 * reader's clock and language, and non-negotiable #12 makes the Arabic dashboard
 * a first-class layout rather than a string swap. This is that rendering, in the
 * design's own shape.
 */
/**
 * The empty line for a filtered read, naming every active filter — composed
 * across the axes rather than enumerated into variants. Written for the console's
 * read and MOVED here beside the labels it uses when the row-365 audit found the
 * merchant screen failing its own standard: with only a kind chip set it said
 * "No entries match that search" — and there was no search. On an audit log,
 * "no entries" against a misnamed filter misreports what was looked for.
 *
 * `scope` is the console's `?salon=` axis, given as the PHRASE that names it —
 * "AVO platform actions" for the `platform` literal, or a salon's own name now
 * that the `?salon=SAL-…` picker can resolve one. A phrase rather than a boolean
 * because the axis stopped being binary when the picker landed: "No Money entries
 * yet" under a salon filter misreports what was looked for in exactly the way
 * this function exists to prevent. The merchant read has no scope axis and passes
 * null.
 */
export function auditEmptyLine(
  query: string,
  kind: AuditKind | null,
  scope: string | null,
): string {
  const what = kind ? `${KIND_LABEL[kind]} entries` : 'entries';
  const from = scope === null ? '' : ` from ${scope}`;
  if (query.trim() !== '') return `No ${what}${from} match “${query.trim()}”.`;
  if (kind || scope !== null) return `No ${what}${from} yet.`;
  return 'No entries match that search.';
}

/**
 * "Today · 14:05", "Yesterday · 09:12", "9 Jul · 19:40" — the feed stamp the
 * audit log, the Shop orders board and the console's two feeds share.
 *
 * THE ZONE IS AN ARGUMENT, AND WHICH ONE IS A DECISION PER SCREEN, NOT A DEFAULT.
 * This used to format in the browser's zone and compare `toDateString()`s, so a
 * reader in Karachi saw a Kuwait salon's evening under tomorrow's date.
 * `salonTime.ts` has the whole argument; the decisions it forces are:
 *
 *   - THE MERCHANT AUDIT LOG AND THE ORDERS BOARD pass the SALON's zone. They
 *     are the salon's own records, read against its till receipts and its
 *     appointment book, and "Today" here must be the same day the Appointments
 *     list calls Today — a void at 22:30 Kuwait time is today's void there.
 *   - THE CONSOLE (`console/Audit.tsx`, `console/Activity.tsx`) passes
 *     `viewerZone()`. Its rows span every salon, and one column mixing each
 *     row's own zone would stop sorting by time as a reader scans it. The
 *     reader's own clock is the one frame every row shares — chosen explicitly
 *     at the call site so it is never what happens by leaving a zone out.
 */
export function whenLabel(iso: string, timezone: string | null, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'unknown';
  const frame = clockFrame(timezone);
  const time = clock24(at, frame);

  const day = relativeDay(at, now, frame.zone);
  if (day === 'today') return `Today · ${time}`;
  if (day === 'yesterday') return `Yesterday · ${time}`;
  return `${dayMonth(at, frame)} · ${time}`;
}

/**
 * BOTH FILTERS GO TO THE SERVER — `?q=` and `?kind=` on `GET /salons/{id}/audit`,
 * which is cursor-paged over years of rows; filtering a loaded page here would
 * report "no entries" for a void two pages back.
 *
 * THE KIND IS IN THE URL; THE SEARCH IS NOT. The box matches customer names
 * ("Search staff, customer or action"), and a customer's name does not belong
 * in browser history or a copied link — `listFilters.ts`.
 *
 * NO DATE FILTER, and not one faked over loaded pages: the endpoint takes no
 * `?from=&to=`. It is in the lane report for lane A.
 */
const AUDIT_FILTERS = { kind: enumParam(AUDIT_KINDS) } as const;

export const AUDIT_KIND_CHIPS: ReadonlyArray<{ value: AuditKind | ''; label: string }> = [
  { value: '', label: 'All' },
  ...AUDIT_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] })),
];

export function AuditLog() {
  const [query, setQuery] = useState('');
  // Debounced: the search box hits the API, and a request per keystroke would
  // put a LIKE over a years-deep table on every letter.
  const search = useSearchText(query, setQuery, 300);
  const url = useUrlFilters(AUDIT_FILTERS);
  const kind = (url.values.kind || null) as AuditKind | null;
  const filtered = query.trim() !== '' || kind !== null;
  const clearFilters = () => {
    search.reset();
    setQuery('');
    url.clear();
  };

  const log = useAuditLog({ q: query, kind });
  // The shell has already read the salon; this is a cache hit, not a request.
  const timezone = useSalon().data?.timezone ?? null;

  if (log.isError) {
    return (
      <SectionError
        error={log.error}
        forbiddenTitle="You don't have access to the audit log"
        failedTitle="Couldn't load the audit log"
        onRetry={() => void log.refetch()}
        retrying={log.isFetching}
      />
    );
  }

  const pages = log.data?.pages ?? [];
  const rows = pages.flatMap((p) => p.items);
  const total = pages[0]?.total ?? 0;
  const retention = pages[0]?.retentionYears ?? 7;

  return (
    <div className="audit">
      <InfoBanner icon={<ClockGlyph />}>
        Every charge, void, reimbursement, rule change and permission change in this salon — who
        did it and from where. Append-only: nothing here can be edited or deleted.
      </InfoBanner>

      <FilterBar
        label="Filter the audit log"
        search={{
          value: search.text,
          onChange: search.setText,
          label: 'Search the audit log',
          placeholder: 'Search staff, customer or action',
        }}
        count={log.isPending ? null : `${total} ${total === 1 ? 'entry' : 'entries'}`}
        onClear={filtered ? clearFilters : undefined}
      >
        <FilterChips
          label="Filter by kind"
          options={AUDIT_KIND_CHIPS}
          value={kind ?? ''}
          onChange={(next) => url.set({ kind: next })}
        />
      </FilterBar>

      <Card className="audit__card" flush>
        {/* §1: the table scrolls inside its card; it never drops a column. */}
        <div className="audit__scroll">
          <table className="audit__table">
            {/*
              No count while pending — `total` defaults to 0 before the first page,
              and this caption told a screen reader "0 entries match" while the
              visible count line correctly showed nothing. Found on the console
              sibling by asserting on its loading DOM; the same line was here.
            */}
            <caption className="avo-sr-only">
              Audit log, newest first.
              {log.isPending
                ? ''
                : ` ${total} ${total === 1 ? 'entry matches' : 'entries match'} the current filter.`}
            </caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Who</th>
                <th scope="col">Action</th>
                <th scope="col">Detail</th>
                <th scope="col">Source</th>
              </tr>
            </thead>
            <tbody>
              {log.isPending ? (
                [0, 1, 2, 3, 4, 5].map((n) => (
                  <tr key={n}>
                    {[0, 1, 2, 3, 4].map((c) => (
                      <td key={c}>
                        <Skeleton width={`${85 - c * 8}%`} height={13} />
                      </td>
                    ))}
                  </tr>
                ))
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="audit__empty">
                    {query || kind ? (
                      <EmptyState
                        title={auditEmptyLine(query, kind, null)}
                        body="Search and the kind filter look at the whole log, not just this page."
                        action={{ label: 'Clear filters', onClick: clearFilters }}
                      />
                    ) : (
                      <EmptyState
                        title="Nothing recorded yet"
                        body="Charges, voids, rule changes and permission changes appear here as your team works."
                      />
                    )}
                  </td>
                </tr>
              ) : (
                rows.map((entry) => <AuditRow key={entry.id} entry={entry} timezone={timezone} />)
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {log.hasNextPage ? (
        <div className="audit__more">
          <Button
            variant="secondary"
            onClick={() => void log.fetchNextPage()}
            disabled={log.isFetchingNextPage}
          >
            {log.isFetchingNextPage ? 'Loading…' : `Show older (${total - rows.length} more)`}
          </Button>
        </div>
      ) : null}

      <p className="audit__foot">
        Kept for {retention} years and exportable as CSV from Reports. AVO platform staff actions
        on your salon appear here too, marked <b>Owner console</b>.
      </p>
    </div>
  );
}

function AuditRow({ entry, timezone }: { entry: AuditEntry; timezone: string | null }) {
  return (
    <tr data-platform={entry.isPlatformAction ? '' : undefined}>
      <td className="audit__when">
        {/*
          The machine-readable instant rides along with the human phrasing. A row
          read seven years later during a dispute should not depend on the reader
          reconstructing "Yesterday" from a screenshot.
        */}
        <time dateTime={entry.when} title={new Date(entry.when).toISOString()}>
          {whenLabel(entry.when, timezone)}
        </time>
      </td>
      <td>
        <div className="audit__who">{entry.who}</div>
        <div className="audit__role">{entry.role}</div>
      </td>
      <td>
        <Pill tone={KIND_TONE[entry.kind]}>{entry.action}</Pill>
      </td>
      <td className="audit__detail">{entry.detail}</td>
      <td className="audit__source">
        {/*
          "AVO platform staff actions on your salon appear here too, marked Owner
          console." `sourceLabel` is the server's own label — one place decides
          what the product calls a thing, and this log is read years later.
        */}
        {entry.isPlatformAction ? (
          <Pill tone="warn">{entry.sourceLabel}</Pill>
        ) : (
          entry.sourceLabel
        )}
      </td>
    </tr>
  );
}

export function ClockGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M10 6v4l2.5 1.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
