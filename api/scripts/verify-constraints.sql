-- Proof, not documentation.
--
--   pnpm --dir api run db:reset    # fresh database + migrations
--   pnpm --dir api run db:verify   # this file
--
-- Runs the guarantees the schema exists to hold and shows the database refusing
-- each violation.
--
-- HOW TO READ IT. Most statements are EXPECTED TO FAIL — an error here is the
-- guarantee working. The exceptions are named, because a section that only ever
-- fails cannot tell you when it has stopped testing anything:
--
--   MUST SUCCEED   the seeds; 1a; 3f; 3h's NULL update; 4's summary row;
--                  5 (RECONCILED); 6d (the erasure cascade); 7d (loyalty_event is
--                  truncatable BY DECISION, migration 0008); 8b (a member with no
--                  money history does delete); 9d (a non-terminal top-up advances)
--   MUST FAIL      everything else
--
-- The MUST SUCCEED blocks exist because several of these invariants have a
-- DELIBERATE limit, and a limit nobody asserts is one the next person removes while
-- "fixing an inconsistency". 6d and 7d are the two already reasoned about at length,
-- in migrations 0023 and 0008.
--
-- Sections 4a, 4b and 5 RAISE on violation rather than printing a table, so this
-- file fails loudly instead of leaving a reader to notice.
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
\warn '=== 4. every money column is bigint, and no float exists at all ==========='
\warn ''
-- THIS SECTION USED TO PRINT A TABLE AND ASSERT NOTHING.
--
-- It listed every `%_fils` column and its type, and left the reader to notice a
-- wrong one. A `double precision` column would have appeared in that list, in
-- alphabetical order, between two correct ones — which is the same failure mode as
-- a comment: information nobody is obliged to act on. Non-negotiable #1 is the
-- most load-bearing rule in this project and it was the least checked thing in
-- this file.
SELECT table_name, column_name, data_type
  FROM information_schema.columns
 WHERE table_schema = 'public' AND column_name LIKE '%\_fils'
 ORDER BY table_name, column_name;

\warn '--- 4a. and it now FAILS if any of them is not bigint ---'
DO $$
DECLARE offenders text;
BEGIN
  SELECT string_agg(format('%s.%s is %s', table_name, column_name, data_type), ', ' ORDER BY table_name, column_name)
    INTO offenders
    FROM information_schema.columns
   WHERE table_schema = 'public' AND column_name LIKE '%\_fils' AND data_type <> 'bigint';

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'Non-negotiable #1: money must be bigint fils. Offending columns: %', offenders
      USING HINT = 'Integer fils, never a float. Format to 3 decimals at the display boundary only.';
  END IF;
END
$$;

\warn '--- 4b. AND no float-family column exists anywhere, whatever it is called ---'
-- The `%_fils` rule only catches money that was named correctly. A column called
-- `total`, `price` or `amount` in `double precision` satisfies every check above
-- and still puts a float on the money path — and the naming convention is the only
-- thing that would have flagged it. So the stronger claim is asserted directly:
-- this schema contains no float-family column at all.
--
-- `numeric` is refused with the others. It is exact, so it would not lose fils to
-- binary rounding, but non-negotiable #1 is that money is an INTEGER COUNT of
-- fils, and a numeric column invites a fractional fil that has no meaning and no
-- display format. If a genuine non-money use for numeric ever arrives, narrow this
-- to the money-bearing tables rather than deleting it.
DO $$
DECLARE offenders text;
BEGIN
  SELECT string_agg(format('%s.%s is %s', table_name, column_name, data_type), ', ' ORDER BY table_name, column_name)
    INTO offenders
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND data_type IN ('double precision', 'real', 'numeric', 'money');

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'Non-negotiable #1: no float may reach money. Offending columns: %', offenders
      USING HINT = 'Money is integer fils in bigint. A float column on any table is a float one join away from a total.';
  END IF;
END
$$;

SELECT 'no float-family column anywhere' AS money_type_check,
       count(*) AS fils_columns_all_bigint
  FROM information_schema.columns
 WHERE table_schema = 'public' AND column_name LIKE '%\_fils' AND data_type = 'bigint';

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

\warn ''
\warn '=== 7. TRUNCATE cannot erase the money ledger ============================='
\warn ''
-- THE THIRD INSTANCE OF THE HALF-PARITY PATTERN, on the most load-bearing table in
-- the schema. `schema/ledger.ts` claimed `ledger_entry` was immutable "for the same
-- reason" as `audit_log`, and migration 0004 said the same of `gateway_event`. Both
-- had no_update and no_delete; `audit_log` also has no_truncate, because TRUNCATE
-- is neither an UPDATE nor a DELETE and a FOR EACH ROW trigger never runs for it.
--
-- So one statement emptied the table every wallet balance is derived from, with no
-- error. Migration 0024 closes it. All four statements below must FAIL.
\warn '--- 7a. the wallet ledger ---'
TRUNCATE ledger_entry;

