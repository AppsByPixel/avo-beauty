-- ===========================================================================
-- A PHONE NUMBER FINDS ITS WALLETS WITHOUT READING EVERY MEMBER.
--
-- Aftab, 2026-09-29: "different wallet themes for different workspaces … If I
-- logged in, it has the forest green themed wallet … not a separate app."
--
-- One wallet app, and the account decides the workspace. So
-- `POST /auth/member/session` and `POST /auth/member/password-reset/request`
-- accept a request with NO `salonId`, and look up every live wallet that phone
-- holds (routes/auth.ts § SIGN-IN WITHOUT A SALON).
--
-- `member_salon_phone_uq` is on (salon_id, phone), with the phone SECOND, so it
-- cannot serve `WHERE phone = $1`. Without this index each salon-less attempt is
-- a sequential scan of `member` — on an unauthenticated endpoint, and growing
-- with the customer book.
--
-- PARTIAL ON `erased_at IS NULL`, the exact predicate both lookups carry. An
-- erased row's phone is a random `+990…` tombstone (services/erasure.ts) that no
-- caller can name, so indexing it would only be weight.
--
-- ---------------------------------------------------------------------------
-- SAFE UNDER THE DEPLOYED API, AND THE NEW API IS SAFE WITHOUT IT
-- ---------------------------------------------------------------------------
-- ADDITIVE. One index; nothing rewritten, dropped or constrained. The deployed
-- API never issues a phone-only lookup, so it neither uses nor notices it. The
-- new API is CORRECT without it (the planner scans instead), so deploy order
-- between this migration and the API is free — it only changes speed.
--
-- LOCKING. A plain CREATE INDEX takes SHARE on `member`, which blocks member
-- UPDATEs (balance, visits) for the build. `member` is one row per wallet — small
-- at launch — so the build is milliseconds. Not CONCURRENTLY, because drizzle's
-- migrator runs every pending migration inside one transaction (0059's header).
-- lock_timeout 3s, the 0010/0011/0059/0063..0069 convention: `member` is written
-- inside every charge, so the migration fails and rolls back rather than queueing
-- behind a charge and holding every later one. Re-running is safe.
-- ===========================================================================

SET lock_timeout = '3s';--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "member_live_phone_idx"
  ON "member" ("phone")
  WHERE "erased_at" IS NULL;--> statement-breakpoint

RESET lock_timeout;
