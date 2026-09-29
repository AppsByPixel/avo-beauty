-- ===========================================================================
-- A BRANCH BOOST PAYS NO TOP-UP BONUS. IT NEVER DID, AND NOW IT CANNOT SAY SO.
--
-- Aftab, 2026-09-29: "Remove it from boosts". DECISIONS.md § "Branch boosts
-- lose the top-up bonus".
--
-- WHAT WAS WRONG. `boost.topup` was a merchant setting, drawn as the
-- dashboard's "Top-up bonus" stepper and the wallet's "+10% top-ups" chip, and
-- nothing ever paid it. A top-up happens in the app and has no branch, so
-- services/topup.ts hands `decideEarning` a NULL branch and no branch boost is
-- ever found for it. The column was a promise of money with no path to money.
--
-- WHAT THIS DOES, IN ORDER
-- ------------------------
--   1. Every existing `topup` goes to 0.
--   2. A row that step 1 left NEUTRAL (1/0/1) loses its window too. The API
--      stores a neutral branch as ONE shape — `parseBoost` drops the window on
--      "no boost" — and a top-up-only boost with an `ends_at` would otherwise
--      become a window on nothing, which the next unchanged publish would
--      read as "changed".
--   3. `boost_topup_removed` holds it at 0.
--
-- THE UPDATE COMES FIRST for 0051's reason: a non-zero row is storable today,
-- and `ADD CONSTRAINT` would fail on it. A migration that cannot apply is not
-- a guarantee. It REWRITES A MERCHANT'S SETTING, said out loud, and it is
-- defensible because the setting never moved a fil. A deployment with real
-- salons can read what is about to change first:
--
--   SELECT salon_id, branch_id, visit, topup, stamp, starts_at, ends_at
--     FROM boost WHERE topup <> 0;
--
-- The seed stored `topup = 10` on BR-KWC, and db/seed.ts now stores 0.
--
-- WHAT STAYS
-- ----------
-- THE COLUMN, AND THE WIRE FIELD. `BoostSchema.topup` is required on the wire
-- in every installed wallet and every dashboard build, so it is served as 0
-- for ever rather than removed. Dropping it would be a four-way break for
-- nothing.
--
-- `boost_topup_in_range` (0..30) STAYS. It is now subsumed and cannot fire, so
-- it is redundant. It is kept because this migration is additive by brief, and
-- dropping it buys nothing on a deployed database.
--
-- `boost_stopped_is_neutral` still says `topup = 0`, and is now always true of
-- that clause.
--
-- ---------------------------------------------------------------------------
-- SAFE UNDER THE DEPLOYED API — production is on 0063; 0064..0068 apply in order
-- ---------------------------------------------------------------------------
-- No column is added or dropped. The deployed API reads `topup` and gets 0,
-- which is what it already paid. Its `PUT …/boosts` upsert writes whatever
-- `topup` the dashboard sent. The dashboard deploys first and sends 0 once
-- its stepper is gone, so the only write this refuses is a stale dashboard
-- that still has the stepper, sending a non-zero value to the OLD API during
-- the overlap. That write fails with 23514 and a 500. It is loud and brief,
-- and it never stores a bonus nobody pays. The new API refuses the same body
-- at the door with 400 `boost_topup_removed`.
--
-- lock_timeout 3s, the 0010/0011/0059/0063..0067 convention. `boost` is one
-- row per branch, so the validating scan under ADD CONSTRAINT is trivial.
-- ===========================================================================

SET lock_timeout = '3s';--> statement-breakpoint

UPDATE "boost"
   SET "topup" = 0,
       "starts_at" = CASE WHEN "visit" = 1 AND "stamp" = 1 THEN NULL ELSE "starts_at" END,
       "ends_at"   = CASE WHEN "visit" = 1 AND "stamp" = 1 THEN NULL ELSE "ends_at" END,
       "updated_at" = now()
 WHERE "topup" <> 0;
--> statement-breakpoint
ALTER TABLE "boost" ADD CONSTRAINT "boost_topup_removed" CHECK ("topup" = 0);
