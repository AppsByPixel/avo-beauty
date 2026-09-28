// @vitest-environment jsdom

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * FOUR WRITES THAT COMMIT BEFORE THE CLIENT READS THE ANSWER
 * ═══════════════════════════════════════════════════════════════════════════
 * `POST …/no-show`, `POST …/cancel`, `POST …/complete` and
 * `PATCH /v1/…/orders/{tid}`. The first two move a customer's money; by the
 * time the response body is being read, the deposit has left the salon.
 *
 * All four used to dereference that body through `authedRequest<T>`, which is a
 * CAST and not a parse — `data.booking.status` on the three, `body.order` and
 * then `updated.status` on the fourth. A 200 without the key is a TypeError, and
 * the position it is thrown from is what makes this file worth having:
 *
 *   @tanstack/query-core's `Mutation#execute` awaits `onSuccess` INSIDE the try
 *   that guards `mutationFn`. A throw there is caught, `onError` runs, and
 *   `{ type: 'error' }` is dispatched — so the hook reports `isError` for a
 *   write the server committed, and the screen draws `WriteError`:
 *
 *       "Something went wrong on our side. The deposit is still held."
 *
 *   The reassurance is the dangerous half. It is a confident, false sentence
 *   about a customer's money, and the action it invites is a SECOND refund. A
 *   crash is visibly broken and gets asked about; a false failure gets acted on.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SO THE SPECS BELOW DRIVE THE HOOKS AND RENDER `WriteError` THE WAY THE
 * SCREENS DO, RATHER THAN CALLING THE PARSERS
 * ═══════════════════════════════════════════════════════════════════════════
 * A parser test would pass whatever the hooks did with it. The subject here is
 * "after the server committed", so every spec actually resolves a mutation
 * through `useMutation` and reads the mutation state and the DOM that state
 * produces. `Screen` below is the two lines `Appointments.tsx` and
 * `ShopOrders.tsx` each write around these hooks, with their own reassurance
 * copy, so the strings asserted absent are the strings a merchant would read.
 *
 * FOUR PROPERTIES, IN THE ORDER THEY MATTER:
 *
 *   1. AN UNREADABLE BODY IS NOT A FAILURE. `isSuccess`, no `role="alert"`,
 *      and none of the four failure sentences anywhere in the document.
 *   2. AN UNREADABLE BODY DOES NOT PATCH. The cache keeps what it had —
 *      no `undefined` status spliced onto a row a merchant is looking at.
 *   3. THE INVALIDATION STILL FIRES, because it is the refetch that supplies
 *      the truth the patch was a guess at.
 *   4. A WELL-FORMED BODY IS UNCHANGED, byte for byte — the optimistic patch
 *      was not traded away to buy the safety.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { BookingSchema, ShopOrderSchema } from '@avo/types';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const authedRequest = vi.fn();
vi.mock('../auth/authedRequest.js', () => ({
  authedRequest: (...args: unknown[]) => authedRequest(...args),
}));
vi.mock('../auth/AuthProvider.js', () => ({ useSalonId: () => 'SAL-AMARA' }));

const { bookingKeys, useCancelBooking, useCompleteBooking, useMarkNoShow } =
  await import('./bookings.js');
const { orderKeys, useMoveOrder } = await import('./orders.js');
const { WriteError } = await import('../routes/sectionState.js');

type MerchantBooking = import('./bookings.js').MerchantBooking;
type MerchantShopOrder = import('./orders.js').MerchantShopOrder;
type OrderBoard = import('./orders.js').OrderBoard;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/* =============================================================== fixtures == */

const BOOKING_ID = 'BK-9d0c1f6a-2b44-4d1e-9f77-5a2e3c8b1d40';
const TRANSACTION_ID = 'TX-3233428';

/** The row as `GET /salons/{id}/bookings` serves it — joins and all. */
const ROW: MerchantBooking = {
  id: BOOKING_ID,
  memberId: 'MB-1a2b3c4d5e',
  guestName: null,
  guestPhone: null,
  artistId: 'AR-1a2b3c4d5e',
  branchId: 'BR-1a2b3c4d5e',
  serviceId: 'SV-1a2b3c4d5e',
  startsAt: '2026-09-17T10:00:00.000Z',
  endsAt: '2026-09-17T11:00:00.000Z',
  durationMin: 60,
  /** A DEPOSIT-BEARING ROW, which is what selects the dangerous reassurance. */
  depositFils: 5000,
  status: 'deposit_held',
  source: 'app',
  changeableUntil: '2026-09-17T09:00:00.000Z',
  noShowReturnDueAt: '2026-09-17T12:00:00.000Z',
  rescheduledCount: 0,
  calendarSyncState: 'synced',
  policy: null,
  settlement: null,
  branchAssumed: false,
  memberName: 'Dana Al-Sabah',
  memberPhone: '+96599124408',
  memberErased: false,
  memberTier: 'gold',
  artistName: 'Noura Al-Rashid',
  serviceName: 'Balayage',
};

