/**
 * Shared fixtures. Ids deliberately reuse entries from live.js's curated
 * AA_SLUG map so the tiered matching paths are exercisable:
 *   kimi-k3                      — curated slug, plots
 *   mimo-v2.5                    — dotted id, normalized slug differs from id
 *   ox-alpha                     — no cost, no score (unplottable both axes)
 *   muse-spark-1.2-contributor   — has score but no published cost
 */

let uuidSeq = 0;
export function uuid() {
  const hex = (++uuidSeq).toString(16).padStart(8, '0');
  return ('a7f10000-0000-4000-8000-' + hex + '00000000').slice(0, 36);
}

// ---------- models.dev shapes ----------
export function modelsDevCatalog(models = {}) {
  return {
    moonshot: {
      name: 'Moonshot',
      models: {
        'kimi-k3': { name: 'Kimi K3', cost: { input: 3, output: 15, cache_read: 0.3 }, limit: { context: 1048576 }, open_weights: true, reasoning: true },
        'kimi-k2.7-code': { name: 'Kimi K2.7 Code', cost: { input: 2, output: 18, cache_read: 0.4 }, limit: { context: 256000 }, open_weights: true, reasoning: true },
        ...(models.moonshot || {}),
      },
    },
    xiaomi: {
      name: 'Xiaomi',
      models: {
        'mimo-v2.5': { name: 'MiMo-V2.5', cost: { input: 0.14, output: 0.28, cache_read: 0.003 }, limit: { context: 1000000 }, open_weights: true, reasoning: true },
        ...(models.xiaomi || {}),
      },
    },
    zhipu: {
      name: 'Zhipu',
      models: {
        'glm-5.3': { name: 'GLM-5.3', cost: { input: 0.6, output: 5, cache_read: 0.1 }, limit: { context: 200000 }, open_weights: true, reasoning: true },
        ...(models.zhipu || {}),
      },
    },
    meta: {
      name: 'Meta',
      models: {
        'muse-spark-1.2-contributor': { name: 'Muse Spark 1.2', cost: { input: 1, output: 4.25, cache_read: 0.1 }, limit: { context: 1048576 }, open_weights: false, reasoning: true },
        ...(models.meta || {}),
      },
    },
  };
}

// ---------- Artificial Analysis flight shapes ----------
export function aaModel(over = {}) {
  const shortName = over.shortName ?? 'Kimi K3';
  return {
    id: uuid(),
    slug: 'kimi-k3',
    shortName,
    name: over.name ?? shortName,
    creator: over.creator ?? { name: 'Moonshot AI', slug: 'moonshot', color: '#9C36B5' },
    intelligenceIndex: 59.7,
    effort: null,
    isOpenWeights: true,
    ...over,
  };
}
/** Wrap a record exactly like Next.js flight payloads do (doubly-encoded string). */
export function flightPush(record) {
  return 'self.__next_f.push([1,' + JSON.stringify(JSON.stringify(record)) + '])';
}
/** AA index page body: several pushes; content includes "intelligenceIndex" so the validator passes. */
export function aaIndexHtml(records, { extra = '' } = {}) {
  return records.map(flightPush).join('\n') + extra;
}
/** AA per-model page body: validator wants currentModel or intelligenceIndex. */
export function aaPageHtml(record) {
  return '<script>self.__next_f.push([0,{"currentModel":1}])</script>' + flightPush(record);
}

