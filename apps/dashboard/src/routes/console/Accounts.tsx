import { useEffect, useState } from 'react';
import { Button, Card, EmptyState, InfoBanner, Pill, Segmented, Skeleton } from '@avo/ui';
import {
  useSendResetLink,
  usePlatformAccounts,
  type AccountRoleFilter,
  type PlatformAccount,
} from '../../api/platformAccounts.js';
import { SectionError, WriteError } from '../sectionState.js';
import { AccountVouchers } from './AccountVouchers.js';

/**
 * Console → Accounts. `GET /v1/platform/accounts`, section `accounts`.
 *
 * `AVO Owner Console.dc.html:431` § ACCOUNTS — a banner, a search box with a
 * "shown" count, a four-way segmented filter, and a five-column table: Name,
 * Salon, Role, Password, Active.
 *
 * =========================================================================
 * THE WIDEST READ IN THE PRODUCT
 * =========================================================================
 * Every other read of `member` and `staff_user` in this API is salon-scoped
 * through `requireSameSalon`. This one has no salon predicate at all — it is
 * every customer and every staff member on the platform, in one list, by design.
 * The gate is the whole safety argument and it is server-side:
 * `requirePlatform(req, 'accounts')`, which refuses on the credential KIND before
 * it refuses on authority, so a merchant token cannot reach it whatever
 * permissions the merchant holds.
 *
 * Driven as the analyst `mariam.k` (`activity: true, accounts: false`): the list
 * 403s and so does the reset write, independently. Non-negotiable #7 — the
 * sidebar hiding this item from her is a courtesy; these two refusals are the
 * control.
 *
 * =========================================================================
 * THREE THINGS THE DESIGN DRAWS THAT ARE NOT BUILT, AND WHY EACH IS ABSENT
 * =========================================================================
 * 1. THE CUSTOMER DETAIL VIEW. The design opens a customer into a profile with
 *    phone, email, birthday, tier, stamp card, next booking, purchase history and
 *    a per-customer activity feed, plus Wallet adjust and Add stamps. There is no
 *    per-account READ endpoint of any kind — `accounts.ts` says so explicitly
 *    ("If the console needs to tell two customers named Dana apart, that belongs
 *    on a per-account read") — and most of those fields are not served anywhere.
 *    The two WRITES exist (`POST /members/{id}/adjustments`, gated `accounts`),
 *    but a wallet-adjust form needs the balance it is adjusting, and nothing
 *    serves it to this console.
 *
 *    So names are rendered as text, not as the design's `Name ›` button. A button
 *    that opens nothing is worse than no button, and this is the `Salons`
 *    subtitle lesson applied before it becomes a defect rather than after:
 *    "a header that offers one above a screen that has none is still a false
 *    claim."
 *
 * 2. THE "ACTIVE" TOGGLE. The design's fifth column is a suspend switch. THERE IS
 *    NO SUSPENSION ENDPOINT ANYWHERE IN THE API — not for a member, not for a
 *    staff member, not for a salon. A toggle wired to nothing, on the screen that
 *    controls every account AVO holds, would be the worst possible place for a
 *    control that appears to work.
 *
 *    The column is kept and made a STATUS instead, which is real: the endpoint
 *    resolves four timestamps into one `status` precisely so the console cannot
 *    disagree with the write door.
 *
 * 3. THE BANNER'S MIDDLE CLAUSE. The design's sentence is "Every account on the
 *    platform. Open a customer to see their profile, add wallet credit or stamps —
 *    or send a reset link. Passwords are never stored or shown." Two thirds of
 *    that is true and one third describes the detail view above. Copy is kept
 *    verbatim in this build, so the true clauses are kept WORD FOR WORD and the
 *    unbuilt one is dropped rather than paraphrased into something vaguer. The
 *    sentence that survives is still the design's, including #6's own sentence,
 *    which the design deliberately draws on this screen.
 *
 * All three are reported to trunk rather than quietly worked around.
 *
 * =========================================================================
 * THE SIXTH COLUMN IS NOT THE DESIGN'S, AND IT IS NEW RATHER THAN RESTORED
 * =========================================================================
 * The design's table has five columns and they are transcribed above. "Vouchers"
 * is a sixth, added because `api/src/routes/vouchers.ts` shipped four endpoints
 * that no client consumed and the design bundle draws no surface for them
 * anywhere — `grep -ril 'coupon\|voucher\|compensat' design/` is empty. So this
 * is a new control on a settled screen, marked as one.
 *
 * IT IS THE `Name ›` BUTTON'S PLACE AND DELIBERATELY NOT ITS FORM. The design's
 * name link promises a customer PROFILE — phone, tier, stamp card, history — and
 * absence 1 above is why it is not drawn. Making that link open a voucher panel
 * instead would satisfy the letter of "a button that opens something" and break
 * the whole point of the rule: it would be a control that opens the wrong thing.
 * A separate button, labelled for exactly what it opens, is the honest shape.
 *
 * CUSTOMERS ONLY. A voucher is bound to a `member`; `POST /v1/vouchers` answers
 * 404 `unknown_member` for a `staff_user` id — driven, against a real seeded staff
 * row — so a staff line renders no button rather than one that 404s. The refusal
 * is the server's; this is the courtesy over it.
 *
 * NOT OFFERED ON A TOMBSTONE, for the same reason the reset button is not: the
 * issue endpoint refuses an erased member 409 `member_erased` one step BEFORE it
 * writes, "so an unredeemable voucher is never created". A deletion-requested
 * account still gets the button — she is still a customer with a live wallet, and
 * the API issues to her.
 *
 * =========================================================================
 * THE SEARCH BOX, AND THE ONE WORD DELIBERATELY REMOVED FROM ITS PLACEHOLDER
 * =========================================================================
 * The design's placeholder is "Search name, salon or role" and its mock filters
 * an in-memory array on all three. The API matches name, salon name and (for
 * staff) handle — and NOT role, with a stated reason that is correct: the rows
 * carry a LABEL ("Salon owner") and the column carries an enum (`owner`), so
 * matching a typed word against `role` would find "owner" and silently not "Salon
 * owner" — a search that works for one of the four chips and quietly fails for
 * the others. `?role=` is the field for that question and it is exact, which is
 * what the segmented control beside the box sends.
 *
 * So the placeholder promises name and salon only. Promising "role" above a box
 * that cannot search it would be a false claim of exactly the kind this file
 * removes two of above.
 *
 * DEBOUNCED, for `Audit.tsx`'s reason squared: the `ILIKE` runs across every
 * tenant's `member` AND `staff_user` rows.
 *
 * IT DOES NOT FIGHT THE `memberSearch.ts` RATE LIMITER. That limiter's two tiers
 * are counted off `audit_log` rows written by `GET /members` — the SCANNER-scoped
 * search behind `perms.scanner`, whose whole point is stopping a salon's front
 * desk from walking the customer name space. This is a different endpoint on a
 * different gate that writes no audit row per lookup, and it deliberately has no
 * minimum query length because a console admin holding `accounts` is entitled to
 * the unfiltered list anyway. The debounce here spares the database, not a
 * limiter that is not watching this door.
 *
 * =========================================================================
 * THE COUNT SAYS "SHOWN", WHICH IS WHAT IT CAN COUNT
 * =========================================================================
 * The endpoint deliberately serves no `total` — two extra `count(*)` scans per
 * page, and the sum of two streams' counts is not the count of the merged list.
 * The design's line already reads "{{ acctCount }} shown", so the number rendered
 * is the number of rows actually held, which is the only honest reading of that
 * word. Nothing here fabricates a zero while pending: the count renders '' until
 * data lands, and the sr-only caption withholds it on the same condition — the
 * announced-not-painted defect both audit screens had.
 */
