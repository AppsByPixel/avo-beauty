-- ===========================================================================
-- 0021 - account deletion: a member STATE with a clock, not a ticket
--
-- The wallet's copy promises the account is "removed within 30 days", and there
-- was no endpoint behind it. Lane B escalated rather than guessing, because
-- whether this is a ticket, a scheduled job or a state on the member changes
-- what the confirmation screen is ALLOWED to say.
--
-- IT IS A STATE WITH A DUE DATE. The reasoning, in the order it decides things:
--
-- 1. IT CANNOT BE A HARD DELETE, and the published policy already says so. The
--    privacy policy seeded in 0019 carries both halves: "Transaction records
--    are kept for 7 years, as financial rules require" AND "the rest of your
--    account data is deleted within 30 days of a deletion request." Those are
--    two different retention periods over one customer, so deletion is
--    necessarily an ERASURE OF PERSONAL DATA that leaves the money record
--    standing. `transaction`, `ledger_entry` and `audit_log` all reference the
--    member and are append-only or restrict-on-delete; a DELETE FROM member
--    would be refused by the database, and rightly.
--
-- 2. IT CANNOT BE A TICKET. CLAUDE.md lists "who monitors the AVO support
--    queue, in what hours" among the decisions that are still open, so routing
--    this to a queue would make a promise published in a legal document depend
--    on a rota nobody has agreed. A 30-day guarantee whose clock only starts
--    when a human reads an inbox is not a guarantee.
--
-- 3. SO THE CLOCK IS A DATABASE FACT. `deletion_requested_at` starts it and
--    `deletion_due_at` is when erasure falls due — both on the member, both
--    readable, both queryable by the job that will do the erasing.
--
-- THE 30 DAYS ARE ALSO A GRACE WINDOW, which is why the request does NOT
-- revoke her sessions and sign-in keeps working. She has to be able to come
-- back and cancel, and an account she is locked out of the moment she asks is
-- one she cannot change her mind about. `DELETE /members/me/deletion` is that
-- door.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT ADD IS THE ERASURE ITSELF.
-- WHICH COLUMNS ARE NULLED AT the due date, and which survive for the 7-year
-- financial record, is a retention decision — CLAUDE.md § Open decisions:
-- "Data residency and the retention schedule" belongs to the client, not to
-- this lane. Escalated. What is built is everything that has to be true BEFORE
-- that decision lands: the request is real, the clock is running, and the state
-- is on the row where the job will look for it.
-- ===========================================================================

ALTER TABLE member ADD COLUMN deletion_requested_at timestamptz;
ALTER TABLE member ADD COLUMN deletion_due_at       timestamptz;

-- Both or neither. A due date with no request, or a request with no due date,
-- is a row the erasure job cannot act on and cannot report.
ALTER TABLE member ADD CONSTRAINT member_deletion_is_whole
  CHECK ((deletion_requested_at IS NULL) = (deletion_due_at IS NULL));

ALTER TABLE member ADD CONSTRAINT member_deletion_due_after_request
  CHECK (deletion_due_at IS NULL OR deletion_due_at > deletion_requested_at);

-- The job's query: whose erasure has fallen due. Partial, because the
-- overwhelming majority of members have never asked.
CREATE INDEX member_deletion_due_idx
  ON member (deletion_due_at) WHERE deletion_requested_at IS NOT NULL;
