-- ===========================================================================
-- AN APPOINTMENT THE FRONT DESK WROTE, FOR SOMEBODY WHO MAY NOT HAVE AN ACCOUNT
--
-- Client asks 5 and 6: admin creates appointments by hand, for existing OR
-- non-existing customers, and can mark / cancel / move / reassign them.
--
-- `booking` was modelled as A MONEY ROW WITH A CALENDAR ATTACHED — its own
-- header says so — and FOUR of its constraints assume the money exists:
-- `member_id` NOT NULL, `hold_transaction_id` NOT NULL,
-- `booking_deposit_positive`, and `booking_settlement_matches_status`. A walk-in
-- written down by a receptionist has no member row, no wallet, no hold and no
-- deposit, so all four refuse her.
--
-- THE SHAPE OF THIS MIGRATION IS "LET THE MONEYLESS ROWS THROUGH, AND CHANGE
-- NOTHING ELSE". Every relaxation below is made SOURCE-AWARE or HOLD-AWARE, so
-- that a row which HAS a hold is governed by exactly the constraint set it was
-- governed by yesterday. The `app` state machine is not weakened by one bit; it
-- is re-expressed with an explicit antecedent that was previously implied by
-- `hold_transaction_id NOT NULL`.
--
-- ---------------------------------------------------------------------------
-- WHY THERE IS NO SECOND TABLE. THIS IS THE WHOLE POINT OF THE MIGRATION.
-- ---------------------------------------------------------------------------
-- The obvious alternative was `manual_appointment`, leaving `booking` pristine.
-- It is the wrong answer and the reason is one line:
--
--   `booking_artist_slot_no_overlap` (migration 0013) is an
--   `EXCLUDE USING gist (artist_id WITH =, tstzrange(starts_at, ends_at) WITH &&)`
--   and an exclusion constraint CANNOT SPAN TWO TABLES.
--
-- A manual appointment in its own table and an app booking in this one could sit
-- on the same artist at the same instant, and nothing in the database would say
-- so. A customer who paid a deposit and a walk-in who did not would arrive at
-- 16:45 for the same chair. That makes hand-entry WORSE than the paper diary it
-- replaces — the diary at least has one page per artist. So: one table, one
-- exclusion constraint, and the constraints that assumed money are the ones that
-- move.
--
-- THE EXCLUSION CONSTRAINT ITSELF IS NOT TOUCHED, AND DOES NOT NEED TO BE. Its
-- predicate is `WHERE status IN ('deposit_held','completed')`, and a live
-- merchant booking is `deposit_held` — the contract keeps four status values and
-- renders "Booked"/"No-show" from `deposit_fils = 0` at the display boundary
-- (`packages/types § BookingSchema`), precisely so that no enum widening is
-- needed here. A merchant row therefore enters the SAME index, under the SAME
-- predicate, as an app row, from the moment it is inserted. Nothing about
-- overlap detection is conditional on `source`, and that is deliberate: the one
-- guarantee this feature must not make source-aware is the one that stops two
-- people being sold one chair.
--
-- ---------------------------------------------------------------------------
-- THE FOUR RELAXATIONS, EACH WITH WHAT AN `app` ROW STILL CANNOT DO
-- ---------------------------------------------------------------------------
--
--   member_id DROP NOT NULL
--     An `app` booking still cannot have a null member: the new
--     `booking_identity_exactly_one` requires exactly one of
--     (member_id, guest_name), and `booking_guest_requires_merchant_source`
--     permits a guest name only on `source = 'merchant'`. Together they say
--     "`app` ⇒ member_id IS NOT NULL", which is what the dropped NOT NULL said.
--
--   hold_transaction_id DROP NOT NULL
--     An `app` booking still cannot have a null hold: the new
--     `booking_deposit_matches_hold` makes the hold and a positive deposit
--     equivalent, and `booking_merchant_is_zero_deposit` confines zero deposits
--     to `merchant` rows. So an `app` or `google_calendar` row has
--     `deposit_fils > 0` — nothing writes a zero one — and therefore a hold.
--
--   booking_deposit_positive  ->  booking_deposit_matches_hold
--                                 + booking_deposit_non_negative
--     The old check said `deposit_fils > 0`. The new pair says
--     `deposit_fils >= 0` AND `(deposit_fils > 0) = (hold_transaction_id IS NOT NULL)`.
--     For any row with a hold — every `app` row — the conjunction still forces
--     `deposit_fils > 0`, exactly the old constraint. The floor is re-stated
--     separately because the biconditional alone would accept a NEGATIVE deposit
--     on a hold-less row (`-5000 > 0` is false, and so is `hold IS NOT NULL`),
--     which is the kind of hole a "relaxation" quietly opens.
--
--   booking_settlement_matches_status  ->  conditional on there being a hold
--     Old:  (status = 'deposit_held') = (settled_transaction_id IS NULL)
--     New:  CASE WHEN hold_transaction_id IS NOT NULL
--             THEN (status = 'deposit_held') = (settled_transaction_id IS NULL)
--             ELSE settled_transaction_id IS NULL
--           END
--     The THEN branch is the old text, character for character, and every `app`
--     row takes it — so an app booking still cannot be completed without naming
--     the charge that consumed the hold, and still cannot be cancelled without
--     naming the refund. The ELSE branch is strictly a NEW prohibition on rows
--     that never existed before: a settled transaction may never appear on a row
--     that had no hold. Nothing was permitted that was not permitted yesterday.
--
-- ---------------------------------------------------------------------------
-- THE NEW CHECKS
-- ---------------------------------------------------------------------------
--   booking_identity_exactly_one        a booking names a member OR a guest,
--                                       never both, never neither.
--   booking_guest_requires_merchant_source
--                                       an `app` booking always names a member.
--                                       A guest can only be written by hand.
--   booking_guest_phone_requires_guest_name
--                                       a phone number with no name attached is
--                                       an orphan piece of a customer's personal
--                                       data sitting in a salon's database.
--   booking_deposit_matches_hold        money and the hold are the same fact.
--   booking_deposit_non_negative        the floor the biconditional loses.
--   booking_merchant_is_zero_deposit    NON-NEGOTIABLE #2, AS A DATABASE FACT.
--                                       A merchant-created booking for an
--                                       existing member could technically debit
--                                       her wallet and must not: a merchant who
--                                       can move a customer's money by filling
--                                       in a form can move it without her. The
--                                       same reasoning that stops a merchant
--                                       sending a customer a message (#8). The
--                                       handler refuses it too; this is the layer
--                                       that holds when someone edits the
--                                       handler.
--
-- ---------------------------------------------------------------------------
-- THE ENUM VALUE, AND WHY THE CHECKS BELOW SAY `source::text`
-- ---------------------------------------------------------------------------
-- Postgres allows `ALTER TYPE … ADD VALUE` inside a transaction but refuses to
-- USE the new value in the same transaction, and drizzle's migrator runs a file
-- as one transaction. Migration 0028 hit this and settled the form: compare
-- `source::text` against a string literal. Same constraint, expressed in a form
-- this transaction is allowed to evaluate.
--
-- LOCKING: two ADD COLUMNs with no default (catalog-only from PG 11); two DROP
-- NOT NULLs (catalog-only); one ALTER TYPE ADD VALUE (brief catalog lock); and
-- seven CHECK constraints, six added and one replaced, which DO scan `booking`.
-- That scan is bounded by the appointment table and is unavoidable if the
-- constraints are to be true of the rows already there.
--
-- GRANTS: no new table, no new grant. 0001's defaults still cover `booking`.
--
-- Idempotent and safe to re-run.
-- ===========================================================================

ALTER TYPE "public"."booking_source" ADD VALUE IF NOT EXISTS 'merchant';--> statement-breakpoint

-- --------------------------------------------------------------- the guest --
ALTER TABLE "booking" ADD COLUMN IF NOT EXISTS "guest_name" text;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN IF NOT EXISTS "guest_phone" text;--> statement-breakpoint

-- ------------------------------------------------- the two dropped NOT NULLs --
ALTER TABLE "booking" ALTER COLUMN "member_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "booking" ALTER COLUMN "hold_transaction_id" DROP NOT NULL;--> statement-breakpoint

-- ------------------------------------------------------------ the identity --
ALTER TABLE "booking" DROP CONSTRAINT IF EXISTS "booking_identity_exactly_one";--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_identity_exactly_one"
  CHECK (num_nonnulls("member_id", "guest_name") = 1);--> statement-breakpoint

ALTER TABLE "booking" DROP CONSTRAINT IF EXISTS "booking_guest_requires_merchant_source";--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_guest_requires_merchant_source"
  CHECK ("guest_name" IS NULL OR "source"::text = 'merchant');--> statement-breakpoint

ALTER TABLE "booking" DROP CONSTRAINT IF EXISTS "booking_guest_phone_requires_guest_name";--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_guest_phone_requires_guest_name"
  CHECK ("guest_phone" IS NULL OR "guest_name" IS NOT NULL);--> statement-breakpoint

-- --------------------------------------------------------------- the money --
ALTER TABLE "booking" DROP CONSTRAINT IF EXISTS "booking_deposit_positive";--> statement-breakpoint

ALTER TABLE "booking" DROP CONSTRAINT IF EXISTS "booking_deposit_non_negative";--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_deposit_non_negative"
  CHECK ("deposit_fils" >= 0);--> statement-breakpoint

ALTER TABLE "booking" DROP CONSTRAINT IF EXISTS "booking_deposit_matches_hold";--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_deposit_matches_hold"
  CHECK (("deposit_fils" > 0) = ("hold_transaction_id" IS NOT NULL));--> statement-breakpoint

ALTER TABLE "booking" DROP CONSTRAINT IF EXISTS "booking_merchant_is_zero_deposit";--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_merchant_is_zero_deposit"
  CHECK ("source"::text <> 'merchant' OR "deposit_fils" = 0);--> statement-breakpoint

-- ------------------------------------------------------- the state machine --
-- The THEN branch is the old constraint verbatim. See the header.
ALTER TABLE "booking" DROP CONSTRAINT IF EXISTS "booking_settlement_matches_status";--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_settlement_matches_status"
  CHECK (
    CASE WHEN "hold_transaction_id" IS NOT NULL
      THEN ("status" = 'deposit_held') = ("settled_transaction_id" IS NULL)
      ELSE "settled_transaction_id" IS NULL
    END
  );
