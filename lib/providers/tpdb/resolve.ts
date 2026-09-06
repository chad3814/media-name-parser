import type { Category, ParsedVideo } from '../../parse/types';
import type {
  JsonValue, Provider, ResolveContext, ResolveOutcome, ResolvedMedia, ResolvedPerson,
} from '../types';
import { titleSimilarity } from '../../resolve/confidence';
import { normalizeSiteName } from '../../parse/normalize';
import { logFailure } from '../../http/log';
import { withTransaction } from '../../db/client';
import { sortTitleOf } from '../tmdb/normalize';
import type { TpdbClient } from './client';
import { sceneListSchema, sceneOneSchema, type TpdbScene } from './schema';
import { findSiteId, rememberSite, type RememberedSite } from './sites';

/**
 * What each strategy step earns, in the order the steps run.
 *
 * The two `q`-only bands sit below `CONFIDENCE_FLOOR` (0.75) deliberately: a
 * free-text search with nothing corroborating it is a suggestion, and belongs
 * in the admin browser's low band until a human pins it. The date bands sit
 * above the floor because `site_id` plus an exact date is very nearly a
 * primary key on this API -- the worked example returns exactly one row.
 */
const EXACT_DATE = 0.98;
const DATE_ONE_DAY_OUT = 0.90;
const TEXT_WITH_SITE = 0.85;
/**
 * The parsed site named the brand above the scene's site rather than the site
 * itself -- `RealityKings...` for a scene on RK Prime. Still corroboration by
 * a field outside the search, so it clears the floor, but weaker than a leaf
 * match: Reality Kings spans 56 sites, so the title carries more of the
 * weight. Without this band the correct scene is found and then discarded at
 * 0.70 for failing to match a name it was never going to match.
 */
const TEXT_WITH_PARENT = 0.80;
const TEXT_SINGLE = 0.70;
const TEXT_BEST_OF_MANY = 0.60;

/**
 * A day either side of the parsed date, in UTC.
 *
 * `new Date('2022-07-07')` parses as midnight UTC but `setDate`/`getDate` read
 * the local zone, so west of Greenwich that pair silently lands on the
 * previous day. Everything here is the `*UTC*` form for that reason. This is
 * arithmetic on a string taken from the filename rather than a clock read, so
 * it stays deterministic -- and it lives in the provider, not the parser,
 * regardless.
 */
