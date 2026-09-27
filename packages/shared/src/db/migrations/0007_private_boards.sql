ALTER TABLE "reviews" ALTER COLUMN "graph" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "is_private" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "encrypted_title" "bytea";--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "key_check" "bytea";--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_private_key_check" CHECK ("boards"."is_private" = ("boards"."key_check" is not null) and ("boards"."is_private" or "boards"."encrypted_title" is null));