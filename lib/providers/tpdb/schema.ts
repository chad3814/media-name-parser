import { z } from 'zod';

/**
 * Only the fields this slice reads. theporndb.net's scene resource carries
 * about 30 fields and adds more over time; validating the rest would mean
 * this schema starts rejecting valid responses the day the API grows. Every
 * field here is `.nullish()` unless verified present on every sampled row,
 * because real responses do omit fields.
 */
const performerSchema = z.object({
  id: z.string(),
  name: z.string(),
  parent: z.object({ id: z.string(), name: z.string() }).nullish(),
});

const siteSchema = z.object({
  id: z.number(),
  name: z.string(),
  short_name: z.string(),
});

export const sceneSchema = z.object({
  id: z.string(),
  title: z.string(),
  date: z.string().nullish(),
  /** Seconds, verified against a live 25-scene sample (min 1920, median 2340, max 3060). */
  duration: z.number().nullish(),
  description: z.string().nullish(),
  site_id: z.number().nullish(),
  site: siteSchema.nullish(),
  performers: z.array(performerSchema).default([]),
});

export const sceneListSchema = z.object({
  data: z.array(sceneSchema).default([]),
  meta: z.object({ total: z.number().nullish() }).nullish(),
});

export type TpdbScene = z.infer<typeof sceneSchema>;
