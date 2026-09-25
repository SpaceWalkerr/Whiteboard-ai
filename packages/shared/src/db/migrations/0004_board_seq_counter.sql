ALTER TABLE "boards" ADD COLUMN "last_seq" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Backfill: the counter must start above every seq already used, wherever it now lives
-- (the live log, the archive after compaction, or a snapshot's upper bound).
UPDATE "boards" AS b SET "last_seq" = GREATEST(
  COALESCE((SELECT max("seq") FROM "board_updates" WHERE "board_id" = b."id"), 0),
  COALESCE((SELECT max("seq") FROM "board_update_archive" WHERE "board_id" = b."id"), 0),
  COALESCE((SELECT max("seq_upto") FROM "board_snapshots" WHERE "board_id" = b."id"), 0)
);
