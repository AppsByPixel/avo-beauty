/**
 * WHICH ACCOUNT EACH LEG OF EACH MONEY MOVEMENT POSTS TO — as pure functions.
 *
 * =========================================================================
 * WHY THIS MODULE EXISTS (DECISIONS.md #58)
 * =========================================================================
 * The ledger was never asserted BY ACCOUNT anywhere in this build. Counted
 * across every test file in the repository before this landed:
 *
 *     member_wallet             3 occurrences
 *     avo_commission            0
 *     salon_revenue             0
 *     merchant_bonus_funding    0
 *     gateway_clearing          0
 *     deposit_held              0
 *
 * Every ledger assertion was a NET BY DIRECTION — `e2e/adjustments.test.ts`
 * sums `case when direction='credit' then amount_fils else -amount_fils end`
 * filtered by member. A balanced net cannot tell `avo_commission` from
 * `salon_revenue`, so the commission leg of a top-up could post to the wrong
 * account — swapping AVO's revenue with the salon's — and the whole suite stayed
 * green. Commission was verified only as `topup_intent.fee_fils`, never as its
 * ledger pair.
 *
 * -------------------------------------------------------------------------
 * THE GAP HAS A PRECISE SHAPE, AND IT IS THE NON-WALLET LEG
 * -------------------------------------------------------------------------
 * Worth stating exactly, because it is what decides where a test is worth
 * writing. Ask of every pair "if these two accounts were swapped, would
 * anything currently catch it?" and the answer splits cleanly:
 *
 *   THE WALLET LEG IS ALREADY PINNED, by two CHECK constraints in migration
 *   0001 — `ledger_entry_wallet_requires_member` (a `member_wallet` row with no
 *   `member_id` is refused) and `ledger_entry_balance_after_is_wallet_only` (a
 *   non-wallet row carrying `balance_after_fils` is refused). Move the wallet
 *   account anywhere and the INSERT fails. So `member_wallet` — the one account
 *   the suite did name — is also the only account that could not have moved
 *   silently anyway.
 *
 *   THE NON-WALLET LEG IS PINNED BY NOTHING. `salon_revenue`,
 *   `avo_commission`, `merchant_bonus_funding`, `gateway_clearing` and
 *   `deposit_held` carry no `member_id` and no `balance_after_fils`, so any one
 *   is interchangeable with any other as far as the schema, the balanced-pair
 *   trigger and every net-by-direction assertion are concerned.
 *
 * That is the class of misposting this module makes assertable, and there is no
 * second net to catch it: the daily reconciliation job that would compare our
 * ledger against the processor's does not exist yet (its own ticket), so a
 * misposting is invisible end to end rather than caught at month end.
 *
 * =========================================================================
 * WHY PURE FUNCTIONS, AND NOT AN INTEGRATION SPEC
 * =========================================================================
 * Because the account choice never needed a database. At all ten call sites the
 * accounts were LITERALS in an object built from scalars that were already
 * resolved — no query decides them, no row decides them. They were unreachable
 * from a unit test only because they sat inside a `tx.insert(...)` argument.
 *
 * That matters, because `vitest.int.config.ts` is not in `pnpm check` and says
 * at length why. An assertion that needs `AVO_INT_DATABASE_URL` runs when
 * somebody remembers to point it at a lane database; an assertion over these
 * functions runs on every merge. So the postings moved out here and the call
 * sites now pass their scalars in.
 *
 * WHAT THAT COSTS, stated plainly: these functions prove the accounts a posting
 * NAMES, not that the row reached Postgres. The insert itself, its transaction
 * boundary and the balanced-pair trigger are still only exercised by `e2e/` and
 * the `.int` suite. A caller that stopped calling a builder, or passed the wrong
 * scalar, is a hole here — which is why the builders are the only place in
 * `api/src` allowed to name a `ledger_account` value (`ledger.test.ts` asserts
 * that, by grep over the source, so a re-inlined literal is a red test).
 *
 * =========================================================================
 * CONSOLIDATION IS DELIBERATE
 * =========================================================================
 * Ten call sites, eight builders. Four pairs were byte-identical postings
 * written out twice:
 *
 *   `walletSpendPosting`      services/charge.ts § 7 and services/order.ts § 7
 *   `depositReleasedPosting`  services/charge.ts § 7a and services/booking.ts
 *
 * They are one function each now, so a correction to a posting cannot land on
 * one caller and miss the other — which is a second, smaller version of the
 * same bug this module is about.
 *
 * The sign convention is the schema's: `amount_fils` is always positive and
 * `direction` carries the sign (db/schema/ledger.ts).
 */

