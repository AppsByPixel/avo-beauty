import {
  countedPage,
  SupportConfigSchema,
  SupportTicketSchema,
  type SupportConfig,
  type SupportTicket,
  type SupportTopic,
} from '@avo/types';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { authedRequest } from '../auth/authedRequest.js';

/**
 * Owner console → Policies → Support & contact, and the ticket queue under it.
 *
 * EIGHT ENDPOINTS ACROSS TWO GUARDS, read out of `api/src/routes/support.ts`
 * rather than off api-contract.md. The distinction earned its own decision entry:
 * the contract is a specification and the routes are the inventory, and four
 * successive readings of the contract's block miscounted this very family.
 *
 *   GET    /v1/platform/support               requirePrincipal   support.ts:443
 *   PATCH  /v1/platform/support/channels      policies           support.ts:514
 *   POST   /v1/platform/support/topics        policies           support.ts:646
 *   PATCH  /v1/platform/support/topics/:id    policies           support.ts:777
 *   DELETE /v1/platform/support/topics/:id    policies           support.ts:922
 *   POST   /v1/support/tickets                requireMember      support.ts:1023
 *   GET    /v1/support/tickets                requireQueueReader support.ts:1162
 *   PATCH  /v1/support/tickets/:id            requireQueueReader support.ts:1244
 *
 * `POST /v1/support/tickets` is the WALLET's form. It is listed so the count is
 * the real one; nothing here calls it.
 *
 * THE READ IS UNGATED AND THE WRITES ARE `policies`, which is exactly the
 * ungated-read/gated-write shape `routes/sectionState.tsx`'s ledger says needs a
 * courtesy gate — and it does NOT need one here, for a reason worth stating
 * because the ledger's rule would suggest otherwise. That rule exists to stop a
 * screen handing someone an editor whose every save refuses. It cannot happen on
 * this panel: the only route that renders it is `/console/policies`, and reaching
 * that route already means holding `policies`, which is the same permission the
 * four writes check. Lane A regated deliberately so that "an admin who can open
 * the panel can edit the panel, so there is no screen carrying a control that
 * only 403s." Verified by calling the read directly as an analyst with
 * `perm_policies` off: 200 on the read, 403 on the policy draft that gates the
 * route. The gate is the route, not a `session.perms` check duplicated here.
 *
 * NO PUBLISH STEP, EVER. `design/README.md` and api-contract.md both: support
 * config saves immediately, "unlike legal documents there is no draft/publish
 * step, because nothing here is a legal representation". The policy panel
 * directly above has draft/publish/version-stamping precisely because it IS one.
 * A Publish button here for visual symmetry would be a false claim about legal
 * status, so every mutation below writes on commit and invalidates.
 *
 * NO `retry` ON ANY HOOK — `api/retryPolicy.ts` is the one policy and `main.tsx`
 * installs it as the default. See the note in `api/platform.ts`.
 */
export const supportKeys = {
  /*
   * NOT under `['platform', 'policies', …]`, even though the panel renders inside
   * the Policies screen. Publish and discard invalidate that whole prefix, and
   * support has no publish step at all — sweeping it up in a policy publish would
   * refetch it for no reason and, worse, imply the two move together.
   */
  config: ['support', 'config'] as const,
  tickets: (route: string, status: string) => ['support', 'tickets', route, status] as const,
};

/* ------------------------------------------------------------ the config -- */

/**
 * The channels and the ACTIVE topic list, in render order.
 *
 * `topics` IS THE EDITABLE SET, and that is a property of the soft delete rather
 * than a coincidence. `DELETE …/topics/:id` sets `active = false`, and this read
 * filters `active = true` — so a retired topic leaves this response and the list
 * on screen is exactly the list the four writes operate on.
 *
 * THE COROLLARY IS A REAL LIMIT: there is no un-retire. Nothing serves the
 * inactive rows, so a topic retired by mistake cannot be brought back from this
 * console — the replacement is a new topic with a new id. The API's own refusal
 * says as much when you PATCH a retired one ("Add a new one instead"), so the
 * behaviour is deliberate on both sides; it is recorded here because a reader
 * looking for the un-retire hook should find the reason it is absent rather than
 * conclude it was forgotten.
 *
 * `SupportConfigSchema` from @avo/types — the same schema the wallet parses this
 * endpoint with, so a dropped field fails here instead of rendering an empty
 * channel as a configured one.
 */
export function useSupportConfig(): UseQueryResult<SupportConfig> {
  return useQuery({
    queryKey: supportKeys.config,
    queryFn: async ({ signal }) => {
      const raw = await authedRequest<unknown>('owner', '/v1/platform/support', { signal });
      return SupportConfigSchema.parse(raw);
    },
  });
}

/** The six channel fields, all optional — the PATCH takes any subset. */
export interface ChannelPatch {
  whatsapp?: string;
  email?: string;
  hoursEn?: string;
  hoursAr?: string;
  replyEn?: string;
  replyAr?: string;
}

