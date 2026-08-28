/**
 * Cloudflare Worker — single sanitized endpoint for Model Value Map.
 *
 * GET /  (or /api) → { t, meta, models }
 *  - fetches OC pricing from https://models.dev/api.json (no key)
 *  - fetches AA intelligence from https://artificialanalysis.ai/api/v2/language/models/free (x-api-key: AA_API_KEY)
 *    paginated (page_size 200) — merges all pages
 *  - joins on AA_SLUG + dots→dashes normalization, validates every value,
 *    and returns the same sanitized shape as data.js / live.js buildModels
 *    so the page can render directly without flight parsing or client secrets.
 *
 * CORS: Access-Control-Allow-Origin: * — GH Pages fetches it directly.
 * Cache: CDN s-maxage 300 (5m), client max-age 60, plus internal Cache API.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

const CURATED_DOCS = ['https://opencode.ai/docs/go', 'https://opencode.ai/docs/zen'];

function extractCuratedIdsFromHtml(html) {
  const ids = new Set();
  if (!html || typeof html !== 'string') return ids;
  function isSpurious(low) {
    return low.includes('limit') || low.includes('http') || low.includes('requests per') || low.includes('endpoint') || low.includes('package') || low.includes('hour') || low.includes('weekly') || low.includes('monthly');
  }
  const tableRe = /<table[\s\S]*?<\/table>/gi;
  let tblMatch;
  while ((tblMatch = tableRe.exec(html))) {
    const tbl = tblMatch[0];
    const headerMatches = [...tbl.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)];
    const headers = headerMatches.map((m) => m[1].replace(/<[^>]+>/g, '').trim().toLowerCase());
    let colIdx = -1;
    for (let i = 0; i < headers.length; i++) if (headers[i].includes('model id')) { colIdx = i; break; }
    if (colIdx === -1) for (let i = 0; i < headers.length; i++) if (headers[i] === 'model') { colIdx = i; break; }
    if (colIdx === -1) continue;
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch;
    let first = true;
    while ((rowMatch = rowRe.exec(tbl))) {
      const rowHtml = rowMatch[1];
      if (first && rowHtml.includes('<th')) { first = false; continue; }
      first = false;
      const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
      const cells = [];
      let cMatch;
      while ((cMatch = cellRe.exec(rowHtml))) {
        const txt = cMatch[1].replace(/<[^>]+>/g, '').replace(/&#x[^;]+;/g, ' ').replace(/&[^;]+;/g, ' ').trim();
        cells.push(txt);
      }
      if (cells.length <= colIdx) continue;
      let raw = cells[colIdx].trim().replace(/:+$/, '').trim().replace(/\s*\([^)]*\)\s*$/, '').trim();
      if (!raw || raw.toLowerCase() === 'model' || raw.toLowerCase() === 'model id') continue;
      if (raw.length > 60 || raw.length < 2) continue;
      if (!/[a-zA-Z]/.test(raw)) continue;
      if (isSpurious(raw.toLowerCase())) continue;
      ids.add(raw);
    }
  }
  const liRe = /<li[^>]*>\s*<strong[^>]*>([\s\S]*?)<\/strong>/gi;
  let m;
  while ((m = liRe.exec(html))) {
    let raw = m[1].replace(/<[^>]+>/g, '').trim().replace(/:+$/, '').trim().replace(/\s*\([^)]*\)\s*$/, '').trim();
    if (!raw || raw.length > 60 || raw.length < 2) continue;
    if (!/[a-zA-Z]/.test(raw)) continue;
    if (isSpurious(raw.toLowerCase())) continue;
    ids.add(raw);
  }
  return ids;
}

async function fetchCuratedIds() {
  const sets = [];
  for (const url of CURATED_DOCS) {
    try {
      const res = await fetch(url, { headers: { 'Accept': 'text/html' }, cf: { cacheTtl: 300 } });
      if (!res.ok) continue;
      const html = await res.text();
      const ids = extractCuratedIdsFromHtml(html);
      if (ids.size) sets.push(ids);
    } catch (_) {}
  }
  if (sets.length === 0) return new Set();
  if (sets.length === 1) return sets[0];
  // intersection on normalized form
  const norm = (s) => s.toLowerCase().replace(/[\s\/\._]+/g, '-').replace(/-free$/, '');
  const setA = new Set([...sets[0]].map((s) => norm(s)));
  const setB = new Set([...sets[1]].map((s) => norm(s)));
  const interNorm = new Set([...setA].filter((x) => setB.has(x)));
  if (interNorm.size) {
    // return raw ids that correspond to inter (from first set's raw values that normalize to inter)
    const out = new Set();
    for (const raw of sets[0]) if (interNorm.has(norm(raw))) out.add(raw);
    for (const raw of sets[1]) if (interNorm.has(norm(raw))) out.add(raw);
    // also add normalized forms for convenience
    for (const n of interNorm) out.add(n);
    return out;
  }
  // fallback to union if intersection empty
  const all = new Set();
  for (const s of sets) for (const id of s) all.add(id);
  return all;
}

const AA_SLUG = {
  'deepseek-v4-flash': 'deepseek-v4-flash',
  'mimo-v2.5': 'mimo-v2-5-0424',
  'muse-spark-1.2-contributor': 'muse-spark-1-2',
  'nemotron-3-ultra': 'nvidia-nemotron-3-ultra-550b-a55b',
  'deepseek-v4-pro': 'deepseek-v4-pro',
  'hy3': 'hy3',
  'gpt-5.6-luna': 'gpt-5-6-luna',
  'nemotron-3.5-lightning': 'nemotron-3-5-lightning',
  'minimax-m3': 'minimax-m3',
  'glm-5.2': 'glm-5-2',
  'glm-5.3': 'glm-5-3',
  'mimo-v2.5-pro': 'mimo-v2-5-pro',
  'kimi-k2.7-code': 'kimi-k2-7-code',
  'kimi-k3': 'kimi-k3',
  'qwen3.7-plus': 'qwen3-7-plus',
  'command-a-plus': 'cohere-command-a',
  'claude-4-5-haiku-reasoning': 'claude-haiku-4-5',
  'claude-4-5-haiku': 'claude-haiku-4-5',
  'glm-5-3-flash': 'glm-5-3-flash',
  'glm-5.3-flash': 'glm-5-3-flash',
};

const CURATED_FALLBACK_IDS = Object.keys(AA_SLUG).concat(['ox-alpha', 'laguna-s-2.1', 'deepseek-v4-flash-vision-exp']);

const REVERSE_AA_SLUG = Object.fromEntries(Object.entries(AA_SLUG).map(([k, v]) => [v, k]));

function normSlug(id) {
  return (id || '').toLowerCase().replace(/[\/._]/g, '-');
}

// aggressive normalization: lowercase + any spaces/dots/underscores/slashes → dash, strip trailing -free
function dashNorm(id) {
  return (id || '').toLowerCase().replace(/[\s\/\._]+/g, '-').replace(/-free$/, '');
}

const FALLBACK_HUES = ['#3B5BDB', '#D9480F', '#0CA678', '#9C36B5', '#0C8599', '#C2255C', '#6741D9', '#E8890C', '#2F9E44'];
function hueFor(author) {
  let h = 0;
  const str = author || '';
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return FALLBACK_HUES[h % FALLBACK_HUES.length];
}

// ---------- AA keyless parsing (inert text — never executed) ----------
function extractFlight(html) {
  if (!html || typeof html !== 'string') return '';
  const re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
  let m, flight = '';
  while ((m = re.exec(html))) { try { flight += JSON.parse(m[1]); } catch (_) {} }
  return flight;
}

function matchBrace(text, start) {
  let depth = 0, inStr = false, esc = false;
  const limit = Math.min(start + 300000, text.length);
  for (let j = start; j < limit; j++) {
    const c = text[j];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') { depth--; if (depth === 0) return j; }
  }
  return -1;
}

function aaRecordFromObj(o) {
  if (!o || !o.slug || !o.shortName) return null;
  const idx = typeof o.intelligenceIndex === 'number' && Number.isFinite(o.intelligenceIndex) && o.intelligenceIndex >= 0 ? o.intelligenceIndex : null;
  if (idx == null) return null;
  const creator = (o.creator && (o.creator.name || o.creator.slug))
    || (o.model_creator && (o.model_creator.name || o.model_creator.slug)) || null;
  return {
    slug: o.slug,
    shortName: o.shortName,
    name: o.name || o.shortName,
    creator,
    creatorColor: (o.creator && o.creator.color) || null,
    intelligenceIndex: Math.round(idx * 100) / 100,
    effort: (o.effort && o.effort.label) || null,
    isOpenWeights: !!o.isOpenWeights,
    url: 'https://artificialanalysis.ai/models/' + o.slug,
  };
}

/** Full model records embedded in the AA flight payload (inert text). */
function scanAaFlightRecords(flight) {
  const out = new Map();
  const re = /\{"id":"[0-9a-f-]{36}","slug":"/g;
  let m;
  while ((m = re.exec(flight))) {
    const end = matchBrace(flight, m.index);
    if (end < 0) continue;
    try {
      const o = JSON.parse(flight.slice(m.index, end + 1));
      const rec = aaRecordFromObj(o);
      if (rec && !out.has(rec.slug)) out.set(rec.slug, rec);
    } catch (_) {}
  }
  return out;
}

/** Leaderboard rows embedded in the AA index JSON-LD datasets (inert text). */
function scanJsonLdScores(html) {
  const out = new Map();
  const re = /\{"label":"([^"]+)","intelligenceIndex":([0-9.]+),"detailsUrl":"\/models\/([^"]+)"\}/g;
  let m;
  while ((m = re.exec(html))) {
    const slug = m[3];
    const score = parseFloat(m[2]);
    if (!slug || !Number.isFinite(score)) continue;
    if (!out.has(slug)) {
      const rawLabel = m[1];
      out.set(slug, {
        slug,
        shortName: rawLabel.replace(/\s*\([^)]*\)\s*$/, '').trim(),
        name: rawLabel,
        creator: null,
        creatorColor: null,
        intelligenceIndex: Math.round(score * 100) / 100,
        effort: null,
        isOpenWeights: false,
        url: 'https://artificialanalysis.ai/models/' + slug,
      });
    }
  }
  return out;
}

