CREATE TYPE "public"."interview_role" AS ENUM('interviewer', 'candidate', 'observer');--> statement-breakpoint
CREATE TYPE "public"."interview_status" AS ENUM('active', 'ended');--> statement-breakpoint
CREATE TABLE "interview_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"interview_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"actor_id" uuid,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "interview_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "interview_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"interview_id" uuid NOT NULL,
	"author_id" uuid,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "interview_notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "interview_participants" (
	"interview_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "interview_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interview_participants_interview_id_user_id_pk" PRIMARY KEY("interview_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "interview_participants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "interview_scorecards" (
	"interview_id" uuid NOT NULL,
	"interviewer_id" uuid NOT NULL,
	"scores" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"recommendation" text,
	"summary" text DEFAULT '' NOT NULL,
	"submitted_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interview_scorecards_interview_id_interviewer_id_pk" PRIMARY KEY("interview_id","interviewer_id")
);
--> statement-breakpoint
ALTER TABLE "interview_scorecards" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "interview_share_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"interview_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "interview_share_links_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "interview_share_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "interviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"board_id" uuid NOT NULL,
	"started_by" uuid,
	"status" "interview_status" DEFAULT 'active' NOT NULL,
	"question" jsonb NOT NULL,
	"revealed_hints" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"duration_ms" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paused_at" timestamp with time zone,
	"paused_ms" bigint DEFAULT 0 NOT NULL,
	"ended_at" timestamp with time zone,
	"version" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "interviews" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "interview_id" uuid;--> statement-breakpoint
ALTER TABLE "interview_events" ADD CONSTRAINT "interview_events_interview_id_interviews_id_fk" FOREIGN KEY ("interview_id") REFERENCES "public"."interviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_notes" ADD CONSTRAINT "interview_notes_interview_id_interviews_id_fk" FOREIGN KEY ("interview_id") REFERENCES "public"."interviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_notes" ADD CONSTRAINT "interview_notes_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_participants" ADD CONSTRAINT "interview_participants_interview_id_interviews_id_fk" FOREIGN KEY ("interview_id") REFERENCES "public"."interviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_participants" ADD CONSTRAINT "interview_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_scorecards" ADD CONSTRAINT "interview_scorecards_interview_id_interviews_id_fk" FOREIGN KEY ("interview_id") REFERENCES "public"."interviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_scorecards" ADD CONSTRAINT "interview_scorecards_interviewer_id_users_id_fk" FOREIGN KEY ("interviewer_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_share_links" ADD CONSTRAINT "interview_share_links_interview_id_interviews_id_fk" FOREIGN KEY ("interview_id") REFERENCES "public"."interviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_share_links" ADD CONSTRAINT "interview_share_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "interview_events_interview_id_idx" ON "interview_events" USING btree ("interview_id","created_at");--> statement-breakpoint
CREATE INDEX "interview_notes_interview_id_idx" ON "interview_notes" USING btree ("interview_id","created_at");--> statement-breakpoint
CREATE INDEX "interview_participants_user_id_idx" ON "interview_participants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "interview_share_links_interview_id_idx" ON "interview_share_links" USING btree ("interview_id");--> statement-breakpoint
CREATE INDEX "interviews_board_id_idx" ON "interviews" USING btree ("board_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "interviews_one_active_per_board" ON "interviews" USING btree ("board_id") WHERE "interviews"."status" = 'active';--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_interview_id_interviews_id_fk" FOREIGN KEY ("interview_id") REFERENCES "public"."interviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reviews_interview_id_idx" ON "reviews" USING btree ("interview_id");