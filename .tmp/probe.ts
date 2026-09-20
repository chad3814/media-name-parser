const key = process.env.TVDB_API_KEY ?? '';
if (key.length === 0) { console.error('no key'); process.exit(1); }
const BASE = 'https://api4.thetvdb.com/v4';
const login = await fetch(`${BASE}/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ apikey: key }),
});
console.log('POST /login ->', login.status);
if (!login.ok) { console.log(await login.text()); process.exit(1); }
const body = await login.json() as { status?: string; data?: { token?: string } };
const token = body.data?.token ?? '';
console.log('  status field:', body.status, '| token received:', token.length > 0 ? `yes (${token.length} chars)` : 'NO');
// Decode the JWT expiry without printing the token.
const payload = token.split('.')[1];
if (payload !== undefined) {
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { exp?: number; iat?: number };
  if (claims.exp !== undefined) {
    const days = (claims.exp * 1000 - Date.now()) / 86400000;
    console.log(`  token expires in ${days.toFixed(1)} days`);
  }
}
globalThis.TOKEN = token;
async function get(path: string): Promise<void> {
  const res = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
  let note = '';
  if (res.ok) {
    const j = await res.json() as { data?: unknown };
    const d = j.data;
    note = Array.isArray(d) ? `${d.length} items` : (d === null || d === undefined ? 'no data' : `object keys: ${Object.keys(d as object).slice(0,12).join(',')}`);
  }
  console.log(`GET ${path} -> ${res.status} ${note}`);
}
// Endpoints the published spec omits -- verify they exist.
await get('/series/121361');                       // Game of Thrones
await get('/series/121361/extended');
await get('/series/121361/episodes/default?season=1&episodeNumber=1');
await get('/episodes/3254641');
await get('/episodes/3254641/extended');
await get('/search?query=Game%20of%20Thrones&type=series');
await get('/search/remoteid/tt0944947');
