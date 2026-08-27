/**
 * EVERY LEDGER LEG POSTS TO THE ACCOUNT IT IS SUPPOSED TO — asserted BY ACCOUNT.
 *
 * =========================================================================
 * WHAT WAS MISSING, MEASURED
 * =========================================================================
 * Counted across every test file in this repository before this spec existed:
 *
 *     member_wallet             3 occurrences
 *     avo_commission            0
 *     salon_revenue             0
 *     merchant_bonus_funding    0
 *     gateway_clearing          0
 *     deposit_held              0
 *
 * Every ledger assertion in the build was a NET BY DIRECTION —
 * `e2e/adjustments.test.ts` sums `case when direction='credit' then amount_fils
 * else -amount_fils end` filtered by member, and `topupReaper.int.test.ts`
 * counts rows. Both are true of a correct ledger and equally true of a ledger
 * that swapped `avo_commission` with `salon_revenue`, because the net still
 * balances and neither names an account.
 *
 * -------------------------------------------------------------------------
 * AND THE ONE ACCOUNT THAT WAS NAMED IS THE ONE THAT COULD NOT MOVE
 * -------------------------------------------------------------------------
 * The three `member_wallet` mentions are the least valuable three in the set.
 * Two CHECK constraints from migration 0001 already pin that leg —
 * `ledger_entry_wallet_requires_member` and
 * `ledger_entry_balance_after_is_wallet_only` — so moving the wallet account
 * anywhere fails the INSERT. The five accounts nothing asserted are exactly the
 * five carrying neither `member_id` nor `balance_after_fils`, and therefore
 * exactly the five that are freely interchangeable as far as the schema, the
 * balanced-pair trigger and every net in the suite are concerned.
 *
 * So the assertions here are deliberately about the NON-WALLET leg. The wallet
 * legs are asserted too, because they are cheap and they pin the direction, but
 * they are not where the gap was.
 *
 * There is no second net to fall back on: the daily reconciliation job that
 * would compare this ledger against the processor's does not exist yet, so a
 * misposting is invisible end to end rather than caught at month end.
 *
 * =========================================================================
 * DERIVED FROM `LEDGER_ACCOUNTS`, NOT FROM A LIST TYPED HERE
 * =========================================================================
 * `LEDGER_ACCOUNTS` is `ledgerAccount.enumValues` — the schema enum itself. The
 * coverage spec iterates it and fails on any label no builder posts to, so a
 * seventh account is covered on the day it is added to the enum rather than on
 * the day somebody remembers this file. That is the technique
 * `services/campaignAudience.test.ts` and `e2e/support/source-enums.ts` both
 * use, and the bug it exists to stop: `audience: "lapsed"` answered 500 for the
 * whole life of `POST /campaigns` because every spec pinned its own literal at
 * its own call site.
 *
 * The count is asserted too. Without it, an emptied enum would make every
 * derived spec vanish and this file would report green with nothing run.
 *
 * =========================================================================
 * WHY THESE ARE UNIT SPECS
 * =========================================================================
 * Because the account choice never needed a database — see money/ledger.ts §
 * WHY PURE FUNCTIONS. `vitest.int.config.ts` is not in `pnpm check` and says at
 * length why, so an assertion that needs `AVO_INT_DATABASE_URL` runs when
 * somebody remembers to point it at a lane database, and one over these
 * functions runs on every merge.
 *
 * The cost is stated in the module header: this proves what a posting NAMES, not
 * that the row reached Postgres. § THE BUILDERS ARE THE ONLY PLACE below is what
 * stops that cost growing — a re-inlined account literal anywhere in `api/src`
 * turns this file red.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { commissionFor, fils, type Fils } from '@avo/types';
import { describe, expect, it } from 'vitest';
import {
  chargeReversedPosting,
  depositAppliedPosting,
  depositHeldPosting,
  depositReleasedPosting,
  LEDGER_ACCOUNTS,
  type LedgerPosting,
  merchantFundedCreditPosting,
  topUpSettledPosting,
  walletAdjustedPosting,
  walletSpendPosting,
} from './ledger';

const TX = 'TX-0000001';
const SALON = 'SAL-AMARA';
const MEMBER = '8842';

/** `{account, direction, amountFils}` per leg, order-insensitive. */
const legs = (
  postings: LedgerPosting[],
): Array<{ account: string; direction: string; amountFils: number }> =>
  postings
    .map((p) => ({ account: p.account, direction: p.direction, amountFils: p.amountFils }))
    .sort((a, b) => a.account.localeCompare(b.account));

