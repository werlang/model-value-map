/* Subsidy frontier — classic script, no dependencies, no modules.
 *
 * Plots five provider catalogues (models.dev, base tier only) against the
 * Artificial Analysis Intelligence Index, with three X modes:
 *   subsidized    cost_per_task / subsidy_multiple  (one point per model×plan)
 *   cost_per_task AA intelligenceIndexCostPerTask.cost.total
 *   api_cost      models.dev base output cost (USD / 1M output tokens)
 *
 * Live AA scores come from window.LiveData (the sanitized worker endpoint).
 * models.dev and the two committed data files are fetched directly. The
 * merged dataset is cached under mvm.subsidy.v1 (30 min TTL) plus an
 * unexpired mvm.subsidy.lastgood, so an unreachable worker degrades to the
 * AA snapshot and then to the last clean merge — never to invented values.
 */
(function () {
  'use strict';

  const MODELS_DEV_URL = 'https://models.dev/api.json';
  const PLANS_URL = 'data/subsidy-plans.json';
  const SNAPSHOT_URL = 'data/aa-subsidy-snapshot.json';
  const CACHE_KEY = 'mvm.subsidy.v1';
  const LASTGOOD_KEY = 'mvm.subsidy.lastgood';
  const HIDDEN_KEY = 'mvm.subsidy.hidden.v1';
  const XSCALE_KEY = 'mvm.subsidy.xscale.v1';
  const TTL_MS = 30 * 60 * 1000;

  const PROVIDERS = [
    { key: 'anthropic', name: 'Anthropic' },
    { key: 'openai', name: 'OpenAI' },
    { key: 'google', name: 'Google' },
    { key: 'xai', name: 'xAI' },
    { key: 'opencode-go', name: 'OpenCode Go' },
  ];
  const PROVIDER_KEYS = PROVIDERS.map(function (p) { return p.key; });
  const PROVIDER_NAMES = {};
  PROVIDERS.forEach(function (p) { PROVIDER_NAMES[p.key] = p.name; });

  const MODES = ['subsidized', 'cost_per_task', 'api_cost'];

  function num(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }

  /** Lowercase catalog slug: dots/underscores/slashes/spaces all become '-'. */
  function dashNorm(id) {
    return String(id == null ? '' : id)
      .toLowerCase()
      .replace(/^.*\//, '')
      .replace(/[\s\/._]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  function normVariants(id) {
    const out = [];
    const base = dashNorm(id);
    if (base) out.push(base);
    const noFree = base.replace(/-free$/, '');
    if (noFree && noFree !== base) out.push(noFree);
    const noParen = base.replace(/-\([^)]*\)$/, '');
    if (noParen && noParen !== base) out.push(noParen);
    return out;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtMoney(v) {
    if (v == null || !Number.isFinite(v)) return '—';
    if (v >= 100) return '$' + String(Math.round(v));
    if (v >= 1) return '$' + v.toFixed(2);
    if (v >= 0.01) return '$' + v.toFixed(3);
    if (v >= 0.0001) return '$' + v.toFixed(4);
    return '$' + v.toExponential(1);
  }

  function fmtPrice(v) {
    if (v == null || !Number.isFinite(v)) return '—';
    return '$' + (v % 1 === 0 ? String(v) : v.toFixed(2)) + '/mo';
  }

  // ---------- catalog parsing ----------

  function parseModelsDevCatalog(data) {
    const out = [];
    const seen = new Set();
    if (!data || typeof data !== 'object') return out;
    PROVIDER_KEYS.forEach(function (pk) {
      const prov = data[pk];
      if (!prov || typeof prov !== 'object' || !prov.models || typeof prov.models !== 'object') return;
      Object.keys(prov.models).forEach(function (key) {
        const m = prov.models[key];
        if (!m || typeof m !== 'object') return;
        const rawId = typeof m.id === 'string' && m.id ? m.id : key;
        const id = rawId.toLowerCase();
        const dedupe = pk + '|' + dashNorm(id);
        if (seen.has(dedupe)) return;
        seen.add(dedupe);
        const cost = m.cost && typeof m.cost === 'object' ? m.cost : {};
        const input = num(cost.input);
        const output = num(cost.output);
        out.push({
          id,
          name: typeof m.name === 'string' && m.name ? m.name : key,
          provider: pk,
          providerName: PROVIDER_NAMES[pk] || pk,
          apiInput: input != null && input >= 0 ? input : null,
          apiOutput: output != null && output >= 0 ? output : null,
          reasoning: !!m.reasoning,
        });
      });
    });
    return out;
  }

  function parseSnapshot(data) {
    const out = [];
    const list = data && Array.isArray(data.models) ? data.models : [];
    list.forEach(function (r) {
      if (!r || typeof r !== 'object' || typeof r.slug !== 'string' || !r.slug) return;
      const score = num(r.intelligenceIndex);
      const cpt = num(r.costPerTask);
      out.push({
        slug: r.slug,
        name: typeof r.name === 'string' && r.name ? r.name : r.slug,
        creator: typeof r.creator === 'string' ? r.creator : '',
        creatorSlug: typeof r.creatorSlug === 'string' ? r.creatorSlug : '',
        intelligenceIndex: score != null && score >= 0 ? score : null,
        costPerTask: cpt != null && cpt > 0 ? cpt : null,
        url: typeof r.url === 'string' && r.url ? r.url : 'https://artificialanalysis.ai/models/' + r.slug,
      });
    });
    return out;
  }

  function parsePlans(data) {
    const raw = Array.isArray(data) ? data : (data && Array.isArray(data.entries) ? data.entries : []);
    const out = [];
    raw.forEach(function (e) {
      if (!e || typeof e !== 'object') return;
      const provider = typeof e.provider === 'string' ? e.provider : '';
      const model = typeof e.model === 'string' ? e.model : '';
      if (!provider || !model || !Array.isArray(e.plans)) return;
      const plans = [];
      e.plans.forEach(function (p) {
        if (!p || typeof p !== 'object') return;
        const price = num(p.price);
        const multiple = num(p.multiple);
        if (!p.name || price == null || price < 0 || multiple == null || multiple <= 0) return;
        plans.push({ name: String(p.name), price, multiple });
      });
      if (!plans.length) return;
      out.push({
        provider,
        providerName: typeof e.providerName === 'string' ? e.providerName : (PROVIDER_NAMES[provider] || provider),
        model,
        modelName: typeof e.modelName === 'string' ? e.modelName : model,
        source: typeof e.source === 'string' ? e.source : 'https://opencode.ai/docs/go',
        collected_at: typeof e.collected_at === 'string' ? e.collected_at : '',
        plans,
      });
    });
    return out;
  }

  // ---------- cross-catalog matching ----------
  // Exact dash-normalized keys first, then a release-suffix prefix match.
  // The latter covers AA's dated slugs (deepseek-v4-1-flash-1017) without
  // turning family members into matches (claude-opus-5 ≠ claude-opus-5-5).

  function releaseSuffix(longer, shorter) {
    if (!longer || !shorter || longer.indexOf(shorter + '-') !== 0) return false;
    return /^\d{3,8}$/.test(longer.slice(shorter.length + 1));
  }

  function closeVariant(a, b) {
    return releaseSuffix(a, b) || releaseSuffix(b, a);
  }

  function makeAaIndex(snapshotRows) {
    const byKey = new Map();
    snapshotRows.forEach(function (row) {
      const keys = [row.slug, row.name, row.creatorSlug].filter(Boolean);
      keys.forEach(function (k) {
        normVariants(k).forEach(function (v) {
          if (v && !byKey.has(v)) byKey.set(v, row);
        });
      });
    });
    return { byKey: byKey, keys: Array.from(byKey.keys()).sort() };
  }

  function findAaRecord(id, index) {
    if (!index) return null;
    const variants = normVariants(id);
    for (let i = 0; i < variants.length; i++) {
      if (index.byKey.has(variants[i])) return index.byKey.get(variants[i]);
    }
    let best = null;
    let bestDiff = Infinity;
    for (let i = 0; i < variants.length; i++) {
      const d = variants[i];
      if (!d) continue;
      for (let j = 0; j < index.keys.length; j++) {
        const k = index.keys[j];
        if (k === d) return index.byKey.get(k);
        if (closeVariant(k, d)) {
          const diff = Math.abs(k.length - d.length);
          if (diff < bestDiff) { best = index.byKey.get(k); bestDiff = diff; }
        }
      }
    }
    return best;
  }

  function makePlanIndex(planEntries) {
    const byKey = new Map();
    planEntries.forEach(function (e) {
      const key = e.provider + '|' + dashNorm(e.model);
      if (!byKey.has(key)) byKey.set(key, e);
    });
    return { entries: planEntries, byKey: byKey };
  }

  function findPlanEntry(provider, id, index) {
    if (!index) return null;
    const variants = normVariants(id);
    for (let i = 0; i < variants.length; i++) {
      const hit = index.byKey.get(provider + '|' + variants[i]);
      if (hit) return hit;
    }
    let best = null;
    let bestDiff = Infinity;
    for (let i = 0; i < index.entries.length; i++) {
      const e = index.entries[i];
      if (e.provider !== provider) continue;
      const k = dashNorm(e.model);
      for (let j = 0; j < variants.length; j++) {
        const d = variants[j];
        if (k === d) return e;
        if (closeVariant(k, d)) {
          const diff = Math.abs(k.length - d.length);
          if (diff < bestDiff) { best = e; bestDiff = diff; }
        }
      }
    }
    return best;
  }

  function makeWorkerIndex(workerModels) {
    const byKey = new Map();
    (Array.isArray(workerModels) ? workerModels : []).forEach(function (m) {
      if (!m || typeof m !== 'object') return;
      const keys = [m.id, m.label, m.aa && m.aa.slug, m.aa && m.aa.name].filter(Boolean);
      keys.forEach(function (k) {
        normVariants(k).forEach(function (v) {
          if (v && !byKey.has(v)) byKey.set(v, m);
        });
      });
    });
    return { byKey: byKey, keys: Array.from(byKey.keys()).sort() };
  }

  function findWorkerRecord(id, aaSlug, index) {
    if (!index) return null;
    const candidates = normVariants(id).concat(normVariants(aaSlug));
    for (let i = 0; i < candidates.length; i++) {
      if (index.byKey.has(candidates[i])) return index.byKey.get(candidates[i]);
    }
    let best = null;
    let bestDiff = Infinity;
    for (let i = 0; i < candidates.length; i++) {
      const d = candidates[i];
      if (!d) continue;
      for (let j = 0; j < index.keys.length; j++) {
        const k = index.keys[j];
        if (k === d) return index.byKey.get(k);
        if (closeVariant(k, d)) {
          const diff = Math.abs(k.length - d.length);
          if (diff < bestDiff) { best = index.byKey.get(k); bestDiff = diff; }
        }
      }
    }
    return best;
  }

  function workerScore(m) {
    if (!m) return null;
    const v = m.aa && num(m.aa.intelligenceIndex) != null ? m.aa.intelligenceIndex : m.intelligenceIndex;
    const n = num(v);
    return n != null && n >= 0 ? n : null;
  }

  function workerCostPerTask(m) {
    if (!m || !m.aa) return null;
    const n = num(m.aa.costPerTask);
    return n != null && n > 0 ? n : null;
  }

  // ---------- dataset ----------

  function buildDataset(opts) {
    const options = opts || {};
    const catalogRaw = options.modelsDev
      || (options.snapshot && options.snapshot.modelsDev)
      || null;
    const catalog = Array.isArray(catalogRaw) ? catalogRaw : parseModelsDevCatalog(catalogRaw);
    const snapshotRows = Array.isArray(options.snapshotModels)
      ? options.snapshotModels
      : parseSnapshot(options.snapshot || null);
    const planEntries = Array.isArray(options.plans) ? options.plans : parsePlans(options.plans || null);
    const aaIndex = makeAaIndex(snapshotRows);
    const planIndex = makePlanIndex(planEntries);
    const workerIndex = makeWorkerIndex(options.workerModels || []);

    const models = catalog.map(function (m) {
      const aa = findAaRecord(m.id, aaIndex);
      let score = aa ? aa.intelligenceIndex : null;
      let cpt = aa ? aa.costPerTask : null;
      let scoreSource = aa ? 'snapshot' : null;
      let costTaskSource = aa && aa.costPerTask != null ? 'snapshot' : null;
      const worker = findWorkerRecord(m.id, aa && aa.slug, workerIndex);
      const liveScore = workerScore(worker);
      if (liveScore != null) { score = liveScore; scoreSource = 'live'; }
      const liveCpt = workerCostPerTask(worker);
      if (liveCpt != null) { cpt = liveCpt; costTaskSource = 'live'; }
      const planEntry = findPlanEntry(m.provider, m.id, planIndex)
        || (aa && findPlanEntry(m.provider, aa.slug, planIndex));
      return {
        id: m.id,
        key: m.provider + '/' + dashNorm(m.id),
        name: m.name,
        provider: m.provider,
        providerName: m.providerName,
        apiInput: m.apiInput,
        apiOutput: m.apiOutput,
        intelligenceIndex: score,
        scoreSource: scoreSource,
        costPerTask: cpt,
        costTaskSource: costTaskSource,
        aaSlug: aa ? aa.slug : null,
        aaName: aa ? aa.name : null,
        aaUrl: aa ? aa.url : null,
        effort: null,
        plans: planEntry ? planEntry.plans.slice() : [],
        planEntry: planEntry || null,
      };
    });

    return {
      models,
      plans: planEntries,
      meta: {
        source: options.snapshot && options.snapshot.source ? options.snapshot.source : 'https://artificialanalysis.ai/models',
        collected_at: options.snapshot && options.snapshot.collected_at ? options.snapshot.collected_at : '',
      },
    };
  }

  function modelKey(m) {
    return m.provider + '/' + dashNorm(m.id);
  }

  /** Compact AA-shaped view of a cached dataset — never the raw 7 MB catalog. */
  function snapshotFromDataset(dataset) {
    if (!dataset || !Array.isArray(dataset.models)) return null;
    const models = dataset.models.filter(function (m) {
      return m.aaSlug && Number.isFinite(m.intelligenceIndex);
    }).map(function (m) {
      return {
        slug: m.aaSlug,
        name: m.aaName || m.name,
        creator: m.providerName,
        intelligenceIndex: m.intelligenceIndex,
        costPerTask: m.costPerTask,
        url: m.aaUrl,
      };
    });
    if (!models.length) return null;
    return {
      source: dataset.meta && dataset.meta.source,
      collected_at: dataset.meta && dataset.meta.collected_at,
      models,
    };
  }

  function buildPoints(dataset, mode, providerFilter, hiddenSet) {
    const result = {
      mode,
      points: [],
      allPoints: [],
      excluded: [],
      noPlan: [],
      noScoreCount: 0,
      modelCount: 0,
    };
    if (!dataset || !Array.isArray(dataset.models)) return result;
    const hidden = hiddenSet instanceof Set ? hiddenSet : new Set();
    const wantedMode = MODES.indexOf(mode) >= 0 ? mode : 'subsidized';
    const models = dataset.models.filter(function (m) {
      return !providerFilter || providerFilter === 'all' || m.provider === providerFilter;
    });
    result.modelCount = models.length;

    models.forEach(function (m) {
      const hasPlan = m.plans.length > 0;
      if (!hasPlan) result.noPlan.push(m);
      const score = num(m.intelligenceIndex);
      if (score == null) {
        result.noScoreCount++;
        result.excluded.push({ model: m, reason: 'Sem score AA' });
        return;
      }
      const base = {
        modelKey: modelKey(m),
        id: m.id,
        name: m.name,
        provider: m.provider,
        providerName: m.providerName,
        y: score,
        aaSlug: m.aaSlug,
        aaUrl: m.aaUrl,
        apiInput: m.apiInput,
        apiOutput: m.apiOutput,
      };

      if (wantedMode === 'subsidized') {
        if (!hasPlan) return;
        const cpt = num(m.costPerTask);
        let emitted = 0;
        if (cpt != null && cpt > 0) {
          m.plans.forEach(function (plan) {
            const effective = cpt / plan.multiple;
            if (!(effective > 0) || !Number.isFinite(effective)) return;
            emitted++;
            const point = Object.assign({}, base, {
              key: base.modelKey + '::' + plan.name,
              x: effective,
              planName: plan.name,
              planPrice: plan.price,
              multiple: plan.multiple,
              baseCostPerTask: cpt,
              effectiveCostPerTask: effective,
            });
            result.allPoints.push(point);
          });
        }
        if (!emitted) result.excluded.push({ model: m, reason: 'Sem cost_per_task AA' });
        return;
      }

      if (wantedMode === 'cost_per_task') {
        const cpt = num(m.costPerTask);
        if (cpt == null || cpt <= 0) {
          result.excluded.push({ model: m, reason: 'Sem cost_per_task AA' });
          return;
        }
        result.allPoints.push(Object.assign({}, base, {
          key: base.modelKey,
          x: cpt,
          baseCostPerTask: cpt,
        }));
        return;
      }

      const out = num(m.apiOutput);
      if (out == null) {
        result.excluded.push({ model: m, reason: 'Sem custo de API base' });
        return;
      }
      if (out <= 0) {
        result.excluded.push({ model: m, reason: 'API cost $0 — off the log scale' });
        return;
      }
      result.allPoints.push(Object.assign({}, base, {
        key: base.modelKey,
        x: out,
        apiInput: m.apiInput,
        apiOutput: out,
      }));
    });

    result.points = result.allPoints.filter(function (p) { return !hidden.has(p.modelKey); });
    return result;
  }

  function frontierOf(points) {
    const sorted = points.slice().sort(function (a, b) {
      return (a.x - b.x) || (b.y - a.y) || String(a.key).localeCompare(String(b.key));
    });
    const out = [];
    let bestY = -Infinity;
    sorted.forEach(function (p) {
      if (p.y > bestY) {
        out.push(p);
        bestY = p.y;
      }
    });
    return out;
  }

  const X_TICKS = [0.0001, 0.0002, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];

  function logTicks(lo, hi) {
    const out = X_TICKS.filter(function (t) { return t >= lo && t <= hi; });
    if (out.length < 2) {
      out.length = 0;
      out.push(lo, hi);
    }
    return out;
  }

  function linearTicks(lo, hi, count) {
    const n = count || 6;
    if (!(hi > lo)) return [lo];
    const rawStep = (hi - lo) / Math.max(1, n - 1);
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const norm = rawStep / mag;
    let nice;
    if (norm < 1.5) nice = 1;
    else if (norm < 3.5) nice = 2;
    else if (norm < 7.5) nice = 5;
    else nice = 10;
    const step = nice * mag;
    const start = Math.ceil(lo / step) * step;
    const out = [];
    for (let v = start; v <= hi + step * 0.5; v += step) {
      out.push(+((Math.round(v / step) * step)).toFixed(6));
      if (out.length >= 8) break;
    }
    return out.length ? out : [lo, hi];
  }

  function computeDomains(points, scale) {
    if (!points.length) return { xd: [0.01, 100], yd: [0, 100], xt: [0.01, 0.1, 1, 10, 100], yt: [0, 20, 40, 60, 80, 100] };
    const xs = points.map(function (p) { return p.x; }).filter(function (v) { return Number.isFinite(v) && v > 0; });
    const ys = points.map(function (p) { return p.y; }).filter(function (v) { return Number.isFinite(v); });
    const xmin = xs.length ? Math.min.apply(null, xs) : 0.01;
    const xmax = xs.length ? Math.max.apply(null, xs) : 100;
    let xd;
    if ((scale || 'log') === 'linear') {
      const pad = Math.max((xmax - xmin) * 0.15, xmax * 0.02, 0.0001);
      xd = [Math.max(0, xmin - pad), xmax + pad];
    } else {
      xd = [xmin / 1.6, xmax * 1.6];
    }
    const ymin = ys.length ? Math.min.apply(null, ys) : 0;
    const ymax = ys.length ? Math.max.apply(null, ys) : 100;
    const yd = [Math.floor((ymin - 2) / 5) * 5, Math.ceil((ymax + 2) / 5) * 5];
    const xt = (scale || 'log') === 'linear' ? linearTicks(xd[0], xd[1], 6) : logTicks(xd[0], xd[1]);
    const yt = [];
    for (let v = yd[0]; v <= yd[1]; v += 5) yt.push(v);
    return { xd, yd, xt, yt };
  }

  // ---------- state + DOM ----------

  const state = {
    mode: 'subsidized',
    xScale: loadXScale(),
    provider: 'all',
    dataset: null,
    results: null,
    activeKey: null,
    hidden: loadHidden(),
    stamp: 'loading',
    sources: { worker: null, modelsDev: null, snapshot: null, plans: null },
    lastError: false,
    lastUpdated: null,
  };

  function loadHidden() {
    try {
      const raw = JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]');
      return new Set(Array.isArray(raw) ? raw.filter(function (x) { return typeof x === 'string' && x; }) : []);
    } catch (_) { return new Set(); }
  }

  function saveHidden() {
    try { localStorage.setItem(HIDDEN_KEY, JSON.stringify(Array.from(state.hidden))); } catch (_) {}
  }

  function loadXScale() {
    try { return localStorage.getItem(XSCALE_KEY) === 'linear' ? 'linear' : 'log'; }
    catch (_) { return 'log'; }
  }

  function saveXScale() {
    try { localStorage.setItem(XSCALE_KEY, state.xScale); } catch (_) {}
  }

  function $(id) { return document.getElementById(id); }

  function setStamp(cls, text) {
    const el = $('stamp');
    const txt = $('stamp-text');
    if (el) {
      el.classList.remove('live', 'partial', 'snapshot', 'error');
      if (cls) el.classList.add(cls);
    }
    if (txt) txt.textContent = text;
    state.stamp = cls || 'idle';
  }

  function setChartLoading(on) {
    const el = $('chart-loading');
    if (el) el.classList.toggle('is-visible', !!on);
    const btn = $('stamp-refresh');
    if (btn) {
      btn.classList.toggle('spinning', !!on);
      btn.disabled = !!on;
    }
  }

  function fmtAge(ts) {
    const mins = Math.max(1, Math.round((Date.now() - ts) / 60000));
    if (mins < 60) return mins + ' min';
    return Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm';
  }

  function fmtClock(ts) {
    try { return new Date(ts).toISOString().slice(11, 16) + ' UTC'; }
    catch (_) { return ''; }
  }

  function readCache(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const entry = JSON.parse(raw);
      if (!entry || typeof entry.t !== 'number' || !entry.dataset || !Array.isArray(entry.dataset.models)) return null;
      return entry;
    } catch (_) { return null; }
  }

  function writeCache(key, dataset, t) {
    try { localStorage.setItem(key, JSON.stringify({ t: t || Date.now(), dataset })); } catch (_) {}
  }

  async function fetchJson(url) {
    const res = await fetch(url, { headers: { 'Accept': 'application/json' }, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!res.ok) throw new Error('fetch failed ' + res.status + ' ' + url);
    return res.json();
  }

  async function loadLive() {
    if (!window.LiveData || typeof window.LiveData.load !== 'function') return null;
    try { return await window.LiveData.load({ force: false }); }
    catch (_) { return null; }
  }

  async function loadData(force) {
    setChartLoading(true);
    setStamp(null, 'Fetching subsidy data…');
    state.lastError = false;

    if (!force) {
      const cached = readCache(CACHE_KEY);
      if (cached && Date.now() - cached.t < TTL_MS) {
        state.dataset = cached.dataset;
        state.lastUpdated = cached.t;
        setChartLoading(false);
        setStamp('live', 'Live · fetched ' + fmtAge(cached.t) + ' ago');
        render();
        return;
      }
    }

    const lastgood = readCache(LASTGOOD_KEY);
    const cached = readCache(CACHE_KEY);

    const settled = await Promise.allSettled([
      loadLive(),
      fetchJson(MODELS_DEV_URL),
      fetchJson(PLANS_URL),
      fetchJson(SNAPSHOT_URL),
    ]);
    const liveRes = settled[0].status === 'fulfilled' ? settled[0].value : null;
    const modelsDev = settled[1].status === 'fulfilled' ? settled[1].value : null;
    const plansData = settled[2].status === 'fulfilled' ? settled[2].value : null;
    const snapshot = settled[3].status === 'fulfilled' ? settled[3].value : null;

    state.sources = {
      worker: liveRes && liveRes.models ? liveRes : null,
      modelsDev,
      snapshot,
      plans: plansData,
    };

    const fallbackPlans = plansData || (lastgood && lastgood.dataset && lastgood.dataset.plans) || (cached && cached.dataset && cached.dataset.plans) || null;
    const lastgoodSnapshot = lastgood ? snapshotFromDataset(lastgood.dataset) : null;
    const fallbackSnapshot = snapshot || lastgoodSnapshot;
    const catalog = modelsDev || (snapshot && snapshot.modelsDev) || null;

    let dataset = null;
    if (catalog) {
      dataset = buildDataset({
        modelsDev: catalog,
        snapshot: fallbackSnapshot,
        plans: fallbackPlans,
        workerModels: liveRes && liveRes.models ? liveRes.models : null,
      });
    }

    if (dataset && dataset.models.length) {
      const t = Date.now();
      state.dataset = dataset;
      state.lastUpdated = t;
      writeCache(CACHE_KEY, dataset, t);
      writeCache(LASTGOOD_KEY, dataset, t);
      setChartLoading(false);
      updateStampFromSources(liveRes, dataset);
      render();
      return;
    }

    const fallback = (lastgood && lastgood.dataset) || (cached && cached.dataset) || null;
    if (fallback && Array.isArray(fallback.models) && fallback.models.length) {
      state.dataset = fallback;
      state.lastUpdated = (lastgood || cached).t;
      setChartLoading(false);
      const msg = liveRes && liveRes.state === 'stale'
        ? 'Stale live data · fetched ' + fmtAge((lastgood || cached).t) + ' ago · sources unreachable'
        : 'Stale subsidy data · fetched ' + fmtAge((lastgood || cached).t) + ' ago · sources unreachable';
      setStamp('partial', msg);
      render();
      return;
    }

    state.dataset = { models: [], plans: [], meta: {} };
    state.lastError = true;
    setChartLoading(false);
    setStamp('error', 'Failed to load subsidy data — sources unreachable. Check connection and try again.');
    render();
  }

  function updateStampFromSources(liveRes, dataset) {
    if (liveRes && liveRes.state === 'live') {
      setStamp('live', 'Live · updated ' + fmtClock(liveRes.fetchedAt || Date.now()));
      return;
    }
    if (liveRes && liveRes.state === 'cached') {
      setStamp('live', 'Live · fetched ' + fmtAge(liveRes.fetchedAt || Date.now()) + ' ago');
      return;
    }
    if (liveRes && liveRes.state === 'stale') {
      setStamp('partial', 'Stale live data · fetched ' + fmtAge(liveRes.fetchedAt || Date.now()) + ' ago · sources unreachable');
      return;
    }
    const date = dataset && dataset.meta && dataset.meta.collected_at ? dataset.meta.collected_at : '2026-11-23';
    setStamp('snapshot', 'Snapshot · ' + date + ' · live AA unavailable');
  }

  // ---------- rendering ----------

  function providerLabel(key) {
    return PROVIDER_NAMES[key] || key;
  }

  function visibleResults() {
    return buildPoints(state.dataset, state.mode, state.provider, state.hidden);
  }

  function modeLabel() {
    if (state.mode === 'subsidized') return 'subsidized cost per AA task';
    if (state.mode === 'cost_per_task') return 'AA cost per task';
    return 'API output cost';
  }

  function syncModeUI() {
    document.querySelectorAll('[data-mode]').forEach(function (btn) {
      const on = btn.getAttribute('data-mode') === state.mode;
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.classList.toggle('active', on);
    });
  }

  function syncScaleUI() {
    const btn = $('scale-toggle');
    const linear = state.xScale === 'linear';
    if (btn) {
      btn.textContent = linear ? 'X: Linear' : 'X: Log';
      btn.setAttribute('aria-pressed', linear ? 'true' : 'false');
    }
    const note = document.querySelector('.axis-note');
    if (note) {
      note.textContent = (linear ? 'X is linear' : 'X is log-scaled')
        + ' · 3 X modes: subsidized (default), cost per task, API cost · dot labels show plan where applicable';
    }
  }

  function syncProviderUI() {
    document.querySelectorAll('[data-provider]').forEach(function (btn) {
      const on = (btn.getAttribute('data-provider') || 'all') === state.provider;
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.classList.toggle('active', on);
    });
  }

  function svgEl(name, cls) {
    const n = document.createElementNS('http://www.w3.org/2000/svg', name);
    if (cls) n.setAttribute('class', cls);
    return n;
  }

  function renderChart(results) {
    const holder = $('chart-holder');
    if (!holder) return;
    const loading = $('chart-loading');
    const w = Math.max(280, Math.round(holder.clientWidth) || 760);
    const h = holder.clientHeight > 100 ? holder.clientHeight : Math.round(Math.min(660, Math.max(380, w * 0.56)));
    const points = results.points;
    const frontier = frontierOf(points);
    const frontierKeys = new Set(frontier.map(function (p) { return p.key; }));
    const { xd, yd, xt, yt } = computeDomains(points, state.xScale);
    const M = { top: 26, right: 24, bottom: 46, left: 58 };
    const iw = w - M.left - M.right;
    const ih = h - M.top - M.bottom;
    const scale = state.xScale === 'linear' ? 'linear' : 'log';
    const x = scale === 'linear'
      ? function (v) { return M.left + ((v - xd[0]) / ((xd[1] - xd[0]) || 1)) * iw; }
      : function (v) { return M.left + ((Math.log10(v) - Math.log10(xd[0])) / ((Math.log10(xd[1]) - Math.log10(xd[0])) || 1)) * iw; };
    const y = function (v) { return M.top + ih - ((v - yd[0]) / ((yd[1] - yd[0]) || 1)) * ih; };

    const svg = svgEl('svg', 'chart-svg');
    svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    svg.setAttribute('width', w);
    svg.setAttribute('height', h);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Subsidy scatter plot of ' + points.length + ' points. Horizontal axis: '
      + (state.mode === 'api_cost' ? 'API output cost in dollars per million tokens' : 'cost in dollars per AA task')
      + ', ' + scale + ' scale. Vertical axis: Artificial Analysis Intelligence Index.');

    const defs = svgEl('defs');
    defs.innerHTML = '<pattern id="hatch" patternUnits="userSpaceOnUse" width="7" height="7">'
      + '<path d="M0 7 L7 0" stroke="#1f49e0" stroke-opacity="0.10" stroke-width="1"/></pattern>';
    svg.appendChild(defs);

    const gGrid = svgEl('g');
    const gZone = svgEl('g');
    const gAxes = svgEl('g');
    const gDots = svgEl('g', 'layer-dots');
    svg.append(gGrid, gZone, gAxes, gDots);

    function line(parent, x1, y1, x2, y2, cls) {
      const l = svgEl('line', cls);
      l.setAttribute('x1', x1); l.setAttribute('y1', y1);
      l.setAttribute('x2', x2); l.setAttribute('y2', y2);
      parent.appendChild(l);
    }
    function text(parent, tx, ty, str, cls, anchor) {
      const t = svgEl('text', cls);
      t.setAttribute('x', tx); t.setAttribute('y', ty);
      if (anchor) t.setAttribute('text-anchor', anchor);
      t.textContent = str;
      parent.appendChild(t);
      return t;
    }

    xt.forEach(function (tv) {
      line(gGrid, x(tv), M.top, x(tv), M.top + ih, 'grid-minor');
      line(gGrid, x(tv), M.top + ih, x(tv), M.top + ih + 5, 'grid-major');
      text(gAxes, x(tv), M.top + ih + 18, fmtMoney(tv), 'tick-label', 'middle');
    });
    yt.forEach(function (tv) {
      line(gGrid, M.left, y(tv), M.left + iw, y(tv), tv % 10 === 0 ? 'grid-major' : 'grid-minor');
      text(gAxes, M.left - 8, y(tv) + 3.5, String(tv), 'tick-label', 'end');
    });
    line(gAxes, M.left, M.top + ih, M.left + iw, M.top + ih, 'grid-major');
    line(gAxes, M.left, M.top, M.left, M.top + ih, 'grid-major');

    const xTitle = state.mode === 'subsidized'
      ? 'SUBSIDIZED COST PER AA TASK (USD)'
      : state.mode === 'cost_per_task'
        ? 'COST PER AA TASK (USD)'
        : 'API OUTPUT COST (USD / 1M TOKENS)';
    text(gAxes, M.left + iw / 2, h - 7, xTitle, 'axis-title-x', 'middle');
    const yTitle = text(gAxes, 14, M.top + ih / 2, 'INTELLIGENCE INDEX (ARTIFICIAL ANALYSIS)', 'axis-title-y', 'middle');
    yTitle.setAttribute('transform', 'rotate(-90 14 ' + (M.top + ih / 2) + ')');

    if (frontier.length > 1) {
      const poly = svgEl('polygon', 'dominated-zone fade');
      const pts = [`${x(frontier[0].x)},${y(frontier[0].y)}`]
        .concat(frontier.slice(1).map(function (p) { return x(p.x) + ',' + y(p.y); }))
        .concat([`${x(frontier[frontier.length - 1].x)},${M.top + ih}`, `${x(frontier[0].x)},${M.top + ih}`])
        .join(' ');
      poly.setAttribute('points', pts);
      gZone.appendChild(poly);
      const zl = text(gZone, 0, 0, 'DOMINATED', 'zone-label', 'middle');
      const mx = (x(frontier[0].x) + x(frontier[frontier.length - 1].x)) / 2;
      zl.setAttribute('x', mx + 30);
      zl.setAttribute('y', M.top + ih - 14);
      zl.setAttribute('transform', 'rotate(-52 ' + (mx + 30) + ' ' + (M.top + ih - 14) + ')');

      const d = frontier.map(function (p, i) { return (i ? 'L' : 'M') + x(p.x) + ',' + y(p.y); }).join('');
      const halo = svgEl('path', 'frontier-halo');
      halo.setAttribute('d', d);
      const path = svgEl('path', 'frontier-path draw');
      path.setAttribute('d', d);
      path.setAttribute('stroke-dasharray', '7 5');
      gZone.append(halo, path);
    }

    points.forEach(function (p, idx) {
      const cx = x(p.x);
      const cy = y(p.y);
      const onF = frontierKeys.has(p.key);
      const g = svgEl('g', 'dot-point' + (onF ? ' frontier-member' : ''));
      g.setAttribute('tabindex', '0');
      g.setAttribute('role', 'img');
      g.dataset.key = p.key;
      g.dataset.id = p.modelKey;
      g.setAttribute('transform', 'translate(' + cx + ',' + cy + ')');

      let aria;
      if (state.mode === 'subsidized') {
        aria = p.name + ' (' + p.providerName + '), ' + p.planName + ' plan ' + fmtPrice(p.planPrice)
          + ' at ' + p.multiple + '×. Base cost per AA task ' + fmtMoney(p.baseCostPerTask)
          + ', subsidized ' + fmtMoney(p.effectiveCostPerTask) + ', intelligence ' + p.y
          + (onF ? ', on the Pareto frontier.' : '.');
      } else if (state.mode === 'cost_per_task') {
        aria = p.name + ' (' + p.providerName + '). ' + fmtMoney(p.x) + ' per AA task, intelligence ' + p.y
          + (onF ? ', on the Pareto frontier.' : '.');
      } else {
        aria = p.name + ' (' + p.providerName + '). API output ' + fmtMoney(p.apiOutput) + ' per 1M tokens'
          + (p.apiInput != null ? ', input ' + fmtMoney(p.apiInput) : '') + ', intelligence ' + p.y
          + (onF ? ', on the Pareto frontier.' : '.');
      }
      g.setAttribute('aria-label', aria);

      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = aria;
      g.appendChild(title);

      const mark = svgEl('circle', 'dot-mark');
      const r = onF ? 7.6 : 6.8;
      mark.setAttribute('r', r.toFixed(1));
      mark.setAttribute('fill', hueFor(p.provider));
      mark.classList.add('dot-enter');
      mark.style.animationDelay = (80 + (idx % 12) * 28) + 'ms';
      mark.addEventListener('animationend', function () { mark.classList.remove('dot-enter'); }, { once: true });

      const ring = svgEl('circle', 'dot-ring');
      ring.setAttribute('r', (r + 4.5).toFixed(1));
      g.append(mark, ring);

      if (w >= 640 && points.length <= 6) {
        const label = state.mode === 'subsidized'
          ? (p.name + ' · ' + p.planName).slice(0, 28)
          : p.name.slice(0, 26);
        text(g, 11, -8, label, 'dot-label', 'start');
      }

      g.addEventListener('pointerenter', function () { setActive(p.key); });
      g.addEventListener('pointerleave', function () { setActive(null); });
      g.addEventListener('focus', function () { setActive(p.key); });
      g.addEventListener('blur', function () { setActive(null); });
      g.addEventListener('click', function (e) { e.stopPropagation(); setActive(p.key); });
      gDots.appendChild(g);
    });

    svg.addEventListener('click', function () { setActive(null); });
    holder.replaceChildren(svg);
    if (loading) holder.appendChild(loading);
  }

  const HUES = ['#3B5BDB', '#D9480F', '#0CA678', '#9C36B5', '#0C8599'];
  function hueFor(provider) {
    const idx = PROVIDER_KEYS.indexOf(provider);
    return HUES[idx >= 0 ? idx : 0];
  }

  function setActive(key) {
    state.activeKey = key;
    const holder = $('chart-holder');
    if (holder) {
      holder.querySelectorAll('.dot-point.is-active').forEach(function (g) { g.classList.remove('is-active'); });
      if (key) {
        holder.querySelectorAll('.dot-point').forEach(function (g) {
          if (g.dataset.key === key) g.classList.add('is-active');
        });
      }
    }
    const point = key && state.results
      ? state.results.points.filter(function (p) { return p.key === key; })[0]
      : null;
    renderReadout(point || null);
  }

  function renderReadout(point) {
    const el = $('readout');
    if (!el) return;
    if (!point) {
      const res = state.results || { points: [], noScoreCount: 0, noPlan: [] };
      el.innerHTML = '<h3 class="readout-empty-title">Reading the subsidy map</h3>'
        + '<p class="readout-lede">' + esc(modeLabel()) + ' on X, Artificial Analysis Intelligence Index on Y. '
        + 'Hover or focus a dot for the full plan arithmetic. The dashed cobalt line is the Pareto frontier.</p>'
        + '<ul class="readout-members">'
        + '<li><span class="m-name">Pontos plotados</span><span class="m-vals">' + res.points.length + '</span></li>'
        + '<li><span class="m-name">Sem score AA</span><span class="m-vals">' + res.noScoreCount + '</span></li>'
        + '<li><span class="m-name">Sem tabela de subsídio</span><span class="m-vals">' + res.noPlan.length + '</span></li>'
        + '</ul>';
      return;
    }
    const badge = state.results && frontierOf(state.results.points).some(function (p) { return p.key === point.key; })
      ? '<span class="badge on-frontier">Pareto frontier</span>'
      : '';
    let grid = '';
    if (state.mode === 'subsidized') {
      grid = gridItem('Plano', esc(point.planName))
        + gridItem('Preço do plano', esc(fmtPrice(point.planPrice)))
        + gridItem('Múltiplo de subsídio', esc(point.multiple + '×'))
        + gridItem('cost_per_task base', esc(fmtMoney(point.baseCostPerTask)))
        + gridItem('Custo subsidiado / tarefa', esc(fmtMoney(point.effectiveCostPerTask)))
        + gridItem('Score AA', esc(String(point.y)));
    } else if (state.mode === 'cost_per_task') {
      grid = gridItem('cost_per_task', esc(fmtMoney(point.x)))
        + gridItem('Score AA', esc(String(point.y)));
    } else {
      grid = gridItem('API output / 1M', esc(fmtMoney(point.apiOutput)))
        + gridItem('API input / 1M', esc(point.apiInput == null ? '—' : fmtMoney(point.apiInput)))
        + gridItem('Score AA', esc(String(point.y)));
    }
    el.innerHTML = '<h3 class="readout-model-title"><span>' + esc(point.name) + '</span></h3>'
      + '<p class="readout-author">' + esc(point.providerName) + '</p>'
      + '<div class="readout-badges">' + badge + '</div>'
      + '<dl class="readout-grid">' + grid + '</dl>'
      + (point.aaUrl
        ? '<p class="readout-links"><a href="' + esc(point.aaUrl) + '" target="_blank" rel="noopener">Artificial Analysis ↗</a></p>'
        : '');
  }

  function gridItem(label, value) {
    return '<div><dt>' + esc(label) + '</dt><dd>' + value + '</dd></div>';
  }

  function renderExcluded(results) {
    const list = $('excluded-list');
    const count = $('excluded-count');
    if (count) {
      count.textContent = results.noScoreCount + ' modelos sem score AA'
        + (results.excluded.length > results.noScoreCount
          ? ' · ' + (results.excluded.length - results.noScoreCount) + ' sem o eixo X deste modo'
          : '');
    }
    if (!list) return;
    list.innerHTML = results.excluded.map(function (e) {
      return '<li><div class="excluded-row"><span class="excluded-name">' + esc(e.model.name) + '</span>'
        + '<span class="excluded-axis">' + esc(e.model.providerName) + '</span></div>'
        + '<p class="excluded-reason">' + esc(e.reason) + '</p></li>';
    }).join('');
  }

  function renderNoPlan(results) {
    const list = $('no-plan-list');
    const count = $('no-plan-count');
    if (count) {
      count.textContent = results.noPlan.length + ' modelo'
        + (results.noPlan.length === 1 ? '' : 's')
        + ' sem múltiplo de subsídio publicado';
    }
    if (!list) return;
    list.innerHTML = results.noPlan.map(function (m) {
      return '<li><div class="excluded-row"><span class="excluded-name">' + esc(m.name) + '</span>'
        + '<span class="excluded-axis">' + esc(m.providerName) + '</span></div>'
        + '<p class="excluded-reason">Sem tabela de subsídio publicada — não plotado no modo subsidiado.</p></li>';
    }).join('');
  }

  function renderToggles(results) {
    const el = $('toggles');
    if (!el) return;
    const models = {};
    results.allPoints.forEach(function (p) {
      if (!models[p.modelKey]) models[p.modelKey] = { key: p.modelKey, name: p.name, provider: p.provider, providerName: p.providerName };
    });
    const keys = Object.keys(models).sort(function (a, b) {
      return String(models[a].name).localeCompare(String(models[b].name));
    });
    if (!keys.length) {
      el.innerHTML = '<p class="panel-sub">Nenhum modelo plotável neste modo.</p>';
      return;
    }
    el.innerHTML = keys.map(function (key) {
      const m = models[key];
      const on = !state.hidden.has(key);
      return '<div class="lab-group"><div class="lab-row">'
        + '<button type="button" class="chip" data-model-key="' + esc(key) + '" aria-pressed="' + (on ? 'true' : 'false') + '">'
        + '<span class="chip-dot" style="background:' + esc(hueFor(m.provider)) + '"></span>'
        + '<span class="chip-name">' + esc(m.name) + '</span>'
        + '<span class="chip-state">' + (on ? 'on' : 'off') + '</span></button>'
        + '<span class="excluded-axis">' + esc(m.providerName) + '</span>'
        + '</div></div>';
    }).join('');
    el.querySelectorAll('[data-model-key]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const key = btn.getAttribute('data-model-key');
        if (state.hidden.has(key)) state.hidden.delete(key); else state.hidden.add(key);
        saveHidden();
        render();
      });
    });
  }

  function renderCount(results) {
    const el = $('visible-count');
    if (!el) return;
    const frontier = frontierOf(results.points);
    const unit = state.mode === 'subsidized' ? 'pontos' : 'modelos';
    el.textContent = results.points.length + ' de ' + results.allPoints.length + ' ' + unit + ' plotados'
      + ' · ' + results.noScoreCount + ' modelos sem score AA'
      + ' · ' + results.noPlan.length + ' sem tabela de subsídio'
      + ' · frontier tem ' + frontier.length + ' ' + (state.mode === 'subsidized' ? 'pontos' : 'modelos');
  }

  function updateTable(results) {
    let table = document.getElementById('sr-data-table');
    if (!table) {
      table = document.createElement('table');
      table.className = 'visually-hidden';
      table.id = 'sr-data-table';
      const panel = document.querySelector('.toggles-panel');
      if (panel) panel.appendChild(table);
    }
    const modeCols = state.mode === 'subsidized'
      ? '<th>Plan</th><th>Plan price</th><th>Multiple</th><th>Subsidized cost/task</th>'
      : state.mode === 'cost_per_task'
        ? '<th>Cost per task</th>'
        : '<th>API input</th><th>API output</th>';
    table.innerHTML = '<caption>Subsidy data</caption>'
      + '<thead><tr><th>Model</th><th>Provider</th>' + modeCols + '<th>Intelligence Index</th></tr></thead><tbody>'
      + results.points.map(function (p) {
        const modeCells = state.mode === 'subsidized'
          ? '<td>' + esc(p.planName) + '</td><td>' + esc(fmtPrice(p.planPrice)) + '</td><td>' + esc(p.multiple + '×')
            + '</td><td>' + esc(fmtMoney(p.effectiveCostPerTask)) + '</td>'
          : state.mode === 'cost_per_task'
            ? '<td>' + esc(fmtMoney(p.x)) + '</td>'
            : '<td>' + esc(p.apiInput == null ? '—' : fmtMoney(p.apiInput)) + '</td><td>' + esc(fmtMoney(p.apiOutput)) + '</td>';
        return '<tr><td>' + esc(p.name) + '</td><td>' + esc(p.providerName) + '</td>' + modeCells
          + '<td>' + esc(String(p.y)) + '</td></tr>';
      }).join('')
      + results.excluded.map(function (e) {
        return '<tr><td>' + esc(e.model.name) + ' (not plottable)</td><td>' + esc(e.model.providerName)
          + '</td><td colspan="' + (state.mode === 'subsidized' ? 4 : state.mode === 'cost_per_task' ? 1 : 2)
          + '">' + esc(e.reason) + '</td><td>' + esc(e.model.intelligenceIndex == null ? 'n/a' : String(e.model.intelligenceIndex)) + '</td></tr>';
      }).join('')
      + '</tbody>';
  }

  function render() {
    if (!state.dataset) {
      state.dataset = { models: [], plans: [], meta: {} };
    }
    const results = visibleResults();
    state.results = results;
    renderChart(results);
    renderReadout(state.activeKey
      ? results.points.filter(function (p) { return p.key === state.activeKey; })[0] || null
      : null);
    renderExcluded(results);
    renderNoPlan(results);
    renderToggles(results);
    renderCount(results);
    updateTable(results);
    syncModeUI();
    syncScaleUI();
    syncProviderUI();
  }

  // ---------- wiring ----------

  function setMode(mode) {
    if (MODES.indexOf(mode) < 0) return false;
    state.mode = mode;
    state.activeKey = null;
    render();
    return true;
  }

  function setProvider(provider) {
    state.provider = PROVIDER_KEYS.indexOf(provider) >= 0 ? provider : 'all';
    render();
  }

  function setScale(scale) {
    state.xScale = scale === 'linear' ? 'linear' : 'log';
    saveXScale();
    render();
  }

  function applyAction(action) {
    if (!state.results) return;
    if (action === 'none') {
      state.results.allPoints.forEach(function (p) { state.hidden.add(p.modelKey); });
    } else if (action === 'frontier') {
      const frontier = frontierOf(state.results.points);
      const keep = new Set(frontier.map(function (p) { return p.modelKey; }));
      state.results.allPoints.forEach(function (p) {
        if (keep.has(p.modelKey)) state.hidden.delete(p.modelKey); else state.hidden.add(p.modelKey);
      });
    } else {
      state.hidden.clear();
    }
    saveHidden();
    render();
  }

  function bindUI() {
    document.querySelectorAll('[data-mode]').forEach(function (btn) {
      btn.addEventListener('click', function () { setMode(btn.getAttribute('data-mode')); });
    });
    document.querySelectorAll('[data-provider]').forEach(function (btn) {
      btn.addEventListener('click', function () { setProvider(btn.getAttribute('data-provider')); });
    });
    document.querySelectorAll('[data-action]').forEach(function (btn) {
      btn.addEventListener('click', function () { applyAction(btn.getAttribute('data-action')); });
    });
    const scale = $('scale-toggle');
    if (scale) scale.addEventListener('click', function () { setScale(state.xScale === 'linear' ? 'log' : 'linear'); });
    const refresh = $('stamp-refresh');
    if (refresh) refresh.addEventListener('click', function () { loadData(true); });
  }

  function boot() {
    if (typeof document === 'undefined' || !$('chart-holder')) return;
    bindUI();
    syncProviderUI();
    syncModeUI();
    setChartLoading(true);
    loadData(false);
  }

  // Pure helpers for the headless suite — no DOM work here.
  window.MVM_SUBSIDY_TEST = {
    dashNorm,
    normVariants,
    parseModelsDevCatalog,
    parseSnapshot,
    parsePlans,
    makeAaIndex,
    findAaRecord,
    findPlanEntry,
    buildDataset,
    snapshotFromDataset,
    buildPoints,
    frontierOf,
    computeDomains,
    logTicks,
    linearTicks,
    fmtMoney,
    fmtPrice,
    esc,
    MODEL_DEV_URL: MODELS_DEV_URL,
    CACHE_KEY,
    LASTGOOD_KEY,
    MODES,
    PROVIDERS: PROVIDER_KEYS,
    state,
    setMode,
    setProvider,
    setScale,
    boot,
    loadData,
    render,
    renderReadout,
    applyAction,
  };

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }
})();