/**
 * `serialiseBooking(row)` — the seventeen keys `BookingSchema` declares and NOT
 * ONE JOINED FIELD, which is the shape all three booking writes answer with.
 */
const WRITTEN_BOOKING: Record<string, unknown> = {
  id: BOOKING_ID,
  memberId: ROW.memberId,
  guestName: null,
  guestPhone: null,
  artistId: ROW.artistId,
  branchId: ROW.branchId,
  serviceId: ROW.serviceId,
  startsAt: ROW.startsAt,
  endsAt: ROW.endsAt,
  durationMin: 60,
  depositFils: 5000,
  status: 'no_show_returned',
  source: 'app',
  changeableUntil: ROW.changeableUntil,
  noShowReturnDueAt: ROW.noShowReturnDueAt,
  rescheduledCount: 0,
  calendarSyncState: 'synced',
  policy: null,
  settlement: null,
};

/** The board row — `serialiseShopOrder` plus the join `perms.shop` gates. */
const ORDER_ROW: MerchantShopOrder = {
  transactionId: TRANSACTION_ID,
  fulfilment: 'pickup',
  status: 'preparing',
  address: null,
  // A hand-built ShopOrder must say it: `.nullable()` is required on the wire (0060).
  pickupBranch: null,
  createdAt: '2026-09-17T09:30:00.000Z',
  readyAt: null,
  closedAt: null,
  memberName: 'Dana Al-Sabah',
  memberPhone: '+96599124408',
  memberErased: false,
  lines: [{ productId: 'PR-1', name: 'Argan oil', qty: 1, unitPriceFils: 4500, lineTotalFils: 4500 }],
  totalFils: 4500,
};

/** `serialiseShopOrder(row)` — the BARE `ShopOrder`, no join. */
const MOVED_ORDER: Record<string, unknown> = {
  transactionId: TRANSACTION_ID,
  fulfilment: 'pickup',
  status: 'ready',
  address: null,
  // A hand-built ShopOrder must say it: `.nullable()` is required on the wire (0060).
  pickupBranch: null,
  createdAt: ORDER_ROW.createdAt,
  readyAt: '2026-09-17T09:47:00.000Z',
  closedAt: null,
};

const LIST_KEY = bookingKeys.list('SAL-AMARA', null);
const STREAM_KEY = bookingKeys.stream('SAL-AMARA');
const BOARD_KEY = orderKeys.board('SAL-AMARA', null);

/* ================================================================ the rig == */

/**
 * THE TWO LINES EACH SCREEN WRITES AROUND THESE HOOKS.
 *
 * `Appointments.tsx` renders `{markError ? <WriteError error reassurance/> : null}`
 * with `held ? 'The deposit is still held.' : 'Nothing has changed.'`, and
 * `ShopOrders.tsx` renders `{move.isError ? <WriteError …/> : null}` with "The
 * status shown is still the real one." Reproduced rather than mocked so that
 * what these specs assert absent is the copy a merchant would actually read.
 */
function Screen({
  hook,
  vars,
  reassurance,
}: {
  hook: () => { mutate: (v: never) => void; isError: boolean; error: unknown };
  vars: Record<string, string>;
  reassurance: string;
}) {
  const m = hook();
  return (
    <div>
      <button type="button" onClick={() => m.mutate(vars as never)}>
        Go
      </button>
      {m.isError ? <WriteError error={m.error} reassurance={reassurance} /> : null}
    </div>
  );
}

interface Subject {
  /** What a merchant calls it. */
  name: string;
  hook: () => { mutate: (v: never) => void; isError: boolean; error: unknown };
  vars: Record<string, string>;
  reassurance: string;
  /** A 200 whose body the handler can read. */
  ok: Record<string, unknown>;
  /** The key the handler used to dereference without checking. */
  missingKey: string;
}

/**
 * THE FOUR. `complete` and `cancel` answer the same envelope as the no-show —
 * `{ booking }` — and the move answers `{ order }`; the key each handler reached
 * into is what `missingKey` names, and deleting it is the whole of the
 * malformed-body fixture.
 */