const accountsOf = (postings: LedgerPosting[]): string[] => postings.map((p) => p.account);

/** Credits minus debits — the property every existing assertion in the suite had. */
const net = (postings: LedgerPosting[]): number =>
  postings.reduce((n, p) => n + (p.direction === 'credit' ? p.amountFils : -p.amountFils), 0);

/**
 * ============================================================================
 * THE FIXTURE TOP-UP, AND IT IS THE ONE READ OUT OF THE DEMO SEED BY HAND
 * ============================================================================
 * A 20.000 KD KNET top-up, no bonus. The four rows it produces were read
 * straight off `ledger_entry` while validating the demo seed:
 *
 *     seq  transaction_id  account           direction  amount_fils  balance_after
 *      7   TX-9824041      gateway_clearing  debit            20000
 *      8   TX-9824041      member_wallet     credit           20000  20000
 *      9   TX-9824041      salon_revenue     debit              150
 *     10   TX-9824041      avo_commission    credit             150
 *
 * The customer's wallet is credited IN FULL and the flat commission moves FROM
 * the salon TO AVO. The commission is 150 because KNET is 150 fils flat; the
 * expected value comes from `commissionFor` rather than the literal 150, so this
 * spec cannot disagree with `packages/types/src/money.test.ts` about the rate.
 */
const KNET_20KD = {
  transactionId: TX,
  salonId: SALON,
  memberId: MEMBER,
  amountFils: fils(20_000),
  creditFils: fils(20_000),
  bonusFils: fils(0),
  promoBonusFils: fils(0),
  feeFils: commissionFor(fils(20_000), 'knet'),
  balanceAfterFils: fils(20_000),
} as const;

/**
 * The same top-up on a card, which is 2.5% + 50 rather than a flat 150, and a
 * Gold member so both merchant-funded bonuses fire.
 *
 * 20.000 paid, 20% tier bonus = 4.000, a 1.000 promotion bonus on top, so
 * 25.000 lands in the wallet against a 20.000 payment. The 5.000 difference is
 * the merchant's, and `merchant_bonus_funding` is what makes the ledger balance.
 */
const CARD_20KD_WITH_BONUS = {
  transactionId: TX,
  salonId: SALON,
  memberId: MEMBER,
  amountFils: fils(20_000),
  creditFils: fils(25_000),
  bonusFils: fils(4_000),
  promoBonusFils: fils(1_000),
  feeFils: commissionFor(fils(20_000), 'card'),
  balanceAfterFils: fils(25_000),
} as const;

const wallet = (amountFils: Fils, balanceAfterFils: Fils) => ({
  transactionId: TX,
  salonId: SALON,
  memberId: MEMBER,
  amountFils,
  balanceAfterFils,
});

/**
 * Every posting the build writes, by the movement it represents. The coverage
 * spec below reduces over this, so a builder added to `money/ledger.ts` and not
 * added here leaves its accounts uncovered only if they are covered nowhere else
 * — which is the point of driving coverage off the enum rather than off this
 * table.
 */
const POSTINGS: Record<string, LedgerPosting[]> = {
  'top-up settled, KNET, no bonus': topUpSettledPosting(KNET_20KD),
  'top-up settled, card, tier + promo bonus': topUpSettledPosting(CARD_20KD_WITH_BONUS),
  'wallet spend (counter charge, shop order)': walletSpendPosting(
    wallet(fils(8_000), fils(16_500)),
  ),
  'deposit applied to a completed visit': depositAppliedPosting({
    transactionId: TX,
    salonId: SALON,
    amountFils: fils(5_000),
  }),
  'deposit held out of the wallet': depositHeldPosting(wallet(fils(5_000), fils(19_500))),
  'deposit released back to the wallet': depositReleasedPosting(
    wallet(fils(5_000), fils(24_500)),
  ),
  'merchant-funded happy-hour credit': merchantFundedCreditPosting(
    wallet(fils(3_000), fils(27_500)),
  ),
  'charge voided': chargeReversedPosting(wallet(fils(8_000), fils(32_500))),
  'owner console credit': walletAdjustedPosting({
    transactionId: TX,
    salonId: SALON,
    memberId: MEMBER,
    deltaFils: 2_500,
    balanceAfterFils: fils(35_000),
  }),
  'owner console debit': walletAdjustedPosting({
    transactionId: TX,
    salonId: SALON,
    memberId: MEMBER,
    deltaFils: -2_500,
    balanceAfterFils: fils(32_500),
  }),
};

