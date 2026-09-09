-- ---------------------------------------------------------------------------
-- A TILL KNOWS WHERE IT IS STANDING.                    (DECISIONS.md #82)
--
-- `services/branch.ts` has been able to accept an established branch since the
-- day it was written — `resolveBranch(exec, salonId, supplied)` returns
-- `established: true` for it, and its header names the missing half exactly:
--
--     "THE REAL FIX, still owed: a branch-bound scanner session. `StaffPrincipal`
--      carries branch ACCESS (`branchAccessAll` / `branchAccessIds`), which is a
--      permission and not a location, so the server cannot infer where a staff
--      member is standing. That waits on the device-enrolment decision."
--
-- `session.device_id` is a nullable string the CLIENT sends, and there has been
-- no server-side device -> branch record anywhere. This is that record.
--
-- WHAT IT UNBLOCKS, AND WHY IT IS NOT COSMETIC
-- --------------------------------------------
-- `charge.ts` passes `branch.established ? branchId : null` into
-- `loadPromotionInputs`, and a null branch matches no boost and no branch-scoped
-- happy hour. So at a MULTI-BRANCH salon every per-branch earning rate is
-- stored, served to both clients, editable by the merchant — and applied by
-- nobody. Decision 82's framing: adding a second branch is not a configuration
-- task, it is a regression, and nothing tells the merchant.
--
-- With an enrolment the branch is established from a fact the SERVER holds, so
-- the boost pays and `transaction.branch_assumed` becomes false.
--
-- THE FIX THAT MUST NOT BE TAKEN, restated because this table is the thing that
-- makes it tempting: a client naming its own branch is a client choosing its own
-- multiplier. `POST /charges` has no branch in its body and must never grow one.
-- The device sends an IDENTIFIER; the server looks up what that identifier is
-- bound to. Those are different acts, and only the second is safe.
--
-- WHY A COMPOSITE FOREIGN KEY, AND THE UNIQUE INDEX ON `branch` THAT ENABLES IT
-- ----------------------------------------------------------------------------
-- `(branch_id, salon_id)` references `branch (id, salon_id)`, so a row naming
-- ANOTHER salon's branch does not commit. That is deliberately stronger than the
-- pattern next door: `artist.staff_user_id` is a plain FK with no same-salon
-- constraint behind it, and `services/reports.ts` has to carry a defensive join
-- and a comment explaining that a mislinked row renders as "no staff account"
-- rather than leaking another salon's handle. Here the money follows the branch,
-- so the tenancy error is made unrepresentable instead of defended against.
--
-- `branch_id_salon_uq` is additive — `id` is already the primary key, so the
-- pair is already unique and the index cannot fail on existing data.
--
-- ONE LIVE ENROLMENT PER (SALON, DEVICE), AND REVOKING KEEPS THE HISTORY
-- ---------------------------------------------------------------------
-- A partial unique index rather than a composite primary key, because unenrolling
-- must not erase the record that a till was pointed at a branch while money moved
-- through it. `revoked_at IS NULL` is the live row; the rest are history, and
-- re-enrolling the same device later is a new row rather than a mutation of the
-- old one. Same shape as `transaction_reverses_uq`.
--
-- `(salon_id, device_id)` is scoped per salon deliberately — it is the same pair
-- `pin_attempt_device_idx` and `scanner_attempt_device_idx` already key on, and
-- `device_id` is a client-chosen string, so two salons may both run a
-- "DEV-SCANNER-01" without colliding.
--
-- GRANTS: 0001's `ALTER DEFAULT PRIVILEGES … ON TABLES` covers it. This table is
-- deliberately NOT append-only — revoking is an UPDATE — so no REVOKE follows.
-- ---------------------------------------------------------------------------
ALTER TABLE "branch" ADD CONSTRAINT "branch_id_salon_uq" UNIQUE ("id", "salon_id");
--> statement-breakpoint
CREATE TABLE "device_enrolment" (
  "id" text PRIMARY KEY NOT NULL,
  "salon_id" text NOT NULL,
  "device_id" text NOT NULL,
  "branch_id" text NOT NULL,
  -- What a human calls this till. NOT NULL: a list of opaque device ids is a
  -- list a merchant cannot safely revoke a row from.
  "label" text NOT NULL,
  "enrolled_by_staff_id" text,
  "revoked_at" timestamp with time zone,
  "revoked_by_staff_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "device_enrolment_device_id_not_blank" CHECK (length(btrim("device_id")) > 0),
  CONSTRAINT "device_enrolment_label_not_blank" CHECK (length(btrim("label")) > 0),
  -- Revoked is one fact with two columns; either both or neither.
  CONSTRAINT "device_enrolment_revocation_is_whole"
    CHECK (("revoked_at" IS NULL) = ("revoked_by_staff_id" IS NULL)),
  CONSTRAINT "device_enrolment_salon_id_salon_id_fk"
    FOREIGN KEY ("salon_id") REFERENCES "salon"("id") ON DELETE restrict,
  CONSTRAINT "device_enrolment_branch_same_salon_fk"
    FOREIGN KEY ("branch_id", "salon_id") REFERENCES "branch"("id", "salon_id") ON DELETE restrict,
  CONSTRAINT "device_enrolment_enrolled_by_staff_user_id_fk"
    FOREIGN KEY ("enrolled_by_staff_id") REFERENCES "staff_user"("id") ON DELETE restrict,
  CONSTRAINT "device_enrolment_revoked_by_staff_user_id_fk"
    FOREIGN KEY ("revoked_by_staff_id") REFERENCES "staff_user"("id") ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX "device_enrolment_live_uq"
  ON "device_enrolment" ("salon_id", "device_id") WHERE "revoked_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "device_enrolment_branch_idx" ON "device_enrolment" ("branch_id");
