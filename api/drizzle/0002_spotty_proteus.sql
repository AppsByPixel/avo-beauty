CREATE TYPE "public"."principal_kind" AS ENUM('member', 'staff');--> statement-breakpoint
CREATE TYPE "public"."session_scope" AS ENUM('wallet', 'scanner', 'dashboard');--> statement-breakpoint
CREATE TYPE "public"."receipt_channel" AS ENUM('whatsapp', 'email');--> statement-breakpoint
CREATE TYPE "public"."receipt_status" AS ENUM('queued', 'sending', 'sent', 'failed');--> statement-breakpoint
CREATE TABLE "service" (
	"id" text PRIMARY KEY NOT NULL,
	"salon_id" text NOT NULL,
	"name" text NOT NULL,
	"price_fils" bigint NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_price_positive" CHECK ("service"."price_fils" > 0)
);
--> statement-breakpoint
CREATE TABLE "pin_attempt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"salon_id" text NOT NULL,
	"device_id" text NOT NULL,
	"staff_id" text,
	"succeeded" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"principal_kind" "principal_kind" NOT NULL,
	"member_id" text,
	"staff_id" text,
	"salon_id" text NOT NULL,
	"scope" "session_scope" NOT NULL,
	"refresh_token_hash" text NOT NULL,
	"device_id" text,
	"user_agent" text,
	"ip_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	CONSTRAINT "session_exactly_one_principal" CHECK (("session"."principal_kind" = 'member' AND "session"."member_id" IS NOT NULL AND "session"."staff_id" IS NULL)
          OR ("session"."principal_kind" = 'staff' AND "session"."staff_id" IS NOT NULL AND "session"."member_id" IS NULL)),
	CONSTRAINT "session_scanner_is_device_scoped" CHECK ("session"."scope" <> 'scanner' OR "session"."device_id" IS NOT NULL),
	CONSTRAINT "session_scope_matches_principal" CHECK (("session"."principal_kind" = 'member' AND "session"."scope" = 'wallet')
          OR ("session"."principal_kind" = 'staff' AND "session"."scope" IN ('scanner', 'dashboard'))),
	CONSTRAINT "session_revoked_has_reason" CHECK ("session"."revoked_at" IS NULL OR "session"."revoked_reason" IS NOT NULL),
	CONSTRAINT "session_expires_after_creation" CHECK ("session"."expires_at" > "session"."created_at")
);
--> statement-breakpoint
CREATE TABLE "receipt_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" text NOT NULL,
	"member_id" text NOT NULL,
	"channel" "receipt_channel" NOT NULL,
	"status" "receipt_status" DEFAULT 'queued' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "receipt_job_transaction_id_unique" UNIQUE("transaction_id"),
	CONSTRAINT "receipt_job_attempts_non_negative" CHECK ("receipt_job"."attempts" >= 0),
	CONSTRAINT "receipt_job_sent_at_matches_status" CHECK (("receipt_job"."status" = 'sent') = ("receipt_job"."sent_at" IS NOT NULL))
);
--> statement-breakpoint
DROP INDEX "idempotency_key_scope_key_uq";--> statement-breakpoint
ALTER TABLE "service" ADD CONSTRAINT "service_salon_id_salon_id_fk" FOREIGN KEY ("salon_id") REFERENCES "public"."salon"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pin_attempt" ADD CONSTRAINT "pin_attempt_salon_id_salon_id_fk" FOREIGN KEY ("salon_id") REFERENCES "public"."salon"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pin_attempt" ADD CONSTRAINT "pin_attempt_staff_id_staff_user_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_staff_id_staff_user_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_salon_id_salon_id_fk" FOREIGN KEY ("salon_id") REFERENCES "public"."salon"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_job" ADD CONSTRAINT "receipt_job_transaction_id_transaction_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transaction"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_job" ADD CONSTRAINT "receipt_job_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "service_salon_idx" ON "service" USING btree ("salon_id");--> statement-breakpoint
CREATE INDEX "pin_attempt_device_idx" ON "pin_attempt" USING btree ("salon_id","device_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "session_refresh_hash_uq" ON "session" USING btree ("refresh_token_hash");--> statement-breakpoint
CREATE INDEX "session_member_idx" ON "session" USING btree ("member_id") WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE INDEX "session_staff_idx" ON "session" USING btree ("staff_id") WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE INDEX "session_expires_idx" ON "session" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "receipt_job_claim_idx" ON "receipt_job" USING btree ("available_at") WHERE status IN ('queued', 'failed');--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_key_scope_endpoint_key_uq" ON "idempotency_key" USING btree ("scope","endpoint","key");