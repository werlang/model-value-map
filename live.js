/* Live data layer — direct, dependency-free API integration.
 *
 * Sources:
 *   • models.dev/api.json          → Official OpenCode catalog with model pricing, context limits, and flags (CORS: *).
 *   • artificialanalysis.ai/models → Official Artificial Analysis Intelligence Index v4.1.1 (CORS: *).
 *
 * Robustness & Safety:
 *   • Direct CORS requests (zero public proxies, zero relays, zero workers).
 *   • AA flight payloads are parsed as inert text (regex + brace matching) — never executed.
 *   • Graceful degradation: cached payloads in localStorage (30-min TTL), unTTL'd lastgood fallback on outages.
 */
window.LiveData = (function () {
  'use strict';

  const CACHE_KEY = 'mvm.live.v1';
  const CACHE_LASTGOOD = 'mvm.live.lastgood';
  const TTL_MS = 30 * 60 * 1000;

  // OpenCode / models.dev id → Artificial Analysis slug
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

  function normSlug(id) {
    return (id || '').toLowerCase().replace(/[\/._]/g, '-');
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

  // ---------- AA flight parsing (inert text — never executed) ----------
  function extractFlight(html) {
    if (!html || typeof html !== 'string') return '';
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

  const AGGREGATOR_KEYS = [
    'nanogpt', 'nano-gpt', 'openrouter', 'deepinfra', 'groq', 'together', 'togetherai',
    'fireworks', 'fireworks-ai', 'novita', 'hyperbolic', 'replicate', 'anyscale',
    'scaleway', 'parasail', 'klusterai', 'router', '302ai', 'requesty', 'mixlayer',
    'neuralwatt', 'edenai', 'nebius', 'chutes', 'cerebras', 'sambanova', 'glhf',
    'huggingface', 'featherless', 'friendliai', 'lepton', 'siliconflow', 'plan', 'coding'
  ];

  function labFor(id, name, family, providerKey, providerName) {
    const modelStr = `${id || ''} ${name || ''} ${family || ''}`.toLowerCase();

    // 1. Explicit model name / family / id match (highest precedence)
    if (/\b(glm|chatglm|codegeex|cogvideo|zhipu)\b/i.test(modelStr) || modelStr.startsWith('glm-') || modelStr.includes('glm-') || modelStr.includes('zhipu')) return 'Zhipu AI';
    if (/\b(deepseek|deepseek-ai|deepseek-v|deepseek-r|deepseek-coder)\b/i.test(modelStr) || modelStr.includes('deepseek')) return 'DeepSeek';
    if (/\b(claude|anthropic)\b/i.test(modelStr) || modelStr.includes('claude')) return 'Anthropic';
    if (/\b(gpt|o1|o3|o4|chatgpt|openai|dall-e|sora|whisper|text-embedding)\b/i.test(modelStr) || modelStr.startsWith('gpt-') || modelStr.startsWith('openai/')) return 'OpenAI';
    if (/\b(gemini|gemma|palm|google)\b/i.test(modelStr) || modelStr.includes('gemini') || modelStr.includes('gemma')) return 'Google';
    if (/\b(kimi|moonshot|moonshotai)\b/i.test(modelStr) || modelStr.includes('kimi') || modelStr.includes('moonshot')) return 'Moonshot AI';
    if (/\b(qwen|alibaba|tongyi|wanx)\b/i.test(modelStr) || modelStr.includes('qwen')) return 'Alibaba';
    if (/\b(mimo|xiaomi)\b/i.test(modelStr) || modelStr.includes('mimo') || modelStr.includes('xiaomi')) return 'Xiaomi';
    if (/\b(minimax|abab|minimaxai)\b/i.test(modelStr) || modelStr.includes('minimax')) return 'MiniMax';
    if (/\b(grok|xai)\b/i.test(modelStr) || modelStr.includes('grok')) return 'xAI';
    if (/\b(nemotron|nvidia|cosmos)\b/i.test(modelStr) || modelStr.includes('nemotron')) return 'Nvidia';
    if (/\b(mistral|mixtral|codestral|ministral|pixtral|devstral)\b/i.test(modelStr) || modelStr.includes('mistral')) return 'Mistral';
    if (/\b(llama|meta|muse)\b/i.test(modelStr) || modelStr.includes('llama') || modelStr.includes('muse')) return 'Meta';
    if (/\b(hunyuan|tencent|hy3)\b/i.test(modelStr) || modelStr.includes('hunyuan')) return 'Tencent';
    if (/\b(cohere|command-r|command-a|command-plus|aya)\b/i.test(modelStr) || modelStr.includes('command-')) return 'Cohere';
    if (/\b(stepfun|step-)\b/i.test(modelStr)) return 'StepFun';
    if (/\b(solar|upstage)\b/i.test(modelStr)) return 'Upstage';
    if (/\b(jamba|ai21)\b/i.test(modelStr)) return 'AI21 Labs';
    if (/\b(doubao|bytedance|skylark)\b/i.test(modelStr) || modelStr.includes('doubao')) return 'ByteDance';
    if (/\b(ernie|baidu)\b/i.test(modelStr) || modelStr.includes('ernie')) return 'Baidu';
    if (/\b(amazon|nova|titan|bedrock)\b/i.test(modelStr) || modelStr.startsWith('nova-')) return 'Amazon';
    if (/\b(phi|phi-3|phi-4|wizardlm|microsoft)\b/i.test(modelStr)) return 'Microsoft';
    if (/\b(dbrx|databricks)\b/i.test(modelStr)) return 'Databricks';
    if (/\b(internlm|shanghai)\b/i.test(modelStr)) return 'Shanghai AI Lab';
    if (/\b(yi-|yi_01|01-ai|01.ai)\b/i.test(modelStr)) return '01.AI';
    if (/\b(perplexity|sonar)\b/i.test(modelStr)) return 'Perplexity';

    // Check organization prefix in "org/model"
    if (id && id.includes('/')) {
      const org = id.split('/')[0].toLowerCase();
      if (org === 'meta-llama' || org === 'meta') return 'Meta';
      if (org === 'google') return 'Google';
      if (org === 'anthropic') return 'Anthropic';
      if (org === 'openai') return 'OpenAI';
      if (org === 'deepseek-ai' || org === 'deepseek') return 'DeepSeek';
      if (org === 'zhipuai' || org === 'zai-org' || org === 'thudm' || org === 'zhipu') return 'Zhipu AI';
      if (org === 'qwen' || org === 'alibaba') return 'Alibaba';
      if (org === 'mistralai' || org === 'mistral') return 'Mistral';
      if (org === 'nvidia') return 'Nvidia';
      if (org === 'cohere') return 'Cohere';
      if (org === 'moonshotai' || org === 'moonshot') return 'Moonshot AI';
      if (org === 'minimax') return 'MiniMax';
      if (org === 'bytedance') return 'ByteDance';
      if (org === 'microsoft') return 'Microsoft';
    }

    // 2. First-party provider matches (skip aggregators/routers)
    const provStr = `${providerKey || ''} ${providerName || ''}`.toLowerCase();
    const isAggregator = AGGREGATOR_KEYS.some((k) => provStr.includes(k));

    if (!isAggregator) {
      if (provStr.includes('openai')) return 'OpenAI';
      if (provStr.includes('anthropic')) return 'Anthropic';
      if (provStr.includes('google')) return 'Google';
      if (provStr.includes('deepseek')) return 'DeepSeek';
      if (provStr.includes('moonshot')) return 'Moonshot AI';
      if (provStr.includes('zhipu') || provStr.includes('zai')) return 'Zhipu AI';
      if (provStr.includes('alibaba') || provStr.includes('qwen')) return 'Alibaba';
      if (provStr.includes('xiaomi') || provStr.includes('mimo')) return 'Xiaomi';
      if (provStr.includes('minimax')) return 'MiniMax';
      if (provStr.includes('xai')) return 'xAI';
      if (provStr.includes('nvidia')) return 'Nvidia';
      if (provStr.includes('mistral')) return 'Mistral';
      if (provStr.includes('meta')) return 'Meta';
      if (provStr.includes('tencent')) return 'Tencent';
      if (provStr.includes('cohere')) return 'Cohere';
      if (provStr.includes('stepfun')) return 'StepFun';
      if (provStr.includes('upstage')) return 'Upstage';
      if (provStr.includes('ai21')) return 'AI21 Labs';
      if (provStr.includes('bytedance')) return 'ByteDance';
      if (provStr.includes('baidu')) return 'Baidu';
      if (provStr.includes('microsoft')) return 'Microsoft';
      if (provStr.includes('amazon')) return 'Amazon';
      if (providerName && providerName !== 'Default' && !providerName.toLowerCase().includes('plan')) {
        return providerName;
      }
    }

    return 'AI Lab';
  }

  function scanAaModels(flight) {
    const out = new Map();
    if (!flight || typeof flight !== 'string') return out;
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
            url: 'https://artificialanalysis.ai/models/' + o.slug,
          });
        }
      } catch (_) {}
    }

    const detailMatches = [...flight.matchAll(/\{"label":"([^"]+)","(?:artificialAnalysisIntelligenceIndex|intelligenceIndex)":([0-9.]+),"detailsUrl":"\/models\/([^"]+)"\}/g)];
    for (const match of detailMatches) {
      const slug = match[3];
      if (!out.has(slug)) {
        const rawLabel = match[1];
        const effortMatch = rawLabel.match(/\(([^)]+)\)/);
        const effort = effortMatch ? effortMatch[1] : null;
        const shortName = rawLabel.replace(/\s*\([^)]*\)/, '').trim();
        const score = parseFloat(match[2]);
        if (typeof score === 'number' && !isNaN(score) && score >= 0) {
          out.set(slug, {
            slug: slug,
            shortName: shortName,
            name: rawLabel,
            intelligenceIndex: Math.round(score * 100) / 100,
            effort: effort,
            isOpenWeights: false,
            url: 'https://artificialanalysis.ai/models/' + slug,
          });
        }
      }
    }

    return out;
  }

  // ---------- models.dev catalog parsing ----------
  function parseModelsDev(data) {
    const map = new Map();
    if (!data || typeof data !== 'object') return map;
    const firstParty = [
      'openai', 'anthropic', 'google', 'deepseek', 'meta', 'mistral', 'cohere',
      'moonshot', 'moonshotai', 'zhipu', 'zhipuai', 'nvidia', 'xiaomi', 'alibaba',
      'minimax', 'tencent', 'xai', 'stepfun', 'upstage'
    ];
    const provKeys = Object.keys(data).sort((a, b) => {
      const aPlan = a.includes('plan') || a.includes('coding');
      const bPlan = b.includes('plan') || b.includes('coding');
      if (aPlan !== bPlan) return aPlan ? 1 : -1;
      const aP = firstParty.some((k) => a.includes(k)) ? 0 : 1;
      const bP = firstParty.some((k) => b.includes(k)) ? 0 : 1;
      return aP - bP;
    });

    for (const providerKey of provKeys) {
      const providerObj = data[providerKey];
      if (!providerObj || typeof providerObj !== 'object') continue;
      const provName = providerObj.name || providerKey;
      const models = providerObj.models;
      if (!models || typeof models !== 'object') continue;

      for (const mKey of Object.keys(models)) {
        const m = models[mKey];
        if (!m || typeof m !== 'object') continue;
        const cost = m.cost;
        if (!cost || typeof cost !== 'object') continue;
        const outCost = typeof cost.output === 'number' && Number.isFinite(cost.output) ? cost.output : null;
        if (outCost == null || outCost < 0) continue;

        const inCost = typeof cost.input === 'number' && Number.isFinite(cost.input) ? cost.input : null;
        const cacheRead = typeof cost.cache_read === 'number' && Number.isFinite(cost.cache_read) ? cost.cache_read
          : (typeof cost.cacheRead === 'number' && Number.isFinite(cost.cacheRead) ? cost.cacheRead : null);
        const cacheWrite = typeof cost.cache_write === 'number' && Number.isFinite(cost.cache_write) ? cost.cache_write
          : (typeof cost.cacheWrite === 'number' && Number.isFinite(cost.cacheWrite) ? cost.cacheWrite : null);
        const limitContext = m.limit && typeof m.limit.context === 'number' && Number.isFinite(m.limit.context) ? m.limit.context : null;
        const limitOutput = m.limit && typeof m.limit.output === 'number' && Number.isFinite(m.limit.output) ? m.limit.output : null;
        const author = labFor(m.id || mKey, m.name, m.family, providerKey, provName);
        const info = {
          id: m.id || mKey,
          name: m.name || mKey,
          author,
          cost: {
            input: inCost,
            output: outCost,
            cacheRead: cacheRead,
            cacheWrite: cacheWrite,
          },
          limit: { context: limitContext, output: limitOutput },
          openWeights: m.open_weights != null ? !!m.open_weights : (m.openWeights != null ? !!m.openWeights : null),
          reasoning: !!m.reasoning,
        };

        const keysToSet = [m.id, mKey, normSlug(m.id || ''), normSlug(mKey)].filter(Boolean);
        if (m.id && m.id.includes('/')) keysToSet.push(m.id.split('/').pop(), normSlug(m.id.split('/').pop()));
        if (mKey.includes('/')) keysToSet.push(mKey.split('/').pop(), normSlug(mKey.split('/').pop()));

        for (const k of keysToSet) {
          const existing = map.get(k);
          if (!existing || (existing.cost.output <= 0 && outCost > 0)) {
            map.set(k, info);
          }
        }
      }
    }
    return map;
  }

  // ---------- direct fetching ----------
  async function fetchModelsDev() {
    try {
      const res = await fetch('https://models.dev/api.json', {
        headers: { 'Accept': 'application/json' },
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
      if (!res.ok) return new Map();
      const data = await res.json();
      return parseModelsDev(data);
    } catch (_) {
      return new Map();
    }
  }

  async function fetchAaIndex() {
    try {
      const res = await fetch('https://artificialanalysis.ai/models', {
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
      if (!res.ok) return new Map();
      const html = await res.text();
      return scanAaModels(extractFlight(html));
    } catch (_) {
      return new Map();
    }
  }

  async function fetchAaModelPage(slug) {
    try {
      const res = await fetch('https://artificialanalysis.ai/models/' + encodeURIComponent(slug), {
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
      if (!res.ok) return null;
      const html = await res.text();
      const map = scanAaModels(extractFlight(html));
      return map.get(slug) || null;
    } catch (_) {
      return null;
    }
  }

  // ---------- localStorage cache ----------
  function readCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const entry = JSON.parse(raw);
      if (!entry || typeof entry !== 'object' || typeof entry.t !== 'number' || !Array.isArray(entry.models)) return null;
      return entry;
    } catch (_) { return null; }
  }

  function readLastGood() {
    try {
      const raw = localStorage.getItem(CACHE_LASTGOOD);
      if (!raw) return null;
      const entry = JSON.parse(raw);
      if (!entry || typeof entry !== 'object' || typeof entry.t !== 'number' || !Array.isArray(entry.models)) return null;
      return entry;
    } catch (_) { return null; }
  }

  function writeCache(models, t) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ t: t || Date.now(), models }));
    } catch (_) {}
  }

  function writeLastGood(models, t) {
    try {
      localStorage.setItem(CACHE_LASTGOOD, JSON.stringify({ t: t || Date.now(), models }));
    } catch (_) {}
  }

  // ---------- join models ----------
  function buildModels(mdMap, aaMap, aaPages, snapById) {
    const out = [];
    const seen = new Set();

    // 1. Process all models in AA index
    for (const [slug, aa] of aaMap) {
      seen.add(slug);
      seen.add(normSlug(slug));
      const lookupKey = AA_SLUG[slug] || normSlug(slug);
      const md = mdMap.get(lookupKey) || mdMap.get(slug) || mdMap.get(normSlug(slug)) || null;
      const snap = snapById ? snapById.get(slug) || snapById.get(lookupKey) : null;

      const cost = md && md.cost ? md.cost.output : (snap && snap.ocCostPerM != null ? snap.ocCostPerM : null);
      const author = (md && md.author) || (snap && snap.author) || 'AI Lab';
      const label = aa.shortName || (md && md.name) || (snap && snap.label) || slug;
      const contextWindowTokens = (md && md.limit && md.limit.context) || (snap && snap.contextWindowTokens) || null;
      const reasoning = md ? md.reasoning : (snap ? !!snap.reasoning : false);
      const openWeights = md && md.openWeights != null ? md.openWeights : (aa ? aa.isOpenWeights : (snap ? !!snap.openWeights : false));
      const plot = typeof cost === 'number' && cost > 0 && typeof aa.intelligenceIndex === 'number' && aa.intelligenceIndex > 0;
      const excludeReason = !plot ? (cost == null ? 'Missing pricing' : 'Missing intelligence score') : null;

      out.push({
        id: slug,
        label,
        author,
        ocCostPerM: cost,
        ocCost: md ? md.cost : (snap ? snap.ocCost : { input: null, output: cost, cached: null }),
        intelligenceIndex: aa.intelligenceIndex,
        aa: {
          slug,
          name: aa.name,
          intelligenceIndex: aa.intelligenceIndex,
          effort: aa.effort,
          isOpenWeights: aa.isOpenWeights,
          url: aa.url || ('https://artificialanalysis.ai/models/' + slug),
        },
        contextWindowTokens,
        reasoning,
        openWeights,
        plot,
        excludeReason,
        hue: hueFor(author, snapById, slug),
      });
    }

    // 2. Add any curated snapshot models missing from AA index
    if (snapById) {
      for (const [id, snap] of snapById) {
        if (seen.has(id) || seen.has(normSlug(id))) continue;
        seen.add(id);
        const lookupKey = AA_SLUG[id] || normSlug(id);
        const md = mdMap.get(lookupKey) || mdMap.get(id) || mdMap.get(normSlug(id)) || null;
        const aa = (aaPages && aaPages[id]) || aaMap.get(lookupKey) || aaMap.get(id) || (snap ? snap.aa : null);

        const cost = md && md.cost ? md.cost.output : (snap && snap.ocCostPerM != null ? snap.ocCostPerM : null);
        const author = (md && md.author) || (snap && snap.author) || 'AI Lab';
        const label = (aa && aa.shortName) || (md && md.name) || (snap && snap.label) || id;
        const score = aa && typeof aa.intelligenceIndex === 'number' ? aa.intelligenceIndex : null;
        const plot = typeof cost === 'number' && cost > 0 && typeof score === 'number' && score > 0;
        const excludeReason = !plot ? (cost == null ? 'Missing pricing' : 'Missing intelligence score') : null;

        out.push({
          id,
          label,
          author,
          ocCostPerM: cost,
          ocCost: md ? md.cost : (snap ? snap.ocCost : { input: null, output: cost, cached: null }),
          intelligenceIndex: score,
          aa: aa ? {
            slug: aa.slug || id,
            name: aa.name || label,
            intelligenceIndex: score,
            effort: aa.effort || null,
            isOpenWeights: !!aa.isOpenWeights,
            url: aa.url || ('https://artificialanalysis.ai/models/' + (aa.slug || id)),
          } : null,
          contextWindowTokens: (md && md.limit && md.limit.context) || (snap && snap.contextWindowTokens) || null,
          reasoning: md ? md.reasoning : (snap ? !!snap.reasoning : false),
          openWeights: md && md.openWeights != null ? md.openWeights : (aa ? !!aa.isOpenWeights : (snap ? !!snap.openWeights : false)),
          plot,
          excludeReason,
          hue: hueFor(author, snapById, id),
        });
      }
    }

    return out;
  }

  // ---------- live fetch pipeline ----------
  async function fetchFresh(snapById) {
    const [modelsDev, aaIndex] = await Promise.all([
      fetchModelsDev(),
      fetchAaIndex(),
    ]);

    if (modelsDev.size === 0 && aaIndex.size === 0) {
      const lastGood = readLastGood();
      if (lastGood) {
        return {
          state: 'stale',
          models: lastGood.models,
          fetchedAt: lastGood.t,
          ocUpdatedAt: new Date(lastGood.t).toISOString(),
        };
      }
      return null;
    }

    // Optional per-model fetch for any curated snapshot models missing from AA index
    const aaPages = {};
    if (snapById) {
      const needed = [];
      for (const [id] of snapById) {
        const slug = AA_SLUG[id] || normSlug(id);
        if (!aaIndex.has(slug) && !aaIndex.has(id)) needed.push({ id, slug });
      }
      if (needed.length > 0) {
        await Promise.all(needed.map(async ({ id, slug }) => {
          const rec = await fetchAaModelPage(slug);
          if (rec) aaPages[id] = rec;
        }));
      }
    }

    const models = buildModels(modelsDev, aaIndex, aaPages, snapById);
    const now = Date.now();
    writeCache(models, now);
    writeLastGood(models, now);

    return {
      state: 'live',
      models,
      fetchedAt: now,
      ocUpdatedAt: new Date(now).toISOString(),
    };
  }

  // Entry point.
  async function load(snapshotOrOpts, maybeOpts) {
    const hasSnapshot = Array.isArray(snapshotOrOpts);
    const snapshotModels = hasSnapshot ? snapshotOrOpts : [];
    const opts = hasSnapshot ? (maybeOpts || {}) : (snapshotOrOpts || {});
    const force = !!opts.force;
    const snapById = snapshotModels.length > 0 ? new Map(snapshotModels.map((m) => [m.id, m])) : null;
    const report = typeof opts.onUpdate === 'function' ? opts.onUpdate : null;

    // 1. Fetch from localStorage cache
    if (!force) {
      const cached = readCache();
      if (cached && Date.now() - cached.t < TTL_MS) {
        return {
          state: 'cached',
          models: cached.models,
          fetchedAt: cached.t,
          ocUpdatedAt: new Date(cached.t).toISOString(),
        };
      }

      // Past TTL: paint aged payload immediately as stale, refresh in background
      const bg = cached || readLastGood();
      if (bg) {
        const staleResult = {
          state: 'stale',
          models: bg.models,
          fetchedAt: bg.t,
          ocUpdatedAt: new Date(bg.t).toISOString(),
          refreshing: true,
        };
        fetchFresh(snapById).then((fresh) => {
          if (report) report(fresh || { ...staleResult, refreshing: false });
        }).catch(() => { if (report) report({ ...staleResult, refreshing: false }); });
        return staleResult;
      }
    }

    // 2. Fetch fresh from origins
    return fetchFresh(snapById);
  }

  return { load };
})();
