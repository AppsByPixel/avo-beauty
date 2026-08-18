-- Proof, not documentation — and now proof a MACHINE can read.
--
--   pnpm --dir=/abs/path/to/api run db:verify        # against `avo`
--   AVO_VERIFY_DB=avo_lane_a pnpm --dir=/abs/path/to/api run db:verify
--
-- The path is ABSOLUTE deliberately: `--dir api` resolves from cwd, which is the same
-- failure as `--filter` and can point at another worktree's package. LANES.md.
--
-- Exits 0 when every invariant holds and NON-ZERO when any of them does not, so
-- CI can gate on it.
--
-- ===========================================================================
-- WHY THIS FILE WAS REWRITTEN — IT WAS THE FOURTH INSTANCE OF ITS OWN FINDING
-- ===========================================================================
-- The previous version ran raw statements under `ON_ERROR_STOP=0` and printed the
-- transcript. Two defects, both of which it existed to catch in other people's
-- code:
--
--   IT COULD NOT FAIL. psql continued past every error and exited 0. A violated
--   invariant was signalled only by the ABSENCE of an expected error, which needs
--   a human to read 259 lines and already know which lines should have failed.
--   Ten sections of assertions were exactly what the prose invariants had been:
--   true, unread, unenforced. Proved against `avo_ci`, which predates migrations
--   0023 and 0024: three TRUNCATEs that should have been refused printed
--   `TRUNCATE TABLE`, and the script exited 0.
--
--   IT WAS DESTRUCTIVE. The probes used `BEGIN … COMMIT`, so on a database missing
--   the triggers it was checking for, it really truncated `ledger_entry` and
--   committed. `avo_ci` was left with an empty money ledger by a script whose
--   purpose is to prove that cannot happen. And section 5 printed
--   `RECONCILED | 2` BEFORE section 7 wiped the table, so the verdict a reader
--   remembers came from before the damage.
--
-- ===========================================================================
-- HOW IT WORKS NOW
-- ===========================================================================
-- Every probe goes through `pg_temp.probe(...)`, which runs the statement inside a
-- plpgsql `BEGIN … EXCEPTION` block. That block is an implicit SUBTRANSACTION, so:
--
--   * a statement that is REFUSED is rolled back by the exception, and the error
--     is captured rather than printed loose;
--   * a statement that is ALLOWED is rolled back too, because the probe raises a
--     sentinel (`ZZZ01`) immediately afterwards purely to force that rollback.
--
-- So nothing a probe does survives it, whichever way the invariant went. The whole
-- run is additionally wrapped in one transaction that ends in ROLLBACK, so even
-- the fixtures do not persist. THIS SCRIPT NO LONGER WRITES ANYTHING.
--
-- Each probe records PASS/FAIL into a temp table with the real error text, the
-- report prints per-probe, and the VERDICT PRINTS LAST — after the rollback, so a
-- success line cannot appear above work that would have contradicted it.
--
-- EXPECTED FAILURE IS NOT ENOUGH: a probe may also declare `p_match`, a substring
-- the refusal must contain. Without it, a statement that failed because of a typo'd
-- column name counts as the invariant holding — which happened to me three times
-- while writing sections 9 and 10, and is the same "narrower than the claim"
-- mistake this file keeps finding elsewhere.
--
-- MUST-SUCCEED PROBES are declared `allowed` and are the reason the next person
-- cannot "fix" a deliberate limit: 3f, 6d (the erasure cascade), 7d
-- (`loyalty_event` is truncatable BY DECISION, migration 0008), 8b (a member with
-- no money history does delete) and 9d (a non-terminal top-up advances).
--
-- The deferred `ledger_entry_balanced` trigger normally fires at COMMIT. Since
-- nothing here commits, probe 3e forces it with `SET CONSTRAINTS ALL IMMEDIATE` —
-- the same constraint, evaluated earlier.
-- ===========================================================================

\set ON_ERROR_STOP on
\pset pager off

-- The result table is created OUTSIDE the transaction so it survives the rollback
-- that discards everything else. Its ROWS are still written inside, so the report
-- is read before the rollback and the verdict is carried out in psql variables.
DROP TABLE IF EXISTS _verify_result;
CREATE TEMP TABLE _verify_result (
  seq         serial primary key,
  section     text    not null,
  label       text    not null,
  expectation text    not null,
  passed      boolean not null,
  detail      text    not null
);

BEGIN;

SET client_min_messages TO WARNING;

-- --------------------------------------------------------------- harness ------

CREATE FUNCTION pg_temp.probe(
  p_section text,
  p_label   text,
  p_expect  text,               -- 'refused' (must fail) or 'allowed' (must succeed)
  p_stmt    text,
  p_match   text DEFAULT NULL,  -- substring the refusal must contain
  p_role    text DEFAULT NULL   -- run as this role
) RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
  v_passed boolean;
  v_detail text;
BEGIN
  BEGIN
    IF p_role IS NOT NULL THEN
      EXECUTE format('SET LOCAL ROLE %I', p_role);
    END IF;

    EXECUTE p_stmt;

    -- Reached only when the statement was ALLOWED. The sentinel exists to roll the
    -- statement back: without it, a probe that discovers a missing guarantee would
    -- COMMIT the very damage it was checking for. That is what emptied `avo_ci`.
    RAISE EXCEPTION 'AVO_PROBE_ALLOWED' USING ERRCODE = 'ZZZ01';

  EXCEPTION
    WHEN sqlstate 'ZZZ01' THEN
      v_passed := (p_expect = 'allowed');
      v_detail := CASE WHEN v_passed
                       THEN 'allowed, as required'
                       ELSE 'ALLOWED — the guarantee did not hold' END;

    WHEN others THEN
      IF p_expect = 'refused' THEN
        IF p_match IS NOT NULL AND position(lower(p_match) in lower(SQLERRM)) = 0 THEN
          v_passed := false;
          v_detail := format('refused for the WRONG reason (wanted "%s"): %s', p_match, SQLERRM);
        ELSE
          v_passed := true;
          v_detail := SQLERRM;
        END IF;
      ELSE
        v_passed := false;
        v_detail := format('REFUSED but had to be allowed: %s', SQLERRM);
      END IF;
  END;

  RESET ROLE;
  INSERT INTO _verify_result (section, label, expectation, passed, detail)
  VALUES (p_section, p_label, p_expect, v_passed, v_detail);
END
$fn$;

/** A property with no statement behind it: schema shape, a reconciliation. */
CREATE FUNCTION pg_temp.assert(
  p_section text, p_label text, p_holds boolean, p_detail text
) RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  INSERT INTO _verify_result (section, label, expectation, passed, detail)
  VALUES (p_section, p_label, 'holds', coalesce(p_holds, false),
          coalesce(p_detail, '(no detail)'));