/** Public AA index page → extra keyless scores (flight records ∪ JSON-LD rows). */
function extractAaIndexScores(html) {
  const map = scanAaFlightRecords(extractFlight(html));
  for (const [slug, rec] of scanJsonLdScores(html)) if (!map.has(slug)) map.set(slug, rec);
  return map;
}

/** Public AA per-model page → the model's own full record (or null). */
function extractAaModelPageRecord(html, slug) {
  if (!html || !slug) return null;
  return scanAaFlightRecords(extractFlight(html)).get(slug) || null;
}

/** Fill aaMap with keyless scores for slugs the keyed API omitted. */
function mergeAaScores(aaMap, extraMap) {
  for (const [slug, rec] of extraMap) if (!aaMap.has(slug)) aaMap.set(slug, rec);
}

// ---------- OC parsing (models.dev) ----------
function parseModelsDev(data) {
  const map = new Map();
  if (!data || typeof data !== 'object') return map;
  const firstParty = ['openai','anthropic','google','deepseek','meta','mistral','cohere','moonshot','moonshotai','zhipu','zhipuai','nvidia','xiaomi','alibaba','minimax','tencent','xai','stepfun','upstage'];
  const provKeys = Object.keys(data).sort((a,b)=>{
    const aPlan = a.includes('plan')||a.includes('coding');
    const bPlan = b.includes('plan')||b.includes('coding');
    if (aPlan!==bPlan) return aPlan?1:-1;
    const aP = firstParty.some(k=>a.includes(k))?0:1;
    const bP = firstParty.some(k=>b.includes(k))?0:1;
    return aP-bP;
  });
  for (const pk of provKeys) {
    const prov = data[pk];
    if (!prov || typeof prov !== 'object') continue;
    const models = prov.models;
    if (!models || typeof models !== 'object') continue;
    for (const mKey of Object.keys(models)) {
      const m = models[mKey];
      if (!m || typeof m !== 'object') continue;
      const cost = m.cost;
      if (!cost || typeof cost !== 'object') continue;
      const outCost = typeof cost.output === 'number' && Number.isFinite(cost.output) ? cost.output : null;
      if (outCost == null || outCost < 0) continue;
      const inCost = typeof cost.input === 'number' && Number.isFinite(cost.input) ? cost.input : null;
      const cacheRead = typeof cost.cache_read === 'number' && Number.isFinite(cost.cache_read) ? cost.cache_read : (typeof cost.cacheRead === 'number' && Number.isFinite(cost.cacheRead) ? cost.cacheRead : null);
      const cacheWrite = typeof cost.cache_write === 'number' && Number.isFinite(cost.cache_write) ? cost.cache_write : (typeof cost.cacheWrite === 'number' && Number.isFinite(cost.cacheWrite) ? cost.cacheWrite : null);
      const limitContext = m.limit && typeof m.limit.context === 'number' && Number.isFinite(m.limit.context) ? m.limit.context : null;
      const limitOutput = m.limit && typeof m.limit.output === 'number' && Number.isFinite(m.limit.output) ? m.limit.output : null;
      const info = {
        id: m.id || mKey,
        name: m.name || mKey,
        cost: { input: inCost, output: outCost, cacheRead, cacheWrite },
        limit: { context: limitContext, output: limitOutput },
        openWeights: m.open_weights != null ? !!m.open_weights : (m.openWeights != null ? !!m.openWeights : null),
        reasoning: !!m.reasoning,
      };
      const keysToSet = [m.id, mKey, normSlug(m.id||''), normSlug(mKey)].filter(Boolean);
      if (m.id && m.id.includes('/')) keysToSet.push(m.id.split('/').pop(), normSlug(m.id.split('/').pop()));
      if (mKey.includes('/')) keysToSet.push(mKey.split('/').pop(), normSlug(mKey.split('/').pop()));
      for (const k of keysToSet) {
        const ex = map.get(k);
        if (!ex || (ex.cost.output <= 0 && outCost > 0)) map.set(k, info);
      }
    }
  }
  return map;
}

