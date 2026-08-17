-- ===========================================================================
-- 0017 - staff onboarding: hiring, leaving, and a reset that is a LINK
--
-- build-plan.md phase 4. Until now `GET /staff` listed and `PATCH /staff/{id}`
-- adjusted the nine permissions, and that was the whole surface. A new
-- receptionist had to be INSERTed by hand with a hash produced by hand — which
-- is not merely a blocker, it is the exact circumstance in which somebody
-- stores a plaintext password to get through the afternoon.
--
-- WHY LEAVING IS `deactivated_at` AND NOT A DELETE
--
-- `transaction.created_by_staff_id`, `wallet_token.consumed_by_staff_id` and
-- `artist.staff_user_id` all reference this table, and `audit_log` names the
-- actor by id as a soft reference. A leaver's row is what makes a two-year-old
-- charge still say who took it. Same rule as the branch close in 0016 and the
-- happy-hour delete before it: the record outlives the operational interest.
--
-- Deactivation therefore removes the CREDENTIALS, not the row —
-- `password_hash` and `pin_hash` are nulled and every session is revoked, so a
-- leaver keeps nothing she can sign in with. Re-hiring her is a reset link
-- against the same row, which keeps her history attached to one identity
-- instead of forking it across two.
--
-- The roster deliberately keeps listing deactivated rows, flagged. Hiding them
-- would make `staff_user_salon_handle_uq` inexplicable: a manager re-hiring
-- somebody would be told the handle is taken by a row she cannot see.
--
-- THE RESET TABLE, AND NON-NEGOTIABLE #6
--
-- "Passwords are never stored in plaintext, never returned by an endpoint,
-- never shown in a UI. Owner console only ever sends a reset link."
--
-- So this table stores a sha256 of the token and never the token, exactly as
-- `session.refresh_token_hash` and `wallet_token.token_hash` do. The issuing
-- endpoint answers 202 with NO token in the body: a reset that comes back
-- through the manager's browser is a credential travelling through the wrong
-- pair of hands, which is the thing the non-negotiable is about. The row is an
-- outbox; the token reaches the staff member out of band.
--
-- Delivery is not wired, for the reason receipts/types.ts documents at length
-- and which is not this table's to solve: the WhatsApp templates are
-- unapproved and the sending domain is an open client decision. `sent_at` is
-- where a sender records itself when there is one.
--
-- Single-use and short-lived are enforced by `used_at` and `expires_at`, and
-- the partial index makes "is there a live reset for this staff member" the
-- cheap question the issuing endpoint asks to avoid minting a second token that
-- silently invalidates the first one somebody is already walking to their desk
-- with.
-- ===========================================================================

ALTER TABLE staff_user ADD COLUMN deactivated_at timestamptz;

CREATE INDEX staff_user_salon_active_idx ON staff_user (salon_id) WHERE deactivated_at IS NULL;

-- A deactivated staff member holds no credential. Belt and braces with the
-- handler: this is the invariant, the handler is the implementation of it.
ALTER TABLE staff_user ADD CONSTRAINT staff_user_deactivated_holds_no_credential
  CHECK (deactivated_at IS NULL OR (password_hash IS NULL AND pin_hash IS NULL));

CREATE TABLE staff_password_reset (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id      text NOT NULL REFERENCES staff_user (id) ON DELETE cascade,
  salon_id      text NOT NULL REFERENCES salon (id) ON DELETE restrict,

  -- sha256 of the token. The token itself exists in one HTTP response body that
  -- is never written, and in the message the staff member receives.
  token_hash    text NOT NULL,

  -- Who asked for it. A reset is an access event and the audit row names the
  -- actor; this keeps the fact on the row itself too.
  requested_by  text NOT NULL,

  expires_at    timestamptz NOT NULL,
  -- Stamped by a sender when there is one. NULL means "not delivered yet",
  -- which today means "no sender is wired" and not "delivery failed".
  sent_at       timestamptz,
  used_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT staff_password_reset_expires_after_creation CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX staff_password_reset_token_uq ON staff_password_reset (token_hash);
CREATE INDEX staff_password_reset_live_idx
  ON staff_password_reset (staff_id) WHERE used_at IS NULL;

-- GRANTS: migration 0001 set ALTER DEFAULT PRIVILEGES for avo_app on this
-- schema, so the new table is reachable by the application role without a
-- statement here. The audit_log REVOKE is untouched.
