-- ===========================================================================
-- A REWARD THE SALON WROTE — a custom option on "Attach a reward".
--
-- The client asked for merchants to be able to add their own option to the
-- "Attach a reward" dropdown on Marketing → Campaigns. Until this migration a
-- campaign's `reward` was `RewardKey | 'none'`, a fixed list, validated at the
-- boundary only (there is no CHECK on `campaign.reward`, so nothing here widens
-- one: `'custom'` is admitted in `routes/campaigns.ts`, where the other values
-- are).
--
-- A CAMPAIGN REWARD IS A LABEL, AND THIS KEEPS IT ONE. Nothing applies
-- `campaign.reward` as an earning effect — happy hours do, through
-- `rewardEffect()`, and campaigns never have. A custom reward is a free-text
-- perk ("Free hair mask with any blow-dry") that the salon honours itself. It
-- moves no money, touches no ledger and is read by no charge, top-up or
-- `rewardEffect`. Happy hours keep their fixed list and are untouched.
--
-- ---------------------------------------------------------------------------
-- THE LIST: `campaign_reward`
-- ---------------------------------------------------------------------------
-- One row per saved option, per salon. `CRW-10000000` onwards from
-- `campaign_reward_number_seq` (`services/ids.ts § campaignRewardId`), the
-- in-INSERT form, because nothing needs the id before the row exists.
--
-- REMOVED IS ARCHIVED, NEVER DELETED. `DELETE /campaign-rewards/{id}` sets
-- `archived_at`. A campaign that used the reward still points at the row, and
-- the FK below is `restrict`, so the row a campaign names cannot vanish.
--
-- THE LABEL IS HELD AT THE COLUMN: trimmed (`label = btrim(label)`) and 1..60
-- characters. The route trims and refuses by name first (400 `invalid_label`);
-- the CHECKs are there so a write that bypasses the route cannot store a label
-- the dropdown would then render.
--
-- ONE ACTIVE LABEL PER SALON, CASE-INSENSITIVELY: a partial unique index on
-- `(salon_id, lower(label)) WHERE archived_at IS NULL`. Partial, so a salon
-- that removes "Free mask" can add "Free mask" again later without the archived
-- row standing in the way. The route answers 409 `duplicate_reward` by name, and
-- this index is what answers the race two tabs pressing Save at once would
-- otherwise win twice.
--
-- `campaign_reward_id_salon_uq (id, salon_id)` is the target of the composite
-- FK from `campaign`, additive over the primary key exactly as
-- `artist_id_salon_uq` and `service_id_salon_uq` are (0061).
--
-- GRANTS AND ROW SECURITY. No table in this schema enables row-level security;
-- tenancy is enforced in each route's WHERE and, where it can be, in composite
-- FKs. 0001's `ALTER DEFAULT PRIVILEGES … ON TABLES` grants `avo_app` SELECT,
-- INSERT, UPDATE, DELETE on this table, and `… ON SEQUENCES` covers the
-- sequence. The same as `artist_service` (0061). Not append-only — archiving is
-- an UPDATE — so no REVOKE follows.
--
-- ---------------------------------------------------------------------------
-- THE CAMPAIGN: `custom_reward_id` and `custom_reward_label`
-- ---------------------------------------------------------------------------
-- `custom_reward_label` IS A SNAPSHOT of the label at submission, and it is what
-- the wire serves as `customReward`. A campaign still reads correctly after its
-- reward is removed from the list, and a reviewer approves the words the
-- merchant saw, not whatever the row says later. The server resolves it from
-- the id; a label sent by the client is never read.
--
-- `campaign_custom_reward_same_salon_fk (custom_reward_id, salon_id)` →
-- `campaign_reward (id, salon_id)` makes "salon A's campaign names salon B's
-- reward" unstorable, even if a code path forgets the check. MATCH SIMPLE, so
-- a NULL `custom_reward_id` is not checked at all — every existing row.
--
-- `campaign_custom_reward_is_labelled`: `(reward = 'custom') = (custom_reward_label
-- IS NOT NULL)`. An equivalence, so it bites both ways: a custom campaign with no
-- words and a non-custom one carrying stray words are both unstorable.
-- `campaign_custom_reward_id_requires_custom`: the id is NULL unless the reward is
-- custom.
--
-- ---------------------------------------------------------------------------
-- SAFE UNDER THE DEPLOYED API
-- ---------------------------------------------------------------------------
-- The API live on the demo (3dee53e) inserts campaigns with `reward` in
-- `RewardKey | 'none'` and names neither new column, so both are NULL: the
-- equivalence reads false = false, the one-way CHECK reads true, and the FK is
-- not checked. Every existing row passes for the same reason. Its SELECTs name
-- their columns through Drizzle, so two unread columns change nothing it
-- serialises. A new table and two nullable columns, nothing renamed, nothing
-- dropped.
--
-- LOCKING: CREATE TABLE touches nothing live. ADD COLUMN with no default is a
-- catalogue change (ACCESS EXCLUSIVE, milliseconds, no rewrite). The two CHECKs
-- scan `campaign` and the FK validates against it, under SHARE ROW EXCLUSIVE —
-- tens of rows per salon. lock_timeout 3s, the 0010/0011/0059/0063 convention,
-- so a long transaction holding `campaign` fails this rather than queueing the
-- decision endpoint behind it.
-- ===========================================================================

SET lock_timeout = '3s';--> statement-breakpoint

CREATE SEQUENCE IF NOT EXISTS campaign_reward_number_seq AS bigint START WITH 10000000;
--> statement-breakpoint
CREATE TABLE "campaign_reward" (
  "id" text PRIMARY KEY NOT NULL,
  "salon_id" text NOT NULL,
  "label" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by" text NOT NULL,
  "archived_at" timestamp with time zone,
  CONSTRAINT "campaign_reward_id_salon_uq" UNIQUE ("id", "salon_id"),
  CONSTRAINT "campaign_reward_label_is_trimmed" CHECK ("label" = btrim("label")),
  CONSTRAINT "campaign_reward_label_length" CHECK (char_length("label") BETWEEN 1 AND 60)
);
--> statement-breakpoint
ALTER TABLE "campaign_reward" ADD CONSTRAINT "campaign_reward_salon_id_salon_id_fk"
  FOREIGN KEY ("salon_id") REFERENCES "salon"("id") ON DELETE restrict;
--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_reward_active_label_uq"
  ON "campaign_reward" ("salon_id", lower("label")) WHERE "archived_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "campaign" ADD COLUMN "custom_reward_id" text;
--> statement-breakpoint
ALTER TABLE "campaign" ADD COLUMN "custom_reward_label" text;
--> statement-breakpoint
ALTER TABLE "campaign" ADD CONSTRAINT "campaign_custom_reward_same_salon_fk"
  FOREIGN KEY ("custom_reward_id", "salon_id") REFERENCES "campaign_reward"("id", "salon_id")
  ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "campaign" ADD CONSTRAINT "campaign_custom_reward_is_labelled"
  CHECK (("reward" = 'custom') = ("custom_reward_label" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "campaign" ADD CONSTRAINT "campaign_custom_reward_id_requires_custom"
  CHECK ("custom_reward_id" IS NULL OR "reward" = 'custom');
--> statement-breakpoint
RESET lock_timeout;