// ============================================================================
describe('LEDGER_ACCOUNTS — coverage is derived from the schema enum', () => {
  it('has the six accounts the schema declares', () => {
    // Not redundant with the loop below: an emptied enum would make every
    // derived spec vanish and this file would report green with nothing run.
    expect(LEDGER_ACCOUNTS).toHaveLength(6);
    expect([...LEDGER_ACCOUNTS].sort()).toEqual([
      'avo_commission',
      'deposit_held',
      'gateway_clearing',
      'member_wallet',
      'merchant_bonus_funding',
      'salon_revenue',
    ]);
  });

  const posted = new Set(Object.values(POSTINGS).flatMap(accountsOf));

  for (const account of LEDGER_ACCOUNTS) {
    it(`\`${account}\` is posted to by at least one money path`, () => {
      expect(
        posted.has(account),
        `No posting in money/ledger.ts names \`${account}\`, so nothing in ` +
          `\`pnpm check\` would notice if a leg that should reach it went somewhere ` +
          `else. If this account is new, add the builder that posts to it and a case ` +
          `for it in POSTINGS. If it is genuinely unused, remove it from the ` +
          `\`ledgerAccount\` enum rather than leaving an account no path writes and ` +
          `no reconciliation reads.`,
      ).toBe(true);
    });
  }
});

// ============================================================================
describe('every posting balances — the property the old net-by-direction assertions had', () => {
  /**
   * KEPT DELIBERATELY, AND IT IS THE CONTRAST THIS FILE IS ABOUT.
   *
   * This is exactly what `e2e/adjustments.test.ts` asserts, restated over the
   * pure builders. It passes for every posting below AND it passes with any two
   * non-wallet accounts swapped — which is why it was never enough on its own.
   * The by-account specs that follow are strictly stronger; this one is here so
   * the difference is visible in the same file rather than argued about.
   */
  for (const [name, postings] of Object.entries(POSTINGS)) {
    it(`${name}: credits equal debits`, () => {
      expect(postings.length).toBeGreaterThanOrEqual(2);
      expect(net(postings)).toBe(0);
    });
  }
});