import { add, fils, type Fils } from '@avo/types';
import { ledgerAccount, ledgerEntry } from '../db/schema/ledger';

/** One row, exactly as the table takes it. */
export type LedgerPosting = typeof ledgerEntry.$inferInsert;

/**
 * The account labels, READ OFF THE SCHEMA ENUM rather than retyped.
 *
 * This is what makes `ledger.test.ts`'s coverage exhaustive by construction: a
 * seventh account added to `ledgerAccount` is covered on the day it is added,
 * because the spec iterates this and fails on any label no builder posts to.
 * The technique is `services/campaignAudience.test.ts`'s — a `lapsed` audience
 * answered 500 for the life of an endpoint because every spec pinned its own
 * literal at the call site.
 */
export const LEDGER_ACCOUNTS = ledgerAccount.enumValues;

/** What every posting needs to name, whatever moved. */
export interface PostingRefs {
  transactionId: string;
  salonId: string;
}

/** A posting that touches a customer wallet also names her and her new balance. */
export interface WalletRefs extends PostingRefs {
  memberId: string;
  balanceAfterFils: Fils;
}

/**
 * A KNET/card top-up settling: the four-to-five rows a credit produces.
 *
 * Reading down the debits — the money the PSP is holding for us, the merchant's
 * own funding of the bonus it advertised, and the merchant's commission to AVO.
 * Credits: the customer's wallet, and AVO's income.
 *
 * THE COMMISSION PAIR IS `salon_revenue` DEBIT → `avo_commission` CREDIT, and
 * that direction is the whole reason this module exists. Commission is the
 * merchant's cost and AVO's income; reversed, AVO would be funding the salon out
 * of its own revenue on every top-up in the country, and every existing
 * assertion in the suite would still pass.
 *
 * `merchant_bonus_funding` carries BOTH merchant-funded bonuses on one debit —
 * the tier bonus and any promotion bonus come out of the same pocket, and
 * `transaction.promotion_id` is what separates a campaign's cost from a tier's
 * in a report. It is emphatically NOT `avo_commission` and NOT `salon_revenue`:
 * a tier bonus is the salon's money advertised by the salon, which is what
 * CLAUDE.md's non-negotiables mean by refunds and bonuses never being AVO's.
 *
 * Both conditional legs are omitted when their amount is zero rather than
 * written as a zero row, because `ledger_entry_amount_positive` refuses a zero.
 */
export function topUpSettledPosting(refs: {
  transactionId: string;
  salonId: string;
  memberId: string;
  /** What the customer actually paid the PSP. */
  amountFils: Fils;
  /** What landed in the wallet: the payment plus both bonuses. */
  creditFils: Fils;
  /** Tier bonus, merchant funded. */
  bonusFils: Fils;
  /** Promotion bonus, merchant funded. */
  promoBonusFils: Fils;
  /** AVO's commission on this method and amount. */
  feeFils: Fils;
  balanceAfterFils: Fils;
}): LedgerPosting[] {
  const { transactionId, salonId } = refs;

  const entries: LedgerPosting[] = [
    {
      transactionId,
      salonId,
      memberId: null,
      account: 'gateway_clearing',
      direction: 'debit',
      amountFils: refs.amountFils,
    },
    {
      transactionId,
      salonId,
      memberId: refs.memberId,
      account: 'member_wallet',
      direction: 'credit',
      amountFils: refs.creditFils,
      balanceAfterFils: refs.balanceAfterFils,
    },
  ];

  const merchantFunded = add(refs.bonusFils, refs.promoBonusFils);
  if (merchantFunded > 0) {
    entries.push({
      transactionId,
      salonId,
      memberId: null,
      account: 'merchant_bonus_funding',
      direction: 'debit',
      amountFils: merchantFunded,
    });
  }

  if (refs.feeFils > 0) {
    entries.push(
      {
        transactionId,
        salonId,
        memberId: null,
        account: 'salon_revenue',
        direction: 'debit',
        amountFils: refs.feeFils,
      },
      {
        transactionId,
        salonId,
        memberId: null,
        account: 'avo_commission',
        direction: 'credit',
        amountFils: refs.feeFils,
      },
    );
  }

  return entries;
}

