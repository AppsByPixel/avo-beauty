-- ===========================================================================
-- 0073 — A PHONE IS PAIRED, NOT TYPED IN; AND A STAFF MEMBER'S NUMBER IS A NAME
--
-- Aftab, 2026-11-10 (DECISIONS.md § Staff phone pairing, phone sign-in, and a
-- truthful receipt line). Nothing in the product set a staff PIN or bound one to
-- a phone — only `db/seed.ts` wrote `pin_hash` — so every staff account made in
-- the dashboard, and every owner of an onboarded salon, could never sign into
-- the scanner. Pairing is the missing door. Three changes:
--
--   1. `staff_user.phone` — the staff member's own mobile, E.164, a sign-in name
--      beside `handle`. REVERSES the recorded choice at
--      `api/src/db/schema/salon.ts` § ownerPhone ("It is also NOT on
--      `staff_user`") by Aftab's ruling.
--   2. `staff_pairing_code` — the single-use code a manager issues and a phone
--      redeems once, by QR (the token) or by mobile number + six digits.
--   3. `sign_in_attempt.surface` admits `'pair'`, so the unauthenticated redeem
--      is rationed on the same counter as the three password doors.
--
-- ---------------------------------------------------------------------------
-- 1. staff_user.phone
-- ---------------------------------------------------------------------------
-- NULLABLE: landing on a populated table, and "null until a manager enters it"
-- is the contract (`StaffUserSchema.phone`).
--
-- `staff_user_phone_is_e164` IS BYTE-IDENTICAL TO `member_phone_is_e164` (0000)
-- and `salon_owner_phone_is_e164` (0037), and `http/fields.ts § E164` is the same
-- pattern, so a value the API accepts cannot be refused here with a 500. A NULL
-- passes a CHECK, which is the nullable half.
--
-- `staff_user_salon_active_phone_uq` — UNIQUE (salon_id, phone) AMONG ACTIVE
-- STAFF. A phone number is a sign-in name, so two live accounts sharing one at a
-- salon would be one login that opens whichever row the planner reaches first.
-- PARTIAL ON `deactivated_at IS NULL`, unlike `staff_user_salon_handle_uq`, which
-- spans leavers: a leaver's number is not hers for ever — it is a SIM, and the
-- next hire may well hold it. The re-hire path (routes/auth.ts § staff
-- password-reset) drops a leaver's number that somebody active now holds, in the
-- same UPDATE that re-activates her, rather than meeting this index as a 500.
--
-- `staff_user_active_phone_idx` — (phone) among active staff. `POST /staff/pair`
-- by mobile number carries NO salon (the phone is not yet signed into one), so it
-- asks "which active staff rows hold this number" across salons; the unique
-- index above has `salon_id` first and cannot serve that. Same shape and reason
-- as `member_live_phone_idx` (0070).
--
-- `staff_user_id_salon_uq` — UNIQUE (id, salon_id). Additive over the primary
-- key, exactly as `branch_id_salon_uq` (0043) is: it is the target of the
-- composite foreign keys below, which make "salon A's code names salon B's staff
-- member" unstorable whatever a code path forgets.
--
-- ---------------------------------------------------------------------------
-- 2. staff_pairing_code
-- ---------------------------------------------------------------------------
-- HASHES ONLY. `token_hash` is sha256 hex — the token is 256 bits of CSPRNG, so
-- there is no low-entropy space to slow anybody down through, which is
-- `session.refresh_token_hash`'s argument. `code_hash` is argon2id through
-- `hashSecret`, because SIX DIGITS ARE A MILLION PREIMAGES: a leaked sha256 of
-- one is a laptop-second away from the code. The two CHECKs pin the shapes, so a
-- plaintext code cannot be stored by a future caller that forgets to hash.
--
-- SINGLE-USE IS A WHERE CLAUSE. `used_at IS NULL AND voided_at IS NULL AND
-- expires_at > now()` guards the claim UPDATE inside `POST /staff/pair`'s one
-- transaction, so two racing redeems cannot both win.
--
-- `staff_pairing_code_spent_once` — used and voided are two ways for a code to
-- END, and a code ends once.
--
-- `failed_attempts` — five wrong six-digit guesses against one code VOID it
-- (`voided_at`), so the phone + digits path is bounded per code as well as per
-- phone and per address (`services/pairLimit.ts`).
--
-- `staff_pairing_code_live_uq` — at most ONE live code per staff member. Issuing
-- a new one voids the earlier ones (routes/staff.ts § pairing-code) inside a
-- transaction that locks the staff row first; this index is the backstop that
-- makes "two live codes for one person" unstorable rather than merely unwritten.
-- An expired code that was never voided still counts as live here, which is
-- harmless: the next issue voids it.
--
-- TENANCY IS COMPOSITE FOREIGN KEYS. `(staff_id, salon_id)` and
-- `(created_by, salon_id)` → `staff_user (id, salon_id)`; `(branch_id, salon_id)`
-- → `branch (id, salon_id)`, MATCH SIMPLE so a NULL branch ("pair, do not enrol")
-- is not checked. The issuer, the target and the till's branch are all one salon
-- or the row does not commit.
--
-- ON DELETE: `staff_id` CASCADES, as `staff_password_reset.staff_id` does — a
-- code is a credential in transit for that person and means nothing without her.
-- (Staff rows are deactivated, never deleted, in the product; this is what a
-- test fixture's cleanup meets.) `created_by` RESTRICTS: an issuer's id is the
-- audit answer to "who let this phone in".
--
-- GRANTS. 0001's `ALTER DEFAULT PRIVILEGES … ON TABLES` already gives `avo_app`
-- SELECT, INSERT, UPDATE, DELETE; restated explicitly below so the table does not
-- depend on which role happened to run this file. Not append-only — a claim and a
-- void are UPDATEs — so no REVOKE follows. Its trail is `audit_log`, which is.
--
-- ---------------------------------------------------------------------------
-- 3. sign_in_attempt.surface += 'pair'
-- ---------------------------------------------------------------------------
-- The redeem is unauthenticated and guesses a secret, so it is rationed on the
-- 0039 counter: HMAC-keyed buckets, a rolling window, nothing written to the
-- account row. `services/pairLimit.ts` keys it per address and per phone (the
-- spec asks for both, and why the address tier is acceptable HERE when 0039
-- refused it for passwords is argued in that file). A CHECK swap, not an enum:
-- 0039's own rule. `avo_app` keeps INSERT and SELECT only.
--
-- ---------------------------------------------------------------------------
-- SAFE UNDER THE DEPLOYED API
-- ---------------------------------------------------------------------------
-- ADDITIVE. One nullable column the deployed API never names (its SELECTs list
-- columns through Drizzle), a new table it never reads, one more allowed value
-- in a CHECK it only ever satisfies with the old three. Nothing renamed, nothing
-- dropped, nothing tightened against a row that exists.
--
-- LOCKING. ADD COLUMN with no default is a catalogue change. The CHECK and the
-- two indexes on `staff_user` scan and build over one row per staff member —
-- tens per salon. The CHECK swap on `sign_in_attempt` re-validates a counter
-- table that retention keeps short. lock_timeout 3s, the 0010/0011/0059/0063..0072
-- convention, so the migration fails and rolls back rather than queueing a
-- sign-in behind it. Re-running is safe (IF NOT EXISTS / DROP IF EXISTS).
-- ===========================================================================

SET lock_timeout = '3s';--> statement-breakpoint

-- ----------------------------------------------------------------- phone --
ALTER TABLE "staff_user" ADD COLUMN IF NOT EXISTS "phone" text;--> statement-breakpoint

ALTER TABLE "staff_user" DROP CONSTRAINT IF EXISTS "staff_user_phone_is_e164";--> statement-breakpoint
ALTER TABLE "staff_user" ADD CONSTRAINT "staff_user_phone_is_e164"
  CHECK ("phone" ~ '^\+[1-9][0-9]{6,14}$');--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "staff_user_salon_active_phone_uq"
  ON "staff_user" ("salon_id", "phone")
  WHERE "deactivated_at" IS NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "staff_user_active_phone_idx"
  ON "staff_user" ("phone")
  WHERE "deactivated_at" IS NULL AND "phone" IS NOT NULL;--> statement-breakpoint

ALTER TABLE "staff_user" DROP CONSTRAINT IF EXISTS "staff_user_id_salon_uq";--> statement-breakpoint
ALTER TABLE "staff_user" ADD CONSTRAINT "staff_user_id_salon_uq" UNIQUE ("id", "salon_id");--> statement-breakpoint

-- --------------------------------------------------------- pairing codes --
CREATE TABLE IF NOT EXISTS "staff_pairing_code" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "salon_id" text NOT NULL,
  "staff_id" text NOT NULL,
  -- sha256 hex of the QR token. Never the token.
  "token_hash" text NOT NULL,
  -- argon2id of the six digits. Never the digits.
  "code_hash" text NOT NULL,
  -- The branch the paired phone is enrolled at as a till. NULL: paired, not enrolled.
  "branch_id" text,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "voided_at" timestamp with time zone,
  "failed_attempts" integer DEFAULT 0 NOT NULL,
  -- The staff member whose `perms.team` issued it.
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "staff_pairing_code_token_hash_is_sha256"
    CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "staff_pairing_code_code_hash_is_argon2id"
    CHECK ("code_hash" LIKE '$argon2id$%'),
  CONSTRAINT "staff_pairing_code_expires_after_creation"
    CHECK ("expires_at" > "created_at"),
  CONSTRAINT "staff_pairing_code_attempts_non_negative"
    CHECK ("failed_attempts" >= 0),
  CONSTRAINT "staff_pairing_code_spent_once"
    CHECK ("used_at" IS NULL OR "voided_at" IS NULL),
  CONSTRAINT "staff_pairing_code_salon_id_salon_id_fk"
    FOREIGN KEY ("salon_id") REFERENCES "salon"("id") ON DELETE restrict,
  CONSTRAINT "staff_pairing_code_staff_same_salon_fk"
    FOREIGN KEY ("staff_id", "salon_id") REFERENCES "staff_user"("id", "salon_id") ON DELETE cascade,
  CONSTRAINT "staff_pairing_code_issuer_same_salon_fk"
    FOREIGN KEY ("created_by", "salon_id") REFERENCES "staff_user"("id", "salon_id") ON DELETE restrict,
  CONSTRAINT "staff_pairing_code_branch_same_salon_fk"
    FOREIGN KEY ("branch_id", "salon_id") REFERENCES "branch"("id", "salon_id") ON DELETE restrict
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "staff_pairing_code_token_uq"
  ON "staff_pairing_code" ("token_hash");--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "staff_pairing_code_live_uq"
  ON "staff_pairing_code" ("staff_id")
  WHERE "used_at" IS NULL AND "voided_at" IS NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "staff_pairing_code_salon_created_idx"
  ON "staff_pairing_code" ("salon_id", "created_at" DESC);--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "staff_pairing_code" TO avo_app;--> statement-breakpoint

-- ---------------------------------------------- the redeem's rate limiter --
ALTER TABLE "sign_in_attempt" DROP CONSTRAINT IF EXISTS "sign_in_attempt_surface_known";--> statement-breakpoint
ALTER TABLE "sign_in_attempt" ADD CONSTRAINT "sign_in_attempt_surface_known"
  CHECK ("surface" IN ('member', 'web', 'platform', 'pair'));--> statement-breakpoint

RESET lock_timeout;
