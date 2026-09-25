CREATE TABLE "board_snapshots" (
	"board_id" uuid NOT NULL,
	"seq_upto" bigint NOT NULL,
	"state" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "board_snapshots_board_id_seq_upto_pk" PRIMARY KEY("board_id","seq_upto")
);
--> statement-breakpoint
ALTER TABLE "board_snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "board_update_archive" (
	"board_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"update" "bytea" NOT NULL,
	"client_id" bigint,
	"user_id" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "board_update_archive_board_id_seq_pk" PRIMARY KEY("board_id","seq")
);
--> statement-breakpoint
ALTER TABLE "board_update_archive" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "board_updates" (
	"board_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"update" "bytea" NOT NULL,
	"client_id" bigint,
	"user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "board_updates_board_id_seq_pk" PRIMARY KEY("board_id","seq")
);
--> statement-breakpoint
ALTER TABLE "board_updates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "boards" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid,
	"title" text DEFAULT 'Untitled board' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "boards" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "board_snapshots" ADD CONSTRAINT "board_snapshots_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_update_archive" ADD CONSTRAINT "board_update_archive_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_updates" ADD CONSTRAINT "board_updates_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "boards_owner_id_idx" ON "boards" USING btree ("owner_id");