END
$fn$;

-- ---------------------------------------------------------------- fixtures ----
-- Rolled back with everything else. `ON CONFLICT DO NOTHING` because earlier
-- versions of this script committed these rows, so some databases still have them.

INSERT INTO salon (id, name, brand_color, loyalty_mode, tiers, deposit_fils, business_hours)
VALUES ('SL-VERIFY', 'Amara', '#B7A99A', 'tiers',
        '[{"name":"bronze","minVisits":0,"bonusPercent":0}]'::jsonb, 5000,
        '{"morning":["10:00","13:00"],"evening":["16:00","22:00"]}'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO branch (id, salon_id, name) VALUES ('BR-VERIFY', 'SL-VERIFY', 'Salmiya')
ON CONFLICT (id) DO NOTHING;

INSERT INTO member (id, salon_id, name, phone, password_hash, balance_fils, tier, policy_version)
VALUES ('MB-VERIFY', 'SL-VERIFY', 'Noura S.', '+96599124408', '$argon2id$fake', 18000, 'bronze', 3)
ON CONFLICT (id) DO NOTHING;

INSERT INTO artist (id, salon_id, name) VALUES ('AR-VERIFY', 'SL-VERIFY', 'Rana')
ON CONFLICT (id) DO NOTHING;

INSERT INTO service (id, salon_id, name, price_fils) VALUES ('SV-VERIFY', 'SL-VERIFY', 'Blow-dry', 8000)
ON CONFLICT (id) DO NOTHING;

-- The owner console's principal and one campaign, for section 12. Rolled back with
-- everything else.
INSERT INTO platform_admin (id, name, handle, password_hash, role, owner,
                            perm_analytics, perm_activity, perm_salons, perm_accounts,
                            perm_admins, perm_controls, perm_approvals, perm_policies, perm_audit)
VALUES ('PLT-VERIFY', 'Yousef', 'yousef.verify', '$argon2id$fake', 'owner', true,
        true, true, true, true, true, true, true, true, true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO campaign (id, salon_id, title, body, channel, audience, reward, reach,
                      send_when, status, submitted_by)
VALUES ('CMP-VERIFY', 'SL-VERIFY', 'Thursday late night', 'Every visit counts double.',
        'push', 'all', 'x2visit', 12, 'now', 'pending', 'Rana Al-Sabah')
ON CONFLICT (id) DO NOTHING;

-- An audit row for section 1 to try to tamper with. Written by the app role, which
-- is the only thing it is allowed to do to this table.
SET LOCAL ROLE avo_app;
INSERT INTO audit_log (salon_id, actor_kind, actor_id, actor_name, actor_role,
                       kind, action, detail, source, amount_fils)
VALUES ('SL-VERIFY', 'staff', 'ST-VERIFY', 'Rana Al-Sabah', 'Manager',
        'money', 'Charge taken', '6.000 KD · Blow-dry · Noura S.', 'scanner', -6000);
RESET ROLE;

-- =========================================================================
-- 1. audit_log is append-only
-- =========================================================================
SELECT pg_temp.probe('1', 'app role may INSERT', 'allowed',
  $probe$INSERT INTO audit_log (salon_id, actor_kind, actor_id, actor_name, actor_role, kind, action, source, amount_fils)
    VALUES ('SL-VERIFY','staff','ST-VERIFY','Rana','Manager','money','Charge taken','scanner',-6000)$probe$,
  NULL, 'avo_app');

-- Found by the harness refusing my own sloppy fixture, which is the instrument
-- working: a `money` audit row with no figure on it is a money event nobody can
-- read. Worth asserting rather than only tripping over.
SELECT pg_temp.probe('1', 'a money audit row with no amount refused', 'refused',
  $probe$INSERT INTO audit_log (salon_id, actor_kind, actor_id, actor_name, actor_role, kind, action, source)
    VALUES ('SL-VERIFY','staff','ST-VERIFY','Rana','Manager','money','Charge taken','scanner')$probe$,
  'audit_log_money_has_amount', 'avo_app');

SELECT pg_temp.probe('1', 'a non-system actor with no id refused', 'refused',
  $probe$INSERT INTO audit_log (salon_id, actor_kind, actor_name, actor_role, kind, action, source)
    VALUES ('SL-VERIFY','staff','Rana','Manager','access','Customer looked up','scanner')$probe$,
  'audit_log_actor_id_required', 'avo_app');

SELECT pg_temp.probe('1', 'app role UPDATE refused', 'refused',
  $probe$UPDATE audit_log SET detail = 'nothing to see here' WHERE actor_id = 'ST-VERIFY'$probe$,
  'permission denied', 'avo_app');

SELECT pg_temp.probe('1', 'app role DELETE refused', 'refused',
  $probe$DELETE FROM audit_log WHERE actor_id = 'ST-VERIFY'$probe$,
  'permission denied', 'avo_app');

SELECT pg_temp.probe('1', 'app role TRUNCATE refused', 'refused',
  $probe$TRUNCATE audit_log$probe$, 'permission denied', 'avo_app');

SELECT pg_temp.probe('1', 'OWNER UPDATE refused (the trigger)', 'refused',
  $probe$UPDATE audit_log SET detail = 'owner tried' WHERE actor_id = 'ST-VERIFY'$probe$, 'append-only');

SELECT pg_temp.probe('1', 'OWNER DELETE refused (the trigger)', 'refused',
  $probe$DELETE FROM audit_log WHERE actor_id = 'ST-VERIFY'$probe$, 'append-only');

-- =========================================================================
-- 2. a negative balance is impossible AT THE DATABASE LEVEL
-- =========================================================================
SELECT pg_temp.probe('2', 'spending past the balance refused', 'refused',
  $probe$UPDATE member SET balance_fils = balance_fils - 20000 WHERE id = 'MB-VERIFY'$probe$,
  'member_balance_non_negative', 'avo_app');

SELECT pg_temp.probe('2', 'writing a negative balance refused', 'refused',
  $probe$UPDATE member SET balance_fils = -1 WHERE id = 'MB-VERIFY'$probe$,
  'member_balance_non_negative', 'avo_app');

SELECT pg_temp.probe('2', 'inserting an overdrawn member refused', 'refused',
  $probe$INSERT INTO member (id, salon_id, name, phone, password_hash, balance_fils, tier, policy_version)
    VALUES ('MB-NEG','SL-VERIFY','Overdrawn','+96599124409','$argon2id$fake',-1,'bronze',3)$probe$,
  'member_balance_non_negative', 'avo_app');

-- =========================================================================
-- 3. supporting guarantees
-- =========================================================================
SELECT pg_temp.probe('3', 'a long-lived wallet token refused', 'refused',
  $probe$INSERT INTO wallet_token (member_id, token_hash, expires_at)
    VALUES ('MB-VERIFY','hash-long-lived', now() + interval '1 day')$probe$,
  'wallet_token_expiry_is_short', 'avo_app');

SELECT pg_temp.probe('3', 'the same idempotency key twice refused', 'refused',
  $probe$DO $i$ BEGIN
      INSERT INTO idempotency_key (scope,key,endpoint,request_hash)
      VALUES ('member:MB-VERIFY','idem-1','POST /charges','sha256:aaa');
      INSERT INTO idempotency_key (scope,key,endpoint,request_hash)
      VALUES ('member:MB-VERIFY','idem-1','POST /charges','sha256:bbb');
    END $i$ $probe$,
  'idempotency_key_scope_endpoint_key_uq', 'avo_app');

SELECT pg_temp.probe('3', 'void without charges refused', 'refused',
  $probe$INSERT INTO staff_user (id,salon_id,name,handle,role,perm_void,perm_charges)
    VALUES ('ST-BAD','SL-VERIFY','Hessa M.','hessa','frontdesk',true,false)$probe$,
  'staff_user_void_implies_charges', 'avo_app');

SELECT pg_temp.probe('3', 'a charge that credits the customer refused', 'refused',
  $probe$INSERT INTO transaction (id,member_id,salon_id,branch_id,kind,amount_fils)
    VALUES ('TX-BAD','MB-VERIFY','SL-VERIFY','BR-VERIFY','charge',6000)$probe$,
  'transaction_amount_sign_matches_kind', 'avo_app');

-- 3e / 3f: the double-entry trigger, forced immediate because nothing commits.
SELECT pg_temp.probe('3', 'an unbalanced ledger pair refused', 'refused',
  $probe$DO $i$ BEGIN
      INSERT INTO transaction (id,member_id,salon_id,branch_id,kind,amount_fils,status,settled_at)
      VALUES ('TX-LEDGER','MB-VERIFY','SL-VERIFY','BR-VERIFY','charge',-6000,'settled',now());
      INSERT INTO ledger_entry (transaction_id,salon_id,member_id,account,direction,amount_fils,balance_after_fils)
      VALUES ('TX-LEDGER','SL-VERIFY','MB-VERIFY','member_wallet','debit',6000,12000);
      INSERT INTO ledger_entry (transaction_id,salon_id,account,direction,amount_fils)
      VALUES ('TX-LEDGER','SL-VERIFY','salon_revenue','credit',5000);
      SET CONSTRAINTS ALL IMMEDIATE;
    END $i$ $probe$,
  'do not balance');

SELECT pg_temp.probe('3', 'the BALANCED pair is accepted', 'allowed',
  $probe$DO $i$ BEGIN
      INSERT INTO transaction (id,member_id,salon_id,branch_id,kind,amount_fils,status,settled_at)
      VALUES ('TX-LEDGER-OK','MB-VERIFY','SL-VERIFY','BR-VERIFY','charge',-6000,'settled',now());
      INSERT INTO ledger_entry (transaction_id,salon_id,member_id,account,direction,amount_fils,balance_after_fils)
      VALUES ('TX-LEDGER-OK','SL-VERIFY','MB-VERIFY','member_wallet','debit',6000,12000);
      INSERT INTO ledger_entry (transaction_id,salon_id,account,direction,amount_fils)
      VALUES ('TX-LEDGER-OK','SL-VERIFY','salon_revenue','credit',6000);
      SET CONSTRAINTS ALL IMMEDIATE;
    END $i$ $probe$);

SELECT pg_temp.probe('3', 'a committed ledger entry cannot be edited', 'refused',
  $probe$UPDATE ledger_entry SET amount_fils = 1 WHERE account = 'member_wallet'$probe$, 'append-only');

-- A blank Arabic name paints an empty heading, because `'' ?? name` is `''`.
-- Absent has to be NULL and nothing else — so the blank is refused and the NULL
-- must be accepted.
SELECT pg_temp.probe('3', 'a whitespace Arabic salon name refused', 'refused',
  $probe$UPDATE salon SET name_ar = '   ' WHERE id = 'SL-VERIFY'$probe$, 'name_ar_not_blank', 'avo_app');

SELECT pg_temp.probe('3', 'a blank Arabic stamp reward refused', 'refused',
  $probe$UPDATE salon SET stamp_reward_ar = '' WHERE id = 'SL-VERIFY'$probe$, 'not_blank', 'avo_app');

SELECT pg_temp.probe('3', 'a blank Arabic branch name refused', 'refused',
  $probe$UPDATE branch SET name_ar = '' WHERE id = 'BR-VERIFY'$probe$, 'name_ar_not_blank', 'avo_app');

SELECT pg_temp.probe('3', 'a NULL Arabic name IS accepted', 'allowed',
  $probe$UPDATE salon SET name_ar = NULL WHERE id = 'SL-VERIFY'$probe$, NULL, 'avo_app');

-- A row-count property rather than an error: consuming twice must affect 0 rows
-- the second time, which is the 410 the scanner shows.
SELECT pg_temp.probe('3', 'a wallet token is single use (1 row then 0)', 'allowed',
  $probe$DO $i$
    DECLARE n int;
    BEGIN
      INSERT INTO wallet_token (member_id, token_hash) VALUES ('MB-VERIFY','hash-single-use');
      UPDATE wallet_token SET consumed_at = now()
       WHERE token_hash='hash-single-use' AND consumed_at IS NULL AND expires_at > now();
      GET DIAGNOSTICS n = ROW_COUNT;
      IF n <> 1 THEN RAISE EXCEPTION 'first consume affected % rows, expected 1', n; END IF;
      UPDATE wallet_token SET consumed_at = now()
       WHERE token_hash='hash-single-use' AND consumed_at IS NULL AND expires_at > now();
      GET DIAGNOSTICS n = ROW_COUNT;
      IF n <> 0 THEN RAISE EXCEPTION 'second consume affected % rows, expected 0', n; END IF;
    END $i$ $probe$,
  NULL, 'avo_app');

-- =========================================================================
-- 4. money is integer fils — non-negotiable #1
-- =========================================================================
-- This section used to PRINT a table of `%_fils` columns and assert nothing: a
-- `double precision` would have appeared in alphabetical order between two correct
-- ones. The most load-bearing rule in the project was the least checked thing in
-- the file that exists to check rules.
SELECT pg_temp.assert('4', 'every %_fils column is bigint',
  NOT EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND column_name LIKE '%\_fils' AND data_type <> 'bigint'),
  coalesce((SELECT string_agg(format('%s.%s is %s', table_name, column_name, data_type), ', ')
              FROM information_schema.columns
             WHERE table_schema='public' AND column_name LIKE '%\_fils' AND data_type <> 'bigint'),
           (SELECT count(*)::text || ' fils columns, all bigint' FROM information_schema.columns
             WHERE table_schema='public' AND column_name LIKE '%\_fils')));

-- The `%_fils` rule only catches money that was NAMED correctly. A `legacy_price
-- real` satisfies every check above and still puts a float one join away from a
-- total, and the naming convention is structurally incapable of noticing. `numeric`
-- is refused with the floats: #1 is that money is an integer COUNT of fils, and a
-- fractional fil has no meaning and no display format.
SELECT pg_temp.assert('4', 'no float-family column exists anywhere',
  NOT EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='public'
                 AND data_type IN ('double precision','real','numeric','money')),
  coalesce((SELECT string_agg(format('%s.%s is %s', table_name, column_name, data_type), ', ')
              FROM information_schema.columns
             WHERE table_schema='public'
               AND data_type IN ('double precision','real','numeric','money')),
           'no double precision, real, numeric or money column in the schema'));

