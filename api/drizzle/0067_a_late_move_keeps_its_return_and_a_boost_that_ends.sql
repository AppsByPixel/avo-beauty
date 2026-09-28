-- ===========================================================================
-- A LATE MOVE KEEPS ITS RETURN, AND A BRANCH BOOST THAT ENDS.
--
-- Two additive changes, one migration number (trunk reserved 0067 for this
-- slice). Neither table's existing rows change meaning.
--
-- ---------------------------------------------------------------------------
-- 1. booking.policy_return_cap_percent — the reschedule loophole
-- ---------------------------------------------------------------------------
-- Trunk, 2026-09-29: moving a booking must not buy back a return she had
-- already lost. Under 48h→100% / 24h→50%, a booking 30 hours out returns 50%
-- on cancel; moved to next week it would return 100% — the move bought back
-- the half the salon had already earned the right to keep.
--
-- The column is the percent her own reschedule LOCKED IN: at each customer
-- reschedule of a POLICY booking, the percent a cancel would have returned at
-- that instant against the slot she moved AWAY from, folded in with `least()`
-- across every move. A cancel then returns the smaller of that cap and what
-- the stamped rules give against the CURRENT slot. services/bookingPolicy.ts
-- § cancellationOutcome carries the argument for a cap rather than measuring
-- every cut-off from the first slot for ever.
--
--   NULL          never moved by her (or LEGACY) — no cap, the rules decide.
--   0..100        the cap.
--
-- Only on a policy booking (`policy_id` NOT NULL): a legacy booking returns
-- the whole deposit whatever happens and has nothing to cap. The salon's own
-- reschedule does not write it — a salon moving an appointment is not her
-- buying anything back.
--
-- NO BACKFILL. 0066 is not deployed (production is on 0063); every policy
-- booking in a lane or demo database that was rescheduled was moved under the
-- loophole, and a guessed cap from audit rows is not a figure anyone chose.
--
-- ---------------------------------------------------------------------------
-- 2. boost.starts_at / ends_at / stopped_at / stopped_by / stopped_by_staff_id
-- ---------------------------------------------------------------------------
-- Aftab: "Duration and stop option in the branch boost in the marketing on
-- dashboard". A boost applies while `starts_at <= now < ends_at`, each bound
-- optional — the same half-open interval `isHappyHourLive` uses, and like it
-- there is NO `live` column: every reader (charge, top-up, wallet, dashboard)
-- resolves the predicate against its own clock. services/promotions.ts
-- § isBoostLive is the predicate; nothing flips a flag when a boost expires.
--
-- A STOP ends the boost now: the branch goes back to the neutral 1/0/1 and
-- loses its window, and who stopped it and when are recorded. Neutral rather
-- than "values kept, flagged stopped" is deliberate: a stopped row then pays
-- nothing through ANY reader, including a client too old to know the stop
-- columns exist, and there is no "stopped but carrying 2x" state for a later
-- set publish to resurrect by sending the values back. What was stopped is on
-- the audit row.
--
-- EXISTING BOOSTS GET NO END: all five columns NULL, which is exactly today's
-- behaviour — applies from publish until changed.
--
-- ---------------------------------------------------------------------------
-- SAFE UNDER THE DEPLOYED API
-- ---------------------------------------------------------------------------
-- Six nullable columns with no default (catalogue-only), one FK, four CHECKs
-- every existing row passes (every new column is NULL). The deployed API names
-- none of the new columns: its bookings carry no cap, which IS the old
-- behaviour, and its `PUT …/boosts` upsert leaves the five boost columns NULL
-- on insert and untouched on update. No row the old API can write on its own
-- fails any CHECK here.
--
-- The one interaction is during a rollout overlap: if the NEW API stops a
-- branch and the OLD API then publishes non-neutral values over it, the old
-- upsert does not clear `stopped_*`, and `boost_stopped_is_neutral` refuses
-- the write (23514). A loud failure for the length of the overlap, never a
-- stopped row quietly paying 2x.
--
-- lock_timeout 3s, the 0010/0011/0059/0063/0064/0065/0066 convention.
-- ===========================================================================

SET lock_timeout = '3s';--> statement-breakpoint

-- ------------------------------------------------------------- 1. booking --
ALTER TABLE "booking" ADD COLUMN "policy_return_cap_percent" smallint;
--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_policy_return_cap_valid"
  CHECK (
    "policy_return_cap_percent" IS NULL
    OR ("policy_id" IS NOT NULL AND "policy_return_cap_percent" BETWEEN 0 AND 100)
  );
--> statement-breakpoint

-- --------------------------------------------------------------- 2. boost --
ALTER TABLE "boost" ADD COLUMN "starts_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "boost" ADD COLUMN "ends_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "boost" ADD COLUMN "stopped_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "boost" ADD COLUMN "stopped_by" text;
--> statement-breakpoint
ALTER TABLE "boost" ADD COLUMN "stopped_by_staff_id" text;
--> statement-breakpoint
ALTER TABLE "boost" ADD CONSTRAINT "boost_stopped_by_staff_fk"
  FOREIGN KEY ("stopped_by_staff_id") REFERENCES "public"."staff_user"("id") ON DELETE restrict;
--> statement-breakpoint
-- Half-open `[starts_at, ends_at)`: an end at or before the start is a boost
-- that can never apply, which is a mistake to refuse rather than store.
ALTER TABLE "boost" ADD CONSTRAINT "boost_window_ordered"
  CHECK ("starts_at" IS NULL OR "ends_at" IS NULL OR "ends_at" > "starts_at");
--> statement-breakpoint
-- Who and when, together or not at all.
ALTER TABLE "boost" ADD CONSTRAINT "boost_stop_is_whole"
  CHECK (
    ("stopped_at" IS NULL AND "stopped_by" IS NULL AND "stopped_by_staff_id" IS NULL)
    OR ("stopped_at" IS NOT NULL AND "stopped_by" IS NOT NULL AND "stopped_by_staff_id" IS NOT NULL)
  );
--> statement-breakpoint
-- A stopped boost pays nothing and has no window. See § 2.
ALTER TABLE "boost" ADD CONSTRAINT "boost_stopped_is_neutral"
  CHECK (
    "stopped_at" IS NULL
    OR ("visit" = 1 AND "topup" = 0 AND "stamp" = 1 AND "starts_at" IS NULL AND "ends_at" IS NULL)
  );
