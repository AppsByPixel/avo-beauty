-- ===========================================================================
-- THE BELL OPENS ON HER HISTORY, READ.
--
-- Decided by Aftab, 2026-09-28 (DECISIONS.md, "Card-paid shop orders and the
-- wallet bell", ruling 2): existing members would otherwise meet their whole
-- receipt history as unread on day one. What exists when this runs is marked
-- read; only what happens after launch is unread.
--
-- 0057 is NOT edited. It is applied to avo_ci and every lane database, and its
-- journal hash is fixed.
--
-- ---------------------------------------------------------------------------
-- ROWS, NOT A TIMESTAMP.
-- ---------------------------------------------------------------------------
-- This writes one `member_notification_read` row for each bell item that EXISTS
-- in this statement's snapshot. It stores no launch instant and the feed compares
-- no date. The alternative — "an item created before launch counts as read",
-- evaluated at read time — decides by `created_at` / `sent_at`, and those are not
-- facts about WHEN a row came to exist:
--
--   * the bell's own int fixtures write campaigns decided in 2020, so they do not
--     spend SAL-AMARA's monthly campaign cap (memberNotifications.int.test.ts §
--     campaignRow). Under a watermark every such fixture — and any other fixture
--     written with a past date — would read as already read, and a spec
--     expecting an unread item would go red, or pass for the wrong reason;
--   * in production, a transaction that STARTS before the instant and COMMITS
--     after it carries a `created_at` from before launch. `markMemberNotifications
--     Read`'s "mark all" rejects a watermark for exactly this reason.
--
-- A row this INSERT did not see gets no mark, whatever date it carries. That is
-- the whole mechanism. `bellBackfill.int.test.ts` pins it: a receipt and a
-- campaign inserted after this runs, backdated to 2020, are unread.
--
-- ---------------------------------------------------------------------------
-- WHAT COUNTS AS AN ITEM — THE FEED'S OWN PREDICATES, RESTATED.
-- ---------------------------------------------------------------------------
-- `services/memberNotifications.ts` § receiptStreamWhere / campaignStreamWhere,
-- clause for clause, so the backfill marks exactly what her bell serves:
--
--   receipt   her own `receipt_job` row, a known kind, and ONE per transaction —
--             the lowest channel stands for a WhatsApp + email pair. (The mark is
--             keyed on the transaction, so this only decides which row supplies it.)
--   campaign  a `campaign_send` to her, of a campaign that is `sent`, of HER salon,
--             on the app channel (`push` / `both`).
--
-- ONE DELIBERATE DIFFERENCE: her current `offers` consent is NOT applied. In the
-- feed that is a reversible VIEW filter — withdrawn, campaigns leave the bell;
-- restored, "they return" (the same spec file pins it). A member who has offers
-- off today would, on turning them back on after launch, meet every pre-launch
-- campaign as unread — the day-one problem this migration exists to prevent,
-- deferred. So the backfill marks the stream, and consent keeps deciding what is
-- SHOWN. The int spec proves the marks and the feed agree item for item.
--
-- ---------------------------------------------------------------------------
-- ERASURE — NEVER RECREATE HER MARKS.
-- ---------------------------------------------------------------------------
-- Erasure deletes her receipt_job rows and her read marks, but campaign_send
-- cannot be deleted (0028), so an erased member still has a campaign stream. The
-- `live` CTE excludes `erased_at IS NOT NULL`.
--
-- That filter alone is a race on a live database. The erasure job takes the member
-- row FOR UPDATE, deletes her marks, and stamps `erased_at`, in one transaction.
-- If that transaction is open when this statement starts, the snapshot still shows
-- her un-erased; the FK check on the insert would wait for her row, find it (a
-- tombstone is still a row), and write marks AFTER erasure deleted them.
--
-- So `live` takes FOR KEY SHARE on each member it will mark. Against an open
-- erasure it waits, then re-evaluates `erased_at IS NULL` on the committed row
-- (READ COMMITTED's recheck) and drops her. Against an erasure that has not
-- started yet, erasure's FOR UPDATE waits for this migration to commit, and its
-- DELETE then sees — and deletes — these marks. Either order ends with no marks.
-- FOR KEY SHARE is the weakest lock that does it, and it is the lock the FK check
-- on `member_notification_read.member_id` takes on the same row anyway, so it adds
-- no blocking the insert would not already have.
--
-- ---------------------------------------------------------------------------
-- LOCKING, ON A LIVE DATABASE THAT IS TAKING PAYMENTS.
-- ---------------------------------------------------------------------------
-- `receipt_job` and `campaign_send` are written inside money transactions. This
-- migration only READS them: ACCESS SHARE on the tables, which conflicts with no
-- INSERT, UPDATE or DELETE, and no row lock on either. A top-up or charge that
-- writes a receipt_job row while this runs is not blocked by it — and, not being
-- in the snapshot, is correctly left unread.
--
-- What IS locked is `member` rows, FOR KEY SHARE, for members who have something
-- to mark — by `live` and by the FK checks alike. A charge, top-up settle, order
-- or erasure on one of them takes her row FOR UPDATE and waits until the migration
-- COMMITS. That cannot be designed away while the FK exists; it is kept short:
--
--   * ONE statement, no loop, no DDL. On avo_lane_a (670 receipt_job rows, 733
--     members) it is measured in the lane report; the demo is of that order.
--   * `live` is narrowed to members who have a receipt or a send, so a member with
--     no history is never locked.
--   * lock_timeout 3s, the 0010/0011 convention: if a member row is held by a long
--     transaction the migration fails and rolls back rather than sitting in the
--     queue holding every other member's key-share lock. Re-running is safe.
--
-- drizzle's migrator applies every PENDING migration in ONE transaction, so every
-- lock is held until the last of them commits. If a database has not yet run
-- 0057, that run also includes 0057's plain CREATE INDEX on receipt_job (a SHARE
-- lock, which DOES block receipt_job inserts, i.e. money writes) — held through
-- this statement as well. Migrate 0057–0058 first where that matters.
--
-- ---------------------------------------------------------------------------
-- IDEMPOTENT.
-- ---------------------------------------------------------------------------
-- `ON CONFLICT DO NOTHING` against 0057's two partial unique indexes: a re-run, or
-- a mark she wrote herself before this ran, keeps the FIRST `read_at`.
-- ===========================================================================

