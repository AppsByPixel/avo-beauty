import { useEffect, useState } from 'react';
import { fils } from '@avo/types';
import { Button, Card, EmptyState, Money, Skeleton } from '@avo/ui';
import {
  useCustomer,
  useCustomerBook,
  useCustomerHistory,
  type CustomerDetail,
  type CustomerListItem,
} from '../api/customers.js';
import type { ActivityItem } from '../api/salon.js';
import { ApiError } from '../api/client.js';
import { SectionError } from './sectionState.js';

/**
 * Merchant → Accounts → Customers. `AVO Merchant Dashboard.dc.html:547` § CUSTOMERS.
 *
 * The design puts this behind a two-option `Segmented` labelled "Accounts" —
 * Team | Customers — under a sidebar item whose subtitle is "Staff access and
 * customer profiles", and the permission that governs it is the chip the design
 * itself calls "Team & accounts". `Accounts.tsx` already rendered the Team half
 * behind that control with an EmptyState standing in for this one; this is that
 * EmptyState's replacement and it mounts in the same slot.
 *
 * =========================================================================
 * IT OWNS ITS OWN FOUR STATES ALTHOUGH ITS HOST IS ON THE SAME PERMISSION
 * =========================================================================
 * `Accounts.tsx` reads `GET /salons/{id}/staff`; this reads three customer
 * routes. All four are `perms.team`, and `ShopOrders.tsx` already settled that a
 * shared PERMISSION is not a shared FAILURE: two routes can refuse, time out or
 * go offline independently, and nothing in the host's read landing says anything
 * about whether these have. So a `SectionError` here is its own answer rather than
 * a drifting copy of its host's, and the pending paint is its own too.
 *
 * WHAT THAT MEANS FOR THE 403 IN PRACTICE, said plainly because it would otherwise
 * read as dead code: a session without `team` is refused by the HOST's staff read
 * first and never reaches this tab, because `Accounts.tsx` returns its
 * `SectionError` above the `Segmented`. The refusal below is still built and still
 * correct — `perms` is a snapshot taken at sign-in, so `team` can be revoked while
 * this tab is open, and the next page of the book is then the request that learns
 * it. It is reachable, it is simply reachable second.
 *
 * =========================================================================
 * THREE PANELS THE DESIGN DRAWS THAT ARE NOT HERE — SAID ON THE SCREEN
 * =========================================================================
 * The design's customer card has six parts. Four are served and two are not, plus
 * the card's two buttons. Rather than quietly drawing five sixths of a card, the
 * card renders `UnservedPanels` naming all three and why. The reasons are
 * `api/src/routes/customers.ts`' and are NOT worked around with a client-side
 * join, which is the one thing that would turn a stated absence into a leak:
 *
 *   NEXT BOOKING is `appointments` data. `team` and `appointments` are not
 *       ordered — the seeded frontdesk `ST-002` holds `appointments` and not
 *       `team` — so a joined read resolves to the STRICTEST of the two, which is
 *       BOTH. Fetching `GET /salons/{id}/bookings` from this card would hand a
 *       `team`-only manager appointment data she is not granted, or 403 the whole
 *       card for a `team` holder who lacks `appointments`. Neither is a panel.
 *
 *   PURCHASES is the same join twice over — services are `appointments`, products
 *       are `shop`.
 *
 *   GIFT and REIMBURSE move money. They need idempotency keys (#4) and the
 *       adjustment path, and `POST /members/{id}/adjustments` is gated
 *       differently again. A read slice does not grow a write.
 *
 * A FOURTH ABSENCE FOUND WHILE BUILDING, AND IT IS THE SAME RULE A THIRD TIME.
 * The design's Wallet panel draws eight stamp dots under "6 of 8 stamps · free
 * blow-dry at 8". `stamps` is served on the card — it is the customer's count —
 * but the TARGET and the REWARD NAME are `stampTarget` / `stampReward` on the
 * loyalty config, which `api/loyalty.ts` reads behind `perms.loyalty`. Drawing
 * the dots would put this card behind `team` AND `loyalty` for one caption, which
 * is precisely the resolution Lane A refused for Next booking. So the count is
 * rendered as the fact it is and the ladder it sits on is not claimed. Reported,
 * not invented.
 *
 * =========================================================================
 * TWO THINGS THE DESIGN DRAWS THAT HAVE NO COLUMN AT ALL
 * =========================================================================
 * `handle` (`@latifa.a`) and `birthday`. There is no username on a customer —
 * DECISIONS.md settled that a customer's sign-in identity is her PHONE, and
 * `services/reports.ts` serves `Phone` in the customers CSV citing this very tab
 * as the place the UI shows the same thing — and there is no date-of-birth column
 * on `member`. So the design's Username COLUMN is Phone here, which is a real
 * field answering the same question ("which Dana is this"), and Birthday is absent
 * from Personal information rather than rendered as an em dash that looks like
 * missing data.
 */

