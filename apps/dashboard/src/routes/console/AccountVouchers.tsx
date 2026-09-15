import { useRef, useState } from 'react';
import type { Fils } from '@avo/types';
import { Button, Card, EmptyState, InfoBanner, InlineError, Money, Pill, Skeleton } from '@avo/ui';
import type { PlatformAccount } from '../../api/platformAccounts.js';
import type { VoucherList as VoucherListData } from '../../api/vouchers.js';
import {
  REASON_MAX,
  readAmountInput,
  useIssueVoucher,
  useMemberVouchers,
  useVoidVoucher,
  voucherState,
  type Voucher,
  type VoucherState,
} from '../../api/vouchers.js';
import { SectionError, WriteError } from '../sectionState.js';

/**
 * Console → Accounts → one customer's AVO vouchers.
 *
 * `GET /v1/vouchers?memberId=`, `POST /v1/vouchers`, `DELETE /v1/vouchers/:id`,
 * all three `requirePlatform(req, 'accounts')` — the same section as the list
 * this panel opens from.
 *
 * =========================================================================
 * THE DESIGN BUNDLE DRAWS NO VOUCHER SURFACE, AND THAT IS STATED RATHER THAN
 * WORKED AROUND
 * =========================================================================
 * `grep -ril 'coupon\|voucher\|compensat\|gift card' design/` returns NOTHING —
 * not in `AVO Owner Console.dc.html`, not in the merchant dashboard, not in the
 * wallet. Every other screen in this directory is transcribed from a drawn one
 * and cites its line number. This one cannot, because there is no line to cite.
 *
 * So this is a NEW CONTROL rather than a build of a settled design, and the
 * decision is marked here rather than hidden: the layout, the copy and the column
 * order below are this lane's, not the designer's, and they should be reviewed as
 * such. `CLAUDE.md` § "Do not add features" points at `design/README.md` § Known
 * gaps for deliberate omissions; vouchers are not in that list either — the
 * endpoints are simply newer than the bundle (`DECISIONS #87`, migration 0046).
 *
 * =========================================================================
 * WHY IT LIVES INSIDE ACCOUNTS AND NOT IN THE SIDEBAR
 * =========================================================================
 * Three reasons, in the order that decided it:
 *
 * 1. THERE IS NO `vouchers` SECTION TO NAME. `PLATFORM_SECTIONS` has nine and the
 *    API gates all three endpoints on `accounts`. A tenth nav item would have to
 *    declare `section: 'accounts'` in `consoleNavItems.tsx` — and
 *    `consoleNavGates.test.ts` would happily pass it, because the gate really is
 *    `accounts`. The sidebar would then show two doors for one permission, which
 *    is the `salons`-said-`analytics` failure in reverse: a nav that is green
 *    against the server and still wrong about the product.
 *
 * 2. `POST /v1/vouchers` NEEDS A `memberId`, and the accounts list is the only
 *    place in the console that holds one. A standalone section would have to
 *    grow a customer picker, i.e. a second copy of the search this panel is
 *    already standing inside.
 *
 * 3. THE ROUTE FILE'S OWN ARGUMENT. "A voucher is a compensation instrument, and
 *    `accounts` is the console section where a customer's wallet is already
 *    adjusted." The gate is not an accident of implementation; it is where this
 *    belongs, said in code.
 *
 * IT IS A PANEL AND NOT A ROUTE, for `Accounts.tsx`'s exact reason. A
 * `/console/accounts/$id/vouchers` URL can be bookmarked, and a bookmarked load
 * has no account row to have opened it — so it would render a customer's
 * compensation history above a heading that could not say whose, because there is
 * still no per-account READ endpoint. The panel takes the `PlatformAccount` the
 * row handed it, so the name on the heading is a name the console actually has.
 *
 * =========================================================================
 * TWO THINGS THIS SCREEN DOES NOT DRAW, AND THE ENDPOINT EACH IS WAITING ON
 * =========================================================================
 * 1. THE PLATFORM-WIDE VOUCHER LIST. `GET /v1/vouchers` with no `memberId` is
 *    served, works, and returns every voucher on the platform newest-first — I
 *    drove it. It is not drawn because `serialiseVoucher` sends `memberId` and no
 *    member NAME, and no console endpoint resolves one: `accounts.ts` says a
 *    per-account read is where that would live and there is none. The screen
 *    would be a column of `8842`s over a column of money, and "AVO issued 12.750
 *    KD to 8842" is not an answer anybody can act on. It is waiting on either a
 *    name on that payload or the per-account READ this directory has wanted since
 *    `Accounts.tsx` was written. A list keyed on a customer you already chose
 *    needs neither.
 *
 * 2. A LINK FROM A REDEEMED VOUCHER TO ITS TRANSACTION. `redeemedTransactionId`
 *    is on the wire and is parsed (`api/vouchers.ts § Voucher`). There is no
 *    console endpoint that reads one transaction — `GET /charges` is
 *    `requireScannerPerm`, which no web principal can ever satisfy — so the id
 *    would be a link to nothing. The panel says a voucher was redeemed and when;
 *    it does not offer to show the row, because it cannot. Waiting on a
 *    platform-scoped per-transaction read.
 *
 * Neither is a TODO. Both are controls deliberately absent because the endpoint
 * behind them does not exist, which is this directory's standard: "a control
 * wired to nothing is worse than no control."
 *
 * =========================================================================
 * NON-NEGOTIABLE #5, IN THE COPY
 * =========================================================================
 * "Refunds are wallet credit. No cash, no card reversal, on any surface, ever."
 * The banner says what a voucher IS in those terms, and nothing on this screen
 * uses the words refund, reverse or cash for what the button does. The server
 * says the same thing from the other side when an admin tries to unwind a
 * redeemed one — "Its credit is in the customer’s wallet and cannot be taken back
 * here" — and `WriteError` renders that verbatim rather than softening it.
 */