// ============================================================================
describe('top-up — the commission pair, by account', () => {
  it('KNET 20.000: four rows, and the commission moves FROM the salon TO AVO', () => {
    const p = topUpSettledPosting(KNET_20KD);
    expect(p).toHaveLength(4);
    expect(legs(p)).toEqual([
      { account: 'avo_commission', direction: 'credit', amountFils: 150 },
      { account: 'gateway_clearing', direction: 'debit', amountFils: 20_000 },
      { account: 'member_wallet', direction: 'credit', amountFils: 20_000 },
      { account: 'salon_revenue', direction: 'debit', amountFils: 150 },
    ]);
  });

  /**
   * THE MISPOSTING THIS FILE EXISTS TO CATCH, named on its own.
   *
   * The loop above would catch it, but a named spec is what a bisect run reads,
   * and this is the pair that has to keep working. Reversed, AVO would be paying
   * the salon a commission on every top-up in the country and every other
   * assertion in the repository would still pass.
   */
  it('commission is DEBITED from salon_revenue and CREDITED to avo_commission, not the reverse', () => {
    for (const input of [KNET_20KD, CARD_20KD_WITH_BONUS]) {
      const p = topUpSettledPosting(input);
      const commission = p.filter((e) => e.amountFils === input.feeFils);

      const avo = commission.find((e) => e.account === 'avo_commission');
      const salon = commission.find((e) => e.account === 'salon_revenue');

      expect(avo, 'no avo_commission leg — commission is AVO income and must be credited to it').toBeDefined();
      expect(salon, 'no salon_revenue leg — commission is the merchant\'s cost and must be debited from it').toBeDefined();
      expect(avo?.direction, 'avo_commission must be CREDITED: commission is income to AVO').toBe('credit');
      expect(salon?.direction, 'salon_revenue must be DEBITED: commission is a cost to the salon').toBe('debit');
      // Neither leg touches a wallet, which is exactly why nothing else catches
      // a swap: no member to require, no balance_after to reject.
      expect(avo?.memberId ?? null).toBeNull();
      expect(salon?.memberId ?? null).toBeNull();
    }
  });

  it('card commission is 2.5% + 50, and it is the same pair', () => {
    const p = topUpSettledPosting(CARD_20KD_WITH_BONUS);
    // 20.000 KD → 500 + 50 = 550 fils. From `commissionFor`, not typed here.
    expect(CARD_20KD_WITH_BONUS.feeFils).toBe(550);
    expect(p.find((e) => e.account === 'avo_commission')).toMatchObject({
      direction: 'credit',
      amountFils: 550,
    });
    expect(p.find((e) => e.account === 'salon_revenue')).toMatchObject({
      direction: 'debit',
      amountFils: 550,
    });
  });

  it('a wallet-method top-up with no commission writes no commission pair at all', () => {
    // A zero row is refused by `ledger_entry_amount_positive`, so the legs are
    // omitted rather than written as zeroes.
    const p = topUpSettledPosting({ ...KNET_20KD, feeFils: fils(0) });
    expect(p).toHaveLength(2);
    expect(accountsOf(p)).not.toContain('avo_commission');
    expect(accountsOf(p)).not.toContain('salon_revenue');
    expect(net(p)).toBe(0);
  });

  it('credits the wallet IN FULL — the commission is not deducted from her credit', () => {
    const p = topUpSettledPosting(KNET_20KD);
    const w = p.find((e) => e.account === 'member_wallet');
    expect(w).toMatchObject({ direction: 'credit', amountFils: 20_000 });
    expect(w?.balanceAfterFils).toBe(20_000);
    // The customer never sees commission. It is the merchant's cost, and the
    // gateway leg is what the PSP is holding — her full payment.
    expect(p.find((e) => e.account === 'gateway_clearing')).toMatchObject({
      direction: 'debit',
      amountFils: 20_000,
    });
  });
});

// ============================================================================
describe('bonus funding is the SALON\'s money — never AVO\'s, never revenue', () => {
  /**
   * CLAUDE.md's non-negotiables, as an assertion. A tier bonus is advertised by
   * the salon and funded by the salon; `avo_commission` here would say AVO buys
   * the salon's loyalty programme, and `salon_revenue` would say the bonus is
   * value the salon delivered rather than value it gave away.
   */
  it('both merchant-funded bonuses land on merchant_bonus_funding, on one debit', () => {
    const p = topUpSettledPosting(CARD_20KD_WITH_BONUS);
    const funding = p.filter((e) => e.account === 'merchant_bonus_funding');
    expect(funding).toHaveLength(1);
    // 4.000 tier + 1.000 promotion, one debit. `transaction.promotion_id` is
    // what separates a campaign's cost from a tier's in a report.
    expect(funding[0]).toMatchObject({ direction: 'debit', amountFils: 5_000 });
    expect(funding[0]?.memberId ?? null).toBeNull();
  });

  it('the bonus is never charged to avo_commission', () => {
    const p = topUpSettledPosting(CARD_20KD_WITH_BONUS);
    const avo = p.filter((e) => e.account === 'avo_commission');
    expect(avo).toHaveLength(1);
    expect(avo[0]?.amountFils, 'avo_commission carries the commission and nothing else').toBe(
      CARD_20KD_WITH_BONUS.feeFils,
    );
  });

  it('a happy-hour credit is funded by the merchant, same account as a tier bonus', () => {
    const p = merchantFundedCreditPosting(wallet(fils(3_000), fils(27_500)));
    expect(legs(p)).toEqual([
      { account: 'member_wallet', direction: 'credit', amountFils: 3_000 },
      { account: 'merchant_bonus_funding', direction: 'debit', amountFils: 3_000 },
    ]);
  });

  it('no top-up posting ever writes zero, whatever the bonus and fee', () => {
    for (const bonus of [0, 1, 4_000]) {
      for (const fee of [0, 150, 550]) {
        const p = topUpSettledPosting({
          ...KNET_20KD,
          bonusFils: fils(bonus),
          promoBonusFils: fils(0),
          creditFils: fils(20_000 + bonus),
          balanceAfterFils: fils(20_000 + bonus),
          feeFils: fils(fee),
        });
        expect(
          p.every((e) => e.amountFils > 0),
          `bonus=${bonus} fee=${fee} produced a zero row, which ` +
            '`ledger_entry_amount_positive` refuses — a 500 at the counter.',
        ).toBe(true);
        expect(net(p)).toBe(0);
      }
    }
  });
});

