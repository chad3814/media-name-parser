const key = process.env.TVDB_API_KEY ?? '';
const BASE = 'https://api4.thetvdb.com/v4';
const r = await fetch(`${BASE}/login`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({apikey:key}) });
const token = ((await r.json()) as {data?:{token?:string}}).data?.token ?? '';
const get = async (p: string): Promise<unknown> => {
  const res = await fetch(`${BASE}${p}`, { headers: { authorization:`Bearer ${token}`, accept:'application/json' } });
  return ((await res.json()) as { data?: unknown }).data;
};
const ep = await get('/series/121361/episodes/default?season=1&episodeNumber=1') as { series?: Record<string,unknown>; episodes?: Array<Record<string,unknown>> };
console.log('=== episodes[0] ===');
console.log(JSON.stringify(ep.episodes?.[0], null, 1).slice(0, 900));
console.log('\n=== series (from that same response), selected keys ===');
const s = ep.series ?? {};
console.log(JSON.stringify({ id:s.id, name:s.name, slug:s.slug, firstAired:s.firstAired, lastAired:s.lastAired, status:s.status, overview:s.overview, year:s.year }, null, 1));
console.log('\n=== search result[0] ===');
const sr = await get('/search?query=Game%20of%20Thrones&type=series') as Array<Record<string,unknown>>;
console.log(JSON.stringify(sr[0], null, 1).slice(0, 900));
