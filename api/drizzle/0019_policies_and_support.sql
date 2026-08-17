-- ===========================================================================
-- 0019 - the legal set, the support configuration, and support tickets
--
-- NON-NEGOTIABLE #10: "The customer app holds no legal copy. It renders the
-- published policy set from the API and stamps the version. Store the accepted
-- version against the member."
--
-- The member half has existed since 0000 — `member.policy_version`, NOT NULL,
-- CHECK > 0. The other half did not, so every member row has been stamped with
-- a version pointing at a document set the API could not produce. The wallet's
-- Terms screen renders nothing, and "she accepted THESE terms" has been
-- unanswerable.
--
-- WHY EVERY PUBLISHED VERSION IS KEPT
--
-- api-contract.md § LegalDocumentSet: "show the version and effective date in
-- the document header so support can tell which wording a customer actually
-- agreed to. Store the accepted `version` against the member record at signup —
-- that, not the current text, is what they consented to."
--
-- A single mutable row would make `member.policy_version` a dangling reference
-- the moment anything is republished, and the question it exists to answer
-- unanswerable in exactly the case it is asked: a dispute about old wording. So
-- `version` is the primary key and a publish INSERTS. Nothing here is updated
-- after it is published, which is what makes the stamp mean something.
--
-- THE DOCS ARE ONE jsonb COLUMN, for the same reason `salon.tiers` is: a
-- publish is a single row write and cannot half-apply. A tier ladder that
-- half-published is a money bug; a legal set that half-published is a customer
-- shown clause 3 of the old terms and clause 4 of the new ones.
--
-- SUPPORT: `route` IS THE WHOLE POINT OF THE TOPIC TABLE
--
-- Non-negotiable #11: "Support ticket routing is resolved server-side from
-- `topicId`. A client-supplied route can land a wallet dispute in a salon's
-- inbox." So `route` lives HERE, against the topic, owned by AVO —
-- api-contract.md is explicit that a merchant cannot edit it, because a salon
-- that could re-route "a charge I do not recognise" to itself would be
-- answering the disputes it is the subject of.
--
-- `support_ticket.route` is a COPY of the topic's route at the moment the
-- ticket was opened, not a join. AVO can re-route a topic later; a ticket that
-- silently moved queue afterwards would be a customer's dispute changing hands
-- with no record. Same snapshot instinct as `audit_log`'s actor columns.
-- ===========================================================================

CREATE TABLE legal_document_set (
  -- The version the member's `policy_version` refers to. PK, and INSERT-only.
  version        integer PRIMARY KEY,
  effective_from date NOT NULL,
  published_at   timestamptz NOT NULL,
  published_by   text NOT NULL,

  -- LegalDoc[]: { id, scope, consent, title:{en,ar}, body:{en:[],ar:[]} }.
  -- One column so a publish cannot half-apply.
  docs           jsonb NOT NULL,

  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT legal_document_set_version_positive CHECK (version > 0),
  -- An empty published set would satisfy every consent check trivially.
  CONSTRAINT legal_document_set_has_documents CHECK (jsonb_array_length(docs) > 0)
);

-- AVO-owned, one row. `id` is a fixed sentinel rather than a uuid: there is
-- exactly one support configuration on the platform, and a table that can hold
-- two is a table that eventually does.
CREATE TABLE support_config (
  id         text PRIMARY KEY DEFAULT 'avo',
  whatsapp   text NOT NULL,
  email      text NOT NULL,
  hours_en   text NOT NULL,
  hours_ar   text NOT NULL,
  reply_en   text NOT NULL,
  reply_ar   text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT support_config_is_singleton CHECK (id = 'avo')
);

CREATE TABLE support_topic (
  id         text PRIMARY KEY,
  -- 'salon' or 'avo'. The field non-negotiable #11 is about.
  route      text NOT NULL,
  en         text NOT NULL,
  ar         text NOT NULL,
  -- "rendered in array order" — api-contract.md § SupportConfig.
  position   integer NOT NULL,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT support_topic_route_is_known CHECK (route IN ('salon', 'avo'))
);

CREATE UNIQUE INDEX support_topic_position_uq ON support_topic (position);

CREATE TABLE support_ticket (
  -- "SUP-48263" — the customer's reference, shown verbatim. api-contract.md
  -- rule 4: "It is the only handle the customer has."
  id             text PRIMARY KEY,
  member_id      text NOT NULL REFERENCES member (id) ON DELETE restrict,
  salon_id       text NOT NULL REFERENCES salon (id) ON DELETE restrict,
  topic_id       text NOT NULL REFERENCES support_topic (id) ON DELETE restrict,

  -- Resolved from the topic ON THE SERVER, and snapshotted. Never from a body.
  route          text NOT NULL,

  message        text NOT NULL,
  -- An optional receipt/transaction reference the customer attached.
  ref            text NOT NULL DEFAULT '',
  -- Rule 3: a ref that matches a Transaction is LINKED — "support answering a
  -- dispute needs the receipt". Nullable because most refs match nothing.
  transaction_id text REFERENCES "transaction" (id) ON DELETE set null,

  via            text NOT NULL,
  status         text NOT NULL DEFAULT 'open',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT support_ticket_route_is_known CHECK (route IN ('salon', 'avo')),
  CONSTRAINT support_ticket_via_is_known CHECK (via IN ('wa', 'email')),
  CONSTRAINT support_ticket_status_is_known CHECK (status IN ('open', 'closed'))
);

CREATE INDEX support_ticket_member_created_idx ON support_ticket (member_id, created_at DESC);
-- The staffed queues: `GET /v1/support/tickets?route=&status=`.
CREATE INDEX support_ticket_route_status_idx ON support_ticket (route, status, created_at DESC);

-- GRANTS: covered by the ALTER DEFAULT PRIVILEGES in migration 0001.