SET lock_timeout = '3s';--> statement-breakpoint

WITH live AS MATERIALIZED (
  SELECT m.id, m.salon_id
    FROM member m
   WHERE m.erased_at IS NULL
     AND (EXISTS (SELECT 1 FROM receipt_job r WHERE r.member_id = m.id)
          OR EXISTS (SELECT 1 FROM campaign_send s WHERE s.member_id = m.id))
     FOR KEY SHARE OF m
)
INSERT INTO member_notification_read (member_id, transaction_id, campaign_id)
SELECT rj.member_id, rj.transaction_id, NULL
  FROM receipt_job rj
  JOIN live ON live.id = rj.member_id
 WHERE (rj.payload->>'kind') IN ('topup', 'charge', 'shop', 'deposit_hold', 'deposit_return')
   AND NOT EXISTS (
         SELECT 1 FROM receipt_job other
          WHERE other.transaction_id = rj.transaction_id
            AND other.member_id = rj.member_id
            AND other.channel < rj.channel)
UNION ALL
SELECT cs.member_id, NULL, cs.campaign_id
  FROM campaign_send cs
  JOIN live ON live.id = cs.member_id
  JOIN campaign c ON c.id = cs.campaign_id
 WHERE c.status = 'sent'
   AND c.salon_id = live.salon_id
   AND cs.channel IN ('push', 'both')
ON CONFLICT DO NOTHING;--> statement-breakpoint

RESET lock_timeout;
