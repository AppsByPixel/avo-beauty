-- ===========================================================================
-- 0014 - a charge may be fully covered by a held deposit
--
-- FOUND BY BUILDING THE DEPOSIT CREDIT LINE, not by reading the schema.
--
-- `transaction_amount_sign_matches_kind` (migration 0000) says:
--
--     kind IN ('charge','deposit_hold','shop')  ->  amount_fils < 0
--
-- which was right while `heldDepositFils` was hardcoded to 0, because a charge's
-- amount was always the whole basket and a service price is always positive.
--
-- With deposits real, the charge row records what was debited AFTER the held
-- deposit was applied - the design's "8.000 service - 5.000 deposit = 3.000
-- charged". A 6.000 manicure against a 10.000 deposit (the contract's maximum)
-- therefore debits NOTHING further, and `amount_fils = 0` failed this CHECK with
-- a 500 at the counter. The remaining 4.000 comes back as its own
-- `deposit_return`, so no money is lost either way; what was missing was the
-- ability to record a visit that took nothing more from the wallet.
--
-- WHY `<= 0` AND NOT A RELAXATION OF THE WHOLE CONSTRAINT
-- The constraint's job is that a debit kind cannot credit. Zero is neither, and
-- a zero-amount charge is a real event: a visit happened, loyalty increments, the
-- booking completes, a receipt goes out, and the wallet was not touched again.
-- What must stay forbidden is a POSITIVE charge - a charge that pays the customer
-- - and it still is.
--
-- Only `charge` is widened. `deposit_hold` and `shop` stay strictly negative:
-- `salon.deposit_fils` is CHECKed between 1000 and 10000 so a zero hold cannot
-- arise, and a zero-priced order is the "free service is a rounding bug waiting
-- to be argued about at a counter" case that `service_price_positive` already
-- refuses. Widening them would buy the ability to write a meaningless row.
--
-- LOCKING: dropping and re-adding a CHECK takes ACCESS EXCLUSIVE on `transaction`
-- and re-validates every row. On a pilot-sized table that is milliseconds. Before
-- a large production table it should be scheduled, or split into ADD CONSTRAINT
-- ... NOT VALID followed by VALIDATE CONSTRAINT, which takes only a SHARE UPDATE
-- EXCLUSIVE lock for the scan. Said here rather than found during a deploy.
-- ===========================================================================

ALTER TABLE "transaction" DROP CONSTRAINT "transaction_amount_sign_matches_kind";--> statement-breakpoint

ALTER TABLE "transaction" ADD CONSTRAINT "transaction_amount_sign_matches_kind" CHECK (
  ("kind" IN ('topup', 'deposit_return') AND "amount_fils" > 0)
  OR ("kind" = 'charge' AND "amount_fils" <= 0)
  OR ("kind" IN ('deposit_hold', 'shop') AND "amount_fils" < 0)
  OR ("kind" = 'adjustment' AND "amount_fils" <> 0)
);
