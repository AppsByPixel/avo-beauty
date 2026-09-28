-- ===========================================================================
-- THE SALON WRITES ITS OWN BOOKING POLICY — and it replaces the return window.
--
-- DECISIONS.md § "The fourth list, 2026-09-29, and four rulings from Aftab",
-- "Booking deposit: the salon's own policy replaces the return window".
--
-- BEFORE THIS MIGRATION every exit from a held deposit gave the money back:
-- a cancel returned it in full (and was refused inside the last hour), a
-- no-show returned it `salon.no_show_return_minutes` after the slot ended, and
-- nothing anywhere could move held money to the salon except a charge for the
-- visit. The salon now decides, in a published and versioned policy:
--
--   no-show        `keep` (forfeited to the salon) or `return` (to her wallet).
--                  Applied when staff mark the no-show or when the booked slot
--                  ends, whichever is first (trunk's ruling).
--   cancellation   up to three `{ hoursBefore, returnPercent }` rules. The first
--                  whose threshold she meets wins; later than every threshold
--                  returns 0%. The percent is applied to integer fils and rounded
--                  DOWN; the salon keeps the remainder fil.
--   text           `{ en, ar }`, written by the salon. Empty `ar` falls back to
--                  `en`, like `LegalDocSchema`.
--
-- ---------------------------------------------------------------------------
-- 1. `booking_policy` — ONE ROW PER PUBLISHED VERSION, AND NEVER EDITED
-- ---------------------------------------------------------------------------
-- A publish INSERTS version n+1. Nothing updates or deletes a version: the
-- REVOKE below makes that a privilege fact for `avo_app`, because a booking
-- points at the version it was made under and "a later edit never changes what
-- an existing booking returns" is only true if the version it points at cannot
-- itself be edited.
--
-- THE RULES ARE A CHECKED jsonb ARRAY, not child rows. The ordering rules
-- (`hoursBefore` strictly descending, `returnPercent` non-increasing) are
-- CROSS-ROW, so child rows would need a trigger to say them; a jsonb value is
-- one datum and an IMMUTABLE function can say all of it in a CHECK. The SAME
-- function checks the snapshot stamped on each booking, so a booking cannot
-- carry a rule set its salon could never have published.
--
-- ---------------------------------------------------------------------------
-- 2. THE BOOKING STAMPS THE POLICY — six columns, all or none
-- ---------------------------------------------------------------------------
-- `policy_id`, `policy_version`, `policy_no_show`, `policy_cancellation_rules`,
-- `policy_text_en`, `policy_text_ar`. The text is snapshotted as well as the
-- rules, so what she was shown before she confirmed is on her booking and every
-- serialiser can emit it without a join. `(policy_id, salon_id,
-- policy_version)` is a composite FK onto the version row, so a booking cannot
-- name another salon's policy or a version number its policy row does not have.
--
-- A STAMP REQUIRES A HOLD. A merchant-written appointment takes no deposit
-- (`booking_merchant_is_zero_deposit`), so there is nothing for a deposit policy
-- to govern on it.
--
-- NULL ALL SIX IS "LEGACY", and it keeps today's behaviour exactly. Every row in
-- the table when this applies is legacy, and so is every booking made at a salon
-- that has never published a policy. services/bookingPolicy.ts § LEGACY states
-- that behaviour in full.
--
-- ---------------------------------------------------------------------------
-- 3. HOW HELD MONEY REACHES THE SALON — `deposit_forfeit`
-- ---------------------------------------------------------------------------
-- A new transaction kind. Its ledger pair is `deposit_held` DEBIT +
-- `salon_revenue` CREDIT (money/ledger.ts § depositForfeitedPosting): the same
-- two accounts a charge uses when it applies a deposit, because in both cases
-- escrow the salon had not earned becomes money it has. The return is the
-- existing `deposit_return` pair (`deposit_held` DEBIT + `member_wallet`
-- CREDIT). A 60% cancellation of 5.005 KD writes both, and the `deposit_held`
-- account nets to zero for the booking:
--
--   hold      member_wallet  D 5005   deposit_held   C 5005   (deposit_hold)
--   return    deposit_held   D 3003   member_wallet  C 3003   (deposit_return)
--   forfeit   deposit_held   D 2002   salon_revenue  C 2002   (deposit_forfeit)
--
-- `amount_fils` IS ZERO ON A FORFEIT, and the CHECK below requires exactly zero.
-- `amount_fils` is this table's WALLET delta — the whole build reads it that way
-- (e2e/orders.test.ts reconciles `sum(amount_fils)` against the balance
-- movement; a charge records what was debited AFTER the deposit). A forfeit
-- moves nothing in her wallet: the money left it when the deposit was held. The
-- magnitude lives on the ledger legs and on `booking.settled_kept_fils`, exactly
-- as an applied deposit's lives on the charge's `deposit_held` debit leg.
--
-- ---------------------------------------------------------------------------
-- 4. WHERE THE MONEY WENT, ON THE BOOKING
-- ---------------------------------------------------------------------------
-- `settled_returned_fils` + `settled_kept_fils` = `deposit_fils`, and
-- `forfeit_transaction_id` names the forfeit when anything was kept.
-- `settled_transaction_id` keeps its meaning — the transaction that settled the
-- booking — and is the RETURN when anything was returned, else the FORFEIT, so
-- `booking_settlement_matches_status` holds unchanged for every new outcome.
-- The split is NULL on rows settled before this migration (and on rows the
-- deployed API settles until the new one ships); every one of those was a full
-- return, which is what the serialiser reports for a NULL split.
--
-- ---------------------------------------------------------------------------
-- 5. THE BELL — `member_policy_notice`, one row per member per salon-day
-- ---------------------------------------------------------------------------
-- Each publish writes one notice to each (non-erased) member of the salon, and
-- UNIQUE (member_id, salon_id, notice_date) is the coalescing rule: a second
-- publish on the same salon-local day writes none. Bell only — nothing here is
-- a send, no receipt_job and no campaign_send, so it cannot become a route
-- around non-negotiable #8. `read_at` lives on the row: it is per member
-- already, so it does not need `member_notification_read`'s indirection.
--
-- ---------------------------------------------------------------------------
-- WHAT IS NOT HERE
-- ---------------------------------------------------------------------------
-- `salon.no_show_return_minutes` is KEPT, unchanged, values and CHECK included.
-- It still stamps the deadline of legacy bookings (and of new bookings at a
-- salon with no published policy), and it is still the counter's early-arrival
-- grace in services/booking.ts § findApplicableHold. What goes away is the
-- merchant's ability to write it (routes/salons.ts, not a migration).
--
-- ---------------------------------------------------------------------------
-- SAFE UNDER THE DEPLOYED API (production is on 0063; 0064 and 0065 apply first)
-- ---------------------------------------------------------------------------
-- Additive only: two tables, two sequences, one function, nine nullable
-- columns, one enum value, CHECKs every existing row passes, and one CHECK
-- replaced by a strictly wider one. The deployed API inserts bookings naming
-- none of the new columns — all NULL, legacy, which is exactly what it
-- implements — and settles them through its own `returnDeposit`, which writes
-- NULL splits (permitted) and names no forfeit. It never writes
-- `deposit_forfeit`, and a value it never reads cannot reach its serialisers.
--
-- `ALTER TYPE … ADD VALUE` cannot be USED in the transaction that adds it, and
-- drizzle's migrator runs a file as one transaction — so the CHECK below says
-- `kind::text = 'deposit_forfeit'`, the 0028/0056 form.
--
-- LOCKING: ADD COLUMN with no default is catalogue-only. The booking CHECKs scan
-- `booking` once each; the replaced sign CHECK scans `transaction` once.
-- lock_timeout 3s, the 0010/0011/0059/0063/0064/0065 convention.
-- ===========================================================================

SET lock_timeout = '3s';--> statement-breakpoint

-- ------------------------------------------------------- the rule validator --
-- IMMUTABLE and total: any jsonb in, a boolean out, never an exception, so a
-- malformed value is a CHECK violation rather than an error raised inside one.
-- Mirrors services/bookingPolicy.ts § parseCancellationRules exactly; the
-- constants there (3 rules, 1..720 hours, 0..100 percent) are restated here
-- because a migration cannot import them, and bookingPolicy.int.test.ts drives
-- both with the same refusals.
CREATE OR REPLACE FUNCTION booking_cancellation_rules_valid(rules jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  r jsonb;
  h numeric;
  p numeric;
  prev_h numeric := NULL;
  prev_p numeric := NULL;
BEGIN
  IF rules IS NULL THEN
    RETURN true;
  END IF;
  IF jsonb_typeof(rules) IS DISTINCT FROM 'array' THEN
    RETURN false;
  END IF;
  IF jsonb_array_length(rules) > 3 THEN
    RETURN false;
  END IF;
  FOR r IN SELECT e FROM jsonb_array_elements(rules) WITH ORDINALITY AS x(e, i) ORDER BY i LOOP
    IF jsonb_typeof(r) IS DISTINCT FROM 'object' THEN
      RETURN false;
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(r)) <> 2 THEN
      RETURN false;
    END IF;
    IF jsonb_typeof(r->'hoursBefore') IS DISTINCT FROM 'number'
       OR jsonb_typeof(r->'returnPercent') IS DISTINCT FROM 'number' THEN
      RETURN false;
    END IF;
    h := (r->>'hoursBefore')::numeric;
    p := (r->>'returnPercent')::numeric;
    IF h <> trunc(h) OR p <> trunc(p) THEN
      RETURN false;
    END IF;
    IF h < 1 OR h > 720 OR p < 0 OR p > 100 THEN
      RETURN false;
    END IF;
    IF prev_h IS NOT NULL AND (h >= prev_h OR p > prev_p) THEN
      RETURN false;
    END IF;
    prev_h := h;
    prev_p := p;
  END LOOP;
  RETURN true;
END;
$$;--> statement-breakpoint

-- ------------------------------------------------------------ the versions --
CREATE SEQUENCE IF NOT EXISTS "booking_policy_number_seq";--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "booking_policy" (
  "id" text PRIMARY KEY NOT NULL,
  "salon_id" text NOT NULL,
  "version" integer NOT NULL,
  "no_show_rule" text NOT NULL,
  "cancellation_rules" jsonb NOT NULL,
  "text_en" text NOT NULL,
  "text_ar" text DEFAULT '' NOT NULL,
  "published_at" timestamp with time zone DEFAULT now() NOT NULL,
  "published_by_staff_id" text NOT NULL,
  CONSTRAINT "booking_policy_salon_fk" FOREIGN KEY ("salon_id")
    REFERENCES "public"."salon"("id") ON DELETE restrict,
  CONSTRAINT "booking_policy_published_by_fk" FOREIGN KEY ("published_by_staff_id")
    REFERENCES "public"."staff_user"("id") ON DELETE restrict,
  CONSTRAINT "booking_policy_salon_version_uq" UNIQUE ("salon_id", "version"),
  -- The target of the composite FKs below. (id) alone is already unique; this
  -- lets a referencing row prove salon and version in the same constraint.
  CONSTRAINT "booking_policy_ref_uq" UNIQUE ("id", "salon_id", "version"),
  CONSTRAINT "booking_policy_version_positive" CHECK ("version" > 0),
  CONSTRAINT "booking_policy_no_show_rule_valid" CHECK ("no_show_rule" IN ('keep', 'return')),
  CONSTRAINT "booking_policy_rules_valid"
    CHECK (booking_cancellation_rules_valid("cancellation_rules")),
  CONSTRAINT "booking_policy_text_en_present"
    CHECK (length(btrim("text_en")) > 0 AND char_length("text_en") <= 1000),
  CONSTRAINT "booking_policy_text_ar_bounded" CHECK (char_length("text_ar") <= 1000)
);--> statement-breakpoint
-- A published version is a promise other rows point at. Append-only for the app.
REVOKE UPDATE, DELETE ON "booking_policy" FROM avo_app;--> statement-breakpoint

-- --------------------------------------------------------- the transaction --
ALTER TYPE "public"."transaction_kind" ADD VALUE IF NOT EXISTS 'deposit_forfeit';--> statement-breakpoint
ALTER TABLE "transaction" DROP CONSTRAINT IF EXISTS "transaction_amount_sign_matches_kind";--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_amount_sign_matches_kind"
  CHECK (
    ("kind" IN ('topup', 'deposit_return') AND "amount_fils" > 0)
    OR ("kind" = 'charge' AND "amount_fils" <= 0)
    OR ("kind" IN ('deposit_hold', 'shop') AND "amount_fils" < 0)
    OR ("kind" = 'adjustment' AND "amount_fils" <> 0)
    -- A forfeit moves nothing in her wallet. § 3 above.
    OR ("kind"::text = 'deposit_forfeit' AND "amount_fils" = 0)
  );--> statement-breakpoint

-- ------------------------------------------------------------ the booking --
ALTER TABLE "booking" ADD COLUMN IF NOT EXISTS "policy_id" text;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN IF NOT EXISTS "policy_version" integer;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN IF NOT EXISTS "policy_no_show" text;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN IF NOT EXISTS "policy_cancellation_rules" jsonb;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN IF NOT EXISTS "policy_text_en" text;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN IF NOT EXISTS "policy_text_ar" text;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN IF NOT EXISTS "settled_returned_fils" bigint;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN IF NOT EXISTS "settled_kept_fils" bigint;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN IF NOT EXISTS "forfeit_transaction_id" text;--> statement-breakpoint

ALTER TABLE "booking" ADD CONSTRAINT "booking_policy_fk"
  FOREIGN KEY ("policy_id", "salon_id", "policy_version")
  REFERENCES "public"."booking_policy"("id", "salon_id", "version") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_forfeit_transaction_fk"
  FOREIGN KEY ("forfeit_transaction_id")
  REFERENCES "public"."transaction"("id") ON DELETE restrict;--> statement-breakpoint

-- All six or none. A half-stamped booking is one no settle path can act on.
ALTER TABLE "booking" ADD CONSTRAINT "booking_policy_stamp_is_whole"
  CHECK (
    num_nonnulls("policy_id", "policy_version", "policy_no_show",
                 "policy_cancellation_rules", "policy_text_en", "policy_text_ar") IN (0, 6)
  );--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_policy_requires_hold"
  CHECK ("policy_id" IS NULL OR "hold_transaction_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_policy_no_show_valid"
  CHECK ("policy_no_show" IS NULL OR "policy_no_show" IN ('keep', 'return'));--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_policy_rules_valid"
  CHECK (booking_cancellation_rules_valid("policy_cancellation_rules"));--> statement-breakpoint

-- Where the money went. § 4 above.
ALTER TABLE "booking" ADD CONSTRAINT "booking_settlement_split_is_whole"
  CHECK (("settled_returned_fils" IS NULL) = ("settled_kept_fils" IS NULL));--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_settlement_split_non_negative"
  CHECK (
    ("settled_returned_fils" IS NULL OR "settled_returned_fils" >= 0)
    AND ("settled_kept_fils" IS NULL OR "settled_kept_fils" >= 0)
  );--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_settlement_split_sums_to_deposit"
  CHECK (
    "settled_returned_fils" IS NULL
    OR "settled_returned_fils" + "settled_kept_fils" = "deposit_fils"
  );--> statement-breakpoint
-- A split describes a deposit that left escrow OTHER than by a charge.
ALTER TABLE "booking" ADD CONSTRAINT "booking_settlement_split_is_for_an_exit"
  CHECK (
    "settled_returned_fils" IS NULL
    OR ("hold_transaction_id" IS NOT NULL AND "status" IN ('cancelled', 'no_show_returned'))
  );--> statement-breakpoint
-- A forfeit exists exactly when something was kept.
ALTER TABLE "booking" ADD CONSTRAINT "booking_forfeit_matches_kept"
  CHECK (("forfeit_transaction_id" IS NOT NULL) = (coalesce("settled_kept_fils", 0) > 0));--> statement-breakpoint
-- `settled_transaction_id` is the return when anything came back, else the forfeit.
ALTER TABLE "booking" ADD CONSTRAINT "booking_settled_names_the_return"
  CHECK (
    "settled_returned_fils" IS NULL
    OR ("settled_returned_fils" > 0) = ("settled_transaction_id" IS DISTINCT FROM "forfeit_transaction_id")
  );--> statement-breakpoint

-- ------------------------------------------------------------------ the bell --
CREATE SEQUENCE IF NOT EXISTS "member_policy_notice_number_seq";--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "member_policy_notice" (
  "id" text PRIMARY KEY NOT NULL,
  "member_id" text NOT NULL,
  "salon_id" text NOT NULL,
  "policy_id" text NOT NULL,
  "policy_version" integer NOT NULL,
  -- The SALON's calendar date of the publish, never the server's.
  "notice_date" date NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "read_at" timestamp with time zone,
  CONSTRAINT "member_policy_notice_member_fk" FOREIGN KEY ("member_id")
    REFERENCES "public"."member"("id") ON DELETE restrict,
  CONSTRAINT "member_policy_notice_salon_fk" FOREIGN KEY ("salon_id")
    REFERENCES "public"."salon"("id") ON DELETE restrict,
  CONSTRAINT "member_policy_notice_policy_fk"
    FOREIGN KEY ("policy_id", "salon_id", "policy_version")
    REFERENCES "public"."booking_policy"("id", "salon_id", "version") ON DELETE restrict,
  -- The coalescing rule. At most one notice per member per salon per day.
  CONSTRAINT "member_policy_notice_one_a_day_uq" UNIQUE ("member_id", "salon_id", "notice_date"),
  CONSTRAINT "member_policy_notice_read_after_created"
    CHECK ("read_at" IS NULL OR "read_at" >= "created_at")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "member_policy_notice_member_created_idx"
  ON "member_policy_notice" ("member_id", "created_at" DESC);
