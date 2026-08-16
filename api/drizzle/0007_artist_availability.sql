-- ===========================================================================
-- 0007 — artist, and the availability window the dashboard's Team screen edits
--
-- WHY A TABLE AND NOT FOUR COLUMNS ON staff_user
-- ---------------------------------------------
-- api-contract.md § Artist: "Artists do **not** need an AVO login." A salon's
-- bookable people and its sign-in accounts are overlapping sets, not one set —
-- a visiting colourist is bookable with no credential at all, and the
-- receptionist holding `perms.team` is an account nobody books. Folding them
-- together forces a `staff_user` row per artist, which means inventing rows in
-- the exact table the permission system reads on every request.
--
-- `staff_user_id` is the optional link back, UNIQUE where present, so an artist
-- who does hold a scanner PIN can set her own week through
-- `PUT /artists/me/availability` and there is never a question of which artist
-- row a given login means.
--
-- `artist_google_source_requires_connection` IS THE POINT OF THIS MIGRATION
-- -----------------------------------------------------------------------
-- The contract says Google connect is "one-time and read-only for busy slots",
-- and the dashboard draws that as disabled day rows behind a Synced pill.
-- Read-only in a client is a courtesy — non-negotiable #7 — so the state that
-- decides it lives in this column and `PUT /artists/{id}/availability` refuses a
-- window edit while it says `google`. The CHECK holds the half a database can:
-- a row cannot claim its hours come from a calendar it is not connected to.
--
-- The reverse is deliberately allowed. `google_connected = true` with
-- `availability_source = 'manual'` is the normal, expected state after
-- reception switches the segmented control — the calendar stays linked for busy
-- blocks while the bookable window is set by hand.
--
-- WINDOWS AS ONE JSONB DOCUMENT
-- -----------------------------
-- Same reasoning as `salon.tiers`: a week of hours is edited and saved as a
-- whole, so it is written as a whole. Seven columns would let a save land half
-- applied, which for availability means a Tuesday that closed and a Wednesday
-- that did not.
--
-- TIMEZONE — DELIBERATELY ABSENT, AND WRITTEN DOWN RATHER THAN DECIDED
-- --------------------------------------------------------------------
-- `windows[d].from` / `.to` are naive wall clock ("10:00"), exactly like
-- `salon.business_hours` and exactly like the happy-hour times in
-- design/avo-promotions.js. There is no timezone column anywhere in this schema
-- and this migration does not add one.
--
-- That is correct today for one reason only: every AVO salon is in Kuwait,
-- Kuwait is UTC+3, and Kuwait has no daylight saving, so a single implicit
-- offset is right for every row all year. It stops being correct the day AVO
-- signs a salon anywhere else, and the failure is silent — see the header of
-- api/src/routes/artists.ts for exactly what breaks and why the eventual fix has
-- to be an IANA zone id and not a stored offset. Choosing a zone is a client
-- decision (CLAUDE.md § Escalate, don't guess); adding the column on one lane's
-- judgement would be read as settled by the next three.
--
-- GRANTS
-- ------
-- Migration 0001 set `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,
-- INSERT, UPDATE, DELETE ON TABLES TO avo_app`, so this table inherits the
-- baseline with nothing to re-grant. `artist` is NOT append-only — hours are
-- meant to be edited — so no REVOKE is written here, which is the decision 0001
-- asks a later migration to state out loud rather than leave to a reader.
-- ===========================================================================

CREATE TYPE "public"."availability_source" AS ENUM('google', 'manual');--> statement-breakpoint

CREATE TABLE "artist" (
	"id" text PRIMARY KEY NOT NULL,
	"salon_id" text NOT NULL,
	"staff_user_id" text,
	"name" text NOT NULL,
	"name_ar" text,
	"availability_source" "availability_source" DEFAULT 'manual' NOT NULL,
	"google_connected" boolean DEFAULT false NOT NULL,
	"slot_minutes" integer DEFAULT 30 NOT NULL,
	"windows" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artist_slot_minutes_allowed" CHECK ("artist"."slot_minutes" IN (15, 20, 30, 45, 60)),
	CONSTRAINT "artist_google_source_requires_connection" CHECK ("artist"."availability_source" <> 'google' OR "artist"."google_connected"),
	CONSTRAINT "artist_name_ar_not_blank" CHECK ("artist"."name_ar" IS NULL OR length(btrim("artist"."name_ar")) > 0)
);
--> statement-breakpoint

ALTER TABLE "artist" ADD CONSTRAINT "artist_salon_id_salon_id_fk" FOREIGN KEY ("salon_id") REFERENCES "public"."salon"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artist" ADD CONSTRAINT "artist_staff_user_id_staff_user_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."staff_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "artist_salon_idx" ON "artist" USING btree ("salon_id");--> statement-breakpoint
CREATE UNIQUE INDEX "artist_staff_user_uq" ON "artist" USING btree ("staff_user_id") WHERE staff_user_id IS NOT NULL;
