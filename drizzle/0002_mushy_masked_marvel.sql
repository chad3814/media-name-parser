ALTER TABLE "scene_details" ADD COLUMN "site_ref" text;--> statement-breakpoint
-- Backfill from the site cache. Scenes resolved before this column existed
-- know their site's display name; `provider_sites` knows the id under the
-- normalised short name. Matching them here saves those rows from being the
-- only ones that can never answer the question.
UPDATE scene_details d
   SET site_ref = s.provider_ref
  FROM provider_sites s
 WHERE d.site_ref IS NULL
   AND d.site_name IS NOT NULL
   AND s.provider = 'tpdb'
   AND s.short_name = lower(regexp_replace(d.site_name, '[^a-zA-Z0-9]', '', 'g'));