-- =========================================================================
-- 5. every wallet reconciles to its ledger
-- =========================================================================
-- `member.balance_fils` is a cached aggregate and `schema/ledger.ts` states the
-- property that makes it defensible. Three comments claimed it and nothing checked
-- it; it was false from the seed's first line until the opening balances got
-- entries of their own.
--
-- LEFT JOIN, not INNER: a member with no wallet entries must show as a drift equal
-- to her whole balance rather than vanishing — which is exactly the shape the
-- missing opening balances had. `SL-VERIFY` is excluded because section 3 writes
-- wallet entries for `MB-VERIFY` without maintaining her balance, on purpose.
SELECT pg_temp.assert('5', 'member.balance_fils = sum(member_wallet entries)',
  NOT EXISTS (
    SELECT 1 FROM (
      SELECT m.id, m.balance_fils - coalesce(sum(CASE le.direction WHEN 'credit' THEN le.amount_fils
                                                                   ELSE -le.amount_fils END),0) AS diff
        FROM member m
        LEFT JOIN ledger_entry le ON le.member_id = m.id AND le.account = 'member_wallet'
       WHERE m.salon_id <> 'SL-VERIFY'
       GROUP BY m.id, m.balance_fils) d
     WHERE diff <> 0),
  coalesce((SELECT string_agg(format('%s off by %s fils', id, diff), ', ' ORDER BY id) FROM (
              SELECT m.id, m.balance_fils - coalesce(sum(CASE le.direction WHEN 'credit' THEN le.amount_fils
                                                                           ELSE -le.amount_fils END),0) AS diff
                FROM member m
                LEFT JOIN ledger_entry le ON le.member_id = m.id AND le.account = 'member_wallet'
               WHERE m.salon_id <> 'SL-VERIFY'
               GROUP BY m.id, m.balance_fils) d WHERE diff <> 0),
           (SELECT count(*)::text || ' member(s) reconcile' FROM member WHERE salon_id <> 'SL-VERIFY')));

