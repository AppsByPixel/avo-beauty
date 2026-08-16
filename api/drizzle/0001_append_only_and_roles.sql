-- ===========================================================================
-- 0001 — the guarantees that are not columns
--
--   1. the application role, and what it may not do
--   2. audit_log is append-only FOR REAL (privileges, not convention)
--   3. ledger_entry is immutable for the same reason
--   4. double entry stays balanced, checked at COMMIT
--   5. a money column can never be anything but bigint
--
-- Everything here is idempotent and can be re-run against a database that
-- already has it.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. The application role.
--
-- The API connects as `avo_app`. It is NOT the owner of these tables, and that
-- is the entire point: a table owner can UPDATE its own table no matter what
-- has been revoked, so an API that connects as the owner has an append-only
-- audit log in name only.
--
-- Created NOLOGIN if absent, so this migration never invents a credential. In
-- production a DBA provisions the role with a real secret and this block is a
-- no-op; locally docker/initdb/01-app-role.sh has already created it LOGIN.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'avo_app') THEN
    CREATE ROLE avo_app NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO avo_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO avo_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO avo_app;

-- Tables added by later migrations inherit the same baseline. An append-only
-- table added later must repeat the explicit REVOKE below; that is deliberate,
-- because "append-only" should be a decision someone writes down.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO avo_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO avo_app;

-- Nobody gets anything merely by being able to connect.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;


-- ---------------------------------------------------------------------------
-- 2. audit_log — append-only at the role level.
--
-- build-plan.md phase 0: "the row cannot be updated or deleted".
-- go-live-checklist.md: "Audit log verified append-only at the database level".
--
-- SELECT and INSERT, nothing else. An attempt to rewrite history fails with
-- `permission denied for table audit_log` before it ever reaches a WHERE clause.
-- ---------------------------------------------------------------------------
REVOKE ALL ON TABLE audit_log FROM avo_app, PUBLIC;
GRANT SELECT, INSERT ON TABLE audit_log TO avo_app;
GRANT USAGE, SELECT ON SEQUENCE audit_log_seq_seq TO avo_app;

-- Defence in depth. The REVOKE is the control; this catches what the REVOKE
-- cannot — a migration, a psql session, or a future job connecting as the
-- owner. Removing a row then takes deliberately disabling a trigger, which is
-- a DDL event rather than a typo.
CREATE OR REPLACE FUNCTION table_is_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    '% is append-only: % is not permitted on this table', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation',
          HINT = 'Correct a wrong entry by appending a correcting one.';
END
$$;

DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION table_is_append_only();

DROP TRIGGER IF EXISTS audit_log_no_delete ON audit_log;
CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION table_is_append_only();

DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log;
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION table_is_append_only();


-- ---------------------------------------------------------------------------
-- 3. ledger_entry — immutable, for the same reason.
--
-- A ledger you can edit is not a ledger. A wrong entry is corrected by posting
-- a reversing entry; that is what double entry is for.
-- ---------------------------------------------------------------------------
REVOKE ALL ON TABLE ledger_entry FROM avo_app, PUBLIC;
GRANT SELECT, INSERT ON TABLE ledger_entry TO avo_app;
GRANT USAGE, SELECT ON SEQUENCE ledger_entry_seq_seq TO avo_app;

DROP TRIGGER IF EXISTS ledger_entry_is_immutable ON ledger_entry;
CREATE TRIGGER ledger_entry_is_immutable
  BEFORE UPDATE OR DELETE ON ledger_entry
  FOR EACH ROW EXECUTE FUNCTION table_is_append_only();


-- ---------------------------------------------------------------------------
-- 4. Double entry stays balanced.
--
-- Per transaction, sum(credits) = sum(debits). DEFERRABLE INITIALLY DEFERRED so
-- it runs at COMMIT rather than after the first of the pair of INSERTs — the
-- handler writes both inside one transaction and the intermediate state is
-- legitimately unbalanced.
--
-- This is what makes `POST /charges` provable rather than merely careful: a
-- charge that debits a wallet without crediting salon revenue does not commit.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ledger_entries_must_balance() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  imbalance bigint;
BEGIN
  SELECT coalesce(sum(
           CASE direction WHEN 'credit' THEN amount_fils ELSE -amount_fils END
         ), 0)
    INTO imbalance
    FROM ledger_entry
   WHERE transaction_id = NEW.transaction_id;

  IF imbalance <> 0 THEN
    RAISE EXCEPTION
      'ledger entries for transaction % do not balance: % fils out',
      NEW.transaction_id, imbalance
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS ledger_entry_balanced ON ledger_entry;
CREATE CONSTRAINT TRIGGER ledger_entry_balanced
  AFTER INSERT ON ledger_entry
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_must_balance();


-- ---------------------------------------------------------------------------
-- 5. Money is bigint fils. Non-negotiable #1, asserted at migration time.
--
-- Naming money `*_fils` is a convention; this makes the convention load-bearing.
-- A future migration that declares `price_fils numeric(10,3)` — the single most
-- likely way a float ever reaches AVO's money — fails here, rather than rounding
-- someone's balance eighteen months from now.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg(format('%I.%I is %s', c.table_name, c.column_name, c.data_type), ', ')
    INTO offenders
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
   WHERE c.table_schema = 'public'
     AND t.table_type = 'BASE TABLE'
     AND c.column_name LIKE '%\_fils'
     AND c.data_type <> 'bigint';

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'Non-negotiable #1: money must be bigint fils. Offending columns: %', offenders;
  END IF;
END
$$;
