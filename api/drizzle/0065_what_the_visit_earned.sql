-- ===========================================================================
-- WHAT THE VISIT EARNED — the charge row records its own loyalty outcome.
--
-- DECISIONS.md § "The fourth list", 2026-09-29: "show what she gained". The
-- scanner's success screen and her wallet both say "+1 visit · 2 more to
-- Gold" or the stamp equivalent. The scanner can read it off the `POST
-- /charges` response. Her wallet cannot: `GET /members/me/transactions`
-- serves transaction rows, and nothing on a transaction row said what the
-- visit earned. The increment was computed inside the charge (services/
-- charge.ts § 9), applied to `member.visits` or `member.stamps`, and thrown
-- away.
--
-- AND THROWING IT AWAY WAS A MONEY-ADJACENT BUG, NOT ONLY A MISSING LINE.
-- `POST /voids` could not know what it was undoing, so it took off exactly
-- one visit, always (`visits: Math.max(0, m.visits - 1)`). A visit doubled by
-- a branch boost or an x2visit happy hour lost one of its two on void, and on
-- a stamp card a void took a visit that was never given and left the stamps
-- the charge had added. The void now takes back what THIS column says the
-- charge earned — routes/charges.ts § performVoid.
--
-- ---------------------------------------------------------------------------
-- THE SIX COLUMNS
-- ---------------------------------------------------------------------------
--   loyalty_mode           the salon's mode AT CHARGE TIME. Not re-read from
--                          `salon` later: a salon that changes mode must not
--                          change what an old charge says it earned, and a
--                          void must undo the counter that was actually moved.
--   loyalty_visits_earned  tiers mode: the increment APPLIED, after any
--   loyalty_stamps_earned  multiplier. stamps mode: likewise. Exactly one is
--                          set, by the mode.
--   loyalty_tier_after     tiers mode: the rung after this charge. NULL in
--                          stamps mode, and NULL is also a legal tiers value
--                          (a ladder whose bottom rung is above her count).
--   loyalty_climbed        tiers mode: this charge changed her rung. Always
--                          false in stamps mode — nothing climbs a stamp card.
--   loyalty_reward_ready   stamps mode: the card is full after this charge —
--                          the same `stamps >= target` the charge response
--                          sends, so the till and her wallet cannot disagree.
--                          Always false in tiers mode.
--
-- The enums are the existing `loyalty_mode` and `tier_name`, not new text
-- columns, so a seventh spelling of "gold" cannot be stored here.
--
-- ---------------------------------------------------------------------------
-- NULLABLE, AND NO BACKFILL
-- ---------------------------------------------------------------------------
-- 0050's argument, for the same reason. Every charge already in this table
-- earned something, and nothing recorded what. A backfill would have to guess
-- the multiplier: `transaction.promotion_id` names a happy hour but a branch
-- boost moves the rate with no window at all (services/promotions.ts §
-- decideEarning leaves `happyHourId` null), so "no promotion, therefore +1" is
-- false at exactly the enrolled tills a boost pays at. A guessed number
-- committed to a column is worse than no number: it can never be questioned
-- again. NULL means "this charge recorded no outcome", the wallet renders that
-- as it renders every row today, and `POST /voids` falls back to its old
-- arithmetic for it (charges.ts § THE FALLBACK).
--
-- ---------------------------------------------------------------------------
-- THE CONSTRAINTS
-- ---------------------------------------------------------------------------
--   `..._loyalty_is_charge_only`  A loyalty outcome describes a CHARGE. Same
--                                 shape as `..._custom_amount_is_charge_only`
--                                 (0049). A shop order also earns a visit
--                                 (services/order.ts § 8) and does not record
--                                 one here yet; widening this to `shop` is a
--                                 one-line migration when that is ruled, and
--                                 it is not ruled.
--   `..._loyalty_is_whole`        All six NULL, or a complete tiers record, or
--                                 a complete stamps record. A half-written
--                                 outcome is a row a void cannot act on and a
--                                 wallet cannot render.
--   `..._loyalty_earned_non_negative`  An increment is never negative. Zero is
--                                 allowed rather than refused: nothing earns
--                                 zero today (multipliers floor at 1), and a
--                                 future rule that awards nothing should be a
--                                 row that says 0, not a charge that fails.
--
-- ---------------------------------------------------------------------------
-- SAFE UNDER THE DEPLOYED API
-- ---------------------------------------------------------------------------
-- The API live on the demo (3dee53e) inserts charges naming none of these
-- columns, so every row it writes is all-NULL: `is_charge_only` reads true,
-- `is_whole` takes its first arm, `non_negative` reads true. Its SELECTs name
-- their columns through Drizzle, so six unread columns change nothing it
-- serialises, and its void reads none of them. Every existing row passes all
-- three CHECKs for the same reason. Six nullable columns and three CHECKs,
-- nothing renamed, nothing dropped, nothing backfilled. Applies after 0064,
-- which it does not touch (`campaign`, `campaign_reward`).
--
-- `transaction_revenue` (0042) selects named columns, so the view is
-- untouched. NO INDEX: nothing queries by these; every reader already has the
-- row in hand.
--
-- LOCKING: ADD COLUMN with no default is a catalogue change (ACCESS
-- EXCLUSIVE, milliseconds, no rewrite). The three CHECKs scan `transaction`
-- once each. lock_timeout 3s, the 0010/0011/0059/0063/0064 convention, so a
-- long transaction holding `transaction` fails this rather than queueing every
-- charge behind it.
-- ===========================================================================

SET lock_timeout = '3s';--> statement-breakpoint

ALTER TABLE "transaction" ADD COLUMN "loyalty_mode" "loyalty_mode";
--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN "loyalty_visits_earned" integer;
--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN "loyalty_stamps_earned" integer;
--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN "loyalty_tier_after" "tier_name";
--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN "loyalty_climbed" boolean;
--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN "loyalty_reward_ready" boolean;
--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_loyalty_is_charge_only"
  CHECK ("loyalty_mode" IS NULL OR "kind" = 'charge');
--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_loyalty_is_whole"
  CHECK (
    (
      "loyalty_mode" IS NULL
      AND "loyalty_visits_earned" IS NULL
      AND "loyalty_stamps_earned" IS NULL
      AND "loyalty_tier_after" IS NULL
      AND "loyalty_climbed" IS NULL
      AND "loyalty_reward_ready" IS NULL
    )
    OR (
      "loyalty_mode" = 'tiers'
      AND "loyalty_visits_earned" IS NOT NULL
      AND "loyalty_stamps_earned" IS NULL
      AND "loyalty_climbed" IS NOT NULL
      AND "loyalty_reward_ready" = false
    )
    OR (
      "loyalty_mode" = 'stamps'
      AND "loyalty_stamps_earned" IS NOT NULL
      AND "loyalty_visits_earned" IS NULL
      AND "loyalty_tier_after" IS NULL
      AND "loyalty_climbed" = false
      AND "loyalty_reward_ready" IS NOT NULL
    )
  );
--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_loyalty_earned_non_negative"
  CHECK (
    ("loyalty_visits_earned" IS NULL OR "loyalty_visits_earned" >= 0)
    AND ("loyalty_stamps_earned" IS NULL OR "loyalty_stamps_earned" >= 0)
  );
--> statement-breakpoint
RESET lock_timeout;