-- =========================================================================
-- 6. a consent record cannot be rewritten
-- =========================================================================
-- Non-negotiable #8 needs marketing consent readable and TRUTHFUL at send time.
-- Migration 0020 revoked UPDATE/DELETE from the app role and claimed parity with
-- `audit_log`; 0023 added the triggers that stop the owner too.
SELECT pg_temp.probe('6', 'a withdrawal cannot be flipped to a grant', 'refused',
  $probe$DO $i$ BEGIN
      INSERT INTO member_consent_event (member_id,salon_id,kind,granted,source,policy_version)
      VALUES ('MB-VERIFY','SL-VERIFY','marketing_offers',false,'wallet_account',3);
      UPDATE member_consent_event SET granted = true WHERE member_id = 'MB-VERIFY';
    END $i$ $probe$,
  'append-only');

SELECT pg_temp.probe('6', 'a consent event cannot be backdated', 'refused',
  $probe$DO $i$ BEGIN
      INSERT INTO member_consent_event (member_id,salon_id,kind,granted,source,policy_version)
      VALUES ('MB-VERIFY','SL-VERIFY','marketing_offers',true,'signup',3);
      UPDATE member_consent_event SET created_at = now() - interval '1 year' WHERE member_id = 'MB-VERIFY';
    END $i$ $probe$,
  'append-only');

SELECT pg_temp.probe('6', 'consent cannot be moved to another policy version', 'refused',
  $probe$DO $i$ BEGIN
      INSERT INTO member_consent_event (member_id,salon_id,kind,granted,source,policy_version)
      VALUES ('MB-VERIFY','SL-VERIFY','marketing_offers',true,'signup',3);
      UPDATE member_consent_event SET policy_version = 99 WHERE member_id = 'MB-VERIFY';
    END $i$ $probe$,
  'append-only');

SELECT pg_temp.probe('6', 'consent cannot be emptied wholesale', 'refused',
  $probe$TRUNCATE member_consent_event$probe$, 'append-only');

-- 6d MUST SUCCEED. `member_consent_event.member_id` is ON DELETE CASCADE and the
-- 30-day erasure the privacy policy promises ends in a DELETE of the member. A
-- DELETE trigger here would make that erasure impossible — verified with the exact
-- trigger `audit_log` uses. This is why 0023's parity deliberately stops at UPDATE
-- and TRUNCATE, and this probe is what stops someone "completing" it.
SELECT pg_temp.probe('6', 'the ERASURE CASCADE still works (no DELETE trigger)', 'allowed',
  $probe$DO $i$
    DECLARE n int;
    BEGIN
      INSERT INTO member (id,salon_id,name,phone,password_hash,balance_fils,tier,policy_version)
      VALUES ('MB-ERASE','SL-VERIFY','Erasure Probe','+96599100009','$argon2id$fake',0,'bronze',3);
      INSERT INTO member_consent_event (member_id,salon_id,kind,granted,source,policy_version)
      VALUES ('MB-ERASE','SL-VERIFY','marketing_offers',true,'signup',3);
      DELETE FROM member WHERE id = 'MB-ERASE';
      SELECT count(*) INTO n FROM member_consent_event WHERE member_id = 'MB-ERASE';
      IF n <> 0 THEN RAISE EXCEPTION 'cascade left % consent row(s)', n; END IF;
    END $i$ $probe$);

-- =========================================================================
-- 7. TRUNCATE cannot erase the money ledger
-- =========================================================================
-- `schema/ledger.ts` claimed immutability "for the same reason" as `audit_log`, and
-- 0004 said the same of `gateway_event`. Both had no_update and no_delete; TRUNCATE
-- is neither, and a FOR EACH ROW trigger never fires for it. One statement emptied
-- the table every wallet balance is derived from. Migration 0024 closes it.
SELECT pg_temp.probe('7', 'the wallet ledger cannot be truncated', 'refused',
  $probe$TRUNCATE ledger_entry$probe$, 'append-only');

