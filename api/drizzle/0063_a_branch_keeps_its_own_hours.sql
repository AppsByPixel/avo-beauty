-- ===========================================================================
-- A BRANCH KEEPS ITS OWN HOURS — when it has any.
--
-- The client, for pickup: "please collect during the branch's official working
-- hours", and after hours, say it is closed now and she can collect the next
-- day. Hours existed only on the SALON (`salon.business_hours`, two sessions,
-- because "the Kuwaiti afternoon closure is the norm"). A branch had a name and
-- nothing else, and the wallet was never sent hours at all.
--
-- `branch.business_hours` is an OPTIONAL OVERRIDE, the same `BusinessHours`
-- shape and validated by the same `parseBusinessHours`. NULL MEANS "USE THE
-- SALON'S HOURS", so every branch that exists when this runs keeps exactly the
-- hours it effectively had, and no merchant has to set anything. There is no
-- backfill, deliberately: copying the salon's hours into every branch would
-- freeze today's value, and the next Settings edit of the salon's hours would
-- then silently not reach any branch.
--
-- The API serves the RESOLVED hours (`branch ?? salon`) and which one it is —
-- `routes/salons.ts § serialiseBranch`, `routes/orders.ts § pickupBranchView`.
--
-- THE CHECK IS THE SHAPE'S SKELETON, not its grammar. Both sessions present and
-- each a two-element array; the clock format and "24:00 is a close, never an
-- open" stay in `parseBusinessHours` and `BusinessHoursSchema`, which own them
-- (http/fields.ts § THE DIVISION OF LABOUR). The CHECK exists so a write that
-- bypasses the route cannot store a document the resolver would then serve to
-- every wallet as hours — the `salon.business_hours` defect http/fields.ts
-- records, closed at the column this time rather than after the fact.
--
-- THE COALESCE IS LOAD-BEARING. A missing session makes `-> 'evening'` NULL,
-- the comparison NULL, the whole AND NULL — and a CHECK that evaluates to NULL
-- PASSES. The first draft of this constraint had exactly that hole and stored
-- `{"morning": [...]}` without a murmur; `branchHours.int.test.ts § THE COLUMN`
-- is the spec that caught it.
--
-- NO WEEKDAY DIMENSION. The shape, like the salon's, is one day repeated seven
-- times. A branch closed on Fridays cannot say so here. Reported, not built.
--
-- LOCKING: ADD COLUMN with no default is a catalogue change (ACCESS EXCLUSIVE,
-- held for milliseconds, no rewrite). ADD CONSTRAINT … CHECK scans `branch` —
-- a handful of rows per salon — under the same lock. lock_timeout 3s, the
-- convention, because `resolvePickupBranch` and `resolveBranch` read `branch`
-- FOR SHARE inside money transactions and must not queue behind this for long.
-- ===========================================================================

SET lock_timeout = '3s';--> statement-breakpoint

ALTER TABLE "branch" ADD COLUMN "business_hours" jsonb;
--> statement-breakpoint
ALTER TABLE "branch" ADD CONSTRAINT "branch_business_hours_shape"
  CHECK (
    "business_hours" IS NULL
    OR COALESCE(
      jsonb_typeof("business_hours") = 'object'
      AND jsonb_typeof("business_hours" -> 'morning') = 'array'
      AND jsonb_array_length("business_hours" -> 'morning') = 2
      AND jsonb_typeof("business_hours" -> 'evening') = 'array'
      AND jsonb_array_length("business_hours" -> 'evening') = 2,
      false
    )
  );
--> statement-breakpoint
RESET lock_timeout;
