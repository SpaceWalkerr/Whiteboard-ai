CREATE TYPE "public"."billing_interval" AS ENUM('month', 'year');--> statement-breakpoint
CREATE TYPE "public"."billing_provider" AS ENUM('razorpay');--> statement-breakpoint
CREATE TYPE "public"."entitlement_source" AS ENUM('subscription', 'team_seat', 'student_trial', 'manual');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('paid', 'issued', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('created', 'authenticated', 'active', 'past_due', 'halted', 'paused', 'cancelled', 'completed', 'expired');--> statement-breakpoint
CREATE TABLE "billing_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "billing_provider" NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"provider_subscription_id" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "board_editor_seats" (
	"board_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"suspended" boolean DEFAULT false NOT NULL,
	CONSTRAINT "board_editor_seats_board_id_user_id_pk" PRIMARY KEY("board_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "board_editor_seats" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "coupons" (
	"code" text PRIMARY KEY NOT NULL,
	"provider" "billing_provider" NOT NULL,
	"provider_offer_id" text NOT NULL,
	"description" text NOT NULL,
	"plan_ids" text[],
	"valid_from" timestamp with time zone,
	"valid_until" timestamp with time zone,
	"max_redemptions" integer,
	"redemptions" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "coupons" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" uuid,
	"org_id" uuid,
	"user_id" uuid,
	"provider" "billing_provider" NOT NULL,
	"provider_invoice_id" text NOT NULL,
	"provider_payment_id" text,
	"status" "invoice_status" NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" text NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"issued_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"receipt_url" text,
	"receipt_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invoices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "plans" (
	"id" text PRIMARY KEY NOT NULL,
	"tier" "plan" NOT NULL,
	"interval" "billing_interval" NOT NULL,
	"currency" text NOT NULL,
	"amount_minor" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "student_trials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"email_hash" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	CONSTRAINT "student_trials_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "student_trials_email_hash_unique" UNIQUE("email_hash")
);
--> statement-breakpoint
ALTER TABLE "student_trials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"user_id" uuid,
	"provider" "billing_provider" NOT NULL,
	"provider_subscription_id" text NOT NULL,
	"provider_customer_id" text,
	"plan_id" text NOT NULL,
	"status" "subscription_status" NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"next_charge_at" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"grace_until" timestamp with time zone,
	"grace_reminder_sent_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"has_scheduled_change" boolean DEFAULT false NOT NULL,
	"coupon_code" text,
	"coupon_redeemed_at" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subscriptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- entitlements: one row per grant instead of one per user (0005 created user_id as the
-- inline primary key, so Postgres named it entitlements_pkey). Existing rows become
-- "manual" grants (the dev-only plan:set script wrote them).
ALTER TABLE "entitlements" DROP CONSTRAINT "entitlements_pkey";--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "plan_locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "entitlements" ADD COLUMN "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "entitlements" ADD COLUMN "source" "entitlement_source" DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "entitlements" ADD COLUMN "source_id" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "entitlements" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "entitlements" ADD COLUMN "seats" integer;--> statement-breakpoint
ALTER TABLE "entitlements" ADD COLUMN "valid_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "entitlements" ADD COLUMN "expiry_processed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "entitlements" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "board_editor_seats" ADD CONSTRAINT "board_editor_seats_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_editor_seats" ADD CONSTRAINT "board_editor_seats_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_trials" ADD CONSTRAINT "student_trials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_events_provider_event_idx" ON "billing_events" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "board_editor_seats_user_id_idx" ON "board_editor_seats" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_provider_invoice_idx" ON "invoices" USING btree ("provider","provider_invoice_id");--> statement-breakpoint
CREATE INDEX "invoices_subscription_id_idx" ON "invoices" USING btree ("subscription_id");--> statement-breakpoint
CREATE INDEX "invoices_org_id_idx" ON "invoices" USING btree ("org_id","issued_at");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_provider_id_idx" ON "subscriptions" USING btree ("provider","provider_subscription_id");--> statement-breakpoint
CREATE INDEX "subscriptions_org_id_idx" ON "subscriptions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "subscriptions_user_id_idx" ON "subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_one_live_per_org" ON "subscriptions" USING btree ("org_id") WHERE "subscriptions"."status" in ('authenticated', 'active', 'past_due', 'halted');--> statement-breakpoint
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "entitlements_user_source_idx" ON "entitlements" USING btree ("user_id","source","source_id");--> statement-breakpoint
CREATE INDEX "entitlements_valid_until_idx" ON "entitlements" USING btree ("valid_until");;--> statement-breakpoint
-- The price list. Annual = 2 months free. Provider plan ids are server configuration.
INSERT INTO "plans" ("id", "tier", "interval", "currency", "amount_minor") VALUES
  ('pro_monthly', 'pro', 'month', 'INR', 39900),
  ('pro_yearly', 'pro', 'year', 'INR', 399000),
  ('team_monthly', 'team', 'month', 'INR', 99900),
  ('team_yearly', 'team', 'year', 'INR', 999000);