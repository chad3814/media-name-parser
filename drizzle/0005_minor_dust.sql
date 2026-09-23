CREATE TABLE "media_versions" (
	"a" uuid NOT NULL,
	"b" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_versions_a_b_pk" PRIMARY KEY("a","b"),
	CONSTRAINT "media_versions_ordered" CHECK ("media_versions"."a" < "media_versions"."b")
);
--> statement-breakpoint
CREATE TABLE "people_versions" (
	"a" uuid NOT NULL,
	"b" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "people_versions_a_b_pk" PRIMARY KEY("a","b"),
	CONSTRAINT "people_versions_ordered" CHECK ("people_versions"."a" < "people_versions"."b")
);
--> statement-breakpoint
CREATE TABLE "sites_versions" (
	"a" uuid NOT NULL,
	"b" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sites_versions_a_b_pk" PRIMARY KEY("a","b"),
	CONSTRAINT "sites_versions_ordered" CHECK ("sites_versions"."a" < "sites_versions"."b")
);
--> statement-breakpoint
ALTER TABLE "provider_sites" RENAME TO "sites";--> statement-breakpoint
ALTER TABLE "sites" DROP CONSTRAINT "provider_sites_provider_provider_ref_pk";--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "media_versions" ADD CONSTRAINT "media_versions_a_media_id_fk" FOREIGN KEY ("a") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_versions" ADD CONSTRAINT "media_versions_b_media_id_fk" FOREIGN KEY ("b") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people_versions" ADD CONSTRAINT "people_versions_a_people_id_fk" FOREIGN KEY ("a") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people_versions" ADD CONSTRAINT "people_versions_b_people_id_fk" FOREIGN KEY ("b") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites_versions" ADD CONSTRAINT "sites_versions_a_sites_id_fk" FOREIGN KEY ("a") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites_versions" ADD CONSTRAINT "sites_versions_b_sites_id_fk" FOREIGN KEY ("b") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_versions_b_idx" ON "media_versions" USING btree ("b");--> statement-breakpoint
CREATE INDEX "people_versions_b_idx" ON "people_versions" USING btree ("b");--> statement-breakpoint
CREATE INDEX "sites_versions_b_idx" ON "sites_versions" USING btree ("b");--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_provider_ref_key" UNIQUE("provider","provider_ref");