SELECT pg_temp.probe('7', 'the gateway event log cannot be truncated', 'refused',
  $probe$TRUNCATE gateway_event$probe$, 'append-only');

SELECT pg_temp.probe('7', 'audit_log cannot be truncated', 'refused',
  $probe$TRUNCATE audit_log$probe$, 'append-only');

-- 7d MUST SUCCEED. Migration 0008: "APPEND-ONLY BY INTENT, NOT BY REVOKE, AND THAT
-- IS THE DECISION" — a derived record feeding one dashboard panel, with nothing
-- reconciling against it. Asserted so the asymmetry is a decision someone has to
-- argue with rather than an inconsistency someone tidies.
SELECT pg_temp.probe('7', 'loyalty_event IS truncatable, by decision (0008)', 'allowed',
  $probe$TRUNCATE loyalty_event$probe$);

-- =========================================================================
-- 8. a member with money history cannot be hard-deleted
-- =========================================================================
-- Migration 0021 justifies soft deletion partly with "every table that references
-- member ... are append-only or restrict-on-delete; a DELETE FROM member [would
-- fail]". Seven of eleven references are RESTRICT; four are CASCADE. So the claim is
-- true of a customer with history and false of a fresh signup. The design decision
-- stands on 0021's OTHER argument — two retention periods over one customer — and
-- what is asserted here is the half that is real.
SELECT pg_temp.probe('8', 'a member WITH a transaction cannot be deleted', 'refused',
  $probe$DO $i$ BEGIN
      INSERT INTO member (id,salon_id,name,phone,password_hash,balance_fils,tier,policy_version)
      VALUES ('MB-MONEYED','SL-VERIFY','Has History','+96599100011','$argon2id$fake',0,'bronze',3);
      INSERT INTO transaction (id,member_id,salon_id,branch_id,kind,amount_fils,status,settled_at)
      VALUES ('TX-RESTRICT','MB-MONEYED','SL-VERIFY','BR-VERIFY','charge',-1000,'settled',now());
      DELETE FROM member WHERE id = 'MB-MONEYED';
    END $i$ $probe$,
  'violates foreign key constraint');

-- 8b MUST SUCCEED — the overstated half, stated honestly rather than believed.
SELECT pg_temp.probe('8', 'a member with NO history does delete (0021 overstated)', 'allowed',
  $probe$DO $i$ BEGIN
      INSERT INTO member (id,salon_id,name,phone,password_hash,balance_fils,tier,policy_version)
      VALUES ('MB-CLEAN','SL-VERIFY','No History','+96599100012','$argon2id$fake',0,'bronze',3);
      DELETE FROM member WHERE id = 'MB-CLEAN';
    END $i$ $probe$);

-- =========================================================================
-- 9. a settled top-up cannot leave its terminal state
-- =========================================================================
-- Migration 0004: "top-up % is terminal (%): it cannot become %". A succeeded
-- top-up that could return to pending is one that can be credited twice.
--
-- `topup_intent_succeeded_has_settled_at` and `..._has_transaction` are written as
-- EQUIVALENCES, so they bite both ways: a succeeded intent with no moment or no
-- transaction is refused, and so is a pending one claiming either.
SELECT pg_temp.probe('9', 'succeeded -> pending refused', 'refused',
  $probe$DO $i$ BEGIN
      INSERT INTO transaction (id,member_id,salon_id,branch_id,kind,amount_fils,status,settled_at)
      VALUES ('TX-TOPUP-T','MB-VERIFY','SL-VERIFY','BR-VERIFY','topup',10000,'settled',now());
      INSERT INTO topup_intent (id,member_id,salon_id,branch_id,amount_fils,bonus_fils,credit_fils,
                                fee_fils,method,provider,status,reference,settled_at,transaction_id)
      VALUES ('TI-TERMINAL','MB-VERIFY','SL-VERIFY','BR-VERIFY',10000,0,10000,150,'knet','sandbox',
              'succeeded','AVO-VERIFY-TERMINAL',now(),'TX-TOPUP-T');
      UPDATE topup_intent SET status = 'pending' WHERE id = 'TI-TERMINAL';
    END $i$ $probe$,
  'is terminal');

SELECT pg_temp.probe('9', 'succeeded -> failed refused', 'refused',
  $probe$DO $i$ BEGIN
      INSERT INTO transaction (id,member_id,salon_id,branch_id,kind,amount_fils,status,settled_at)
      VALUES ('TX-TOPUP-U','MB-VERIFY','SL-VERIFY','BR-VERIFY','topup',10000,'settled',now());
      INSERT INTO topup_intent (id,member_id,salon_id,branch_id,amount_fils,bonus_fils,credit_fils,
                                fee_fils,method,provider,status,reference,settled_at,transaction_id)
      VALUES ('TI-TERM2','MB-VERIFY','SL-VERIFY','BR-VERIFY',10000,0,10000,150,'knet','sandbox',
              'succeeded','AVO-VERIFY-TERM2',now(),'TX-TOPUP-U');
      UPDATE topup_intent SET status = 'failed' WHERE id = 'TI-TERM2';
    END $i$ $probe$,
  'is terminal');

SELECT pg_temp.probe('9', 'succeeded with no settled_at refused', 'refused',
  $probe$INSERT INTO topup_intent (id,member_id,salon_id,branch_id,amount_fils,bonus_fils,credit_fils,
                              fee_fils,method,provider,status,reference)
    VALUES ('TI-NOSETTLE','MB-VERIFY','SL-VERIFY','BR-VERIFY',10000,0,10000,150,'knet','sandbox',
            'succeeded','AVO-VERIFY-NOSETTLE')$probe$,
  'succeeded_has_settled_at');

-- 9d MUST SUCCEED: the trigger polices TERMINAL states, not all movement. A top-up
-- that could never advance is a top-up nobody could pay.
SELECT pg_temp.probe('9', 'a non-terminal transition still advances', 'allowed',
  $probe$DO $i$ BEGIN
      INSERT INTO topup_intent (id,member_id,salon_id,branch_id,amount_fils,bonus_fils,credit_fils,
                                fee_fils,method,provider,status,reference)
      VALUES ('TI-MOVING','MB-VERIFY','SL-VERIFY','BR-VERIFY',10000,0,10000,150,'knet','sandbox',
              'created','AVO-VERIFY-MOVING');
      UPDATE topup_intent SET status = 'redirected' WHERE id = 'TI-MOVING';
    END $i$ $probe$);

