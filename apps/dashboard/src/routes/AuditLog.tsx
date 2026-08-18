import { useEffect, useState } from 'react';
import { Button, Card, Chip, EmptyState, InfoBanner, Pill, Skeleton, type PillTone } from '@avo/ui';
import { AUDIT_KINDS, useAuditLog, type AuditEntry, type AuditKind } from '../api/audit.js';
import { SectionError } from './sectionState.js';

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

const KIND_LABEL: Record<AuditKind, string> = {
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
const KIND_TONE: Record<AuditKind, PillTone> = {
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
function whenLabel(iso: string): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  if (at.toDateString() === today.toDateString()) return `Today · ${time}`;
  if (at.toDateString() === yesterday.toDateString()) return `Yesterday · ${time}`;
  return `${at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · ${time}`;
}

export function AuditLog() {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<AuditKind | null>(null);

  // Debounced: the search box hits the API, and a request per keystroke would
  // put a LIKE over a years-deep table on every letter.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const log = useAuditLog({ q: query, kind });

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

      <div className="audit__controls">
        <input
          className="avo-input audit__search"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search staff, customer or action"
          aria-label="Search the audit log"
        />
        <div className="audit__filters" role="radiogroup" aria-label="Filter by kind">
          <Chip
            role="radio"
            className="avo-chip--outline"
            on={kind === null}
            label="All"
            onClick={() => setKind(null)}
          />
          {AUDIT_KINDS.map((k) => (
            <Chip
              key={k}
              role="radio"
              className="avo-chip--outline"
              on={kind === k}
              label={KIND_LABEL[k]}
              onClick={() => setKind(k)}
            />
          ))}
        </div>
        <span className="audit__count" role="status">
          {log.isPending ? '' : `${total} ${total === 1 ? 'entry' : 'entries'}`}
        </span>
      </div>

      <Card className="audit__card" flush>
        {/* §1: the table scrolls inside its card; it never drops a column. */}
        <div className="audit__scroll">
          <table className="audit__table">
            <caption className="avo-sr-only">
              Audit log, newest first. {total} entries match the current filter.
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
                      'No entries match that search.'
                    ) : (
                      <EmptyState
                        title="Nothing recorded yet"
                        body="Charges, voids, rule changes and permission changes appear here as your team works."
                      />
                    )}
                  </td>
                </tr>
              ) : (
                rows.map((entry) => <AuditRow key={entry.id} entry={entry} />)
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

function AuditRow({ entry }: { entry: AuditEntry }) {
  return (
    <tr data-platform={entry.isPlatformAction ? '' : undefined}>
      <td className="audit__when">
        {/*
          The machine-readable instant rides along with the human phrasing. A row
          read seven years later during a dispute should not depend on the reader
          reconstructing "Yesterday" from a screenshot.
        */}
        <time dateTime={entry.when} title={new Date(entry.when).toISOString()}>
          {whenLabel(entry.when)}
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

function ClockGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M10 6v4l2.5 1.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
