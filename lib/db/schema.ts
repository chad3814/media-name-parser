import {
  boolean, date, index, integer, jsonb, pgEnum, pgTable, primaryKey, real,
  text, timestamp, uniqueIndex, unique, uuid,
} from 'drizzle-orm/pg-core';

export const categoryEnum = pgEnum('category', ['tv', 'movies', 'books', 'xxx']);
export const mediaKindEnum = pgEnum('media_kind', [
  'movie', 'series', 'season', 'episode', 'book', 'scene',
]);
export const providerEnum = pgEnum('provider', ['tmdb', 'ibdb', 'tpdb']);
export const personRoleEnum = pgEnum('person_role', [
  'performer', 'director', 'producer', 'writer', 'author', 'illustrator', 'narrator',
]);
export const lookupStateEnum = pgEnum('lookup_state', ['resolved', 'unresolved', 'pending']);
export const jobStateEnum = pgEnum('job_state', ['pending', 'running', 'abandoned']);

// --- identity (Better Auth core plus the admin plugin) ----------------------
//
// Shapes and names are dictated by Better Auth, not chosen: singular table
// names, `text` primary keys because it generates its own string ids, a
// BOOLEAN `emailVerified`, and a `session` with both an `id` and a unique
// `token`. `role` is text rather than an enum because the admin plugin treats
// it as a string and supports comma-separated multiple roles.
// `test/db/schema.test.ts` checks all four against `getAuthTables()`.

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  role: text('role').notNull().default('user'),
  banned: boolean('banned').notNull().default(false),
  banReason: text('ban_reason'),
  banExpires: timestamp('ban_expires', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable('session', {
  id: text('id').primaryKey(),
  token: text('token').notNull(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  impersonatedBy: text('impersonated_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('session_token_idx').on(t.token),
  index('session_user_idx').on(t.userId),
]);

export const account = pgTable('account', {
  id: text('id').primaryKey(),
  issuer: text('issuer').notNull(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('account_user_idx').on(t.userId)]);

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('verification_identifier_idx').on(t.identifier)]);

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  tokenHash: text('token_hash').notNull(),
  prefix: text('prefix').notNull(),
  rateLimitPerMin: integer('rate_limit_per_min').notNull().default(60),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('api_keys_token_hash_idx').on(t.tokenHash), index('api_keys_user_idx').on(t.userId)]);

export const rateLimitWindows = pgTable('rate_limit_windows', {
  apiKeyId: uuid('api_key_id').notNull().references(() => apiKeys.id, { onDelete: 'cascade' }),
  windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
  count: integer('count').notNull().default(0),
}, (t) => [primaryKey({ columns: [t.apiKeyId, t.windowStart] })]);

// --- media -----------------------------------------------------------------

