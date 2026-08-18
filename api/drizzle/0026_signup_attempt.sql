-- ===========================================================================
-- 0026 — bounding an unauthenticated argon2 endpoint
--
-- `POST /auth/member/signup` runs argon2id, which is deliberately expensive, and
-- had no rate limit at all. Its own header said so in as many words: "There is
-- also NO RATE LIMIT on this route: argon2 is deliberately expensive, so an
-- unauthenticated hashing endpoint is a cheap denial of service. Both are
-- escalated, not fixed quietly."
--
-- One of those two things was a product decision and one was not. THE
-- ENUMERATION ORACLE STAYS ESCALATED: `already_registered` confirms that a phone
-- number holds a wallet at this salon, and bounding that needs a verification step
-- at signup — the shape the phone-change challenge already uses — which is a
-- product decision about what a customer is asked to do, not one to invent in a
-- migration. An unbounded expensive endpoint is not a product question, and this
-- is that half.
--
-- WHY A TABLE, AND NOT AN IN-PROCESS COUNTER
-- -----------------------------------------
-- The same reason `src/gateway/sandbox.ts` keeps its payments in a table rather
-- than a `Map`: a counter in one Node process is a limit per replica that resets
-- on every deploy, so the real ceiling is N times what the number says and it
-- disappears exactly when a rolling restart is under way.
--
-- WHY NOT `audit_log`, WHICH THE DIRECTORY-READ LIMITER COUNTS
-- -----------------------------------------------------------
-- `services/memberSearch.ts` counts audit rows, and that works there because a
-- directory read is a thing a salon should be able to see in its own activity
-- feed. A refused signup attempt is not: `audit_log` is merchant-facing, and
-- filling it with "somebody tried to register" would train the people who read it
-- to skim. This is the same separation `pin_attempt` already makes for the same
-- reason — the account's own counter lives on `staff_user`, and the per-device
-- attempt log lives in its own table.
--
-- WHAT IS AND IS NOT RECORDED
-- ---------------------------
-- The IP, the salon, and the time. NOT THE PHONE NUMBER, and not the name. The
-- limit is keyed on the caller, so the phone is not needed to enforce it — and a
-- table of phone numbers that tried to register, retained indefinitely, would be
-- a list of people who do not have accounts here. That is a worse privacy
-- artefact than the oracle this does not close.
--
-- AND NOT WHETHER IT WORKED, which the first draft of this table had as a
-- `succeeded boolean` copied from `pin_attempt`. It could not be made truthful.
-- `pin_attempt` knows its outcome at insert time; this row has to be written
-- BEFORE the argon2 hash, or a thousand simultaneous requests all read a count of
-- zero and all pay for a hash — the exact flood being rationed. Recording the
-- outcome would therefore need an UPDATE, and the privileges below refuse one for
-- a reason worth keeping.
--
-- So this is a COUNTER, not a record, and it says only what it can: an attempt
-- from this address, at this time, that was about to cost a hash. Which of them
-- succeeded is already answerable — `audit_log` carries a "Member signed up" row
-- per success, with the same IP — and keeping the failures out of that table is
-- deliberate, since it is what a merchant reads.
--
-- `salon_id` HAS NO FOREIGN KEY, on purpose. An attempt naming a salon that does
-- not exist is exactly the kind of traffic worth counting, and a FK would make
-- that request fail on the insert before it could be counted — turning the
-- cheapest possible probe into the one path that skips the limiter.
--
-- Idempotent and safe to re-run.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS signup_attempt (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Free text, deliberately unconstrained. See the header.
  salon_id    text NOT NULL,
  -- Nullable: a request Fastify cannot attribute is still an attempt and must
  -- still be counted rather than rejected here. Every such caller shares this one
  -- bucket, so being unattributable is not a way past the limit.
  ip_address  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- The limiter's only query: two counts over one window, for one IP. `created_at`
-- descending because the window is always "the recent end".
CREATE INDEX IF NOT EXISTS signup_attempt_ip_idx
  ON signup_attempt (ip_address, created_at DESC);

-- For answering "what happened at this salon" during an incident, which is a
-- different question from the limiter's and would otherwise be a full scan.
CREATE INDEX IF NOT EXISTS signup_attempt_salon_idx
  ON signup_attempt (salon_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Privileges.
--
-- INSERT and SELECT for the application role, and nothing else. A row that can be
-- UPDATEd or DELETEd is a counter that can be reset by whatever gets compromised
-- next, and a limiter whose own rows the application can remove is not a limit.
-- Retention is an operator's job, with the owner role.
--
-- This is also what settled the `succeeded` column out of the table, rather than
-- the other way round: the privilege is the one worth keeping and the column was
-- the one that needed an UPDATE.
--
-- This is weaker than the `audit_log` REVOKE in 0001, which that table needs
-- because it is evidence. These rows are a control, not a record; the asymmetry
-- is deliberate and the reasoning is the paragraph above rather than the
-- convention.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT ON signup_attempt TO avo_app;
REVOKE UPDATE, DELETE ON signup_attempt FROM avo_app;
