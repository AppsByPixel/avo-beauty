-- ===========================================================================
-- 0022 — a service has an Arabic name
--
-- WHAT WAS WRONG
-- --------------
-- `packages/types` now declares `Service.nameAr` and `Service.active`, and the
-- API served neither: `GET /salons/{id}/services` selected `{id, name,
-- priceFils}` and the column did not exist at all.
--
-- The Book flow is the most Arabic-heavy screen in the wallet — a customer
-- picks a service, an artist and a slot, and the first of those was rendering
-- "Colour — roots" in the middle of an RTL layout. Non-negotiable #12 calls
-- Arabic a first-class layout rather than a translation pass; a first-class
-- layout cannot render a name the API does not have.
--
-- Salon, Branch and Artist all carry `name_ar` (migrations 0006 and 0007).
-- Service was the omission, and it is the one a customer reads most often,
-- because it is also the line on every receipt and every transaction detail.
--
-- NULLABLE, NOT NOT-NULL-WITH-DEFAULT — the reasoning of 0006 verbatim
-- --------------------------------------------------------------------
-- A salon that has not supplied an Arabic name has not supplied one. Defaulting
-- the column to the Latin name would make "untranslated" indistinguishable from
-- "translated to the same string" and would hand every client a value that looks
-- authored. NULL says the thing that is true, and the client falls back to
-- `name` the way it already does for a branch.
--
-- No backfill, for the same reason. Every existing row becomes NULL, which is
-- the correct statement about a service nobody has asked for an Arabic name yet.
--
-- `active` NEEDS NO MIGRATION. The column has existed since 0000 — "retired
-- services stay for old transactions to reference; they just can't be charged".
-- It was simply never serialised. That half of the drift is a route change, not
-- a schema change, and it is in the same commit.
--
-- Grants: `avo_app` holds table-level GRANT SELECT, INSERT, UPDATE from
-- migration 0001, and a column added later inherits it. Nothing to re-grant.
-- ===========================================================================

ALTER TABLE "service" ADD COLUMN "name_ar" text;--> statement-breakpoint

-- An empty string is not a translation, it is a rendering bug waiting to happen:
-- `'' ?? name` is `''`, so a blank Arabic name defeats the fallback and paints an
-- empty line on a receipt. Absent is NULL; present means present. Same CHECK as
-- `salon_name_ar_not_blank` and `branch_name_ar_not_blank` in 0006.
ALTER TABLE "service" ADD CONSTRAINT "service_name_ar_not_blank"
  CHECK ("name_ar" IS NULL OR length(btrim("name_ar")) > 0);