/**
 * One channel field at a time, committed on blur.
 *
 * NOT KEYED FOR IDEMPOTENCY, and the API says why in those words: every field is
 * an absolute value, so a replay writes the same row and there is nothing to
 * prevent twice. What a retry can do is clobber a concurrent edit, and the
 * handler's `FOR UPDATE` makes two edits serial rather than interleaved.
 */
export function useUpdateChannels(): UseMutationResult<unknown, unknown, ChannelPatch> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) =>
      authedRequest<unknown>('owner', '/v1/platform/support/channels', {
        method: 'PATCH',
        body,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: supportKeys.config });
    },
  });
}

/* ------------------------------------------------------------- the topics -- */

/**
 * `{ en }` only. The API mints the id and appends at the end of the active list;
 * `ar` and `route` are set afterwards through the PATCH, which is the design's
 * flow too — its "+ Add topic" field takes English and nothing else.
 */
export function useAddTopic(): UseMutationResult<unknown, unknown, { en: string }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) =>
      authedRequest<unknown>('owner', '/v1/platform/support/topics', { method: 'POST', body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: supportKeys.config });
    },
  });
}

export interface TopicPatch {
  id: string;
  en?: string;
  ar?: string;
  route?: 'salon' | 'avo';
  /**
   * A DENSE INDEX into the active list, not a rank — and the reorder arrows are
   * the only caller, because there is no seventh endpoint behind them.
   *
   * THE MOVE IS A SHIFT, NOT A SWAP. The API splices the topic out of the active
   * list and back in at `min(order, length - 1)`, then rewrites every position, so
   * the list comes back `0…n-1` with no gaps. Sending the fifth topic to index 0
   * pushes the other four down by one; it does not trade places with the first.
   * Clamped server-side, so an index past the end lands last rather than erroring
   * — which is what lets the arrows send `index ± 1` without bounds-checking
   * against a list they might have re-read since.
   */
  order?: number;
}

/**
 * Label, route or position — the API takes any subset of the four and refuses an
 * unknown key by name.
 *
 * `en` IS REQUIRED AND `ar` IS BLANKABLE, which is the API's asymmetry and the
 * right one: "not yet translated" is a real state that the wallet falls back
 * through, and a console that refused an empty Arabic field would make the only
 * way to clear a wrong translation a database edit.
 *
 * A ROUTE CHANGE DOES NOT MOVE THE TICKETS ALREADY FILED. `support_ticket.route`
 * is snapshotted at insert — deliberately the opposite of the label, which is
 * joined — because "a ticket that silently changed queue afterwards would be a
 * customer's dispute changing hands with no record of it". So rerouting a topic
 * decides where the NEXT message goes and leaves the open ones where they are.
 * The panel says so at the control rather than leaving an admin to infer it.
 *
 * INVALIDATES RATHER THAN WRITING THE CACHE, which matters for `order`
 * specifically: the PATCH returns the one topic it changed and not the
 * re-densified list, so the authoritative order exists only on the server.
 * Recomputing the array here would be a second implementation of that splice, and
 * the two would disagree the first time the clamp fired.
 */
export function useUpdateTopic(): UseMutationResult<unknown, unknown, TopicPatch> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }) =>
      authedRequest<unknown>(
        'owner',
        `/v1/platform/support/topics/${encodeURIComponent(id)}`,
        { method: 'PATCH', body },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: supportKeys.config });
    },
  });
}

/**
 * RETIRE, not delete — `active = false`, and the database settled it rather than
 * a preference: `support_ticket.topic_id` references the topic
 * `onDelete: 'restrict'`, so a hard delete of anything anyone has written under
 * fails at the foreign key. A ticket whose topic vanished is a dispute nobody can
 * say what it was about.
 *
 * TWO REFUSALS THE PANEL MUST SURFACE RATHER THAN PRE-EMPT, both 409 with a
 * server-authored sentence that names the fix:
 *
 *   last_topic     "This is the only topic left. The Contact us form needs at
 *                   least one, so add its replacement first."
 *   topic_retired   on a PATCH to an already-retired row.
 *
 * `namedStateAnswer` in routes/sectionState.tsx renders both verbatim through
 * `WriteError`, which is why the retire control is a live button on the last
 * topic instead of a disabled one. A disabled control would have to explain
 * itself in copy this file would have to keep in sync with the API's; a live one
 * lets the API explain, which is also the only version that cannot drift. It is
 * NOT the dead-control case — the endpoint exists and the refusal is about state
 * the admin can change, which is the opposite of a button that can only ever 403.
 *
 * IDEMPOTENT: retiring a retired topic is a 204, not a 404.
 */
