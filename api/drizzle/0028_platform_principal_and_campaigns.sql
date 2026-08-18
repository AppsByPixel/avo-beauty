-- ===========================================================================
-- 0028 — the owner console gets a principal, and a campaign becomes a row
--
-- Phase 7 was blocked at its front door. `PrincipalKind` was `'member' |
-- 'staff'` and `SessionScope` was `'wallet' | 'scanner' | 'dashboard'`, so
-- `POST /auth/web/session` could only ever mint a salon-scoped merchant session.
-- Lane C recorded the whole blocking list in
-- `apps/dashboard/src/auth/scopes.ts` and declined to build against it, which
-- was right: LANES.md § "Order of work" records that running a client ahead of
-- the API is what produced "the throwaway sign-in stand-in that had to be
-- rewritten".
--
-- One thing already anticipated the console: `audit_log.actor_kind` has included
-- `platform_admin` since 0001, and the seed writes rows with it, while
-- `services/audit.ts::actorOf()` could not produce that value from any principal
-- that existed. The schema was ready and the write path was not.
--
-- ---------------------------------------------------------------------------
-- WHAT `POST /campaigns` WAS DOING, WHICH IS WORTH STATING PLAINLY
-- ---------------------------------------------------------------------------
-- It built an object literal, wrote an audit row, and returned the literal. It
-- persisted nothing. So the `status: 'pending'` it hardcoded so carefully was
-- true of a value that existed for the length of one HTTP response, and
-- non-negotiable #8's first half held only because there was no second half:
-- nothing could send, because nothing was stored. `DELETE
-- .../campaigns/{cid}` had nothing to withdraw and the platform decision
-- endpoint had nothing to decide about.
--
-- Trunk counted the other half in `api/src`: `requireApproval` 0 occurrences,
-- `weeklyCapPerCustomer` 0, `monthlyCapPerSalon` 0, `quietFrom` 0.
-- `PlatformMessagingPolicySchema` and `isInQuietHours` were both written and
-- neither was called. This migration is the storage; `services/campaign.ts` is
-- the enforcement.
--
-- ---------------------------------------------------------------------------
-- THE `session` CHANGE, AND WHY `salon_id` HAD TO BECOME NULLABLE
-- ---------------------------------------------------------------------------
-- Every other principal is salon-scoped and `requireSameSalon` is the tenancy
-- boundary. A platform admin is the one credential that reads ACROSS salons by
-- design — the console's Analytics is "across all salons". A platform session
-- carrying a salon id would be a merchant with extra authority, which is exactly
-- the confusion the console must not be, so `salon_id` is NULL for platform
-- sessions and the new CHECK requires that in both directions.
--
-- THE ENUM VALUES ARE ADDED AND THEN NOT USED AS ENUM LITERALS. Postgres allows
-- `ALTER TYPE … ADD VALUE` inside a transaction but refuses to USE the new value
-- in the same transaction, and drizzle's migrator runs a file as one
-- transaction. So every new CHECK below compares `principal_kind::text` and
-- `scope::text` against string literals rather than against the enum values.
-- Same constraint, expressed in a form this transaction is allowed to evaluate.
--
-- LOCKING: three CREATE TABLEs on tables that do not exist; two ALTER TYPE ADD
-- VALUE, which take a brief catalog lock; and ALTERs on `session`. Dropping NOT
-- NULL is a catalog-only change. ADD COLUMN with no default and no volatile
-- expression is catalog-only from PG 11. The two CHECK replacements DO scan
-- `session` — bounded by the number of live sessions, which is small, and
-- unavoidable if the constraint is to be true of existing rows.
--
-- GRANTS: 0001's ALTER DEFAULT PRIVILEGES covers the three new tables for
-- `avo_app` on creation. `platform_admin`, `campaign` and
-- `platform_messaging_policy` are state that legitimately changes.
-- `campaign_send` is not: it is both a rate-limit counter and the evidence that a
-- customer was contacted, so UPDATE and DELETE are revoked exactly as they are
-- on `ledger_entry` and `shop_order_line`. A cap whose own rows the application
-- can delete is not a cap — 0026's reasoning about `signup_attempt`, which
-- applies more strongly here.
--
-- Idempotent and safe to re-run.
-- ===========================================================================

