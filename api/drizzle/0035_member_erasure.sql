-- ===========================================================================
-- 0035 — the erasure job's marker, so the 30-day promise has an executor
--
-- THE DEFECT THIS CLOSES: the published privacy policy (legalSeed.ts, § 5) says
-- "Transaction records are kept for 7 years, as financial rules require. The
-- rest of your account data is deleted within 30 days of a deletion request."
-- `POST /members/me/deletion` set the clock, `GET /members/me/deletion` served
-- `erasureDueAt` to the customer as a fact — and NOTHING EXECUTED IT. There was
-- no erasure job; a member past her due date stayed undeleted for ever. The
-- no-show shape exactly: a state machine with an unreachable terminal state,
-- except this terminal state is a legal commitment.
--
-- `erased_at` IS THE TOMBSTONE MARKER. The job scrubs the member row in place
-- rather than deleting it — `transaction`, `ledger_entry` and `booking` rows are
-- a salon's books and reference her with restrict, so the row must survive for
-- the money record to keep resolving. What survives identifies NOBODY: the name,
-- phone, email and password hash are all replaced, and `erased_at` is what says
-- so. The deletion timestamps are KEPT (dates are not personal data), so the row
-- still reads "requested X, due Y, erased Z".
--
-- THE CHECK: an erasure without a request is a row nothing can explain — the
-- job's candidate query starts from `deletion_due_at`, so `erased_at` can only
-- ever be set on a row that has one. Made a database fact, like
-- `member_deletion_is_whole` before it.
--
-- THE PARTIAL INDEX is the candidate scan: "who is past due and not yet erased"
-- is the one query the job runs on a timer, and it must not become a full scan
-- of every member as the table grows.
--
-- LOCKING: ALTER TABLE ADD COLUMN (nullable, no default) takes a brief
-- ACCESS EXCLUSIVE but rewrites nothing.
-- GRANTS: 0001's defaults cover it; the job runs as avo_app, whose existing
-- UPDATE on `member` is all the new column needs.
--
-- Idempotent and safe to re-run.
-- ===========================================================================

ALTER TABLE member ADD COLUMN IF NOT EXISTS erased_at timestamptz;--> statement-breakpoint

ALTER TABLE member DROP CONSTRAINT IF EXISTS member_erased_only_after_request;--> statement-breakpoint
ALTER TABLE member ADD CONSTRAINT member_erased_only_after_request
  CHECK (erased_at IS NULL OR deletion_requested_at IS NOT NULL);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS member_erasure_due_idx
  ON member (deletion_due_at)
  WHERE deletion_due_at IS NOT NULL AND erased_at IS NULL;
