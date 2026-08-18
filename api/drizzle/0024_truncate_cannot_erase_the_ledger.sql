-- ===========================================================================
-- 0024 - TRUNCATE is not an UPDATE and it is not a DELETE
--
-- THE THIRD INSTANCE OF THE SAME PATTERN, AND THE MOST EXPENSIVE ONE.
--
-- `schema/ledger.ts` says "Entries are immutable. Migration 0001 revokes UPDATE
-- and DELETE on this table from the application role for the same reason it does
-- on `audit_log`." Migration 0004 says `gateway_event` "is append-only, for the
-- same reason audit_log is."
--
-- Both claims stop short of what `audit_log` actually gets. 0001 gives audit_log
-- THREE triggers - no_update, no_delete AND no_truncate - because TRUNCATE is
-- neither an UPDATE nor a DELETE and a BEFORE ... FOR EACH ROW trigger never runs
-- for it. `ledger_entry` and `gateway_event` each got the first two.
--
-- So this worked, as the owner, against the table every wallet balance is derived
-- from:
--
--     SELECT count(*) FROM ledger_entry;          -- 6
--     TRUNCATE ledger_entry;                      -- TRUNCATE TABLE
--     SELECT count(*) FROM ledger_entry;          -- 0
--
-- One statement, no error, and `member.balance_fils` becomes a number with no
-- derivation behind it - which is the exact condition `ledger_entry` exists to
-- make impossible, and which `db:verify` section 5 reconciles against. The
-- immutability trigger fired for neither row because there were no row events.
--
-- WHY THIS BREAKS NOTHING
-- ----------------------
-- Checked before writing it, because the seed does reset these tables:
--
--   - `db/seed.ts` uses `DELETE FROM ledger_entry` and `DELETE FROM
--     gateway_event`, never TRUNCATE, and disables the two immutability triggers
--     by name around it. The new triggers are never in its way.
--   - `scripts/lane-db.sh` resets with `DROP SCHEMA ... CASCADE`, which drops the
--     triggers along with the tables rather than firing them.
--   - No TRUNCATE of either table exists anywhere in `api/`, `e2e/`, `scripts/`
--     or `packages/`.
--
-- So unlike migration 0023 - where a DELETE trigger would have broken the erasure
-- cascade and the parity had to stop deliberately - there is no legitimate caller
-- here to protect. Both tables get the full treatment.
--
-- NOT `member_consent_event`, which already has its TRUNCATE trigger from 0023,
-- and NOT `loyalty_event`, which migration 0008 states is append-only by intent
-- and NOT by revoke, with its reasoning written out. That decision stands.
-- ===========================================================================

DROP TRIGGER IF EXISTS ledger_entry_no_truncate ON ledger_entry;
CREATE TRIGGER ledger_entry_no_truncate
  BEFORE TRUNCATE ON ledger_entry
  FOR EACH STATEMENT EXECUTE FUNCTION table_is_append_only();

DROP TRIGGER IF EXISTS gateway_event_no_truncate ON gateway_event;
CREATE TRIGGER gateway_event_no_truncate
  BEFORE TRUNCATE ON gateway_event
  FOR EACH STATEMENT EXECUTE FUNCTION table_is_append_only();