-- =========================================================================
-- 10. one artist cannot be double-booked
-- =========================================================================
-- A GiST exclusion constraint, which is what makes "two customers, one slot, one
-- winner" a database fact rather than a race the application hopes to win.
SELECT pg_temp.probe('10', 'an overlapping booking for one artist refused', 'refused',
  $probe$DO $i$ BEGIN
      INSERT INTO transaction (id,member_id,salon_id,branch_id,kind,amount_fils,status,settled_at)
      VALUES ('TX-HOLD-A','MB-VERIFY','SL-VERIFY','BR-VERIFY','deposit_hold',-5000,'settled',now());
      INSERT INTO booking (id,salon_id,member_id,artist_id,branch_id,service_id,starts_at,ends_at,
                           duration_min,deposit_fils,status,source,hold_transaction_id,no_show_return_due_at)
      VALUES ('BK-V1','SL-VERIFY','MB-VERIFY','AR-VERIFY','BR-VERIFY','SV-VERIFY',
              '2030-01-01 10:00+00','2030-01-01 10:30+00',30,5000,'deposit_held','app',
              'TX-HOLD-A','2030-01-01 11:30+00');
      INSERT INTO transaction (id,member_id,salon_id,branch_id,kind,amount_fils,status,settled_at)
      VALUES ('TX-HOLD-B','MB-VERIFY','SL-VERIFY','BR-VERIFY','deposit_hold',-5000,'settled',now());
      INSERT INTO booking (id,salon_id,member_id,artist_id,branch_id,service_id,starts_at,ends_at,
                           duration_min,deposit_fils,status,source,hold_transaction_id,no_show_return_due_at)
      VALUES ('BK-V2','SL-VERIFY','MB-VERIFY','AR-VERIFY','BR-VERIFY','SV-VERIFY',
              '2030-01-01 10:15+00','2030-01-01 10:45+00',30,5000,'deposit_held','app',
              'TX-HOLD-B','2030-01-01 11:45+00');
    END $i$ $probe$,
  'booking_artist_slot_no_overlap');

-- =========================================================================
-- 11. a shop order says what it sold, and cannot be re-itemised afterwards
-- =========================================================================
-- Migration 0027. A `shop` transaction IS the order and `shop_order_line` holds
-- what was in it. Two properties matter and neither is checkable anywhere else:
--
--   THE MULTIPLICATION. This is the only money path in the schema that
--   multiplies — `qty × unit_price_fils` — and non-negotiable #1 is a rule about
--   arithmetic as much as about column types. A handler that computed a line
--   total with a float, or dropped a quantity, must not commit.
--
--   THE LINES ARE EVIDENCE. UPDATE and DELETE are revoked from `avo_app` exactly
--   as they are on `ledger_entry`, so a settled purchase cannot be quietly
--   re-itemised by whatever gets compromised next. Note this is a GRANT and not a
--   trigger, so the owner can still edit — unlike `ledger_entry`. The asymmetry is
--   deliberate and 0027's header says why: order lines are reconstructible from a
--   receipt payload and a total, and the ledger is not reconstructible from
--   anything.
SELECT pg_temp.probe('11', 'a free product is refused', 'refused',
  $probe$INSERT INTO product (id, salon_id, name, price_fils)
    VALUES ('PR-VERIFY-FREE', 'SL-VERIFY', 'Sample sachet', 0)$probe$,
  'product_price_positive');

-- The sign CHECK on `transaction` claimed a `shop` row cannot be zero "because
-- service_price_positive refuses a free line" — but a shop line is priced from
-- `product`, so it named a constraint that did not govern the kind it explained.
-- Both halves are checked here so the CORRECTED claim is the one under test: zero
-- is refused by the sign CHECK, and a free product cannot exist to produce one.
SELECT pg_temp.probe('11', 'a shop transaction cannot be zero', 'refused',
  $probe$INSERT INTO transaction (id,member_id,salon_id,branch_id,kind,amount_fils,status,settled_at)
    VALUES ('TX-SHOP-ZERO','MB-VERIFY','SL-VERIFY','BR-VERIFY','shop',0,'settled',now())$probe$,
  'transaction_amount_sign_matches_kind');

-- A shop row that PAYS the customer. The mirror of the charge case in section 3.
SELECT pg_temp.probe('11', 'a shop transaction cannot credit the customer', 'refused',
  $probe$INSERT INTO transaction (id,member_id,salon_id,branch_id,kind,amount_fils,status,settled_at)
    VALUES ('TX-SHOP-POS','MB-VERIFY','SL-VERIFY','BR-VERIFY','shop',5000,'settled',now())$probe$,
  'transaction_amount_sign_matches_kind');

SELECT pg_temp.probe('11', 'a line total that is not qty x unit price is refused', 'refused',
  $probe$DO $i$ BEGIN
      INSERT INTO product (id, salon_id, name, price_fils)
      VALUES ('PR-VERIFY', 'SL-VERIFY', 'Argan hair oil 100ml', 8500);
      INSERT INTO transaction (id,member_id,salon_id,branch_id,kind,amount_fils,status,settled_at)
      VALUES ('TX-SHOP-BAD','MB-VERIFY','SL-VERIFY','BR-VERIFY','shop',-17000,'settled',now());
      -- 2 x 8500 is 17000. 16999 is what a float looks like after it has lost a fil.
      INSERT INTO shop_order_line (transaction_id,product_id,name,qty,unit_price_fils,line_total_fils)
      VALUES ('TX-SHOP-BAD','PR-VERIFY','Argan hair oil 100ml',2,8500,16999);
    END $i$ $probe$,
  'shop_order_line_total_matches_qty');

SELECT pg_temp.probe('11', 'a quantity of zero is refused', 'refused',
  $probe$DO $i$ BEGIN
      INSERT INTO product (id, salon_id, name, price_fils)
      VALUES ('PR-VERIFY-Q', 'SL-VERIFY', 'Repair mask', 12000);
      INSERT INTO transaction (id,member_id,salon_id,branch_id,kind,amount_fils,status,settled_at)
      VALUES ('TX-SHOP-Q','MB-VERIFY','SL-VERIFY','BR-VERIFY','shop',-12000,'settled',now());
      INSERT INTO shop_order_line (transaction_id,product_id,name,qty,unit_price_fils,line_total_fils)
      VALUES ('TX-SHOP-Q','PR-VERIFY-Q','Repair mask',0,12000,0);
    END $i$ $probe$,
  'shop_order_line_qty_positive');

-- The append-only pair. Written against whatever lines the database holds, so on
-- an empty table `UPDATE`/`DELETE` still hit the privilege check before the row
-- count — a permission denial does not need a row to deny.
SELECT pg_temp.probe('11', 'the app role cannot re-itemise a settled order', 'refused',
  $probe$UPDATE shop_order_line SET qty = qty + 1$probe$,
  'permission denied', 'avo_app');

