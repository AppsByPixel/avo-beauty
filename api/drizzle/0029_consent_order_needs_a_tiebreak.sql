-- ===========================================================================
-- 0029 — marketing consent had no deterministic order, and the tie resolved to
--        "granted"
--
-- `services/consent.ts` derives the standing answer as the NEWEST
-- `member_consent_event`, and it is the function the whole campaign send path is
-- documented as having to call:
--
--     ORDER BY created_at DESC LIMIT 1
--
-- `created_at` is `timestamptz NOT NULL DEFAULT now()`, and `now()` is the
-- TRANSACTION timestamp — identical for every row written in one transaction.
-- `recordConsent` takes an executor precisely so a caller can record consent
-- inside the transaction that created the account, so two events sharing an
-- instant is a reachable shape rather than a contrived one.
--
-- With two tied rows there is no tiebreak, so which one is "newest" is the
-- planner's choice. MEASURED, on a grant and a withdrawal written in one
-- statement:
--
--     SELECT granted FROM member_consent_event
--      WHERE member_id='8843' AND kind='marketing_offers'
--      ORDER BY created_at DESC LIMIT 1;
--     -> true, on eight consecutive runs
--
-- The withdrawal lost. So a customer who turned marketing off in the same instant
-- she was asked reads as CONSENTING, and the send path — which was about to be
-- built on this function — would have messaged her. The failure is silent, it is
-- in the permissive direction, and it is in the one table whose whole purpose is
-- to be the record a regulator is shown.
--
-- WHY A COLUMN AND NOT `ORDER BY created_at DESC, id DESC`
-- -------------------------------------------------------
-- `id` is `uuid DEFAULT gen_random_uuid()`. Ordering by a random value is
-- deterministic for a given pair of rows and MEANINGLESS: it would settle the tie
-- by coin flip and do it reproducibly, which is worse than settling it visibly,
-- because it would look fixed.
--
-- `ledger_entry` already solved this and its column carries the reasoning:
-- "`seq bigserial` — Monotonic write order — the audit read order, independent of
-- clock skew." A sequence is assigned at INSERT, in insert order, whatever the
-- transaction clock says. `member_consent_event` is the other append-only
-- evidence table in this schema and it should have had one from the start.
--
-- WHAT THIS DOES NOT FIX, and is not trying to: two events written in SEPARATE
-- transactions where the clocks are skewed. `seq` handles that too — it is
-- assigned by the sequence, not the clock — which is why the read is
-- `ORDER BY created_at DESC, seq DESC` rather than `seq DESC` alone: `created_at`
-- stays the primary key of the ordering because it is the thing a human reads and
-- a regulator asks about, and `seq` settles ties beneath it. Where the two
-- disagree across transactions, that disagreement is a clock problem worth
-- seeing rather than one worth hiding behind a sequence.
--
-- LOCKING: ADD COLUMN with a SEQUENCE default is a volatile default, so this
-- REWRITES the table under an ACCESS EXCLUSIVE lock. `member_consent_event` holds
-- one row per consent answer per member — small now, and this is the cheapest
-- moment it will ever be. Doing it later would be the same statement on a larger
-- table.
--
-- PRIVILEGES: the table has UPDATE and DELETE revoked from `avo_app` (migration
-- 0023 makes it append-only with triggers as well). `avo_app` needs USAGE on the
-- new sequence to INSERT, and 0001's ALTER DEFAULT PRIVILEGES covers sequences
-- created afterwards — granted explicitly below anyway, because a default
-- privilege that silently did not apply is an INSERT that fails at runtime rather
-- than here.
--
-- Idempotent and safe to re-run.
-- ===========================================================================

ALTER TABLE member_consent_event
  ADD COLUMN IF NOT EXISTS seq bigserial NOT NULL;--> statement-breakpoint

-- The read's index: newest answer for one member and one kind. `created_at DESC,
-- seq DESC` is the exact order `marketingConsentOf` and
-- `grantedMarketingConsent` use, so both are an index scan of one row per member
-- rather than a sort.
CREATE INDEX IF NOT EXISTS member_consent_latest_idx
  ON member_consent_event (member_id, kind, created_at DESC, seq DESC);--> statement-breakpoint

GRANT USAGE, SELECT ON SEQUENCE member_consent_event_seq_seq TO avo_app;
