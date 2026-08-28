/** Shared env builder for live.js behavioral tests — worker only. */
import { createSandbox, DEFAULT_CLOCK_START } from './sandbox.js';
import { makeFetch } from './fake-fetch.js';
import {
  aaIndexHtml, modelsDevCatalog,
  tinySnapshot, tinyCoverage,
} from './fixtures.js';

export const MODELS_DEV = 'https://models.dev/api.json';
export const AA_INDEX = 'https://artificialanalysis.ai/models';
export const WORKER_URL = 'https://model-value-map-api.pswerlang.workers.dev/';
export const WORKER_URL_RE = /^https:\/\/model-value-map-api\.pswerlang\.workers\.dev\/$/;
export const CURATED_GO = 'https://opencode.ai/docs/go';
export const WORKER_CURATED = 'https://model-value-map-api.pswerlang.workers.dev/curated';

function curatedHtmlFor(snapshot) {
  const ids = snapshot.map((m) => m.id);
  const rows = ids.map((id) => `<tr><td>${id} label</td><td>${id}</td></tr>`).join('');
  const lis = ids.map((id) => `<li><strong>${id}</strong></li>`).join('');
  return `<html><body><table><thead><tr><th>Model</th><th>Model ID</th></tr></thead><tbody>${rows}</tbody></table><ul>${lis}</ul></body></html>`;
}

function buildWorkerModels(snapshot, coverage, modelsDev) {
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
  const norm = (s) => (s||'').toLowerCase().replace(/[\/._]/g, '-');
  const reverse = Object.fromEntries(Object.entries(AA_SLUG).map(([k,v])=>[v,k]));
  const mdMap = new Map();
  if (modelsDev && typeof modelsDev === 'object') {
    for (const pk of Object.keys(modelsDev)) {
      const prov = modelsDev[pk];
      if (!prov || !prov.models) continue;
      for (const [k, m] of Object.entries(prov.models)) {
        if (!m || !m.cost || typeof m.cost.output !== 'number' || m.cost.output < 0) continue;
        const cost = m.cost;
        const info = {
          id: m.id || k,
          name: m.name || k,
          cost: {
            input: typeof cost.input === 'number' ? cost.input : null,
            output: cost.output,
            cacheRead: typeof cost.cache_read === 'number' ? cost.cache_read : (typeof cost.cacheRead === 'number' ? cost.cacheRead : null),
            cacheWrite: typeof cost.cache_write === 'number' ? cost.cache_write : (typeof cost.cacheWrite === 'number' ? cost.cacheWrite : null),
          },
          limit: { context: m.limit && typeof m.limit.context === 'number' ? m.limit.context : null, output: m.limit && typeof m.limit.output === 'number' ? m.limit.output : null },
          openWeights: m.open_weights != null ? !!m.open_weights : (m.openWeights != null ? !!m.openWeights : null),
          reasoning: !!m.reasoning,
        };
        for (const kk of [m.id, k, norm(m.id||''), norm(k)]) if (kk) mdMap.set(kk, info);
      }
    }
  }
  const aaMap = new Map();
  for (const r of coverage.aaRecords || []) {
    if (!r || !r.slug || !r.shortName || typeof r.intelligenceIndex !== 'number' || !Number.isFinite(r.intelligenceIndex) || r.intelligenceIndex < 0) continue;
    if (aaMap.has(r.slug)) continue;
    const rounded = { ...r, intelligenceIndex: Math.round(r.intelligenceIndex * 100) / 100 };
    if (r.effort && r.effort.label) rounded.effort = r.effort;
    aaMap.set(r.slug, rounded);
  }
  const out = [];
  const seen = new Set();
  for (const [slug, aa] of aaMap) {
    const ocId = reverse[slug] || null;
    const effectiveId = ocId || slug;
    const md = mdMap.get(ocId) || mdMap.get(norm(ocId||'')) || mdMap.get(slug) || mdMap.get(norm(slug)) || null;
    if (!md) continue; // only models available at OpenCode
    seen.add(effectiveId); seen.add(norm(effectiveId)); seen.add(slug); seen.add(norm(slug));
    const cost = md.cost.output;
    const plot = typeof cost === 'number' && cost > 0 && typeof aa.intelligenceIndex === 'number' && aa.intelligenceIndex > 0;
    out.push({
      id: effectiveId,
      label: aa.shortName || effectiveId,
      author: (aa.creator && aa.creator.name) || null,
      ocCostPerM: cost,
      ocCost: md.cost,
      intelligenceIndex: aa.intelligenceIndex,
      aa: { slug, name: aa.name || aa.shortName, intelligenceIndex: aa.intelligenceIndex, effort: aa.effort?.label || null, isOpenWeights: !!aa.isOpenWeights, url: 'https://artificialanalysis.ai/models/'+slug },
      contextWindowTokens: md.limit.context,
      reasoning: !!md.reasoning,
      openWeights: md.openWeights,
      plot,
      excludeReason: !plot ? 'Missing intelligence score' : null,
      hue: '#3B5BDB',
    });
  }
  const snapIds = snapshot.map((m)=>m.id);
  for (const id of snapIds) {
    if (seen.has(id) || seen.has(norm(id))) continue;
    const slug = AA_SLUG[id] || norm(id);
    if (aaMap.has(slug) || aaMap.has(id) || aaMap.has(norm(slug)) || aaMap.has(norm(id))) continue;
    const snap = snapshot.find((m)=>m.id===id);
    if (!snap) continue;
    if (!snap.plot) {
      const cost = snap.ocCostPerM;
      const score = snap.aa && typeof snap.aa.intelligenceIndex === 'number' ? snap.aa.intelligenceIndex : null;
      const plot = typeof cost === 'number' && cost > 0 && typeof score === 'number' && score > 0;
      const excludeReason = !plot ? (cost == null ? 'Missing pricing' : 'Missing intelligence score') : null;
      out.push({ ...snap, plot, excludeReason, aa: snap.aa || null });
    }
  }
  return out;
}

