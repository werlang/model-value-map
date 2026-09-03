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

// Cache API entries have no built-in TTL, so bound staleness here to match
// the documented CDN s-maxage window (plus slack) — never serve a payload
// older than this, regardless of edge eviction behavior.
const MAX_CACHE_AGE_MS = 10 * 60 * 1000;

async function matchFresh(cache, cacheKey) {
  try {
    const hit = await cache.match(cacheKey);
    if (!hit) return null;
    const t = await hit.clone().json().then((j) => (j && j.t) || 0).catch(() => 0);
    const age = Date.now() - t;
    if (Number.isFinite(age) && age >= 0 && age < MAX_CACHE_AGE_MS) return hit;
    return null;
  } catch (_) { return null; }
}

// The Go docs table is the roster — every model listed there must appear on the page.
const CURATED_DOCS = ['https://opencode.ai/docs/go'];

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
  const all = new Set();
  for (const url of CURATED_DOCS) {
    try {
      const res = await fetch(url, { headers: { 'Accept': 'text/html' }, cf: { cacheTtl: 300 } });
      if (!res.ok) continue;
      const html = await res.text();
      const ids = extractCuratedIdsFromHtml(html);
      for (const id of ids) all.add(id);
    } catch (_) {}
  }
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
  if (!flight || typeof flight !== 'string') return out;
  // Phase 1: strict detailed records with id prefix (fast path for index pages)
  const reId = /\{"id":"[0-9a-f-]{36}","slug":"/g;
  let m;
  while ((m = reId.exec(flight))) {
    const end = matchBrace(flight, m.index);
    if (end < 0) continue;
    try {
      const o = JSON.parse(flight.slice(m.index, end + 1));
      const rec = aaRecordFromObj(o);
      if (rec && !out.has(rec.slug)) out.set(rec.slug, rec);
    } catch (_) {}
  }
  // Phase 2: lightweight per-model records that start with {"slug":" (no id) or inline model objects
  // Scan every {"slug":" occurrence and try to parse its enclosing object; aaRecordFromObj filters non-models.
  const reSlug = /\{"slug":"/g;
  while ((m = reSlug.exec(flight))) {
    const start = m.index;
    // skip if this occurrence was already covered by the id-prefixed scan (same start overlaps)
    // but cheap to re-parse; dedupe via map
    const end = matchBrace(flight, start);
    if (end < 0) continue;
    // avoid parsing huge surrounding arrays — limit size
    if (end - start > 50000) continue;
    try {
      const o = JSON.parse(flight.slice(start, end + 1));
      const rec = aaRecordFromObj(o);
      if (rec && !out.has(rec.slug)) out.set(rec.slug, rec);
    } catch (_) {}
  }
  return out;
}

/** Extract all AA slugs present in the flight payload (for alias resolution, regardless of score). */
function extractAllAaSlugs(flight) {
  const out = new Set();
  if (!flight || typeof flight !== 'string') return out;
  const re = /"slug":"([^"]+)"/g;
  let m;
  while ((m = re.exec(flight))) {
    const s = m[1];
    if (s && s.length >= 2 && s.length <= 80 && /^[a-z0-9][a-z0-9._-]*$/i.test(s)) out.add(s);
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
  const rec = scanAaFlightRecords(extractFlight(html)).get(slug);
  if (rec) return rec;
  // fallback: lightweight scan may have extracted with different parsing window — try second pass over raw html flight
  // already covered by scanAaFlightRecords above, so just return null
  return null;
}

/** Fill aaMap with keyless scores for slugs the keyed API omitted. */
function mergeAaScores(aaMap, extraMap) {
  for (const [slug, rec] of extraMap) if (!aaMap.has(slug)) aaMap.set(slug, rec);
}

// ---------- OC→AA resolver (automatic, no hand list required) ----------
function ocVariantsDash(id) {
  const d = dashNorm(id);
  const out = [d];
  let cur = d;
  while (cur.includes('-')) {
    const idx = cur.lastIndexOf('-');
    cur = cur.slice(0, idx);
    if (cur.length < 3) break;
    out.push(cur);
  }
  return out;
}

function aaLookupNorm(slug, aaMap) {
  if (!slug) return null;
  if (aaMap.has(slug)) return aaMap.get(slug);
  const d = dashNorm(slug);
  if (aaMap.has(d)) return aaMap.get(d);
  const n = normSlug(slug);
  if (aaMap.has(n)) return aaMap.get(n);
  return null;
}

