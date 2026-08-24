import { useState } from 'react';
import { Button, Pill, Segmented, Skeleton } from '@avo/ui';
import { useSetTicketStatus, useTicketQueue, type QueueFilter, type QueueTicket } from '../../api/support.js';
import { SectionError, WriteError } from '../sectionState.js';

/**
 * Policies → Support & contact → the ticket queue.
 *
 * THE CONSOLE SEES EVERY QUEUE, and that is a property of the principal rather
 * than of the filter below. `queueScope` in api/src/routes/support.ts forces
 * `salon_id = hers AND route = 'salon'` onto a staff principal and REFUSES
 * `?route=avo` outright — 403, not a narrowed result, because narrowing in silence
 * would let a merchant believe she had seen the whole queue. A platform admin gets
 * no forced predicate, so the Salon/AVO filter here is a real filter.
 *
 * WHICH MAKES THIS COMPONENT CONSOLE-ONLY BY CONSTRUCTION, not by convention. The
 * merchant dashboard is owed the same queue eventually and must NOT reuse this: the
 * one control it offers is the exact call that surface is refused for. Two
 * audiences, one endpoint, deliberately different affordances — and the note is
 * here because a shared component is the obvious next move and the wrong one.
 *
 * NO "CLOSED BY" COLUMN, AND NOTHING WAS OMITTED TO ACHIEVE THAT. `support_ticket`
 * has no `closed_by` and no `closed_at`, and `PATCH …/{id}` writes no audit row —
 * deliberately for the audit part, since a customer's complaint about a merchant
 * does not belong in a log that merchant can read, but the missing column is a gap
 * Lane A reported rather than invented. So "who closed this" is unanswerable today.
 * The design draws no actor either: its row is `id · member · topic · ref · at`
 * and one toggle. Checked before building rather than discovered after.
 *
 * FIRST PAGE ONLY. `GET /v1/support/tickets` pages by cursor (50 default, 100 max)
 * and returns `nextCursor`. The count in the heading is `total` — the whole
 * filtered set, not the rows on screen — so a busy day reads as itself rather than
 * as exactly the page size. Where more exists, the panel says so instead of
 * implying the page is the queue.
 */
export function SupportQueue() {
  const [filter, setFilter] = useState<QueueFilter>({ route: '', status: 'open' });
  const queue = useTicketQueue(filter);
  const setStatus = useSetTicketStatus();

  return (
    <div className="support__queue">
      <div className="support__queuehead">
        {/*
          The count is withheld until there IS one. `total ?? 0` would announce an
          empty queue the panel is not painting, which is the class this build keeps
          finding — and tsc caught the second half of it here: keyed on `isPending`
          alone, an ERRORED queue also reaches this line, so a failed read would
          have announced "Messages · 0" above its own error block. Keyed on the data
          instead, which covers both.
        */}
        <span className="avo-label">
          {queue.data ? `Messages · ${queue.data.total}` : 'Messages'}
        </span>
        <span className="support__note">
          Every message a customer sends from Contact us. AVO answers its own queue; a
          salon-routed message is the salon&apos;s to answer.
        </span>
      </div>

      <div className="support__queuefilters">
        <Segmented
          label="Queue"
          value={filter.route}
          options={[
            { value: '', label: 'All' },
            { value: 'salon', label: 'Salon' },
            { value: 'avo', label: 'AVO' },
          ]}
          onChange={(route) => setFilter((f) => ({ ...f, route }))}
        />
        <Segmented
          label="Status"
          value={filter.status}
          options={[
            { value: 'open', label: 'Open' },
            { value: 'closed', label: 'Answered' },
            { value: '', label: 'Both' },
          ]}
          onChange={(status) => setFilter((f) => ({ ...f, status }))}
        />
      </div>

      {queue.isError ? (
        <SectionError
          error={queue.error}
          forbiddenTitle="You don't have access to the support queue"
          failedTitle="Couldn't load the support queue"
          onRetry={() => void queue.refetch()}
          retrying={queue.isFetching}
        />
      ) : queue.isPending ? (
        <div className="support__tickets">
          <Skeleton height={54} />
          <Skeleton height={54} />
        </div>
      ) : queue.data.items.length === 0 ? (
        /*
         * THE EMPTY STATE NAMES THE FILTER, because "no messages" is a different
         * claim from "no messages matching Open + AVO" and only one of them is
         * true. An unfiltered empty queue is genuinely good news and says so; a
         * filtered one points at the filter rather than letting an admin conclude
         * the queue is broken.
         */
        <p className="support__empty">
          {filter.route === '' && filter.status === ''
            ? 'No messages yet. Nothing has been sent from Contact us.'
            : `No messages match ${describeFilter(filter)}.`}
        </p>
      ) : (
        <>
          <ul className="support__tickets">
            {queue.data.items.map((ticket) => (
              <TicketRow
                key={ticket.id}
                ticket={ticket}
                onToggle={() =>
                  setStatus.mutate({
                    id: ticket.id,
                    status: ticket.status === 'open' ? 'closed' : 'open',
                  })
                }
                busy={setStatus.isPending}
              />
            ))}
          </ul>
          {queue.data.nextCursor !== null ? (
            /*
             * SAYS SO RATHER THAN PAGING. A "Load more" button is a second slice —
             * the cursor is opaque and the honest thing meanwhile is to not let the
             * page masquerade as the queue. `total` above is already the real
             * number, so the two together are truthful: this many exist, these are
             * the newest.
             */
            <p className="support__more">
              Showing the {queue.data.items.length} newest of {queue.data.total}.
            </p>
          ) : null}
        </>
      )}

      {setStatus.isError ? (
        <WriteError error={setStatus.error} reassurance="The message is unchanged." />
      ) : null}
    </div>
  );
}