function shiftDay(iso: string, days: number): string {
  const at = new Date(`${iso}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/**
 * The site cache, behind an interface so the provider can be exercised
 * offline.
 *
 * `findSiteId`/`rememberSite` take a `Tx`, and `Provider.resolve` deliberately
 * runs outside the pipeline's transactions -- holding one across an HTTP call
 * would pin a pooled connection for its duration -- so each cache touch opens
 * its own short transaction.
 */
export interface TpdbSiteCache {
  find(shortName: string): Promise<string | null>;
  remember(site: RememberedSite): Promise<void>;
}

export function dbSiteCache(): TpdbSiteCache {
  return {
    find: (shortName) => withTransaction((tx) => findSiteId(tx, shortName)),
    remember: (site) => withTransaction((tx) => rememberSite(tx, site)),
  };
}

function textOrNull(value: string | null | undefined): string | null {
  return value === null || value === undefined || value.length === 0 ? null : value;
}

function yearOf(date: string | null): number | null {
  if (date === null) return null;
  const year = Number.parseInt(date.slice(0, 4), 10);
  return Number.isNaN(year) ? null : year;
}

/**
 * The one spelling both sides of the site join compare on.
 *
 * `short_name` on the API is bare alphanumerics (`passionhd`), while
 * `parseScene` hands back the filename's head with its tokens joined by
 * spaces (`Passion HD`, `Naughty America`, `2 Chicks Same Time`). Lowercasing
 * alone therefore never matched for a multi-token site -- 271 corpus names,
 * every one of them dated, so every one of them skipped the three indexed
 * date queries that should have scored them 0.98 and settled for an
 * uncorroborated text search below the floor. `findSiteId` and `rememberSite`
 * apply the same function, so reads and writes agree.
 */
function foldSite(name: string): string {
  return normalizeSiteName(name);
}

/**
 * Performers, in credited order.
 *
 * `name` is the name as credited on this scene and `parent.name` is the
 * canonical identity behind it. A filename carries the credited spelling, so
 * that is what is stored; `parent.id` is preferred as the ref so two credits
 * for one performer collapse onto a single `people` row.
 */
function peopleFrom(scene: TpdbScene): readonly ResolvedPerson[] {
  return scene.performers.map((performer, index) => ({
    providerRef: performer.parent?.id ?? performer.id,
    name: performer.name,
    role: 'performer' as const,
    characterName: null,
    billingOrder: index,
    raw: performer as unknown as JsonValue,
  }));
}

/** A scene has no ancestors, unlike an episode, so `parent` is always null. */
function normalizeScene(scene: TpdbScene): ResolvedMedia {
  const date = textOrNull(scene.date);
  return {
    category: 'xxx',
    kind: 'scene',
    provider: 'tpdb',
    providerRef: scene.id,
    title: scene.title,
    sortTitle: sortTitleOf(scene.title),
    originalTitle: null,
    releaseDate: date,
    year: yearOf(date),
    overview: textOrNull(scene.description),
    raw: scene as unknown as JsonValue,
    details: {
      movie: null,
      series: null,
      season: null,
      episode: null,
      scene: {
        siteName: scene.site?.name ?? null,
        siteRef: scene.site?.id === undefined ? null : String(scene.site.id),
        // Seconds. A 25-scene sample ran 1920 to 3060; the one row reporting
        // 60 is bad data in that row, not a value in minutes to be converted.
        durationSeconds: scene.duration ?? null,
        releasedOn: date,
      },
    },
    people: peopleFrom(scene),
    parent: null,
  };
}

/** A chosen scene and what it earned, before it is normalized. */
interface Match {
  readonly scene: TpdbScene;
  readonly confidence: number;
}

/** The closest title among several results. Ties keep the API's own order. */
function bestByTitle(scenes: readonly TpdbScene[], title: string): TpdbScene | null {
  let best: TpdbScene | null = null;
  let bestScore = -1;
  for (const scene of scenes) {
    const score = titleSimilarity(title, scene.title);
    if (score > bestScore) {
      best = scene;
      bestScore = score;
    }
  }
  return best;
}

async function searchScenes(
  client: TpdbClient,
  query: Record<string, string | number | undefined>,
  ctx: ResolveContext,
): Promise<readonly TpdbScene[]> {
  const list = await client.get('/scenes', query, sceneListSchema, ctx);
  return list === null ? [] : list.data;
}

/**
 * One `site_id` + `date` query. Exact dates only: `dateOperation` was tested
 * live with `>=`, `<=`, `gte`, `greater` and `after`, and every one of them
 * returned zero rows, so there is no range query and a day of tolerance costs
 * a whole extra call rather than a wider filter.
 */
async function byDate(
  client: TpdbClient, siteId: string, date: string, title: string,
  confidence: number, ctx: ResolveContext,
): Promise<Match | null> {
  const scenes = await searchScenes(client, { site_id: siteId, date }, ctx);
  const scene = bestByTitle(scenes, title);
  return scene === null ? null : { scene, confidence };
}

/**
 * The free-text fallback: an unknown site, a missing date, or a miss on all
 * three date queries.
 *
 * A result whose `site.short_name` equals the parsed site is corroborated by
 * something outside the search itself, and clears the floor. Nothing else here
 * is, which is the point.
 *
 * Two constraints on that band, both learned the hard way:
 *
 * The site narrows the candidates; it does not choose among them. Taking the
 * first same-site row and scoring it 0.85 -- above the floor, so the pipeline
 * writes it as `resolved` -- ignored the title entirely on the first lookup
 * for every one of ~1,350 distinct sites, which is the one lookup per site
 * that runs this path. The corroborated rows are filtered first and
 * `bestByTitle` picks among them.
 *
 * And a site match with no title to compare is not corroboration of a scene.
 * For the 29 corpus names whose parsed title is empty, `q` degenerates to the
 * site name alone, so *any* scene that site ever published would clear the
 * floor. With no title the band is not earned, and the weaker `q`-only bands
 * below -- both under the floor -- are the honest answer.
 */
async function byText(
  client: TpdbClient, site: string | null, title: string, ctx: ResolveContext,
): Promise<Match | null> {
  const q = [site ?? '', title].filter((part) => part.length > 0).join(' ');
  if (q.length === 0) return null;
  const scenes = await searchScenes(client, { q }, ctx);

  if (site !== null && title.length > 0) {
    const wanted = foldSite(site);
    const onSite = scenes.filter((s) => foldSite(s.site?.short_name ?? '') === wanted);
    const exact = bestByTitle(onSite, title);
    if (exact !== null) return { scene: exact, confidence: TEXT_WITH_SITE };

    // Fall back to the brand above the site. Checked only after the leaf, so a
    // filename naming the exact site never loses its stronger band.
    const underBrand = scenes.filter((s) =>
      foldSite(s.site?.parent?.short_name ?? '') === wanted
      || foldSite(s.site?.network?.short_name ?? '') === wanted);
    const brand = bestByTitle(underBrand, title);
    if (brand !== null) return { scene: brand, confidence: TEXT_WITH_PARENT };
  }

  const only = scenes.length === 1 ? scenes[0] : undefined;
  if (only !== undefined) return { scene: only, confidence: TEXT_SINGLE };

  const best = bestByTitle(scenes, title);
  return best === null ? null : { scene: best, confidence: TEXT_BEST_OF_MANY };
}

/**
 * Remembers the matched scene's site so the next lookup for it is one call.
 *
 * This is the whole point of the design: the first lookup for a site pays for
 * a text search, and every later one narrows by an indexed `site_id`. The
 * cache warms itself here and nowhere else -- there is no sync job -- so
 * skipping this leaves every site permanently cold.
 *
 * A failure is logged and swallowed, and that is deliberate: a cache must not
 * be able to fail the thing it caches. This is awaited before the outcome is
 * returned, so a throw used to propagate out of `provider.resolve` into the
 * pipeline, which discarded the scene it had already fetched, wrote `pending`,
 * and returned non-terminal -- so the sweeper repeated all four provider calls
 * and met the same write again.
 *
 * The trigger is still reachable however carefully the SQL is written. The
 * `ON CONFLICT` in `rememberSite` can name only one constraint and names
 * `(provider, provider_ref)`, while the table also carries
 * `UNIQUE (provider, short_name)`; the `DELETE` that guards it locks nothing
 * when there is no row to lock, so two concurrent resolves of different scenes
 * on the same new short name with different site ids can still raise. Making
 * the write non-fatal closes it for every constraint at once, and for an
 * unreachable database too.
 */
async function remember(sites: TpdbSiteCache, scene: TpdbScene): Promise<void> {
  const site = scene.site;
  if (site === null || site === undefined) return;
  try {
    await sites.remember({
      // Folded here as well as in `rememberSite`'s SQL. The lookup side folds
      // too, so the two must meet in the same spelling, and stating it at the
      // seam means a cache implementation that is not the database agrees.
      providerRef: String(site.id),
      shortName: foldSite(site.short_name),
      name: site.name,
    });
  } catch (error) {
    // Named by short name, never by anything carrying a credential.
    logFailure(`tpdb site cache write for ${foldSite(site.short_name)}`, error);
  }
}

export function createTpdbProvider(
  client: TpdbClient,
  sites: TpdbSiteCache = dbSiteCache(),
): Provider {
  return {
    name: 'tpdb',
    supports(category: Category): boolean {
      return category === 'xxx';
    },
    async resolve(parsed: ParsedVideo, ctx: ResolveContext): Promise<ResolveOutcome | null> {
      ctx.signal.throwIfAborted();
      // A non-scene parse means the caller filed this under `movies` or `tv`
      // and the filename named a TPDB scene, so the pipeline routed it here.
      // TPDB has one namespace, so unlike a bare TMDB id there is nothing
      // ambiguous to corroborate: the id addresses exactly one record.
      if (parsed.kind !== 'scene') {
        const foreign = parsed.externalId;
        if (foreign === undefined || foreign.source !== 'tpdb') return null;
        const one = await client.get(
          `/scenes/${encodeURIComponent(foreign.id)}`, {}, sceneOneSchema, ctx,
        );
        if (one === null) return null;
        await remember(sites, one.data);
        return { media: normalizeScene(one.data), confidence: 1 };
      }

      // An id names the scene outright. `/scenes/{id}` accepts the numeric
      // `_id`, the uuid, and the slug -- all three verified -- so whatever
      // form the filename carries is passed through as written. A `{tmdb-}` or
      // `{tvdb-}` id belongs to a provider this one does not serve and is
      // ignored rather than guessed at.
      //
      // A miss falls through to the ordinary strategy rather than failing: a
      // stale id beside a good site and date should still resolve.
      const named = parsed.externalId;
      if (named !== undefined && named.source === 'tpdb') {
        const one = await client.get(
          `/scenes/${encodeURIComponent(named.id)}`, {}, sceneOneSchema, ctx,
        );
        if (one !== null) {
          await remember(sites, one.data);
          return { media: normalizeScene(one.data), confidence: 1 };
        }
      }

      const { site, releasedOn, title } = parsed;
      // Folded at the seam, as `remember` folds on the way out: `findSiteId`
      // normalizes again in its SQL, but a cache implementation that is not
      // the database has to be handed the same spelling the write side stored.
      const siteId = site === null ? null : await sites.find(foldSite(site));

      // Ordered, first hit wins, one call each. A step whose inputs are absent
      // is skipped rather than failed, so an unknown site or an undated name
      // goes straight to the text search.
      let match: Match | null = null;
      if (siteId !== null && releasedOn !== null) {
        match = await byDate(client, siteId, releasedOn, title, EXACT_DATE, ctx);
        // Filenames are sometimes a day out in either direction, so a miss on
        // the exact date is not a miss on the scene -- but it is weaker
        // evidence and scores lower.
        match ??= await byDate(client, siteId, shiftDay(releasedOn, -1), title,
          DATE_ONE_DAY_OUT, ctx);
        match ??= await byDate(client, siteId, shiftDay(releasedOn, 1), title,
          DATE_ONE_DAY_OUT, ctx);
      }
      match ??= await byText(client, site, title, ctx);

      // Null, not a manufactured low-confidence guess: the pipeline records
      // that as `unresolved`, which is the honest outcome.
      if (match === null) return null;

      await remember(sites, match.scene);
      return { media: normalizeScene(match.scene), confidence: match.confidence };
    },
  };
}