// ---------- AA parsing (api/v2/language/models/free) ----------
function parseAaFree(pages) {
  const map = new Map();
  for (const page of pages) {
    const data = page && Array.isArray(page.data) ? page.data : [];
    for (const r of data) {
      if (!r || typeof r !== 'object') continue;
      const slug = r.slug;
      const shortName = r.name || r.slug;
      // free tier: evaluations.artificial_analysis_intelligence_index
      const idx = r.evaluations && typeof r.evaluations.artificial_analysis_intelligence_index === 'number' ? r.evaluations.artificial_analysis_intelligence_index : null;
      if (!slug || typeof idx !== 'number' || !Number.isFinite(idx) || idx < 0) continue;
      // allow 0? original validated >0 for plot, but keep 0 as valid record (will be filtered as not plottable)
      if (map.has(slug)) continue;
      const creator = r.model_creator && (r.model_creator.name || r.model_creator.slug) || null;
      // AA free doesn't expose creator color; fallback to hueFor
      map.set(slug, {
        slug,
        shortName,
        name: r.name || shortName,
        creator,
        creatorColor: null,
        intelligenceIndex: Math.round(idx * 100) / 100,
        effort: null, // free tier doesn't expose effort per variant
        isOpenWeights: false, // not in free pricing; keep false, worker could infer from OC openWeights
        url: 'https://artificialanalysis.ai/models/' + slug,
      });
    }
  }
  return map;
}

