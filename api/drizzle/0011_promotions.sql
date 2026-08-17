-- ===========================================================================
-- 0011 - the promotion set: branch boosts and happy-hour windows
--
-- api-contract.md § Promotion set. ONE object the wallet and the dashboard both
-- read, carrying days/from/to and NO `live` flag, because liveness is a function
-- of the row and the clock that every reader evaluates for itself - including
-- this server, at charge time, using the same shared predicate the clients use
-- (packages/types/src/rules.ts). A stale banner cannot cause a wrong charge.
--
-- THE TWO SCHEMA OBSTACLES THAT WERE FLAGGED BEFORE THIS WAS BUILT
--
-- 1. `transaction` has CHECK (bonus_fils = 0 OR kind = 'topup'), so a happy-hour
--    reward on a CHARGE had nowhere to record itself.
--
--    NOT RELAXED. Building it showed the constraint was right and the modelling
--    was wrong. `x2visit`/`x2stamp`/`x3stamp` move no money at all - they
--    multiply a loyalty increment, and `promotion_id` on the charge row records
--    which window did it. `credit3` is a 3.000 KD wallet credit, and burying a
--    credit inside the charge row that triggered it would net a debit against a
--    credit and leave the activity feed unable to show the customer either
--    number; it is written as its own `adjustment` row, which the existing sign
--    CHECK already permits and the ledger already balances. Relaxing the
--    constraint would only have bought the ability to write a meaningless row.
--
-- 2. `topup10`/`topup20` would be a second bonus source alongside the tier bonus,
--    both landing in one `bonus_fils` column, so reconciliation could not tell
--    merchant-funded-by-standing from merchant-funded-by-promotion.
--
--    DONE, as suggested: `promo_bonus_fils` alongside `bonus_fils`, on the
--    transaction AND on the intent that produces it, plus `promotion_id`. The
--    credit invariant widens from amount+bonus to amount+bonus+promo_bonus. Two
--    budget lines, two columns.
--
-- MIDNIGHT - unspecified anywhere, decided here: a window may NOT cross it.
-- `to > from`, enforced below. A merchant wanting 22:00 -> 02:00 writes two
-- windows, `22:00 -> 24:00` and `00:00 -> 02:00`. This is forced rather than
-- chosen: `isHappyHourLive` is the SHARED implementation, imported by both
-- clients and by this server so they cannot disagree, and it evaluates
-- `from <= now < to`, which is empty when `to <= from`. A server that
-- special-cased a wrap would apply a multiplier every client renders as not
-- live - a customer charged at 1x while her wallet shows 2x. Allowing a wrap is
-- a packages/types change plus a re-release of every surface, not a lane A one.
-- `24:00` is the sentinel that makes the split lossless: it parses to 1440
-- through the shared hhmmToMinutes with no change, and `minutes < 1440` holds
-- for every real clock reading, so the day is covered to its last second.
-- `to: '23:59'` would leave a dead minute.
--
-- LOCKING: two CREATE TABLEs (nothing to lock - the tables do not exist yet) and
-- three ADD COLUMNs. The ADD COLUMNs on `transaction` and `topup_intent` are
-- NULL-defaulted or constant-defaulted, so catalogue-only since Postgres 11: no
-- rewrite, no row touched, ACCESS EXCLUSIVE held only for the catalogue update.
-- Bounded with lock_timeout so it cannot queue behind a long read and block the
-- money path behind it. No index is created or dropped on an existing table, so
-- CONCURRENTLY does not apply anywhere here.
--
-- The two new indexes are created WITH the tables they belong to, on tables no
-- session can be reading yet - the one case where a plain CREATE INDEX is not a
-- lock question at all.
-- ===========================================================================

SET lock_timeout = '3s';--> statement-breakpoint

