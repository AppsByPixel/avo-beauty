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
-- WHAT THIS TRIGGER DOES NOT DO — AND THE CLAIM THAT USED TO BE HERE
-- ------------------------------------------------------------------
-- This header said: "a state cannot reach itself. That is deliberate and
-- load-bearing: it is what makes a re-delivered `succeeded` callback a no-op
-- rather than a second credit."
--
-- Both sentences were false, and the second was the dangerous one. Verified in
-- psql against a real settled intent, savepoint-per-probe, all rolled back:
--
--   UPDATE topup_intent SET status='succeeded' WHERE id='TI-…';   -> UPDATE 1
--   UPDATE topup_intent SET status='succeeded',
--          transaction_id='TX-9021' WHERE id='TI-…';              -> UPDATE 1
--   UPDATE topup_intent SET status='pending'   WHERE id='TI-…';
--     -> ERROR: top-up TI-… is terminal (succeeded): it cannot become pending
--
-- A state reaches itself freely: the `IF NEW.status = OLD.status THEN RETURN NEW`
-- branch below returns BEFORE the arrow table is consulted. So a settled intent
-- can be re-asserted as settled, and — the second line above — re-pointed at a
-- DIFFERENT transaction_id while it does so, which is precisely the shape a
-- second credit has.
--
-- AND IT CANNOT BE OTHERWISE. Re-asserting a status is indistinguishable from
-- touching `updated_at`, which ordinary work does and an existing spec requires
-- to keep working (`UPDATE … SET updated_at=now()` is `UPDATE 1` above, and it
-- passes through the same branch). Refusing self-transitions would refuse that.
-- More to the point, A SECOND CREDIT NEVER MOVES THE STATUS — it is
-- `succeeded → succeeded` by construction — so a status guard is STRUCTURALLY
-- BLIND to the thing this comment claimed it prevented. No version of this
-- trigger could have made the claim true.
--
-- WHAT IS ACTUALLY LOAD-BEARING, then. The arrows below are real and they are
-- worth having: `succeeded → pending` is refused, which stops a settled top-up
-- being walked back into flight by a support tool or a psql session, and that is
-- the paragraph above ("WHY A TRIGGER AND NOT JUST CAREFUL CODE") stated
-- correctly. What stops a re-delivered callback crediting twice is in
-- services/topup.ts: the intent row taken `FOR UPDATE`, `canTransition` refusing
-- `succeeded → succeeded` in application code, and the conditional credit write.
-- Lane D removed them one at a time and money moved twice only when all three
-- were gone.
--
-- THIS IS THE THIRD PROSE INVARIANT IN A MIGRATION COMMENT THAT NOBODY COULD
-- CHECK, after the ledger reconciliation claim and 0020's half-parity. The
-- pattern is the same each time: a true-sounding sentence about a guarantee,
-- written next to a mechanism that does something adjacent to it, and no test
-- that would fail if it were wrong. There is one now — lane D's spec asserts both
-- halves, so it fails if this trigger is dropped AND it documents that the
-- self-transition is permitted.
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