export function standardEnv(over = {}) {
  const snapshot = over.snapshot ?? over.models ?? tinySnapshot();
  const cov = { ...tinyCoverage(), ...(over.coverage ?? {}) };
  const modelsDev = over.modelsDev ?? modelsDevCatalog(over.modelsDevModels);
  const workerModels = over.workerModels ?? buildWorkerModels(snapshot, cov, modelsDev);

  // Worker rule needs to be available before createSandbox (app boot fetches immediately).
  // Use a mutable holder so body can read the mocked clock after sb is created.
  let sbRef = null;
  const dynamicWorker = {
    test: WORKER_URL_RE,
    body: () => {
      const now = sbRef ? sbRef.Date.now() : (over.clockStart ?? DEFAULT_CLOCK_START);
      return JSON.stringify({ t: now, meta: { mocked: true }, models: workerModels });
    },
  };
  const workerRule = (() => {
    if (over.workerRule) return over.workerRule;
    if (over.workerFail) return { test: WORKER_URL_RE, fail: true };
    if (over.workerT != null) return { test: WORKER_URL_RE, json: { t: over.workerT, meta: { mocked: true }, models: workerModels } };
    return dynamicWorker;
  })();

  const rules = [];
  rules.push(workerRule);
  // curated Go docs (app scrapes at boot) + worker curated fallback
  const goHtml = over.curatedGoHtml ?? curatedHtmlFor(snapshot);
  const curatedIds = over.curatedIds ?? snapshot.map((m) => m.id);
  const workerCuratedRule = (() => {
    if (over.workerCuratedRule) return over.workerCuratedRule;
    if (over.workerCuratedFail) return { test: WORKER_CURATED, fail: true };
    return { test: WORKER_CURATED, json: { t: over.clockStart ?? DEFAULT_CLOCK_START, ids: curatedIds } };
  })();
  const goRule = (() => {
    if (over.curatedGoRule) return over.curatedGoRule;
    if (over.curatedGoFail) return { test: CURATED_GO, fail: true };
    return { test: CURATED_GO, body: goHtml };
  })();
  rules.push(goRule, workerCuratedRule);
  if (over.aaPageRules) rules.push(...over.aaPageRules);
  else if (over.aaPageRule) rules.push(over.aaPageRule);
  else rules.push({ test: /^https:\/\/artificialanalysis\.ai\/models\/.+/, status: 404 });
  rules.push(
    over.modelsDevRule ?? { test: MODELS_DEV, json: modelsDev },
    over.aaIndexRule ?? { test: AA_INDEX, body: aaIndexHtml(cov.aaRecords || []) },
    ...(over.extraRules ?? []),
  );
  const fetch = makeFetch(rules);
  const sb = createSandbox({
    snapshotSource:
      'window.DASHBOARD_DATA={meta:{sources:[' +
      '{name:"models.dev",url:"https://models.dev/api.json"},' +
      '{name:"artificialanalysis.ai/models",url:"https://artificialanalysis.ai/models"}' +
      ']},models:' + JSON.stringify(snapshot) + '};',
    fetchImpl: fetch,
    storage: over.storage,
    loadApp: !!over.loadApp,
    loadLive: over.loadLive !== false,
    clockStart: over.clockStart,
  });
  sbRef = sb;

  return { sb, fetch, Date: sb.Date };
}
