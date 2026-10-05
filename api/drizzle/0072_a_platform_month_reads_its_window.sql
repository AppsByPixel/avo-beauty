-- ===========================================================================
-- 0072 — THE CONSOLE'S MONTH READS ITS OWN WINDOW, NOT THE WHOLE LEDGER.
--
-- `GET /v1/platform/analytics` (services/platformAnalytics.ts) and
-- `GET /v1/platform/metrics` read `transaction` ACROSS EVERY SALON for a run of
-- calendar months. Every existing index on the table leads with `salon_id`,
-- `member_id` or `branch_id` (0000), so an all-salon time range has nothing to
-- range over and Postgres 17 has no skip scan: measured inside BEGIN…ROLLBACK
-- on 600,000 synthetic rows, every one of those reads was a sequential scan of
-- the whole table, and that cost grows with the platform's age, not with the
-- window asked for.
--
-- TWO PARTIAL INDEXES, one per time column the console buckets on:
--
--   transaction_topup_settled_idx    (settled_at) WHERE topup AND settled
--       Loaded, revenue and the payment mix: `platformMetrics.ts`' predicate,
--       which buckets top-ups on `settled_at`. Partial, so it holds top-ups
--       only — the rows that predicate can ever match.
--
--   transaction_settled_created_idx  (created_at) INCLUDE (salon_id, member_id, kind)
--                                    WHERE settled
--       Spent, active members and salons, busiest times — everything bucketed on
--       `created_at`. The INCLUDE columns are what the active-member count reads,
--       so that query can be answered from the index alone.
--
-- Whether the planner USES them depends on how much of the table the window
-- covers: a year of history on a two-year table is half the rows, and a
-- sequential scan is the right plan for that. The point is that a one-month or
-- a twelve-month read stays the size of its window as the ledger grows.
--
-- ---------------------------------------------------------------------------
-- SAFE UNDER THE DEPLOYED API, AND ORDER-FREE
-- ---------------------------------------------------------------------------
-- ADDITIVE: two indexes, nothing rewritten or constrained. Correct without them
-- (the planner scans instead), so deploy order is free.
--
-- LOCKING. CREATE INDEX takes SHARE on `transaction`, which blocks inserts — every
-- charge and top-up — for the build. Not CONCURRENTLY, because drizzle's migrator
-- runs every pending migration in one transaction (0059's header). lock_timeout
-- 3s, the 0010/0011/0059/0063..0071 convention: the migration fails and rolls back
-- rather than queueing behind a charge and holding every later one. At launch
-- volume the build is milliseconds; on a large table, run it in a quiet window.
-- Re-running is safe.
-- ===========================================================================

SET lock_timeout = '3s';--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "transaction_topup_settled_idx"
  ON "transaction" ("settled_at")
  WHERE "kind" = 'topup' AND "status" = 'settled';--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "transaction_settled_created_idx"
  ON "transaction" ("created_at") INCLUDE ("salon_id", "member_id", "kind")
  WHERE "status" = 'settled';--> statement-breakpoint

RESET lock_timeout;