\warn '--- 7b. the gateway event log ---'
TRUNCATE gateway_event;

\warn '--- 7c. and the two that were already protected, so the set stays complete ---'
TRUNCATE audit_log;
TRUNCATE member_consent_event;

\warn '--- 7d. loyalty_event is NOT protected, BY WRITTEN DECISION (0008) — must SUCCEED ---'
-- Migration 0008: "APPEND-ONLY BY INTENT, NOT BY REVOKE, AND THAT IS THE DECISION".
-- It is a derived record of something that already happened, it feeds one dashboard
-- panel, and nothing reconciles against it. This block is here so that the decision
-- is asserted rather than assumed, and so that anyone who "fixes" the asymmetry has
-- to change a test that states why it exists.
BEGIN;
TRUNCATE loyalty_event;
ROLLBACK;
SELECT 'loyalty_event is truncatable by decision, see migration 0008' AS deliberate_asymmetry;

\warn ''
\warn '=== 8. a member with money history cannot be hard-deleted ================='
\warn ''
-- Migration 0021 justifies soft deletion partly like this: "every table that
-- references member ... are append-only or restrict-on-delete; a DELETE FROM member
-- [would fail]". That is TRUE OF SEVEN of the eleven references and FALSE OF FOUR:
-- `session`, `wallet_token`, `phone_change_challenge` and `member_consent_event` are
-- ON DELETE CASCADE. A member with no financial history — a signup who never topped
-- up — therefore deletes cleanly today, taking her consent trail with her.
--
-- The DESIGN decision is still right, for 0021's other and better reason: two
-- retention periods over one customer means deletion is an erasure of personal data
-- that leaves the money record standing. Only the supporting claim was overstated.
--
-- So what is asserted here is the half that is real and load-bearing: once a
-- customer has money history, the 7-year record cannot be removed by deleting her.
\warn '--- 8a. a member WITH a transaction cannot be deleted (RESTRICT) ---'
BEGIN;
INSERT INTO member (id, salon_id, name, phone, password_hash, balance_fils, tier, policy_version)
VALUES ('MB-MONEYED', 'SL-VERIFY', 'Has History', '+96599100011', '$argon2id$fake', 0, 'bronze', 3);
INSERT INTO transaction (id, member_id, salon_id, branch_id, kind, amount_fils, status, settled_at)
VALUES ('TX-RESTRICT', 'MB-MONEYED', 'SL-VERIFY', 'BR-VERIFY', 'charge', -1000, 'settled', now());
DELETE FROM member WHERE id = 'MB-MONEYED';
ROLLBACK;

\warn '--- 8b. and one with NO history DOES delete — the overstated half, shown honestly ---'
BEGIN;
INSERT INTO member (id, salon_id, name, phone, password_hash, balance_fils, tier, policy_version)
VALUES ('MB-CLEAN', 'SL-VERIFY', 'No History', '+96599100012', '$argon2id$fake', 0, 'bronze', 3);
DELETE FROM member WHERE id = 'MB-CLEAN';
SELECT 'a member with no money history deletes; 0021 rests on its OTHER argument' AS honest_note;
ROLLBACK;

\warn ''
\warn '=== 9. a settled top-up cannot leave its terminal state ==================='
\warn ''
-- Migration 0004: "top-up % is terminal (%): it cannot become %". The terminal
-- states are succeeded, failed and cancelled. A succeeded top-up that could be
-- moved back to pending is a top-up that can be credited twice, so this is a money
-- invariant and not a tidiness one.
--
-- SAVEPOINTS, because a failed statement aborts the enclosing transaction and the
-- fixture has to survive three separate refusals. Each case rolls back to its own
-- savepoint so the next one runs against the same intent.
--
-- Two more invariants surfaced while building this fixture, and both are worth
-- naming: `topup_intent_succeeded_has_settled_at` and
-- `topup_intent_succeeded_has_transaction` are written as EQUIVALENCES
-- (`status = 'succeeded'` IS `settled_at IS NOT NULL`), so they bite in both
-- directions — a succeeded intent with no moment or no transaction is refused, and
-- so is a pending one that claims either. A credit with no transaction behind it is
-- money that appeared from nowhere.
BEGIN;
INSERT INTO transaction (id, member_id, salon_id, branch_id, kind, amount_fils, status, settled_at)
VALUES ('TX-TOPUP-T', 'MB-VERIFY', 'SL-VERIFY', 'BR-VERIFY', 'topup', 10000, 'settled', now());
INSERT INTO topup_intent (id, member_id, salon_id, branch_id, amount_fils, bonus_fils,
                          credit_fils, fee_fils, method, provider, status, reference,
                          settled_at, transaction_id)
