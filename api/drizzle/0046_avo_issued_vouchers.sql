-- ---------------------------------------------------------------------------
-- AVO-ISSUED VOUCHERS.                              (item 10, DECISIONS #87)
--
-- Compensation was ALREADY BUILT: `POST /members/{id}/adjustments`, a complete
-- money path with a required `reason`, gated `requirePlatform(req,'accounts')` so
-- only AVO can do it. What is new is the voucher OBJECT — a code a customer
-- redeems, rather than a credit an admin pushes.
--
-- THE RULING THAT SHAPES EVERYTHING: REDEMPTION CREDITS THE WALLET. It does not
-- discount a charge. That keeps this entirely off `POST /charges` — the most
-- sensitive transaction in the product — and it matches non-negotiable #5's
-- semantics: value arrives as wallet credit and nothing else.
--
-- WHAT SURVIVES OF LEAN'S COUPON: `couponText` (the code) and nothing else. Its
-- `minimumAmountIsCart` and its `optionType`/`optionList` product restriction
-- both presuppose a BASKET, and a wallet credit has none — a credit is not a
-- purchase. Both are OMITTED rather than accepted and ignored: a rule that can
-- never fire is the dead-guard shape, and there are already columns in this build
-- that exist for a check nobody reaches.
--
-- Lean's enforcement is entirely client-side — `applyDiscount` finds the code in
-- the app, compares the total in the app, filters products in the app. So the
-- client decides what a thing costs. Here the code is resolved server-side,
-- eligibility is evaluated server-side, and the client submits a CODE, never an
-- amount and never a discount.
--
-- =========================================================================
-- BOUND TO A MEMBER, NOT A BEARER CODE — `member_id` IS NOT NULL
-- =========================================================================
-- The request was "coupons or vouchers for compensations of customer": AVO
-- apologising to a named person. Binding the voucher to her makes a leaked code
-- worthless to anybody else, and turns redemption into an ownership check rather
-- than an enumeration target — which is most of why the indistinguishable
-- refusal below costs so little.
--
-- NOT NULL rather than nullable-for-a-future-bearer-variant, deliberately. A
-- nullable column with no code path behind it is a dead field, and this project
-- has already paid for one of those. A bearer voucher is a different risk profile
-- — who it credits, what stops one code draining a budget, what rate limit
-- applies — so it is a migration and a decision, not a spare column.
--
-- =========================================================================
-- THE PROVENANCE, WHICH IS THE POINT TRUNK ADDED
-- =========================================================================
-- That a credit came from an AVO voucher is a FACT KNOWN AT WRITE TIME. Who
-- settles it is a POLICY APPLIED LATER. So this migration records the first and
-- models none of the second: no settlement status, no reimbursement, no opinion
-- about who owes whom.
--
-- It is recorded in the LEDGER, as a new account. `avo_voucher_funding` is
-- debited and `member_wallet` credited, which is exactly the shape
-- `merchant_bonus_funding` already has for the merchant-funded half of a tier
-- bonus — an account exists there precisely so a report can tell whose money
-- funded a credit. So:
--
--     SELECT sum(amount_fils) FROM ledger_entry
--      WHERE account = 'avo_voucher_funding' AND salon_id = $1
--
-- answers "how much AVO-voucher credit entered this salon's wallets", exactly,
-- from one indexed table, with no audit rows and no timestamps involved.
-- `ledger_entry_salon_account_idx` is already `(salon_id, account, created_at)`.
--
-- NO `transaction.voucher_id`, and the asymmetry with `transaction.promotion_id`
-- is argued rather than accidental. A promotion touches MANY transactions, so the
-- pointer has to live on the transaction. A voucher redeems EXACTLY ONCE, so the
-- pointer lives on the voucher (`redeemed_transaction_id`) and a second copy on
-- the transaction would be two places for one fact.
--
-- WHAT THIS DOES *NOT* MAKE TRACEABLE, stated here because the difference is the
-- whole answer: the GRANT is exact and cheap; the SPEND is not traceable at all.
-- A wallet is one number and money in it is fungible — a charge debits
-- `member_wallet` with no notion of which credit it consumed. Answering "how much
-- of that voucher credit has been spent" needs LOTS on the wallet (FIFO layers),
-- which changes the balance model itself and is a far larger question than
-- vouchers. Not built, not stubbed. What the ledger does give without it is the
-- two aggregates that BOUND it — total granted, and her current balance.
-- ---------------------------------------------------------------------------
ALTER TYPE "ledger_account" ADD VALUE 'avo_voucher_funding';
--> statement-breakpoint
CREATE TABLE "voucher" (
  "id" text PRIMARY KEY NOT NULL,
  -- What she types. Unique across the platform because that is all she sends.
  "code" text NOT NULL,
  "member_id" text NOT NULL,
  -- Integer fils, non-negotiable #1. A voucher only ever ADDS, so `> 0` rather
  -- than the signed range `walletAdjustedPosting` handles: an AVO apology that
  -- debited a customer is not a thing this endpoint should be able to express.
  "amount_fils" bigint NOT NULL,
  -- Required, exactly as `POST /members/{id}/adjustments` requires one: "a reason
  -- is an unexplained balance change in a dispute two years later".
  "reason" text NOT NULL,
  -- NULL means no expiry. Not defaulted: how long an apology stays valid is a
  -- commercial decision, and writing one because the column looked empty is the
  -- mistake decisions 80 and 82 are both about.
  "expires_at" timestamp with time zone,

  "issued_by_admin_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,

  -- Redeemed and voided are both terminal and mutually exclusive. THERE IS NO
  -- `status` COLUMN: redeemable is `redeemed_at IS NULL AND voided_at IS NULL AND
  -- (expires_at IS NULL OR expires_at > now())`, which the rows already
  -- determine. A stored status would be a second place for it to live and a
  -- second thing to disagree — the argument decision 81 settled for money.
  "redeemed_at" timestamp with time zone,
  "redeemed_transaction_id" text,
  "voided_at" timestamp with time zone,
  "voided_by_admin_id" text,

  CONSTRAINT "voucher_member_id_member_id_fk"
    FOREIGN KEY ("member_id") REFERENCES "member"("id") ON DELETE restrict,
  CONSTRAINT "voucher_issued_by_platform_admin_id_fk"
    FOREIGN KEY ("issued_by_admin_id") REFERENCES "platform_admin"("id") ON DELETE restrict,
  CONSTRAINT "voucher_voided_by_platform_admin_id_fk"
    FOREIGN KEY ("voided_by_admin_id") REFERENCES "platform_admin"("id") ON DELETE restrict,
  CONSTRAINT "voucher_redeemed_transaction_id_transaction_id_fk"
    FOREIGN KEY ("redeemed_transaction_id") REFERENCES "transaction"("id") ON DELETE restrict,

  CONSTRAINT "voucher_amount_positive" CHECK ("amount_fils" > 0),
  CONSTRAINT "voucher_code_not_blank" CHECK (length(btrim("code")) > 0),
  CONSTRAINT "voucher_reason_not_blank" CHECK (length(btrim("reason")) > 0),
  -- Each terminal state is one fact with two columns; either both or neither.
  CONSTRAINT "voucher_redemption_is_whole"
    CHECK (("redeemed_at" IS NULL) = ("redeemed_transaction_id" IS NULL)),
  CONSTRAINT "voucher_void_is_whole"
    CHECK (("voided_at" IS NULL) = ("voided_by_admin_id" IS NULL)),
  -- And they cannot both have happened. A voucher voided after it was redeemed
  -- would be AVO taking back money already in her wallet, which is a refund
  -- problem wearing a voucher's clothes.
  CONSTRAINT "voucher_is_not_both_redeemed_and_voided"
    CHECK ("redeemed_at" IS NULL OR "voided_at" IS NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "voucher_code_uq" ON "voucher" ("code");
--> statement-breakpoint
CREATE INDEX "voucher_member_idx" ON "voucher" ("member_id", "created_at" DESC);
