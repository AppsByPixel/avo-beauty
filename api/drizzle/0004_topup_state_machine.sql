-- ===========================================================================
-- 0004 — the top-up state machine, as a database rule
--
--   1. a top-up status only ever moves forward, and never out of a terminal
--      state
--   2. gateway_event is append-only, for the same reason audit_log is
--   3. the new money columns are bigint fils (re-asserting 0001 §5 over the
--      tables 0003 added)
--
-- Idempotent and safe to re-run.
--
-- WHY A TRIGGER AND NOT JUST CAREFUL CODE
-- ---------------------------------------
-- services/topup.ts applies every transition as a conditional UPDATE whose row
-- count decides the outcome, which is already correct. This exists because
-- "correct" in one file is a property of that file. A reconciliation job, a
-- support tool, a psql session or next quarter's handler can all UPDATE
-- topup_intent, and exactly one of those needs to get it wrong for a settled
-- top-up to be walked back into flight and settled a second time.
--
-- The arrows, in full:
--
--   created    → redirected, pending, succeeded, failed, cancelled
--   redirected → pending, succeeded, failed, cancelled
--   pending    → succeeded, failed, cancelled
--   succeeded  → (nothing)
--   failed     → (nothing)
--   cancelled  → (nothing)
--
-- Note that a state cannot reach itself. That is deliberate and load-bearing:
-- it is what makes a re-delivered `succeeded` callback a no-op rather than a
-- second credit.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. Status transitions.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION topup_intent_status_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    -- Not a transition. Updating redirect_url or psp_reference without touching
    -- status is ordinary work; only status changes are policed here.
    RETURN NEW;
  END IF;

  IF OLD.status IN ('succeeded', 'failed', 'cancelled') THEN
    RAISE EXCEPTION
      'top-up % is terminal (%): it cannot become %',
      OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation',
            HINT = 'A settled or failed top-up is history. Create a new intent instead.';
  END IF;

  IF NOT (
       (OLD.status = 'created'    AND NEW.status IN ('redirected','pending','succeeded','failed','cancelled'))
    OR (OLD.status = 'redirected' AND NEW.status IN ('pending','succeeded','failed','cancelled'))
    OR (OLD.status = 'pending'    AND NEW.status IN ('succeeded','failed','cancelled'))
  ) THEN
    RAISE EXCEPTION
      'top-up % cannot move from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS topup_intent_status_transitions ON topup_intent;
CREATE TRIGGER topup_intent_status_transitions
  BEFORE UPDATE ON topup_intent
  FOR EACH ROW EXECUTE FUNCTION topup_intent_status_guard();


-- ---------------------------------------------------------------------------
-- 2. gateway_event is append-only.
--
-- It is the record of what the processor told us and when. In a dispute it is
-- the only account of the other side's behaviour, so it gets the same treatment
-- as audit_log in 0001: privileges first, trigger as defence in depth.
--
-- `table_is_append_only()` is defined in migration 0001.
-- ---------------------------------------------------------------------------
REVOKE ALL ON TABLE gateway_event FROM avo_app, PUBLIC;
GRANT SELECT, INSERT ON TABLE gateway_event TO avo_app;

DROP TRIGGER IF EXISTS gateway_event_no_update ON gateway_event;
CREATE TRIGGER gateway_event_no_update
  BEFORE UPDATE ON gateway_event
  FOR EACH ROW EXECUTE FUNCTION table_is_append_only();

DROP TRIGGER IF EXISTS gateway_event_no_delete ON gateway_event;
CREATE TRIGGER gateway_event_no_delete
  BEFORE DELETE ON gateway_event
  FOR EACH ROW EXECUTE FUNCTION table_is_append_only();


-- ---------------------------------------------------------------------------
-- 3. Non-negotiable #1 over the tables 0003 added.
--
-- 0001 §5 asserted this across the schema as it stood. Re-running it here is
-- what makes the assertion cover topup_intent and sandbox_gateway_payment too,
-- rather than being a one-time check that new money columns can slip past.
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