function describeFilter(filter: QueueFilter): string {
  const parts = [
    filter.status === 'open' ? 'Open' : filter.status === 'closed' ? 'Answered' : null,
    filter.route === 'salon' ? 'Salon' : filter.route === 'avo' ? 'AVO' : null,
  ].filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join(' + ') : 'this filter';
}

/**
 * One message.
 *
 * THE SUBJECT IS `topic.en`, JOINED BY THE API AND NOT SNAPSHOTTED — the opposite
 * of `route` on the same row, and the asymmetry is the point. A route is a DECISION
 * about the ticket and is frozen at insert, so a rerouted topic never moves a
 * dispute that is already open. A label is WORDING, so fixing a typo or adding the
 * Arabic fixes it on every ticket. Without the join a retired topic's tickets would
 * render a bare slug — `visit` — which is the dangling reference the soft delete
 * exists to avoid, moved one layer up into the UI.
 *
 * THE ROUTE PILL USES THE SAME TWO TONES AS THE TOPIC LIST ABOVE, and deliberately
 * not the design's. The prototype paints a salon-routed row in the warn colours
 * (#F6F1E4 / #8a6d3b) purely to tell the two apart; on this panel the identical
 * fact is already shown by the Salon/AVO control fifty pixels up, and giving it a
 * second colour coding in the same card would read as a warning about the message
 * rather than as its queue. `brand` for AVO, `neutral` for Salon, both halves.
 *
 * `Pill` and not `Chip`: the queue is where a route is OBSERVED. It is changed on
 * the topic, which is the only place #11 lets it be changed at all.
 */
function TicketRow({
  ticket,
  onToggle,
  busy,
}: {
  ticket: QueueTicket;
  onToggle: () => void;
  busy: boolean;
}) {
  const open = ticket.status === 'open';
  return (
    <li className="support__ticket" data-status={ticket.status}>
      <Pill tone={ticket.route === 'avo' ? 'brand' : 'neutral'}>
        {ticket.route === 'avo' ? 'AVO' : 'Salon'}
      </Pill>
      <div className="support__ticketbody">
        <p className="support__ticketmsg">{ticket.message}</p>
        {/*
          The design's meta line: id · member · topic · ref · at, blanks dropped.
          `ticket.id` is first and verbatim because rule 4 makes it "the only handle
          the customer has" — she quotes SUP-48263 and an admin has to find it.
        */}
        <p className="support__ticketmeta">
          {[
            ticket.id,
            ticket.member,
            ticket.topic.en,
            ticket.ref,
            ticket.at.replace('T', ' ').slice(0, 16),
          ]
            .filter((part) => part !== '')
            .join(' · ')}
        </p>
      </div>
      <Button variant="quiet" onClick={onToggle} disabled={busy}>
        {open ? 'Mark answered' : 'Reopen'}
      </Button>
    </li>
  );
}
