CREATE TYPE "public"."plan" AS ENUM('free', 'pro', 'team');--> statement-breakpoint
CREATE TYPE "public"."review_status" AS ENUM('running', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"board_id" uuid,
	"review_id" uuid,
	"kind" text NOT NULL,
	"model" text NOT NULL,
	"status" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_creation_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd_micros" bigint DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"request_id" text,
	"fingerprint" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_usage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "entitlements" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"plan" "plan" DEFAULT 'free' NOT NULL,
	"ai_reviews_per_month_override" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "entitlements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"board_id" uuid NOT NULL,
	"requested_by" uuid,
	"status" "review_status" DEFAULT 'running' NOT NULL,
	"problem_statement" text DEFAULT '' NOT NULL,
	"requirements" text DEFAULT '' NOT NULL,
	"graph" jsonb NOT NULL,
	"graph_format_version" integer NOT NULL,
	"rule_findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"result" jsonb,
	"model" text NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "reviews" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_usage_created_at_idx" ON "ai_usage" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ai_usage_user_kind_idx" ON "ai_usage" USING btree ("user_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "reviews_board_id_idx" ON "reviews" USING btree ("board_id","created_at");--> statement-breakpoint
CREATE INDEX "reviews_requested_by_idx" ON "reviews" USING btree ("requested_by","created_at");