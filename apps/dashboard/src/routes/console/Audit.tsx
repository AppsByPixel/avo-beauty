import { useEffect, useState } from 'react';
import { Button, Card, Chip, EmptyState, InfoBanner, Pill, Skeleton } from '@avo/ui';
import {
  AUDIT_KINDS,
  usePlatformAuditLog,
  type AuditEntry,
  type AuditKind,
} from '../../api/audit.js';
import { ClockGlyph, KIND_LABEL, KIND_TONE, whenLabel } from '../AuditLog.js';
import { SectionError } from '../sectionState.js';

/**
 * Console → Audit. `GET /v1/platform/audit`, section `audit`.
 *
 * `AVO Owner Console.dc.html:978` § AUDIT — the same five columns, the same five
 * chips and the same search box as the merchant's log, which is the point:
 * `api/src/services/auditRead.ts` answers the filter grammar, the cursor rule and
 * the row shape ONCE for both reads, "an audit log is read years later by someone
 * reconciling a dispute, and the two screens would be compared". So this screen
 * imports the merchant screen's chips, tones and time phrasing rather than
 * restating them — one client answer to the same question.
 *
 * WHAT IS DIFFERENT IS THE SCOPING, and it is an absence: no salon filter is
 * applied, so the console sees every salon's rows AND the null-salon rows that
 * are the platform's own business — the controls change, an admin's sections
 * being edited. Plus the one filter the merchant's read can never express:
 * `?salon=platform`, AVO's own actions alone, surfaced as the "AVO actions only"
 * toggle beside the kind chips.
 *
 * THE KINDS ARE `AUDIT_KINDS` FROM api/audit.ts — the census discipline. One
 * client list, two screens, mirroring the server's own export to both routes; a
 * hand-written list here is how a fifth kind ships on the wire and silently never
 * gets a chip. The server refuses unknown kinds with `invalid_kind`, so the two
 * lists cannot drift quietly in the other direction either.
 *
 * NO COURTESY GATE — the read is `requirePlatform(req, 'audit')`, the refusal
 * arrives on its own with the server's sentence, and there is no write here.
 * There is no POST on either read and never will be: rows are written by the
 * handlers that cause them and UPDATE/DELETE are revoked at the role level.
 */
export function Audit() {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<AuditKind | null>(null);
  const [scope, setScope] = useState<'platform' | null>(null);

  // Debounced for the same reason the merchant screen debounces: the search hits
  // the API, and here the LIKE runs over EVERY salon's history, not one salon's.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const log = usePlatformAuditLog({ q: query, kind, scope });

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
  const filtered = query.trim() !== '' || kind !== null || scope !== null;

  return (
    <div className="audit">
      <InfoBanner icon={<ClockGlyph />}>
        Every money-touching or permission-changing action, on every surface, with who did it and
        from where. Entries are append-only and kept for {retention} years.
      </InfoBanner>

      <div className="audit__controls">
        <input
          className="avo-input audit__search"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search actor, salon or entity"
          aria-label="Search the platform audit log"
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
        {/*
          `?salon=platform` — the null-salon rows on their own. A second axis, so it
          is NOT in the kind radiogroup: "AVO's own money rows" is a legitimate
          crossing, and one radiogroup would make the two exclusive.
        */}
        <Chip
          className="avo-chip--outline audit__scope"
          on={scope === 'platform'}
          label="AVO actions only"
          onClick={() => setScope(scope === 'platform' ? null : 'platform')}
        />
        <span className="audit__count" role="status">
          {log.isPending ? '' : `${total} ${total === 1 ? 'entry' : 'entries'}`}
        </span>
      </div>

      <Card className="audit__card" flush>
        <div className="audit__scroll">
          <table className="audit__table">
            {/*
              THE COUNT LEAVES THE CAPTION WHILE PENDING. `total` is `?? 0` before
              the first page lands, so the caption read "0 entries match" to a
              screen reader while the visible count line correctly rendered
              nothing — the same fabricated zero the no-`0.000` rule bans on money,
              arriving through the accessibility tree instead of the paint. Caught
              by asserting on the loading DOM, not the markup.
            */}
            <caption className="avo-sr-only">
              Platform audit log, newest first, across every salon.
              {log.isPending ? '' : ` ${total} entries match the current filter.`}
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
                [0, 1, 2, 3, 4, 5, 6, 7].map((n) => (
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
                    {filtered ? (
                      /*
                       * NAMES WHAT IT FILTERED. "No entries match that search." is
                       * the design's sentence and stays for the search case; a
                       * kind or scope filter names itself, because "no entries"
                       * against an invisible filter reads as an empty log — and on
                       * THIS log, "the platform has never done anything" is a
                       * claim worth not making by accident.
                       */
                      emptyLine(query, kind, scope)
                    ) : (
                      <EmptyState
                        title="Nothing recorded yet"
                        body="Charges, voids, rule changes and permission changes across every salon appear here as they happen."
                      />
                    )}
                  </td>
                </tr>
              ) : (
                rows.map((entry) => <ConsoleAuditRow key={entry.id} entry={entry} />)
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
        Kept for {retention} years. Rows are written by the systems that act — nothing here can be
        added, edited or deleted, including by this console.
      </p>
    </div>
  );
}

/**
 * The empty line for a filtered read, naming every active filter.
 *
 * Composed rather than enumerated: the three axes cross (a search inside Money
 * inside AVO-only is one legitimate query), and eight hand-written variants would
 * be the hand-kept list this screen otherwise avoids.
 */
function emptyLine(query: string, kind: AuditKind | null, scope: 'platform' | null): string {
  const parts: string[] = [];
  if (kind) parts.push(`${KIND_LABEL[kind]} entries`);
  else parts.push('entries');
  if (scope) parts.push('from AVO platform actions');
  const what = parts.join(' ');
  if (query.trim() !== '') return `No ${what} match “${query.trim()}”.`;
  if (kind || scope) return `No ${what} yet.`;
  return 'No entries match that search.';
}

/**
 * The console's row. `Who` carries the salon id under the role when the row
 * belongs to a salon — the design's prototype writes "Manager · Amara", and the
 * wire carries `salonId`, not a salon NAME; there is no platform salons list yet
 * to resolve one against, so the id is rendered rather than a name invented or
 * the column silently dropped. An id is greppable and stable in a log read years
 * later; a guessed name is neither. Named in the lane report with the endpoint
 * that would fix it.
 */
function ConsoleAuditRow({ entry }: { entry: AuditEntry }) {
  return (
    <tr data-platform={entry.isPlatformAction ? '' : undefined}>
      <td className="audit__when">
        <time dateTime={entry.when} title={new Date(entry.when).toISOString()}>
          {whenLabel(entry.when)}
        </time>
      </td>
      <td>
        <div className="audit__who">{entry.who}</div>
        <div className="audit__role">
          {entry.role}
          {entry.salonId ? ` · ${entry.salonId}` : ''}
        </div>
      </td>
      <td>
        <Pill tone={KIND_TONE[entry.kind]}>{entry.action}</Pill>
      </td>
      <td className="audit__detail">{entry.detail}</td>
      <td className="audit__source">{entry.sourceLabel}</td>
    </tr>
  );
}