SELECT pg_temp.probe('11', 'the app role cannot remove an order line', 'refused',
  $probe$DELETE FROM shop_order_line$probe$,
  'permission denied', 'avo_app');

-- A reconciliation rather than a probe: every `shop` transaction's lines must add
-- up to what the customer was debited. `line_total_fils = qty × unit_price_fils`
-- is enforced per row above; this is the sum ACROSS an order, which no CHECK can
-- express.
--
-- It is the shop's counterpart to invariant 5, and invariant 5 is what caught a
-- real lost update on this very path: with `FOR UPDATE` removed from
-- `services/order.ts` to find out whether it was load-bearing, five concurrent
-- orders of 9.000 KD against a 15.250 balance ALL settled, all five reported the
-- same `balanceAfterFils: 6250`, and `member.balance_fils` ended 36000 fils apart
-- from the ledger. Every CHECK in this schema was satisfied the whole way through
-- — including both non-negative balance constraints, because each writer wrote
-- the same plausible number. Reconciliation was the only thing that could see it.
SELECT pg_temp.assert('11', 'every shop order''s lines sum to what was debited',
  NOT EXISTS (
    SELECT 1
      FROM transaction t
      JOIN shop_order_line l ON l.transaction_id = t.id
     WHERE t.kind = 'shop'
     GROUP BY t.id, t.amount_fils
    HAVING sum(l.line_total_fils) <> -t.amount_fils
  ),
  (SELECT CASE
     WHEN count(*) = 0 THEN 'no shop orders in this database yet'
     ELSE count(*) || ' order(s) reconcile' END
     FROM transaction WHERE kind = 'shop'));

-- Every line belongs to a `shop` transaction and to nothing else. No foreign key
-- can say this — `transaction_id` references the table, not the kind — so a
-- handler that hung order lines off a charge or a top-up would be refused by
-- nothing at all.
SELECT pg_temp.assert('11', 'no order line hangs off a non-shop transaction',
  NOT EXISTS (
    SELECT 1 FROM shop_order_line l
      JOIN transaction t ON t.id = l.transaction_id
     WHERE t.kind <> 'shop'
  ),
  (SELECT count(*) || ' line(s) checked' FROM shop_order_line));

-- =========================================================================
-- 12. the owner console's principal, and #8's storage
-- =========================================================================
-- Migrations 0028 and 0029. Four rules that a handler cannot be trusted with,
-- because each of them is exactly what a handler forgets:
--
--   THE PLATFORM PRINCIPAL HAS NO SALON. `requireSameSalon` is the tenancy
--   boundary for every other principal, and the console reads across salons by
--   design. `PlatformPrincipal` has no `salonId` FIELD so the check does not
--   compile — and the row-level version is an EQUIVALENCE, because a MERCHANT
--   session with a NULL salon would slip past `requireSameSalon` by having nothing
--   to compare. Both directions are probed.
--
--   "OWNER · FULL ACCESS" is a constraint. The console draws the owner's chips
--   non-toggleable; this is what backs that, so a row written before the rule
--   cannot express the forbidden combination either — `void implies charges`'s
--   treatment, applied to the console.
--
--   A REJECTION CARRIES A REASON. api-contract.md: "Rejections must carry a note —
--   the merchant sees it under the campaign." Left to the handler that is a
--   promise; here a future second decision path cannot forget it.
--
--   A HOLD IS NOT A STATUS. `CampaignSchema` declares four and a fifth on the wire
--   is a value every client's `.parse()` rejects, so a hold is `approved` +
--   `held_reason` — and only `approved`, since a hold on a pending, rejected or
--   sent campaign is a state nobody can act on.
SELECT pg_temp.probe('12', 'a platform session cannot carry a salon', 'refused',
  $probe$INSERT INTO session (principal_kind, platform_admin_id, salon_id, scope,
                          refresh_token_hash, expires_at)
    VALUES ('platform_admin', 'PLT-VERIFY', 'SL-VERIFY', 'platform',
            'verify-hash-salonful', now() + interval '1 day')$probe$,
  'session_salon_matches_principal');

-- THE OTHER DIRECTION, and it is the one a nullable column would have let through.
SELECT pg_temp.probe('12', 'a merchant session cannot omit its salon', 'refused',
  $probe$INSERT INTO session (principal_kind, staff_id, salon_id, scope,
                          refresh_token_hash, expires_at)
    VALUES ('staff', 'ST-VERIFY', NULL, 'dashboard',
            'verify-hash-salonless', now() + interval '1 day')$probe$,
  'session_salon_matches_principal');

SELECT pg_temp.probe('12', 'a platform admin cannot hold a dashboard session', 'refused',
  $probe$INSERT INTO session (principal_kind, platform_admin_id, salon_id, scope,
                          refresh_token_hash, expires_at)
    VALUES ('platform_admin', 'PLT-VERIFY', NULL, 'dashboard',
            'verify-hash-wrongscope', now() + interval '1 day')$probe$,
  'session_scope_matches_principal');

SELECT pg_temp.probe('12', 'a session cannot name two principals', 'refused',
  $probe$INSERT INTO session (principal_kind, platform_admin_id, staff_id, salon_id, scope,
                          refresh_token_hash, expires_at)
    VALUES ('platform_admin', 'PLT-VERIFY', 'ST-VERIFY', NULL, 'platform',
            'verify-hash-twoprincipals', now() + interval '1 day')$probe$,
  'session_exactly_one_principal');

SELECT pg_temp.probe('12', 'the owner cannot have a section switched off', 'refused',
  $probe$UPDATE platform_admin SET perm_approvals = false WHERE id = 'PLT-VERIFY'$probe$,
  'platform_admin_owner_holds_everything');

SELECT pg_temp.probe('12', 'the owner flag and the owner role are one fact', 'refused',
  $probe$UPDATE platform_admin SET role = 'admin' WHERE id = 'PLT-VERIFY'$probe$,
  'platform_admin_owner_flag_matches_role');

SELECT pg_temp.probe('12', 'a rejection with no note is refused', 'refused',
  $probe$UPDATE campaign SET status = 'rejected', decided_by = 'Yousef', decided_at = now()
     WHERE id = 'CMP-VERIFY'$probe$,
  'campaign_rejection_has_note');

SELECT pg_temp.probe('12', 'a pending campaign cannot name a decider', 'refused',
  $probe$UPDATE campaign SET decided_by = 'Yousef', decided_at = now()
     WHERE id = 'CMP-VERIFY'$probe$,
  'campaign_decision_is_attributed');

SELECT pg_temp.probe('12', 'a decided campaign cannot omit its decider', 'refused',
  $probe$UPDATE campaign SET status = 'approved' WHERE id = 'CMP-VERIFY'$probe$,
  'campaign_decision_is_attributed');

