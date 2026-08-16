-- ===========================================================================
-- 0006 — the Arabic name fields the contract already promised
--
-- WHAT WAS WRONG
-- --------------
-- `packages/types` declares `Salon.nameAr`, `Branch.nameAr` and
-- `Salon.stampRewardAr`, because the bundle's own reference implementation
-- carries them (`design/avo-promotions.js` → `branchLabel`, which picks
-- `nameAr` when the language is `ar`) and the live AvoRewards app renders
-- `item?.nameAr` by language. The contract landed without the columns behind
-- it: there was no `name_ar` anywhere, and `GET /salons/{id}` omitted all
-- three.
--
-- The wallet's fallback (`nameAr ?? name`) therefore passed by accident —
-- `undefined ?? name` and `null ?? name` produce the same answer, so nobody
-- noticed the field was not being served at all. Non-negotiable #12 calls
-- Arabic a first-class layout; a first-class layout cannot render a name the
-- API does not have.
--
-- WHY NULLABLE AND NOT NOT-NULL-WITH-DEFAULT
-- ------------------------------------------
-- A salon that has not supplied an Arabic name has not supplied one. Defaulting
-- the column to the Latin name would make "untranslated" indistinguishable from
-- "translated to the same string", and would hand every client a value that
-- looks authored. NULL says the thing that is true, and the client falls back to
-- `name` the same way an untranslated legal document falls back to `en`.
--
-- That also makes the fallback TESTABLE. A rule exercised only by an absent key
-- never proves the null path: the "stringify bug", where a NULL reaches a client
-- as the four-character string "null", is invisible until a row genuinely holds
-- NULL. `api/src/db/seed.ts` seeds one deliberately.
--
-- No backfill. Every existing row becomes NULL, which is the correct statement
-- about a salon nobody has asked for an Arabic name yet.
--
-- Grants: `avo_app` holds table-level GRANT SELECT, INSERT, UPDATE from
-- migration 0001, and a column added later inherits it. Nothing to re-grant.
-- ===========================================================================

ALTER TABLE "salon" ADD COLUMN "name_ar" text;--> statement-breakpoint
ALTER TABLE "salon" ADD COLUMN "stamp_reward_ar" text;--> statement-breakpoint
ALTER TABLE "branch" ADD COLUMN "name_ar" text;--> statement-breakpoint

-- An empty string is not a translation, it is a rendering bug waiting to happen:
-- `'' ?? name` is `''`, so a blank Arabic name defeats the fallback and paints an
-- empty heading. Absent is NULL; present means present.
ALTER TABLE "salon" ADD CONSTRAINT "salon_name_ar_not_blank"
  CHECK ("name_ar" IS NULL OR length(btrim("name_ar")) > 0);--> statement-breakpoint
ALTER TABLE "salon" ADD CONSTRAINT "salon_stamp_reward_ar_not_blank"
  CHECK ("stamp_reward_ar" IS NULL OR length(btrim("stamp_reward_ar")) > 0);--> statement-breakpoint
ALTER TABLE "branch" ADD CONSTRAINT "branch_name_ar_not_blank"
  CHECK ("name_ar" IS NULL OR length(btrim("name_ar")) > 0);