function buildModels(mdMap, aaMap, curatedDocsIds) {
  const out = [];
  const seen = new Set();

  // 1. AA models that are actually available at OpenCode (have OC pricing) — use OC id when reverse-mapped
  for (const [slug, aa] of aaMap) {
    const ocId = REVERSE_AA_SLUG[slug] || null;
    const effectiveId = ocId || slug;
    const lookupKey = ocId || AA_SLUG[slug] || normSlug(slug);
    const md = mdMap.get(ocId) || mdMap.get(normSlug(ocId||'')) || mdMap.get(lookupKey) || mdMap.get(slug) || mdMap.get(normSlug(slug)) || null;
    if (!md) continue; // not available at OpenCode — skip (prevents 600+ off-map noise)
    seen.add(effectiveId); seen.add(normSlug(effectiveId)); seen.add(slug); seen.add(normSlug(slug));
    const cost = md.cost.output;
    const author = aa.creator || null;
    const label = aa.shortName || md.name || slug;
    const contextWindowTokens = md.limit && md.limit.context || null;
    const reasoning = md ? md.reasoning : false;
    const openWeights = md.openWeights != null ? md.openWeights : !!aa.isOpenWeights;
    const plot = typeof cost === 'number' && cost > 0 && typeof aa.intelligenceIndex === 'number' && aa.intelligenceIndex > 0;
    const excludeReason = !plot ? (cost == null ? 'Missing pricing' : 'Missing intelligence score') : null;
    out.push({
      id: effectiveId,
      label,
      author,
      ocCostPerM: cost,
      ocCost: md.cost,
      intelligenceIndex: aa.intelligenceIndex,
      aa: { slug, name: aa.name, intelligenceIndex: aa.intelligenceIndex, effort: aa.effort, isOpenWeights: !!aa.isOpenWeights, url: aa.url },
      contextWindowTokens,
      reasoning,
      openWeights,
      plot,
      excludeReason,
      hue: aa.creatorColor || hueFor(author),
      weeklyTokensT: null,
      rank: null,
    });
  }

  // 2. curated OC-only models that have pricing but no AA score → keep as off-map (honest)
  //    Docs-derived roster (Go ∩ Zen, from fetchCuratedIds) + legacy curated ids.
  const pool = new Set(CURATED_FALLBACK_IDS);
  if (curatedDocsIds && curatedDocsIds.size) {
    for (const id of curatedDocsIds) pool.add(id);
  }
  for (const id of pool) {
    const variants = [id, normSlug(id), dashNorm(id), AA_SLUG[id], normSlug(AA_SLUG[id] || '')].filter(Boolean);
    if (variants.some((v) => seen.has(v) || seen.has(normSlug(v)) || seen.has(dashNorm(v)))) continue;
    if (variants.some((v) => aaMap.has(v) || aaMap.has(normSlug(v)) || aaMap.has(dashNorm(v)))) continue;
    const md = variants.map((v) => mdMap.get(v)).find(Boolean) || null;
    if (!md) continue;
    const cost = md.cost.output;
    const label = md.name || id;
    // prefer a clean canonical id (no provider slash, no whitespace, lowercase)
    const clean = (s) => /^[a-z0-9][a-z0-9._-]*$/i.test(s) && !s.includes('/') && !/\s/.test(s);
    let emitId = md.id || id;
    if (!clean(emitId)) {
      const base = String(md.id || '').split('/').pop();
      emitId = variants.find((v) => clean(v) && (v.toLowerCase() === base.toLowerCase() || dashNorm(v) === dashNorm(base)))
        || variants.find((v) => clean(v))
        || dashNorm(md.id || id);
    }
    emitId = String(emitId).toLowerCase();
    out.push({
      id: emitId,
      label,
      author: null,
      ocCostPerM: cost,
      ocCost: md.cost,
      intelligenceIndex: null,
      aa: null,
      contextWindowTokens: md.limit && md.limit.context || null,
      reasoning: !!md.reasoning,
      openWeights: md.openWeights,
      plot: false,
      excludeReason: 'Not scored on the Artificial Analysis Intelligence Index yet.',
      hue: hueFor(null),
      weeklyTokensT: null,
      rank: null,
    });
    seen.add(emitId); seen.add(normSlug(emitId)); seen.add(dashNorm(emitId));
  }

  return out;
}