export function useRetireTopic(): UseMutationResult<unknown, unknown, { id: string }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id }) =>
      authedRequest<unknown>(
        'owner',
        `/v1/platform/support/topics/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: supportKeys.config });
    },
  });
}

/* ------------------------------------------------------------ the tickets -- */

/**
 * A queue row is just `SupportTicket` now.
 *
 * `salonId` and the joined `topic: { en, ar }` are declared in the trunk schema —
 * `bd5fa99` and `1feb89c` — so `SupportTicketSchema.parse()` yields both and there
 * is nothing left for this module to read beside it. The local `QueueTicket`
 * interface and its `parseTicket` shim are gone rather than kept as a
 * belt-and-braces layer: `salonId` is `NOT NULL` in the schema and non-nullable in
 * the contract, and the shim widened it to `string | null`, so keeping it would
 * have been a workaround contradicting the fix it asked for. That is what turned
 * dev red.
 */
export interface TicketPage {
  items: SupportTicket[];
  total: number;
  nextCursor: string | null;
}

export interface QueueFilter {
  /** '' means every queue. A platform admin may ask for either; a merchant may not. */
  route: '' | 'salon' | 'avo';
  status: '' | 'open' | 'closed';
}

/**
 * THE CONSOLE GETS THE WHOLE QUEUE, and that is a property of the principal
 * rather than of this query string.
 *
 * `queueScope` in support.ts forces `salon_id = hers AND route = 'salon'` onto a
 * STAFF principal and REFUSES `?route=avo` and `?salon=<someone else>` outright —
 * 403, not a narrowed result, because silently narrowing would tell a merchant she
 * had seen the whole queue. A platform admin gets no forced predicate at all, so
 * `route` and `status` here are genuine optional filters.
 *
 * WHICH MAKES THIS HOOK CONSOLE-ONLY BY CONSTRUCTION. The merchant dashboard owes
 * its staff the same queue eventually, and it must not reuse the route filter
 * below: the one control this panel offers is the one call that surface is refused
 * for. Two audiences, one endpoint, deliberately different affordances.
 *
 * PAGED BY CURSOR, and only the first page is fetched here. `total` is the count
 * of the whole filtered set, not of `items` — the design's "N open" note is a
 * count of the queue and not of the rows on screen, and conflating them would
 * under-report a busy day as exactly the page size.
 */
export function useTicketQueue(filter: QueueFilter): UseQueryResult<TicketPage> {
  return useQuery({
    queryKey: supportKeys.tickets(filter.route, filter.status),
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams();
      if (filter.route !== '') params.set('route', filter.route);
      if (filter.status !== '') params.set('status', filter.status);
      const qs = params.toString();
      const raw = await authedRequest<unknown>(
        'owner',
        `/v1/support/tickets${qs === '' ? '' : `?${qs}`}`,
        { signal },
      );
      /*
       * `countedPage` FROM TRUNK, NOT A HAND-PARSED ENVELOPE — and swapping to it
       * removed a fabricated zero this module was carrying. The envelope used to
       * be read field by field, and `total` came out as
       * `typeof v['total'] === 'number' ? v['total'] : 0`: an API that stopped
       * sending the count would have made the queue heading render "Messages · 0"
       * over a list of real messages, silently. Exactly the premature-zero class
       * the census pins the pending states against, arriving through a defensive
       * default instead of through a loading state.
       *
       * The schema refuses the response instead, which is the louder and correct
       * failure — and it is a `countedPage` rather than a `paginated` precisely so
       * that a missing `total` cannot be tolerated: trunk split the two helpers so
       * "a page with a count and a page without are different shapes".
       */
      return countedPage(SupportTicketSchema).parse(raw);
    },
  });
}

/**
 * Close or reopen. `{ status }` and nothing else is editable.
 *
 * NOBODY IS RECORDED AS HAVING DONE IT. `support_ticket` has no `closed_by` and no
 * `closed_at`, and the handler writes no audit row — deliberately for the audit
 * part, since a customer's complaint about a merchant does not belong in a log
 * that merchant can read, but the missing column is a GAP that Lane A reported
 * rather than invented. So "who closed this" is unanswerable today.
 *
 * THE PANEL THEREFORE DRAWS NO "closed by" ANYWHERE, and the design agrees: its
 * inbox row is `id · member · topic · ref · at` and a Mark answered / Reopen
 * button, with no actor column. Nothing had to be left out to keep this honest.
 *
 * IDEMPOTENT — closing a closed ticket returns it unchanged, which is the same
 * answer rule 5 gives the customer's double-tapped Send.
 */
export function useSetTicketStatus(): UseMutationResult<
  unknown,
  unknown,
  { id: string; status: 'open' | 'closed' }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }) =>
      authedRequest<unknown>('owner', `/v1/support/tickets/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: { status },
      }),
    onSuccess: () => {
      /*
       * The whole ticket prefix, not one filter's key: closing a ticket moves it
       * between the open and closed views and changes `total` on both, so the
       * filter the admin is not looking at is exactly the one that would go stale.
       */
      void queryClient.invalidateQueries({ queryKey: ['support', 'tickets'] });
    },
  });
}

export type { SupportTopic };
