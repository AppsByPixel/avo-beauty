-- Proof, not documentation.
--
--   pnpm --dir api run db:reset    # fresh database + migrations
--   pnpm --dir api run db:verify   # this file
--
-- Runs the guarantees the schema exists to hold and shows the database refusing
-- each violation. Every statement in sections 1-4 is EXPECTED TO FAIL except the
-- seeds, the legal INSERT into audit_log, and step 3f. Section 5 is the opposite:
-- it must PASS, and raises if it does not.
--
-- WHICH DATABASE. `AVO_VERIFY_DB` selects it and defaults to `avo`:
--
--   AVO_VERIFY_DB=avo_lane_a pnpm --dir api run db:verify
--
-- It used to be hardcoded to `avo`, which meant the one command whose whole job
-- is proving invariants could not be pointed at the database you had just
-- seeded — and a lane that ran it anyway would be reading someone else's rows.
-- Section 5 is about seeded data, so this stopped being a convenience.
--
-- Run sections 1-4 against a freshly migrated database. It deliberately cannot
-- clean up after itself: the rows it writes to audit_log and ledger_entry are
-- ones nothing in this system is allowed to delete, which is the point.
--
-- Labels go to stderr (`\warn`) so they interleave with psql's errors in the
-- right order when the whole transcript is captured with 2>&1.

\set ON_ERROR_STOP off
\set QUIET on
SET client_min_messages TO WARNING;

-- --------------------------------------------------------------- seed ------
BEGIN;

