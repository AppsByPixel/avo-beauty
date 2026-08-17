-- ===========================================================================
-- 0013 - booking: the deposit hold, the no-show clock, and the calendar seam
--
-- build-plan.md phase 6. api-contract.md section Booking.
--
-- WHAT A BOOKING IS, IN THIS SCHEMA
-- A booking is a MONEY ROW with a calendar attached. `POST /bookings` debits the
-- customer's wallet for the salon's deposit and writes a `deposit_hold`
-- transaction; every exit from this table decides where that money lands. The
-- table is therefore modelled like `transaction` and not like a diary:
-- `hold_transaction_id` is NOT NULL, `settled_transaction_id` names the row that
-- resolved it, and a CHECK ties both to `status` so the state machine is a
-- database fact rather than a handler's good intentions.
--
--     deposit_held        settled_transaction_id IS NULL
--     completed           -> the charge that consumed the deposit
--     cancelled           -> the deposit_return
--     no_show_returned    -> the deposit_return
--
-- Non-negotiable #5: every one of those returns is WALLET CREDIT. There is no
-- path out of this table that reaches cash or a card.
--
-- THE EXCLUSION CONSTRAINT, AND WHY NOT A UNIQUE INDEX
-- Two customers tapping 16:45 at the same instant is the booking form of the
-- double-tapped scanner, and gets the same answer: the database resolves it, not
-- a SELECT followed by an INSERT. A UNIQUE index on (artist_id, starts_at) only
-- catches an exact tie - a 45-minute booking at 16:00 and a 30-minute one at
-- 16:15 overlap and would both be accepted, and the artist would find two
-- customers in her chair. `EXCLUDE USING gist` over the real time range refuses
-- what the screen means by "taken".
--
-- It needs btree_gist, because the constraint mixes an equality column
-- (artist_id, text) with a range operator. btree_gist is core contrib, ships in
-- the postgres:17-alpine image, and is not a managed-service extension - ADR-0001
-- section provider-neutral is satisfied. If a future host cannot provide it, the
-- fallback is a UNIQUE index on (artist_id, starts_at) plus an explicit overlap
-- SELECT inside the booking transaction, which is strictly weaker under
-- concurrency; that trade is written down here so it is a decision and not a
-- discovery.
--
-- The predicate is `status IN ('deposit_held','completed')`. A cancelled or
-- no-show booking releases its slot, which is what the availability grid already
-- says by not striking it through.
--
-- WHY no_show_return_due_at IS STORED
-- `salon.no_show_return_minutes` is editable. Computing the deadline at read
-- time means a merchant who changes 60 -> 240 retroactively un-returns deposits
-- that were already due. The deadline a customer was promised is a fact about her
-- booking; it is stamped at write. The job reads this column and nothing else.
--
-- It is stamped from ends_at, not starts_at. The contract says "noShowReturnMinutes
-- after a missed slot"; the product brief says "within 1 hour of the slot". Those
-- differ by the length of the appointment. Measuring from the END is the reading
-- that cannot fire while the customer is in the chair - a 60-minute service under
-- a 60-minute rule would otherwise return the deposit at the exact moment the
-- artist reaches for the scanner, and the credit line the design promises
-- (8.000 - 5.000 = 3.000) would silently vanish. Reported, not settled quietly.
--
-- LOCKING: three CREATE TABLEs and two CREATE TYPEs. Nothing to lock; the tables
-- do not exist. `CREATE EXTENSION btree_gist` takes a brief lock on the extension
-- catalog and is a no-op if it is already installed.
--
-- GRANTS: none needed. Migration 0001 set ALTER DEFAULT PRIVILEGES for avo_app on
-- tables and sequences in `public`, so these three tables are readable and
-- writable by the application role on creation. They are NOT append-only - a
-- booking is state that legitimately changes - so no REVOKE, unlike audit_log and
-- ledger_entry.
-- ===========================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint

CREATE TYPE "public"."booking_status" AS ENUM('deposit_held', 'completed', 'no_show_returned', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."booking_source" AS ENUM('app', 'google_calendar');--> statement-breakpoint
CREATE TYPE "public"."calendar_sync_state" AS ENUM('not_applicable', 'pending', 'synced', 'failed');--> statement-breakpoint
CREATE TYPE "public"."calendar_connection_status" AS ENUM('connected', 'revoked', 'error');--> statement-breakpoint
CREATE TYPE "public"."merchant_notification_kind" AS ENUM('calendar_disconnected', 'booking_no_show');--> statement-breakpoint
CREATE TYPE "public"."merchant_notification_severity" AS ENUM('info', 'warning');--> statement-breakpoint

CREATE TABLE "booking" (
  "id" text PRIMARY KEY NOT NULL,
  "salon_id" text NOT NULL,
  "branch_id" text NOT NULL,
  -- Same meaning as transaction.branch_assumed (migration 0012): the row says of
  -- itself whether its branch was known or attributed by sort order. A client
  -- never names a branch, here or anywhere.
  "branch_assumed" boolean DEFAULT false NOT NULL,
  "member_id" text NOT NULL,
  "artist_id" text NOT NULL,
  "service_id" text NOT NULL,
  "starts_at" timestamp with time zone NOT NULL,
  "ends_at" timestamp with time zone NOT NULL,
  "duration_min" integer NOT NULL,
  "deposit_fils" bigint NOT NULL,
  "status" "booking_status" DEFAULT 'deposit_held' NOT NULL,
  "source" "booking_source" DEFAULT 'app' NOT NULL,
  "hold_transaction_id" text NOT NULL,
  "settled_transaction_id" text,
  "no_show_return_due_at" timestamp with time zone NOT NULL,
  "rescheduled_count" integer DEFAULT 0 NOT NULL,
  "rescheduled_at" timestamp with time zone,
  "calendar_sync_state" "calendar_sync_state" DEFAULT 'not_applicable' NOT NULL,
  "google_event_id" text,
  "calendar_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  "cancelled_at" timestamp with time zone,
  "returned_at" timestamp with time zone,

  CONSTRAINT "booking_duration_positive" CHECK ("duration_min" > 0),
  CONSTRAINT "booking_ends_after_starts" CHECK ("ends_at" > "starts_at"),
  CONSTRAINT "booking_deposit_positive" CHECK ("deposit_fils" > 0),
  -- The state machine. Held if and only if nothing settled it.
  CONSTRAINT "booking_settlement_matches_status"
    CHECK (("status" = 'deposit_held') = ("settled_transaction_id" IS NULL)),
  CONSTRAINT "booking_completed_at_matches_status"
    CHECK (("status" = 'completed') = ("completed_at" IS NOT NULL)),
  CONSTRAINT "booking_cancelled_at_matches_status"
    CHECK (("status" = 'cancelled') = ("cancelled_at" IS NOT NULL)),
  CONSTRAINT "booking_returned_at_matches_status"
    CHECK (("status" = 'no_show_returned') = ("returned_at" IS NOT NULL)),
  CONSTRAINT "booking_rescheduled_count_non_negative" CHECK ("rescheduled_count" >= 0),
  CONSTRAINT "booking_rescheduled_at_matches_count"
    CHECK (("rescheduled_count" > 0) = ("rescheduled_at" IS NOT NULL)),
  CONSTRAINT "booking_google_event_matches_sync_state"
    CHECK (("calendar_sync_state" = 'synced') = ("google_event_id" IS NOT NULL))
);--> statement-breakpoint

ALTER TABLE "booking" ADD CONSTRAINT "booking_salon_id_salon_id_fk"
  FOREIGN KEY ("salon_id") REFERENCES "public"."salon"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_branch_id_branch_id_fk"
  FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_member_id_member_id_fk"
  FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_artist_id_artist_id_fk"
  FOREIGN KEY ("artist_id") REFERENCES "public"."artist"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_service_id_service_id_fk"
  FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_hold_transaction_id_transaction_id_fk"
  FOREIGN KEY ("hold_transaction_id") REFERENCES "public"."transaction"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_settled_transaction_id_transaction_id_fk"
  FOREIGN KEY ("settled_transaction_id") REFERENCES "public"."transaction"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "booking_member_starts_idx" ON "booking" ("member_id", "starts_at" DESC);--> statement-breakpoint
CREATE INDEX "booking_salon_starts_idx" ON "booking" ("salon_id", "starts_at" DESC);--> statement-breakpoint
CREATE INDEX "booking_artist_starts_idx" ON "booking" ("artist_id", "starts_at");--> statement-breakpoint
-- The no-show job's only index. Partial: a job that scans terminal bookings gets
-- slower every day it runs.
CREATE INDEX "booking_no_show_due_idx" ON "booking" ("no_show_return_due_at")
  WHERE "status" = 'deposit_held';--> statement-breakpoint

-- THE DOUBLE-BOOK GUARANTEE. See the header for why this is not a UNIQUE index.
ALTER TABLE "booking" ADD CONSTRAINT "booking_artist_slot_no_overlap"
  EXCLUDE USING gist (
    "artist_id" WITH =,
    tstzrange("starts_at", "ends_at", '[)') WITH &&
  ) WHERE ("status" IN ('deposit_held', 'completed'));--> statement-breakpoint


CREATE TABLE "artist_calendar_connection" (
  "id" text PRIMARY KEY NOT NULL,
  "salon_id" text NOT NULL,
  "artist_id" text NOT NULL,
  "provider" text DEFAULT 'google' NOT NULL,
  "status" "calendar_connection_status" DEFAULT 'connected' NOT NULL,
  "account_email" text,
  "external_calendar_id" text,
  -- A POINTER INTO THE SECRET STORE, NEVER THE TOKEN. An OAuth refresh token in
  -- an application table is a credential sitting in every backup, every replica
  -- and every SELECT * in a support session.
  "credential_ref" text,
  "last_synced_at" timestamp with time zone,
  "last_error" text,
  "connected_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "artist_calendar_connection_artist_id_unique" UNIQUE ("artist_id"),
  CONSTRAINT "artist_calendar_connection_error_has_message"
    CHECK ("status" <> 'error' OR "last_error" IS NOT NULL)
);--> statement-breakpoint

ALTER TABLE "artist_calendar_connection" ADD CONSTRAINT "artist_calendar_connection_salon_id_salon_id_fk"
  FOREIGN KEY ("salon_id") REFERENCES "public"."salon"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artist_calendar_connection" ADD CONSTRAINT "artist_calendar_connection_artist_id_artist_id_fk"
  FOREIGN KEY ("artist_id") REFERENCES "public"."artist"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artist_calendar_connection_salon_idx" ON "artist_calendar_connection" ("salon_id");--> statement-breakpoint


CREATE TABLE "merchant_notification" (
  "id" text PRIMARY KEY NOT NULL,
  "salon_id" text NOT NULL,
  "kind" "merchant_notification_kind" NOT NULL,
  "severity" "merchant_notification_severity" DEFAULT 'warning' NOT NULL,
  "title" text NOT NULL,
  "body" text NOT NULL,
  "subject_type" text NOT NULL,
  "subject_id" text NOT NULL,
  "deep_link" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "read_at" timestamp with time zone,
  "resolved_at" timestamp with time zone,

  CONSTRAINT "merchant_notification_title_not_blank" CHECK (length(btrim("title")) > 0)
);--> statement-breakpoint

ALTER TABLE "merchant_notification" ADD CONSTRAINT "merchant_notification_salon_id_salon_id_fk"
  FOREIGN KEY ("salon_id") REFERENCES "public"."salon"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "merchant_notification_salon_created_idx"
  ON "merchant_notification" ("salon_id", "created_at" DESC);--> statement-breakpoint
-- The dedup that keeps a disconnected calendar from minting one notification per
-- availability read. Makes "raise this if it is not already raised" a single
-- ON CONFLICT DO NOTHING, which is what makes it safe on a hot read path.
CREATE UNIQUE INDEX "merchant_notification_open_uq"
  ON "merchant_notification" ("salon_id", "kind", "subject_type", "subject_id")
  WHERE "resolved_at" IS NULL;--> statement-breakpoint


-- ---------------------------------------------------------------------------
-- A MONEY COLUMN THAT WAS NOT bigint. Found by the assertion below, on the first
-- fresh-database run after this migration was written.
--
-- Migration 0011 added `promo_bonus_fils` to `transaction` and to `topup_intent`
-- as `integer`. Both Drizzle schema files declare it with `filsColumn()`, which
-- is bigint, so the model and the database disagreed and nothing said so: every
-- developer database and every CI run had already applied 0011, and 0001's
-- bigint assertion runs only inside 0001. It could only surface on a migration
-- that re-ran the check, which is what this one does.
--
-- Non-negotiable #1 is not "money is large enough". int4 tops out at 2,147,483,647
-- fils - about 2.1 million KD - which no single promotion bonus will reach, so
-- this is not an outage waiting to happen. It is worse than that in the way that
-- matters: the invariant is what makes "money is integer fils, bigint, everywhere"
-- checkable at all. One exception and the check stops being evidence. The
-- expression `credit_fils = amount_fils + bonus_fils + promo_bonus_fils` already
-- mixes the two widths and Postgres promotes silently, which is exactly how a
-- narrow money column survives review.
--
-- ALTER TYPE integer -> bigint rewrites the table and takes an ACCESS EXCLUSIVE
-- lock. `transaction` is the busiest table in the schema. On a pilot-sized
-- dataset this is milliseconds; before it is run against a large production
-- table it should be scheduled, not deployed casually. Said out loud here rather
-- than discovered during a deploy.
-- ---------------------------------------------------------------------------
ALTER TABLE "transaction" ALTER COLUMN "promo_bonus_fils" TYPE bigint;--> statement-breakpoint
ALTER TABLE "topup_intent" ALTER COLUMN "promo_bonus_fils" TYPE bigint;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Non-negotiable #1, re-asserted. Migration 0001 checks that every *_fils column
-- is bigint; this migration adds one, so the check is run again rather than
-- trusted to have been run once. A `deposit_fils numeric(10,3)` is exactly the
-- shape of mistake that assertion exists for — and, as the block above records,
-- it caught a real one the first time it ran.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg(format('%I.%I is %s', c.table_name, c.column_name, c.data_type), ', ')
    INTO offenders
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
   WHERE c.table_schema = 'public'
     AND t.table_type = 'BASE TABLE'
     AND c.column_name LIKE '%\_fils'
     AND c.data_type <> 'bigint';

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'Non-negotiable #1: money must be bigint fils. Offending columns: %', offenders;
  END IF;
END
$$;