/**
 * The wallet pays the salon: a charge at the counter, or a shop purchase.
 *
 * `salon_revenue` is "value delivered by the salon: services rendered, products
 * sold" (db/schema/ledger.ts), which is both callers. NOT `avo_commission` —
 * AVO takes its cut when money ENTERS through a PSP, and this moves an existing
 * balance with no gateway involved, which is why `transaction.fee_fils` stays 0
 * on both paths.
 */
export function walletSpendPosting(refs: WalletRefs & { amountFils: Fils }): LedgerPosting[] {
  return [
    {
      transactionId: refs.transactionId,
      salonId: refs.salonId,
      memberId: refs.memberId,
      account: 'member_wallet',
      direction: 'debit',
      amountFils: refs.amountFils,
      balanceAfterFils: refs.balanceAfterFils,
    },
    {
      transactionId: refs.transactionId,
      salonId: refs.salonId,
      memberId: null,
      account: 'salon_revenue',
      direction: 'credit',
      amountFils: refs.amountFils,
    },
  ];
}

/**
 * A booking deposit becomes revenue: the visit happened.
 *
 * NEITHER LEG TOUCHES A WALLET ACCOUNT — the money left her spendable balance
 * when the deposit was held, so both accounts here are of the undefended kind
 * and a swap would be invisible to the schema. Reversed, it would re-open a
 * liability nobody holds and drive `salon_revenue` negative by the deposit on
 * every completed booking.
 *
 * -------------------------------------------------------------------------
 * `memberId` IS TAKEN AS AN ARGUMENT, AND THAT IS A REPORTED INCONSISTENCY
 * -------------------------------------------------------------------------
 * This is the ONLY `deposit_held` leg in the build that names a member.
 * `depositHeldPosting` and `depositReleasedPosting` both pass `null`, and
 * `e2e/deposit.test.ts` § "How much is currently HELD" documents `member_id:
 * NULL` on this account as the invariant its query is built around — "only the
 * `member_wallet` leg names her… so 'how much is held for this customer' is not
 * answerable from `ledger_entry` alone; it needs the join through
 * `transaction`."
 *
 * services/charge.ts § 7 has been passing `m.id` here since it was written, so
 * one of three sites disagrees with the other two and with Lane D's stated
 * invariant. Lane D's own query is unaffected — it joins through
 * `transaction.member_id` rather than filtering the ledger's — which is why
 * nothing has caught it.
 *
 * PRESERVED EXACTLY RATHER THAN NORMALISED HERE. Changing it would alter what a
 * money path writes, and this module's job was to make the account choice
 * assertable, not to change it. `ledger.test.ts` pins the current behaviour and
 * names the disagreement so the decision is visible rather than lost.
 */
export function depositAppliedPosting(
  refs: PostingRefs & { memberId: string | null; amountFils: Fils },
): LedgerPosting[] {
  return [
    {
      transactionId: refs.transactionId,
      salonId: refs.salonId,
      memberId: refs.memberId,
      account: 'deposit_held',
      direction: 'debit',
      amountFils: refs.amountFils,
    },
    {
      transactionId: refs.transactionId,
      salonId: refs.salonId,
      memberId: null,
      account: 'salon_revenue',
      direction: 'credit',
      amountFils: refs.amountFils,
    },
  ];
}

/**
 * A deposit is taken: out of the wallet, into a liability the salon has not
 * earned yet.
 *
 * `deposit_held`, not `salon_revenue`. Booking revenue the salon has not
 * delivered is the definition of unearned, and the no-show job may still return
 * it — services/booking.ts unwinds exactly this pair.
 */
export function depositHeldPosting(refs: WalletRefs & { amountFils: Fils }): LedgerPosting[] {
  return [
    {
      transactionId: refs.transactionId,
      salonId: refs.salonId,
      memberId: refs.memberId,
      account: 'member_wallet',
      direction: 'debit',
      amountFils: refs.amountFils,
      balanceAfterFils: refs.balanceAfterFils,
    },
    {
      transactionId: refs.transactionId,
      salonId: refs.salonId,
      memberId: null,
      account: 'deposit_held',
      direction: 'credit',
      amountFils: refs.amountFils,
    },
  ];
}

/**
 * The mirror of the hold: the liability is discharged back into the wallet.
 *
 * Two callers, one posting — the no-show/cancellation return in
 * services/booking.ts, and the remainder in services/charge.ts § 7a when the
 * deposit was larger than the basket.
 *
 * WALLET CREDIT, never cash and never a card reversal (non-negotiable #5).
 */
