import { useState } from 'react';
import type { OrderStatus } from '@avo/types';
import { Button, Card, Chip, EmptyState, InfoBanner, Pill, Skeleton, type PillTone } from '@avo/ui';
import {
  ORDER_STATUSES,
  useMoveOrder,
  useOrderBoard,
  type MerchantShopOrder,
} from '../api/orders.js';
import { SectionError, WriteError } from './sectionState.js';
import { whenLabel } from './AuditLog.js';

/**
 * Merchant → Shop → Orders. The fulfilment board.
 * `GET /v1/salons/{id}/orders` + `PATCH …/orders/{transactionId}`, `perms.shop`.
 *
 * NO COURTESY PERMISSION GATE, DELIBERATELY, and the ledger row is Shop's: both
 * the read and the write are `requireDashboardPerm(req, 'shop')`, so the refusal
 * arrives on the read and `SectionError` renders the server's own sentence
 * ("You don't have permission to see the shop. A manager can grant it."). Adding
 * a client check here would duplicate the server and drift from it.
 *
 * ===========================================================================
 * THIS IS THE FIRST MERCHANT SURFACE IN THE PRODUCT THAT SHOWS WHERE A CUSTOMER
 * LIVES, AND THE SCREEN IS SHAPED BY THAT RATHER THAN BY THE TABLE
 * ===========================================================================
 * Everything else behind `perms.shop` is a product catalogue: names, prices,
 * photos, and a units-sold report with no customer in it. This row carries her
 * name, her phone, her block/street/building and her coordinates. Two
 * consequences are written down here because they are not visible from the
 * markup:
 *
 *   WHO MAY SEE IT is now a privacy question and not only a permissions one.
 *   `perms.shop` is the right RELATIVE answer — better than `dashboard`, which
 *   would put an address behind the Overview permission, and better than
 *   `appointments`, which is a different section. It is not obviously the right
 *   ABSOLUTE answer, and the reason is structural rather than a matter of taste:
 *   `DECISIONS.md` § the reports mapping checked all nine permissions and found
 *   that NONE OF THEM IS A CUSTOMER-DATA PERMISSION, which is why `customers` is
 *   mapped to `team` as an admitted interim fit rather than a semantic one. This
 *   board is that gap a second time, with the address as the payload: a front-desk
 *   account granted `shop` so it can price the shelf would read every delivery
 *   customer's home. Latent rather than live — the seeded front desk holds
 *   `shop: false`, and both routes answer her 403, verified — but the direction is
 *   the point. Reported as a decision rather than resolved here; the gate is the
 *   API's and this lane does not move it. What this lane could do it did: the Team
 *   chip that grants `shop` now says what it opens (`api/staff.ts § PERMISSIONS`).
 *
 *   THE DESIGN BUNDLE HAS NO DELIVERY UI AT ALL. The shop was collection-only
 *   when it was drawn — `AVO Merchant Dashboard.dc.html:299` says "no delivery
 *   (phase 2)", the wallet's receipt says "Pickup", and there is no orders board
 *   anywhere in the bundle. So every pixel below is new. It borrows the
 *   Appointments board's vocabulary rather than inventing a second visual
 *   language: a real <table> in a Card, a sticky uppercase header, status Pills
 *   in the last column, secondary facts as small quiet lines under the primary
 *   one. Named in the lane report as uncovered-by-design rather than presented
 *   as transcribed.
 *
 * ---------------------------------------------------------------------------
 * THE SNAPSHOT, WHICH IS THE ONE THING THIS SCREEN MUST NOT GET WRONG
 *
 * `address` is what she typed WHEN SHE ORDERED. It is not a reference into her
 * address book and it does not track it: editing or deleting an address leaves
 * every past order exactly as it was, deliberately, so a delivered order stays
 * answerable months later. `ShopOrderSchema` in `@avo/types` calls it "the field
 * most likely to be misread".
 *
 * So the requirement on this surface is a NEGATIVE one, and negatives are the
 * kind of thing that gets built by accident: there is no link on the address, no
 * "view her addresses", no edit affordance, and nothing that would let a merchant
 * conclude she is looking at live data. The fact is stated ONCE, in the banner,
 * rather than as a caption under forty rows — a sentence repeated per row stops
 * being read, which is the failure mode `Shop.tsx § the photo hint` already
 * argues about the catalogue.
 *
 * COORDINATES ARE RENDERED AND NOT LINKED. A driver needs them, so withholding
 * them would be precious. But a map link would send a named customer's home
 * address to a third party from the merchant's browser on page view, which is
 * not a thing this screen gets to decide on her behalf — and it is a decision
 * about a data processor, not a layout. Printed as text, copyable, going nowhere.
 *
 * ---------------------------------------------------------------------------
 * WHERE AN ORDER IS GOING — THREE STATES, AND `address` DECIDES NONE OF THEM
 *
 * A NULL ADDRESS IS ORDINARY DATA IN BOTH OF THE TWO WAYS IT ARRIVES, and the
 * cell reads `fulfilment` to tell them apart. Reading `address` was correct for
 * exactly as long as it had one meaning.
 *
 *   delivery, address present   the snapshot. `AddressSnapshot` below.
 *   pickup, address null        she is collecting. `PRIOR-ART.md` § "Pickup is
 *                               not replaced. It is a fork." Both paths are live
 *                               in the app this model is taken from, and
 *                               delivery-based means delivery is available and
 *                               chosen — not that collection was removed. So the
 *                               cell says what is happening ("Collecting at the
 *                               salon") rather than reporting an absence with an
 *                               em dash or "No address". Rendering live data as
 *                               missing data is the premature-zero class with
 *                               the sign flipped.
 *   delivery, address null      THE ERASED DELIVERY — new, and the one below.
 *
 * THE PAIR IS UNAMBIGUOUS AND THE DATABASE IS WHY, which is the only reason this
 * cell can state a fact rather than hedge. Migration 0048's CHECK has three arms:
 * a live delivery MUST carry block, street and building AND MUST NOT carry the
 * erasure stamp; the erased arm requires the stamp and refuses every address
 * column; a pickup carries neither. So `fulfilment: 'delivery'` with
 * `address: null` cannot come from a forgotten snapshot or from a pickup
 * mislabelled — both are unstorable. There is no fourth reading to guard against.
 *
 * ---------------------------------------------------------------------------
 * THE ERASED DELIVERY, AND WHY THE COPY IS FOUR WORDS AND NOT SIX
 *
 * `services/erasure.ts` nulls every address column on her past delivery orders
 * and stamps `address_erased_at` (DECISIONS.md #97). The order stays — it is a
 * financial record — and the household it named is gone.
 *
 * WHAT THIS CELL USED TO SAY WAS FALSE, not merely thin: "Collecting at the
 * salon" on a row whose own Fulfilment pill says Delivery, one cell to the left.
 * Lane A found it while landing the erasure and flagged it in
 * `api/src/routes/orders.ts` rather than reaching into this column.
 *
 * "Address no longer held" — and the four constraints it is the answer to:
 *
 *   NOT THE DATE, AND THE API DOES NOT EVEN SERVE ONE. `address_erased_at` is
 *       deliberately absent from the wire (`api/src/routes/orders.ts` §
 *       serialiseShopOrder): it would tell a salon WHEN a customer asked to be
 *       erased, which is a fact about her rather than about the order she placed.
 *       So there is nothing to render even if this cell wanted it, which is the
 *       right way round.
 *
 *   NOT NOTHING, EITHER. A blank cell reads as a broken screen and sends a
 *       merchant looking for the street — in her inbox, in a WhatsApp thread,
 *       anywhere the scrub could not reach. The sentence exists to END that
 *       search, which is the privacy outcome and not a courtesy.
 *
 *   NOT A REASON, AND NOT A STATUS. It does not say who asked, or why, and it
 *       says nothing about the ORDER: an erased row keeps whatever status it had
 *       and the Status column still owns that. "Cancelled", "Undeliverable" or
 *       anything in that register would be this cell inventing a fact about the
 *       purchase out of a fact about the data.
 *
 *   NOT "DELETED", AND NOT "ERASED". Both are true and both are about a person
 *       when the plainer sentence is about a record. "No longer held" says the
 *       field is GONE rather than missing — which is exactly the distinction Lane
 *       A's `null` was chosen to carry — and it is the salon that no longer holds
 *       it, so the sentence never has a subject who is her. (The Customer cell
 *       beside it may well read "Deleted account": that is the API's tombstone,
 *       not this screen's word, and it is one more reason for this cell not to
 *       say it a second time.)
 *
 * IT LOOKS EXACTLY LIKE THE PICKUP LINE — `.orders__erased` in `app.css`, italic
 * and `--avo-text-muted-strong`, the same as `.orders__pickup`. I first styled it
 * one step quieter, on the reasoning that pickup is an instruction a merchant
 * acts on and this is a record with nothing behind it. `--avo-text-muted-soft`
 * measures 2.83:1 composited on `--avo-surface` against a 4.5:1 floor, so the
 * distinction cost legibility for a difference the WORDS already make — the same
 * argument `STATUS_PILL` makes for `dot: false`. The rule in `app.css` carries
 * the measurements.
 */