export function AccountVouchers({
  account,
  panelId,
  onClose,
}: {
  /** The row that opened this. Carries the name no endpoint would serve. */
  account: PlatformAccount;
  /** Matches the opening button's `aria-controls`. */
  panelId: string;
  onClose: () => void;
}) {
  const vouchers = useMemberVouchers(account.id);
  const issue = useIssueVoucher();
  const voidOne = useVoidVoucher();

  return (
    <Card className="vouchers" flush>
      <div className="vouchers__head">
        <h2 className="vouchers__h2 avo-display">Vouchers · {account.name}</h2>
        <Button variant="quiet" onClick={onClose}>
          Close
        </Button>
      </div>

      <div className="vouchers__body" id={panelId} role="region" aria-label={`Vouchers for ${account.name}`}>
        <InfoBanner icon={<VoucherGlyph />}>
          A voucher is wallet credit {account.name.split(' ')[0]} redeems herself, with a code AVO
          generates. Issuing one moves no money; the credit arrives when she redeems it.
        </InfoBanner>

        <IssueForm
          account={account}
          busy={issue.isPending}
          error={issue.error}
          failed={issue.isError}
          /*
           * RESOLVES TO WHETHER THE VOUCHER WAS ACTUALLY ISSUED, and the form
           * clears only on `true` — `Shop.tsx`'s `onSave` shape, for a reason this
           * screen learned the hard way.
           *
           * It was written as a plain `mutate` with the fields cleared
           * immediately, and driving a real 403 through it showed the defect:
           * `WriteError` said "No voucher was issued to Dana Al-Sabah" above a form
           * that had already thrown away the amount and the reason she typed. The
           * banner's whole job is "the screen is still showing what you typed and
           * the record is unchanged", and half of that was false.
           */
          onSubmit={(input) =>
            issue
              .mutateAsync({ memberId: account.id, ...input })
              .then(() => true)
              .catch(() => false)
          }
        />

        {/*
          A failed VOID, reported above the list rather than on the row, for
          `Accounts.tsx`'s reason: the row may have been refetched away by the
          time the answer lands, and an error that can disappear is an error
          nobody reads. `reassurance` names what did not happen, which on a
          compensation instrument is the whole question.
        */}
        {voidOne.isError ? (
          <WriteError error={voidOne.error} reassurance="That voucher is unchanged." />
        ) : null}

        <VoucherList
          account={account}
          isPending={vouchers.isPending}
          isError={vouchers.isError}
          error={vouchers.error}
          isFetching={vouchers.isFetching}
          onRetry={() => void vouchers.refetch()}
          data={vouchers.data ?? null}
          voiding={voidOne.isPending ? (voidOne.variables?.id ?? null) : null}
          onVoid={(id) => voidOne.mutate({ id, memberId: account.id })}
        />
      </div>
    </Card>
  );
}