CREATE TABLE "boost" (
  "salon_id" text NOT NULL REFERENCES "salon"("id") ON DELETE restrict,
  "branch_id" text NOT NULL REFERENCES "branch"("id") ON DELETE restrict,
  "visit" integer DEFAULT 1 NOT NULL,
  "topup" integer DEFAULT 0 NOT NULL,
  "stamp" integer DEFAULT 1 NOT NULL,
  "published_at" timestamp with time zone DEFAULT now() NOT NULL,
  "published_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "boost_salon_id_branch_id_pk" PRIMARY KEY("salon_id","branch_id"),
  -- The dashboard's steppers stop at these bounds. Non-negotiable #7: the UI
  -- stopping is a courtesy, this is the control.
  CONSTRAINT "boost_visit_in_range" CHECK ("visit" BETWEEN 1 AND 3),
  CONSTRAINT "boost_topup_in_range" CHECK ("topup" BETWEEN 0 AND 30),
  CONSTRAINT "boost_stamp_in_range" CHECK ("stamp" BETWEEN 1 AND 3)
);--> statement-breakpoint

CREATE TABLE "happy_hour" (
  "id" text PRIMARY KEY NOT NULL,
  "salon_id" text NOT NULL REFERENCES "salon"("id") ON DELETE restrict,
  -- NULL is the wire's "all". A text column holding the literal 'all' could not
  -- be a foreign key, so a deleted branch would leave a window pointing at an id
  -- no client can resolve.
  "branch_id" text REFERENCES "branch"("id") ON DELETE restrict,
  "days" smallint[] NOT NULL,
  "from" text NOT NULL,
  "to" text NOT NULL,
  "reward" text NOT NULL,
  "on" boolean DEFAULT true NOT NULL,
  "notify" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "happy_hour_from_is_hhmm" CHECK ("from" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  -- 24:00 on `to` only. As a START it is a zero-length window dressed up as a time.
  CONSTRAINT "happy_hour_to_is_hhmm" CHECK ("to" ~ '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$'),
  -- THE MIDNIGHT DECISION, as a database fact. Zero-padded HH:MM sorts exactly
  -- as the minute values it denotes, and '24:00' sorts above every real time, so
  -- the lexicographic comparison is precise here rather than convenient.
  CONSTRAINT "happy_hour_to_after_from" CHECK ("to" > "from"),
  CONSTRAINT "happy_hour_days_valid" CHECK (
    array_length("days", 1) BETWEEN 1 AND 7
    AND "days" <@ ARRAY[0,1,2,3,4,5,6]::smallint[]
  ),
  CONSTRAINT "happy_hour_reward_known" CHECK (
    "reward" IN ('x2stamp', 'x3stamp', 'x2visit', 'topup10', 'topup20', 'credit3')
  )
);--> statement-breakpoint

CREATE INDEX "happy_hour_salon_idx" ON "happy_hour" USING btree ("salon_id");--> statement-breakpoint

-- ------------------------------------------------------------- obstacle 2 --

ALTER TABLE "transaction" ADD COLUMN "promo_bonus_fils" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN "promotion_id" text REFERENCES "happy_hour"("id") ON DELETE restrict;--> statement-breakpoint

ALTER TABLE "transaction" ADD CONSTRAINT "transaction_promo_bonus_non_negative"
  CHECK ("promo_bonus_fils" >= 0);--> statement-breakpoint
-- Same shape as the tier bonus check, and true for the same reason: a promotion
-- that pays out on a charge is an `adjustment` row, not a bonus on the charge.
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_promo_bonus_is_topup_only"
  CHECK ("promo_bonus_fils" = 0 OR "kind" = 'topup');--> statement-breakpoint

ALTER TABLE "topup_intent" ADD COLUMN "promo_bonus_fils" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "topup_intent" ADD COLUMN "promotion_id" text REFERENCES "happy_hour"("id") ON DELETE restrict;--> statement-breakpoint

ALTER TABLE "topup_intent" ADD CONSTRAINT "topup_intent_promo_bonus_non_negative"
  CHECK ("promo_bonus_fils" >= 0);--> statement-breakpoint

-- The credit invariant widens. It was `credit = amount + bonus`; the promotion
-- bonus is a second merchant-funded component of the same credit, and dropping
-- it from this check would let the two disagree silently.
ALTER TABLE "topup_intent" DROP CONSTRAINT "topup_intent_credit_is_amount_plus_bonus";--> statement-breakpoint
ALTER TABLE "topup_intent" ADD CONSTRAINT "topup_intent_credit_is_amount_plus_bonus"
  CHECK ("credit_fils" = "amount_fils" + "bonus_fils" + "promo_bonus_fils");--> statement-breakpoint

RESET lock_timeout;
