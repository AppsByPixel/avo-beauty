-- ===========================================================================
-- 0071 — A ONE-TIME DOWNLOAD LINK THE OWNER CONSOLE CAN HOLD.
--
-- Aftab, 2026-10-05: "The way we added so much graphs and valuable analytics
-- for the merchant dashboard, we need to do similar for the admin console."
-- `GET /v1/platform/analytics.csv` and `POST /v1/platform/analytics/download-url`
-- mirror the Overview export (routes/overview.ts), and that export's link is a
-- `report_download` row. 0036 made that table for STAFF:
--
--   staff_id   NOT NULL REFERENCES staff_user   — a platform admin is not staff
--   salon_id   NOT NULL REFERENCES salon        — the console's export is across
--                                                 every salon unless `?salon=`
--
-- so a console link could not be written without lying in one of them: a staff
-- id that is not a staff member, or a salon the file is not about.
--
-- WHAT CHANGES
--
--   platform_admin_id   NEW, nullable, REFERENCES platform_admin. The minting
--                       admin, whose sections are re-read at redemption exactly
--                       as a staff row's permissions are.
--   staff_id            NOT NULL dropped.
--   salon_id            NOT NULL dropped. On a console row it is the `?salon=`
--                       scope, or NULL for every salon.
--
-- AND ONE CHECK THAT SAYS WHOSE ROW IT IS, in both directions:
--
--   a staff row      staff_id and salon_id set, platform_admin_id NULL, and a
--                    kind that does NOT begin `platform-` — every row 0036 ever
--                    wrote, unchanged;
--   a console row    platform_admin_id set, staff_id NULL, and a kind that DOES
--                    begin `platform-`.
--
-- The kind half is the load-bearing one. `GET /report-downloads/:token`
-- dispatches on `kind`, so without it a staff-minted row could in principle
-- carry a console kind (or the reverse) and be redeemed through the other
-- door's permission check. With it, the dispatch and the principal are one fact
-- the database holds, and the route's own null checks are the second line.
--
-- ---------------------------------------------------------------------------
-- SAFE UNDER THE DEPLOYED API, AND ORDER-FREE
-- ---------------------------------------------------------------------------
-- Every existing row satisfies the CHECK (0036's kinds are the six Reports
-- kinds and `overview[:section]`; none begins `platform-`). The deployed API
-- writes staff rows only, with both columns set, so it never meets the relaxed
-- NOT NULLs. The new API without this migration fails only the console mint
-- (the insert names a column that does not exist) — the staff paths are
-- untouched.
--
-- LOCKING. ALTER TABLE takes ACCESS EXCLUSIVE on `report_download`, a table of
-- sixty-second tokens that only the two export mints and the redemption touch.
-- The ADD CONSTRAINT validates by scanning it, which is milliseconds.
-- lock_timeout 3s, the 0010/0011/0059/0063..0070 convention.
-- ===========================================================================

SET lock_timeout = '3s';--> statement-breakpoint

ALTER TABLE report_download
  ADD COLUMN IF NOT EXISTS platform_admin_id text
    REFERENCES platform_admin(id) ON DELETE CASCADE;--> statement-breakpoint

ALTER TABLE report_download ALTER COLUMN staff_id DROP NOT NULL;--> statement-breakpoint

ALTER TABLE report_download ALTER COLUMN salon_id DROP NOT NULL;--> statement-breakpoint

ALTER TABLE report_download DROP CONSTRAINT IF EXISTS report_download_one_principal;--> statement-breakpoint

ALTER TABLE report_download ADD CONSTRAINT report_download_one_principal CHECK (
  (platform_admin_id IS NULL
     AND staff_id IS NOT NULL
     AND salon_id IS NOT NULL
     AND kind NOT LIKE 'platform-%')
  OR
  (platform_admin_id IS NOT NULL
     AND staff_id IS NULL
     AND kind LIKE 'platform-%')
);--> statement-breakpoint

RESET lock_timeout;