function resolveAaSlugForOc(ocId, aaMap) {
  if (!ocId || !aaMap) return null;
  const d = dashNorm(ocId);
  // 1. explicit override (dash-normalized key)
  const over = AA_SLUG[ocId] || AA_SLUG[d] || AA_SLUG[normSlug(ocId)] || null;
  if (over) {
    const hit = aaLookupNorm(over, aaMap);
    if (hit) return hit.slug;
    // still consider over as candidate even if not yet scored — caller may fetch it
  }
  // 2. exact
  if (aaMap.has(d)) return d;
  if (aaMap.has(ocId)) return ocId;
  // 3. stripped suffixes (muse-spark-1-3-contributor → muse-spark-1-3)
  const vars = ocVariantsDash(ocId).slice(1);
  for (const v of vars) if (aaMap.has(v)) return v;
  // 4. prefix expansion: AA slug starts with OC dash + '-'  (qwen3-8-flash → qwen3-8-flash-next, mimo-v2-5 → mimo-v2-5-0424)
  //    and reverse: OC starts with AA slug + '-' (deepseek-v4-flash-vision-exp → deepseek-v4-flash-vision)
  let best = null;
  let bestDiff = Infinity;
  for (const slug of aaMap.keys()) {
    if (slug.startsWith(d + '-') || d.startsWith(slug + '-')) {
      const diff = Math.abs(slug.length - d.length);
      // prefer shorter diff; tie-break by preferring scored slugs that are not xhigh variants? keep stable
      if (diff < bestDiff) { best = slug; bestDiff = diff; }
    }
  }
  return best;
}

function resolveAaRecordForOc(ocId, aaMap) {
  const slug = resolveAaSlugForOc(ocId, aaMap);
  return slug ? aaMap.get(slug) : null;
}

// Exact = curator override or literal slug hit. Anything resolved through the
// stripped-suffix / prefix-expansion fuzzy tiers is a *different* AA model
// (glm-5.2 → glm-5, inkling-small → inkling) — usable as a closest-match
// signal, but must never be presented as the model's own score.
function resolveAaMatchForOc(ocId, aaMap) {
  if (!ocId || !aaMap) return null;
  const d = dashNorm(ocId);
  const over = AA_SLUG[ocId] || AA_SLUG[d] || AA_SLUG[normSlug(ocId)] || null;
  if (over) {
    const hit = aaLookupNorm(over, aaMap);
    if (hit) return { rec: hit, match: 'exact' };
  }
  if (aaMap.has(d)) return { rec: aaMap.get(d), match: 'exact' };
  if (aaMap.has(ocId)) return { rec: aaMap.get(ocId), match: 'exact' };
  const slug = resolveAaSlugForOc(ocId, aaMap);
  if (!slug) return null;
  const rec = aaMap.get(slug);
  return rec ? { rec, match: 'approximate' } : null;
}

function mdLookupForAa(aaSlug, mdMap) {
  if (!aaSlug || !mdMap) return null;
  if (mdMap.has(aaSlug)) return mdMap.get(aaSlug);
  const d = dashNorm(aaSlug);
  if (mdMap.has(d)) return mdMap.get(d);
  const n = normSlug(aaSlug);
  if (mdMap.has(n)) return mdMap.get(n);
  const rev = REVERSE_AA_SLUG[aaSlug] || REVERSE_AA_SLUG[d] || REVERSE_AA_SLUG[n] || null;
  if (rev) {
    if (mdMap.has(rev)) return mdMap.get(rev);
    if (mdMap.has(dashNorm(rev))) return mdMap.get(dashNorm(rev));
    if (mdMap.has(normSlug(rev))) return mdMap.get(normSlug(rev));
  }
  return null;
}

