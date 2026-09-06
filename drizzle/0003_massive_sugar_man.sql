CREATE TYPE "public"."id_source" AS ENUM('tmdb', 'imdb', 'tvdb', 'tpdb');--> statement-breakpoint
CREATE TABLE "media_external_ids" (
	"media_id" uuid NOT NULL,
	"source" "id_source" NOT NULL,
	"ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_external_ids_source_ref_pk" PRIMARY KEY("source","ref")
);
--> statement-breakpoint
ALTER TABLE "media_external_ids" ADD CONSTRAINT "media_external_ids_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_external_ids_media_idx" ON "media_external_ids" USING btree ("media_id");--> statement-breakpoint
-- Backfill the imdb ids already sitting unindexed in the stored TMDB payloads.
-- Movie details carry `imdb_id`; nothing else can be recovered without a
-- provider call, so nothing else is attempted here.
INSERT INTO media_external_ids (media_id, source, ref)
SELECT m.id, 'imdb', m.raw->>'imdb_id'
  FROM media m
 WHERE m.provider = 'tmdb'
   AND m.raw->>'imdb_id' IS NOT NULL
   AND m.raw->>'imdb_id' <> ''
ON CONFLICT (source, ref) DO NOTHING;