/* --------------------------------------------------------------- the list -- */

/**
 * TAKES THE FOUR FACTS, NOT THE QUERY OBJECT, and that is so the four states can
 * be RENDERED in a test rather than grepped for.
 *
 * `stateCensus.test.ts` proves this file has the vocabulary; only rendering
 * proves the 403 arrives without a Try again button and that the empty state says
 * whose list is empty. `shopRender.test.tsx` makes the same argument for the same
 * reason, and a component that took `UseQueryResult` could only be exercised by
 * standing up a real query client and a fake transport.
 */
export function VoucherList({
  account,
  isPending,
  isError,
  error,
  isFetching,
  onRetry,
  data,
  voiding,
  onVoid,
}: {
  account: PlatformAccount;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  isFetching: boolean;
  onRetry: () => void;
  data: VoucherListData | null;
  voiding: string | null;
  onVoid: (id: string) => void;
}) {
  /*
   * THE ERROR AND OFFLINE ANSWERS ARE THIS PANEL'S OWN, not its host's.
   *
   * `Accounts.tsx` reads `GET /v1/platform/accounts` and this reads
   * `GET /v1/vouchers` — two routes that fail independently even though they
   * share one section, which is `ShopOrders`'s ruling ("SAME GATE, WHICH IS NOT
   * THE SAME THING AS ONE READ"). A voucher fetch that times out must not be
   * reported as the accounts list failing, and the accounts list landing says
   * nothing about whether this one has.
   *
   * THE 403 ARM IS REACHABLE ONLY BY MID-SESSION REVOCATION, and it is built
   * anyway. In the ordinary case an analyst without `accounts` is refused by the
   * LIST and this panel never mounts — so the refusal she sees is
   * `Accounts.tsx`'s. But `Admins.tsx` § the chips posts a PATCH that the server
   * re-reads on the next request, so `accounts` can be revoked while this panel
   * is open, and the next refetch answers 403 into exactly this arm. Non-negotiable
   * #7's point is that the server refuses whatever the UI did; a screen that
   * assumed the refusal away would be the UI claiming to be the control.
   */
  if (isError) {
    return (
      <SectionError
        error={error}
        forbiddenTitle="You don't have access to vouchers"
        failedTitle="Couldn't load vouchers"
        onRetry={onRetry}
        retrying={isFetching}
      />
    );
  }

  if (isPending || data === null) {
    return (
      <ul className="vouchers__list" aria-busy="true">
        {[0, 1, 2].map((n) => (
          <li key={n} className="vouchers__row">
            <Skeleton width="34%" height={15} />
            <Skeleton width="58%" height={12} />
          </li>
        ))}
      </ul>
    );
  }

  const items = data.items;

  if (items.length === 0) {
    return (
      /*
       * NAMES WHAT FILLS IT. "No vouchers" alone reads as a fact about the
       * product; this says whose list is empty and what puts a row in it — the
       * form directly above, which is the one action available here.
       */
      <EmptyState
        title={`No vouchers for ${account.name}`}
        body="AVO has not issued her any compensation. Issue one above and it appears here with its code."
      />
    );
  }

  return (
    <>
      <ul className="vouchers__list">
        {items.map((v) => (
          <VoucherRow
            key={v.id}
            voucher={v}
            voiding={voiding === v.id}
            onVoid={() => onVoid(v.id)}
          />
        ))}
      </ul>
      {/*
        THE CAP, SAID OUT LOUD. `LIMIT 200` with an honest `truncated` beside it;
        dropping it here is the defect `stateCensus.test.ts` § "a capped list does
        not report itself as complete" pins on `ShopOrders`, and this list has the
        same shape. Unreachable for a normal customer and rendered anyway — an
        account with 200 vouchers is the account somebody is looking at for a
        reason.
      */}
      {data.truncated ? (
        <p className="vouchers__truncated" role="status">
          Showing the 200 most recent vouchers. Older ones are not listed.
        </p>
      ) : null}
    </>
  );
}

/* ---------------------------------------------------------------- the row -- */

const STATE_LABEL: Record<VoucherState, string> = {
  redeemable: 'Redeemable',
  redeemed: 'Redeemed',
  void: 'Void',
  expired: 'Expired',
};

const STATE_TONE: Record<VoucherState, 'brand' | 'neutral' | 'quiet'> = {
  redeemable: 'brand',
  redeemed: 'neutral',
  void: 'quiet',
  expired: 'quiet',
};

