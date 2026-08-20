-- ===========================================================================
-- 0036 — one-time report download tokens, so a plain anchor can save a CSV
--
-- THE DEFECT (Lane C, driven): `resolvePrincipal` reads the `authorization`
-- header and nothing else, so the natural download — an <a href> to
-- `…/sales.csv` — carries no credential and saves a JSON 401 named `sales.csv`.
-- Lane C shipped an authenticated-fetch workaround; this table is what lets the
-- workaround collapse back to an anchor.
--
-- THE SHAPE IS THE CODEBASE'S OWN: an opaque CSPRNG token, stored as a sha256
-- (`wallet_token` and all three password-reset tables), SHORT-LIVED (60s — it is
-- minted by the click handler immediately before the anchor navigates) and
-- SINGLE-USE under a race via the conditional-spend UPDATE.
--
-- THE ROW STORES WHAT WAS MINTED — kind, salon, branch, period, and WHO — so the
-- redemption serves exactly the filter state the user was looking at, and the
-- minting principal's permission can be RE-CHECKED at redemption: a `team`
-- permission revoked between mint and click refuses the download. The token is a
-- capability, but a 60-second one that still answers to the permission table.
--
-- NO GRANTS BEYOND 0001's defaults; avo_app inserts, reads and spends its rows.
-- Idempotent and safe to re-run.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS report_download (
  id          uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  staff_id    text NOT NULL REFERENCES staff_user(id) ON DELETE CASCADE,
  salon_id    text NOT NULL REFERENCES salon(id) ON DELETE restrict,
  kind        text NOT NULL,
  branch_id   text REFERENCES branch(id) ON DELETE restrict,
  period      text NOT NULL,
  token_hash  text NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT report_download_expires_after_creation CHECK (expires_at > created_at)
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS report_download_token_uq
  ON report_download (token_hash);