// ---------- Snapshot ----------
const baseModel = {
  label: undefined, author: 'Moonshot', hue: '#9C36B5', rank: 1,
  weeklyTokensT: 0.21, ocCostPerM: 15, ocCost: { input: 3, output: 15, cached: 0.3 },
  reasoning: true, openWeights: true, contextWindowTokens: 1048576,
};
function snapModel(over) {
  const m = {
    id: over.id,
    ...baseModel,
    label: over.label ?? over.id.replace(/[-_.]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    ...over,
  };
  if (m.ocCostPerM != null && !m.aaExempt) {
    m.aa = m.aa ?? { name: m.label, intelligenceIndex: 50, effort: null, url: 'https://artificialanalysis.ai/models/' + m.id.replace(/\./g, '-') };
  }
  delete m.aaExempt;
  if (m.plot === undefined) m.plot = m.ocCostPerM != null && !!m.aa;
  if (!m.plot && !m.excludeReason) m.excludeReason = 'No token cost published on OpenCode.';
  return m;
}

/** Two fully-covered plottable models — lets clean runs reach state 'live'. */
export function tinySnapshot() {
  return [
    snapModel({
      id: 'kimi-k3', label: 'Kimi K3', author: 'Moonshot', hue: '#9C36B5', rank: 17,
      weeklyTokensT: 0.21, ocCostPerM: 15, ocCost: { input: 3, output: 15, cached: 0.3 },
      reasoning: true, openWeights: true, contextWindowTokens: 1048576,
      aa: { name: 'Kimi K3 (max)', intelligenceIndex: 59.7, effort: 'max', url: 'https://artificialanalysis.ai/models/kimi-k3' },
      plot: true,
    }),
    snapModel({
      id: 'mimo-v2.5', label: 'MiMo-V2.5', author: 'Xiaomi', hue: '#D9480F', rank: 3,
      weeklyTokensT: 12.61, ocCostPerM: 0.28, ocCost: { input: 0.14, output: 0.28, cached: 0.003 },
      reasoning: true, openWeights: true, contextWindowTokens: 1000000,
      aa: { name: 'MiMo-V2.5', intelligenceIndex: 38.04, effort: null, url: 'https://artificialanalysis.ai/models/mimo-v2-5-0424' },
      plot: true,
    }),
  ];
}

/** Records covering tinySnapshot end-to-end through live data. */
export function tinyCoverage() {
  return {
    aaRecords: [
      aaModel({ slug: 'kimi-k3', shortName: 'Kimi K3', name: 'Kimi K3', intelligenceIndex: 59.7, effort: { label: 'max' }, isOpenWeights: true }),
      aaModel({ slug: 'mimo-v2-5-0424', shortName: 'MiMo-V2.5', name: 'MiMo-V2.5 0424', intelligenceIndex: 38.04, isOpenWeights: true }),
    ],
  };
}

/** Six-model render fixture:
 *   plotted  — kimi-k3 ($15, 59.7) · glm-5.3 ($5, 45.5) · mimo-v2.5 ($0.28, 38.04)
 *              · kimi-k2.7-code ($18, 50.02, DOMINATED by kimi-k3)
 *   frontier = { mimo-v2.5, glm-5.3, kimi-k3 }
 *   excluded — ox-alpha (no cost, no score) · muse-spark-1.2-contributor (score, no cost)
 */
export function snapshot() {
  return [
    snapModel({
      id: 'kimi-k3', label: 'Kimi K3', author: 'Moonshot', hue: '#9C36B5', rank: 17,
      weeklyTokensT: 0.21, ocCostPerM: 15, ocCost: { input: 3, output: 15, cached: 0.3 },
      aa: { name: 'Kimi K3 (max)', intelligenceIndex: 59.7, effort: 'max', url: 'https://artificialanalysis.ai/models/kimi-k3' },
      plot: true,
    }),
    snapModel({
      id: 'mimo-v2.5', label: 'MiMo-V2.5', author: 'Xiaomi', hue: '#D9480F', rank: 3,
      weeklyTokensT: 12.61, ocCostPerM: 0.28, ocCost: { input: 0.14, output: 0.28, cached: 0.003 },
      reasoning: true, openWeights: true, contextWindowTokens: 1000000,
      aa: { name: 'MiMo-V2.5', intelligenceIndex: 38.04, effort: null, url: 'https://artificialanalysis.ai/models/mimo-v2-5-0424' },
      plot: true,
    }),
    snapModel({
      id: 'ox-alpha', label: 'Ox-Alpha', author: 'Unknown', hue: '#8B94A3', rank: 2,
      weeklyTokensT: 17.68, ocCostPerM: null, ocCost: null, reasoning: null, openWeights: null,
      contextWindowTokens: null, plot: false,
      excludeReason: 'No token cost published on OpenCode; not scored by Artificial Analysis.',
    }),
    snapModel({
      id: 'muse-spark-1.2-contributor', label: 'Muse Spark 1.2 (contrib)', author: 'Meta', hue: '#1971C2', rank: 4,
      weeklyTokensT: 5.6, ocCostPerM: null, ocCost: null, reasoning: true, openWeights: false,
      contextWindowTokens: 1048576, plot: false, excludeReason: 'No token cost published on OpenCode.',
      aa: { name: 'Muse Spark 1.2 (xhigh)', intelligenceIndex: 56.76, effort: 'xhigh', url: 'https://artificialanalysis.ai/models/muse-spark-1-2' },
      aaExempt: true,
    }),
    snapModel({
      id: 'glm-5.3', label: 'GLM-5.3', author: 'Zhipu', hue: '#0CA678', rank: 9,
      weeklyTokensT: 2.4, ocCostPerM: 5, ocCost: { input: 0.6, output: 5, cached: 0.1 },
      reasoning: true, openWeights: true, contextWindowTokens: 200000,
      aa: { name: 'GLM-5.3', intelligenceIndex: 45.5, effort: null, url: 'https://artificialanalysis.ai/models/glm-5-3' },
      plot: true,
    }),
    snapModel({
      id: 'kimi-k2.7-code', label: 'Kimi K2.7 Code', author: 'Moonshot', hue: '#C2255C', rank: 11,
      weeklyTokensT: 1.1, ocCostPerM: 18, ocCost: { input: 2, output: 18, cached: 0.4 },
      reasoning: true, openWeights: true, contextWindowTokens: 256000,
      aa: { name: 'Kimi K2.7 Code', intelligenceIndex: 50.02, effort: null, url: 'https://artificialanalysis.ai/models/kimi-k2-7-code' },
      plot: true,
    }),
  ];
}