SELECT pg_temp.probe('12', 'only an approved campaign can be held', 'refused',
  $probe$UPDATE campaign SET held_reason = 'Quiet hours', held_at = now()
     WHERE id = 'CMP-VERIFY'$probe$,
  'campaign_hold_requires_approved');

SELECT pg_temp.probe('12', 'a hold needs a reason AND a moment', 'refused',
  $probe$UPDATE campaign SET status = 'approved', decided_by = 'Yousef', decided_at = now(),
                         held_reason = 'Quiet hours'
     WHERE id = 'CMP-VERIFY'$probe$,
  'campaign_hold_is_complete');

SELECT pg_temp.probe('12', 'only a sent campaign carries a result', 'refused',
  $probe$UPDATE campaign SET status = 'approved', decided_by = 'Yousef', decided_at = now(),
                         result = '612 reached'
     WHERE id = 'CMP-VERIFY'$probe$,
  'campaign_result_requires_sent');

SELECT pg_temp.probe('12', 'a now campaign cannot carry a scheduled time', 'refused',
  $probe$UPDATE campaign SET scheduled_at = now() + interval '1 day' WHERE id = 'CMP-VERIFY'$probe$,
  'campaign_scheduled_at_matches_when');

-- The cap's own rows. A limit whose rows the application can delete is not a limit
-- — 0026's reasoning about `signup_attempt`, and these rows are also the evidence
-- that a customer was contacted.
SELECT pg_temp.probe('12', 'the app role cannot delete a campaign send', 'refused',
  $probe$DELETE FROM campaign_send$probe$, 'permission denied', 'avo_app');

SELECT pg_temp.probe('12', 'the app role cannot backdate a campaign send', 'refused',
  $probe$UPDATE campaign_send SET sent_at = now() - interval '30 days'$probe$,
  'permission denied', 'avo_app');

SELECT pg_temp.probe('12', 'the messaging policy is a singleton', 'refused',
  $probe$INSERT INTO platform_messaging_policy (id) VALUES ('other')$probe$,
  'platform_messaging_policy_is_singleton');

SELECT pg_temp.probe('12', 'a weekly cap outside 1..7 is refused', 'refused',
  $probe$UPDATE platform_messaging_policy SET weekly_cap_per_customer = 8$probe$,
  'weekly_cap_in_range');

SELECT pg_temp.probe('12', 'quiet hours must be HH:mm', 'refused',
  $probe$UPDATE platform_messaging_policy SET quiet_from = '25:00'$probe$,
  'quiet_hours_are_hhmm');

/**
 * CONSENT ORDER IS UNAMBIGUOUS — migration 0029, and this is the invariant behind
 * a measured defect rather than a shape.
 *
 * `services/consent.ts` derives marketing consent as the newest event, and
 * `created_at` defaults to `now()` — the TRANSACTION timestamp — so two events
 * written in one transaction tie. With a grant and a withdrawal tied,
 * `ORDER BY created_at DESC LIMIT 1` returned the GRANT on eight consecutive runs:
 * a customer who withdrew read as consenting, in the permissive direction, from the
 * function the campaign send path is documented as having to call.
 *
 * `seq` is the tiebreak. The invariant is that it can BE one: NOT NULL and unique
 * per member, so "newest" is total rather than partial.
 */
SELECT pg_temp.assert('12', 'every consent event has a unique monotonic seq',
  NOT EXISTS (
    SELECT 1 FROM member_consent_event
     WHERE seq IS NULL
  ) AND NOT EXISTS (
    SELECT member_id, seq FROM member_consent_event
     GROUP BY member_id, seq HAVING count(*) > 1
  ),
  (SELECT count(*) || ' consent event(s) checked' FROM member_consent_event));

/**
 * A HELD CAMPAIGN HAS AN OPEN NOTIFICATION. #8's "held and reported, never
 * silently dropped", as a reconciliation rather than as a promise in a service
 * function: the merchant learns of a hold from the bell and from nowhere else,
 * because `CampaignSchema` declares no field for one. A held campaign with no open
 * `campaign_held` row IS the silent drop the rule forbids, and no constraint can
 * express it — the two tables are joined only by `subject_id`, which is free text.
 */
SELECT pg_temp.assert('12', 'every held campaign has an open notification',
  NOT EXISTS (
    SELECT 1 FROM campaign c
     WHERE c.held_reason IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM merchant_notification n
          WHERE n.salon_id = c.salon_id
            AND n.kind = 'campaign_held'
            AND n.subject_type = 'campaign'
            AND n.subject_id = c.id
            AND n.resolved_at IS NULL
       )
  ),
  (SELECT count(*) || ' held campaign(s) checked'
     FROM campaign WHERE held_reason IS NOT NULL));

-- =========================================================================
-- the report, then the verdict — in that order, and the verdict LAST
-- =========================================================================
\pset format aligned
\echo ''
\echo '=== every invariant checked ==============================================='
SELECT section AS s, label,
       CASE WHEN passed THEN 'PASS' ELSE 'FAIL' END AS result,
       expectation AS wanted,
       left(replace(detail, E'\n', ' '), 78) AS detail
  FROM _verify_result ORDER BY seq;

-- Carried out in psql variables, because the rollback below discards the rows.
-- `has_failures` is a real boolean because psql's `\if` accepts true/false/on/off
-- and nothing else — a count of "2" is not a value it can branch on.
SELECT count(*)::text                                    AS total,
       count(*) FILTER (WHERE NOT passed)::text          AS failures,
       (count(*) FILTER (WHERE NOT passed) > 0)          AS has_failures,
       coalesce(string_agg(section || ' ' || label, '; ') FILTER (WHERE NOT passed), '') AS failed_list
  FROM _verify_result \gset

-- NOTHING THIS SCRIPT DID SURVIVES. Every probe already rolled itself back inside
-- its own subtransaction; this discards the fixtures as well.
ROLLBACK;

\echo ''
\echo '=== verdict =============================================================='
\echo 'invariants checked:' :total '   failed:' :failures
\if :has_failures
\echo 'FAILED ->' :failed_list
-- A STATIC message: psql does not interpolate `:vars` inside dollar-quoted strings,
-- so the counts are echoed immediately above rather than formatted in here. The
-- point of this statement is the EXIT CODE — with ON_ERROR_STOP on, psql exits 3.
DO $verdict$ BEGIN
  RAISE EXCEPTION 'db:verify failed — one or more invariants do not hold'
    USING HINT = 'Read the FAIL rows above. An invariant that cannot fail is a comment.';
END $verdict$;
\else
\echo 'ALL INVARIANTS HOLD — and the database is unchanged by this run.'
\endif
