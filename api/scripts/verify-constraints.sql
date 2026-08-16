-- Proof, not documentation.
--
--   pnpm --filter @avo/api run db:reset    # fresh database + migrations
--   pnpm --filter @avo/api run db:verify   # this file
--
-- Runs the guarantees the schema exists to hold and shows the database refusing
-- each violation. Every statement below is EXPECTED TO FAIL except the seeds,
-- the legal INSERT into audit_log, and step 3f.
--
-- Run it against a freshly migrated database. It deliberately cannot clean up
-- after itself: the rows it writes to audit_log and ledger_entry are ones
-- nothing in this system is allowed to delete, which is the point.
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

\warn '--- 3h. a wallet token is single use: UPDATE 1 then UPDATE 0 (the 410) ---'
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
