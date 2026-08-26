-- ===========================================================================
-- 0039 — a budget for the three PASSWORD sign-ins
--
--   POST /auth/member/session     the customer wallet   (salonId + phone)
--   POST /auth/web/session        the merchant dashboard (salonId + username)
--   POST /auth/platform/session   the owner console      (handle)
--
-- All three verified a password, answered `invalid_credentials`, and COUNTED
-- NOTHING. No rate limit, no lockout, no attempt row, and no global limiter to
-- fall back on — `api/src/app.ts` registers no rate-limit plugin and
-- `api/package.json` carries no such package. Somebody holding a phone number and
-- a salon id, or a console handle, could guess without bound and without trace.
--
-- THE ASYMMETRY THAT HID IT
-- -------------------------
-- Everything around them is limited: signup (0026), the member reset request
-- (0034), the support queue, the customer directory, top-ups, and the three
-- scanner endpoints (0038). The staff PIN is limited TWICE — per device
-- (`pin_attempt`) and per account (`staff_user.pin_locked_until`).
--
-- Non-negotiable #6 is the likely reason. It says passwords are "never stored in
-- plaintext, never returned by an endpoint, never shown in a UI", and then says
-- separately that staff PINs are "hashed, rate limited, device-scoped, locked
-- after N failures". The four controls are attached to the PIN, and the PIN got
-- all four. A four-digit PIN needs them more than a password does; it does not
-- need them INSTEAD of a password.
--
-- WHY A TABLE, AND NOT AN IN-PROCESS COUNTER
-- ------------------------------------------
-- 0026's answer, unchanged: a counter in one Node process is a limit per replica
-- that resets on every deploy, so the real ceiling is N times what the number says
-- and it disappears exactly during a rolling restart.
--
-- WHY NOT `staff_user.pin_locked_until`'S SHAPE — A LATCH ON THE ACCOUNT ROW
-- -------------------------------------------------------------------------
-- Because that is a denial-of-service weapon pointed at a paying customer.
-- `pin_locked_until` is right for a PIN: the account is a staff member, the
-- device is in the salon, and "a manager can unlock it" is a real sentence about
-- a real person standing nearby. There is no manager standing next to Dana's
-- phone. Anybody who knows her number could latch her out of her own wallet at
-- will, indefinitely, for the cost of five wrong guesses.
--
-- So this is a ROLLING WINDOW and not a latch, and it deliberately writes NOTHING
-- to `member`, `staff_user` or `platform_admin`. There is no state on the account
-- for an attacker to set and no unlock for anyone to perform: the window decays,
-- and the legitimate user is back in as soon as it has. routes/auth.ts already
-- reasoned about this shape once, for the deletion grace window — a customer who
-- forgot her password during it "would otherwise be locked out of the one door
-- that cancels the erasure" — and the conclusion transfers: a customer wallet may
-- not have a door that a stranger can bar.
--
-- KEYED ON THE CLAIMED IDENTITY, AND THAT IS WHAT CLOSES THE ORACLE
-- ----------------------------------------------------------------
-- routes/auth.ts's header states the property the whole file is built around:
-- "Every failure path answers with the same body and burns the same argon2 time,
-- whether the account exists or not." A limiter that engaged only for accounts
-- that EXIST would hand that back in a louder form — `429` for a real customer and
-- `401` for a stranger is a customer-list oracle with a bigger signal than the
-- timing channel the `burnVerifyTime` calls were added to remove.
--
-- The key is therefore computed from what the REQUEST CLAIMS, before any table is
-- read, and the limiter never learns whether the account exists. A locked bucket
-- and an absent account are the same code path, so they answer identically by
-- construction rather than by remembering to.
--
-- NOT KEYED ON `req.ip`, AND THIS IS THE DELIBERATE DIFFERENCE FROM 0026
-- ---------------------------------------------------------------------
-- 0038 already made this argument for the till and it is stronger here:
--
--   A SALON IS ONE NAT. Every customer signing in on the salon's wifi leaves
--   through one address. An IP-keyed sign-in budget would refuse the fourth
--   customer of the afternoon.
--
--   `req.ip` IS NOT RELIABLY THE CALLER. `app.ts` sets `trustProxy:
--   env.trustProxy`, which is OFF until `TRUST_PROXY` names the real proxy, so
--   behind a load balancer `req.ip` is the balancer — one bucket for the entire
--   platform. On signup that is a bad day. On sign-in it is a total outage of
--   every surface at once, which is strictly worse than the guessing it bounds.
--
--   AND IT IS EVADABLE ANYWAY, in the direction that matters: an attacker rotates
--   addresses, a customer cannot. The account is the attacker-independent key.
--
-- WHAT IS AND IS NOT RECORDED
-- ---------------------------
-- The surface, the salon, an identity KEY, and the time. NEVER THE PASSWORD —
-- non-negotiable #6 — and never the phone number or the handle in the clear.
--
-- `identity_key` is an HMAC-SHA256 over `surface | salon | identifier`, keyed with
-- the deployment's `JWT_SECRET` (services/signInLimit.ts carries the construction
-- and the domain-separation label). A plain digest would not have been enough:
-- Kuwaiti mobile numbers are eight digits behind a fixed prefix, so a sha256 of
-- one is a lookup table away from the number itself, and this table's contents are
-- exactly the phone numbers somebody TRIED — a list that includes people who have
-- no account here. That is 0026's objection to storing the phone at all ("a worse
-- privacy artefact than the oracle this does not close"), and an HMAC is what lets
-- the counter key on the identity without keeping the identity.
--
-- Rotating `JWT_SECRET` re-keys every bucket, which empties the limiter for one
-- window. Acceptable and worth naming: a secret rotation is a rare, deliberate,
-- operator-run event, and the alternative is a second secret with its own
-- lifecycle that nothing else in this API has.
--
-- `salon_id` IS IN THE CLEAR AND HAS NO FOREIGN KEY. In the clear because a salon
-- id is not personal and "what happened at this salon during the incident" is the
-- question an operator actually asks. No foreign key for 0026's reason: an attempt
-- naming a salon that does not exist is exactly the traffic worth counting, and a
-- FK would make that insert fail before the count happened — turning the cheapest
-- possible probe into the one path that skips the limiter. NULL for the console,
-- which has no salon by design (`session_salon_matches_principal`).
--
-- AND NOT WHETHER IT WORKED, for 0026's and 0038's reason. The row is written
-- BEFORE the lookup and before argon2, or a burst of simultaneous requests all
-- read a count of zero and all pay for a hash — the exact flood being rationed.
-- The outcome is not known at insert time, recording it later would need an
-- UPDATE, and the privileges below refuse one.
--
-- The consequence, stated rather than left to be discovered: a SUCCESSFUL sign-in
-- also spends budget. That is the cost of writing first, it is what
-- `signup_attempt` and `scanner_attempt` both pay, and at ten attempts per fifteen
-- minutes per account it is not a cost a person can feel — she would have to sign
-- in on an eleventh device inside a quarter of an hour. Counting only failures
-- would not have helped the denial-of-service case either: an attacker fills the
-- bucket with failures either way.
--
-- `surface` HAS A CHECK AND NOT AN ENUM. Three values, a closed set, and a
-- pgEnum would put a type in the schema whose only consumer is one `count(*)` —
-- 0038's rule, and `scanner_attempt.action` is the precedent.
--
-- Idempotent and safe to re-run.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS sign_in_attempt (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Which front door. Kept separate from the key it is already mixed into,
  -- because the key is opaque and this is what an operator groups by.
  surface       text NOT NULL,
  -- HMAC-SHA256 hex, 64 characters. See the header for why it is not the phone.
  identity_key  text NOT NULL,
  -- Free text, deliberately unconstrained, and NULL for the owner console.
  salon_id      text,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT sign_in_attempt_surface_known
    CHECK (surface IN ('member', 'web', 'platform'))
);

-- The limiter's only query: two counts over one window for one claimed identity.
-- `created_at` descending because the window is always "the recent end". The
-- surface is already inside `identity_key`, so it is not in the index.
CREATE INDEX IF NOT EXISTS sign_in_attempt_identity_idx
  ON sign_in_attempt (identity_key, created_at DESC);

-- For "what happened at this salon", which is a different question from the
-- limiter's and would otherwise be a full scan. Mirrors `signup_attempt_salon_idx`.
CREATE INDEX IF NOT EXISTS sign_in_attempt_salon_idx
  ON sign_in_attempt (salon_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Privileges. INSERT and SELECT, and nothing else — 0026's rule and its reason:
-- a row the application can UPDATE or DELETE is a counter that can be reset by
-- whatever gets compromised next, and a limiter whose own rows the application can
-- remove is not a limit. Retention is an operator's job, with the owner role.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT ON sign_in_attempt TO avo_app;
REVOKE UPDATE, DELETE ON sign_in_attempt FROM avo_app;