INSERT INTO salon (id, name, brand_color, loyalty_mode, tiers, deposit_fils, business_hours)
VALUES ('SL-VERIFY', 'Amara', '#B7A99A', 'tiers',
        '[{"name":"bronze","minVisits":0,"bonusPercent":0}]'::jsonb,
        5000,
        '{"morning":["10:00","13:00"],"evening":["16:00","22:00"]}'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO branch (id, salon_id, name)
VALUES ('BR-VERIFY', 'SL-VERIFY', 'Salmiya')
ON CONFLICT (id) DO NOTHING;

INSERT INTO member (id, salon_id, name, phone, password_hash, balance_fils, tier, policy_version)
VALUES ('MB-VERIFY', 'SL-VERIFY', 'Noura S.', '+96599124408', '$argon2id$fake', 18000, 'bronze', 3)
ON CONFLICT (id) DO NOTHING;

COMMIT;

\set QUIET off

\warn ''
\warn '=== 1. audit_log is append-only for the application role ==================='
\warn ''

SET ROLE avo_app;
SELECT current_user AS connected_as;

\warn '--- 1a. INSERT is allowed (this must SUCCEED) ---'
INSERT INTO audit_log (salon_id, actor_kind, actor_id, actor_name, actor_role,
                       kind, action, detail, source, amount_fils)
VALUES ('SL-VERIFY', 'staff', 'ST-1', 'Rana Al-Sabah', 'Manager',
        'money', 'Charge taken', '6.000 KD · Blow-dry · Noura S.', 'scanner', -6000);

\warn '--- 1b. UPDATE must be REFUSED ---'
UPDATE audit_log SET detail = 'nothing to see here' WHERE actor_id = 'ST-1';

\warn '--- 1c. DELETE must be REFUSED ---'
DELETE FROM audit_log WHERE actor_id = 'ST-1';

\warn '--- 1d. TRUNCATE must be REFUSED ---'
TRUNCATE audit_log;

RESET ROLE;

\warn '--- 1e. and the trigger refuses the OWNER too (defence in depth) ---'
UPDATE audit_log SET detail = 'owner tried' WHERE actor_id = 'ST-1';
DELETE FROM audit_log WHERE actor_id = 'ST-1';

\warn '--- 1f. the row is still there, unchanged ---'
SELECT actor_name, action, detail FROM audit_log WHERE actor_id = 'ST-1';

\warn ''
\warn '=== 2. a negative balance is impossible ===================================='
\warn ''

SET ROLE avo_app;

\warn '--- 2a. spending more than the balance must be REFUSED ---'
UPDATE member SET balance_fils = balance_fils - 20000 WHERE id = 'MB-VERIFY';

\warn '--- 2b. writing a negative balance directly must be REFUSED ---'
UPDATE member SET balance_fils = -1 WHERE id = 'MB-VERIFY';

\warn '--- 2c. so must inserting a member who is already overdrawn ---'
INSERT INTO member (id, salon_id, name, phone, password_hash, balance_fils, tier, policy_version)
VALUES ('MB-NEG', 'SL-VERIFY', 'Overdrawn', '+96599124409', '$argon2id$fake', -1, 'bronze', 3);

\warn '--- 2d. the balance is untouched ---'
SELECT id, balance_fils FROM member WHERE id = 'MB-VERIFY';

RESET ROLE;

\warn ''
\warn '=== 3. supporting guarantees =============================================='
\warn ''

SET ROLE avo_app;

\warn '--- 3a. a wallet token cannot be minted with a long life ---'
INSERT INTO wallet_token (member_id, token_hash, expires_at)
VALUES ('MB-VERIFY', 'hash-long-lived', now() + interval '1 day');

\warn '--- 3b. the same idempotency key twice in one scope must be REFUSED ---'
INSERT INTO idempotency_key (scope, key, endpoint, request_hash)
VALUES ('member:MB-VERIFY', 'idem-1', 'POST /charges', 'sha256:aaa');
INSERT INTO idempotency_key (scope, key, endpoint, request_hash)
VALUES ('member:MB-VERIFY', 'idem-1', 'POST /charges', 'sha256:bbb');

\warn '--- 3c. void without charges must be REFUSED ---'
INSERT INTO staff_user (id, salon_id, name, handle, role, perm_void, perm_charges)
VALUES ('ST-BAD', 'SL-VERIFY', 'Hessa M.', 'hessa', 'frontdesk', true, false);

\warn '--- 3d. a charge that credits the customer must be REFUSED ---'
INSERT INTO transaction (id, member_id, salon_id, branch_id, kind, amount_fils)
VALUES ('TX-BAD', 'MB-VERIFY', 'SL-VERIFY', 'BR-VERIFY', 'charge', 6000);

\warn '--- 3e. an unbalanced pair of ledger entries must be REFUSED at COMMIT ---'
BEGIN;
INSERT INTO transaction (id, member_id, salon_id, branch_id, kind, amount_fils, status, settled_at)
VALUES ('TX-LEDGER', 'MB-VERIFY', 'SL-VERIFY', 'BR-VERIFY', 'charge', -6000, 'settled', now());
INSERT INTO ledger_entry (transaction_id, salon_id, member_id, account, direction, amount_fils, balance_after_fils)
VALUES ('TX-LEDGER', 'SL-VERIFY', 'MB-VERIFY', 'member_wallet', 'debit', 6000, 12000);
INSERT INTO ledger_entry (transaction_id, salon_id, account, direction, amount_fils)
VALUES ('TX-LEDGER', 'SL-VERIFY', 'salon_revenue', 'credit', 5000);  -- 1000 fils short
COMMIT;

\warn '--- 3f. the balanced version commits ---'
BEGIN;
INSERT INTO transaction (id, member_id, salon_id, branch_id, kind, amount_fils, status, settled_at)
VALUES ('TX-LEDGER-OK', 'MB-VERIFY', 'SL-VERIFY', 'BR-VERIFY', 'charge', -6000, 'settled', now());
INSERT INTO ledger_entry (transaction_id, salon_id, member_id, account, direction, amount_fils, balance_after_fils)
VALUES ('TX-LEDGER-OK', 'SL-VERIFY', 'MB-VERIFY', 'member_wallet', 'debit', 6000, 12000);
INSERT INTO ledger_entry (transaction_id, salon_id, account, direction, amount_fils)
VALUES ('TX-LEDGER-OK', 'SL-VERIFY', 'salon_revenue', 'credit', 6000);
COMMIT;

\warn '--- 3g. and a committed ledger entry cannot be edited afterwards ---'
UPDATE ledger_entry SET amount_fils = 1 WHERE transaction_id = 'TX-LEDGER-OK';

\warn '--- 3h. a blank Arabic name must be REFUSED; a NULL one must be ACCEPTED ---'
-- The client falls back with `nameAr ?? name`, and `'' ?? name` is `''`. So a
-- blank Arabic name does not fall back, it paints an empty heading — absent has
-- to be NULL and nothing else. Both halves are proven: the whitespace UPDATE
-- fails, and the NULL one is the one legal statement in this block.
UPDATE salon SET name_ar = '   ' WHERE id = 'SL-VERIFY';
UPDATE salon SET stamp_reward_ar = '' WHERE id = 'SL-VERIFY';
UPDATE branch SET name_ar = '' WHERE id = 'BR-VERIFY';
UPDATE salon SET name_ar = NULL WHERE id = 'SL-VERIFY';

\warn '--- 3i. a wallet token is single use: UPDATE 1 then UPDATE 0 (the 410) ---'
INSERT INTO wallet_token (member_id, token_hash) VALUES ('MB-VERIFY', 'hash-live-token');
UPDATE wallet_token SET consumed_at = now()
 WHERE token_hash = 'hash-live-token' AND consumed_at IS NULL AND expires_at > now();
UPDATE wallet_token SET consumed_at = now()
 WHERE token_hash = 'hash-live-token' AND consumed_at IS NULL AND expires_at > now();

RESET ROLE;

\warn ''
\warn '=== 4. every money column is bigint ======================================='
SELECT table_name, column_name, data_type
  FROM information_schema.columns
 WHERE table_schema = 'public' AND column_name LIKE '%\_fils'
 ORDER BY table_name, column_name;

\warn ''
\warn '=== 5. every wallet reconciles to its ledger =============================='
\warn ''
-- THE ONE RECONCILIATION THIS SCHEMA EXISTS TO KEEP TRUE, ASSERTED.
--
-- `member.balance_fils` is a cached aggregate. `schema/ledger.ts` says what makes
-- it defensible, and says it is the reason the table exists:
--
--     SELECT sum(CASE direction WHEN 'credit' THEN amount_fils ELSE -amount_fils END)
--     FROM ledger_entry WHERE account = 'member_wallet' AND member_id = $1;
--
-- That property was asserted in three comments and checked nowhere, and the seed
-- broke it on its first line: both fixture members were INSERTed with a balance
-- already on the row and no entry saying where it came from, so the sum was short
-- by exactly the opening balance on a clean database. An invariant nobody checks
-- is the same thing as a comment, so here is the check.
--
-- LEFT JOIN, not INNER. A member with no wallet entries at all must show up as a
-- drift equal to her whole balance rather than vanishing from the result — that is
-- precisely the shape the missing opening balances had, and an INNER JOIN would
-- have hidden it.
--
-- `SL-VERIFY` IS EXCLUDED, and this is the one exemption. That salon and its
-- member are this script's own scratch fixtures for probing constraints: section 3
-- deliberately writes wallet entries for `MB-VERIFY` without maintaining her
-- balance, because it is testing the balanced-entry trigger rather than modelling
-- a customer. Including it would make this section fail always, which is the same
-- as not having it.
SELECT m.id,
       m.balance_fils,
       coalesce(sum(CASE le.direction WHEN 'credit' THEN le.amount_fils
                                      ELSE -le.amount_fils END), 0) AS ledger_fils,
       m.balance_fils
         - coalesce(sum(CASE le.direction WHEN 'credit' THEN le.amount_fils
                                          ELSE -le.amount_fils END), 0) AS difference_fils
  FROM member m
  LEFT JOIN ledger_entry le
         ON le.member_id = m.id
        AND le.account = 'member_wallet'
 WHERE m.salon_id <> 'SL-VERIFY'
 GROUP BY m.id, m.balance_fils
 ORDER BY m.id;

\warn '--- and it FAILS LOUDLY rather than printing a table nobody reads ---'
DO $$
DECLARE
  drifted text;
  n int;
BEGIN
  SELECT count(*), string_agg(format('%s off by %s fils', id, difference_fils), ', ' ORDER BY id)
    INTO n, drifted
    FROM (
      SELECT m.id,
             m.balance_fils
               - coalesce(sum(CASE le.direction WHEN 'credit' THEN le.amount_fils
                                                ELSE -le.amount_fils END), 0) AS difference_fils
        FROM member m
        LEFT JOIN ledger_entry le
               ON le.member_id = m.id
              AND le.account = 'member_wallet'
       WHERE m.salon_id <> 'SL-VERIFY'
       GROUP BY m.id, m.balance_fils
    ) per_member
   WHERE difference_fils <> 0;

  IF n > 0 THEN
    RAISE EXCEPTION
      'wallet ledger does not reconcile for % member(s): %', n, drifted
      USING HINT = 'member.balance_fils must equal the signed sum of its member_wallet entries. '
                   'A balance with no originating entry is a hole in the record, not a fixture convenience.';
  END IF;
END
$$;

-- THE VERDICT, ON STDOUT, and not a `RAISE NOTICE` — line 29 of this script sets
-- `client_min_messages TO WARNING` so that the seed's own chatter stays out of the
-- transcript, which silently swallows any NOTICE raised down here. Found by
-- writing one and watching it never appear. A result row cannot be suppressed by
-- a message threshold, and it states the outcome in both directions rather than
-- only shouting on failure.
SELECT CASE
         WHEN count(*) FILTER (WHERE difference_fils <> 0) = 0 THEN 'RECONCILED'
         ELSE 'DRIFT — '
              || count(*) FILTER (WHERE difference_fils <> 0)
              || ' member(s) disagree with their ledger'
       END AS verdict,
       count(*) AS members_checked
  FROM (
    SELECT m.id,
           m.balance_fils
             - coalesce(sum(CASE le.direction WHEN 'credit' THEN le.amount_fils
                                              ELSE -le.amount_fils END), 0) AS difference_fils
      FROM member m
      LEFT JOIN ledger_entry le
             ON le.member_id = m.id
            AND le.account = 'member_wallet'
     WHERE m.salon_id <> 'SL-VERIFY'
     GROUP BY m.id, m.balance_fils
  ) per_member;

\warn ''
\warn '=== 6. a consent record cannot be rewritten =============================='
\warn ''
-- Non-negotiable #8 needs marketing consent readable and TRUTHFUL on the platform
-- send path. Migration 0020 stores it as append-only events and revokes UPDATE and
-- DELETE from the application role; migration 0023 adds the triggers that stop the
-- OWNER too, because 0020's comment claimed parity with `audit_log` and only had
-- half of it. A consent record that can be edited is not evidence of consent.
--
-- Both statements below are EXPECTED TO FAIL, as the owner.
INSERT INTO member_consent_event (member_id, salon_id, kind, granted, source, policy_version)
VALUES ('MB-VERIFY', 'SL-VERIFY', 'marketing_offers', false, 'wallet_account', 3);

\warn '--- 6a. a withdrawal cannot be flipped into a grant ---'
UPDATE member_consent_event SET granted = true WHERE member_id = 'MB-VERIFY';

\warn '--- 6b. nor can the event be backdated, or moved to another policy version ---'
UPDATE member_consent_event SET created_at = now() - interval '1 year' WHERE member_id = 'MB-VERIFY';
UPDATE member_consent_event SET policy_version = 99 WHERE member_id = 'MB-VERIFY';

\warn '--- 6c. nor emptied wholesale ---'
TRUNCATE member_consent_event;

\warn '--- 6d. but the ERASURE CASCADE must still work: DELETE has NO trigger, deliberately ---'
-- `member_consent_event.member_id` is ON DELETE CASCADE and the 30-day erasure the
-- privacy policy promises ends in a DELETE of the member. A DELETE trigger here
-- would make that erasure impossible — the cascade fails, so the member delete
-- fails. This block is the one in section 6 that must SUCCEED, and it is why the
-- parity with `audit_log` deliberately stops at UPDATE and TRUNCATE.
BEGIN;
INSERT INTO member (id, salon_id, name, phone, password_hash, balance_fils, tier, policy_version)
VALUES ('MB-ERASE', 'SL-VERIFY', 'Erasure Probe', '+96599100009', '$argon2id$fake', 0, 'bronze', 3);
INSERT INTO member_consent_event (member_id, salon_id, kind, granted, source, policy_version)
VALUES ('MB-ERASE', 'SL-VERIFY', 'marketing_offers', true, 'signup', 3);
DELETE FROM member WHERE id = 'MB-ERASE';
SELECT count(*) AS consent_rows_left_after_erasure
  FROM member_consent_event WHERE member_id = 'MB-ERASE';
COMMIT;
