-- ===========================================================================
-- TX-, BK- AND NT- GET SEQUENCES TOO — 0052 FIXED TWO OF FIVE.
--
-- 0052 gave `CMP-` and `SUP-` sequences after a campaign id collided in a full
-- `e2e/` run. It fixed the case that was found, not the defect, and
-- `grep "Math.floor(Math.random()" api/src` still answered with nine minters
-- across five prefixes. The other three are these, and one of them is the money
-- path:
--
--   TX- transactions  9,000,000 values  50% collision at ~3,531 rows
--   BK- bookings      9,000,000         50% at ~3,531
--   NT- notifications 9,000,000         50% at ~3,531
--
-- 3,531 transactions is a busy salon inside a year, and the space is shared
-- across every salon on the platform, so the real figure is the platform's
-- lifetime count and not any one salon's.
--
-- TX- WAS MINTED IN FIVE PLACES — services/{charge,order,topup,booking}.ts and
-- routes/charges.ts for a void — as five private copies of one identical unsafe
-- function. That is why three prefixes survived 0052: there was no single place
-- to fix. `services/ids.ts` is now that place.
--
-- AND A TX- COLLISION DOES NOT SURFACE AS A 500, WHICH IS WHY THIS IS NOT MERELY
-- 0052 AGAIN. routes/{orders,topups,bookings,adjustments,vouchers}.ts each catch
-- 23505 with a bare `isUniqueViolation(err)` and read it as an idempotency-key
-- collision. The loser then looks for a winner's stored response under a key that
-- never committed, finds nothing, and answers `409 request_in_progress` — "still
-- being processed". routes/orders.ts states the precondition that would make its
-- bare catch safe, "nothing else here is unique", and that sentence was false the
-- whole time: `transaction_pkey` is unique and was being minted at random inside
-- that very transaction. services/idempotency.ts § `violatedConstraint` records
-- what this already cost once — "told a staff member a completed void was in
-- flight".
--
-- So the failure mode here is not an error, it is a WRONG ANSWER ABOUT MONEY, on
-- a path whose natural remedy is to charge again. There is no retry on 23505
-- anywhere in api/src.
--
-- START VALUES CLEAR THE SPACE THE RANDOM MINTERS ALREADY USED. Existing rows
-- hold TX-, BK- and NT- ids in 1000000..9999999, plus fixtures below that
-- (`TX-9021` in db/seed.ts). Starting a digit wider means a minted id can never
-- equal a row that is already there: no backfill, no rename, safe on a live
-- database. Ids get one digit longer, which is the cheapest possible signal that
-- the space changed.
--
-- The `TX-VCH-` and `TX-ADJ-` ids in routes/{vouchers,adjustments}.ts are NOT in
-- this range and are not touched — they are `randomUUID().slice(0, 12)`, already
-- collision-safe, and their receipt references are already in the wild.
-- services/ids.ts carries why they are left disagreeing with these rather than
-- silently rewritten.
--
-- `avo_app` gets USAGE via the ALTER DEFAULT PRIVILEGES in 0001, which covers
-- sequences created later by the migration owner.
-- ===========================================================================

CREATE SEQUENCE IF NOT EXISTS transaction_number_seq AS bigint START WITH 10000000;

CREATE SEQUENCE IF NOT EXISTS booking_number_seq AS bigint START WITH 10000000;

CREATE SEQUENCE IF NOT EXISTS notification_number_seq AS bigint START WITH 10000000;