// ============================================================================
describe('spend, deposits and reversals — by account', () => {
  it('a wallet spend credits salon_revenue, never avo_commission', () => {
    const p = walletSpendPosting(wallet(fils(8_000), fils(16_500)));
    expect(legs(p)).toEqual([
      { account: 'member_wallet', direction: 'debit', amountFils: 8_000 },
      { account: 'salon_revenue', direction: 'credit', amountFils: 8_000 },
    ]);
    // AVO takes commission when money ENTERS through a PSP. A charge moves an
    // existing balance, which is why `transaction.fee_fils` stays 0 on this path.
    expect(accountsOf(p)).not.toContain('avo_commission');
  });

  it('a deposit is HELD as a liability, not booked as revenue', () => {
    const p = depositHeldPosting(wallet(fils(5_000), fils(19_500)));
    expect(legs(p)).toEqual([
      { account: 'deposit_held', direction: 'credit', amountFils: 5_000 },
      { account: 'member_wallet', direction: 'debit', amountFils: 5_000 },
    ]);
    expect(accountsOf(p)).not.toContain('salon_revenue');
  });

  it('applying a deposit discharges the liability INTO revenue, in that direction', () => {
    const p = depositAppliedPosting({
      transactionId: TX,
      salonId: SALON,
      amountFils: fils(5_000),
    });
    expect(legs(p)).toEqual([
      { account: 'deposit_held', direction: 'debit', amountFils: 5_000 },
      { account: 'salon_revenue', direction: 'credit', amountFils: 5_000 },
    ]);
    // NEITHER LEG TOUCHES A WALLET ACCOUNT, so neither CHECK constraint applies
    // and a swap here is invisible to the database. This is the sharpest example
    // of the class of misposting this file exists to catch.
    expect(p.every((e) => e.balanceAfterFils === undefined)).toBe(true);
  });

  it('applying a deposit names NOBODY — and nets to zero for her, which is true', () => {
    /**
     * DECISIONS.md #64. This builder took a `memberId` and services/charge.ts § 7
     * passed `m.id`, making it the one `deposit_held` leg in the build that named
     * a member. The field is gone from the signature, so the call site cannot
     * reintroduce it without a type error — see § no non-wallet leg names a
     * member below for the assertion that covers the builders as a class.
     *
     * The consequence is arithmetic, not cosmetic. Her balance moved when the
     * deposit was HELD; applying it moves money between two accounts that are
     * neither of them hers. A per-member net over `ledger_entry.member_id` —
     * which is what `e2e/adjustments.test.ts` asserts the ledger against — must
     * therefore be ZERO across this posting. With `m.id` it was −5.000, counting
     * the deposit against her a second time on every completed booking.
     */
    const p = depositAppliedPosting({
      transactionId: TX,
      salonId: SALON,
      amountFils: fils(5_000),
    });
    expect(
      p.filter((e) => e.memberId !== null),
      'a deposit_held leg named a member; escrow is not her spendable balance',
    ).toEqual([]);
    expect(
      net(p.filter((e) => e.memberId === MEMBER)),
      'applying a deposit moved her per-member ledger net, but not her balance',
    ).toBe(0);
  });

  it('releasing a deposit returns WALLET CREDIT — non-negotiable #5', () => {
    const p = depositReleasedPosting(wallet(fils(5_000), fils(24_500)));
    expect(legs(p)).toEqual([
      { account: 'deposit_held', direction: 'debit', amountFils: 5_000 },
      { account: 'member_wallet', direction: 'credit', amountFils: 5_000 },
    ]);
    // Wallet credit, not a gateway reversal. `gateway_clearing` here would be a
    // card refund the ledger has no authority to claim happened.
    expect(accountsOf(p)).not.toContain('gateway_clearing');
  });

  it('a void debits salon_revenue — including the deposit portion', () => {
    const p = chargeReversedPosting(wallet(fils(8_000), fils(32_500)));
    expect(legs(p)).toEqual([
      { account: 'member_wallet', direction: 'credit', amountFils: 8_000 },
      { account: 'salon_revenue', direction: 'debit', amountFils: 8_000 },
    ]);
    // The deposit stopped being a `deposit_held` liability the moment the charge
    // discharged it into revenue. Crediting it back would reopen a liability
    // nobody holds and leave that account permanently out.
    expect(accountsOf(p)).not.toContain('deposit_held');
    // And a refund is never AVO's to pay.
    expect(accountsOf(p)).not.toContain('avo_commission');
  });

  it('the deposit release posting is byte-identical for both its callers', () => {
    // services/charge.ts § 7a (remainder) and services/booking.ts (no-show or
    // cancellation) were two hand-written copies of this pair. One function now,
    // so a correction cannot land on one caller and miss the other.
    const remainder = depositReleasedPosting(wallet(fils(2_000), fils(26_500)));
    const noShow = depositReleasedPosting(wallet(fils(2_000), fils(26_500)));
    expect(remainder).toEqual(noShow);
  });
});

