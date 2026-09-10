-- ---------------------------------------------------------------------------
-- ERASURE REACHES THE ADDRESS, IN BOTH PLACES IT LIVES.   (DECISIONS.md #97)
--
-- Item 7 (migration 0045) introduced the first personal data in this product
-- with a STREET in it, and `services/erasure.ts` was written before that data
-- existed. `member_address` and `shop_order` appeared in neither its code nor
-- its twelve-table header — absent the way a table nobody has thought about is
-- absent, which is a different thing from `booking` and `loyalty_event` being
-- absent from the DELETE list on a written argument.
--
-- AND THE JOB'S OWN ARGUMENT DOES NOT EXTEND HERE, IT INVERTS. Erasure keeps
-- de-identified rows because "a booking pointing at a tombstone identifies
-- nobody". True of a visit count, a stamp total, a campaign send. FALSE of a
-- street: a block, a street and a building identify a household directly, and
-- they are not de-identified by the name beside them becoming 'Deleted
-- account'. De-identifying the name while keeping the address is the worst of
-- the two available outcomes — the record still locates a person and no longer
-- says who.
--
-- HER BOOK NEEDS NO MIGRATION. `member_address` rows are hers, nothing but her
-- own orders references them, and an address is not a financial record — so the
-- job DELETEs them. That half is in `services/erasure.ts` alone.
--
-- THE SNAPSHOT NEEDS THIS FILE, and this is the decision it carries.
--
-- =========================================================================
-- WHY A MARKER COLUMN AND NOT A RELAXED CHECK
-- =========================================================================
-- `shop_order_delivery_has_an_address` refuses the null-out, and it is RIGHT to:
-- a delivery order that lacks a street cannot be driven to, so making that
-- storable is how a driver ends up with a blank docket. Erasure legitimately
-- creates the one state the CHECK forbids, so the state has to be admitted —
-- and there are two ways to admit it, which are not equivalent.
--
--   RELAX IT — drop the three IS NOT NULLs from the delivery arm. One line, and
--       it spends the constraint's entire value: from then on `services/order.ts`
--       could commit a delivery order whose snapshot it simply forgot to copy,
--       and nothing would say so. A BUG becomes a legal state everywhere, in
--       order to admit a deliberate state in one place.
--
--   NAME IT — this file. A third arm that requires `address_erased_at IS NOT
--       NULL`, and the placement path never sets that column. So the erased
--       state is REPRESENTABLE rather than merely permitted, and a forgotten
--       snapshot is refused exactly as it was before. The invariant "a LIVE
--       delivery has an address" survives intact, because `address_erased_at IS
--       NULL` is now part of the delivery arm.
--
-- The marker also carries WHEN, which the state cannot infer and which the
-- retention question (queued, see below) will need if it is ever answered.
--
-- =========================================================================
-- AND WHY THIS RESOLVES DIFFERENTLY FROM DECISION 12, ON A STATED DIFFERENCE
-- =========================================================================
-- Decision 12 is the same tension one table over: "erasure cannot reach the
-- audit log, and the policy promises both." That one is UNRESOLVED and stays
-- unresolved. The difference is what the obstacle is FOR.
--
--   `audit_log`'s obstacle is 0023's REVOKE plus triggers refusing UPDATE and
--       DELETE. That append-only property IS the promise — § 7 of the same
--       policy — and reaching through it costs the thing the log exists to be.
--       So the tension there is genuine and a schema/retention decision.
--
--   `shop_order`'s obstacle is a CHECK on the SHAPE of a live row. It is a
--       data-quality guard ("pickup is not a delivery with empty fields"), not
--       an integrity guarantee about the past, and `shop_order` was never made
--       append-only for `avo_app` — the status transitions need UPDATE, and
--       migration 0027 revoked UPDATE/DELETE on `shop_order_LINE` and
--       deliberately not on this table. Nothing this constraint exists to buy is
--       spent by admitting an erased row, because nobody drives to an erased
--       order.
--
-- The line is checkable rather than a judgement: THE JOB REACHES EXACTLY THE
-- TABLES THE APP ROLE MAY WRITE. `shop_order` is one. `audit_log` (0023),
-- `member_consent_event` (0020) and `campaign_send` (0028) are not, and the job's
-- own header records all three as unreachable — the first two additionally in
-- every erasure's `retainedBeyondErasure` audit metadata. `shop_order_line` is
-- append-only too (0027) and holds no address: a product name, a quantity and a
-- price. That is why the two tensions resolve differently and not by accident.
--
-- =========================================================================
-- WHAT GOES, AND WHY ALL OF IT
-- =========================================================================
-- Every address column, not the three required ones. `area` and `governorate`
-- are coarser than a street but they still narrow, and `latitude`/`longitude`
-- are the sharp case: A COORDINATE PAIR WITH THE STREET REMOVED STILL LOCATES
-- THE ADDRESS EXACTLY, to about 0.1m at this latitude. A partial scrub would
-- leave residue to argue about later, so the erased arm below is the pickup arm
-- plus the marker: nothing at all, said deliberately.
--
-- `address_id` GOES TOO, and it has to: the FK to `member_address` is
-- `ON DELETE restrict`, so the book cannot be deleted while an order still
-- points at it. (That restrict is also why the addresses route soft-deletes.)
-- The job nulls the snapshot first and deletes the book second, in one
-- transaction. Provenance pointing at a row that no longer exists is worth
-- nothing anyway.
--
-- =========================================================================
-- NOT DECIDED HERE — TWO THINGS, BOTH DELIBERATELY LEFT
-- =========================================================================
-- THE DISCLOSURE. The published privacy policy's § 2 collection notice does not
-- mention an address at all: "your name, phone number, appointment history,
-- transaction and reward history, and basic device data". This migration assumes
-- the address is covered by § 5's "the rest of your account data is deleted
-- within 30 days" — which is the reading that makes the promise honest, and is
-- the only reading under which the current state is a defect rather than a
-- feature. Whether § 2 must also DISCLOSE the collection is counsel's, and that
-- document is with counsel now. Nothing here writes policy copy.
--
-- THE HORIZON. This scrub fires only on ERASURE — a member who asked, 30+ days
-- ago. It sets no retention horizon for the far larger case: a salon's
-- fulfilment board serving a two-day-old CLOSED order's street and gate code
-- for a member who never asked for anything. A salon has a plausible claim there
-- (its own delivery history, a dispute), the policy is silent, and a horizon is
-- client-owned. `address_erased_at` is the column such a job would set; it is
-- not set by anything but erasure today.
-- ---------------------------------------------------------------------------
ALTER TABLE "shop_order" ADD COLUMN "address_erased_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "shop_order" DROP CONSTRAINT "shop_order_delivery_has_an_address";
--> statement-breakpoint
-- THREE ARMS, and the first one is the part that keeps the guarantee. Adding
-- `address_erased_at IS NULL` to the live-delivery arm is what stops the new
-- column being a hole: a row cannot carry a street AND an erasure stamp, so
-- "erased" cannot become a label somebody sets while the data is still there.
--
-- The re-ADD validates every existing row. Live deliveries satisfy arm 1,
-- pickups satisfy arm 3, and no row can be in arm 2 yet because the column was
-- created NULL a statement ago.
ALTER TABLE "shop_order" ADD CONSTRAINT "shop_order_delivery_has_an_address" CHECK (
  -- 1. A LIVE DELIVERY: the three parts a Kuwaiti address needs, and no stamp.
  ("fulfilment" = 'delivery'
     AND "address_erased_at" IS NULL
     AND "block" IS NOT NULL AND "street" IS NOT NULL AND "building" IS NOT NULL)
  OR
  -- 2. AN ERASED DELIVERY: the household is gone and the order remains. The
  --    stamp is what makes this state reachable, and `services/erasure.ts` is
  --    the only writer of it. Identical to the pickup arm below except for the
  --    stamp — including the coordinates, which locate the address on their own.
  ("fulfilment" = 'delivery'
     AND "address_erased_at" IS NOT NULL
     AND "address_id" IS NULL AND "address_label" IS NULL
     AND "block" IS NULL AND "street" IS NULL AND "building" IS NULL
     AND "floor" IS NULL AND "apartment" IS NULL AND "area" IS NULL
     AND "governorate" IS NULL AND "instructions" IS NULL
     AND "latitude" IS NULL AND "longitude" IS NULL)
  OR
  -- 3. A PICKUP: none of them, and no stamp — a pickup has no address to erase,
  --    so a stamped pickup row is a bug rather than a privacy outcome.
  ("fulfilment" = 'pickup'
     AND "address_erased_at" IS NULL
     AND "address_id" IS NULL AND "address_label" IS NULL
     AND "block" IS NULL AND "street" IS NULL AND "building" IS NULL
     AND "floor" IS NULL AND "apartment" IS NULL AND "area" IS NULL
     AND "governorate" IS NULL AND "instructions" IS NULL
     AND "latitude" IS NULL AND "longitude" IS NULL)
);