export function ConsoleAccounts() {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [role, setRole] = useState<AccountRoleFilter>('all');

  useEffect(() => {
    const timer = setTimeout(() => setQuery(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const accounts = usePlatformAccounts({ q: query, role });
  const reset = useSendResetLink();

  /*
   * "Link sent" is the SCREEN's state because there is no server field for it —
   * see `useSendResetLink`. Keyed by account id so two rows cannot share one
   * button's outcome, which is the bug a single `sent` boolean would produce on
   * the first list with two rows in it.
   */
  const [sent, setSent] = useState<Record<string, true>>({});

  /*
   * THE OPEN VOUCHER PANEL, HELD AS THE ROW ITSELF AND NOT AS AN ID.
   *
   * `AccountVouchers` needs the customer's NAME for its heading and its empty
   * state, and no endpoint serves one for a single account — absence 1 above. So
   * the row hands over the `PlatformAccount` it already has. Holding an id and
   * looking it back up in `rows` would work until the search box filtered the row
   * away underneath an open panel, at which point the heading would lose the name
   * it is titled with.
   *
   * ONE AT A TIME, AND IT CLOSES WHEN EITHER FILTER MOVES. A panel that survived
   * a search would sit under a table that no longer contains the row it belongs
   * to — the panel's own heading would be the only thing on screen naming its
   * subject, which is the disappearing-context defect the reset error above is
   * placed to avoid, in slower motion. Closed in the two handlers rather than in
   * an effect, so the rule lives where the change happens.
   */
  const [openVouchers, setOpenVouchers] = useState<PlatformAccount | null>(null);

  if (accounts.isError) {
    return (
      <SectionError
        error={accounts.error}
        forbiddenTitle="You don't have access to accounts"
        failedTitle="Couldn't load accounts"
        onRetry={() => void accounts.refetch()}
        retrying={accounts.isFetching}
      />
    );
  }

  const rows = (accounts.data?.pages ?? []).flatMap((p) => p.items);
  const filtered = query.trim() !== '' || role !== 'all';

  return (
    <div className="accounts-console">
      {/*
        The design's banner, minus the clause describing the unbuilt detail view.
        See the header — the surviving clauses are verbatim, including #6's.
      */}
      <InfoBanner icon={<SearchGlyph />}>
        Every account on the platform. Passwords are never stored or shown.
      </InfoBanner>

      <div className="accounts-console__controls">
        <input
          className="avo-input accounts-console__search"
          type="search"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setOpenVouchers(null);
          }}
          placeholder="Search name or salon"
          aria-label="Search every account on the platform"
        />
        <span className="accounts-console__count" role="status">
          {/* No `?? 0` — a pending screen announces no count it is not painting. */}
          {accounts.isPending ? '' : `${rows.length} shown`}
        </span>
        <Segmented<AccountRoleFilter>
          label="Filter by role"
          value={role}
          onChange={(next) => {
            setRole(next);
            setOpenVouchers(null);
          }}
          options={[
            { value: 'all', label: 'All' },
            { value: 'customer', label: 'Customers' },
            { value: 'staff', label: 'Staff' },
            { value: 'owner', label: 'Owners' },
          ]}
        />
      </div>

      {/*
        A failed RESET, reported above the table rather than inside a row: the row
        that failed may have been filtered away by the time the answer lands, and
        an error that can disappear is an error nobody reads. `reassurance` names
        what did not happen, which on this screen is the whole question — a
        console admin who cannot tell whether a link went out sends a second one.
      */}
      {reset.isError ? (
        <WriteError error={reset.error} reassurance="No link was sent." />
      ) : null}

      <Card className="accounts-console__card" flush>
        <div className="accounts-console__scroll">
          <table className="accounts-console__table">
            <caption className="avo-sr-only">
              Every customer and staff account on the platform, newest first.
              {accounts.isPending
                ? ''
                : ` ${rows.length} ${rows.length === 1 ? 'account is' : 'accounts are'} shown.`}
            </caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Salon</th>
                <th scope="col">Role</th>
                <th scope="col">Password</th>
                <th scope="col">Active</th>
                {/* Not the design's. See the header § the sixth column. */}
                <th scope="col">Vouchers</th>
              </tr>
            </thead>
            <tbody>
              {accounts.isPending ? (
                [0, 1, 2, 3, 4, 5, 6].map((n) => (
                  <tr key={n}>
                    {[0, 1, 2, 3, 4, 5].map((c) => (
                      <td key={c}>
                        <Skeleton width={`${80 - c * 9}%`} height={13} />
                      </td>
                    ))}
                  </tr>
                ))
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="accounts-console__empty">
                    {filtered ? (
                      /*
                       * NAMES WHAT IT FILTERED. "No accounts" under an invisible
                       * filter reads as "the platform has no accounts", which on
                       * this list is a claim worth not making by accident.
                       *
                       * REACHABLE, and driven: `?q=zzzznotarealname` returns
                       * `{"items":[],"nextCursor":null}` against the seeded
                       * database. Checked rather than assumed — the Overview's
                       * empty state was unreachable for months because the
                       * request was refused before it could return zero rows.
                       */
                      <EmptyState title="No accounts match" body={emptyLine(query, role)} />
                    ) : (
                      /*
                       * The unfiltered empty. Reachable only on a platform with
                       * no salons onboarded — every salon arrives through the
                       * onboarding wizard with an owner, so this is the state
                       * before the first one. It names the thing that fills it.
                       */
                      <EmptyState
                        title="No accounts yet"
                        body="Customers and staff appear here as salons onboard and their customers sign up."
                      />
                    )}
                  </td>
                </tr>
              ) : (
                rows.map((account) => (
                  <AccountRow
                    key={`${account.kind}:${account.id}`}
                    account={account}
                    sent={sent[account.id] === true}
                    sending={reset.isPending && reset.variables?.id === account.id}
                    vouchersOpen={openVouchers?.id === account.id}
                    onVouchers={() =>
                      setOpenVouchers((open) => (open?.id === account.id ? null : account))
                    }
                    onSend={() => {
                      reset.mutate(
                        { id: account.id, kind: account.kind },
                        { onSuccess: () => setSent((s) => ({ ...s, [account.id]: true })) },
                      );
                    }}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/*
        THE PANEL, BELOW THE TABLE AND NOT OVER IT. A modal would have to trap
        focus and return it to a trigger that a refetch can unmount; this is a
        region the opening button points at with `aria-controls`, so a keyboard
        user tabs straight into it and Close returns her to the list.
      */}
      {openVouchers !== null ? (
        <AccountVouchers
          account={openVouchers}
          panelId={`vouchers-${openVouchers.id}`}
          onClose={() => setOpenVouchers(null)}
        />
      ) : null}

      {accounts.hasNextPage ? (
        <div className="accounts-console__more">
          <Button
            variant="secondary"
            onClick={() => void accounts.fetchNextPage()}
            disabled={accounts.isFetchingNextPage}
          >
            {accounts.isFetchingNextPage ? 'Loading…' : 'Show more'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------------- rows -- */

/**
 * The role pill's label.
 *
 * The design draws three labels — Customer, Staff, Salon owner — and the wire
 * carries the precise `staffRole` enum, which has five values. Collapsing
 * `manager` / `frontdesk` / `artist` / `scanner` into "Staff" would throw away
 * the answer to the question this directory exists to answer, so each is named
 * and the design's two special labels are kept exactly: `customer` → "Customer"
 * and `owner` → "Salon owner", which is the design's own wording for a
 * `staff_user` whose role is owner.
 *
 * The fallback is the raw value rather than "Staff": an unrecognised role is a
 * server that grew a sixth one, and printing it is how the next reader finds out.
 */
const ROLE_LABEL: Record<string, string> = {
  customer: 'Customer',
  owner: 'Salon owner',
  manager: 'Manager',
  frontdesk: 'Front desk',
  artist: 'Artist',
  scanner: 'Scanner',
};

/** The design's three pill colours: Customer brand, Salon owner warm, Staff quiet. */
function rolePillTone(account: PlatformAccount): 'brand' | 'warn' | 'quiet' {
  if (account.kind === 'customer') return 'brand';
  if (account.role === 'owner') return 'warn';
  return 'quiet';
}

/**
 * The status column — the design's "Active" toggle, made a fact.
 *
 * See the file header: there is no suspension endpoint, so there is nothing for a
 * switch to call. What is rendered instead is the `status` the endpoint resolves,
 * which is more than the toggle could have said anyway — a toggle has two
 * positions and an account has four states, two of which ("erased", "deletion
 * requested") a switch would have flattened into "off".
 */
const STATUS_LABEL: Record<PlatformAccount['status'], string> = {
  active: 'Active',
  deletion_requested: 'Deletion requested',
  erased: 'Erased',
  deactivated: 'Deactivated',
};

const STATUS_TONE: Record<PlatformAccount['status'], 'brand' | 'warn' | 'danger' | 'quiet'> = {
  active: 'brand',
  deletion_requested: 'warn',
  erased: 'danger',
  deactivated: 'quiet',
};

export function AccountRow({
  account,
  sent,
  sending,
  onSend,
  vouchersOpen,
  onVouchers,
}: {
  account: PlatformAccount;
  sent: boolean;
  sending: boolean;
  onSend: () => void;
  vouchersOpen: boolean;
  onVouchers: () => void;
}) {
  /*
   * THE ONE DISABLED STATE, AND THE SERVER INVITED IT.
   *
   * `POST /accounts/{id}/reset-link` refuses an erased member 409 `member_erased`
   * — "a tombstone has no phone for the message to reach and nobody to hold the
   * account." `accounts.ts` resolves `status` server-side for exactly this: "One
   * field, resolved here, so the console's disabled states cannot disagree with
   * what the write door will do."
   *
   * It is still a COURTESY, not a control (#7): the refusal is enforced on the
   * server and would arrive with its own sentence if this line were deleted.
   *
   * A DEACTIVATED STAFF MEMBER IS NOT DISABLED, deliberately — the endpoint calls
   * sending her a link "the re-hire path" and issues one, re-activating at
   * redemption. Disabling that button would hide the row whose action is the
   * reason the row is interesting, and the API lists her for that reason.
   */
  const erased = account.status === 'erased';

  return (
    <tr>
      <td>
        {/* Text, not a link. There is no per-account read — see the header. */}
        <div className="accounts-console__name">{account.name}</div>
        {/*
          The staff member's real login handle. Null for a customer, and nothing
          is rendered in its place: `member` has no handle column, and her login
          identity is the phone, which this list deliberately does not serve.
        */}
        {account.handle ? (
          <div className="accounts-console__handle">@{account.handle}</div>
        ) : null}
      </td>
      <td className="accounts-console__salon">{account.salon}</td>
      <td>
        <Pill tone={rolePillTone(account)}>{ROLE_LABEL[account.role] ?? account.role}</Pill>
      </td>
      <td>
        {sent ? (
          /*
           * The design's green-dotted "Link sent" pill. `delivered` is honestly
           * `false` on the wire — the sender is unwired across all four issuers —
           * so this says the link was ISSUED, which is what actually happened and
           * what the design's word means here.
           */
          <Pill tone="brand" dot>
            Link sent
          </Pill>
        ) : (
          <Button
            variant="secondary"
            className="accounts-console__reset"
            disabled={erased || sending}
            onClick={onSend}
            aria-label={`Send a password reset link to ${account.name}`}
          >
            {sending ? 'Sending…' : 'Send reset link'}
          </Button>
        )}
        {/*
          `passwordSet` carries real information for STAFF and is rendered only
          there: `password_hash` is nullable on `staff_user`, so `false` is either
          an invite nobody has redeemed or a leaver whose credentials were nulled.
          On a customer the column is `NOT NULL` and `false` only ever means
          erased, which the status pill already says — so printing it beside the
          tombstone would be the same fact twice.
        */}
        {account.kind === 'staff' && !account.passwordSet ? (
          <div className="accounts-console__nopassword">No password set</div>
        ) : null}
      </td>
      <td>
        <Pill tone={STATUS_TONE[account.status]}>{STATUS_LABEL[account.status]}</Pill>
      </td>
      <td>
        {/*
          CUSTOMERS ONLY, AND NOT A TOMBSTONE — the header § the sixth column has
          both refusals and where the server states each. A staff row and an
          erased member render NOTHING here rather than a disabled button: a
          disabled control says "not right now", and for a `staff_user` the answer
          is "never, this is not a thing staff hold".

          `aria-controls` IS SPREAD IN ONLY WHILE THE PANEL EXISTS. Pointing at an
          id that is not in the document is worse than pointing at nothing — a
          screen reader following it lands on no element and reports the control as
          broken rather than as closed. `aria-expanded` carries the state on its
          own when there is nothing to point at.
        */}
        {account.kind === 'customer' && !erased ? (
          <Button
            variant="secondary"
            className="accounts-console__vouchers"
            onClick={onVouchers}
            aria-expanded={vouchersOpen}
            {...(vouchersOpen ? { 'aria-controls': `vouchers-${account.id}` } : {})}
            aria-label={`${vouchersOpen ? 'Hide' : 'Show'} vouchers for ${account.name}`}
          >
            {vouchersOpen ? 'Hide' : 'Vouchers'}
          </Button>
        ) : null}
      </td>
    </tr>
  );
}

/** Names the filter an empty result was filtered by. */
function emptyLine(query: string, role: AccountRoleFilter): string {
  const what =
    role === 'all'
      ? 'accounts'
      : role === 'customer'
        ? 'customers'
        : role === 'owner'
          ? 'salon owners'
          : 'staff accounts';
  const q = query.trim();
  if (q !== '') return `No ${what} match “${q}”.`;
  return `There are no ${what} on the platform yet.`;
}

/** The design's own banner glyph (`AVO Owner Console.dc.html:438`). */
function SearchGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="7.5" cy="7.5" r="4" stroke="currentColor" strokeWidth="1.6" />
      <path d="M10.5 10.5 16 16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