function resolveMdForAa(aaSlug, mdMap, curatedDashSet) {
  const direct = mdLookupForAa(aaSlug, mdMap);
  // collect all candidates that match via exact / stripped / prefix
  const d = dashNorm(aaSlug);
  const candidates = [];
  const seenMd = new Set();
  function addCand(md, kd, score) {
    if (!md || seenMd.has(md)) return;
    seenMd.add(md);
    candidates.push({ md, kd, score });
  }
  if (direct) addCand(direct, dashNorm(direct.id || aaSlug), 0);
  const vars = ocVariantsDash(aaSlug);
  for (const v of vars.slice(1)) {
    const hit = mdLookupForAa(v, mdMap);
    if (hit) addCand(hit, dashNorm(v), Math.abs(d.length - dashNorm(v).length) + 0.1);
  }
  // prefix search over OC keys
  for (const [k, v] of mdMap) {
    const kd = dashNorm(k);
    if (kd === d) {
      addCand(v, kd, 0);
    } else if (d.startsWith(kd + '-') || kd.startsWith(d + '-')) {
      const diff = Math.abs(d.length - kd.length);
      addCand(v, kd, diff + 0.5);
    }
  }
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0].md;
  // rank: prefer curated, then smallest diff, then prefer larger kd (more specific, e.g., contributor) when diff tied? For muse, both diff 0 vs 12? Let's compute
  // curatedDashSet gives priority to Go-listed variants
  candidates.sort((a, b) => {
    const aCur = curatedDashSet && curatedDashSet.has(a.kd) ? 0 : 1;
    const bCur = curatedDashSet && curatedDashSet.has(b.kd) ? 0 : 1;
    if (aCur !== bCur) return aCur - bCur;
    if (a.score !== b.score) return a.score - b.score;
    // tie-break: longer (more specific) first for contributor case where AA is prefix of OC
    return b.kd.length - a.kd.length;
  });
  return candidates[0].md;
}