async function fetchAaAll(env) {
  const key = env.AA_API_KEY || env.AA_API_KEY_FREE;
  if (!key) throw new Error('AA_API_KEY not configured — set via `wrangler secret put AA_API_KEY`');
  const base = 'https://artificialanalysis.ai/api/v2/language/models/free';
  const pages = [];
  let page = 1;
  let totalPages = 1;
  while (page <= totalPages) {
    const url = page === 1 ? base : `${base}?page=${page}`;
    const res = await fetch(url, { headers: { 'x-api-key': key, 'Accept': 'application/json' } });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`AA fetch page ${page} failed ${res.status}: ${txt.slice(0,200)}`);
    }
    const json = await res.json();
    pages.push(json);
    const pag = json.pagination;
    if (pag && typeof pag.total === 'number' && typeof pag.page_size === 'number') {
      totalPages = Math.ceil(pag.total / pag.page_size);
    } else if (json.data && json.data.length < 200) {
      totalPages = page; // last page
    }
    page++;
    if (page > 10) break; // safety
  }
  return pages;
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    const url = new URL(request.url);
    // curated ids endpoint — separate cache, CORS *, no key
    if (request.method === 'GET' && (url.pathname === '/curated' || url.pathname === '/api/curated' || url.pathname === '/v1/curated')) {
      try {
        const cache = caches.default;
        const cacheKey = new Request(url.origin + '/__curated_cache', request);
        const cached = await cache.match(cacheKey);
        if (cached) return cached;
        const ids = await fetchCuratedIds();
        const payload = { t: Date.now(), ids: [...ids] };
        const body = JSON.stringify(payload);
        const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=60, s-maxage=300', ...CORS };
        const resp = new Response(body, { status: 200, headers });
        ctx.waitUntil(cache.put(cacheKey, resp.clone()));
        return resp;
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        return new Response(JSON.stringify({ error: 'Failed to build curated list', detail: msg }), { status: 502, headers: { 'Content-Type': 'application/json', ...CORS } });
      }
    }
    try {
      const cache = caches.default;
      const cacheKey = new Request(url.origin + '/__worker_cache', request);
      let cached = await cache.match(cacheKey);
      // Optionally serve stale while revalidating via Cache API — keep simple: respect CDN s-maxage via headers
      // Fetch fresh in parallel; docs roster + keyless AA pages are best-effort (empty on failure)
      const [ocRes, aaPages, curatedIds, aaIndexHtml] = await Promise.all([
        fetch('https://models.dev/api.json', { headers: { 'Accept': 'application/json' }, cf: { cacheTtl: 300 } }),
        fetchAaAll(env),
        fetchCuratedIds(),
        fetch('https://artificialanalysis.ai/models', { headers: { 'Accept': 'text/html' }, cf: { cacheTtl: 300 } })
          .then((r) => (r.ok ? r.text() : '')).catch(() => ''),
      ]);

      if (!ocRes.ok) throw new Error(`OC fetch failed ${ocRes.status}`);
      const ocJson = await ocRes.json();
      const mdMap = parseModelsDev(ocJson);
      const aaMap = parseAaFree(aaPages);

      if (mdMap.size === 0 && aaMap.size === 0) throw new Error('Both sources empty');

      // tier 2: keyless index page scores (flight records + JSON-LD) for slugs the keyed API omitted
      mergeAaScores(aaMap, extractAaIndexScores(aaIndexHtml));

      // tier 3: per-model pages for curated roster models still missing a score (bounded, fail-soft)
      if (curatedIds && curatedIds.size) {
        const need = [];
        const seenSlugs = new Set();
        for (const id of curatedIds) {
          const slug = AA_SLUG[id] || dashNorm(id);
          if (!slug || seenSlugs.has(slug) || aaMap.has(slug)) continue;
          seenSlugs.add(slug);
          need.push(slug);
          if (need.length >= 10) break;
        }
        if (need.length) {
          const pages = await Promise.all(need.map((s) =>
            fetch('https://artificialanalysis.ai/models/' + encodeURIComponent(s), { headers: { 'Accept': 'text/html' }, cf: { cacheTtl: 300 } })
              .then((r) => (r.ok ? r.text() : '')).catch(() => ''),
          ));
          for (let i = 0; i < need.length; i++) {
            const rec = extractAaModelPageRecord(pages[i], need[i]);
            if (rec) aaMap.set(need[i], rec);
          }
        }
      }

      const models = buildModels(mdMap, aaMap, curatedIds);

      const payload = {
        t: Date.now(),
        meta: {
          retrieved: new Date().toISOString(),
          aaIndex: `Artificial Analysis Intelligence Index v4.1 (free tier + public pages, ${aaMap.size} models)`,
          ocModels: mdMap.size,
          sources: [
            { name: 'models.dev', url: 'https://models.dev/api.json' },
            { name: 'artificialanalysis.ai/api/v2/language/models/free', url: 'https://artificialanalysis.ai/api/v2/language/models/free' },
          ],
        },
        models,
      };

      const body = JSON.stringify(payload);
      const headers = {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=60, s-maxage=300',
        ...CORS,
      };
      const response = new Response(body, { status: 200, headers });
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
      return response;
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      return new Response(JSON.stringify({ error: 'Failed to build sanitized data', detail: msg }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', ...CORS },
      });
    }
  },
};

// Headless test seam: pure helpers only — no Cloudflare globals touched here.
export const __TEST__ = {
  parseAaFree,
  extractAaIndexScores,
  extractAaModelPageRecord,
  mergeAaScores,
  buildModels,
  parseModelsDev,
  extractCuratedIdsFromHtml,
  dashNorm,
};
