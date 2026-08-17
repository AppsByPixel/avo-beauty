-- ===========================================================================
-- 0010 - salon.timezone, an IANA zone id, defaulting to Asia/Kuwait
--
-- routes/artists.ts flagged this three times and deliberately did not guess it.
-- The decision is now taken: the BUSINESS question - will AVO sign a salon
-- outside Kuwait - belongs to the client, but the TECHNICAL choice does not
-- depend on the answer. An IANA id is correct either way, costs nothing today
-- (Kuwait is UTC+3 year round, so every row reads 180) and gets expensive once
-- there is production data to backfill and reinterpret.
--
-- WHY NOT AN OFFSET
-- An integer offset cannot express "10:00 local" across a daylight-saving
-- boundary: the same wall time is two different instants across the year in any
-- DST zone. Storing +180 now and discovering that later means a second migration
-- that has to decide, per row and per stored wall-clock string, which side of a
-- transition it was written on. The id costs one text column.
--
-- WHAT IT GOVERNS
-- Every naive wall-clock value in the schema:
--   salon.business_hours.morning / .evening     ["10:00","13:00"]
--   artist.windows[d].from / .to                 "10:00" / "19:00"
--   happy_hour.from / .to                        (migration 0011)
-- All of them are resolved through api/src/time/zone.ts against THIS column,
-- never against the process zone. docker-compose.yml sets TZ=UTC, so before this
-- column existed a Kuwait salon's 10:00 would have resolved three hours late the
-- moment anything converted it - silently, because the slot list still renders.
--
-- WHY THERE IS NO CHECK THAT THE VALUE IS A REAL ZONE
-- Postgres knows the answer (pg_timezone_names) but will not accept it in a
-- CHECK: the tz database is updated in place, so the predicate is not IMMUTABLE
-- and a constraint built on it would be a lie the first time a zone is renamed.
-- The database therefore enforces what is actually invariant - present, not
-- blank - and validity is enforced at the write, in parseTimeZone(), against the
-- runtime's own ICU database. See api/src/time/zone.ts.
--
-- LOCKING - stated plainly, because several API processes share one database
-- during this build. ADD COLUMN ... NOT NULL DEFAULT <constant> has been a
-- catalogue-only operation since Postgres 11: no table rewrite, no row touched.
-- It still needs ACCESS EXCLUSIVE on `salon` for the duration of the catalogue
-- update, which is sub-millisecond on a table with two rows and is bounded below
-- so it can never queue behind a long read and block every request behind it.
-- The ADD CONSTRAINT is likewise a full-table validation of two rows.
-- Nothing here creates or drops an index, so CONCURRENTLY does not apply.
-- ===========================================================================

SET lock_timeout = '3s';--> statement-breakpoint

ALTER TABLE "salon" ADD COLUMN "timezone" text NOT NULL DEFAULT 'Asia/Kuwait';--> statement-breakpoint

-- An empty string is not a zone, and '' would defeat every downstream `?? default`
-- exactly the way a blank Arabic name defeats the client's fallback (0006).
ALTER TABLE "salon" ADD CONSTRAINT "salon_timezone_not_blank"
  CHECK (length(btrim("timezone")) > 0);--> statement-breakpoint

RESET lock_timeout;
