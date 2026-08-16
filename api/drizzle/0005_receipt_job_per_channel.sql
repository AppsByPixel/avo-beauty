-- ===========================================================================
-- 0005 — a receipt job is unique per (transaction, channel), not per transaction
--
-- WHAT WAS WRONG
-- --------------
-- `receipt_job` carried `UNIQUE (transaction_id)`. It reads as "one receipt per
-- transaction", which is the natural sentence to write and the wrong rule: it
-- means one row TOTAL for a transaction, across every channel. build-plan.md
-- phase 2 requires "a receipt email AND a WhatsApp receipt arrive for every
-- settled payment" — two rows — so the constraint made the requirement
-- impossible to meet. The charge and top-up paths queued WhatsApp; email had
-- nowhere to go.
--
-- WHY THE CHANNEL BELONGS IN THE KEY
-- ----------------------------------
-- Two channels are two independent deliveries. They queue independently, the
-- worker claims and retries them independently, and a WhatsApp provider outage
-- must not hold up an email that would have sent fine.
-- whatsapp-templates.md already draws this line one level in: "A failed
-- WhatsApp send must never roll back the transaction that triggered it." The
-- same isolation applies between channels, and a shared unique key is exactly
-- what would couple them.
--
-- WHAT IS PRESERVED
-- -----------------
-- The constraint's real job was idempotency, and it still does it. A replayed
-- charge re-runs the same insert with the same transaction_id AND the same
-- channel; the composite key refuses it. Lane D's "a double submit queues ONE
-- WhatsApp receipt" is unchanged — one row per channel is still one WhatsApp
-- receipt.
--
-- Idempotent and safe to re-run.
-- ===========================================================================

-- 1. The new key must exist before the old one is dropped. Building it first
--    means there is no instant in this transaction where two concurrent charge
--    commits could each insert a duplicate WhatsApp job for one transaction.
--    (Drizzle's migrator wraps each file in a transaction, so this is one
--    atomic swap regardless; the ordering is belt and braces, and it is also
--    what makes the file safe to re-run after a partial failure.)
CREATE UNIQUE INDEX IF NOT EXISTS receipt_job_transaction_channel_uq
  ON receipt_job (transaction_id, channel);

-- 2. Drop the old single-column rule. Named explicitly rather than discovered:
--    a DO block that drops "whatever unique constraint is on transaction_id"
--    would happily drop the composite one on a future schema.
ALTER TABLE receipt_job
  DROP CONSTRAINT IF EXISTS receipt_job_transaction_id_unique;

-- 3. Belt and braces for a database where the constraint arrived under drizzle's
--    other naming convention.
ALTER TABLE receipt_job
  DROP CONSTRAINT IF EXISTS receipt_job_transaction_id_key;
