CREATE TYPE "public"."loyalty_mode" AS ENUM('tiers', 'stamps');--> statement-breakpoint
CREATE TYPE "public"."salon_plan" AS ENUM('starter', 'growth', 'pro');--> statement-breakpoint
CREATE TYPE "public"."tier_name" AS ENUM('bronze', 'silver', 'gold', 'black');--> statement-breakpoint
CREATE TYPE "public"."staff_role" AS ENUM('owner', 'manager', 'frontdesk', 'artist', 'scanner');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('knet', 'card', 'applepay', 'wallet');--> statement-breakpoint
CREATE TYPE "public"."transaction_kind" AS ENUM('topup', 'charge', 'deposit_hold', 'deposit_return', 'shop', 'adjustment');--> statement-breakpoint
CREATE TYPE "public"."transaction_status" AS ENUM('pending', 'settled', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."ledger_account" AS ENUM('member_wallet', 'salon_revenue', 'avo_commission', 'gateway_clearing', 'deposit_held', 'merchant_bonus_funding');--> statement-breakpoint
CREATE TYPE "public"."ledger_direction" AS ENUM('debit', 'credit');--> statement-breakpoint
CREATE TYPE "public"."audit_actor_kind" AS ENUM('staff', 'member', 'platform_admin', 'system');--> statement-breakpoint
CREATE TYPE "public"."audit_kind" AS ENUM('money', 'rules', 'access', 'risk');--> statement-breakpoint
CREATE TYPE "public"."audit_source" AS ENUM('merchant', 'scanner', 'wallet', 'owner_console', 'system');--> statement-breakpoint
CREATE TYPE "public"."idempotency_status" AS ENUM('in_progress', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "branch" (
	"id" text PRIMARY KEY NOT NULL,
	"salon_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "salon" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"plan" "salon_plan" DEFAULT 'starter' NOT NULL,
	"brand_color" text NOT NULL,
	"module_booking" boolean DEFAULT false NOT NULL,
	"module_shop" boolean DEFAULT false NOT NULL,
	"loyalty_mode" "loyalty_mode" NOT NULL,
	"tiers" jsonb,
	"stamp_target" integer,
	"stamp_reward" text,
	"deposit_fils" bigint NOT NULL,
	"no_show_return_minutes" integer DEFAULT 60 NOT NULL,
	"business_hours" jsonb NOT NULL,
	"social" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"whatsapp_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "salon_brand_color_is_hex" CHECK ("salon"."brand_color" ~ '^#[0-9A-Fa-f]{6}$'),
	CONSTRAINT "salon_deposit_in_range" CHECK ("salon"."deposit_fils" BETWEEN 1000 AND 10000),
	CONSTRAINT "salon_no_show_return_positive" CHECK ("salon"."no_show_return_minutes" > 0),
	CONSTRAINT "salon_stamp_target_positive" CHECK ("salon"."stamp_target" IS NULL OR "salon"."stamp_target" > 0),
	CONSTRAINT "salon_loyalty_config_complete" CHECK (("salon"."loyalty_mode" = 'tiers' AND "salon"."tiers" IS NOT NULL)
          OR ("salon"."loyalty_mode" = 'stamps' AND "salon"."stamp_target" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "member" (
	"id" text PRIMARY KEY NOT NULL,
	"salon_id" text NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"email" text,
	"email_verified" boolean DEFAULT false NOT NULL,
	"password_hash" text NOT NULL,
	"balance_fils" bigint DEFAULT 0 NOT NULL,
	"visits" integer DEFAULT 0 NOT NULL,
	"tier" "tier_name",
	"stamps" integer,
	"policy_version" integer NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_balance_non_negative" CHECK ("member"."balance_fils" >= 0),
	CONSTRAINT "member_phone_is_e164" CHECK ("member"."phone" ~ '^\+[1-9][0-9]{6,14}$'),
	CONSTRAINT "member_visits_non_negative" CHECK ("member"."visits" >= 0),
	CONSTRAINT "member_stamps_non_negative" CHECK ("member"."stamps" IS NULL OR "member"."stamps" >= 0),
	CONSTRAINT "member_policy_version_positive" CHECK ("member"."policy_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "staff_user" (
	"id" text PRIMARY KEY NOT NULL,
	"salon_id" text NOT NULL,
	"name" text NOT NULL,
	"handle" text NOT NULL,
	"role" "staff_role" NOT NULL,
	"branch_access_all" boolean DEFAULT false NOT NULL,
	"branch_access_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"password_hash" text,
	"pin_hash" text,
	"pin_device_id" text,
	"pin_failed_attempts" integer DEFAULT 0 NOT NULL,
	"pin_locked_until" timestamp with time zone,
	"perm_dashboard" boolean DEFAULT false NOT NULL,
	"perm_appointments" boolean DEFAULT false NOT NULL,
	"perm_shop" boolean DEFAULT false NOT NULL,
	"perm_loyalty" boolean DEFAULT false NOT NULL,
	"perm_team" boolean DEFAULT false NOT NULL,
	"perm_scanner" boolean DEFAULT false NOT NULL,
	"perm_charges" boolean DEFAULT false NOT NULL,
	"perm_void" boolean DEFAULT false NOT NULL,
	"perm_marketing" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_user_void_implies_charges" CHECK (NOT "staff_user"."perm_void" OR "staff_user"."perm_charges"),
	CONSTRAINT "staff_user_branch_access_exclusive" CHECK (NOT "staff_user"."branch_access_all" OR cardinality("staff_user"."branch_access_ids") = 0),
	CONSTRAINT "staff_user_pin_is_device_scoped" CHECK (("staff_user"."pin_hash" IS NULL) = ("staff_user"."pin_device_id" IS NULL)),
	CONSTRAINT "staff_user_pin_attempts_non_negative" CHECK ("staff_user"."pin_failed_attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "transaction" (
	"id" text PRIMARY KEY NOT NULL,
	"member_id" text NOT NULL,
	"salon_id" text NOT NULL,
	"branch_id" text NOT NULL,
	"kind" "transaction_kind" NOT NULL,
	"amount_fils" bigint NOT NULL,
	"bonus_fils" bigint DEFAULT 0 NOT NULL,
	"fee_fils" bigint DEFAULT 0 NOT NULL,
	"method" "payment_method",
	"status" "transaction_status" DEFAULT 'pending' NOT NULL,
	"reference" text DEFAULT '' NOT NULL,
	"note" text,
	"reverses_transaction_id" text,
	"created_by_staff_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "transaction_amount_sign_matches_kind" CHECK (("transaction"."kind" IN ('topup', 'deposit_return') AND "transaction"."amount_fils" > 0)
          OR ("transaction"."kind" IN ('charge', 'deposit_hold', 'shop') AND "transaction"."amount_fils" < 0)
          OR ("transaction"."kind" = 'adjustment' AND "transaction"."amount_fils" <> 0)),
	CONSTRAINT "transaction_bonus_non_negative" CHECK ("transaction"."bonus_fils" >= 0),
	CONSTRAINT "transaction_bonus_is_topup_only" CHECK ("transaction"."bonus_fils" = 0 OR "transaction"."kind" = 'topup'),
	CONSTRAINT "transaction_fee_non_negative" CHECK ("transaction"."fee_fils" >= 0),
	CONSTRAINT "transaction_reversal_is_not_self" CHECK ("transaction"."reverses_transaction_id" IS NULL OR "transaction"."reverses_transaction_id" <> "transaction"."id"),
	CONSTRAINT "transaction_settled_at_matches_status" CHECK (("transaction"."status" = 'settled') = ("transaction"."settled_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "ledger_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"transaction_id" text NOT NULL,
	"salon_id" text NOT NULL,
	"member_id" text,
	"account" "ledger_account" NOT NULL,
	"direction" "ledger_direction" NOT NULL,
	"amount_fils" bigint NOT NULL,
	"balance_after_fils" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entry_amount_positive" CHECK ("ledger_entry"."amount_fils" > 0),
	CONSTRAINT "ledger_entry_balance_after_non_negative" CHECK ("ledger_entry"."balance_after_fils" IS NULL OR "ledger_entry"."balance_after_fils" >= 0),
	CONSTRAINT "ledger_entry_balance_after_is_wallet_only" CHECK ("ledger_entry"."balance_after_fils" IS NULL OR "ledger_entry"."account" = 'member_wallet'),
	CONSTRAINT "ledger_entry_wallet_requires_member" CHECK ("ledger_entry"."account" <> 'member_wallet' OR "ledger_entry"."member_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"salon_id" text,
	"actor_kind" "audit_actor_kind" NOT NULL,
	"actor_id" text,
	"actor_name" text NOT NULL,
	"actor_role" text NOT NULL,
	"kind" "audit_kind" NOT NULL,
	"action" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"source" "audit_source" NOT NULL,
	"subject_type" text,
	"subject_id" text,
	"amount_fils" bigint,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_log_actor_id_required" CHECK ("audit_log"."actor_kind" = 'system' OR "audit_log"."actor_id" IS NOT NULL),
	CONSTRAINT "audit_log_money_has_amount" CHECK ("audit_log"."kind" <> 'money' OR "audit_log"."amount_fils" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "idempotency_key" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"endpoint" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" "idempotency_status" DEFAULT 'in_progress' NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"transaction_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone DEFAULT now() + interval '24 hours' NOT NULL,
	CONSTRAINT "idempotency_key_completed_has_response" CHECK ("idempotency_key"."status" = 'in_progress'
          OR ("idempotency_key"."response_status" IS NOT NULL AND "idempotency_key"."response_body" IS NOT NULL
              AND "idempotency_key"."completed_at" IS NOT NULL)),
	CONSTRAINT "idempotency_key_expires_after_creation" CHECK ("idempotency_key"."expires_at" > "idempotency_key"."created_at")
);
--> statement-breakpoint
CREATE TABLE "wallet_token" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() + interval '45 seconds' NOT NULL,
	"consumed_at" timestamp with time zone,
	"consumed_by_staff_id" text,
	"consumed_by_transaction_id" text,
	CONSTRAINT "wallet_token_expiry_is_short" CHECK ("wallet_token"."expires_at" > "wallet_token"."issued_at" AND "wallet_token"."expires_at" <= "wallet_token"."issued_at" + interval '2 minutes'),
	CONSTRAINT "wallet_token_consumed_after_issue" CHECK ("wallet_token"."consumed_at" IS NULL OR "wallet_token"."consumed_at" >= "wallet_token"."issued_at"),
	CONSTRAINT "wallet_token_consumer_requires_consumption" CHECK ("wallet_token"."consumed_at" IS NOT NULL
          OR ("wallet_token"."consumed_by_staff_id" IS NULL AND "wallet_token"."consumed_by_transaction_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "branch" ADD CONSTRAINT "branch_salon_id_salon_id_fk" FOREIGN KEY ("salon_id") REFERENCES "public"."salon"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_salon_id_salon_id_fk" FOREIGN KEY ("salon_id") REFERENCES "public"."salon"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_user" ADD CONSTRAINT "staff_user_salon_id_salon_id_fk" FOREIGN KEY ("salon_id") REFERENCES "public"."salon"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_salon_id_salon_id_fk" FOREIGN KEY ("salon_id") REFERENCES "public"."salon"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_reverses_transaction_id_transaction_id_fk" FOREIGN KEY ("reverses_transaction_id") REFERENCES "public"."transaction"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_created_by_staff_id_staff_user_id_fk" FOREIGN KEY ("created_by_staff_id") REFERENCES "public"."staff_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_transaction_id_transaction_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transaction"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_salon_id_salon_id_fk" FOREIGN KEY ("salon_id") REFERENCES "public"."salon"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_salon_id_salon_id_fk" FOREIGN KEY ("salon_id") REFERENCES "public"."salon"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_key" ADD CONSTRAINT "idempotency_key_transaction_id_transaction_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transaction"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_token" ADD CONSTRAINT "wallet_token_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_token" ADD CONSTRAINT "wallet_token_consumed_by_staff_id_staff_user_id_fk" FOREIGN KEY ("consumed_by_staff_id") REFERENCES "public"."staff_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_token" ADD CONSTRAINT "wallet_token_consumed_by_transaction_id_transaction_id_fk" FOREIGN KEY ("consumed_by_transaction_id") REFERENCES "public"."transaction"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "branch_salon_idx" ON "branch" USING btree ("salon_id");--> statement-breakpoint
CREATE UNIQUE INDEX "branch_salon_name_uq" ON "branch" USING btree ("salon_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "member_salon_phone_uq" ON "member" USING btree ("salon_id","phone");--> statement-breakpoint
CREATE INDEX "member_salon_idx" ON "member" USING btree ("salon_id");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_user_salon_handle_uq" ON "staff_user" USING btree ("salon_id","handle");--> statement-breakpoint
CREATE INDEX "staff_user_salon_idx" ON "staff_user" USING btree ("salon_id");--> statement-breakpoint
CREATE INDEX "staff_user_pin_device_idx" ON "staff_user" USING btree ("salon_id","pin_device_id");--> statement-breakpoint
CREATE INDEX "transaction_member_created_idx" ON "transaction" USING btree ("member_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "transaction_salon_created_idx" ON "transaction" USING btree ("salon_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "transaction_branch_created_idx" ON "transaction" USING btree ("branch_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_reverses_uq" ON "transaction" USING btree ("reverses_transaction_id") WHERE reverses_transaction_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ledger_entry_transaction_idx" ON "ledger_entry" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "ledger_entry_member_seq_idx" ON "ledger_entry" USING btree ("member_id","seq");--> statement-breakpoint
CREATE INDEX "ledger_entry_salon_account_idx" ON "ledger_entry" USING btree ("salon_id","account","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_salon_created_idx" ON "audit_log" USING btree ("salon_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_kind_created_idx" ON "audit_log" USING btree ("kind","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_source_created_idx" ON "audit_log" USING btree ("source","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_subject_idx" ON "audit_log" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_key_scope_key_uq" ON "idempotency_key" USING btree ("scope","key");--> statement-breakpoint
CREATE INDEX "idempotency_key_expires_idx" ON "idempotency_key" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idempotency_key_transaction_idx" ON "idempotency_key" USING btree ("transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_token_hash_uq" ON "wallet_token" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "wallet_token_member_live_idx" ON "wallet_token" USING btree ("member_id","expires_at" DESC NULLS LAST) WHERE consumed_at IS NULL;--> statement-breakpoint
CREATE INDEX "wallet_token_expires_idx" ON "wallet_token" USING btree ("expires_at");