// ============================================================================
describe('owner console adjustment — direction and magnitude cannot disagree', () => {
  it('a credit credits the wallet and debits gateway_clearing', () => {
    const p = walletAdjustedPosting({
      transactionId: TX,
      salonId: SALON,
      memberId: MEMBER,
      deltaFils: 2_500,
      balanceAfterFils: fils(35_000),
    });
    expect(legs(p)).toEqual([
      { account: 'gateway_clearing', direction: 'debit', amountFils: 2_500 },
      { account: 'member_wallet', direction: 'credit', amountFils: 2_500 },
    ]);
    // NOT `salon_revenue`. A goodwill credit is not a service delivered, and
    // booking it as revenue would inflate the salon's earnings by every apology.
    expect(accountsOf(p)).not.toContain('salon_revenue');
  });

  it('a debit mirrors it exactly', () => {
    const p = walletAdjustedPosting({
      transactionId: TX,
      salonId: SALON,
      memberId: MEMBER,
      deltaFils: -2_500,
      balanceAfterFils: fils(32_500),
    });
    expect(legs(p)).toEqual([
      { account: 'gateway_clearing', direction: 'credit', amountFils: 2_500 },
      { account: 'member_wallet', direction: 'debit', amountFils: 2_500 },
    ]);
  });

  it('never writes a negative amount_fils, whatever the sign of the delta', () => {
    for (const delta of [-50_000, -1, 1, 50_000]) {
      const p = walletAdjustedPosting({
        transactionId: TX,
        salonId: SALON,
        memberId: MEMBER,
        deltaFils: delta,
        balanceAfterFils: fils(10_000),
      });
      expect(p.every((e) => e.amountFils > 0)).toBe(true);
      expect(net(p)).toBe(0);
    }
  });
});

