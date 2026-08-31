CREATE TABLE "provider_sites" (
	"provider" "provider" NOT NULL,
	"provider_ref" text NOT NULL,
	"short_name" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_sites_provider_provider_ref_pk" PRIMARY KEY("provider","provider_ref"),
	CONSTRAINT "provider_sites_short_name_key" UNIQUE("provider","short_name")
);
