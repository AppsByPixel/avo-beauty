-- ===========================================================================
-- 0012 - transaction.branch_assumed: the branch we guessed, marked as a guess
--
-- WHAT WENT WRONG
-- `transaction.branch_id` is NOT NULL, because TransactionSchema.branchId is and
-- both clients render it unconditionally. So every money path needed a value,
-- and both of them - services/charge.ts and services/topup.ts - reached for the
-- same private helper:
--
--     SELECT id FROM branch WHERE salon_id = $1 ORDER BY id LIMIT 1
--
-- That is a defensible way to ATTRIBUTE a row and an indefensible way to decide
-- what a customer EARNS. The first live charge on a two-branch salon doubled a
-- customer's visits: the branches are BR-KWC and BR-SAL, BR-KWC sorts first, and
-- Kuwait City carried a 2x visit boost. Nobody chose that. Alphabetical order
-- chose it, and nothing recorded that a choice had been made at all.
--
-- WHAT THIS COLUMN IS FOR, AND WHAT IT IS NOT
-- It is NOT the fix for the money. That is fixed at the source and needs no
-- schema: an unestablished branch matches no boost and no branch-scoped happy
-- hour - services/branch.ts, and services/promotions.ts section PromotionInputs,
-- where NULL means "not known" rather than "no branch".
--
-- This is the fix for the REPORTING half, which the earning fix does not touch.
-- Per-branch revenue is a figure a merchant acts on. Without this column a
-- defaulted row is indistinguishable from a real one forever, and the only
-- honest answer to "is this branch total right" is "we cannot tell". With it,
-- the answer is a WHERE clause:
--
--     SELECT branch_id, count(*) FILTER (WHERE branch_assumed) AS guessed
--     FROM transaction GROUP BY branch_id;
--
-- WHY NOT REFUSE THE CHARGE INSTEAD
-- Refusing when the branch is ambiguous was the other option on the table. It
-- would take every multi-branch salon offline until device enrolment ships, to
-- fix an attribution defect whose money impact is already nil. The money is safe
-- either way; what was wrong is that a guess was presented as a fact.
--
-- DEFAULT FALSE, AND THE BACKFILL IS DELIBERATELY OPTIMISTIC
-- Existing rows get `false`, which claims their branch was established. For most
-- of them that is true - a single-branch salon has nothing to guess - and for
-- charges at multi-branch salons written before this landed it is not. It is not
-- recoverable after the fact: nothing stored says whether the old helper fell
-- back or not, which is precisely the defect. Marking every historical row
-- `true` would be equally wrong in the other direction and would bury the real
-- ones. So: false, said out loud here, and correct from this migration forward.
--
-- THE REAL FIX, still owed: a branch-bound scanner session, so a charge knows
-- where it happened. StaffPrincipal carries branch ACCESS, which is a permission
-- and not a location. That waits on the device-enrolment decision. When it
-- lands, this column goes all-false on its own and stops earning its keep -
-- which is the right shape for a column that exists to measure a known gap.
-- ===========================================================================

ALTER TABLE "transaction"
  ADD COLUMN "branch_assumed" boolean DEFAULT false NOT NULL;
--> statement-breakpoint

-- Partial, because the interesting rows are the rare ones. Once a scanner
-- session establishes the branch this index is empty and costs nothing, and
-- until then it makes "show me every figure that rests on a guess" cheap.
CREATE INDEX IF NOT EXISTS "transaction_branch_assumed_idx"
  ON "transaction" ("salon_id", "created_at" DESC)
  WHERE "branch_assumed";