/**
 * The three statuses, as pills. NEW COPY — the bundle draws none of these.
 *
 * TONES, and the reasoning is `Appointments.tsx § STATUS_PILL`'s: the pill is
 * TEXT, so its pair has to clear 4.5:1, and no token names "an order is on the
 * counter". So the nearest semantically honest tone is used rather than a new
 * colour invented at this call site.
 *
 *   preparing  `brand`   — the salon is doing something. `--avo-brand-tint` on
 *                          `--avo-brand-deep`, exact, and never white on
 *                          `--avo-brand` (non-negotiable #9).
 *   ready      `warn`    — waiting on somebody. The one status with an action
 *                          outstanding, so it is the one that should catch an eye
 *                          scanning the column.
 *   closed     `quiet`   — done. Same tone `completed` carries on Appointments,
 *                          which is the same fact about a different object.
 *
 * `dot` is deliberately off: interaction-spec.md §2 — "Status pills must carry
 * their meaning as text, not color alone" — and the text is the label itself.
 */
const STATUS_PILL: Record<OrderStatus, { label: string; tone: PillTone }> = {
  preparing: { label: 'Preparing', tone: 'brand' },
  ready: { label: 'Ready', tone: 'warn' },
  closed: { label: 'Closed', tone: 'quiet' },
};

