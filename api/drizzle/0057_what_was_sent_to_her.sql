-- ===========================================================================
-- WHAT WAS SENT TO HER — the customer bell's one piece of new state.
--
-- Client ask 4 (wallet list): "add a notification bell so they can see the
-- notifications and manage them".
--
-- THERE IS NO NOTIFICATION TABLE HERE, AND THAT IS THE DECISION.
-- The feed is READ from the two outbound records this API already writes per
-- member, inside the transactions that produce them:
--
--   receipt_job     one row per channel per money movement — top-up, charge,
--                   shop order, deposit held, deposit returned. Written in the
--                   money transaction by `queueReceipts`, so it exists if and
--                   only if the money moved.
--   campaign_send   one row per recipient of a campaign, written only by
--                   `deliverCampaign` AFTER the platform decision, quiet hours
--                   and both caps (non-negotiable #8).
--
-- A third copy of those facts written "for the bell" would have to be added to
-- five money paths and the campaign release, and the copy nobody reads is the
-- one that drifts. `services/memberNotifications.ts` carries the argument.
--
-- What neither record can hold is whether SHE has seen it. That is this table:
-- one row per (member, thing she has read). Absence of a row is "unread".
--
-- ---------------------------------------------------------------------------
-- TWO FOREIGN KEYS AND AN EXACTLY-ONE CHECK, NOT A FREE-TEXT `notification_id`.
-- ---------------------------------------------------------------------------
-- A bell item is either a transaction (receipt stream) or a campaign. A text id
-- with no FK would accept a mark for a row that does not exist, and a mark for
-- SOMEBODY ELSE'S transaction — the write path refuses both (it inserts only ids
-- drawn from her own feed), and the schema refuses the first on its own.
-- ===========================================================================

CREATE TABLE "member_notification_read" (
  "member_id" text NOT NULL,
  "transaction_id" text,
  "campaign_id" text,
  "read_at" timestamp with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "member_notification_read_member_id_member_id_fk"
    FOREIGN KEY ("member_id") REFERENCES "member"("id") ON DELETE restrict,
  CONSTRAINT "member_notification_read_transaction_id_transaction_id_fk"
    FOREIGN KEY ("transaction_id") REFERENCES "transaction"("id") ON DELETE restrict,
  CONSTRAINT "member_notification_read_campaign_id_campaign_id_fk"
    FOREIGN KEY ("campaign_id") REFERENCES "campaign"("id") ON DELETE restrict,

  -- Exactly one source. Both is two facts in one row; neither is a mark of nothing.
  CONSTRAINT "member_notification_read_exactly_one_source"
    CHECK (("transaction_id" IS NULL) <> ("campaign_id" IS NULL))
);

-- One mark per item per member. `ON CONFLICT DO NOTHING` against these is what
-- makes a second mark-read a no-op that keeps the FIRST `read_at`.
CREATE UNIQUE INDEX "member_notification_read_tx_uq"
  ON "member_notification_read" ("member_id", "transaction_id")
  WHERE "transaction_id" IS NOT NULL;
CREATE UNIQUE INDEX "member_notification_read_campaign_uq"
  ON "member_notification_read" ("member_id", "campaign_id")
  WHERE "campaign_id" IS NOT NULL;

-- The receipt stream's read: "her receipt rows, newest first". `receipt_job` had
-- no member index at all — erasure's `DELETE … WHERE member_id` was a seq scan
-- too — because until now only the worker read it, and the worker reads by status.
CREATE INDEX "receipt_job_member_created_idx"
  ON "receipt_job" ("member_id", "created_at" DESC);