/* ------------------------------------------------------------ the book view */

export function Customers() {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  /**
   * The open card, held as an ID and not as the row.
   *
   * `console/Accounts.tsx` holds the ROW for its voucher panel, deliberately,
   * because nothing serves that console a per-account read and the panel needs the
   * name the row already has. Here the opposite is true: `GET
   * /salons/{id}/customers/{memberId}` is the card's own source, so holding the
   * row would mean rendering a header from the list's copy of a member while the
   * card's copy was still loading — two answers to "what is her balance" on one
   * screen, differing by however long the request takes.
   */
  const [openId, setOpenId] = useState<string | null>(null);

  /*
   * DEBOUNCED, `console/Accounts.tsx`' split: the hook stays a function of the
   * query it is handed and the timing lives with the input that produces it.
   * `customerSearchPredicate` runs an `ILIKE` across the salon's members and the
   * endpoint writes an audit row per call — `CUSTOMER_LIST_ACTION`, which is
   * budgeted by `enforceCustomerDirectoryLimit` at 300 per hour. A keystroke-per-
   * request search box would spend that budget on a merchant typing a name.
   */
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const book = useCustomerBook(query);

  /*
   * THE CARD REPLACES THE BOOK, and it is checked BEFORE the book's error.
   * The design's card is a full view with a "‹ All customers" escape, not an
   * overlay. Checking the book's error first would bounce a merchant out of an
   * open customer the moment a background refetch of the LIST failed — losing the
   * card she is reading to a failure that says nothing about it.
   */
  if (openId !== null) {
    return <CustomerCard memberId={openId} onBack={() => setOpenId(null)} />;
  }

  if (book.isError) {
    return (
      <SectionError
        error={book.error}
        /*
         * Names the section the way the design's own permission chip does —
         * "Team & accounts" — rather than naming the endpoint. The BODY is the
         * server's sentence rendered verbatim by `SectionError`, which is what
         * tells her which permission she lacks and who can grant it.
         */
        forbiddenTitle="You don't have access to Team & accounts"
        failedTitle="Couldn't load the customer book"
        onRetry={() => void book.refetch()}
        retrying={book.isFetching}
      />
    );
  }

  const rows = (book.data?.pages ?? []).flatMap((p) => p.items);

  return (
    <div className="cust">
      <div className="cust__controls">
        <input
          className="avo-input cust__search"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          /*
           * The design's placeholder is "Search name or username". There is no
           * username on a customer (see the header), and the server matches name,
           * phone digits or an exact member id — so the box promises what it can
           * actually find. A placeholder naming a field the endpoint cannot search
           * is the false claim `console/Accounts.tsx` removed from its own.
           */
          placeholder="Search name or phone"
          aria-label="Search this salon's customers by name or phone"
        />
        <span className="cust__count" role="status">
          {/*
            "shown", not "customers". The endpoint serves no total — it pages 25 at
            a time with an opaque cursor — so the only number this screen can state
            truthfully is how many rows it is holding. `console/Accounts.tsx` made
            the same substitution against the same absence.

            AND NO `?? 0` WHILE PENDING. A count rendered from `rows.length` before
            the first page lands announces "0 shown" beside a column of skeletons,
            which is the premature-zero class `stateCensus.test.ts` pins on both
            audit screens.
          */}
          {book.isPending ? '' : `${rows.length} shown`}
        </span>
      </div>

      <Card className="cust__card" flush>
        <table className="cust__table">
          <caption className="avo-sr-only">
            {/*
              NEWEST FIRST, AND THE CAPTION SAYS SO BECAUSE THE SCREEN CANNOT.
              `joined_at DESC` is the server's order and there is no control to
              change it; a sighted merchant infers the order from the Joined
              column, and this is that column read aloud.
            */}
            This salon&rsquo;s customers, most recently joined first.
            {book.isPending
              ? ''
              : ` ${rows.length} ${rows.length === 1 ? 'customer is' : 'customers are'} shown.`}
          </caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              {/* The design's "Username" column. See the header § no column at all. */}
              <th scope="col">Phone</th>
              <th scope="col">Tier</th>
              <th scope="col">Wallet</th>
              <th scope="col">Joined</th>
              <th scope="col">
                <span className="avo-sr-only">Open customer</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {book.isPending ? (
              [0, 1, 2, 3, 4].map((n) => (
                <tr key={n}>
                  {[0, 1, 2, 3, 4, 5].map((c) => (
                    <td key={c}>
                      <Skeleton width={`${78 - c * 8}%`} height={13} />
                    </td>
                  ))}
                </tr>
              ))
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="cust__empty">
                  <BookEmpty query={query} onClear={() => setSearch('')} />
                </td>
              </tr>
            ) : (
              rows.map((customer) => (
                <CustomerRow
                  key={customer.id}
                  customer={customer}
                  onOpen={() => setOpenId(customer.id)}
                />
              ))
            )}
          </tbody>
        </table>
      </Card>

      {book.hasNextPage ? (
        <div className="cust__more">
          <Button
            variant="secondary"
            onClick={() => void book.fetchNextPage()}
            disabled={book.isFetchingNextPage}
          >
            {book.isFetchingNextPage ? 'Loading…' : 'Show more'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * THE TWO EMPTIES, WHICH ARE NOT ONE EMPTY WITH A VARIABLE IN IT.
 *
 * `AVO States.dc.html:199` draws "Search · no results" as its own state and says
 * what it is for in as many words: "Echo the query back and offer the escape.
 * Distinct from 'no data at all'." Its copy is `No members match "noura almu"` over
 * a "Clear search" button.
 *
 * The difference is a claim about the salon. "No customers yet" under a search box
 * with "dana" in it tells a salon with 1,284 registrations that it has none — and
 * the reverse, offering "Clear search" to a salon that genuinely has no customers,
 * offers an escape from a filter that is not there.
 *
 * BOTH ARE REACHABLE and neither is a hypothetical: the unfiltered one is a salon
 * before its first registration, and the filtered one is any query that matches
 * nothing — `routes/customers.ts` writes its audit row "whether or not anything
 * matched" precisely because a search that found nothing is a thing that happened.
 */
export function BookEmpty({ query, onClear }: { query: string; onClear: () => void }) {
  const q = query.trim();
  if (q !== '') {
    return (
      <EmptyState
        title={`No customers match “${q}”`}
        body="Try a phone number, or part of a name. Search looks at every customer in this salon, not just the ones on screen."
        action={{ label: 'Clear search', onClick: onClear }}
      />
    );
  }
  return (
    <EmptyState
      title="No customers yet"
      body="Customers appear here as soon as they register — at the till, or by signing up in the AVO app. Newest joiner first."
    />
  );
}

/* ------------------------------------------------------------------ one row */

export function CustomerRow({
  customer,
  onOpen,
}: {
  customer: CustomerListItem;
  onOpen: () => void;
}) {
  return (
    <tr>
      <td>
        <div className="cust__ident">
          <span className="cust__avatar" aria-hidden="true">
            {customer.name.slice(0, 1)}
          </span>
          <span className="cust__name">{customer.name}</span>
        </div>
      </td>
      <td>
        <MemberPhone customer={customer} />
      </td>
      <td>
        <TierPill tier={customer.tier} />
      </td>
      <td className="cust__wallet">
        {/*
          `fils()` HERE AND NOWHERE EARLIER. Non-negotiable #1: the integer travels
          from the wire to this line untouched, and `<Money>` is the display
          boundary that turns it into "24.500". Nothing on the way added, compared
          or rounded it.
        */}
        <Money amount={fils(customer.balanceFils)} withUnit />
      </td>
      <td className="cust__joined">{monthYear(customer.joinedAt)}</td>
      <td className="cust__open">
        <Button variant="secondary" onClick={onOpen}>
          View
        </Button>
      </td>
    </tr>
  );
}

/**
 * ===========================================================================
 * AN ERASED CUSTOMER IS IN THE BOOK, AND SHE IS NOT CONTACTABLE
 * ===========================================================================
 * SHE IS IN THE BOOK ON PURPOSE. `customerDirectory.ts` states it: her
 * transactions are financial records the retention schedule keeps for seven years,
 * so a merchant reconciling a settled charge has to be able to reach the row it
 * belongs to. A directory that dropped her would make a real charge trace to a
 * customer who cannot be opened. She appears, flagged, with nothing erasure took.
 *
 * AND THE ROW MUST NOT IMPLY SHE CAN BE REACHED. `services/erasure.ts` sets her
 * name to `TOMBSTONE_NAME` ("Deleted account") and her phone to `+990` + 12 random
 * digits — an UNASSIGNED country code, so the number is a tombstone by
 * construction and reaches nobody. This lane has shipped that tombstone twice: the
 * fulfilment board drew it as a working `tel:` link beside the words "Deleted
 * account" (DECISIONS.md #100), and the scanner's My Bookings turned the same
 * digits into a `tel:` AND a `https://wa.me/` button.
 *
 * THIS IS THE THIRD MERCHANT SURFACE TO JOIN `member` FOR A PHONE, AND IT IS THE
 * SAME RENDER. `customerDirectory.ts` named its fields `memberErased` /
 * `memberPhone` to match `MemberContactWire` exactly, deliberately, so that this
 * function is the orders board's decision reused and not a third implementation of
 * it. The one thing that must not happen here is a fourth opinion.
 *
 * THE FLAG, NEVER THE PREFIX. `startsWith('+990')` anywhere on a client is a
 * client-side erasure predicate built on a server constant it does not own, and the
 * day the sentinel changes the link comes back silently.
 *
 * `=== null` AND NOT `== null`, and BOTH ARMS ARE READ. The contract pairs a null
 * phone with `memberErased: true`, so either alone is sufficient; both are read for
 * belt and braces. A phone that is `undefined` is a MISSING JOIN — an upstream bug
 * — and degrades to the same safe cell rather than being reported to a merchant as
 * an erasure that did not happen.
 *
 * NO DIGITS, NOT JUST NO LINK. Printing `+990224285141169` as plain text passes
 * "there is no anchor" and fixes nothing a merchant with a handset cares about: she
 * can copy fabricated digits into a phone just as easily as tap them. The digits do
 * not appear at all.
 */
export function MemberPhone({
  customer,
}: {
  customer: Pick<CustomerListItem, 'memberErased' | 'memberPhone'>;
}) {
  if (customer.memberErased || customer.memberPhone === null) {
    return <span className="cust__contact-erased">Phone no longer held</span>;
  }
  return (
    /*
      A `tel:` link, for the fulfilment board's reason: dialling a customer about
      her own visit is not the platform MESSAGING her, which is what non-negotiable
      #8 governs. `dir="ltr"` pins E.164 against the bidi algorithm reordering the
      leading `+` to the wrong end — defensive on an English-only surface, correct
      on any.
    */
    <a className="cust__phone" href={`tel:${customer.memberPhone}`} dir="ltr">
      {customer.memberPhone}
    </a>
  );
}

/**
 * The tier chip. `--avo-tier-*` are LOYALTY-TIER tokens and this is a loyalty tier,
 * so unlike `Pill`'s documented substitutions there is nothing borrowed here.
 *
 * `tier: null` IS NOT AN ABSENCE TO HIDE. A stamps salon runs no ladder, so every
 * one of its customers has a null tier — rendering nothing would make the column
 * look broken for an entire salon. `--avo-tier-member-*` exists for exactly that
 * row and the word is "Member".
 *
 * AN UNRECOGNISED VALUE IS PRINTED RAW, `console/Accounts.tsx § ROLE_LABEL`'s rule:
 * a fifth tier means the server grew one, and printing it is how the next reader
 * finds out. It falls back to the Member swatch rather than to no styling.
 */
const TIER_LABEL: Record<string, string> = {
  bronze: 'Bronze',
  silver: 'Silver',
  gold: 'Gold',
  black: 'Black',
};

export function TierPill({ tier }: { tier: string | null }) {
  const known = tier !== null && tier in TIER_LABEL;
  return (
    <span className="cust__tier" data-tier={known ? tier : 'member'}>
      {tier === null ? 'Member' : (TIER_LABEL[tier] ?? tier)}
    </span>
  );
}

/* --------------------------------------------------------------- the card -- */

/** A 404 from the card or the history: an id that is not in this salon's book. */
function isUnknownMember(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/**
 * ONE CUSTOMER. The design's detail view, minus the three panels named in the file
 * header and plus the notice that names them.
 *
 * TWO READS, TWO STATES, AND THEY ARE NOT MERGED. The card and the history are
 * separate requests — `routes/customers.ts` split them because her activity grows
 * and her row does not — so the history failing must not blank the profile a
 * merchant opened the card for, and the profile failing must not be reported as
 * "couldn't load her history". Each answers for itself.
 *
 * THE 404 IS A SENTENCE AND NOT A SERVER FAILURE. `loadCustomer` answers `404
 * unknown_member` for an id that is not in this salon — byte-identical to an id
 * that does not exist anywhere, so the endpoint cannot be used as an oracle for
 * "is 8842 a customer somewhere in AVO". Routed through `SectionError` it would
 * read "Something went wrong on our side", which is false: nothing went wrong and
 * retrying will answer the same thing forever. It gets its own state, with no
 * retry, for the reason a 403 has none.
 */
export function CustomerCard({ memberId, onBack }: { memberId: string; onBack: () => void }) {
  const card = useCustomer(memberId);
  const history = useCustomerHistory(memberId);

  return (
    <div className="cust-card">
      <button type="button" className="cust-card__back" onClick={onBack}>
        <span aria-hidden="true">‹</span> All customers
      </button>

      {card.isPending ? (
        <CustomerSkeleton />
      ) : card.isError ? (
        isUnknownMember(card.error) ? (
          <EmptyState
            title="That customer isn't in this salon's book"
            body="She may have been opened from a stale list, or she belongs to another salon. Go back and search the book again."
            action={{ label: 'Back to all customers', onClick: onBack }}
          />
        ) : (
          <SectionError
            error={card.error}
            forbiddenTitle="You don't have access to Team & accounts"
            failedTitle="Couldn't load this customer"
            onRetry={() => void card.refetch()}
            retrying={card.isFetching}
          />
        )
      ) : (
        <CustomerProfile customer={card.data} />
      )}

      <div className="cust-card__grid">
        <Card className="cust-card__panel">
          <h3 className="cust-card__panel-title avo-display">Recent activity</h3>
          <History
            history={history}
            /*
              The history is not asked for again when the card itself has already
              answered 404 — the member is not in this salon and the second refusal
              adds nothing but a second audit row against an id nobody holds.
            */
            suppressed={card.isError && isUnknownMember(card.error)}
          />
        </Card>

        <UnservedPanels />
      </div>
    </div>
  );
}

/** The design's header strip, Personal information and Wallet. */
export function CustomerProfile({ customer }: { customer: CustomerDetail }) {
  return (
    <>
      <div className="cust-card__head">
        <span className="cust-card__avatar" aria-hidden="true">
          {customer.name.slice(0, 1)}
        </span>
        <div className="cust-card__ident">
          <div className="cust-card__name avo-display">{customer.name}</div>
          <div className="cust-card__since">
            {/*
              The design's line is "{{ cd.handle }} · member since {{ cd.joined }}".
              There is no handle on a customer, so what survives is the true half —
              kept in the design's own words.
            */}
            member since {monthYear(customer.joinedAt)} · {customer.visits}{' '}
            {customer.visits === 1 ? 'visit' : 'visits'}
          </div>
        </div>
        <TierPill tier={customer.tier} />
      </div>

      <div className="cust-card__grid">
        <Card className="cust-card__panel">
          <h3 className="cust-card__panel-title avo-display">Personal information</h3>
          {/*
            Three rows, not the design's four. Birthday has no column on `member`
            at all — see the file header — and a row rendered as an em dash would
            report a field the product does not hold as data somebody forgot to
            enter.
          */}
          <dl className="cust-card__info">
            <div className="cust-card__info-row">
              <dt>Phone</dt>
              <dd>
                <MemberPhone customer={customer} />
              </dd>
            </div>
            <div className="cust-card__info-row">
              <dt>Email</dt>
              <dd>
                <MemberEmail customer={customer} />
              </dd>
            </div>
            <div className="cust-card__info-row">
              <dt>Joined</dt>
              <dd>{fullDate(customer.joinedAt)}</dd>
            </div>
          </dl>
        </Card>

        <Card className="cust-card__panel">
          <h3 className="cust-card__panel-title avo-display">Wallet</h3>
          <div className="cust-card__balance">
            <Money amount={fils(customer.balanceFils)} />
            <span className="cust-card__unit">KD</span>
          </div>
          {/*
            THE STAMP COUNT WITHOUT THE LADDER IT SITS ON, and the header says why:
            `stampTarget` and `stampReward` live on the loyalty config behind
            `perms.loyalty`, so the design's "6 of 8 · free blow-dry at 8" would put
            this card behind two permissions for one caption — the exact resolution
            Lane A refused for Next booking. The count is a fact this endpoint
            serves; the target is not, and is not guessed.

            `stamps === null` IS A TIERS SALON, NOT A ZERO. The column is nullable
            for that reason and `customerDirectory.ts` refuses to default it, so
            nothing is drawn rather than "0 stamps" claimed about a salon that runs
            no stamp card.
          */}
          {customer.stamps === null ? null : (
            <div className="cust-card__stamps">
              {customer.stamps} {customer.stamps === 1 ? 'stamp' : 'stamps'} collected
              <span className="cust-card__stamps-note">
                The card length and its reward are set under Loyalty.
              </span>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

/**
 * `email` IS SERVED RAW AND ITS NULL IS TWO DIFFERENT FACTS.
 *
 * Erasure clears the column outright — it is nullable, unlike the phone, so there
 * is no tombstone to keep off the wire and `customerDirectory.ts` deliberately
 * gives it no serialiser. Which means a null here means "erased" on an erased
 * member and "never gave us one" on a live one, and `memberErased` is the only
 * thing that can tell them apart. Printing one sentence for both would report a
 * customer who simply never typed an email as a deletion.
 */
export function MemberEmail({
  customer,
}: {
  customer: Pick<CustomerDetail, 'memberErased' | 'email'>;
}) {
  if (customer.memberErased) return <span className="cust__contact-erased">No longer held</span>;
  if (customer.email === null) return <span className="cust__contact-none">None on file</span>;
  return <span dir="ltr">{customer.email}</span>;
}

/**
 * THE PANELS THIS CARD DOES NOT HAVE, NAMED ON THE SCREEN.
 *
 * A merchant who knows the design expects Next booking, Purchases, Gift and
 * Reimburse. Silently drawing four panels where six were specified makes the card
 * look finished and wrong; it also invites the next person to "fix" it with a
 * client-side join, which is the one repair that would actually leak something.
 *
 * So the absence is stated, in the merchant's terms rather than in permission
 * names — "your booking access" is what she can act on; `perms.appointments` is
 * not. What she needs to know is that the data exists elsewhere in the product and
 * that this panel is not broken.
 */
export function UnservedPanels() {
  return (
    <Card className="cust-card__panel cust-card__panel--unserved">
      <h3 className="cust-card__panel-title avo-display">Not on this card yet</h3>
      <ul className="cust-card__unserved">
        <li>
          <b>Next booking</b> and <b>Purchases</b> are appointment and shop records. They sit
          behind different access from the customer book, so they cannot be shown on a card
          opened with Team &amp; accounts alone. Her appointments are on the Appointments board
          and her orders are on Shop → Orders.
        </li>
        <li>
          <b>Gift</b> and <b>Reimburse</b> move money into her wallet. They are not part of this
          release; a refund is wallet credit and is issued from the charge it belongs to.
        </li>
      </ul>
    </Card>
  );
}

/* ------------------------------------------------------------- her history -- */

type HistoryQuery = ReturnType<typeof useCustomerHistory>;

export function History({
  history,
  suppressed,
}: {
  history: HistoryQuery;
  suppressed: boolean;
}) {
  if (suppressed) return null;

  if (history.isError) {
    if (isUnknownMember(history.error)) return null;
    return (
      <SectionError
        error={history.error}
        forbiddenTitle="You don't have access to Team & accounts"
        failedTitle="Couldn't load her history"
        onRetry={() => void history.refetch()}
        retrying={history.isFetching}
      />
    );
  }

  if (history.isPending) {
    return (
      <div className="cust-card__feed">
        {[0, 1, 2, 3, 4].map((n) => (
          <div className="cust-card__feed-row" key={n}>
            <Skeleton width="70%" height={13} />
            <Skeleton width="34%" height={11} />
          </div>
        ))}
      </div>
    );
  }

  const items = (history.data?.pages ?? []).flatMap((p) => p.items);

  if (items.length === 0) {
    return (
      /*
        A THIRD EMPTY, AND IT IS ABOUT HER RATHER THAN ABOUT THE BOOK. A customer
        with no settled transaction and no loyalty event is a registration that has
        not been used yet — `routes/customers.ts` filters to `status: 'settled'`, so
        a customer mid-top-up at a gateway page also lands here. It names the thing
        that fills it rather than reporting the panel as broken.
      */
      <EmptyState
        title="Nothing yet"
        body="Charges, top-ups and tier changes appear here as soon as they settle."
      />
    );
  }

  return (
    <>
      <ul className="cust-card__feed">
        {items.map((item) => (
          <HistoryRow key={`${item.stream}:${item.id}`} item={item} />
        ))}
      </ul>
      {history.hasNextPage ? (
        <div className="cust-card__more">
          <Button
            variant="secondary"
            onClick={() => void history.fetchNextPage()}
            disabled={history.isFetchingNextPage}
          >
            {history.isFetchingNextPage ? 'Loading…' : 'Show more'}
          </Button>
        </div>
      ) : null}
    </>
  );
}

/**
 * One line of her history.
 *
 * `what` IS RENDERED AS THE SERVER SENT IT. `activityFeed.ts § describeTransaction`
 * composes it — "topped up 25.000 via KNET", "Reached Gold tier" — and it exists
 * because a top-up's `amount_fils` is what LANDED, bonus included, so a client
 * that printed the column would tell a merchant her customer paid five dinars she
 * did not. Three surfaces read that one function; this is the third.
 *
 * `who` IS NOT DRAWN, unlike the Overview's row. Every line on this panel belongs
 * to the customer whose card it is, so bolding her name five times answers a
 * question nobody asked. The exception the server makes — "System" for an automatic
 * deposit return — is already inside `what` ("returned 5.000 deposit · Latifa A."),
 * so nothing is lost.
 *
 * `amountFils` IS NOT DRAWN EITHER, and that is not an oversight: it is signed as
 * stored and the sentence beside it already states the amount in the merchant's
 * terms. Rendering the raw integer a second time invites the two to disagree, which
 * on a top-up they would.
 */
export function HistoryRow({ item }: { item: ActivityItem }) {
  return (
    <li className="cust-card__feed-row">
      <span className="cust-card__feed-dot" data-stream={item.stream} aria-hidden="true" />
      <span className="cust-card__feed-body">
        <span className="cust-card__feed-what">{item.what}</span>
        <span className="cust-card__feed-when">{whenLabel(item.at)}</span>
      </span>
    </li>
  );
}

/* ------------------------------------------------------------------ pending */

function CustomerSkeleton() {
  return (
    <>
      <div className="cust-card__head">
        <Skeleton width={56} height={56} radius={16} />
        <div className="cust-card__ident">
          <Skeleton width="42%" height={20} />
          <Skeleton width="28%" height={13} />
        </div>
      </div>
      <div className="cust-card__grid">
        {[0, 1].map((n) => (
          <Card className="cust-card__panel" key={n}>
            <Skeleton width="45%" height={16} />
            <Skeleton width="100%" height={54} />
          </Card>
        ))}
      </div>
    </>
  );
}

/* -------------------------------------------------------------------- dates */

/**
 * The design's "member since Mar 2024". `en-GB` for the salon's reading, matching
 * every other date on this surface.
 *
 * AN UNPARSEABLE INSTANT DEGRADES TO A WORD RATHER THAN TO "Invalid Date".
 * `Accounts.tsx § formatExpiry` set that shape for the same reason: a date this
 * client could not read is a server the merchant cannot fix, and printing the
 * browser's error string into a customer's row helps nobody.
 */
export function monthYear(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'unknown';
  return at.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
}

export function fullDate(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'unknown';
  return at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** `AuditLog.tsx`' feed stamp, same shape so two feeds do not read two ways. */
export function whenLabel(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'unknown';
  const time = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · ${time}`;
}