const SUBJECTS: Subject[] = [
  {
    name: 'no-show',
    hook: useMarkNoShow as unknown as Subject['hook'],
    vars: { bookingId: BOOKING_ID, idempotencyKey: 'K-first' },
    reassurance: 'The deposit is still held.',
    ok: {
      booking: WRITTEN_BOOKING,
      refundedFils: 5000,
      balanceAfterFils: 29500,
      transactionId: 'TX-3233428',
    },
    missingKey: 'booking',
  },
  {
    name: 'cancel',
    hook: useCancelBooking as unknown as Subject['hook'],
    vars: { bookingId: BOOKING_ID },
    reassurance: 'The deposit is still held.',
    ok: {
      booking: { ...WRITTEN_BOOKING, status: 'cancelled' },
      refundedFils: 5000,
      balanceAfterFils: 29500,
      transactionId: 'TX-3233429',
    },
    missingKey: 'booking',
  },
  {
    name: 'complete',
    hook: useCompleteBooking as unknown as Subject['hook'],
    vars: { bookingId: BOOKING_ID },
    reassurance: 'Nothing has changed.',
    ok: { booking: { ...WRITTEN_BOOKING, status: 'completed' } },
    missingKey: 'booking',
  },
  {
    name: 'order moved',
    hook: (() => useMoveOrder(null)) as unknown as Subject['hook'],
    vars: { transactionId: TRANSACTION_ID, status: 'ready' },
    reassurance: 'The status shown is still the real one.',
    ok: { order: MOVED_ORDER },
    missingKey: 'order',
  },
];

/** A seeded client holding every shape these writes can reach. */
function seededClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(LIST_KEY, { items: [ROW], nextCursor: null });
  client.setQueryData(STREAM_KEY, {
    pages: [{ items: [ROW], nextCursor: null }],
    pageParams: [null],
  });
  client.setQueryData<OrderBoard>(BOARD_KEY, {
    items: [ORDER_ROW],
    truncated: false,
    nextCursor: null,
  });
  return client;
}

/** Mount the screen, press the control, and wait for the write to settle. */
async function commit(subject: Subject, body: unknown): Promise<QueryClient> {
  authedRequest.mockResolvedValue(body);
  const client = seededClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  render(
    <Screen hook={subject.hook} vars={subject.vars} reassurance={subject.reassurance} />,
    { wrapper },
  );
  await act(async () => {
    screen.getByRole('button', { name: 'Go' }).click();
  });
  await waitFor(() => expect(authedRequest).toHaveBeenCalled());
  return client;
}

function listRow(client: QueryClient): MerchantBooking {
  return client.getQueryData<{ items: MerchantBooking[] }>(LIST_KEY)!.items[0]!;
}

function streamRow(client: QueryClient): MerchantBooking {
  return client.getQueryData<{ pages: { items: MerchantBooking[] }[] }>(STREAM_KEY)!
    .pages[0]!.items[0]!;
}

function boardRow(client: QueryClient): MerchantShopOrder {
  return client.getQueryData<OrderBoard>(BOARD_KEY)!.items[0]!;
}

/**
 * EVERY SENTENCE `WriteError` CAN PRODUCE, plus the two reassurances. Asserted
 * ABSENT rather than asserting some success string present: the failure mode is
 * a screen SAYING something it should not, so the spec has to be able to see any
 * of it, including a sentence added to `WriteError` later.
 */
const FAILURE_LANGUAGE = [
  'Something went wrong on our side',
  "We couldn't reach the workspace",
  'The deposit is still held',
  'Nothing has changed',
  'The status shown is still the real one',
];

/* ========================================== 1 · the body we cannot read === */