VALUES ('TI-TERMINAL', 'MB-VERIFY', 'SL-VERIFY', 'BR-VERIFY', 10000, 0, 10000, 150,
        'knet', 'sandbox', 'succeeded', 'AVO-VERIFY-TERMINAL', now(), 'TX-TOPUP-T');

\warn '--- 9a. succeeded -> pending is refused (it could be credited twice) ---'
SAVEPOINT a; UPDATE topup_intent SET status = 'pending' WHERE id = 'TI-TERMINAL'; ROLLBACK TO a;

\warn '--- 9b. succeeded -> failed is refused ---'
SAVEPOINT b; UPDATE topup_intent SET status = 'failed' WHERE id = 'TI-TERMINAL'; ROLLBACK TO b;

\warn '--- 9c. a succeeded intent with no settled_at is refused outright ---'
SAVEPOINT c;
INSERT INTO topup_intent (id, member_id, salon_id, branch_id, amount_fils, bonus_fils,
                          credit_fils, fee_fils, method, provider, status, reference)
VALUES ('TI-NOSETTLE', 'MB-VERIFY', 'SL-VERIFY', 'BR-VERIFY', 10000, 0, 10000, 150,
        'knet', 'sandbox', 'succeeded', 'AVO-VERIFY-NOSETTLE');
ROLLBACK TO c;

\warn '--- 9d. and a NON-terminal transition must SUCCEED (created -> redirected) ---'
-- The deliberate limit: the trigger polices terminal states, not all movement. A
-- top-up that could never advance would be a top-up nobody could pay.
SAVEPOINT d;
INSERT INTO topup_intent (id, member_id, salon_id, branch_id, amount_fils, bonus_fils,
                          credit_fils, fee_fils, method, provider, status, reference)
VALUES ('TI-MOVING', 'MB-VERIFY', 'SL-VERIFY', 'BR-VERIFY', 10000, 0, 10000, 150,
        'knet', 'sandbox', 'created', 'AVO-VERIFY-MOVING');
UPDATE topup_intent SET status = 'redirected' WHERE id = 'TI-MOVING';
SELECT id, status AS advanced_normally FROM topup_intent WHERE id = 'TI-MOVING';
ROLLBACK TO d;
ROLLBACK;

\warn ''
\warn '=== 10. one artist cannot be double-booked ================================'
\warn ''
-- `booking_artist_slot_no_overlap` is a GiST exclusion constraint, and it is what
-- makes "two customers, one slot, one winner" a database fact rather than a race the
-- application hopes to win. Scoped to live statuses, which is the deliberate limit
-- asserted in 10c.
BEGIN;
INSERT INTO artist (id, salon_id, name) VALUES ('AR-VERIFY', 'SL-VERIFY', 'Rana');
INSERT INTO service (id, salon_id, name, price_fils) VALUES ('SV-VERIFY', 'SL-VERIFY', 'Blow-dry', 8000);
INSERT INTO transaction (id, member_id, salon_id, branch_id, kind, amount_fils, status, settled_at)
VALUES ('TX-HOLD-A', 'MB-VERIFY', 'SL-VERIFY', 'BR-VERIFY', 'deposit_hold', -5000, 'settled', now());
INSERT INTO booking (id, salon_id, member_id, artist_id, branch_id, service_id, starts_at, ends_at,
                     duration_min, deposit_fils, status, source, hold_transaction_id,
                     no_show_return_due_at)
VALUES ('BK-V1', 'SL-VERIFY', 'MB-VERIFY', 'AR-VERIFY', 'BR-VERIFY', 'SV-VERIFY',
        '2030-01-01 10:00+00', '2030-01-01 10:30+00', 30, 5000, 'deposit_held', 'app',
        'TX-HOLD-A', '2030-01-01 11:30+00');

\warn '--- 10a. an overlapping booking for the SAME artist is refused ---'
INSERT INTO transaction (id, member_id, salon_id, branch_id, kind, amount_fils, status, settled_at)
VALUES ('TX-HOLD-B', 'MB-VERIFY', 'SL-VERIFY', 'BR-VERIFY', 'deposit_hold', -5000, 'settled', now());
INSERT INTO booking (id, salon_id, member_id, artist_id, branch_id, service_id, starts_at, ends_at,
                     duration_min, deposit_fils, status, source, hold_transaction_id,
                     no_show_return_due_at)
VALUES ('BK-V2', 'SL-VERIFY', 'MB-VERIFY', 'AR-VERIFY', 'BR-VERIFY', 'SV-VERIFY',
        '2030-01-01 10:15+00', '2030-01-01 10:45+00', 30, 5000, 'deposit_held', 'app',
        'TX-HOLD-B', '2030-01-01 11:45+00');
ROLLBACK;
