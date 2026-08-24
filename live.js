/* Live data layer — fetches both sources at page load so the map stays current.
 *
 *   • artificialanalysis.ai  → sends `Access-Control-Allow-Origin: *`, fetched directly.
 *   • opencode.ai            → sends no CORS header, fetched through public relays
 *                              (allorigins → codetabs → corsproxy), each response
 *                              validated before parsing. The starting relay rotates
 *                              per request so no single relay absorbs every hit.
 *
 * Robustness model:
 *   • Per-model page URLs come from the canonical links embedded in the /data
 *     HTML; a constructed URL is only a fallback.
 *   • Every fetched value passes a sanity check before it may override the
 *     snapshot; anything missing or malformed degrades per-value to data.js.
 *   • AA matching is tiered: curated slug → deterministic normalized id against
 *     the live index → per-model AA page (both candidates tried). A renamed or
 *     brand-new model keeps working without a manual map entry whenever its
 *     OpenCode id maps to the AA slug by dots-to-dashes alone.
 *   • Parsed payloads are cached ONLY after a fetch with zero transport
 *     failures, so a flaky relay never pins stale data for 30 minutes.
 *     (A 404/410 is an authoritative "no such page", not a failure.)
 *   • Any successful OpenCode backbone fetch also refreshes an unTTL'd
 *     last-known-good copy ('mvm.live.lastgood'). If OpenCode later becomes
 *     unreachable through every transport, the page renders it (status
 *     "stale", age shown) instead of the old snapshot.
 *
 * Safety model:
 *   • AA flight payloads are parsed as INERT TEXT (regex + brace matching) — never executed.
 *   • OpenCode hydration blobs need a JS evaluation to rebuild their shared-ref graph;
 *     that happens inside a throwaway Blob Worker with stubbed globals — the remote
 *     script never sees the page, the DOM, or this module.
 *
 * Every value falls back to the embedded snapshot (data.js) when missing, so the
 * dashboard always renders, and a status stamp reports exactly how fresh it is.
 */