describe('a 200 the client cannot read is not a failed write', () => {
  describe.each(SUBJECTS)('$name', (subject) => {
    /** The 200 with the key the handler dereferenced simply absent. */
    const malformed = (): Record<string, unknown> => {
      const body = { ...subject.ok };
      delete body[subject.missingKey];
      return body;
    };

    it('does not throw, and the mutation does not report an error', async () => {
      const client = await commit(subject, malformed());
      // A throw from `onSuccess` would have been caught by `Mutation#execute`
      // and dispatched as `{ type: 'error' }`. Nothing here may do that.
      await waitFor(() => expect(client.isMutating()).toBe(0));
      expect(screen.queryByRole('alert')).toBeNull();
    });

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE ONE THAT MATTERS. The server committed; the refund has left.
     * ═══════════════════════════════════════════════════════════════════════
     * A merchant shown "Something went wrong on our side. The deposit is still
     * held." will retry a completed refund — which is materially worse than the
     * crash this replaces, because a crash is visibly broken and a confident
     * wrong sentence is acted on.
     */
    it('renders NOTHING that says the write failed', async () => {
      await commit(subject, malformed());
      await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
      const text = document.body.textContent ?? '';
      for (const sentence of FAILURE_LANGUAGE) {
        expect(text).not.toContain(sentence);
      }
    });

    it('leaves the cache exactly as it found it — no half-read row', async () => {
      const client = await commit(subject, malformed());
      if (subject.name === 'order moved') {
        // Not patched to `undefined`, and the join the PATCH never carries is
        // still on the row.
        expect(boardRow(client)).toEqual(ORDER_ROW);
      } else {
        expect(listRow(client)).toEqual(ROW);
        expect(streamRow(client)).toEqual(ROW);
      }
    });

    /**
     * THE REFETCH IS WHAT SUPPLIES THE TRUTH THE PATCH WAS A GUESS AT, so
     * dropping the patch is only honest while the invalidation survives. For the
     * move this is also the sharper assertion: `writeRow`'s predicate
     * deliberately EXCLUDES the board being looked at, so the board's own key
     * going stale is reachable on the unreadable path and on no other.
     */
    it('still marks the list stale, so the refetch answers', async () => {
      const client = await commit(subject, malformed());
      const key = subject.name === 'order moved' ? BOARD_KEY : LIST_KEY;
      await waitFor(() => {
        expect(client.getQueryState(key)?.isInvalidated).toBe(true);
      });
    });
  });
});

/* ============================== 2 · the well-formed path, pinned as it was = */

describe('a well-formed body still patches optimistically, exactly as before', () => {
  it('flips the booking row and keeps the customer on it', async () => {
    const client = await commit(SUBJECTS[0]!, SUBJECTS[0]!.ok);
    await waitFor(() => expect(listRow(client).status).toBe('no_show_returned'));
    // The three fields the response does not carry. A whole-object splice, or a
    // parse that returned the response as the ROW, would blank every one.
    expect(listRow(client).memberName).toBe('Dana Al-Sabah');
    expect(listRow(client).serviceName).toBe('Balayage');
    expect(listRow(client).artistName).toBe('Noura Al-Rashid');
    // #1 — the figure a disputed no-show is argued over is still an integer.
    expect(listRow(client).depositFils).toBe(5000);
  });

  it('flips a cancelled row and a completed row to their own statuses', async () => {
    const cancelled = await commit(SUBJECTS[1]!, SUBJECTS[1]!.ok);
    await waitFor(() => expect(listRow(cancelled).status).toBe('cancelled'));
    cleanup();
    vi.clearAllMocks();
    const completed = await commit(SUBJECTS[2]!, SUBJECTS[2]!.ok);
    await waitFor(() => expect(listRow(completed).status).toBe('completed'));
  });

  /**
   * THE MERGE, NOT A REPLACE. The PATCH answers a bare `ShopOrder`, so the row
   * must take the server's `status` and `readyAt` while keeping the three joined
   * fields the GET supplied. A straight replace blanked the customer column once
   * already (the hook's own header).
   */
  it('merges the moved order and keeps the join the PATCH does not carry', async () => {
    const client = await commit(SUBJECTS[3]!, SUBJECTS[3]!.ok);
    await waitFor(() => expect(boardRow(client).status).toBe('ready'));
    expect(boardRow(client).readyAt).toBe('2026-09-17T09:47:00.000Z');
    expect(boardRow(client).memberName).toBe('Dana Al-Sabah');
    expect(boardRow(client).memberPhone).toBe('+96599124408');
    expect(boardRow(client).memberErased).toBe(false);
  });

  /**
   * THE PREFIX TRAP THE `patchBookingStatus` HEADER DESCRIBES, STILL HELD.
   * `setQueriesData({ queryKey: bookingKeys.all })` matches BY PREFIX and hands
   * its updater the infinite query's `{ pages, pageParams }` as well as the
   * list's `{ items }`. The parse sits in the same expression as that updater,
   * so a change to one is a chance to break the other.
   */
  it('patches the infinite-query entry under the same prefix without corrupting it', async () => {
    const client = await commit(SUBJECTS[0]!, SUBJECTS[0]!.ok);
    await waitFor(() => expect(streamRow(client).status).toBe('no_show_returned'));
    const cached = client.getQueryData<{
      pages: { items: MerchantBooking[]; nextCursor: string | null }[];
      pageParams: unknown[];
    }>(STREAM_KEY)!;
    // Still an infinite-query entry, and still the same envelope.
    expect(cached.pages).toHaveLength(1);
    expect(cached.pageParams).toEqual([null]);
    expect(cached.pages[0]!.nextCursor).toBeNull();
    expect(streamRow(client).memberName).toBe('Dana Al-Sabah');
  });
});

