CREATE TYPE "public"."gateway_event_outcome" AS ENUM('applied', 'ignored_illegal_transition', 'ignored_unknown_intent', 'ignored_amount_mismatch');--> statement-breakpoint
CREATE TYPE "public"."topup_failure_reason" AS ENUM('declined', 'expired', 'cancelled_by_user', 'gateway_error');--> statement-breakpoint
CREATE TYPE "public"."topup_status" AS ENUM('created', 'redirected', 'pending', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "gateway_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"psp_reference" text NOT NULL,
	"intent_id" text,
	"reported_status" text NOT NULL,
	"outcome" "gateway_event_outcome" NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "topup_intent" (
	"id" text PRIMARY KEY NOT NULL,
	"member_id" text NOT NULL,
	"salon_id" text NOT NULL,
	"branch_id" text NOT NULL,
	"amount_fils" bigint NOT NULL,
	"bonus_fils" bigint DEFAULT 0 NOT NULL,
	"credit_fils" bigint NOT NULL,
	"fee_fils" bigint DEFAULT 0 NOT NULL,
	"method" "payment_method" NOT NULL,
	"status" "topup_status" DEFAULT 'created' NOT NULL,
	"failure_reason" "topup_failure_reason",
	"redirect_url" text DEFAULT '' NOT NULL,
	"reference" text NOT NULL,
	"provider" text NOT NULL,
	"psp_reference" text,
	"transaction_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "topup_intent_amount_positive" CHECK ("topup_intent"."amount_fils" > 0),
	CONSTRAINT "topup_intent_bonus_non_negative" CHECK ("topup_intent"."bonus_fils" >= 0),
	CONSTRAINT "topup_intent_fee_non_negative" CHECK ("topup_intent"."fee_fils" >= 0),
	CONSTRAINT "topup_intent_credit_is_amount_plus_bonus" CHECK ("topup_intent"."credit_fils" = "topup_intent"."amount_fils" + "topup_intent"."bonus_fils"),
	CONSTRAINT "topup_intent_method_is_external" CHECK ("topup_intent"."method" <> 'wallet'),
	CONSTRAINT "topup_intent_succeeded_has_transaction" CHECK (("topup_intent"."status" = 'succeeded') = ("topup_intent"."transaction_id" IS NOT NULL)),
	CONSTRAINT "topup_intent_succeeded_has_settled_at" CHECK (("topup_intent"."status" = 'succeeded') = ("topup_intent"."settled_at" IS NOT NULL)),
	CONSTRAINT "topup_intent_failure_reason_matches_status" CHECK (("topup_intent"."status" = 'failed' AND "topup_intent"."failure_reason" IS NOT NULL)
          OR ("topup_intent"."status" = 'cancelled' AND "topup_intent"."failure_reason" IS NOT NULL)
          OR ("topup_intent"."status" NOT IN ('failed', 'cancelled') AND "topup_intent"."failure_reason" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "sandbox_gateway_payment" (
	"psp_reference" text PRIMARY KEY NOT NULL,
	"intent_id" text NOT NULL,
	"amount_fils" bigint NOT NULL,
	"method" text NOT NULL,
	"outcome" text DEFAULT 'succeeded' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_gateway_payment_outcome_known" CHECK ("sandbox_gateway_payment"."outcome" IN ('succeeded', 'declined', 'cancelled', 'pending', 'gateway_error'))
);
--> statement-breakpoint
ALTER TABLE "gateway_event" ADD CONSTRAINT "gateway_event_intent_id_topup_intent_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."topup_intent"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topup_intent" ADD CONSTRAINT "topup_intent_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topup_intent" ADD CONSTRAINT "topup_intent_salon_id_salon_id_fk" FOREIGN KEY ("salon_id") REFERENCES "public"."salon"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topup_intent" ADD CONSTRAINT "topup_intent_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topup_intent" ADD CONSTRAINT "topup_intent_transaction_id_transaction_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transaction"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_event_provider_event_uq" ON "gateway_event" USING btree ("provider","event_id");--> statement-breakpoint
CREATE INDEX "gateway_event_psp_reference_idx" ON "gateway_event" USING btree ("psp_reference");--> statement-breakpoint
CREATE INDEX "gateway_event_intent_idx" ON "gateway_event" USING btree ("intent_id");--> statement-breakpoint
CREATE INDEX "topup_intent_member_created_idx" ON "topup_intent" USING btree ("member_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "topup_intent_salon_created_idx" ON "topup_intent" USING btree ("salon_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "topup_intent_psp_reference_uq" ON "topup_intent" USING btree ("psp_reference") WHERE psp_reference IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "topup_intent_transaction_uq" ON "topup_intent" USING btree ("transaction_id") WHERE transaction_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "topup_intent_open_idx" ON "topup_intent" USING btree ("created_at") WHERE status IN ('created', 'redirected', 'pending');--> statement-breakpoint
CREATE INDEX "sandbox_gateway_payment_intent_idx" ON "sandbox_gateway_payment" USING btree ("intent_id");