/** `15 Sep 2026`. The console is English-only by decision — `design/README.md` § Known gaps 1. */
function day(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function VoucherRow({
  voucher,
  voiding,
  onVoid,
}: {
  voucher: Voucher;
  voiding: boolean;
  onVoid: () => void;
}) {
  const state = voucherState(voucher);

  return (
    <li className="vouchers__row" data-state={state}>
      <div className="vouchers__rowtop">
        {/*
          `Money` and not a hand-rolled `/1000 .toFixed(3)` — non-negotiable #1's
          display boundary has one implementation in `@avo/types` and this is a
          call to it. It also carries the aria-label that makes `12.750` read as
          "twelve point seven five zero Kuwaiti dinars" rather than as a number.
        */}
        <Money amount={voucher.amountFils} withUnit className="vouchers__amount" />
        <code className="vouchers__code">{voucher.code}</code>
        <Pill tone={STATE_TONE[state]}>{STATE_LABEL[state]}</Pill>
      </div>

      <div className="vouchers__reason">{voucher.reason}</div>

      <div className="vouchers__meta">
        <span>Issued {day(voucher.createdAt)}</span>
        {/*
          The one date that matters for each state, and only that one. Listing
          every timestamp a row carries would make three of the four states read
          as a changelog of something that happened once.
        */}
        {state === 'redeemed' && voucher.redeemedAt !== null ? (
          <span>Redeemed {day(voucher.redeemedAt)}</span>
        ) : null}
        {state === 'void' && voucher.voidedAt !== null ? (
          <span>Voided {day(voucher.voidedAt)}</span>
        ) : null}
        {state === 'expired' && voucher.expiresAt !== null ? (
          <span>Expired {day(voucher.expiresAt)}</span>
        ) : null}
        {state === 'redeemable' && voucher.expiresAt !== null ? (
          <span>Expires {day(voucher.expiresAt)}</span>
        ) : null}
      </div>

      {/*
        VOID IS OFFERED ON A LIVE ROW ONLY, and it is a courtesy over the
        handler's WHERE clause rather than the control — see
        `api/vouchers.ts § useVoidVoucher`. `voucherState` reads the server's own
        `redeemable`, never a browser-clock comparison, so a row this button is
        withheld from is a row the server would refuse.
      */}
      {state === 'redeemable' ? (
        <div className="vouchers__rowactions">
          <Button
            variant="secondary"
            disabled={voiding}
            onClick={onVoid}
            aria-label={`Void the ${voucher.code} voucher`}
          >
            {voiding ? 'Voiding…' : 'Void'}
          </Button>
        </div>
      ) : null}
    </li>
  );
}

/* --------------------------------------------------------------- the form -- */

export function IssueForm({
  account,
  busy,
  error,
  failed,
  onSubmit,
}: {
  account: PlatformAccount;
  busy: boolean;
  error: unknown;
  failed: boolean;
  /** Resolves true when the voucher was issued. See the call site. */
  onSubmit: (input: { amountFils: Fils; reason: string; expiresAt?: string }) => Promise<boolean>;
}) {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [expiry, setExpiry] = useState('');
  const amountRef = useRef<HTMLInputElement>(null);

  const parsed = readAmountInput(amount);
  const trimmedReason = reason.trim();

  /*
   * THE SERVER'S THREE REFUSALS, PRE-EMPTED IN ITS OWN TERMS rather than
   * duplicated loosely. Each was driven against a real API and the code is named
   * beside the rule so a drift is findable:
   *
   *   invalid_amount   "amountFils must be a positive whole number of fils. A
   *                     voucher only adds."          -> readAmountInput
   *   invalid_request  "reason is required."          -> trimmedReason !== ''
   *   invalid_expiry   "expiresAt must be in the future."
   *                                                   -> expiryOk below
   *
   * NONE OF THESE IS A CONTROL. Every one is enforced server-side and would
   * refuse with this whole block deleted; `WriteError` renders the sentence if
   * one gets through. What they buy is that an admin is not told about a typo by
   * a round trip.
   */
  const expiryOk = expiry === '' || new Date(`${expiry}T23:59:59`).getTime() > Date.now();
  const ready = parsed.kind === 'ok' && trimmedReason !== '' && expiryOk && !busy;

  async function submit() {
    if (parsed.kind !== 'ok' || trimmedReason === '' || !expiryOk) return;
    const issued = await onSubmit({
      amountFils: parsed.amountFils,
      reason: trimmedReason,
      /*
       * A DATE INPUT IS A DAY AND THE API TAKES AN INSTANT. The end of that day
       * is the reading that matches what an admin means by "expires on the 31st"
       * — an expiry at 00:00 would kill the voucher the night before the date she
       * typed. Sent as a real ISO instant in her own timezone offset, which
       * `new Date(...).toISOString()` resolves.
       */
      ...(expiry === '' ? {} : { expiresAt: new Date(`${expiry}T23:59:59`).toISOString() }),
    });
    /*
     * ONLY ON SUCCESS. A refused issue leaves the amount, the reason and the
     * expiry exactly where she typed them, so `WriteError`'s "No voucher was
     * issued" sits above a form she can correct and resubmit rather than above
     * three empty fields. Driven: a real 403 cleared the form before this guard
     * existed.
     */
    if (!issued) return;
    setAmount('');
    setReason('');
    setExpiry('');
    amountRef.current?.focus();
  }

  return (
    <div className="vouchers__form">
      <h3 className="vouchers__h3">Issue a voucher</h3>

      <div className="vouchers__formgrid">
        <div className="avo-field">
          <div className="avo-field__top">
            <label className="avo-label" htmlFor="voucher-amount">
              Amount
            </label>
            <span className="vouchers__unit">KD</span>
          </div>
          <input
            id="voucher-amount"
            ref={amountRef}
            className="avo-input"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.000"
            value={amount}
            onChange={(e) => setAmount(e.currentTarget.value)}
          />
        </div>

        <div className="avo-field">
          <div className="avo-field__top">
            <label className="avo-label" htmlFor="voucher-reason">
              Reason
            </label>
            <span className="vouchers__count">
              {trimmedReason.length}/{REASON_MAX}
            </span>
          </div>
          <input
            id="voucher-reason"
            className="avo-input"
            autoComplete="off"
            maxLength={REASON_MAX}
            placeholder="Late appointment, 12 Sep"
            value={reason}
            onChange={(e) => setReason(e.currentTarget.value)}
          />
        </div>

        <div className="avo-field">
          <div className="avo-field__top">
            <label className="avo-label" htmlFor="voucher-expiry">
              Expires
            </label>
            <span className="vouchers__count">Optional</span>
          </div>
          <input
            id="voucher-expiry"
            className="avo-input"
            type="date"
            value={expiry}
            onChange={(e) => setExpiry(e.currentTarget.value)}
          />
        </div>
      </div>

      {/*
        THERE IS NO CODE FIELD, AND THE ABSENCE IS THE DESIGN — `Admins.tsx`'s
        missing password field, one door along. `POST /v1/vouchers` refuses a
        client-supplied `code` BY NAME (400 `code_not_client_supplied`) because "a
        console that chose the code could choose a guessable one". The sentence is
        on the screen rather than only in this comment, because the person it
        matters to is the admin, who would otherwise go looking for the field.
      */}
      <p className="vouchers__note">
        AVO generates the code. It appears on her voucher below once it is issued — read it to
        her, or she will find it in her wallet.
      </p>

      {parsed.kind === 'invalid' ? <InlineError message={parsed.message} /> : null}
      {!expiryOk ? <InlineError message="An expiry has to be in the future." /> : null}

      {failed ? (
        <WriteError error={error} reassurance={`No voucher was issued to ${account.name}.`} />
      ) : null}

      <div className="vouchers__formactions">
        <Button disabled={!ready} onClick={() => void submit()}>
          {busy ? 'Issuing…' : 'Issue voucher'}
        </Button>
      </div>
    </div>
  );
}

/** A tag. Drawn here rather than imported — the design has no voucher glyph to take. */
function VoucherGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M3 6.5A1.5 1.5 0 0 1 4.5 5h11A1.5 1.5 0 0 1 17 6.5v1a1.75 1.75 0 0 0 0 3.5v2A1.5 1.5 0 0 1 15.5 15h-11A1.5 1.5 0 0 1 3 13.5v-2a1.75 1.75 0 0 0 0-3.5z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M11.5 7.5v5" stroke="currentColor" strokeWidth="1.5" strokeDasharray="1.5 2" />
    </svg>
  );
}
