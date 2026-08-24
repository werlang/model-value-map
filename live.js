/* Live data layer — fetches both sources at page load so the map stays current.
 *
 *   • artificialanalysis.ai  → sends `Access-Control-Allow-Origin: *`, fetched directly.
 *   • opencode.ai            → sends no CORS header, fetched through public relays
 *                              (allorigins → codetabs → corsproxy), each response
 *                              validated before parsing.
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

  const FALLBACK_HUES = ['#3B5BDB', '#D9480F', '#0CA678', '#9C36B5', '#0C8599', '#C2255C', '#6741D9', '#E8890C', '#2F9E44'];
  let hueCursor = 0;
  function hueFor(author, snapById, id) {
    const snap = snapById.get(id);
    if (snap && snap.hue) return snap.hue;
    let h = 0;
    for (let i = 0; i < author.length; i++) h = (h * 31 + author.charCodeAt(i)) >>> 0;
    return FALLBACK_HUES[h % FALLBACK_HUES.length] || FALLBACK_HUES[(hueCursor++) % FALLBACK_HUES.length];
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

  async function fetchText(url, validate, timeoutMs = 25000) {
    // OpenCode sends no CORS header today; skipping the doomed direct attempt
    // keeps the console clean and the load fast.
    const chain = url.includes('opencode.ai') ? PROXIES.slice(1) : PROXIES;
    for (const wrap of chain) {
      try {
        const res = await fetch(wrap(url), {
          signal: timeoutSignal(timeoutMs),
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
        });
        if (!res.ok) continue;
        const text = await res.text();
        if (validate(text)) return text;
      } catch (_) { /* relay failed — try the next one */ }
    }
    return null;
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
    '    var re = /<script>([\\s\\S]*?)<\\/script>/g;',
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
        if (o && o.slug && o.shortName && typeof o.intelligenceIndex === 'number' && !out.has(o.slug)) {
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
  function readCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch (_) { return null; }
  }
  function writeCache(live) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), live: { ...live, aaIndex: [...live.aaIndex] } }));
    } catch (_) { /* storage full / private mode */ }
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
    if (!ocHtml) return null; // OpenCode is the backbone — without it we stay on snapshot

    // 2) parse OC home (worker) + AA index (text scan)
    const ocParsed = await parseOcPages([{ id: 'home', html: ocHtml }]);
    const home = ocParsed && ocParsed[0] && ocParsed[0].result && ocParsed[0].result.home;
    if (!home || !Array.isArray(home.leaderboard)) return null;

    const aaIndex = aaHtml ? scanAaModels(extractFlight(aaHtml)) : new Map();

    // 3) fan out for per-model pages (only what the index pages can't answer)
    const board = new Map((home.tokenCost || []).map((r) => [r.model, r]));
    const rows = home.leaderboard;
    const ocJobs = rows
      .filter((r) => !board.has(r.model))
      .map((r) => ({ id: r.model, url: 'https://opencode.ai/data/' + r.provider + '/' + r.model.replace(/\./g, '-') }));
    const aaJobs = rows
      .filter((r) => AA_SLUG[r.model] && !aaIndex.has(AA_SLUG[r.model]))
      .map((r) => ({ id: r.model, slug: AA_SLUG[r.model] }));

    const [ocResults, aaResults] = await Promise.all([
      parseOcPages((await loadPool(ocJobs.map((j) => async () => ({
        id: j.id,
        html: await fetchText(j.url, (t) => t.includes('$R['), 25000),
      })), 4)).filter((j) => j.html)),
      loadPool(aaJobs.map((j) => async () => {
        let rec = null;
        for (let attempt = 0; attempt < 2 && !rec; attempt++) {
          const html = await fetchText('https://artificialanalysis.ai/models/' + j.slug,
            (t) => t.includes('currentModel') || t.includes('intelligenceIndex'), 25000);
          if (!html) break;
          const found = scanAaModels(extractFlight(html)).get(j.slug);
          if (found) rec = found;
        }
        return { id: j.id, rec };
      }), 3),
    ]);

    const ocPages = {};
    for (const r of ocResults || []) if (r && r.result && r.result.info) ocPages[r.id] = r.result.info;
    const aaPages = {};
    for (const r of aaResults) if (r && r.rec) aaPages[r.id] = r.rec;

    const live = {
      updatedAt: home.updatedAt,
      leaderboard: rows,
      tokenCost: home.tokenCost || [],
      ocPages,
      aaIndex,
      aaPages,
    };
    const merged = merge(snapById, live);
    writeCache(live);

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
      } else if (page && page.cost && page.cost.output != null) {
        ocCostPerM = page.cost.output;
        ocCost = { input: page.cost.input, output: page.cost.output, cached: page.cost.cacheRead };
      } else if (snap.ocCostPerM != null) {
        ocCostPerM = snap.ocCostPerM;
        ocCost = snap.ocCost || null;
        snapFallbacks++;
      }

      const aaLive = (AA_SLUG[id] && live.aaIndex.get(AA_SLUG[id])) || live.aaPages[id] || null;
      let aa = null;
      if (aaLive) {
        aa = {
          name: aaLive.shortName || aaLive.name,
          intelligenceIndex: aaLive.intelligenceIndex,
          effort: aaLive.effort,
          isOpenWeights: !!aaLive.isOpenWeights,
          url: 'https://artificialanalysis.ai/models/' + (AA_SLUG[id] || aaLive.slug),
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
        weeklyTokensT: Math.round((row.tokens / 1000) * 100) / 100,
        hue: hueFor(row.author, snapById, id),
        ocCostPerM,
        ocCost,
        contextWindowTokens: (page && page.limit && page.limit.context) || snap.contextWindowTokens || null,
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
