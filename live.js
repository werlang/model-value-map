/* Live data layer — fetches both sources at page load so the map stays current.
 *
 *   • artificialanalysis.ai  → sends `Access-Control-Allow-Origin: *`, fetched directly.
 *   • opencode.ai            → sends no CORS header, fetched through public relays
 *                              (allorigins → codetabs → corsproxy), each response
 *                              validated before parsing. Transports RACE with
 *                              staggered starts instead of queueing, so one slow
 *                              relay costs a head start, not its full timeout.
 *                              The starting relay rotates per request so no single
 *                              relay absorbs every hit.
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
 *   • Past the TTL, the newest clean payload is still served immediately
 *     ("stale") while a background refresh runs; the page only blocks on the
 *     network for a truly cold first visit or an explicit force refresh.
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
  const DEFAULT_API_URL = 'https://model-value-map-api.pswerlang.workers.dev';

  function getApiUrl(opts) {
    if (opts && opts.apiUrl !== undefined) return opts.apiUrl;
    if (typeof window !== 'undefined' && window.MVM_API_URL !== undefined) return window.MVM_API_URL;
    return DEFAULT_API_URL;
  }

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
    const snap = snapById && typeof snapById.get === 'function' ? snapById.get(id) : null;
    if (snap && snap.hue) return snap.hue;
    let h = 0;
    const str = author || '';
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
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
  // Per-transport budget (status line + body) and the head start one transport
  // gets before the next joins the race. The head start is deliberately wider
  // than it needs to be: relays routinely take 4–8s for a big page, and every
  // hedge that fires is a duplicate request a rate-limited relay must serve.
  const ATTEMPT_TIMEOUT_MS = 20000;
  const HEDGE_DELAY_MS = 5000;

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

  // Relay politeness: public relays queue and throttle when hammered, so a
  // wide fan-out that lets every job race every relay at once turns into a
  // self-inflicted slowdown (measured: 12 concurrent jobs pushed single
  // codetabs requests to ~19s). A small GLOBAL cap on in-flight relay
  // requests keeps total pressure fixed; the per-request race then decides
  // WHICH transport wins each URL. Direct attempts bypass the cap — they are
  // fast and either answer or die on CORS immediately.
  const MAX_RELAY_INFLIGHT = 5;
  let relaySlots = MAX_RELAY_INFLIGHT;
  const relayPumps = new Set(); // each in-flight fetchText's launch scheduler

  function releaseRelay() {
    relaySlots++;
    for (const pump of relayPumps) pump(); // parked transports grab free slots
  }

  // Returns validated page text; '' when the origin authoritatively answers
  // 404/410 (confirmed miss — direct transport only); null when every
  // transport failed. Callers must distinguish '' from null with ===.
  //
  // Transports RACE instead of queueing: the first starts alone, and each
  // further transport joins HEDGE_DELAY_MS later only if no validated answer
  // has landed yet — a hung or crawling relay costs its head start, not its
  // whole timeout. Fast failures skip ahead immediately, so a dead relay never
  // even waits for its hedge timer. Worst case is now bounded near one attempt
  // budget plus a few head starts, instead of a sum of sequential timeouts.
  function fetchText(url, validate) {
    const oc = url.includes('opencode.ai');
    // Direct stays FIRST for AA (CORS is allowed today) and LAST for OpenCode
    // (CORS is blocked in-browser today; kept as a zero-cost canary for the
    // day that changes — until then it only joins the race if every relay
    // stalled, where it previously ran as a separate last-resort pass).
    const order = oc ? rotatedRelays().concat([0]) : [0].concat(rotatedRelays());
    return new Promise((resolve) => {
      let settled = false; // a final outcome exists — stop starting/counting
      let launched = 0;
      let parked = false;  // next transport waits for a global relay slot
      const inflight = [];

      function exhausted() {
        return launched >= order.length && inflight.every((a) => a.finished);
      }

      // Final answer: cancel whatever is still racing, resolve exactly once.
      function settle(value) {
        if (settled) return;
        settled = true;
        for (const a of inflight) {
          clearTimeout(a.timer);
          if (!a.finished) {
            a.finished = true;
            try { a.ctrl.abort(); } catch (_) {}
            if (a.pi !== 0) releaseRelay();
          }
        }
        relayPumps.delete(pump);
        resolve(value);
      }

      function failAttempt(att) {
        if (att.finished || settled) return;
        att.finished = true;
        clearTimeout(att.timer);
        if (att.pi !== 0) releaseRelay();
        noteRelay(att.pi, false);
        if (exhausted()) { transportFailures++; settle(null); }
        else next('fail');
      }

      // Launch the next transport. Strict admission rules keep the race
      // economical — a job may add a transport only when
      //   • nothing of its own is in flight (a failure skips ahead
      //     immediately, mirroring the old sequential chain), or
      //   • its OWN hedge timer fired (a deliberate race join against a slow
      //     transport), or
      //   • it is parked on the global relay cap and a slot just freed.
      // Another job releasing a slot must never accelerate THIS job past an
      // attempt that is still unresolved — otherwise successful transports
      // get shadowed by redundant duplicates that burn relay goodwill.
      function next(reason) {
        if (settled || launched >= order.length) return;
        const active = inflight.reduce((n, a) => n + (a.finished ? 0 : 1), 0);
        if (active > 0 && reason !== 'hedge' && !(reason === 'resume' && parked)) return;
        const pi = order[launched];
        if (pi !== 0 && relaySlots <= 0) { parked = true; return; }
        parked = false;
        launched++;
        if (pi !== 0) relaySlots--;
        startAttempt(pi);
      }

      function startAttempt(pi) {
        const att = { pi, ctrl: new AbortController(), timer: 0, finished: false };
        inflight.push(att);
        const complete = () => {
          if (att.finished) return;
          att.finished = true;
          clearTimeout(att.timer);
          if (pi !== 0) releaseRelay();
        };
        att.timer = setTimeout(() => failAttempt(att), ATTEMPT_TIMEOUT_MS);
        fetch(PROXIES[pi](url), {
          signal: att.ctrl.signal,
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
        }).then(async (res) => {
          if (att.finished || settled) return;
          // A 404/410 from the DIRECT transport is the origin server's
          // authoritative "doesn't exist" answer — e.g. an AA page for a model
          // it hasn't scored. It must not count as a transport failure (that
          // would block caching forever), so it settles as a confirmed miss
          // instead of null. Relay responses never get this treatment: a proxy
          // can emit its own 404 without the origin ever being asked.
          if (pi === 0 && (res.status === 404 || res.status === 410)) {
            complete();
            noteRelay(pi, true);
            settle('');
            return;
          }
          if (!res.ok) { failAttempt(att); return; }
          const text = await res.text();
          if (att.finished || settled) return;
          if (validate(text)) {
            complete();
            noteRelay(pi, true);
            settle(text);
          } else {
            failAttempt(att); // body arrived but failed validation
          }
        }).catch(() => {
          // Network error, CORS block, timeout abort — or LOSING THE RACE
          // (aborted by settle()). The finished/settled guards make only the
          // genuine failures reach noteRelay, so a healthy relay that merely
          // lost is never benched unfairly.
          failAttempt(att);
        });
        // If this transport turns out to be merely slow, let the next one
        // join the race. Redundant when failures already advanced `launched`:
        // the guard inside next() makes stale timers harmless no-ops.
        setTimeout(() => next('hedge'), HEDGE_DELAY_MS);
      }

      const pump = () => next('resume'); // run by releaseRelay when a slot frees
      relayPumps.add(pump);
      next('init');
    });
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
  function entryFor(live, t) {
    return JSON.stringify({
      t: t || Date.now(),
      live: { ...live, aaIndex: Array.isArray(live.aaIndex) ? live.aaIndex : [...live.aaIndex] },
    });
  }
  function writeCache(live, t) {
    try { localStorage.setItem(CACHE_KEY, entryFor(live, t)); } catch (_) { /* storage full / private mode */ }
  }
  function writeLastGood(live, t) {
    try { localStorage.setItem(CACHE_LASTGOOD, entryFor(live, t)); } catch (_) { /* ditto */ }
  }

  // ---------- worker API layer ----------
  function validateApiPayload(data) {
    if (!data || typeof data !== 'object') return false;
    if (typeof data.t !== 'number' || !Number.isFinite(data.t) || data.t <= 0) return false;
    if (!data.live || typeof data.live !== 'object') return false;
    if (!Array.isArray(data.live.leaderboard) || data.live.leaderboard.length === 0) return false;
    if (!Array.isArray(data.live.aaIndex)) return false;
    return true;
  }

  async function fetchFromApi(apiUrl) {
    if (!apiUrl) return null;
    try {
      const res = await fetch(apiUrl, {
        headers: { 'Accept': 'application/json' },
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
      if (!res.ok) return null;
      const data = await res.json();
      return validateApiPayload(data) ? data : null;
    } catch (_) {
      return null;
    }
  }

  async function postToApi(apiUrl, payload) {
    if (!apiUrl) return;
    try {
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
      if (!res.ok) {
        try {
          const err = await res.json();
          console.warn('Worker API POST returned', res.status, err);
        } catch (_) {
          console.warn('Worker API POST returned', res.status);
        }
      }
    } catch (err) {
      console.warn('Worker API POST failed:', err);
    }
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

  function staleResultFor(snapById, entry) {
    const live = { ...entry.live, aaIndex: new Map(entry.live.aaIndex) };
    const merged = merge(snapById, live);
    return { state: 'stale', models: merged.models, snapFallbacks: merged.snapFallbacks, fetchedAt: entry.t, ocUpdatedAt: live.updatedAt };
  }

  // The full network path: both indexes, parse, per-model fan-out, merge,
  // cache write. Returns the fresh result, a stale render on total outage, or
  // null when nothing usable was ever fetched.
  function staleResultFor(entry, snapById) {
    const live = { ...entry.live, aaIndex: new Map(entry.live.aaIndex) };
    const merged = merge(snapById, live);
    return { state: 'stale', models: merged.models, snapFallbacks: merged.snapFallbacks, fetchedAt: entry.t, ocUpdatedAt: live.updatedAt };
  }

  async function fetchFresh(apiUrl, snapById) {
    transportFailures = 0;

    // 1) the two index pages, in parallel
    const [ocHtml, aaHtml] = await Promise.all([
      fetchText('https://opencode.ai/data', (t) => t.includes('tokenCost') && t.includes('leaderboard')),
      fetchText('https://artificialanalysis.ai/models', (t) => t.includes('intelligenceIndex')),
    ]);
    if (!ocHtml) {
      // OpenCode is unreachable through every transport — render the newest
      // clean fetch we have ever seen.
      const lastGood = readLastGood();
      if (lastGood) return staleResultFor(lastGood, snapById);
      return null;
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

    // Pool width: each job races its transports internally, so a wider pool
    // only multiplies load when jobs are genuinely in flight. 6 keeps even a
    // bad day (many per-model pages) to ~2 rounds through slow relays.
    const [ocResults, aaResults] = await Promise.all([
      parseOcPages((await loadPool(ocJobs.map((j) => async () => ({
        id: j.id,
        html: await fetchText(j.url, (t) => t.includes('$R[')),
      })), 6)).filter((j) => j.html)),
      loadPool(aaJobs.map((j) => async () => {
        let rec = null;
        for (let attempt = 0; attempt < j.candidates.length && !rec; attempt++) {
          const html = await fetchText('https://artificialanalysis.ai/models/' + j.candidates[attempt],
            (t) => t.includes('currentModel') || t.includes('intelligenceIndex'));
          // null = transports exhausted (give up), '' = confirmed 404 on THIS
          // slug (keep trying the remaining candidates).
          if (html === null) break;
          rec = scanAaModels(extractFlight(html)).get(j.candidates[attempt]) || null;
        }
        return { id: j.id, rec };
      }), 6),
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
    // fast path in localStorage.
    if (!transportFailures) {
      writeCache(live);
    }
    // Worker API update: sync whenever live backbone data (leaderboard + AA scores) was fetched
    const hasBackbone = Array.isArray(rows) && rows.length > 0 && aaIndex && aaIndex.size > 0;
    if (hasBackbone) {
      postToApi(apiUrl, { t: Date.now(), live: { ...live, aaIndex: [...live.aaIndex] } });
    }
    writeLastGood(live);

    const state = merged.snapFallbacks === 0 ? 'live' : 'partial';
    return { state, models: merged.models, snapFallbacks: merged.snapFallbacks, fetchedAt: Date.now(), ocUpdatedAt: live.updatedAt };
  }

  // Entry point.
  // 1. Fetch from LS (if fresh and not force, return cached result immediately).
  // 2. If LS miss (or expired) -> hit the Cloudflare Worker API (and store in LS on hit).
  // 3. If API miss (or force) -> perform client-side fetching (relays + AA direct).
  // 4. When client-side fetching is done, make a POST to update the API.
  async function load(snapshotOrOpts, maybeOpts) {
    const hasSnapshot = Array.isArray(snapshotOrOpts);
    const snapshotModels = hasSnapshot ? snapshotOrOpts : [];
    const opts = hasSnapshot ? (maybeOpts || {}) : (snapshotOrOpts || {});
    const force = !!opts.force;
    const snapById = snapshotModels.length > 0 ? new Map(snapshotModels.map((m) => [m.id, m])) : null;
    const report = typeof opts.onUpdate === 'function' ? opts.onUpdate : null;
    const apiUrl = getApiUrl(opts);

    // 1. Fetch from LS
    if (!force) {
      const cached = readCache();
      if (cached && cached.live && Date.now() - cached.t < TTL_MS) {
        const live = { ...cached.live, aaIndex: new Map(cached.live.aaIndex) };
        const merged = merge(snapById, live);
        return { state: 'cached', models: merged.models, snapFallbacks: merged.snapFallbacks, fetchedAt: cached.t, ocUpdatedAt: live.updatedAt };
      }

      // Past TTL: paint aged payload immediately as stale, refresh in background
      const bg = cached && cached.live ? cached : readLastGood();
      if (bg) {
        const staleResult = { ...staleResultFor(bg, snapById), refreshing: true };
        const doRefresh = async () => {
          if (apiUrl) {
            const apiPayload = await fetchFromApi(apiUrl);
            if (apiPayload && (Date.now() - apiPayload.t < TTL_MS)) {
              writeCache(apiPayload.live, apiPayload.t);
              writeLastGood(apiPayload.live, apiPayload.t);
              const live = { ...apiPayload.live, aaIndex: new Map(apiPayload.live.aaIndex) };
              const merged = merge(snapById, live);
              const state = merged.snapFallbacks === 0 ? 'live' : 'partial';
              return { state, models: merged.models, snapFallbacks: merged.snapFallbacks, fetchedAt: apiPayload.t, ocUpdatedAt: live.updatedAt };
            }
          }
          return fetchFresh(apiUrl, snapById);
        };

        doRefresh().then((fresh) => {
          if (report) report(fresh || { ...staleResult, refreshing: false });
        }).catch(() => { if (report) report({ ...staleResult, refreshing: false }); });
        return staleResult;
      }
    }

    // 2. If LS miss -> hit the API
    if (!force && apiUrl) {
      const apiPayload = await fetchFromApi(apiUrl);
      if (apiPayload) {
        writeCache(apiPayload.live, apiPayload.t);
        writeLastGood(apiPayload.live, apiPayload.t);
        const live = { ...apiPayload.live, aaIndex: new Map(apiPayload.live.aaIndex) };
        const merged = merge(snapById, live);
        const state = merged.snapFallbacks === 0 ? 'live' : 'partial';
        return { state, models: merged.models, snapFallbacks: merged.snapFallbacks, fetchedAt: apiPayload.t, ocUpdatedAt: live.updatedAt };
      }
    }

    // 3. If API miss (or force) -> perform current fetching
    return fetchFresh(apiUrl, snapById);
  }

  // ---------- merge live (+ optional snapshot) ----------
  function merge(snapOrLive, maybeLive) {
    const live = maybeLive || snapOrLive;
    const snapById = (maybeLive && snapOrLive instanceof Map) ? snapOrLive
      : (maybeLive && Array.isArray(snapOrLive) ? new Map(snapOrLive.map((m) => [m.id, m])) : null);
    // Re-validate even cached payloads at this boundary: localStorage content
    // may predate a validation fix or be tampered with by other origins' bugs.
    const board = new Map((live.tokenCost || []).filter(validBoardRow).map((r) => [r.model, r]));
    let snapFallbacks = 0;

    const models = (live.leaderboard || []).map((row) => {
      const id = row.model;
      const snap = snapById ? snapById.get(id) || {} : {};
      const page = (live.ocPages && live.ocPages[id]) || null;
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

      const sane = (rec) => (!!rec && num(rec.intelligenceIndex) && rec.intelligenceIndex >= 0 ? rec : null);
      const aaLive = sane((AA_SLUG[id] && live.aaIndex && live.aaIndex.get(AA_SLUG[id])) || null)
        || sane(live.aaIndex && live.aaIndex.get(normSlug(id)))
        || sane(live.aaPages && live.aaPages[id]);
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

      const plot = num(ocCostPerM) && ocCostPerM > 0 && !!aa;
      const excludeReason = plot ? null
        : ocCostPerM == null
          ? ('No token cost published on OpenCode' + (aa ? '.' : '; not scored by Artificial Analysis either.'))
          : ocCostPerM <= 0
            ? 'Free model (zero output rate) — cannot sit on a log-cost axis.'
            : 'Not scored on the Artificial Analysis Intelligence Index yet.';

      return {
        id,
        label: (page && page.name) || snap.label || id.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        author: row.author,
        rank: row.rank,
        weeklyTokensT: num(row.tokens) && row.tokens > 0 ? Math.round((row.tokens / 1000) * 100) / 100 : 0,
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

    if (snapById) {
      const seen = new Set(models.map((m) => m.id));
      for (const snap of snapById.values()) {
        if (seen.has(snap.id)) continue;
        models.push({ ...snap });
        snapFallbacks++;
      }
    }

    return { models, snapFallbacks };
  }

  return { load };
})();
