-- ===========================================================================
-- 0033 — the console's password-reset outbox, so an invited platform admin can
--        actually get in
--
-- THE DEFECT THIS CLOSES, stated plainly: an invited platform admin could not sign
-- in AT ALL. `POST /v1/platform/admins` creates her with `password_hash` NULL —
-- correctly, because non-negotiable #6 says "Owner console only sends a reset
-- link" and the design's "Temporary password" field is refused by name — and
-- `POST /auth/platform/session` refuses a NULL hash. So the invite worked, the
-- refusal worked, and there was no door between them. routes/platformAdmins.ts said
-- so in its own header: "she sets her own password through the existing
-- `POST /auth/staff/password-reset`-shaped flow once one exists for the console.
-- Until then an invited admin cannot sign in, which is the honest state and is
-- reported rather than worked around by accepting a plaintext password on the
-- wire." This is that flow.
--
-- A SEPARATE TABLE FROM `staff_password_reset`, NOT A WIDENED ONE
-- --------------------------------------------------------------
-- `staff_password_reset.staff_id` REFERENCES `staff_user(id)` and its `salon_id` is
-- NOT NULL. A platform admin is neither: she has no salon, and there is exactly one
-- platform. Reusing that table would have meant making `staff_id` nullable, adding
-- a nullable `platform_admin_id`, and adding a CHECK that exactly one of them is
-- set — three weakenings of a table that currently cannot hold a row pointing at
-- nothing, to save one CREATE TABLE. The two tables also age differently: the staff
-- flow carries a re-hire path (`staff_user_deactivated_holds_no_credential` forces
-- re-activation and the password into one UPDATE) and this one deliberately does
-- not. See the route.
--
-- WHAT IS STORED IS A SHA256, NEVER THE TOKEN
-- ------------------------------------------
-- Same as `session.refresh_token_hash` and `wallet_token.token_hash`: a database
-- dump is not a list of live reset links. The token exists in exactly two places —
-- the message the admin receives, and nowhere else. No endpoint returns it, which
-- is the half of #6 that a "sends a link" implementation gets wrong by returning
-- the link to the caller: it would sit in the inviter's network log, and she could
-- set the password herself and know it.
--
-- `used_at` AND THE PARTIAL INDEX ARE WHAT MAKE A LINK SINGLE-USE. Two redemptions
-- of one link racing each other is the double-tapped scanner in another costume,
-- and the route resolves it the same way: the UPDATE that spends the row carries
-- `used_at IS NULL`, so exactly one racer wins and the loser is refused.
--
-- `sent_at` IS AN OUTBOX STAMP AND IS EXPECTED TO STAY NULL FOR NOW. No sender is
-- wired, for the reason receipts/types.ts sets out — the WhatsApp templates are
-- unapproved and the sending domain is an open client decision (CLAUDE.md
-- escalations). `staff_password_reset` has the same column for the same reason.
-- This migration makes the flow exist; delivery remains blocked on that escalation,
-- and that is stated rather than implied.
--
-- NO `salon_id` COLUMN AT ALL, which is the same structural argument
-- `platform_settings` and `platform_messaging_policy` rest on: there is nothing a
-- salon-scoped route could select, so a merchant cannot reach a console admin's
-- reset by writing a predicate.
--
-- LOCKING: one CREATE TABLE on a table that does not exist.
-- GRANTS: 0001's ALTER DEFAULT PRIVILEGES covers it.
--
-- Idempotent and safe to re-run.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS platform_admin_password_reset (
  id                 uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  platform_admin_id  text NOT NULL REFERENCES platform_admin(id) ON DELETE CASCADE,
  token_hash         text NOT NULL,
  /** Who asked. A reset is an access event; the row carries the fact too. */
  requested_by       text NOT NULL,
  expires_at         timestamptz NOT NULL,
  sent_at            timestamptz,
  used_at            timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT platform_admin_password_reset_expires_after_creation
    CHECK (expires_at > created_at)
);--> statement-breakpoint

-- One live link per token value. The lookup is by hash, so this is both the
-- uniqueness guarantee and the index that lookup uses.
CREATE UNIQUE INDEX IF NOT EXISTS platform_admin_password_reset_token_uq
  ON platform_admin_password_reset (token_hash);--> statement-breakpoint

-- "Does this admin have an outstanding link?" — asked when a second one is issued
-- (which spends the first) and when she is deactivated (which spends them all, so a
-- removed admin cannot walk back in with a link issued before her removal).
CREATE INDEX IF NOT EXISTS platform_admin_password_reset_live_idx
  ON platform_admin_password_reset (platform_admin_id) WHERE used_at IS NULL;
