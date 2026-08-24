-- ===========================================================================
-- 0037 — the two facts the onboarding wizard collects and nothing could store
--
-- THE GAP: `DECISIONS.md` § "White-label onboarding is a wizard" recorded that no
-- salon can be created today — no `POST /salons`, no `POST /v1/platform/salons`,
-- and `api-contract.md` names neither, so onboarding a real client meant a
-- hand-written INSERT. This migration is the schema half of closing that.
--
-- The flow is DESIGNED, not invented here: `design/README.md:165` and
-- `AVO Owner Console.dc.html` § ONBOARDING WIZARD draw four steps — details &
-- plan, modules & deposit, loyalty & brand colour, review. Step 1 gates its
-- Continue button on THREE fields (`wizReady = wName && wCity && wPhone`), and
-- two of the three had no column anywhere:
--
--   city         drawn in the salon list row and the editor header
--                ("Salmiya · Growth plan · 1,284 members"), and already recorded
--                as absent by `routes/platformConsole.ts`: "NO `city`. `salon`
--                has no city column".
--   owner_phone  "Owner contact (WhatsApp)" — the DESTINATION of the invite the
--                review step promises: "Creating the salon sends the owner a
--                WhatsApp invite with their dashboard sign-in".
--
-- Without them the create endpoint would have had to accept two required fields
-- and silently drop them, which is the failure this codebase keeps naming: a
-- console that believes it recorded something it did not.
--
-- REPORTED AS CONTRACT ADDITIONS. `api-contract.md` § Salon and
-- `packages/types`' `SalonSchema` carry neither; both are trunk-owned. A client
-- parsing the salon response through that Zod object strips `city` rather than
-- failing, so this is additive in both directions.
--
-- BOTH NULLABLE, and that is not laziness. This table already holds rows —
-- SAL-AMARA and SAL-LUMIERE in every developer and CI database, and whatever a
-- pilot has — and a NOT NULL column needs a default or a backfill. There is no
-- honest default for either: a city AVO invented for a real salon is a false
-- fact, and a placeholder phone number is a message addressed to nobody. NULL is
-- "not supplied", which is true.
--
-- WHY `owner_phone` IS HERE AND NOT ON `staff_user` OR `staff_password_reset`:
--   - `staff_user` has no contact column at all, and adding one puts a phone on
--     every scanner account across four surfaces. Different decision.
--   - `staff_password_reset` is an OUTBOX and its rows are consumed. The owner
--     contact is durable — "who does AVO call about this account" — and
--     re-issuing an invite must not mean re-typing the number.
-- It is deliberately NOT served by `GET /salons/{id}`, which any authenticated
-- principal of the salon can read, members included.
--
-- CONSTRAINTS RESTATE RULES THAT ALREADY EXIST ELSEWHERE IN THIS SCHEMA:
--   salon_city_not_blank        the `salon_name_ar_not_blank` rule. Absent is
--                               NULL; '' is a rendering bug ("· Growth plan").
--   salon_owner_phone_is_e164   byte-identical to `member_phone_is_e164`, so a
--                               number that passes `parseE164` at the boundary
--                               cannot be refused here as a 500.
--
-- No new grants: 0001's defaults already cover `salon` for avo_app, and a column
-- inherits the table's privileges. Idempotent and safe to re-run.
-- ===========================================================================

ALTER TABLE salon ADD COLUMN IF NOT EXISTS city text;--> statement-breakpoint
ALTER TABLE salon ADD COLUMN IF NOT EXISTS owner_phone text;--> statement-breakpoint

-- `ADD CONSTRAINT` has no IF NOT EXISTS in Postgres, so each one is guarded by a
-- catalog lookup rather than by a swallowed error. 0022 adds an identical
-- not-blank CHECK unguarded, which is fine — the drizzle journal applies each
-- file once — but 0036 states re-runnability as a property and this file keeps
-- that, because the guard costs one catalog read and a half-applied migration is
-- the expensive thing to debug.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'salon_city_not_blank'
  ) THEN
    ALTER TABLE salon ADD CONSTRAINT salon_city_not_blank
      CHECK (city IS NULL OR length(btrim(city)) > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'salon_owner_phone_is_e164'
  ) THEN
    ALTER TABLE salon ADD CONSTRAINT salon_owner_phone_is_e164
      CHECK (owner_phone IS NULL OR owner_phone ~ '^\+[1-9][0-9]{6,14}$');
  END IF;
END $$;
