-- ---------------------------------------------------------------------------
-- AN ARTIST BELONGS TO EXACTLY ONE BRANCH, so a booking stops guessing.
--
-- Aftab's ruling, put to him because artists had no branch at all: one artist,
-- one branch. What it buys is that a booking's branch becomes DERIVED FROM THE
-- ARTIST — established rather than guessed — with no client input and nothing
-- for a customer to assert, so non-negotiable #2 is untouched. Availability
-- needs no change: it is already per-artist, and an artist is in one place.
-- Choosing a branch simply filters the artist list.
--
-- Before this, `services/booking.ts` resolved the deposit hold's branch with
-- `resolveBranch(tx, m.salonId, undefined)` — so at a multi-branch salon every
-- booking was `ORDER BY id LIMIT 1` with `branch_assumed = true`, and "branch"
-- on a booking was a label rather than a constraint.
--
-- =========================================================================
-- THE COLUMN IS NULLABLE, AND NULL MEANS "NOT ASSIGNED" RATHER THAN
-- "UNBOOKABLE". THIS IS THE PART WITH A WRONG ANSWER THAT LOOKS RIGHT.
-- =========================================================================
-- Every existing artist has no branch. For a single-branch salon a backfill is
-- unambiguous. For a MULTI-BRANCH salon it is a guess, and decisions 80 and 82
-- are both about exactly that: do not write a value into live data because the
-- shape was inconvenient.
--
-- So the backfill below touches ONLY salons with exactly one open branch, and
-- every artist at a multi-branch salon is left NULL for the merchant to assign.
--
-- WHAT NULL DOES AT BOOKING TIME: nothing new. It flows into `resolveBranch` as
-- no `supplied` at all, which is byte-for-byte the behaviour that shipped before
-- this migration — one open branch is established, several are assumed. The
-- alternative, NULL = unbookable, would take the booking flow OFFLINE at every
-- multi-branch salon the moment this migration ran, to fix an attribution defect
-- with no money impact. `services/branch.ts` already made that trade once and
-- wrote down why: "it would refuse every charge at every multi-branch salon
-- until device enrolment ships, taking a working product offline to fix an
-- attribution defect whose money impact is already nil."
--
-- AND IT IS VISIBLE RATHER THAN SILENT, which is the condition on choosing the
-- lenient answer. `ArtistSchema` carries `branchId`, `GET /salons/{id}/artists`
-- serves it and filters on it, and a booking made against an unassigned artist
-- still writes `branch_assumed = true` — so "which of my artists has no branch"
-- and "which of my appointments were guessed" are both queries a merchant's
-- dashboard can ask. Lane C owns the screen.
--
-- =========================================================================
-- THE COMPOSITE FOREIGN KEY, REUSED
-- =========================================================================
-- `(branch_id, salon_id)` references `branch (id, salon_id)` — the UNIQUE that
-- migration 0043 added for `device_enrolment`, now earning its keep a second
-- time. An artist assigned to another salon's branch does not commit, so the
-- defensive same-salon join `services/reports.ts` has to carry for
-- `artist.staff_user_id` is not needed for this column.
--
-- NOT CASCADED ON BRANCH CLOSURE, deliberately, and this is the opposite call
-- from the one made for tills in the same commit. A closed branch's TILL is a
-- dead counter — `resolveBranch` refuses a closed `supplied` branch, so the
-- charge fails — and is therefore revoked. An artist whose branch closes simply
-- falls back to an unestablished booking branch, exactly as an unassigned artist
-- does, and her diary keeps working. Nothing breaks, so nothing is rewritten.
-- Where she should work next is a decision for the merchant, and a cascade would
-- erase the record of where she used to be.
--
-- GRANTS: `artist` is already writable by `avo_app`; 0001's defaults cover it.
-- ---------------------------------------------------------------------------
ALTER TABLE "artist" ADD COLUMN "branch_id" text;
--> statement-breakpoint
ALTER TABLE "artist" ADD CONSTRAINT "artist_branch_same_salon_fk"
  FOREIGN KEY ("branch_id", "salon_id") REFERENCES "branch"("id", "salon_id") ON DELETE restrict;
--> statement-breakpoint
-- The artist list is filtered by branch on the booking path, per salon.
CREATE INDEX "artist_salon_branch_idx" ON "artist" ("salon_id", "branch_id");
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- THE BACKFILL: SALONS WITH EXACTLY ONE OPEN BRANCH, AND NO OTHERS.
--
-- `closed_at IS NULL` matches `resolveBranch`'s own definition of a candidate
-- branch, so "exactly one open branch" here means the same thing it means there:
-- a salon with one open and three closed branches is unambiguous, and its
-- charges are already `established` for that reason.
--
-- A salon with NO open branch is skipped rather than defaulted; it cannot take a
-- booking at all (`resolveBranch` throws `no_branch`), so there is nothing to
-- assign and nothing to guess.
-- ---------------------------------------------------------------------------
UPDATE "artist" a
   SET "branch_id" = one."id", "updated_at" = now()
  FROM (
        SELECT "salon_id", min("id") AS "id", count(*) AS "n"
          FROM "branch"
         WHERE "closed_at" IS NULL
         GROUP BY "salon_id"
       ) one
 WHERE one."salon_id" = a."salon_id"
   AND one."n" = 1;