ALTER TYPE "public"."principal_kind" ADD VALUE IF NOT EXISTS 'platform_admin';--> statement-breakpoint
ALTER TYPE "public"."session_scope" ADD VALUE IF NOT EXISTS 'platform';--> statement-breakpoint

-- The bell a held campaign rings. #8's "reported, never silently dropped" — and the
-- only place a merchant can learn of a hold, because `CampaignSchema` declares no
-- field for one and Zod strips what it does not declare.
ALTER TYPE "public"."merchant_notification_kind" ADD VALUE IF NOT EXISTS 'campaign_held';--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- platform_admin
--
-- Nine section permissions. SIX are the chips `AVO Owner Console.dc.html` draws
-- in its Admins editor (analytics, activity, salons, accounts, admins,
-- controls); the design's own sidebar has TEN sections, so four have no declared
-- gate. Three of those four have endpoints in this slice and non-negotiable #7
-- does not permit an ungated endpoint, hence `perm_approvals`, `perm_policies`
-- and `perm_audit`. `reports` is the fourth and gets no column, because nothing
-- serves it yet and adding one when CSV export lands is a smaller decision than
-- guessing now. The design gap is reported, not papered over — the reasoning is
-- in full in `src/db/schema/platformAdmin.ts`.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform_admin (
  id             text PRIMARY KEY NOT NULL,
  name           text NOT NULL,
  -- GLOBALLY unique, unlike `staff_user.handle` which is unique per salon
  -- because "noura" is not a unique person inside AVO. There is one platform, so
  -- there is one "yousef" — which is also why platform sign-in needs no
  -- workspace field where merchant sign-in does.
  handle         text NOT NULL,
  -- Nullable: an invited admin exists before she has a password, and #6 says the
  -- console only ever sends a reset link.
  password_hash  text,
  role           text NOT NULL,
  owner          boolean NOT NULL DEFAULT false,

  perm_analytics boolean NOT NULL DEFAULT false,
  perm_activity  boolean NOT NULL DEFAULT false,
  perm_salons    boolean NOT NULL DEFAULT false,
  perm_accounts  boolean NOT NULL DEFAULT false,
  perm_admins    boolean NOT NULL DEFAULT false,
  perm_controls  boolean NOT NULL DEFAULT false,
  perm_approvals boolean NOT NULL DEFAULT false,
  perm_policies  boolean NOT NULL DEFAULT false,
  perm_audit     boolean NOT NULL DEFAULT false,

  -- Deactivated, never deleted: a removed admin's decisions must still read
  -- "Yousef · Owner" in an audit row seven years from now.
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT platform_admin_role_is_known
    CHECK (role IN ('owner', 'admin', 'analyst', 'support')),
  CONSTRAINT platform_admin_handle_is_lower CHECK (handle = lower(handle)),
  CONSTRAINT platform_admin_handle_has_no_at CHECK (handle NOT LIKE '@%'),
  -- "Owner · full access", as a constraint rather than as a drawn detail. The
  -- console renders the owner's chips non-toggleable; this is what backs that.
  CONSTRAINT platform_admin_owner_holds_everything
    CHECK (NOT owner OR (perm_analytics AND perm_activity AND perm_salons
           AND perm_accounts AND perm_admins AND perm_controls
           AND perm_approvals AND perm_policies AND perm_audit)),
  -- The owner role and the owner flag are one fact, not two.
  CONSTRAINT platform_admin_owner_flag_matches_role CHECK (owner = (role = 'owner'))
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS platform_admin_handle_uq ON platform_admin (handle);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- session gains a third principal
-- ---------------------------------------------------------------------------
ALTER TABLE session ADD COLUMN IF NOT EXISTS platform_admin_id text
  REFERENCES platform_admin(id) ON DELETE cascade;--> statement-breakpoint
ALTER TABLE session ALTER COLUMN salon_id DROP NOT NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS session_platform_admin_idx
  ON session (platform_admin_id) WHERE revoked_at IS NULL;--> statement-breakpoint

-- Exactly one principal, now over three kinds. Both/neither set is a session two
-- different people could be holding.
ALTER TABLE session DROP CONSTRAINT IF EXISTS session_exactly_one_principal;--> statement-breakpoint
ALTER TABLE session ADD CONSTRAINT session_exactly_one_principal CHECK (
  (principal_kind::text = 'member'
     AND member_id IS NOT NULL AND staff_id IS NULL AND platform_admin_id IS NULL)
  OR (principal_kind::text = 'staff'
     AND staff_id IS NOT NULL AND member_id IS NULL AND platform_admin_id IS NULL)
  OR (principal_kind::text = 'platform_admin'
     AND platform_admin_id IS NOT NULL AND member_id IS NULL AND staff_id IS NULL)
);--> statement-breakpoint

-- Members hold wallet sessions, staff hold scanner or dashboard, a platform
-- admin holds `platform` and nothing else. A platform admin with a `dashboard`
-- session would reach every merchant route through `requireDashboardPerm`, which
-- reads `staff_user` — a table she has no row in.
ALTER TABLE session DROP CONSTRAINT IF EXISTS session_scope_matches_principal;--> statement-breakpoint
ALTER TABLE session ADD CONSTRAINT session_scope_matches_principal CHECK (
  (principal_kind::text = 'member' AND scope::text = 'wallet')
  OR (principal_kind::text = 'staff' AND scope::text IN ('scanner', 'dashboard'))
  OR (principal_kind::text = 'platform_admin' AND scope::text = 'platform')
);--> statement-breakpoint

-- THE TENANCY HALF. A platform session has no salon and every other session has
-- one, in both directions — a NULL salon on a merchant session would slip past
-- `requireSameSalon` by having nothing to compare.
ALTER TABLE session DROP CONSTRAINT IF EXISTS session_salon_matches_principal;--> statement-breakpoint
ALTER TABLE session ADD CONSTRAINT session_salon_matches_principal CHECK (
  (principal_kind::text = 'platform_admin') = (salon_id IS NULL)
);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- campaign
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS campaign (
  id            text PRIMARY KEY NOT NULL,
  salon_id      text NOT NULL REFERENCES salon(id) ON DELETE restrict,

  title         text NOT NULL,
  body          text NOT NULL,
  channel       text NOT NULL,
  audience      text NOT NULL,
  -- NULL means every branch; the wire spells it "all", exactly as
  -- `happy_hour.branch_id` does. One sentinel convention, not two.
  branch_id     text REFERENCES branch(id) ON DELETE restrict,
  reward        text NOT NULL DEFAULT 'none',
  -- Server-computed at submission, and deliberately not recomputed on read: the
  -- number a reviewer approved against must not change under her.
  reach         integer NOT NULL DEFAULT 0,

  -- `when` is reserved in SQL. The wire field stays `when`, per CampaignSchema.
  send_when     text NOT NULL DEFAULT 'now',
  scheduled_at  timestamptz,

  status        text NOT NULL DEFAULT 'pending',

  submitted_by  text NOT NULL,
  submitted_at  timestamptz NOT NULL DEFAULT now(),
  decided_by    text,
  decided_at    timestamptz,
  note          text,
  result        text,

  -- The "held, not dropped" state. NOT a fifth status: `CampaignSchema` declares
  -- four, and a fifth on the wire is a value every client's `.parse()` rejects.
  held_reason   text,
  held_at       timestamptz,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT campaign_status_is_known
    CHECK (status IN ('pending', 'approved', 'rejected', 'sent')),
  CONSTRAINT campaign_channel_is_known CHECK (channel IN ('push', 'wa', 'both')),
  CONSTRAINT campaign_audience_is_known
    CHECK (audience IN ('all', 'lapsed', 'lowbal', 'gold', 'new')),
  CONSTRAINT campaign_when_is_known CHECK (send_when IN ('now', 'later', 'recurring')),
  CONSTRAINT campaign_title_not_blank CHECK (length(btrim(title)) > 0),
  CONSTRAINT campaign_body_not_blank CHECK (length(btrim(body)) > 0),
  CONSTRAINT campaign_reach_non_negative CHECK (reach >= 0),

  -- A rejection carries a reason, in the database. The contract says the merchant
  -- sees it verbatim; left to a handler that is a promise, here it is a fact.
  -- One-directional: an approval may carry a note too (the design's fixture has a
  -- standing approval whose note explains the trigger).
  CONSTRAINT campaign_rejection_has_note
    CHECK (status <> 'rejected' OR (note IS NOT NULL AND length(btrim(note)) > 0)),
  -- An EQUIVALENCE, so it bites both ways — `topup_intent_succeeded_has_settled_at`'s
  -- lesson. A one-directional version lets a `pending` row carry a decider, which
  -- reads to a merchant as "somebody looked at this and did nothing".
  CONSTRAINT campaign_decision_is_attributed
    CHECK ((status IN ('approved', 'rejected', 'sent'))
           = (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  CONSTRAINT campaign_hold_is_complete
    CHECK ((held_reason IS NOT NULL) = (held_at IS NOT NULL)),
  -- Only an approved campaign can be held: a pending one was never released, a
  -- rejected one is going nowhere, a sent one already went.
  CONSTRAINT campaign_hold_requires_approved
    CHECK (held_reason IS NULL OR status = 'approved'),
  CONSTRAINT campaign_result_requires_sent CHECK (result IS NULL OR status = 'sent'),
  CONSTRAINT campaign_scheduled_at_matches_when
    CHECK ((send_when = 'later') = (scheduled_at IS NOT NULL))
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS campaign_salon_submitted_idx
  ON campaign (salon_id, submitted_at DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS campaign_status_submitted_idx
  ON campaign (status, submitted_at);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- platform_messaging_policy — one row, and the singleton CHECK is the structural
-- half of "a merchant can never read or raise these values". There is no salon
-- column, so there is nothing a merchant-scoped route could select.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform_messaging_policy (
  id                       text PRIMARY KEY NOT NULL DEFAULT 'avo',
  require_approval         boolean NOT NULL DEFAULT true,
  weekly_cap_per_customer  integer NOT NULL DEFAULT 2,
  monthly_cap_per_salon    integer NOT NULL DEFAULT 8,
  quiet_from               text NOT NULL DEFAULT '22:00',
  quiet_to                 text NOT NULL DEFAULT '09:00',
  updated_by               text,
  updated_at               timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT platform_messaging_policy_is_singleton CHECK (id = 'avo'),
  -- The contract's own ranges, so a PATCH cannot store a cap the design's
  -- stepper could never have produced.
  CONSTRAINT platform_messaging_policy_weekly_cap_in_range
    CHECK (weekly_cap_per_customer BETWEEN 1 AND 7),
  CONSTRAINT platform_messaging_policy_monthly_cap_in_range
    CHECK (monthly_cap_per_salon BETWEEN 1 AND 30),
  CONSTRAINT platform_messaging_policy_quiet_hours_are_hhmm
    CHECK (quiet_from ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
           AND quiet_to ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
);--> statement-breakpoint

-- The defaults are api-contract.md's: requireApproval ON, 2 per customer per
-- week, 8 per salon per month, quiet 22:00–09:00. Inserted here rather than left
-- to the seed, because an absent policy row is a deployment with no messaging
-- limits at all and the handlers would have to invent fallbacks — which is how
-- two silent defaults for TRUST_PROXY came to be wrong in both directions.
INSERT INTO platform_messaging_policy (id) VALUES ('avo') ON CONFLICT (id) DO NOTHING;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- campaign_send — one row per customer per delivered campaign.
--
-- This is what makes the weekly cap real. "A hard cap across ALL salons" is a
-- question about the customer, answerable only from a log of what she has already
-- received; nothing else in this schema records a message reaching a person.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS campaign_send (
  campaign_id text NOT NULL REFERENCES campaign(id) ON DELETE restrict,
  member_id   text NOT NULL REFERENCES member(id) ON DELETE restrict,
  sent_at     timestamptz NOT NULL DEFAULT now(),
  channel     text NOT NULL,

  -- One send per customer per campaign. A scheduler that fires twice cannot
  -- double-count her against the cap or double-message her, and the database is
  -- what says so rather than the worker's good intentions.
  CONSTRAINT campaign_send_pk PRIMARY KEY (campaign_id, member_id),
  CONSTRAINT campaign_send_channel_is_known CHECK (channel IN ('push', 'wa', 'both'))
);--> statement-breakpoint

-- THE CAP'S ONLY QUERY: "how many in the last seven days, for this member".
CREATE INDEX IF NOT EXISTS campaign_send_member_sent_idx
  ON campaign_send (member_id, sent_at DESC);--> statement-breakpoint

GRANT SELECT, INSERT ON campaign_send TO avo_app;--> statement-breakpoint
REVOKE UPDATE, DELETE ON campaign_send FROM avo_app;