/* ================= 3 · every required key, so a later field is covered === */

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TABLE IS DERIVED FROM THE SCHEMA, NOT FROM THE FIXTURE
 * ═══════════════════════════════════════════════════════════════════════════
 * `Object.keys(BookingSchema.shape)` is the list trunk maintains, so a field
 * added to `packages/types` later arrives in this table without anyone editing
 * it — and the first spec below fails loudly if the fixture has not kept up,
 * which is the failure a fixture-derived table would have hidden.
 *
 * WHAT IS ASSERTED IS THE HOOK'S BEHAVIOUR AND NOT THE PARSER'S. Each case
 * commits a real mutation whose body is missing one key and asserts the row is
 * untouched — losing the optimistic patch is the correct, honest degradation,
 * and it is what the whole slice is for.
 */
describe('the required keys of a booking, one missing at a time', () => {
  it('the fixture itself is a booking, so a failure below is about the key', () => {
    expect(BookingSchema.safeParse(WRITTEN_BOOKING).success).toBe(true);
  });

  it.each(Object.keys(BookingSchema.shape))(
    'a body whose booking is missing %s loses the patch and keeps the row',
    async (key) => {
      const booking = { ...WRITTEN_BOOKING };
      delete booking[key];
      // Stated here so a key that turns out to be optional reads as that,
      // rather than as the hook having failed to protect the row.
      expect(BookingSchema.safeParse(booking).success).toBe(false);

      const client = await commit(SUBJECTS[0]!, { ...SUBJECTS[0]!.ok, booking });
      expect(listRow(client)).toEqual(ROW);
      expect(streamRow(client)).toEqual(ROW);
      expect(screen.queryByRole('alert')).toBeNull();
    },
  );
});

describe('the required keys of a shop order, one missing at a time', () => {
  it('the fixture itself is a shop order', () => {
    expect(ShopOrderSchema.safeParse(MOVED_ORDER).success).toBe(true);
  });

  it.each(Object.keys(ShopOrderSchema.shape))(
    'a body whose order is missing %s loses the patch and keeps the row',
    async (key) => {
      const order = { ...MOVED_ORDER };
      delete order[key];
      expect(ShopOrderSchema.safeParse(order).success).toBe(false);

      const client = await commit(SUBJECTS[3]!, { order });
      expect(boardRow(client)).toEqual(ORDER_ROW);
      expect(screen.queryByRole('alert')).toBeNull();
    },
  );
});

/* ============================ 4 · the envelope, and a genuinely failed write = */

describe('the bodies that are not objects at all', () => {
  /**
   * A 200 WITH A BODY OF `null` IS THE CASE THAT THROWS BEFORE ANY SCHEMA IS
   * CONSULTED — `response.booking` on `null` is the TypeError, not the parse.
   * `typeof null === 'object'`, so it has to be excluded by name.
   */
  it.each(SUBJECTS)('$name survives a null body', async (subject) => {
    const client = await commit(subject, null);
    await waitFor(() => expect(client.isMutating()).toBe(0));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.body.textContent ?? '').not.toContain('Something went wrong');
  });

  it.each(SUBJECTS)('$name survives a body that is a string', async (subject) => {
    const client = await commit(subject, 'ok');
    await waitFor(() => expect(client.isMutating()).toBe(0));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  /**
   * AND THE NEGATIVE THAT KEEPS THE REST HONEST: a write the server actually
   * REFUSED must still reach the screen as a refusal, with the server's own
   * sentence. A fix that made every outcome look like success would pass every
   * spec above and be far worse than the bug.
   */
  it.each(SUBJECTS)('$name still renders a real refusal', async (subject) => {
    const { ApiError } = await import('./client.js');
    authedRequest.mockRejectedValue(
      new ApiError('That appointment has not started yet, so it cannot be marked as a no-show.', {
        status: 409,
        code: 'appointment_not_started',
      }),
    );
    const client = seededClient();
    render(
      <Screen hook={subject.hook} vars={subject.vars} reassurance={subject.reassurance} />,
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      },
    );
    await act(async () => {
      screen.getByRole('button', { name: 'Go' }).click();
    });
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeNull());
    // Rendered verbatim — a 409 is the server explaining itself, not a failure
    // this client should paraphrase.
    expect(screen.getByRole('alert').textContent).toContain(
      'That appointment has not started yet',
    );
    expect(screen.getByRole('alert').textContent).toContain(subject.reassurance);
  });
});