/** The filter chips. `null` is the whole board — an option, not the absence of one. */
const FILTERS: ReadonlyArray<{ value: OrderStatus | null; label: string }> = [
  { value: null, label: 'All' },
  ...ORDER_STATUSES.map((value) => ({ value, label: STATUS_PILL[value].label })),
];

/**
 * MONOTONIC, SO THE BUTTON IS THE NEXT STEP AND NOTHING ELSE.
 *
 * `preparing → ready → closed`, forward only, one step at a time, enforced
 * server-side. A control that offered a backwards move would be offering a 409 —
 * and worse than the error, "closed → preparing" would tell a customer her
 * delivered order is being prepared. `closed` has no entry, so a closed row has
 * no button: the board is not a place an order can be reopened, because the API
 * is not.
 */
const NEXT_STEP: Partial<Record<OrderStatus, { to: Exclude<OrderStatus, 'preparing'>; label: string }>> =
  {
    preparing: { to: 'ready', label: 'Mark ready' },
    ready: { to: 'closed', label: 'Close' },
  };

export interface ShopOrdersProps {
  /**
   * `modules.shop`, from the HOST's `GET /salons/{id}` — `undefined` while that
   * read is in flight.
   *
   * IT IS HERE ONLY TO PICK AN EMPTY, and that is the whole justification for a
   * prop on an otherwise self-contained screen. "No orders yet — they land here
   * as soon as they're placed" is true for a salon whose shop is open and FALSE
   * for one whose module is off, because nobody *can* place one. `AVO
   * States.dc.html` is explicit that two different facts must not share copy, and
   * this is the same pair Appointments has for `modules.booking`.
   *
   * It does NOT gate the fetch, which is the difference from `useSalonBookings`.
   * A salon that switches the shop off still has the orders it already took, and
   * they still have to be prepared, handed over and closed — so the board must
   * load. Booking's module-off empty can skip its request because a salon with
   * booking off has no bookings BY CONSTRUCTION; that reasoning does not transfer.
   */
  /**
   * `boolean | undefined` AND NOT `?: boolean`. The workspace runs
   * `exactOptionalPropertyTypes`, so the two are genuinely different types — and
   * here the difference is the one that matters: `undefined` is not "the prop was
   * omitted", it is the THIRD STATE — the salon read has not landed and the
   * module is not yet known. Writing it into the type is what stops it collapsing
   * into `false` at a call site, which is the exact defect this prop guards.
   */
  shopOn: boolean | undefined;
}

