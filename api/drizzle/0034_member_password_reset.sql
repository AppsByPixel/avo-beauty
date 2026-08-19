-- ===========================================================================
-- 0034 — the customer's own reset flow, so "Forgot my current password" leads
--        somewhere
--
-- THE DEFECT THIS CLOSES: api-contract.md § Profile edit rule 5 promises that
-- "Forgot my current password" drops into the existing WhatsApp reset-link flow —
-- and the wallet draws the control (ChangePasswordSheet's pwForgot). But auth.ts
-- carried STAFF and PLATFORM reset flows only. A customer who forgot her password
-- had a button that led nowhere and no way back into her own wallet, which holds
-- her money.
--
-- THE THIRD RESET TABLE, NOT A WIDENED SECOND. 0033 already made this argument
-- once and it holds a third time: `staff_password_reset.staff_id` references
-- `staff_user` with a NOT NULL `salon_id`; `platform_admin_password_reset`
-- references `platform_admin`. Pointing either at `member` means nullable
-- principals plus a CHECK that exactly one is set — weakenings of tables that
-- today cannot hold a row pointing at nothing. Three principals, three tables,
-- and each ages on its own terms: the staff flow carries a re-hire path, the
-- console flow refuses a deactivated admin, and this one interacts with the
-- DELETION GRACE WINDOW (see the route) in a way neither of the others has.
--
-- `requested_ip`, NOT `requested_by`. The other two flows store the NAME of an
-- authenticated requester — a manager, an inviter. This flow is self-service and
-- unauthenticated by necessity (she cannot sign in; that is the point), so there
-- is no name to store and inventing one ("self") would dress a claim up as a
-- fact. What is true and worth keeping is which connection asked, so that is the
-- column. Nullable for the same reason `signup_attempt.ip_address` is: a caller
-- Fastify cannot attribute still gets counted, not exempted.
--
-- NO `salon_id` COLUMN, deliberately, even though a member always has one. The
-- staff table carries salon_id because a MERCHANT issues those links and tenancy
-- scopes the issue path. Nobody salon-scoped may touch a CUSTOMER's reset: the
-- flow is self-service end to end, and a merchant who could select or issue a
-- customer's reset link would hold an account-takeover path into a wallet that
-- holds her money. The structural argument from `platform_settings` applies —
-- give a salon-scoped predicate nothing to select.
--
-- WHAT IS STORED IS A SHA256, NEVER THE TOKEN — same as 0033, same as
-- `session.refresh_token_hash`. `used_at` plus the conditional-spend UPDATE make
-- a link single-use under a race; the SELECT before it is advisory and the UPDATE
-- carrying `used_at IS NULL` is the mechanism (Lane D's race spec on the console
-- flow is byte-identical from outside for exactly this reason).
--
-- `sent_at` IS AN OUTBOX STAMP AND STAYS NULL. No sender is wired — the WhatsApp
-- templates are unapproved and the sending domain is an open client decision
-- (CLAUDE.md escalations). Third table with the same column waiting on the same
-- escalation, stated rather than implied.
--
-- member_password_reset_attempt IS THE LIMITER'S COUNTER, mirroring 0026's
-- signup_attempt for the same endpoint shape: unauthenticated, per-IP budget,
-- written BEFORE any lookup so a flood of probes for unknown phones is exactly
-- the traffic that gets counted. It cannot ride on member_password_reset itself:
-- rows there exist only for phones that MATCHED, so an enumeration sweep of
-- unknown numbers would never be throttled by its own artefacts.
--
-- LOCKING: two CREATE TABLEs on tables that do not exist.
-- GRANTS: 0001's ALTER DEFAULT PRIVILEGES covers both.
--
-- Idempotent and safe to re-run.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS member_password_reset (
  id            uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  member_id     text NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  token_hash    text NOT NULL,
  /** Which connection asked. Self-service has no requester name to store. */
  requested_ip  text,
  expires_at    timestamptz NOT NULL,
  sent_at       timestamptz,
  used_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT member_password_reset_expires_after_creation
    CHECK (expires_at > created_at)
);--> statement-breakpoint

-- One live link per token value; the redeem looks up by hash, so this is both
-- the uniqueness guarantee and that lookup's index.
CREATE UNIQUE INDEX IF NOT EXISTS member_password_reset_token_uq
  ON member_password_reset (token_hash);--> statement-breakpoint

-- "Does she have an outstanding link?" — asked when a second one is issued,
-- which spends the first.
CREATE INDEX IF NOT EXISTS member_password_reset_live_idx
  ON member_password_reset (member_id) WHERE used_at IS NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS member_password_reset_attempt (
  id          uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  /** Null when unattributable — counted in one shared bucket, never exempted. */
  ip_address  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS member_password_reset_attempt_ip_idx
  ON member_password_reset_attempt (ip_address, created_at DESC);
