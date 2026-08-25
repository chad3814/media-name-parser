CREATE TYPE "public"."category" AS ENUM('tv', 'movies', 'books', 'xxx');--> statement-breakpoint
CREATE TYPE "public"."job_state" AS ENUM('pending', 'running', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."lookup_state" AS ENUM('resolved', 'unresolved', 'pending');--> statement-breakpoint
CREATE TYPE "public"."media_kind" AS ENUM('movie', 'series', 'season', 'episode', 'book', 'scene');--> statement-breakpoint
CREATE TYPE "public"."person_role" AS ENUM('performer', 'director', 'producer', 'writer', 'author', 'illustrator', 'narrator');--> statement-breakpoint
CREATE TYPE "public"."provider" AS ENUM('tmdb', 'ibdb', 'tpdb');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"issuer" text NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"label" text NOT NULL,
	"token_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"rate_limit_per_min" integer DEFAULT 60 NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "book_details" (
	"media_id" uuid PRIMARY KEY NOT NULL,
	"isbn13" text,
	"isbn10" text,
	"publisher" text,
	"published_on" date,
	"page_count" integer,
	"language" text
);
--> statement-breakpoint
CREATE TABLE "episode_details" (
	"media_id" uuid PRIMARY KEY NOT NULL,
	"season_number" integer NOT NULL,
	"episode_number" integer NOT NULL,
	"air_date" date
);
--> statement-breakpoint
CREATE TABLE "lookup_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lookup_id" uuid NOT NULL,
	"state" "job_state" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lookups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category" "category" NOT NULL,
	"name" text NOT NULL,
	"normalized_key" text NOT NULL,
	"media_id" uuid,
	"confidence" real,
	"pinned" boolean DEFAULT false NOT NULL,
	"state" "lookup_state" NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"hit_count" integer DEFAULT 0 NOT NULL,
	"last_hit_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lookups_category_name_key" UNIQUE("category","name")
);
--> statement-breakpoint
CREATE TABLE "media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category" "category" NOT NULL,
	"kind" "media_kind" NOT NULL,
	"parent_id" uuid,
	"title" text NOT NULL,
	"sort_title" text NOT NULL,
	"original_title" text,
	"release_date" date,
	"year" integer,
	"overview" text,
	"provider" "provider" NOT NULL,
	"provider_ref" text NOT NULL,
	"raw" jsonb NOT NULL,
	"raw_fetched_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_provider_ref_key" UNIQUE("provider","provider_ref")
);
--> statement-breakpoint
CREATE TABLE "media_people" (
	"media_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"role" "person_role" NOT NULL,
	"character_name" text DEFAULT '' NOT NULL,
	"billing_order" integer,
	CONSTRAINT "media_people_media_id_person_id_role_character_name_pk" PRIMARY KEY("media_id","person_id","role","character_name")
);
--> statement-breakpoint
CREATE TABLE "movie_details" (
	"media_id" uuid PRIMARY KEY NOT NULL,
	"runtime_minutes" integer,
	"imdb_id" text,
	"tagline" text,
	"collection_name" text
);
--> statement-breakpoint
CREATE TABLE "parses" (
	"category" "category" NOT NULL,
	"normalized_key" text NOT NULL,
	"tokens" jsonb NOT NULL,
	"parser_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "parses_category_normalized_key_pk" PRIMARY KEY("category","normalized_key")
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "provider" NOT NULL,
	"provider_ref" text NOT NULL,
	"name" text NOT NULL,
	"sort_name" text NOT NULL,
	"aliases" text[] DEFAULT '{}' NOT NULL,
	"birthdate" date,
	"raw" jsonb NOT NULL,
	"raw_fetched_at" timestamp with time zone NOT NULL,
	CONSTRAINT "people_provider_ref_key" UNIQUE("provider","provider_ref")
);
--> statement-breakpoint
CREATE TABLE "provider_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "provider" NOT NULL,
	"endpoint" text NOT NULL,
	"status" integer NOT NULL,
	"duration_ms" integer NOT NULL,
	"lookup_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit_windows" (
	"api_key_id" uuid NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_limit_windows_api_key_id_window_start_pk" PRIMARY KEY("api_key_id","window_start")
);
--> statement-breakpoint
CREATE TABLE "scene_details" (
	"media_id" uuid PRIMARY KEY NOT NULL,
	"site_name" text,
	"duration_seconds" integer,
	"released_on" date
);
--> statement-breakpoint
CREATE TABLE "season_details" (
	"media_id" uuid PRIMARY KEY NOT NULL,
	"season_number" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "series_details" (
	"media_id" uuid PRIMARY KEY NOT NULL,
	"first_air_date" date,
	"last_air_date" date,
	"status" text
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"impersonated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"role" text DEFAULT 'user' NOT NULL,
	"banned" boolean DEFAULT false NOT NULL,
	"ban_reason" text,
	"ban_expires" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_details" ADD CONSTRAINT "book_details_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episode_details" ADD CONSTRAINT "episode_details_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lookup_jobs" ADD CONSTRAINT "lookup_jobs_lookup_id_lookups_id_fk" FOREIGN KEY ("lookup_id") REFERENCES "public"."lookups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lookups" ADD CONSTRAINT "lookups_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_people" ADD CONSTRAINT "media_people_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_people" ADD CONSTRAINT "media_people_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movie_details" ADD CONSTRAINT "movie_details_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_calls" ADD CONSTRAINT "provider_calls_lookup_id_lookups_id_fk" FOREIGN KEY ("lookup_id") REFERENCES "public"."lookups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_limit_windows" ADD CONSTRAINT "rate_limit_windows_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scene_details" ADD CONSTRAINT "scene_details_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "season_details" ADD CONSTRAINT "season_details_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_details" ADD CONSTRAINT "series_details_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_token_hash_idx" ON "api_keys" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "api_keys_user_idx" ON "api_keys" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lookup_jobs_lookup_idx" ON "lookup_jobs" USING btree ("lookup_id");--> statement-breakpoint
CREATE INDEX "lookup_jobs_due_idx" ON "lookup_jobs" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "lookups_parse_idx" ON "lookups" USING btree ("category","normalized_key");--> statement-breakpoint
CREATE INDEX "lookups_state_idx" ON "lookups" USING btree ("state","last_attempt_at");--> statement-breakpoint
CREATE INDEX "media_category_kind_idx" ON "media" USING btree ("category","kind");--> statement-breakpoint
CREATE INDEX "media_parent_idx" ON "media" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "media_sort_title_idx" ON "media" USING btree ("sort_title");--> statement-breakpoint
CREATE INDEX "media_people_person_idx" ON "media_people" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "people_sort_name_idx" ON "people" USING btree ("sort_name");--> statement-breakpoint
CREATE INDEX "provider_calls_created_idx" ON "provider_calls" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "session_token_idx" ON "session" USING btree ("token");--> statement-breakpoint
CREATE INDEX "session_user_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_parent_id_fk" FOREIGN KEY ("parent_id") REFERENCES "media"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "lookups" ADD CONSTRAINT "lookups_parse_fk" FOREIGN KEY ("category","normalized_key") REFERENCES "parses"("category","normalized_key") ON DELETE RESTRICT;
