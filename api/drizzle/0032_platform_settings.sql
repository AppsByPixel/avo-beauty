-- ===========================================================================
-- 0032 — platform settings, so the console's Controls screen controls something
--
-- `AVO Owner Console.dc.html` § CONTROLS draws "Every platform switch, fee and
-- default": five switches, the flat KNET fee in fils, the card percentage, and the
-- deposit every new salon starts with. None of it had anywhere to live.
--
-- THE COMMISSION IS THE PART THAT MATTERS, and it is why this is a money-path
-- migration rather than a preferences table. `packages/types/src/money.ts` has:
--
--     export function commissionFor(amount, method, rates = DEFAULT_COMMISSION)
--
-- and `services/topup.ts:408` calls it as `commissionFor(input.amountFils,
-- input.method)` — taking the default, always. So AVO's commission was a constant
-- compiled into the clients and the server alike, and the console's stepper would
-- have moved a number on a screen and changed nothing. That is the shape this build
-- keeps finding: a capability that exists and goes unused, like
-- `PlatformMessagingPolicySchema` before 0028 and `isInQuietHours` before it was
-- called.
--
-- ONE ROW, singleton by CHECK, for the reason `platform_messaging_policy` is one:
-- there is no salon column, so there is nothing a salon-scoped route could select.
-- A merchant cannot read or change AVO's take.
--
-- WHY THE FEE COLUMNS ARE INTEGERS AND THE PERCENTAGE IS BASIS POINTS
-- ------------------------------------------------------------------
-- Non-negotiable #1 says no float touches money. The design's card control renders
-- "2.5 %", which is a float on a screen — so it is stored as 250 BASIS POINTS and
-- converted at the display boundary, exactly as fils are. A `numeric(4,2)` column
-- would put a decimal in the one place a rounding argument costs real money, and
-- `db:verify` invariant 4 asserts no float-family column exists anywhere in the
-- schema; this would have been the first.
--
-- `card_percent_bp` NOT `card_percent`, named so the unit cannot be mistaken by
-- somebody writing `2.5` into it.
--
-- AND THE BASIS POINTS ARE CONSTRAINED TO THE DESIGN'S OWN STEP, BECAUSE
-- MEASUREMENT SAID THEY HAD TO BE
-- ----------------------------------------------------------------------
-- Storing basis points does not by itself keep the arithmetic exact. The only
-- consumer is `commissionFor(amount, method, rates)`, whose `CommissionRates.
-- cardPercent` is a PERCENTAGE — so the server must hand it `bp / 100`, and that
-- division is the float this column was supposed to avoid, moved one step later.
--
-- Probed rather than argued, over bp 0..1000 and every exact half-fil boundary in
-- 1..10,000,000 fils:
--
--   half-fil boundaries checked: 7,800,000   diverged by one fil: 172,705
--   136 of the 1001 bp values are unsafe at some amount
--
-- e.g. 29 bp on 25.000 KD is 73 fils exactly and 72 fils through the float. A
-- real fil, in AVO's favour or the salon's depending on the rate, decided by the
-- last bit of a double.
--
-- THE DESIGN ALREADY RULED OUT EVERY UNSAFE VALUE. `AVO Owner Console.dc.html`
-- :1943 steps the card control by 0.5 and clamps it to 5:
--
--   decCard: Math.max(0, Math.round((x.cardPct - 0.5) * 10) / 10)
--   incCard: Math.min(5, ...)
--
-- so the attainable set is {0, 50, 100, ..., 500} bp, and all eleven are in the
-- provably-exact set. The CHECK below is therefore the DESIGN'S bound written
-- down, not an invented restriction, and it is what makes the `bp / 100` in
-- `services/platformSettings.ts` exact over the whole domain rather than merely
-- exact for the default.
--
-- The range also tightens from the 0..1000 a draft of this migration allowed.
-- "0..10%, well past anything a card processor charges" was a fine sentence about
-- a bound nothing enforced; 0..5% is the bound the product has.
--
-- THE KNET FEE IS NOT GIVEN A STEP CONSTRAINT, and the asymmetry is deliberate:
-- it is flat fils, it reaches `commissionFor` as an integer, and no division
-- touches it. A multiple-of-ten CHECK there would refuse a future 155 fils for no
-- correctness reason. A constraint that buys nothing is a constraint somebody
-- removes later without knowing what it was for.
--
-- LOCKING: one CREATE TABLE on a table that does not exist.
-- GRANTS: 0001's ALTER DEFAULT PRIVILEGES covers it.
--
-- Idempotent and safe to re-run.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS platform_settings (
  id                    text PRIMARY KEY NOT NULL DEFAULT 'avo',

  -- The five switches the design draws. Names are the design's own ids.
  flag_signups          boolean NOT NULL DEFAULT true,
  flag_booking          boolean NOT NULL DEFAULT true,
  flag_shop             boolean NOT NULL DEFAULT true,
  flag_wa               boolean NOT NULL DEFAULT true,
  flag_maintenance      boolean NOT NULL DEFAULT false,

  -- AVO's commission. Integers only — see the header.
  knet_flat_fils        bigint NOT NULL DEFAULT 150,
  card_percent_bp       integer NOT NULL DEFAULT 250,
  -- 50, NOT 0, and the difference is AVO's revenue. `DEFAULT_COMMISSION` in
  -- packages/types is `{ knetFlatFils: 150, cardPercent: 2.5, cardFlatFils: 50 }`,
  -- and every default here is copied from it so that creating this table changes
  -- nothing until somebody deliberately moves a stepper. I had written 0 from
  -- memory; the constant said 50.
  card_flat_fils        bigint NOT NULL DEFAULT 50,

  -- "The booking deposit each new salon starts with." Fils, like every other
  -- deposit in this schema; the design's stepper renders KD.
  new_salon_deposit_fils bigint NOT NULL DEFAULT 5000,

  updated_by            text,
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT platform_settings_is_singleton CHECK (id = 'avo'),
  -- The design's own stepper bounds: 0..500 fils in steps of ten.
  CONSTRAINT platform_settings_knet_fee_in_range CHECK (knet_flat_fils BETWEEN 0 AND 500),
  -- 0..5% in 0.5% steps — the design's own stepper, and the reason is in the
  -- header: every attainable value is one where `bp / 100` into `percentOf` is
  -- exact, and 136 of the values a wider range would allow are not.
  CONSTRAINT platform_settings_card_percent_in_range CHECK (card_percent_bp BETWEEN 0 AND 500),
  CONSTRAINT platform_settings_card_percent_is_half_a_point CHECK (card_percent_bp % 50 = 0),
  CONSTRAINT platform_settings_card_flat_non_negative CHECK (card_flat_fils >= 0),
  -- `salon_deposit_in_range` puts a salon's deposit between 1000 and 10000 fils, so
  -- a platform default outside that would create salons that violate it on insert.
  CONSTRAINT platform_settings_deposit_in_range
    CHECK (new_salon_deposit_fils BETWEEN 1000 AND 10000)
);--> statement-breakpoint

-- The row, so no handler has to decide what an absent settings row means. Every
-- default above is `DEFAULT_COMMISSION`'s or the design's, verified field by field
-- against packages/types/src/money.ts rather than recalled — so creating this table
-- changes no money.
INSERT INTO platform_settings (id) VALUES ('avo') ON CONFLICT (id) DO NOTHING;