export function depositReleasedPosting(refs: WalletRefs & { amountFils: Fils }): LedgerPosting[] {
  return [
    {
      transactionId: refs.transactionId,
      salonId: refs.salonId,
      memberId: null,
      account: 'deposit_held',
      direction: 'debit',
      amountFils: refs.amountFils,
    },
    {
      transactionId: refs.transactionId,
      salonId: refs.salonId,
      memberId: refs.memberId,
      account: 'member_wallet',
      direction: 'credit',
      amountFils: refs.amountFils,
      balanceAfterFils: refs.balanceAfterFils,
    },
  ];
}

/**
 * A happy-hour credit into the wallet, funded by the merchant who advertised it.
 *
 * `merchant_bonus_funding`, the SAME account a tier bonus debits on a top-up, so
 * the two are one budget line in a report and `promotion_id` is what separates
 * them. AVO does not fund a salon's promotion; posting this to
 * `avo_commission` or `salon_revenue` would say it does, and nothing outside
 * this module's spec would notice.
 */
export function merchantFundedCreditPosting(
  refs: WalletRefs & { amountFils: Fils },
): LedgerPosting[] {
  return [
    {
      transactionId: refs.transactionId,
      salonId: refs.salonId,
      memberId: null,
      account: 'merchant_bonus_funding',
      direction: 'debit',
      amountFils: refs.amountFils,
    },
    {
      transactionId: refs.transactionId,
      salonId: refs.salonId,
      memberId: refs.memberId,
      account: 'member_wallet',
      direction: 'credit',
      amountFils: refs.amountFils,
      balanceAfterFils: refs.balanceAfterFils,
    },
  ];
}

/**
 * A charge is voided: the refund comes out of `salon_revenue` and back into the
 * wallet.
 *
 * THE WHOLE REFUND, INCLUDING ANY DEPOSIT PORTION, and that is correct rather
 * than a shortcut: the deposit stopped being a `deposit_held` liability the
 * moment the charge discharged it into revenue (services/charge.ts § 7).
 * Crediting `deposit_held` back here would reopen a liability nobody holds and
 * leave that account permanently out.
 *
 * `salon_revenue`, not `avo_commission`. A voided charge never carried
 * commission — see `walletSpendPosting` — so there is nothing of AVO's to give
 * back, and a refund debited from `avo_commission` would make AVO pay for a
 * salon's mistake.
 */
export function chargeReversedPosting(refs: WalletRefs & { amountFils: Fils }): LedgerPosting[] {
  return [
    {
      transactionId: refs.transactionId,
      salonId: refs.salonId,
      memberId: refs.memberId,
      account: 'member_wallet',
      direction: 'credit',
      amountFils: refs.amountFils,
      balanceAfterFils: refs.balanceAfterFils,
    },
    {
      transactionId: refs.transactionId,
      salonId: refs.salonId,
      memberId: null,
      account: 'salon_revenue',
      direction: 'debit',
      amountFils: refs.amountFils,
    },
  ];
}

/**
 * An owner-console wallet adjustment, in either direction.
 *
 * `deltaFils` is SIGNED — positive credits her, negative debits her — and this
 * is the one posting whose directions are computed rather than fixed. Magnitude
 * and direction are derived here together, so they cannot disagree; two
 * independent `deltaFils > 0` ternaries at the call site is how a credit gets
 * written with a debit's sign.
 *
 * `gateway_clearing` is the counterparty because a console adjustment is
 * discretionary money entering or leaving the ecosystem outside a PSP
 * settlement, and clearing is where money in flight sits. It is NOT
 * `salon_revenue`: a goodwill credit is not a service delivered, and booking it
 * as revenue would inflate the salon's earnings report by every apology it ever
 * makes.
 */
export function walletAdjustedPosting(
  refs: PostingRefs & { memberId: string; deltaFils: number; balanceAfterFils: Fils },
): LedgerPosting[] {
  const credited = refs.deltaFils > 0;
  const magnitude = fils(Math.abs(refs.deltaFils));

  return [
    {
      transactionId: refs.transactionId,
      salonId: refs.salonId,
      memberId: refs.memberId,
      account: 'member_wallet',
      direction: credited ? 'credit' : 'debit',
      amountFils: magnitude,
      balanceAfterFils: refs.balanceAfterFils,
    },
    {
      transactionId: refs.transactionId,
      salonId: refs.salonId,
      memberId: null,
      account: 'gateway_clearing',
      direction: credited ? 'debit' : 'credit',
      amountFils: magnitude,
    },
  ];
}