export const media = pgTable('media', {
  id: uuid('id').primaryKey().defaultRandom(),
  category: categoryEnum('category').notNull(),
  kind: mediaKindEnum('kind').notNull(),
  parentId: uuid('parent_id'),
  title: text('title').notNull(),
  sortTitle: text('sort_title').notNull(),
  originalTitle: text('original_title'),
  releaseDate: date('release_date'),
  year: integer('year'),
  overview: text('overview'),
  provider: providerEnum('provider').notNull(),
  providerRef: text('provider_ref').notNull(),
  raw: jsonb('raw').notNull(),
  rawFetchedAt: timestamp('raw_fetched_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('media_provider_ref_key').on(t.provider, t.providerRef),
  index('media_category_kind_idx').on(t.category, t.kind),
  index('media_parent_idx').on(t.parentId),
  index('media_sort_title_idx').on(t.sortTitle),
]);

export const movieDetails = pgTable('movie_details', {
  mediaId: uuid('media_id').primaryKey().references(() => media.id, { onDelete: 'cascade' }),
  runtimeMinutes: integer('runtime_minutes'),
  imdbId: text('imdb_id'),
  tagline: text('tagline'),
  collectionName: text('collection_name'),
});

export const seriesDetails = pgTable('series_details', {
  mediaId: uuid('media_id').primaryKey().references(() => media.id, { onDelete: 'cascade' }),
  firstAirDate: date('first_air_date'),
  lastAirDate: date('last_air_date'),
  status: text('status'),
});

export const seasonDetails = pgTable('season_details', {
  mediaId: uuid('media_id').primaryKey().references(() => media.id, { onDelete: 'cascade' }),
  seasonNumber: integer('season_number').notNull(),
});

export const episodeDetails = pgTable('episode_details', {
  mediaId: uuid('media_id').primaryKey().references(() => media.id, { onDelete: 'cascade' }),
  seasonNumber: integer('season_number').notNull(),
  episodeNumber: integer('episode_number').notNull(),
  airDate: date('air_date'),
});

export const bookDetails = pgTable('book_details', {
  mediaId: uuid('media_id').primaryKey().references(() => media.id, { onDelete: 'cascade' }),
  isbn13: text('isbn13'),
  isbn10: text('isbn10'),
  publisher: text('publisher'),
  publishedOn: date('published_on'),
  pageCount: integer('page_count'),
  language: text('language'),
});

export const sceneDetails = pgTable('scene_details', {
  mediaId: uuid('media_id').primaryKey().references(() => media.id, { onDelete: 'cascade' }),
  siteName: text('site_name'),
  /**
   * The provider's own site identifier, stored beside the display name.
   *
   * Derivable from `site_name` only by normalising it and hoping it matches a
   * `provider_sites.short_name`, which is a coincidence rather than a
   * guarantee. It is known exactly at write time, so it is written.
   */
  siteRef: text('site_ref'),
  durationSeconds: integer('duration_seconds'),
  releasedOn: date('released_on'),
});

export const people = pgTable('people', {
  id: uuid('id').primaryKey().defaultRandom(),
  provider: providerEnum('provider').notNull(),
  providerRef: text('provider_ref').notNull(),
  name: text('name').notNull(),
  sortName: text('sort_name').notNull(),
  aliases: text('aliases').array().notNull().default([]),
  birthdate: date('birthdate'),
  raw: jsonb('raw').notNull(),
  rawFetchedAt: timestamp('raw_fetched_at', { withTimezone: true }).notNull(),
}, (t) => [
  unique('people_provider_ref_key').on(t.provider, t.providerRef),
  index('people_sort_name_idx').on(t.sortName),
]);

export const mediaPeople = pgTable('media_people', {
  mediaId: uuid('media_id').notNull().references(() => media.id, { onDelete: 'cascade' }),
  personId: uuid('person_id').notNull().references(() => people.id, { onDelete: 'cascade' }),
  role: personRoleEnum('role').notNull(),
  characterName: text('character_name').notNull().default(''),
  billingOrder: integer('billing_order'),
}, (t) => [
  primaryKey({ columns: [t.mediaId, t.personId, t.role, t.characterName] }),
  index('media_people_person_idx').on(t.personId),
]);

// --- cache -----------------------------------------------------------------

export const parses = pgTable('parses', {
  category: categoryEnum('category').notNull(),
  normalizedKey: text('normalized_key').notNull(),
  tokens: jsonb('tokens').notNull(),
  parserVersion: integer('parser_version').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.category, t.normalizedKey] })]);

export const lookups = pgTable('lookups', {
  id: uuid('id').primaryKey().defaultRandom(),
  category: categoryEnum('category').notNull(),
  name: text('name').notNull(),
  normalizedKey: text('normalized_key').notNull(),
  mediaId: uuid('media_id').references(() => media.id, { onDelete: 'set null' }),
  confidence: real('confidence'),
  pinned: boolean('pinned').notNull().default(false),
  state: lookupStateEnum('state').notNull(),
  lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  hitCount: integer('hit_count').notNull().default(0),
  lastHitAt: timestamp('last_hit_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('lookups_category_name_key').on(t.category, t.name),
  index('lookups_parse_idx').on(t.category, t.normalizedKey),
  index('lookups_state_idx').on(t.state, t.lastAttemptAt),
]);

export const lookupJobs = pgTable('lookup_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  lookupId: uuid('lookup_id').notNull().references(() => lookups.id, { onDelete: 'cascade' }),
  state: jobStateEnum('state').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
  lockedAt: timestamp('locked_at', { withTimezone: true }),
  lockedBy: text('locked_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('lookup_jobs_lookup_idx').on(t.lookupId),
  index('lookup_jobs_due_idx').on(t.state, t.nextAttemptAt),
]);

export const providerSites = pgTable('provider_sites', {
  provider: providerEnum('provider').notNull(),
  providerRef: text('provider_ref').notNull(),
  shortName: text('short_name').notNull(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.provider, t.providerRef] }),
  unique('provider_sites_short_name_key').on(t.provider, t.shortName),
]);

export const providerCalls = pgTable('provider_calls', {
  id: uuid('id').primaryKey().defaultRandom(),
  provider: providerEnum('provider').notNull(),
  endpoint: text('endpoint').notNull(),
  status: integer('status').notNull(),
  durationMs: integer('duration_ms').notNull(),
  lookupId: uuid('lookup_id').references(() => lookups.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('provider_calls_created_idx').on(t.createdAt)]);