window.LiveData = (function () {
  'use strict';

  const CACHE_KEY = 'mvm.live.v1';
  const CACHE_LASTGOOD = 'mvm.live.lastgood';
  const TTL_MS = 30 * 60 * 1000;

  // OpenCode model id → Artificial Analysis slug (variant chosen per README methodology)
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
  };

  // Deterministic cross-site guess: OpenCode ids differ from AA slugs mostly by
  // dots vs dashes. Verified against the real catalog — exact normalized matches
  // only, no fuzzy scoring, so a wrong pairing can never be invented here.
  function normSlug(id) {
    return id.toLowerCase().replace(/\./g, '-');
  }

  const FALLBACK_HUES = ['#3B5BDB', '#D9480F', '#0CA678', '#9C36B5', '#0C8599', '#C2255C', '#6741D9', '#E8890C', '#2F9E44'];
  let hueCursor = 0;
  function hueFor(author, snapById, id) {
    const snap = snapById.get(id);
    if (snap && snap.hue) return snap.hue;
    let h = 0;
    for (let i = 0; i < author.length; i++) h = (h * 31 + author.charCodeAt(i)) >>> 0;
    return FALLBACK_HUES[h % FALLBACK_HUES.length] || FALLBACK_HUES[(hueCursor++) % FALLBACK_HUES.length];
  }

  // ---------- value validation ----------
  const num = (v) => typeof v === 'number' && Number.isFinite(v);

  function validBoardRow(r) {
    return !!r && typeof r.model === 'string' && num(r.total) && r.total >= 0 && num(r.output);
  }
  function validPageCost(c) {
    return !!c && num(c.output) && c.output >= 0 && (c.input == null || num(c.input));
  }

  // ---------- fetch with relay chain ----------
  function timeoutSignal(ms) {
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) return AbortSignal.timeout(ms);
    const c = new AbortController();
    setTimeout(() => c.abort(), ms);
    return c.signal;
  }

  const PROXIES = [
    (u) => u, // direct — works for AA today, and for OpenCode if it ever adds CORS
    (u) => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u),
    (u) => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u),
    (u) => 'https://corsproxy.io/?url=' + encodeURIComponent(u),
  ];

  // Rate-limited relays fail less when no single one absorbs every request:
  // each fetch starts at the next relay in the circle. A relay that keeps
  // failing gets benched after three consecutive misses, so a dying relay
  // can't tax every request with its full timeout.
  let relayCursor = 0;
  const RELAY_INDEXES = [1, 2, 3]; // PROXIES positions of the relays (0 = direct)
  const relayFails = [0, 0, 0, 0];

  function rotatedRelays() {
    const alive = RELAY_INDEXES.filter((i) => relayFails[i] < 3);
    const pool = alive.length ? alive : RELAY_INDEXES; // benched relays return after a full sweep
    const start = relayCursor++ % pool.length;
    return pool.slice(start).concat(pool.slice(0, start));
  }

  function noteRelay(pi, ok) {
    relayFails[pi] = ok ? 0 : Math.min(3, relayFails[pi] + 1);
  }

  // Transport failures seen during the current load(); a clean fetch is what
  // earns the right to populate the localStorage cache.
  let transportFailures = 0;

  async function fetchText(url, validate, timeoutMs = 25000) {
    // OpenCode sends no CORS header today, so the browser path starts at the
    // relays (rotated, unhealthy ones benched); the direct attempt stays
    // available as an absolute last resort — one fast TypeError in a
    // CORS-blocked browser today, instant success if OpenCode ever adds the
    // header. For AA the direct attempt stays first; relays are only backup.
    const oc = url.includes('opencode.ai');
    const order = oc ? rotatedRelays() : [0].concat(rotatedRelays());
    for (const pi of order) {
      try {
        const res = await fetch(PROXIES[pi](url), {
          signal: timeoutSignal(timeoutMs),
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
        });
        // A 404/410 is the server's authoritative "doesn't exist" answer —
        // e.g. an AA page for a model it hasn't scored. That must not count
        // as a transport failure (it would block caching forever), so it
        // returns a confirmed-miss marker instead of null.
        if (res.status === 404 || res.status === 410) { noteRelay(pi, true); return ''; }
        if (!res.ok) { noteRelay(pi, false); continue; }
        const text = await res.text();
        if (validate(text)) { noteRelay(pi, true); return text; }
        noteRelay(pi, false);
      } catch (_) { noteRelay(pi, false); /* try the next transport */ }
    }
    if (oc) {
      try {
        const res = await fetch(url, {
          signal: timeoutSignal(timeoutMs),
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
        });
        if (res.status === 404 || res.status === 410) return '';
        if (res.ok) {
          const text = await res.text();
          if (validate(text)) return text;
        }
      } catch (_) { /* CORS blocked, as expected in-browser today */ }
    }
    transportFailures++;
    return null;
  }

  // ---------- canonical per-model page links ----------
  // The /data HTML embeds the true URL of every model page. Harvesting them
  // removes URL construction as a failure mode; the constructed form remains
  // as a fallback for rows without a link.
  function harvestOcLinks(html) {
    const links = new Map();
    const re = /href="(\/data\/[a-z0-9-]+\/[a-z0-9.-]+)"/g;
    let m;
    while ((m = re.exec(html))) {
      const seg = m[1].slice('/data/'.length);
      if (!seg.includes('/') || seg.split('/').length !== 2) continue;
      if (seg.startsWith('_build/') || seg.startsWith('compare/')) continue;
      links.set(seg, m[1]);
    }
    return links;
  }
  function ocUrlFor(row, links) {
    const seg = row.provider + '/' + row.model.replace(/\./g, '-');
    return 'https://opencode.ai' + (links.get(seg) || '/data/' + seg);
  }

  // ---------- OpenCode hydration parsing (isolated worker) ----------
  const WORKER_SRC = [
    'self.onmessage = function (e) {',
    '  var out = [];',
    '  (e.data || []).forEach(function (job) {',
    '    try { out.push({ id: job.id, result: parse(job.html) }); }',
    '    catch (err) { out.push({ id: job.id, error: String(err) }); }',
    '  });',
    '  self.postMessage(out);',
    '',
    '  function parse(html) {',
    '    var scripts = [];',
    '    var re = /<script[^>]*>([\\s\\S]*?)<\\/script>/g;',
    '    var m;',
    '    while ((m = re.exec(html))) if (m[1].indexOf("$R[") !== -1) scripts.push(m[1]);',
    '    var noop = function () {};',
    '    var ctx = {',
    '      _$HY: { r: {}, events: [], completed: new WeakSet() },',
    '      $R: [], console: console,',
    '      document: { addEventListener: noop, querySelector: function () { return null; }, getElementById: function () { return null; } },',
    '      localStorage: { getItem: function () { return null; }, setItem: noop },',
    '      navigator: {}',
    '    };',
    '    ctx.window = ctx; ctx.self = ctx;',
    '    for (var i = 0; i < scripts.length; i++) {',
    '      try {',
    '        new Function("window", "self", "document", "localStorage", "navigator", "_$HY", "$R", "console", scripts[i])(',
    '          ctx.window, ctx.self, ctx.document, ctx.localStorage, ctx.navigator, ctx._$HY, ctx.$R, ctx.console',
    '        );',
    '      } catch (_) {}',
    '    }',
    '    var R = ctx.$R;',
    '    function find(pred) { for (var j = 0; j < R.length; j++) { var v = R[j]; if (v && typeof v === "object" && !Array.isArray(v) && pred(v)) return v; } return null; }',
    '    var home = find(function (v) { return v.leaderboard && v.tokenCost; });',
    '    var info = find(function (v) { return v.slug && v.cost; });',
    '    return {',
    '      home: home ? { updatedAt: home.updatedAt, leaderboard: home.leaderboard, tokenCost: home.tokenCost } : null,',
    '      info: info ? { name: info.name, cost: info.cost, limit: info.limit, openWeights: !!info.openWeights, reasoning: !!info.reasoning } : null',
    '    };',
    '  }',
    '};',
  ].join('\n');

  let workerUrl = null;
  function parseOcPages(jobs) {
    return new Promise((resolve) => {
      let w;
      try {
        if (!workerUrl) workerUrl = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
        w = new Worker(workerUrl);
      } catch (_) { resolve(null); return; }
      const timer = setTimeout(() => { try { w.terminate(); } catch (_) {} resolve(null); }, 45000);
      w.onmessage = (e) => { clearTimeout(timer); try { w.terminate(); } catch (_) {} resolve(e.data || []); };
      w.onerror = () => { clearTimeout(timer); try { w.terminate(); } catch (_) {} resolve(null); };
      w.postMessage(jobs);
    });
  }

  // ---------- AA flight parsing (inert text — never executed) ----------
  function extractFlight(html) {
    const re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
    let m, flight = '';
    while ((m = re.exec(html))) { try { flight += JSON.parse(m[1]); } catch (_) {} }
    return flight;
  }

  function matchBrace(text, start) {
    let depth = 0, inStr = false, esc = false;
    const limit = Math.min(start + 200000, text.length);
    for (let j = start; j < limit; j++) {
      const c = text[j];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') { depth--; if (depth === 0) return j; }
    }
    return -1;
  }

  function scanAaModels(flight) {
    const out = new Map();
    const re = /\{"id":"[0-9a-f-]{36}",/g;
    let m;
    while ((m = re.exec(flight))) {
      const end = matchBrace(flight, m.index);
      if (end < 0) continue;
      try {
        const o = JSON.parse(flight.slice(m.index, end + 1));
        if (o && o.slug && o.shortName && typeof o.intelligenceIndex === 'number' && o.intelligenceIndex >= 0 && !out.has(o.slug)) {
          out.set(o.slug, {
            slug: o.slug,
            shortName: o.shortName,
            name: o.name || o.shortName,
            intelligenceIndex: Math.round(o.intelligenceIndex * 100) / 100,
            effort: (o.effort && o.effort.label) || null,
            isOpenWeights: !!o.isOpenWeights,
          });
        }
      } catch (_) {}
    }
    return out;
  }

  // ---------- cache ----------
  function parseCacheEntry(raw) {
    try {
      const c = JSON.parse(raw || 'null');
      if (!c || !c.live || !Array.isArray(c.live.leaderboard) || typeof c.t !== 'number') return null;
      return c;
    } catch (_) { return null; }
  }
  function readStore(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }
  function readCache() {
    return parseCacheEntry(readStore(CACHE_KEY));
  }
  // Last known good payload: written whenever the OpenCode backbone fetch
  // succeeds (authoritative misses like HTTP 404 don't taint it). It exists
  // so a total relay outage still renders recent live data instead of the
  // old snapshot.
  function readLastGood() {
    return parseCacheEntry(readStore(CACHE_LASTGOOD));
  }
  function entryFor(live) {
    return JSON.stringify({ t: Date.now(), live: { ...live, aaIndex: [...live.aaIndex] } });
  }
  function writeCache(live) {
    try { localStorage.setItem(CACHE_KEY, entryFor(live)); } catch (_) { /* storage full / private mode */ }
  }
  function writeLastGood(live) {
    try { localStorage.setItem(CACHE_LASTGOOD, entryFor(live)); } catch (_) { /* ditto */ }
  }

  // ---------- orchestration ----------
  async function loadPool(tasks, size) {
    const results = new Array(tasks.length);
    let next = 0;
    async function runner() {
      while (next < tasks.length) {
        const i = next++;
        results[i] = await tasks[i]();
      }
    }
    await Promise.all(Array.from({ length: Math.min(size, tasks.length) }, runner));
    return results;
  }

  async function load(snapshotModels, opts) {
    const force = !!(opts && opts.force);
    const snapById = new Map(snapshotModels.map((m) => [m.id, m]));
    transportFailures = 0;

    if (!force) {
      const cached = readCache();
      if (cached && cached.live && Date.now() - cached.t < TTL_MS) {
        const live = { ...cached.live, aaIndex: new Map(cached.live.aaIndex) };
        const merged = merge(snapById, live);
        return { state: 'cached', models: merged.models, snapFallbacks: merged.snapFallbacks, fetchedAt: cached.t, ocUpdatedAt: live.updatedAt };
      }
    }

    // 1) the two index pages, in parallel
    const [ocHtml, aaHtml] = await Promise.all([
      fetchText('https://opencode.ai/data', (t) => t.includes('tokenCost') && t.includes('leaderboard')),
      fetchText('https://artificialanalysis.ai/models', (t) => t.includes('intelligenceIndex')),
    ]);
    if (!ocHtml) {
      // OpenCode is unreachable through every transport — render the newest
      // clean fetch we have ever seen rather than the ancient snapshot.
      const lastGood = readLastGood();
      if (lastGood) {
        const live = { ...lastGood.live, aaIndex: new Map(lastGood.live.aaIndex) };
        const merged = merge(snapById, live);
        return { state: 'stale', models: merged.models, snapFallbacks: merged.snapFallbacks, fetchedAt: lastGood.t, ocUpdatedAt: live.updatedAt };
      }
      return null; // nothing ever fetched cleanly — stay on snapshot
    }

    // Canonical per-model URLs, straight from the horse's mouth.
    const ocLinks = harvestOcLinks(ocHtml);

    // 2) parse OC home (worker) + AA index (text scan)
    const ocParsed = await parseOcPages([{ id: 'home', html: ocHtml }]);
    const home = ocParsed && ocParsed[0] && ocParsed[0].result && ocParsed[0].result.home;
    if (!home || !Array.isArray(home.leaderboard)) return null;

    // Drop malformed board rows instead of trusting them; the merge falls back
    // to the per-model page (or snapshot) for anything removed here.
    const rows = home.leaderboard.filter((r) => r && typeof r.model === 'string');
    const board = new Map((home.tokenCost || []).filter(validBoardRow).map((r) => [r.model, r]));

    const aaIndex = aaHtml ? scanAaModels(extractFlight(aaHtml)) : new Map();

    // 3) fan out for per-model pages (only what the index pages can't answer)
    const ocJobs = rows
      .filter((r) => !board.has(r.model))
      .map((r) => ({ id: r.model, url: ocUrlFor(r, ocLinks) }));
    // AA candidate slugs: curated mapping first, then the deterministic
    // normalized id — covers renamed slugs and brand-new models without
    // inventing pairings.
    const aaJobs = rows
      .filter((r) => !((AA_SLUG[r.model] && aaIndex.get(AA_SLUG[r.model])) || aaIndex.get(normSlug(r.model))))
      .map((r) => ({ id: r.model, candidates: [...new Set([AA_SLUG[r.model], normSlug(r.model)].filter(Boolean))] }));

    const [ocResults, aaResults] = await Promise.all([
      parseOcPages((await loadPool(ocJobs.map((j) => async () => ({
        id: j.id,
        html: await fetchText(j.url, (t) => t.includes('$R['), 25000),
      })), 4)).filter((j) => j.html)),
      loadPool(aaJobs.map((j) => async () => {
        let rec = null;
        for (let attempt = 0; attempt < j.candidates.length && !rec; attempt++) {
          const html = await fetchText('https://artificialanalysis.ai/models/' + j.candidates[attempt],
            (t) => t.includes('currentModel') || t.includes('intelligenceIndex'), 25000);
          if (!html) break;
          rec = scanAaModels(extractFlight(html)).get(j.candidates[attempt]) || null;
        }
        return { id: j.id, rec };
      }), 3),
    ]);

    const ocPages = {};
    for (const r of ocResults || []) {
      if (r && r.result && r.result.info && validPageCost(r.result.info.cost)) ocPages[r.id] = r.result.info;
    }
    const aaPages = {};
    for (const r of aaResults) if (r && r.rec) aaPages[r.id] = r.rec;

    const live = {
      updatedAt: home.updatedAt,
      leaderboard: rows,
      tokenCost: [...board.values()],
      ocPages,
      aaIndex,
      aaPages,
    };
    const merged = merge(snapById, live);
    // Fresh cache: only a zero-transport-failure fetch earns the 30-minute
    // fast path. Last-good: any successful OpenCode backbone fetch refreshes
    // the outage layer — stray optional-page misses must not starve it.
    if (!transportFailures) writeCache(live);
    writeLastGood(live);

    const state = merged.snapFallbacks === 0 ? 'live' : 'partial';
    return { state, models: merged.models, snapFallbacks: merged.snapFallbacks, fetchedAt: Date.now(), ocUpdatedAt: live.updatedAt };
  }

  // ---------- merge live + snapshot ----------
  function merge(snapById, live) {
    const board = new Map((live.tokenCost || []).map((r) => [r.model, r]));
    let snapFallbacks = 0;

    const models = (live.leaderboard || []).map((row) => {
      const id = row.model;
      const snap = snapById.get(id) || {};
      const page = live.ocPages[id] || null;
      const tc = board.get(id) || null;

      let ocCostPerM = null;
      let ocCost = null;
      if (tc) {
        ocCostPerM = tc.total;
        ocCost = { input: tc.input, output: tc.output, cached: tc.cached };
      } else if (page && validPageCost(page.cost)) {
        ocCostPerM = page.cost.output;
        ocCost = { input: page.cost.input, output: page.cost.output, cached: page.cost.cacheRead };
      } else if (snap.ocCostPerM != null) {
        ocCostPerM = snap.ocCostPerM;
        ocCost = snap.ocCost || null;
        snapFallbacks++;
      }

      const aaLive = (AA_SLUG[id] && live.aaIndex.get(AA_SLUG[id])) || live.aaIndex.get(normSlug(id)) || live.aaPages[id] || null;
      let aa = null;
      if (aaLive) {
        const slugUsed = aaLive.slug || AA_SLUG[id] || normSlug(id);
        aa = {
          name: aaLive.shortName || aaLive.name,
          intelligenceIndex: aaLive.intelligenceIndex,
          effort: aaLive.effort,
          isOpenWeights: !!aaLive.isOpenWeights,
          url: 'https://artificialanalysis.ai/models/' + slugUsed,
        };
      } else if (snap.aa) {
        aa = { ...snap.aa };
        snapFallbacks++;
      }

      const plot = ocCostPerM != null && !!aa;
      const excludeReason = plot ? null
        : ocCostPerM == null
          ? ('No token cost published on OpenCode' + (aa ? '.' : '; not scored by Artificial Analysis either.'))
          : 'Not scored on the Artificial Analysis Intelligence Index yet.';

      return {
        id,
        label: (page && page.name) || snap.label || id.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        author: row.author,
        rank: row.rank,
        weeklyTokensT: num(row.tokens) ? Math.round((row.tokens / 1000) * 100) / 100 : 0,
        hue: hueFor(row.author, snapById, id),
        ocCostPerM,
        ocCost,
        contextWindowTokens: (page && num(page.limit && page.limit.context) && page.limit.context) || snap.contextWindowTokens || null,
        reasoning: page ? !!page.reasoning : (snap.reasoning ?? null),
        openWeights: page ? !!page.openWeights : (snap.openWeights ?? null),
        aa,
        plot,
        excludeReason,
      };
    });

    return { models, snapFallbacks };
  }

  return { load };
})();
