-- ===========================================================================
-- 0020 - notification preferences, and marketing consent as an EVENT
--
-- The wallet's Account screen has five switches — push, remind, wa, receipt,
-- offers — and no server behind any of them. Lane B held them locally and
-- escalated rather than inventing a contract, which was right, and its
-- reasoning is why this is two different shapes and not five booleans.
--
-- THE FOUR THAT ARE PREFERENCES
--
-- `push` and `remind` are plausibly client-owned; `wa` and `receipt` are not,
-- and that is the half that matters. Those two are SENT BY THE SERVER — the
-- receipt outbox does not consult a phone before it queues a WhatsApp message.
-- A local "off" therefore does not stop a receipt, and the customer has been
-- told it did. That is the defect: not a lost setting, a false statement made
-- to her face. So all four live here, on the row the sender can read, and a
-- reinstall stops silently re-enabling what she turned off.
--
-- WHY `offers` IS NOT A FIFTH COLUMN
--
-- It is not a preference, it is MARKETING CONSENT, and non-negotiable #8 needs
-- it readable on the platform send path: "caps and quiet hours are enforced
-- again at send time". A boolean answers "may we send" and nothing else. It
-- cannot answer the questions a cap and an audit actually ask —
--
--     when did she agree?     to which version of the terms?
--     where did she agree?    signup, or the Account screen?
--     had she withdrawn it before, and when?
--
-- — and those are precisely what somebody has to answer when a regulator or a
-- customer asks why she received a campaign. A boolean that has been flipped
-- twice looks identical to one that was never touched.
--
-- So consent is APPEND-ONLY EVENTS and the current state is the latest one.
-- `policy_version` is stamped on each because the privacy policy is the
-- document the consent is given under, and it is republishable — the same
-- reasoning that makes `member.policy_version` worth storing at all.
--
-- Nothing is ever updated or deleted here. `granted = false` is a withdrawal
-- event, not the absence of a grant.
-- ===========================================================================

-- The four preferences. DEFAULT TRUE for the three service channels, because
-- they are how a customer is told about her own money and her own appointments,
-- and she has an explicit switch for each.
--
-- `offers` is deliberately absent: consent is never a default.
ALTER TABLE member ADD COLUMN notify_push    boolean NOT NULL DEFAULT true;
ALTER TABLE member ADD COLUMN notify_remind  boolean NOT NULL DEFAULT true;
ALTER TABLE member ADD COLUMN notify_wa      boolean NOT NULL DEFAULT true;
ALTER TABLE member ADD COLUMN notify_receipt boolean NOT NULL DEFAULT true;

CREATE TABLE member_consent_event (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id      text NOT NULL REFERENCES member (id) ON DELETE cascade,
  salon_id       text NOT NULL REFERENCES salon (id) ON DELETE restrict,

  -- Only one kind today. A column rather than a fixed table name because the
  -- next one is already visible: non-negotiable #10's acceptance of a NEW
  -- policy version is the same shape of fact.
  kind           text NOT NULL,

  -- The event. `false` is a WITHDRAWAL, which is a fact in its own right and
  -- not the absence of a grant.
  granted        boolean NOT NULL,

  -- Where it happened: 'signup', 'wallet_account', 'support'. A cap auditing a
  -- send needs to know she chose it rather than inheriting it.
  source         text NOT NULL,

  -- Which terms were in force when she agreed. The privacy policy is the
  -- document the consent is given under and it is republishable.
  policy_version integer NOT NULL,

  ip_address     text,
  user_agent     text,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT member_consent_kind_is_known CHECK (kind IN ('marketing_offers')),
  CONSTRAINT member_consent_source_is_known
    CHECK (source IN ('signup', 'wallet_account', 'support', 'import'))
);

-- "What is her consent right now" = the newest row of that kind. This index is
-- the one the platform send path uses, per member per kind.
CREATE INDEX member_consent_member_kind_idx
  ON member_consent_event (member_id, kind, created_at DESC);

-- APPEND-ONLY FOR REAL, the same treatment `audit_log` gets in migration 0001.
-- A consent trail the application can rewrite is not evidence of anything, and
-- this table exists to be evidence. The owner role can still correct it; the
-- application role that serves requests cannot.
REVOKE UPDATE, DELETE ON TABLE member_consent_event FROM avo_app;
GRANT SELECT, INSERT ON TABLE member_consent_event TO avo_app;
