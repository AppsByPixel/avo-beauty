-- ===========================================================================
-- 0023 - a consent record that can be edited is not evidence of consent
--
-- `member_consent_event` got REVOKE UPDATE, DELETE from `avo_app` in migration
-- 0020 and no trigger. That migration's comment says it is getting "the same
-- treatment `audit_log` gets in migration 0001", and that claim is not true:
-- `audit_log` gets the REVOKE **and** three triggers that refuse UPDATE, DELETE
-- and TRUNCATE even to the owner. This table got half of it.
--
-- The gap matters because of what this table is for. Non-negotiable #8 needs
-- marketing consent readable and truthful on the platform send path, and 0020's
-- own reasoning is that a boolean cannot answer "when did she agree, under which
-- terms, had she withdrawn it before". Those answers are only worth having if the
-- rows cannot be rewritten afterwards. An UPDATE could flip a withdrawal into a
-- grant, move `policy_version` to a document she never saw, or backdate
-- `created_at` to before a campaign that had no consent behind it — and leave no
-- trace, because the row that would record the edit IS the row being edited.
--
-- WHY UPDATE AND TRUNCATE, BUT DELIBERATELY NOT DELETE
-- ---------------------------------------------------
-- This is where the parity with `audit_log` has to stop, and the reason is a
-- schema difference rather than a judgement call.
--
--   audit_log            references salon only, ON DELETE RESTRICT. Nothing
--                        cascades into it, so it can refuse DELETE forever.
--   member_consent_event member_id REFERENCES member (id) ON DELETE CASCADE.
--
-- The 30-day erasure the privacy policy promises ends in a DELETE of personal
-- data, and this table holds personal data keyed to the member with a CASCADE
-- that exists precisely so that erasure reaches it. A DELETE trigger here would
-- make that erasure impossible. Verified before writing this migration, with the
-- exact trigger `audit_log` uses:
--
--   ERROR:  member_consent_event is append-only: DELETE is not permitted
--   CONTEXT: SQL statement "DELETE FROM ONLY "public"."member_consent_event"
--            WHERE $1 OPERATOR(pg_catalog.=) "member_id""
--
-- The cascade fails, so `DELETE FROM member` fails, so the erasure fails. Adding
-- the DELETE trigger would trade a threat nobody has for a legal obligation the
-- product has already published.
--
-- So the threat model is split where the schema splits it. REWRITING a consent
-- record is forbidden outright, to everyone including the owner. REMOVING one is
-- permitted only through the member's own erasure, which takes the whole person
-- with it and is the one case where losing the trail is the point. A consent row
-- cannot outlive the customer it is about, and it cannot be quietly changed while
-- she exists.
--
-- TRUNCATE is refused too. It is not reachable through a cascade — `TRUNCATE
-- member CASCADE` would need naming this table, which no code does — and it is
-- the one statement that could empty the table without deleting a single member.
--
-- The application role still cannot DELETE: 0020's REVOKE stands, and the cascade
-- runs with the privileges of the referencing constraint rather than the caller's.
-- So the only route to removing a consent row remains erasing the member.
-- ===========================================================================

DROP TRIGGER IF EXISTS member_consent_event_no_update ON member_consent_event;
CREATE TRIGGER member_consent_event_no_update
  BEFORE UPDATE ON member_consent_event
  FOR EACH ROW EXECUTE FUNCTION table_is_append_only();

DROP TRIGGER IF EXISTS member_consent_event_no_truncate ON member_consent_event;
CREATE TRIGGER member_consent_event_no_truncate
  BEFORE TRUNCATE ON member_consent_event
  FOR EACH STATEMENT EXECUTE FUNCTION table_is_append_only();