export function ShopOrders({ shopOn }: ShopOrdersProps) {
  const [filter, setFilter] = useState<OrderStatus | null>(null);
  const board = useOrderBoard(filter);
  /*
   * The mutation is keyed to the FILTER the board is showing, because that is the
   * cache entry its result has to be written into — see `api/orders.ts § writeRow`.
   */
  const move = useMoveOrder(filter);

  if (board.isError) {
    return (
      <SectionError
        error={board.error}
        forbiddenTitle="You don't have access to the shop"
        failedTitle="Couldn't load orders"
        onRetry={() => void board.refetch()}
        retrying={board.isFetching}
      />
    );
  }

  const rows = board.data?.items ?? [];
  const truncated = board.data?.truncated === true;

  return (
    <div className="orders">
      {/*
        THE SNAPSHOT, STATED ONCE. See the header — this is the sentence that
        stops a merchant reading the column as live data, and it is the only
        place it is said.
      */}
      <InfoBanner icon={<PinGlyph />}>
        A delivery address is <b>what the customer entered when she ordered</b>. If she later
        edits or deletes it in her app, past orders keep the address they were placed with —
        so an order stays answerable.
      </InfoBanner>

      <div className="orders__filters">
        <div className="avo-label">Show</div>
        <div className="orders__chips">
          {FILTERS.map(({ value, label }) => (
            <Chip
              key={value ?? 'all'}
              role="radio"
              on={filter === value}
              label={label}
              onClick={() => setFilter(value)}
            />
          ))}
        </div>
      </div>

      {/*
        THE TRUNCATION, RENDERED. Never hidden — see § the truncation below.
        Above the table, because it is a statement about the table's contents and
        a notice under 200 rows is a notice nobody scrolls to.
      */}
      {truncated ? <TruncatedNotice filtered={filter !== null} onNarrow={() => setFilter('preparing')} /> : null}

      <Card className="orders__card" flush>
        <div className="orders__scroll">
          <table className="orders__table">
            <caption className="avo-sr-only">
              Shop orders and their fulfilment status, newest first.
            </caption>
            <thead>
              <tr>
                <th scope="col">Order</th>
                <th scope="col">Customer</th>
                <th scope="col">Fulfilment</th>
                <th scope="col">Where</th>
                <th scope="col">Placed</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {board.isPending ? (
                /* The pending layout IS the loaded layout — interaction-spec.md
                   §4. Six rows of six cells, so nothing jumps when it resolves. */
                [0, 1, 2, 3, 4, 5].map((n) => (
                  <tr key={n}>
                    {[0, 1, 2, 3, 4, 5].map((c) => (
                      <td key={c}>
                        <Skeleton width={`${82 - c * 8}%`} height={13} />
                      </td>
                    ))}
                  </tr>
                ))
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="orders__empty">
                    <BoardEmpty filter={filter} shopOn={shopOn} onClear={() => setFilter(null)} />
                  </td>
                </tr>
              ) : (
                rows.map((order) => (
                  <OrderRow
                    key={order.transactionId}
                    order={order}
                    moving={move.isPending && move.variables?.transactionId === order.transactionId}
                    onMove={(to) => move.mutate({ transactionId: order.transactionId, status: to })}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/*
        A FAILED MOVE, AND THE REASSURANCE IS THE HALF THAT MATTERS. The pill in
        the row is still showing the previous status — because `useMoveOrder` is
        not optimistic — so this says out loud that the status on screen is the
        real one. Without that sentence a merchant reads an unchanged pill as a
        button that did not register and presses it again.

        The server's own message is rendered verbatim by `WriteError` for a 409:
        "That order is ready. …an order never goes backwards." — which names the
        actual status, and the row has already been resynced to it.
      */}
      {move.isError ? (
        <WriteError error={move.error} reassurance="The status shown is still the real one." />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------ the truncation
 *
 * `truncated: true` MEANS THE BOARD IS INCOMPLETE, and the cap is 200 with no
 * cursor behind it. Lane A named that in the code rather than leaving another
 * `nextCursor: null` to be believed, and hiding it here would put the lie back
 * one layer up.
 *
 * WHICH END IS MISSING IS THE PART WORTH SAYING. The order is `created_at DESC`,
 * so the rows dropped first are the OLDEST — and on a fulfilment board the oldest
 * `preparing` order is the one that has been waiting longest, i.e. the most
 * urgent thing on the screen. That is the same shape as the defect this lane
 * found in the closure preview, where a `starts_at DESC LIMIT 200` silently
 * dropped the appointments starting soonest and the client reported 0 held
 * deposits against the server's 3. A salon at 200 live orders that sees no
 * indication has exactly that bug again.
 *
 * THE FILTER IS A REAL REMEDY AND NOT A CONSOLATION, which is why this notice
 * offers it. `?status=` narrows SERVER-SIDE, so filtering re-runs the query and
 * can return rows the unfiltered cap had dropped — it is not an `Array.filter`
 * over the 200 that survived. Narrowing to Preparing is the one that recovers the
 * urgent end.
 */
export function TruncatedNotice({ filtered, onNarrow }: { filtered: boolean; onNarrow: () => void }) {
  return (
    <div className="orders__truncated" role="status">
      <span className="orders__truncated-dot" aria-hidden="true" />
      <div className="orders__truncated-text">
        <b>Showing the 200 most recent orders — there are more.</b> The ones not shown are the{' '}
        <b>oldest</b>, which on this board means the ones waiting longest. There is no next page
        yet.
        {filtered ? (
          ' Narrowing further, or closing orders you have handed over, brings the rest into view.'
        ) : (
          <>
            {' '}
            Filtering by status asks the server again rather than trimming this list, so it can
            bring them back.
          </>
        )}
      </div>
      {filtered ? null : (
        <Button variant="secondary" onClick={onNarrow}>
          Show Preparing
        </Button>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- the empties
 *
 * THREE DIFFERENT FACTS, THREE DIFFERENT SENTENCES, and never one message for
 * all of them — `AVO States.dc.html`: "Two different empties … Never show the
 * same copy for both." Here there are three, because the filter adds one:
 *
 *   nothing ordered, shop ON    nobody has bought anything yet. Orders will come.
 *   nothing ordered, shop OFF   nobody CAN buy anything. "Orders land here as
 *                               soon as they're placed" is a false promise to a
 *                               salon whose module is off, and it points at the
 *                               wrong fix — there is nothing to wait for.
 *   nothing at this status      there ARE orders, just none preparing / ready /
 *                               closed. The remedy is a click, so it carries one.
 *
 * The filtered empty is the one a board like this gets wrong by default: showing
 * "No orders yet" under an active Preparing chip tells a salon its shop has never
 * sold anything, which is a claim about the business rather than about a filter.
 */
export function BoardEmpty({
  filter,
  shopOn,
  onClear,
}: {
  filter: OrderStatus | null;
  shopOn: boolean | undefined;
  onClear: () => void;
}) {
  if (filter !== null) {
    const label = STATUS_PILL[filter].label.toLowerCase();
    return (
      <EmptyState
        title={`No orders are ${label}`}
        body={`Other orders may be at a different stage. Clear the filter to see the whole board.`}
        action={{ label: 'Show all orders', onClick: onClear }}
      />
    );
  }

  /*
   * `shopOn === false` and not `!shopOn`. `undefined` is "the salon read has not
   * landed", and rendering it as "off" would state a module is off on every load
   * of a salon whose shop is open — the premature-zero class in words, which
   * `Shop.tsx § shopOn` already makes for the notice.
   */
  if (shopOn === false) {
    return (
      <EmptyState
        title="No orders, and none can be placed yet"
        body="The Shop module is off, so customers can't buy anything. Turn it on in Settings → Optional modules and orders will appear here."
      />
    );
  }

  return (
    <EmptyState
      title="No orders yet"
      body="Orders from the customer app land here as soon as they're placed — pickup and delivery both."
    />
  );
}

/* --------------------------------------------------------------------- a row */

export function OrderRow({
  order,
  moving,
  onMove,
}: {
  order: MerchantShopOrder;
  moving: boolean;
  onMove: (to: Exclude<OrderStatus, 'preparing'>) => void;
}) {
  const pill = STATUS_PILL[order.status];
  const next = NEXT_STEP[order.status];
  const delivery = order.fulfilment === 'delivery';

  return (
    <tr>
      <td className="orders__ref">{order.transactionId}</td>
      <td>
        <div className="orders__customer">{order.memberName}</div>
        {/*
          A `tel:` link and not plain text. It is the one affordance a fulfilment
          row genuinely needs — the building number is wrong, the intercom is
          broken, nobody is answering the door — and it dials rather than sending
          anything anywhere. Non-negotiable #8 is about a merchant MESSAGING a
          customer through the platform; a phone number on an order she placed,
          used to complete that order, is not that.
        */}
        {/*
          `dir="ltr"`, on `console/SupportPanel.tsx`'s measured precedent: this is
          E.164, and a leading `+` inside an RTL run is reordered to the wrong end
          by the bidi algorithm, so it would print "965 9912 4408+".

          AND THIS DASHBOARD IS ENGLISH-ONLY BY DECISION, so the pin is defensive
          rather than required. `design/README.md` § Known gaps 1: "Arabic is
          customer-app only. Decided. Merchant dashboard, owner console and the
          staff scanner ship English-only." The absence of any `[dir]` rule in
          `app.css` is therefore the decision, NOT a gap in non-negotiable #12.

          Worth the four lines because the correction is the interesting part: I
          first read the empty `app.css` as #12 being unmet on this surface and
          reported it as a finding. It is the stale-comment shape this codebase
          keeps hitting, running backwards — a REAL rule, read without the
          decision that scopes it, produces a confident finding about a gap that
          does not exist. The rule was right, the scope was in another file, and
          the fix is to cite the scope wherever the rule gets invoked.

          The attribute stays regardless: it costs nothing, it is correct for a
          bidi-sensitive value on any surface, and it is why the copy WhatsApp
          number two files over carries the same one.

          DO NOT OVER-READ THE CORRECTION, because the opposite mistake is now the
          cheaper one to make. "English-only UI" is not "no Arabic anywhere": this
          dashboard AUTHORS and RENDERS Arabic CONTENT — `nameAr`,
          `stampRewardAr`, the support channel and topic labels — and `app.css`
          § `.support input[lang='ar']` gives those the Arabic face, citing #12,
          correctly. The chrome ships English; the DATA can be Arabic. Nothing here
          is Arabic content, which is the only reason this screen needs no more
          than these two attributes.
        */}
        <a className="orders__phone" href={`tel:${order.memberPhone}`} dir="ltr">
          {order.memberPhone}
        </a>
      </td>
      <td>
        <Pill tone={delivery ? 'neutral' : 'quiet'}>{delivery ? 'Delivery' : 'Pickup'}</Pill>
      </td>
      <td className="orders__where">
        {/*
          THREE STATES, AND THE FORK IS `fulfilment` RATHER THAN `address`.
          `address === null` used to mean pickup and now means one of two things
          — see the header § where an order is going. Reading the address to
          decide which is how "Collecting at the salon" ended up printed beside
          the Delivery pill two cells to the left.
        */}
        {order.address ? (
          <AddressSnapshot address={order.address} />
        ) : delivery ? (
          /*
            AN ERASED DELIVERY. Four words, and every one of them was a choice —
            the header § the erased delivery has the argument for each.
          */
          <span className="orders__erased">Address no longer held</span>
        ) : (
          /*
            NOT AN EM DASH AND NOT "No address". Pickup is a live fork, so this
            cell describes what is happening rather than reporting a field that
            is missing. See the header § where an order is going.
          */
          <span className="orders__pickup">Collecting at the salon</span>
        )}
      </td>
      <td className="orders__when">
        <time dateTime={order.createdAt} title={new Date(order.createdAt).toISOString()}>
          {whenLabel(order.createdAt)}
        </time>
        {/*
          THE SERVER'S TIMESTAMPS, NOT A CLIENT'S IDEA OF WHEN A BUTTON WAS
          PRESSED. `readyAt` and `closedAt` are stamped inside the UPDATE, so they
          are when the transition actually committed — which is what a merchant
          reconstructing "she says she waited an hour" needs.
        */}
        {order.readyAt ? (
          <div className="orders__stamp">
            Ready <time dateTime={order.readyAt}>{whenLabel(order.readyAt)}</time>
          </div>
        ) : null}
        {order.closedAt ? (
          <div className="orders__stamp">
            Closed <time dateTime={order.closedAt}>{whenLabel(order.closedAt)}</time>
          </div>
        ) : null}
      </td>
      <td>
        <div className="orders__status">
          <Pill tone={pill.tone}>{pill.label}</Pill>
          {next ? (
            <Button variant="secondary" disabled={moving} onClick={() => onMove(next.to)}>
              {moving ? 'Saving…' : next.label}
            </Button>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

/**
 * The address, in the order a Kuwaiti address is written.
 *
 * BLOCK, STREET, BUILDING FIRST, and the labels are printed rather than implied
 * by position. `PRIOR-ART.md` § "The one thing not to follow": Lean fans one
 * input across four address fields, so a driver receives a house number in the
 * block field and a landmark where the street should be. Our fields are the ones
 * we actually collect — but an unlabelled "4 · Salem Al-Mubarak · 27" reproduces
 * the same confusion at the reading end, where somebody has to act on it.
 *
 * AN OMITTED PART IS OMITTED, not rendered as a blank label and not filled in
 * from a neighbour. Floor, apartment, area, governorate and instructions are all
 * nullable with no default and nothing substitutes for anything — that is the
 * whole point of `normaliseOptional` on the way in, and it would be undone here
 * by a `?? '—'`.
 */
export function AddressSnapshot({
  address,
}: {
  address: NonNullable<MerchantShopOrder['address']>;
}) {
  /** The parts that exist, each with its own word. Nothing positional. */
  const parts: string[] = [
    `Block ${address.block}`,
    `Street ${address.street}`,
    `Building ${address.building}`,
  ];
  if (address.floor) parts.push(`Floor ${address.floor}`);
  if (address.apartment) parts.push(`Apt ${address.apartment}`);

  /** Area and governorate are free text, not ids — no gazetteer to look up. */
  const area = [address.area, address.governorate].filter(Boolean).join(', ');

  return (
    <div className="orders__address">
      {/*
        HER OWN NAME FOR IT ("Home", "Mum's"), from the snapshot, and it is a
        plain label — not a link into an address book it no longer tracks.
      */}
      <div className="orders__address-label">{address.label}</div>
      <div className="orders__address-line">{parts.join(' · ')}</div>
      {area ? <div className="orders__address-area">{area}</div> : null}
      {address.instructions ? (
        <div className="orders__address-note">“{address.instructions}”</div>
      ) : null}
      {/*
        Coordinates, printed and NOT linked — see the header. Both or neither by
        construction (`member_address_coordinates_are_a_pair`), and they arrive as
        strings because the column is `numeric`: nothing does arithmetic on a
        coordinate, and the database's ban on the float family covers it.
      */}
      {address.latitude && address.longitude ? (
        <div className="orders__address-pin">
          {/*
            The PAIR is `dir="ltr"` for the phone number's reason — a
            comma-separated decimal pair is a bidi hazard in the same way — while
            the word "Pin" stays in the run's own direction so it can be
            translated. Same split `SupportPanel` makes between its label and its
            value.
          */}
          Pin{' '}
          <span dir="ltr">
            {address.latitude}, {address.longitude}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function PinGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M10 17.5s5.5-5.2 5.5-9a5.5 5.5 0 0 0-11 0c0 3.8 5.5 9 5.5 9Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <circle cx="10" cy="8.3" r="1.9" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}