// ============================================================================
describe('the wallet leg is the only one the schema pins — so the rest are checked here', () => {
  /**
   * Not a style rule. `ledger_entry_wallet_requires_member` and
   * `ledger_entry_balance_after_is_wallet_only` are what make a wallet
   * misposting fail the INSERT, and asserting them here documents WHY the
   * non-wallet assertions above are the load-bearing ones.
   */
  for (const [name, postings] of Object.entries(POSTINGS)) {
    it(`${name}: every member_wallet leg names a member and carries a balance`, () => {
      for (const e of postings.filter((p) => p.account === 'member_wallet')) {
        expect(e.memberId, 'ledger_entry_wallet_requires_member would refuse this').toBeTruthy();
        expect(
          e.balanceAfterFils,
          'a wallet leg with no balance_after_fils leaves the wallet unrecomputable',
        ).toBeTypeOf('number');
      }
    });

    it(`${name}: no non-wallet leg carries balance_after_fils`, () => {
      for (const e of postings.filter((p) => p.account !== 'member_wallet')) {
        expect(
          e.balanceAfterFils ?? null,
          `\`${e.account}\` carries balance_after_fils, which ` +
            '`ledger_entry_balance_after_is_wallet_only` refuses.',
        ).toBeNull();
      }
    });

    /**
     * THE THIRD DIRECTION, AND THE ONLY ONE THE DATABASE LEAVES OPEN.
     *
     * The two specs above restate CHECK constraints — the INSERT fails without
     * them, so they document rather than defend. This one defends. Read the
     * constraint as written:
     *
     *   ledger_entry_wallet_requires_member
     *     account <> 'member_wallet' OR member_id IS NOT NULL
     *
     * That is wallet ⟹ member, and NOTHING ELSE. A `deposit_held`,
     * `salon_revenue`, `avo_commission`, `gateway_clearing` or
     * `merchant_bonus_funding` row carrying a `member_id` is perfectly legal to
     * Postgres. Compare `ledger_entry_balance_after_is_wallet_only`, which the
     * schema DOES state in the non-wallet direction — so the asymmetry is real,
     * and this is the half of it nothing was checking.
     *
     * It went unchecked for the life of `POST /charges` (DECISIONS.md #64), and
     * the cost was a per-member ledger net that drifted by the deposit on every
     * completed booking. Asserted over every posting rather than at the one call
     * site that had it wrong, because the site that has it wrong next will be a
     * different one — the lesson of `campaignAudience`'s `lapsed` audience.
     */
    it(`${name}: no non-wallet leg names a member`, () => {
      for (const e of postings.filter((p) => p.account !== 'member_wallet')) {
        expect(
          e.memberId,
          `\`${e.account}\` names a member. \`member_id\` means "this row moved ` +
            'this member\'s own spendable balance", and a non-wallet leg by ' +
            'definition did not — the wallet leg beside it is the row that names ' +
            'her. Postgres will NOT refuse this row: ' +
            '`ledger_entry_wallet_requires_member` only constrains the wallet ' +
            'direction. Nothing else catches it either, so a per-member net over ' +
            '`ledger_entry.member_id` silently stops equalling her balance ' +
            'movement. See DECISIONS.md #64.',
        ).toBeNull();
      }
    });
  }
});

// ============================================================================
describe('THE BUILDERS ARE THE ONLY PLACE IN api/src THAT NAMES A LEDGER ACCOUNT', () => {
  /**
   * WHAT THIS GUARDS, AND WHY IT IS A GREP.
   *
   * Everything above proves what the builders return. None of it proves a money
   * path still CALLS one — a re-inlined `account: 'salon_revenue'` literal in a
   * `tx.insert(ledgerEntry)` would leave every spec in this file green and put
   * the untested posting back exactly where it was.
   *
   * That is not a hypothetical shape of mistake in this repository: the whole
   * reason this file exists is a decision that lived at ten call sites and was
   * asserted at none. So the invariant is enforced rather than documented — the
   * account labels appear in `money/ledger.ts`, in the enum that declares them,
   * and nowhere else under `api/src`.
   *
   * A new legitimate writer of the ledger adds a builder here and calls it. If
   * one genuinely cannot (an account chosen from a row, which none is today),
   * add it to `ALLOWED` with the reason — deliberately, in a diff somebody
   * reviews, rather than by a literal nobody notices.
   */
  const SRC = join(import.meta.dirname, '..');

  /** Declares the enum, and this spec's own fixtures and expectations. */
  const ALLOWED = new Set([
    join(SRC, 'db/schema/ledger.ts'),
    join(SRC, 'money/ledger.ts'),
    join(SRC, 'money/ledger.test.ts'),
  ]);

  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });

  const files = walk(SRC).filter((f) => f.endsWith('.ts') && !ALLOWED.has(f));

  it('found the source tree to scan', () => {
    // A failed walk would silently pass every spec below with nothing scanned.
    expect(files.length).toBeGreaterThan(50);
  });

  for (const account of LEDGER_ACCOUNTS) {
    it(`no file outside money/ledger.ts writes \`account: '${account}'\``, () => {
      const offenders = files.filter((f) =>
        new RegExp(`account:\\s*'${account}'`).test(readFileSync(f, 'utf8')),
      );
      expect(
        offenders.map((f) => f.slice(SRC.length + 1)),
        `These files name \`${account}\` directly instead of calling a builder in ` +
          'money/ledger.ts. An inlined account literal is exactly the untested ' +
          'decision this module was created to end: every spec in ledger.test.ts ' +
          'would stay green while the posting it describes is bypassed. Add a ' +
          'builder, or call an existing one.',
      ).toEqual([]);
    });
  }
});