function bestFetchSlugForOc(ocId, allSlugs) {
  if (!ocId || !allSlugs) return dashNorm(ocId);
  const d = dashNorm(ocId);
  const over = AA_SLUG[ocId] || AA_SLUG[d] || AA_SLUG[normSlug(ocId)] || null;
  if (over && allSlugs.has(over)) return over;
  if (allSlugs.has(d)) return d;
  const vars = ocVariantsDash(ocId).slice(1);
  for (const v of vars) if (allSlugs.has(v)) return v;
  let best = null;
  let bestDiff = Infinity;
  for (const s of allSlugs) {
    if (s.startsWith(d + '-') || d.startsWith(s + '-')) {
      const diff = Math.abs(s.length - d.length);
      if (diff < bestDiff) { best = s; bestDiff = diff; }
    }
  }
  return best || d;
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
      const keysToSet = [m.id, mKey, normSlug(m.id||''), normSlug(mKey), dashNorm(m.id||''), dashNorm(mKey)].filter(Boolean);
      if (m.id && m.id.includes('/')) {
        const base = m.id.split('/').pop();
        keysToSet.push(base, normSlug(base), dashNorm(base));
      }
      if (mKey.includes('/')) {
        const base2 = mKey.split('/').pop();
        keysToSet.push(base2, normSlug(base2), dashNorm(base2));
      }
      for (const k of keysToSet) {
        const ex = map.get(k);
        if (!ex || (ex.cost.output <= 0 && outCost > 0)) map.set(k, info);
        // also ensure dash/norm variants of the key are independently reachable
        const dk = dashNorm(k);
        if (dk && dk !== k && !map.has(dk)) map.set(dk, info);
        const nk = normSlug(k);
        if (nk && nk !== k && nk !== dk && !map.has(nk)) map.set(nk, info);
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

// ---------- OpenRouter parsing (openrouter.ai/api/v1/models) ----------
// Free = $0 prompt AND $0 completion. Pricing arrives as USD-per-token
// strings (e.g. '0.0000002' = $0.20/1M); '0' means free.
function orBaseId(id) {
  const s = String(id || '');
  const afterSlash = s.includes('/') ? s.split('/').pop() : s;
  return afterSlash.split(':')[0].toLowerCase();
}

function orProvider(id) {
  const s = String(id || '');
  return s.includes('/') ? s.split('/')[0] : null;
}

function orPriceToNumber(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function parseOpenRouter(data) {
  const list = [];
  const map = new Map();
  if (!data || typeof data !== 'object' || !Array.isArray(data.data)) return { list, map };
  const seenBase = new Set();
  for (const m of data.data) {
    if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !m.id) continue;
    const pricing = (m.pricing && typeof m.pricing === 'object') ? m.pricing : {};
    if (orPriceToNumber(pricing.prompt) !== 0 || orPriceToNumber(pricing.completion) !== 0) continue;
    const base = orBaseId(m.id);
    if (!base || base.length < 2 || base.length > 80) continue;
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(base)) continue;
    if (seenBase.has(base)) continue;
    seenBase.add(base);
    const provider = orProvider(m.id);
    let author = null;
    if (typeof m.name === 'string' && m.name.includes(':')) author = m.name.split(':')[0].trim() || null;
    if (!author && provider) author = provider.charAt(0).toUpperCase() + provider.slice(1);
    const topProvider = (m.top_provider && typeof m.top_provider === 'object') ? m.top_provider : {};
    const info = {
      orId: m.id,
      id: base,
      name: (typeof m.name === 'string' && m.name) || base,
      author,
      provider,
      cost: { input: 0, output: 0, cacheRead: orPriceToNumber(pricing.input_cache_read), cacheWrite: null },
      limit: {
        context: (typeof m.context_length === 'number' && Number.isFinite(m.context_length)) ? m.context_length : null,
        output: (typeof topProvider.max_completion_tokens === 'number' && Number.isFinite(topProvider.max_completion_tokens)) ? topProvider.max_completion_tokens : null,
      },
      openWeights: null,
      reasoning: !!m.reasoning,
    };
    list.push(info);
    const keys = [m.id, base, normSlug(m.id), normSlug(base), dashNorm(m.id), dashNorm(base)];
    for (const k of keys) if (k && !map.has(k)) map.set(k, info);
  }
  return { list, map };
}

// 'Z.ai: GLM 5.2 (free)' → 'GLM 5.2' — the name users recognize from OpenRouter.
function orDisplayName(e) {
  let n = (e && typeof e.name === 'string') ? e.name.trim() : '';
  const ci = n.indexOf(':');
  if (ci > 0 && ci <= 24) n = n.slice(ci + 1).trim();
  n = n.replace(/\s*\(free\)\s*$/i, '').trim();
  return n || ((e && e.id) ? String(e.id) : '');
}

// Join free OpenRouter models with AA intelligence (same sanitized shape as
// buildModels). Cost is always $0/1M, which a log scale cannot show, so every
// entry is plot:false — scored models land in the "Off the map" tray with an
// explicit free reason instead of being silently dropped.
function buildOpenRouterFreeModels(orList, aaMap) {
  const out = [];
  const arr = Array.isArray(orList) ? orList : [];
  for (const e of arr) {
    if (!e || !e.id) continue;
    const base = String(e.id).toLowerCase();
    const found = resolveAaMatchForOc(base, aaMap);
    const aaRec = found ? found.rec : null;
    const match = found ? found.match : null;
    const hasScore = !!(aaRec && typeof aaRec.intelligenceIndex === 'number' && Number.isFinite(aaRec.intelligenceIndex) && aaRec.intelligenceIndex > 0);
    const author = (aaRec && aaRec.creator) || e.author || null;
    // Exact: the benchmark's canonical name. Approximate: the OpenRouter
    // name, so the bar is recognizable as the model the user looked for.
    const label = !hasScore ? (e.name || base)
      : match === 'exact' ? (aaRec.shortName || orDisplayName(e) || base)
      : (orDisplayName(e) || aaRec.shortName || base);
    out.push({
      id: base,
      label,
      author,
      orId: e.orId || null,
      ocCostPerM: 0,
      ocCost: e.cost || { input: 0, output: 0, cacheRead: null, cacheWrite: null },
      intelligenceIndex: hasScore ? aaRec.intelligenceIndex : null,
      aa: aaRec ? { slug: aaRec.slug, name: aaRec.name || aaRec.shortName, intelligenceIndex: aaRec.intelligenceIndex, effort: aaRec.effort || null, isOpenWeights: !!aaRec.isOpenWeights, url: aaRec.url, match } : null,
      contextWindowTokens: (e.limit && e.limit.context) || null,
      reasoning: !!e.reasoning,
      openWeights: e.openWeights != null ? e.openWeights : (aaRec ? !!aaRec.isOpenWeights : null),
      plot: false,
      excludeReason: hasScore
        ? 'Free on OpenRouter — $0/1M output (off the log cost scale).'
        : 'Not scored on the Artificial Analysis Intelligence Index yet.',
      hue: (aaRec && aaRec.creatorColor) || hueFor(author),
      weeklyTokensT: null,
      rank: null,
    });
  }
  out.sort((a, b) => {
    const sa = a.aa ? a.aa.intelligenceIndex : -1;
    const sb = b.aa ? b.aa.intelligenceIndex : -1;
    if (sb !== sa) return sb - sa;
    return String(a.label).localeCompare(String(b.label));
  });
  return out;
}

function buildModels(mdMap, aaMap, curatedDocsIds) {
  const out = [];
  const seen = new Set();
  const poolForCurated = (curatedDocsIds && curatedDocsIds.size) ? curatedDocsIds : new Set(CURATED_FALLBACK_IDS);
  const curatedDashSet = new Set([...poolForCurated].map((id) => dashNorm(id)));

  // 1. AA models that are actually available at OpenCode (have OC pricing) — use OC id when reverse-mapped or fuzzy-matched
  for (const [slug, aa] of aaMap) {
    const md = resolveMdForAa(slug, mdMap, curatedDashSet);
    if (!md) continue; // not available at OpenCode — skip (prevents 600+ off-map noise)
    // effective OC id: prefer reverse alias, then resolved OC key (curated-aware), then AA slug
    let ocId = REVERSE_AA_SLUG[slug] || REVERSE_AA_SLUG[dashNorm(slug)] || null;
    if (!ocId) {
      // use the same curated-aware resolution that chose md to pick the best OC key
      const candidates = [];
      const d = dashNorm(slug);
      for (const [k] of mdMap) {
        const kd = dashNorm(k);
        if (kd === d) { candidates.push({ k, kd, score: 0 }); }
        else if (d.startsWith(kd + '-') || kd.startsWith(d + '-')) {
          candidates.push({ k, kd, score: Math.abs(d.length - kd.length) + 0.5 });
        }
      }
      // stripped AA variants
      if (!candidates.length) {
        const vars = ocVariantsDash(slug).slice(1);
        for (const v of vars) {
          if (mdMap.has(v)) { candidates.push({ k: v, kd: dashNorm(v), score: Math.abs(d.length - dashNorm(v).length) + 0.1 }); break; }
          if (mdMap.has(dashNorm(v))) { candidates.push({ k: dashNorm(v), kd: dashNorm(v), score: Math.abs(d.length - dashNorm(v).length) + 0.1 }); break; }
        }
      }
      if (candidates.length) {
        candidates.sort((a, b) => {
          const aCur = curatedDashSet.has(a.kd) ? 0 : 1;
          const bCur = curatedDashSet.has(b.kd) ? 0 : 1;
          if (aCur !== bCur) return aCur - bCur;
          if (a.score !== b.score) return a.score - b.score;
          return b.kd.length - a.kd.length;
        });
        ocId = candidates[0].k;
      }
      // fallback to md.id if no candidate (should not happen since md exists)
      if (!ocId && md && md.id) ocId = md.id;
    }
    const effectiveIdRaw = ocId || md.id || slug;
    const effectiveId = String(effectiveIdRaw).toLowerCase();
    // dedupe: if we already emitted this OC model via another AA variant, keep highest intelligenceIndex
    // For now, emit per AA slug but use seen to avoid duplicate effectiveIds with lower score?
    // We add all, but track seen by effectiveId dash to allow multiple AA effort variants? Original emitted per AA slug; keep that.
    // To avoid duplicate off-map, just add to seen set broad
    const cost = md.cost.output;
    const author = aa.creator || null;
    const label = aa.shortName || md.name || slug;
    const contextWindowTokens = md.limit && md.limit.context || null;
    const reasoning = md ? md.reasoning : false;
    const openWeights = md.openWeights != null ? md.openWeights : !!aa.isOpenWeights;
    const plot = typeof cost === 'number' && cost > 0 && typeof aa.intelligenceIndex === 'number' && aa.intelligenceIndex > 0;
    const excludeReason = !plot ? (cost == null ? 'Missing pricing' : 'Missing intelligence score') : null;
    // avoid emitting duplicate effectiveId if already plotted with same cost — keep highest intelligence
    const seenKey = dashNorm(effectiveId);
    if (seen.has(seenKey) && plot) {
      // check existing entry for same effectiveId
      const existing = out.find((x) => dashNorm(x.id) === seenKey && x.plot);
      if (existing && existing.aa.intelligenceIndex >= aa.intelligenceIndex) continue;
      // replace weaker variant
      if (existing) {
        const idx = out.indexOf(existing);
        if (idx !== -1) out.splice(idx, 1);
      }
    }
    seen.add(effectiveId); seen.add(normSlug(effectiveId)); seen.add(dashNorm(effectiveId)); seen.add(slug); seen.add(normSlug(slug)); seen.add(dashNorm(slug));
    if (ocId) { seen.add(ocId); seen.add(normSlug(ocId)); seen.add(dashNorm(ocId)); }
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

  // 2. Roster models the join missed → keep as off-map (honest), never silently dropped.
  //    Roster = docs-derived Go table (from fetchCuratedIds); legacy ids only when docs are unreachable.
  const pool = poolForCurated;
  for (const id of pool) {
    const d = dashNorm(id);
    const over = AA_SLUG[id] || AA_SLUG[d] || AA_SLUG[normSlug(id)] || null;
    const variants = [id, normSlug(id), d, over, over ? normSlug(over) : null, over ? dashNorm(over) : null].filter(Boolean);
    // also add stripped variants of d for seen check
    const strippedVars = ocVariantsDash(id);
    const allVariants = [...new Set([...variants, ...strippedVars, ...strippedVars.map(normSlug)])];
    if (allVariants.some((v) => seen.has(v) || seen.has(normSlug(v)) || seen.has(dashNorm(v)))) continue;
    // also check if any variant resolves to a scored AA via fuzzy
    const fuzzySlug = resolveAaSlugForOc(id, aaMap);
    if (fuzzySlug && (seen.has(fuzzySlug) || seen.has(dashNorm(fuzzySlug)) || seen.has(normSlug(fuzzySlug)))) continue;
    const md = variants.map((v) => mdMap.get(v)).find(Boolean) || resolveMdForAa(d, mdMap) || null;
    // prefer fuzzy AA match over exact variant
    let aaRec = variants.map((v) => aaLookupNorm(v, aaMap)).find(Boolean) || null;
    if (!aaRec) aaRec = resolveAaRecordForOc(id, aaMap) || null;
    if (!md && !aaRec) continue; // in no source at all — nothing honest to show
    // prefer a clean canonical id (no provider slash, no whitespace, lowercase)
    const clean = (s) => /^[a-z0-9][a-z0-9._-]*$/i.test(s) && !s.includes('/') && !/\s/.test(s);
    let emitId = (md && md.id) || id;
    if (!clean(emitId)) {
      const base = String(emitId || '').split('/').pop();
      emitId = allVariants.find((v) => clean(v) && (v.toLowerCase() === base.toLowerCase() || dashNorm(v) === dashNorm(base)))
        || allVariants.find((v) => clean(v))
        || d;
    }
    emitId = String(emitId).toLowerCase();
    const cost = md ? md.cost.output : null;
    const label = (md && md.name) || (aaRec && aaRec.shortName) || id;
    // if we have a fuzzy match but no md, still use aaRec; if we have md but aaRec from fuzzy, promote to plotted if possible
    const canPlot = md && aaRec && typeof cost === 'number' && cost > 0 && typeof aaRec.intelligenceIndex === 'number' && aaRec.intelligenceIndex > 0;
    if (canPlot) {
      out.push({
        id: emitId,
        label: aaRec.shortName || label,
        author: aaRec.creator || null,
        ocCostPerM: cost,
        ocCost: md.cost,
        intelligenceIndex: aaRec.intelligenceIndex,
        aa: { slug: aaRec.slug, name: aaRec.name || aaRec.shortName, intelligenceIndex: aaRec.intelligenceIndex, effort: aaRec.effort || null, isOpenWeights: !!aaRec.isOpenWeights, url: aaRec.url },
        contextWindowTokens: md && md.limit && md.limit.context || null,
        reasoning: md ? !!md.reasoning : false,
        openWeights: md && md.openWeights != null ? md.openWeights : (aaRec ? !!aaRec.isOpenWeights : false),
        plot: true,
        excludeReason: null,
        hue: aaRec.creatorColor || hueFor(aaRec.creator),
        weeklyTokensT: null,
        rank: null,
      });
      seen.add(emitId); seen.add(normSlug(emitId)); seen.add(dashNorm(emitId));
      seen.add(aaRec.slug); seen.add(dashNorm(aaRec.slug)); seen.add(normSlug(aaRec.slug));
      continue;
    }
    out.push({
      id: emitId,
      label,
      author: aaRec ? aaRec.creator : null,
      ocCostPerM: cost,
      ocCost: md ? md.cost : null,
      intelligenceIndex: aaRec ? aaRec.intelligenceIndex : null,
      aa: aaRec ? { slug: aaRec.slug, name: aaRec.name || aaRec.shortName, intelligenceIndex: aaRec.intelligenceIndex, effort: aaRec.effort || null, isOpenWeights: !!aaRec.isOpenWeights, url: aaRec.url } : null,
      contextWindowTokens: md && md.limit && md.limit.context || null,
      reasoning: md ? !!md.reasoning : false,
      openWeights: md && md.openWeights != null ? md.openWeights : (aaRec ? !!aaRec.isOpenWeights : false),
      plot: false,
      excludeReason: !md ? 'Missing pricing' : 'Not scored on the Artificial Analysis Intelligence Index yet.',
      hue: hueFor(aaRec ? aaRec.creator : null),
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
        const cached = await matchFresh(cache, cacheKey);
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
    // Free OpenRouter models joined with AA intelligence — same sanitized
    // shape as GET / ({ t, meta, models }), but the roster is every $0
    // OpenRouter model instead of the Go table. No key, CORS *.
    if (request.method === 'GET' && (url.pathname === '/openrouter' || url.pathname === '/api/openrouter' || url.pathname === '/v1/openrouter' || url.pathname === '/openrouter/')) {
      try {
        const cache = caches.default;
        const cacheKey = new Request(url.origin + '/__openrouter_cache', request);
        const cached = await matchFresh(cache, cacheKey);
        if (cached) return cached;
        const [orRes, aaPages, aaIndexHtml] = await Promise.all([
          fetch('https://openrouter.ai/api/v1/models', { headers: { 'Accept': 'application/json' }, cf: { cacheTtl: 300 } }),
          fetchAaAll(env),
          fetch('https://artificialanalysis.ai/models', { headers: { 'Accept': 'text/html' }, cf: { cacheTtl: 300 } })
            .then((r) => (r.ok ? r.text() : '')).catch(() => ''),
        ]);
        if (!orRes.ok) throw new Error(`OpenRouter fetch failed ${orRes.status}`);
        const orJson = await orRes.json();
        const orTotal = orJson && Array.isArray(orJson.data) ? orJson.data.length : 0;
        const { list: orList } = parseOpenRouter(orJson);
        const aaMap = parseAaFree(aaPages);
        // tier 2: keyless index page scores for slugs the keyed API omitted
        mergeAaScores(aaMap, extractAaIndexScores(aaIndexHtml));
        // tier 3: per-model pages for free models still missing a score (bounded, fail-soft)
        if (orList.length) {
          const flight = extractFlight(aaIndexHtml);
          const allAaSlugs = extractAllAaSlugs(flight);
          for (const s of scanJsonLdScores(aaIndexHtml).keys()) allAaSlugs.add(s);
          for (const s of aaMap.keys()) allAaSlugs.add(s);
          const need = [];
          const seenSlugs = new Set();
          for (const e of orList) {
            // Exact matches are done; approximate ones still try for a
            // dedicated model page that would upgrade them to exact.
            const matched = resolveAaMatchForOc(e.id, aaMap);
            if (matched && matched.match === 'exact') continue;
            const fetchSlug = bestFetchSlugForOc(e.id, allAaSlugs);
            if (!fetchSlug || seenSlugs.has(fetchSlug)) continue;
            if (aaMap.has(fetchSlug) || aaMap.has(dashNorm(fetchSlug)) || aaMap.has(normSlug(fetchSlug))) continue;
            seenSlugs.add(fetchSlug);
            need.push(fetchSlug);
            if (need.length >= 20) break;
          }
          if (need.length) {
            const pages = await Promise.all(need.map((s) =>
              fetch('https://artificialanalysis.ai/models/' + encodeURIComponent(s), { headers: { 'Accept': 'text/html' }, cf: { cacheTtl: 300 } })
                .then((r) => (r.ok ? r.text() : '')).catch(() => ''),
            ));
            for (let i = 0; i < need.length; i++) {
              const slug = need[i];
              let rec = extractAaModelPageRecord(pages[i], slug);
              if (!rec) {
                const alt = scanAaFlightRecords(extractFlight(pages[i]));
                if (alt.size === 1) rec = [...alt.values()][0];
                else if (alt.has(slug)) rec = alt.get(slug);
              }
              if (rec) aaMap.set(slug, rec);
            }
          }
        }
        const models = buildOpenRouterFreeModels(orList, aaMap);
        const scored = models.filter((m) => m.aa).length;
        const payload = {
          t: Date.now(),
          meta: {
            retrieved: new Date().toISOString(),
            aaIndex: `Artificial Analysis Intelligence Index v4.1 (free tier + public pages, ${aaMap.size} models)`,
            orModels: orTotal,
            freeCount: orList.length,
            scored,
            sources: [
              { name: 'openrouter.ai/api/v1/models', url: 'https://openrouter.ai/api/v1/models' },
              { name: 'artificialanalysis.ai/api/v2/language/models/free', url: 'https://artificialanalysis.ai/api/v2/language/models/free' },
            ],
          },
          models,
        };
        const body = JSON.stringify(payload);
        const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=60, s-maxage=300', ...CORS };
        const resp = new Response(body, { status: 200, headers });
        ctx.waitUntil(cache.put(cacheKey, resp.clone()));
        return resp;
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        return new Response(JSON.stringify({ error: 'Failed to build OpenRouter free list', detail: msg }), { status: 502, headers: { 'Content-Type': 'application/json', ...CORS } });
      }
    }
    try {
      const cache = caches.default;
      const cacheKey = new Request(url.origin + '/__worker_cache', request);
      const cached = await matchFresh(cache, cacheKey);
      if (cached) return cached;
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

      // build full AA slug set for fetch candidate resolution (all slugs, even unscored)
      const flight = extractFlight(aaIndexHtml);
      const allAaSlugs = extractAllAaSlugs(flight);
      for (const s of scanJsonLdScores(aaIndexHtml).keys()) allAaSlugs.add(s);
      for (const s of aaMap.keys()) allAaSlugs.add(s);

      // tier 3: per-model pages for curated roster models still missing a score (bounded, fail-soft)
      if (curatedIds && curatedIds.size) {
        const need = [];
        const seenSlugs = new Set();
        const needOcMap = new Map(); // slug -> ocId for later mapping
        for (const id of curatedIds) {
          // try to resolve to best existing scored slug first
          if (resolveAaSlugForOc(id, aaMap)) continue;
          const fetchSlug = bestFetchSlugForOc(id, allAaSlugs);
          if (!fetchSlug || seenSlugs.has(fetchSlug)) continue;
          // if we already have score for fetchSlug, skip
          if (aaMap.has(fetchSlug) || aaMap.has(dashNorm(fetchSlug)) || aaMap.has(normSlug(fetchSlug))) continue;
          seenSlugs.add(fetchSlug);
          need.push(fetchSlug);
          needOcMap.set(fetchSlug, id);
          if (need.length >= 20) break;
        }
        if (need.length) {
          const pages = await Promise.all(need.map((s) =>
            fetch('https://artificialanalysis.ai/models/' + encodeURIComponent(s), { headers: { 'Accept': 'text/html' }, cf: { cacheTtl: 300 } })
              .then((r) => (r.ok ? r.text() : '')).catch(() => ''),
          ));
          for (let i = 0; i < need.length; i++) {
            const slug = need[i];
            let rec = extractAaModelPageRecord(pages[i], slug);
            if (!rec) {
              // try to parse any record from the page (fallback when flight structure differs)
              const alt = scanAaFlightRecords(extractFlight(pages[i]));
              if (alt.size === 1) rec = [...alt.values()][0];
              else if (alt.has(slug)) rec = alt.get(slug);
            }
            if (rec) {
              aaMap.set(slug, rec);
              // also map back to OC dash for resolver convenience: ensure dash lookup finds it
              // no need to alias, resolver will handle
            } else {
              // if fetchSlug was a prefix expansion (e.g., qwen3-8-flash-next) but OC is qwen3-8-flash,
              // the fetched record's slug IS the fetchSlug; resolver will map OC->fetchSlug on join
            }
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
  extractAllAaSlugs,
  extractFlight,
  scanAaFlightRecords,
  resolveAaSlugForOc,
  resolveAaRecordForOc,
  resolveMdForAa,
  bestFetchSlugForOc,
  aaRecordFromObj,
  parseOpenRouter,
  buildOpenRouterFreeModels,
  orBaseId,
  orDisplayName,
  resolveAaMatchForOc,
  __AA_SLUG: AA_SLUG,
};
