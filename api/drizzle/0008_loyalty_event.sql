-- ===========================================================================
-- 0008 - loyalty_event: the moment a member's standing changed
--
-- WHY THIS EXISTS
-- ---------------
-- design/AVO Merchant Dashboard.dc.html section Overview draws a Recent activity
-- feed mixing top-ups, charges, deposit returns, shop purchases AND tier changes
-- ("Reem S. reached Gold tier"). Four of those five are rows in `transaction`.
-- The fifth was not recoverable from anything stored: `member.tier` holds the
-- CURRENT rung and nothing held the move. A climb is a visit count crossing a
-- threshold, and neither the count before the charge nor the ladder as it stood
-- at that instant survives anywhere a feed can read.
--
-- So the choice was to record it, to omit it and serve a feed that quietly
-- differs from the design, or to infer it, which means guess.
--
-- WHY NOT audit_log
-- -----------------
-- It is the obvious append-only table and it is the wrong one. Its `kind` is the
-- dashboard's four filter chips (Money / Rules / Access / Risk) and a customer
-- reaching Gold is none of them. Filing it under `rules` would put "Reem S.
-- reached Gold tier" in the same filter as "Tier rules published", which is the
-- filter a merchant opens to find who changed the rules. audit_log records what
-- STAFF did. This records what a MEMBER became.
--
-- WRITTEN INSIDE THE CHARGE TRANSACTION
-- -------------------------------------
-- services/charge.ts already computed `climbed` in step 9 and discarded it. The
-- insert goes there, in the same transaction as the debit and the visit
-- increment, for the reason every other write in that flow is: a climb recorded
-- but rolled back, or applied but unrecorded, is a feed that disagrees with the
-- wallet. Non-negotiable #3.
--
-- APPEND-ONLY BY INTENT, NOT BY REVOKE, AND THAT IS THE DECISION
-- --------------------------------------------------------------
-- Migration 0001 asks every later table to state this out loud rather than leave
-- it to a reader, so: no REVOKE is written here. This is a derived record of
-- something that already happened, it feeds a dashboard panel, and nothing
-- reconciles against it. `audit_log` and `ledger_entry` earn their REVOKEs
-- because money and authority get argued about seven years later; a tier climb
-- does not. `avo_app` inherits the ordinary baseline from 0001's
-- ALTER DEFAULT PRIVILEGES.
--
-- from_tier IS NULLABLE, to_tier IS NOT
-- -------------------------------------
-- A member's first rung has nothing below it. A climb that names no destination
-- is not an event, which is what `loyalty_event_climb_has_destination` says.
-- Both ends are stored rather than only the destination because a republished
-- ladder with a raised threshold can move a member DOWN, and a feed announcing
-- "reached Bronze" to someone who was demoted is worse than silence.
-- ===========================================================================

CREATE TYPE "public"."loyalty_event_kind" AS ENUM('tier_climb', 'stamp_reward_ready');--> statement-breakpoint
CREATE TABLE "loyalty_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"salon_id" text NOT NULL,
	"member_id" text NOT NULL,
	"transaction_id" text,
	"kind" "loyalty_event_kind" NOT NULL,
	"from_tier" "tier_name",
	"to_tier" "tier_name",
	"stamps_after" integer,
	"stamp_target" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loyalty_event_climb_has_destination" CHECK ("loyalty_event"."kind" <> 'tier_climb' OR "loyalty_event"."to_tier" IS NOT NULL),
	CONSTRAINT "loyalty_event_stamp_has_card" CHECK ("loyalty_event"."kind" <> 'stamp_reward_ready'
          OR ("loyalty_event"."stamps_after" IS NOT NULL AND "loyalty_event"."stamp_target" IS NOT NULL)),
	CONSTRAINT "loyalty_event_kind_matches_fields" CHECK (("loyalty_event"."kind" = 'tier_climb' AND "loyalty_event"."stamps_after" IS NULL)
          OR ("loyalty_event"."kind" = 'stamp_reward_ready' AND "loyalty_event"."to_tier" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "loyalty_event" ADD CONSTRAINT "loyalty_event_salon_id_salon_id_fk" FOREIGN KEY ("salon_id") REFERENCES "public"."salon"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_event" ADD CONSTRAINT "loyalty_event_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_event" ADD CONSTRAINT "loyalty_event_transaction_id_transaction_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transaction"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "loyalty_event_salon_seq_idx" ON "loyalty_event" USING btree ("salon_id","seq" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "loyalty_event_member_seq_idx" ON "loyalty_event" USING btree ("member_id","seq" DESC NULLS LAST);