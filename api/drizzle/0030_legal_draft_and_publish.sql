-- ===========================================================================
-- 0030 — the legal draft, so publishing is an endpoint rather than an INSERT
--
-- `legal_document_set` has held every PUBLISHED version since 0019, with
-- `version` as the primary key and publish-by-INSERT. What did not exist was the
-- draft, and therefore neither did any of the six routes api-contract.md
-- § LegalDocumentSet declares:
--
--     PATCH  /v1/platform/policies/draft/{docId}
--     POST   /v1/platform/policies/draft
--     DELETE /v1/platform/policies/draft/{docId}
--     POST   /v1/platform/policies/publish   { effectiveFrom }
--     POST   /v1/platform/policies/discard
--
-- So `GET /v1/platform/policies` answered `{ published }` where the contract
-- declares `{ published, draft }`, and a version could only be published by
-- hand: STATUS.md records that a previous session "inserted v4 by SQL to test the
-- stale path". That is the tell — the only way to exercise #10's re-prompt was to
-- write to the database directly, which means the re-prompt was reachable in a
-- test and not in the product.
--
-- ONE MUTABLE ROW, AND THAT IS THE ASYMMETRY WITH `legal_document_set`
-- -------------------------------------------------------------------
-- Published versions are INSERT-only and kept forever, because
-- `member.policy_version` points at one and a dispute is about wording somebody
-- agreed to two versions ago. A DRAFT is the opposite: it is a scratchpad, nobody
-- has agreed to it, nothing references it, and its history is not evidence of
-- anything. So it is one row that is edited in place, and `discard` resets it.
--
-- `docs` IS ONE jsonb COLUMN, for the reason `salon.tiers` is: a publish must not
-- half-apply. Clause 3 of the new terms beside clause 4 of the old ones is the
-- legal equivalent of a half-published tier ladder.
--
-- WHY NO `version` ON THE DRAFT. It has none until it is published, and giving it
-- a provisional one would create two answers to "what is v4" — the draft's guess
-- and, after somebody else publishes, the real one. The publish reads
-- `max(version) + 1` at the moment it commits.
--
-- LOCKING: one CREATE TABLE on a table that does not exist.
--
-- GRANTS: 0001's ALTER DEFAULT PRIVILEGES covers it. NOT append-only, unlike
-- `legal_document_set`, which is the whole point of the distinction above.
--
-- Idempotent and safe to re-run.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS legal_document_draft (
  id          text PRIMARY KEY NOT NULL DEFAULT 'avo',
  docs        jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The last admin to touch it. Not an audit trail — `audit_log` is that — just
  -- the name the console shows beside "unpublished changes".
  updated_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT legal_document_draft_is_singleton CHECK (id = 'avo'),
  -- An EMPTY draft is legitimate: it means "no unpublished changes", which is what
  -- `discard` produces and what a fresh deployment has. `legal_document_set` has
  -- the opposite CHECK (`jsonb_array_length(docs) > 0`) because an empty PUBLISHED
  -- set would satisfy every consent check trivially. Different tables, different
  -- rule, and the difference is that one of them is in front of customers.
  CONSTRAINT legal_document_draft_docs_is_array CHECK (jsonb_typeof(docs) = 'array')
);--> statement-breakpoint

-- The row, so a handler never has to decide what an absent draft means.
INSERT INTO legal_document_draft (id) VALUES ('avo') ON CONFLICT (id) DO NOTHING;
