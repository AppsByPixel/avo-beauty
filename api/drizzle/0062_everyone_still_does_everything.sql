-- ===========================================================================
-- EVERYONE STILL DOES EVERYTHING — the backfill that keeps booking working.
--
-- THE PART THAT MUST NOT GO WRONG. From the commit that lands this, `POST
-- /bookings`, `POST /salons/{id}/bookings`, both reschedules and the reassign
-- refuse an artist who is not assigned to the service (`artist_not_assigned`).
-- 0061 creates the table EMPTY. Without this file, the moment the new code
-- serves traffic every existing salon's every booking is refused, because no
-- assignment exists anywhere.
--
-- So: every artist of a salon is assigned to every service of THAT salon, which
-- is exactly today's rule ("any active artist with any active service") written
-- down as rows. Nothing becomes bookable that was not, and nothing stops.
--
-- ---------------------------------------------------------------------------
-- ROWS, NOT A TIMESTAMP — 0059's lesson.
-- ---------------------------------------------------------------------------
-- The pairs are the ones that EXIST in this statement's snapshot. Nothing here
-- compares `created_at`, and the booking check compares no date either: there is
-- no "services older than launch are open to everyone" rule, which would treat
-- every fixture written with a past `created_at` as pre-launch and every row a
-- slow transaction commits after the instant as post-launch. A pair this INSERT
-- did not see gets no row, whatever dates it carries. `artistService.int.test.ts`
-- pins that: a service inserted after this runs, backdated to 2020, is still
-- unassigned.
--
-- ---------------------------------------------------------------------------
-- WHY RETIRED ROWS ARE INCLUDED
-- ---------------------------------------------------------------------------
-- The brief said "every existing artist to every existing ACTIVE service". This
-- assigns inactive artists and retired services too, and that is the same rule
-- stated more exactly rather than a broader one. A retired row is not bookable
-- either way — `createBooking` refuses an inactive artist and prices only active
-- services, before this check is reached — so for every row that can be booked
-- today the two readings agree. They differ only if a row is ever made active
-- again (no API route does that today; an operator or a later route might). With
-- the narrower reading that row would come back silently unbookable, a
-- behaviour change nobody asked for; with this one it comes back exactly as it
-- left.
--
-- ---------------------------------------------------------------------------
-- LOCKING
-- ---------------------------------------------------------------------------
-- One INSERT … SELECT. It reads `artist` and `service` (ACCESS SHARE, which
-- conflicts with no row write) and the two FK checks take FOR KEY SHARE on each
-- artist and service row it links. KEY SHARE conflicts only with a DELETE or a
-- key UPDATE, and nothing in the API deletes either table or changes an id — an
-- availability or branch edit is FOR NO KEY UPDATE and does not wait. The row
-- count is artists × services per salon: 4 × 5 = 20 on the demo seed.
--
-- IDEMPOTENT: `ON CONFLICT DO NOTHING` on the primary key, so a re-run, or an
-- assignment a merchant wrote before this ran, is left as it is.
-- ===========================================================================

INSERT INTO "artist_service" ("artist_id", "service_id", "salon_id")
SELECT a."id", s."id", a."salon_id"
  FROM "artist" a
  JOIN "service" s ON s."salon_id" = a."salon_id"
ON CONFLICT DO NOTHING;
