-- ===========================================================================
-- SHE CHOOSES WHERE TO COLLECT
--
-- The client, verbatim: "on the cart page, Collect it is good, but from which
-- branch if they have multiple". Until this migration there was no answer: a
-- pickup order named no location, and a two-branch salon's board could not say
-- which counter to put the bag on.
--
-- ---------------------------------------------------------------------------
-- A PICKUP BRANCH IS NOT AN ATTRIBUTION BRANCH, AND IT IS A SEPARATE COLUMN
-- ---------------------------------------------------------------------------
-- `transaction.branch_id` answers "where did this money move?" and is resolved
-- by the SERVER (`services/branch.ts`), because a client that names it names
-- its own reporting bucket and, on a charge, its own boost multiplier. That rule
-- stands and `POST /orders` still refuses `branchId` by name.
--
-- `shop_order.pickup_branch_id` answers a different question — "where will she
-- physically collect?" — which is genuinely hers to answer. So it lives on the
-- FULFILMENT, beside the delivery address it is the pickup-side twin of, and it
-- is validated by the server rather than resolved by it: an OPEN branch of HER
-- OWN salon, or the order is refused.
--
-- Whether the order's revenue is then ATTRIBUTED to the branch she chose is a
-- separate decision taken in `services/order.ts` (it is: a shop order earns no
-- per-branch boost, so the choice buys her nothing), and not something this
-- column implies.
--
-- ---------------------------------------------------------------------------
-- THE CONSTRAINTS
-- ---------------------------------------------------------------------------
--   shop_order_pickup_branch_same_salon_fk
--       (pickup_branch_id, salon_id) → branch(id, salon_id). TENANCY IN THE
--       SCHEMA: a shop order cannot name another salon's branch even if a code
--       path forgets to check. `branch_id_salon_uq` (0043) is the target, the
--       same composite key `device_enrolment` and `artist` (0044) point at.
--       MATCH SIMPLE, so a NULL pickup branch is not checked — see below.
--
--   shop_order_pickup_branch_only_on_pickup
--       A delivery order carries no pickup branch. "Delivery to Salmiya's
--       counter" is not a storable state, for the reason
--       `shop_order_delivery_has_an_address` refuses a pickup with a street.
--
-- WHY A PICKUP ORDER MAY STILL HAVE A NULL ONE. Orders placed before this
-- migration at a MULTI-branch salon were never asked, and inventing an answer
-- for them would be a location nobody chose printed on a board as fact. They
-- stay NULL, and the API serves `pickupBranch: null` — "not chosen". Every order
-- placed from here on carries one: `services/order.ts § resolveFulfilment`
-- requires it (or defaults it, single-branch), and `delivery.int.test.ts`
-- pins that. A `CHECK (fulfilment <> 'pickup' OR pickup_branch_id IS NOT NULL)
-- NOT VALID` was considered and rejected: Postgres re-checks a NOT VALID CHECK
-- on every UPDATE, so the first `preparing → ready` on a legacy row would fail.
--
-- ON DELETE restrict, as every branch reference is: branches are CLOSED, never
-- deleted (`db/schema/salon.ts § closedAt`).
-- ===========================================================================

ALTER TABLE "shop_order" ADD COLUMN "pickup_branch_id" text;
--> statement-breakpoint
ALTER TABLE "shop_order" ADD CONSTRAINT "shop_order_pickup_branch_same_salon_fk"
  FOREIGN KEY ("pickup_branch_id", "salon_id") REFERENCES "branch"("id", "salon_id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "shop_order" ADD CONSTRAINT "shop_order_pickup_branch_only_on_pickup"
  CHECK ("fulfilment" = 'pickup' OR "pickup_branch_id" IS NULL);
--> statement-breakpoint
-- What a branch closure counts: orders still waiting to be collected there.
-- Partial, because a closed order is history and the preview never asks for it.
CREATE INDEX "shop_order_pickup_branch_open_idx"
  ON "shop_order" ("pickup_branch_id")
  WHERE "pickup_branch_id" IS NOT NULL AND "status" <> 'closed';
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- THE BACKFILL: ONLY WHERE THE ANSWER WAS ALREADY A FACT.
--
-- A legacy pickup order whose `shop` transaction was NOT `branch_assumed` was
-- placed at a salon with exactly one open branch — `resolveBranch` returns
-- `established` for nothing else on this path, since a phone has no enrolled
-- device. There was nowhere else to collect it, so that branch is where it is
-- collected, and saying so is a record rather than a guess.
--
-- An ASSUMED transaction's branch is alphabetical order talking
-- (`services/reports.ts § branch_assumed`), and copying it here would turn a
-- sort order into a counter she is expected at. Those rows stay NULL.
-- ---------------------------------------------------------------------------
UPDATE "shop_order" o
   SET "pickup_branch_id" = t."branch_id"
  FROM "transaction" t
 WHERE t."id" = o."transaction_id"
   AND o."fulfilment" = 'pickup'
   AND o."pickup_branch_id" IS NULL
   AND t."branch_assumed" = false;
