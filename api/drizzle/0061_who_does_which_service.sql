-- ===========================================================================
-- WHO DOES WHICH SERVICE
--
-- The client, verbatim: "add the services, price it, then assign them". Until
-- this migration nothing recorded which artist performs which service, and
-- lane B said so: "no link between artists and services anywhere in the API ...
-- `POST /bookings` accepts any active artist with any active service". A
-- customer could book a manicure with the colourist.
--
-- This file is the SCHEMA. The backfill that keeps every existing booking path
-- working is 0062, on its own, so that `artistService.int.test.ts` can run that
-- file verbatim over rows that already exist — the approach 0059's spec uses —
-- which a file that also holds a CREATE TABLE cannot be re-run to do.
--
-- ---------------------------------------------------------------------------
-- THE TABLE
-- ---------------------------------------------------------------------------
-- `artist_service (artist_id, service_id, salon_id)`, one row per "she does
-- this". The primary key is the pair, so an assignment cannot be recorded twice.
-- `salon_id` is carried on the row for ONE reason: tenancy in the schema.
--
--   artist_service_artist_same_salon_fk   (artist_id, salon_id)  → artist(id, salon_id)
--   artist_service_service_same_salon_fk  (service_id, salon_id) → service(id, salon_id)
--
-- Both pointing at the SAME salon_id column is what makes "salon A's artist does
-- salon B's service" unstorable, even if a code path forgets to check. The
-- targets are two new composite unique keys, additive over the primary keys in
-- exactly the way `branch_id_salon_uq` (0043) is.
--
-- ON DELETE CASCADE, AND THAT IS THE DELIBERATE CONTRAST WITH EVERY MONEY FK.
-- Artists and services are retired, never deleted — `booking`, `transaction`
-- and receipts reference them `ON DELETE restrict`, and that restrict is what
-- protects history. A link is not history: it is today's configuration, it
-- moves no money and no receipt names it. If a row with no history is ever
-- deleted (a fixture's cleanup, an operator removing a typo'd service that was
-- never sold), its assignments mean nothing without it, and `restrict` here
-- would add a reason for that delete to fail while protecting nothing.
--
-- `artist_service_service_idx` serves the per-service read — "who does this?" —
-- which is what `GET /salons/{id}/services` asks for every row. The primary key
-- already serves the per-artist direction and the booking check.
--
-- ---------------------------------------------------------------------------
-- LOCKING, ON A LIVE DATABASE
-- ---------------------------------------------------------------------------
-- The two ADD CONSTRAINT … UNIQUE build an index each, which takes a SHARE lock
-- on `artist` and on `service` for the length of the build. SHARE blocks writes
-- to those two tables and no reads: a charge READS `service` to price a basket,
-- a booking READS `artist`, and neither is blocked. What waits is an
-- availability or branch edit on an artist, for as long as it takes to index a
-- salon roster and a service menu — rows in the tens per salon. lock_timeout 3s,
-- the 0010/0011/0059 convention, so a long transaction holding either table
-- fails this migration rather than queueing every writer behind it.
-- ===========================================================================

SET lock_timeout = '3s';--> statement-breakpoint

-- `SV-10000000` onwards, for services a merchant adds (`services/ids.ts §
-- nextServiceId`). The seeded ids are `SV-01`..`SV-05`, two digits wide.
CREATE SEQUENCE IF NOT EXISTS service_number_seq AS bigint START WITH 10000000;
--> statement-breakpoint

ALTER TABLE "artist" ADD CONSTRAINT "artist_id_salon_uq" UNIQUE ("id", "salon_id");
--> statement-breakpoint
ALTER TABLE "service" ADD CONSTRAINT "service_id_salon_uq" UNIQUE ("id", "salon_id");
--> statement-breakpoint
CREATE TABLE "artist_service" (
  "artist_id" text NOT NULL,
  "service_id" text NOT NULL,
  "salon_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "artist_service_pkey" PRIMARY KEY ("artist_id", "service_id")
);
--> statement-breakpoint
ALTER TABLE "artist_service" ADD CONSTRAINT "artist_service_artist_same_salon_fk"
  FOREIGN KEY ("artist_id", "salon_id") REFERENCES "artist"("id", "salon_id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "artist_service" ADD CONSTRAINT "artist_service_service_same_salon_fk"
  FOREIGN KEY ("service_id", "salon_id") REFERENCES "service"("id", "salon_id") ON DELETE cascade;
--> statement-breakpoint
CREATE INDEX "artist_service_service_idx" ON "artist_service" ("service_id");
--> statement-breakpoint
-- GRANTS: 0001's `ALTER DEFAULT PRIVILEGES … ON TABLES` covers the table, and its
-- `… ON SEQUENCES` (USAGE, SELECT) covers `service_number_seq`. The table is
-- deliberately NOT append-only — unassigning is a DELETE — so no REVOKE follows.
RESET lock_timeout;
