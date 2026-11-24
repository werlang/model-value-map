/**
 * /subsidy behavioral suite.
 *
 * Pure helpers are exercised through window.MVM_SUBSIDY_TEST; the page itself
 * is booted inside the same vm sandbox as the existing app tests (minidom +
 * recorded fetch router), so mode switching, counts and offline fallbacks run
 * against the real subsidy.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSandbox, DEFAULT_CLOCK_START } from './helpers/sandbox.js';
import { makeDocument } from './helpers/minidom.js';
import { makeStorage } from './helpers/storage.js';
import { makeFetch } from './helpers/fake-fetch.js';
import { __TEST__ as WORKER } from '../worker/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUBSIDY_SRC = fs.readFileSync(path.join(ROOT, 'subsidy.js'), 'utf8');
const MIN = 60 * 1000;
const WORKER_RE = /^https:\/\/model-value-map-api\.pswerlang\.workers\.dev\/$/;

const PAGE_SKELETON = `
  <p id="stamp" class="updated-stamp">
    <span class="stamp-dot"></span>
    <span id="stamp-text">Loading</span>
    <button type="button" id="stamp-refresh" class="stamp-refresh"></button>
  </p>
  <div class="quick-actions" role="group" aria-label="X axis mode">
    <button type="button" class="action active" data-mode="subsidized" aria-pressed="true">Subsidized</button>
    <button type="button" class="action" data-mode="cost_per_task" aria-pressed="false">Cost / task</button>
    <button type="button" class="action" data-mode="api_cost" aria-pressed="false">API cost</button>
  </div>
  <div class="quick-actions">
    <button type="button" class="action" data-action="all">All</button>
    <button type="button" class="action" data-action="none">None</button>
    <button type="button" class="action" data-action="frontier">Frontier only</button>
  </div>
  <button type="button" class="action" id="scale-toggle" aria-pressed="false">X: Log</button>
  <div class="summary-counters" id="summary-counters" aria-label="Subsidy coverage counters"></div>
  <div class="lab-legend" id="lab-legend" role="group" aria-label="Lab visibility"></div>
  <div class="chart-holder" id="chart-holder">
    <div class="chart-loading" id="chart-loading" aria-hidden="true">
      <span class="chart-loading-text">Fetching…</span>
    </div>
    <div id="chart-tooltip" class="chart-tooltip" role="tooltip" hidden></div>
  </div>
  <p class="axis-note">X is log-scaled</p>
  <div id="readout"></div>
  <section class="panel excluded-panel">
    <p class="panel-sub" id="excluded-count">0 modelos sem score AA</p>
    <ul class="excluded-list" id="excluded-list"></ul>
  </section>
  <section class="panel excluded-panel subsidy-missing-panel">
    <p class="panel-sub" id="no-plan-count">0</p>
    <ul class="excluded-list" id="no-plan-list"></ul>
  </section>
  <section class="panel toggles-panel">
    <p class="panel-sub" id="visible-count"></p>
    <div class="toggles-switcher">
      <button type="button" class="sort-btn active" data-provider="all" aria-pressed="true">All</button>
      <button type="button" class="sort-btn" data-provider="anthropic" aria-pressed="false">Anthropic</button>
      <button type="button" class="sort-btn" data-provider="openai" aria-pressed="false">OpenAI</button>
      <button type="button" class="sort-btn" data-provider="google" aria-pressed="false">Google</button>
      <button type="button" class="sort-btn" data-provider="xai" aria-pressed="false">xAI</button>
      <button type="button" class="sort-btn" data-provider="opencode-go" aria-pressed="false">OpenCode Go</button>
    </div>
    <div id="toggles"></div>
  </section>
`;

const MODELS_DEV = {
  anthropic: {
    name: 'Anthropic',
    models: {
      'claude-opus-5-5': {
        id: 'claude-opus-5-5',
        name: 'Claude Opus 5.5',
        cost: { input: 4, output: 20, tiers: [{ input: 1, output: 1 }], context_over_200k: { input: 8, output: 40 } },
      },
      'claude-opus-5': { id: 'claude-opus-5', name: 'Claude Opus 5', cost: { input: 5, output: 25 } },
    },
  },
  openai: {
    name: 'OpenAI',
    models: {
      'gpt-6.2-sol': {
        id: 'gpt-6.2-sol',
        name: 'GPT-6.2 Sol',
        cost: { input: 2, output: 10, tiers: [{ input: 9, output: 90 }], context_over_200k: { input: 4, output: 20 } },
      },
      'gpt-6-luna': { id: 'gpt-6-luna', name: 'GPT-6 Luna', cost: { input: 0.1, output: 0.5 } },
    },
  },
  google: {
    name: 'Google',
    models: {
      'gemini-4-neon': { id: 'gemini-4-neon', name: 'Gemini 4 Neon', cost: { input: 3, output: 15 } },
    },
  },
  xai: {
    name: 'xAI',
    models: {
      'grok-4.7': { id: 'grok-4.7', name: 'Grok 4.7', cost: { input: 2, output: 6 } },
    },
  },
  'opencode-go': {
    name: 'OpenCode Go',
    models: {
      'glm-5.3': { id: 'glm-5.3', name: 'GLM-5.3', cost: { input: 1.4, output: 4.4 } },
      'deepseek-v4.1-flash': { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', cost: { input: 0.15, output: 0.6 } },
      'claude-haiku-5-5': { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', cost: { input: 0.1, output: 0.5 } },
    },
  },
  zai: {
    name: 'Z AI',
    models: {
      'glm-5.3': { id: 'glm-5.3', name: 'GLM-5.3 (Z.ai)', cost: { input: 1.4, output: 4.4 } },
    },
  },
};

const SNAPSHOT = {
  source: 'https://artificialanalysis.ai/models',
  collected_at: '2026-11-23',
  models: [
    { slug: 'claude-opus-5-5', name: 'Claude Opus 5.5', creator: 'Anthropic', intelligenceIndex: 59.106, costPerTask: 10.0364, url: 'https://artificialanalysis.ai/models/claude-opus-5-5' },
    { slug: 'gpt-6-2-sol', name: 'GPT-6.2 Sol', creator: 'OpenAI', intelligenceIndex: 57.2576, costPerTask: 1.01438, url: 'https://artificialanalysis.ai/models/gpt-6-2-sol' },
    { slug: 'gemini-4-neon', name: 'Gemini 4 Neon', creator: 'Google', intelligenceIndex: 61.3982, costPerTask: 6.44484, url: 'https://artificialanalysis.ai/models/gemini-4-neon' },
    { slug: 'grok-4-7', name: 'Grok 4.7', creator: 'xAI', intelligenceIndex: 35.485, costPerTask: 7.77154, url: 'https://artificialanalysis.ai/models/grok-4-7' },
    { slug: 'glm-5-3', name: 'GLM-5.3', creator: 'Z AI', intelligenceIndex: 31.6534, costPerTask: 5.00926, url: 'https://artificialanalysis.ai/models/glm-5-3' },
    { slug: 'deepseek-v4-1-flash-1017', name: 'DeepSeek V4.1 Flash 1017', creator: 'DeepSeek', intelligenceIndex: 32.5896, costPerTask: 0.602105, url: 'https://artificialanalysis.ai/models/deepseek-v4-1-flash-1017' },
    { slug: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', creator: 'Anthropic', intelligenceIndex: 36.4845, costPerTask: 0.411007, url: 'https://artificialanalysis.ai/models/claude-haiku-5-5' },
    { slug: 'gpt-6-luna', name: 'GPT-6 Luna', creator: 'OpenAI', intelligenceIndex: 27.8552, costPerTask: null, url: 'https://artificialanalysis.ai/models/gpt-6-luna' },
  ],
  modelsDev: MODELS_DEV,
};

const LAB_PLANS = {
  anthropic: {
    providerName: 'Anthropic',
    source: 'reference chart, 2026-11-23',
    collected_at: '2026-11-23',
    plans: [{ plan: 'Pro', price: 20, multiple: 64 }, { plan: 'Max 5x', price: 100, multiple: 77 }, { plan: 'Ultra', price: 200, multiple: 66 }],
  },
  openai: {
    providerName: 'OpenAI',
    source: 'reference chart, 2026-11-23',
    collected_at: '2026-11-23',
    plans: [{ plan: 'Plus', price: 20, multiple: 15 }, { plan: 'Pro 10x', price: 100, multiple: 30 }, { plan: 'Pro 20x', price: 200, multiple: 30 }, { plan: 'Pro 500', price: 500, multiple: 30 }],
  },
  google: {
    providerName: 'Google',
    source: 'reference chart, 2026-11-23',
    collected_at: '2026-11-23',
    plans: [{ plan: 'Pro', price: 20, multiple: 21 }, { plan: 'Ultra 5x', price: 100, multiple: 24 }, { plan: 'Ultra 20x', price: 200, multiple: 48 }],
  },
  xai: {
    providerName: 'xAI',
    source: 'reference chart, 2026-11-23',
    collected_at: '2026-11-23',
    plans: [{ plan: 'SuperGrok', price: 30, multiple: 11 }, { plan: 'Plus', price: 100, multiple: 13 }, { plan: 'Heavy', price: 300, multiple: 11 }],
  },
};

const PLANS = {
  source: 'reference chart, 2026-11-23 (lab plans); https://opencode.ai/docs/go (OpenCode Go entries)',
  collected_at: '2026-11-23',
  lab_plans: LAB_PLANS,
  entries: [
    { provider: 'anthropic', providerName: 'Anthropic', model: 'claude-opus-5-5', modelName: 'Opus 5.5', source: 'reference chart, 2026-11-23', collected_at: '2026-11-23', plans: [{ name: 'Pro', price: 20, multiple: 64 }, { name: 'Max 5x', price: 100, multiple: 77 }, { name: 'Ultra', price: 200, multiple: 66 }] },
    { provider: 'openai', providerName: 'OpenAI', model: 'gpt-6.2-sol', modelName: 'GPT-6.2 Sol', source: 'reference chart, 2026-11-23', collected_at: '2026-11-23', plans: [{ name: 'Plus', price: 20, multiple: 15 }, { name: 'Pro 10x', price: 100, multiple: 30 }, { name: 'Pro 20x', price: 200, multiple: 30 }, { name: 'Pro 500', price: 500, multiple: 30 }] },
    { provider: 'google', providerName: 'Google', model: 'gemini-4-neon', modelName: 'Gemini 4 Neon', source: 'reference chart, 2026-11-23', collected_at: '2026-11-23', plans: [{ name: 'Pro', price: 20, multiple: 21 }, { name: 'Ultra 5x', price: 100, multiple: 24 }, { name: 'Ultra 20x', price: 200, multiple: 48 }] },
    { provider: 'xai', providerName: 'xAI', model: 'grok-4.7', modelName: 'Grok 4.7', source: 'reference chart, 2026-11-23', collected_at: '2026-11-23', plans: [{ name: 'SuperGrok', price: 30, multiple: 11 }, { name: 'Plus', price: 100, multiple: 13 }, { name: 'Heavy', price: 300, multiple: 11 }] },
    { provider: 'opencode-go', providerName: 'OpenCode Go', model: 'glm-5.3', modelName: 'GLM 5.3', source: 'https://opencode.ai/docs/go', collected_at: '2026-11-23', plans: [{ name: 'Go', price: 10, multiple: 50 }, { name: 'Go Plus', price: 40, multiple: 25 }] },
    { provider: 'opencode-go', providerName: 'OpenCode Go', model: 'deepseek-v4.1-flash', modelName: 'DeepSeek V4.1 Flash', source: 'https://opencode.ai/docs/go', collected_at: '2026-11-23', plans: [{ name: 'Go', price: 10, multiple: 10 }, { name: 'Go Plus', price: 40, multiple: 5 }] },
  ],
};

const INHERIT_MODELS_DEV = {
  anthropic: {
    name: 'Anthropic',
    models: { 'claude-sonnet-5-5': { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', cost: { input: 3, output: 15 } } },
  },
  openai: {
    name: 'OpenAI',
    models: { 'gpt-7-mini': { id: 'gpt-7-mini', name: 'GPT-7 Mini', cost: { input: 1, output: 4 } } },
  },
  google: {
    name: 'Google',
    models: { 'gemini-5-pro': { id: 'gemini-5-pro', name: 'Gemini 5 Pro', cost: { input: 2, output: 9 } } },
  },
  xai: {
    name: 'xAI',
    models: { 'grok-5': { id: 'grok-5', name: 'Grok 5', cost: { input: 2, output: 7 } } },
  },
};

const INHERIT_SNAPSHOT = {
  source: 'https://artificialanalysis.ai/models',
  collected_at: '2026-11-23',
  models: [
    { slug: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', intelligenceIndex: 55, costPerTask: 2 },
    { slug: 'gpt-7-mini', name: 'GPT-7 Mini', intelligenceIndex: 50, costPerTask: 0.5 },
    { slug: 'gemini-5-pro', name: 'Gemini 5 Pro', intelligenceIndex: 58, costPerTask: 3 },
    { slug: 'grok-5', name: 'Grok 5', intelligenceIndex: 45, costPerTask: 4 },
  ],
};

function workerModels(over) {
  const base = [
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', aa: { slug: 'claude-opus-5-5', intelligenceIndex: 59.106, costPerTask: 10.0364 } },
    { id: 'gpt-6.2-sol', label: 'GPT-6.2 Sol', aa: { slug: 'gpt-6-2-sol', intelligenceIndex: 57.2576, costPerTask: 1.01438 } },
    { id: 'gemini-4-neon', label: 'Gemini 4 Neon', aa: { slug: 'gemini-4-neon', intelligenceIndex: 61.3982, costPerTask: 6.44484 } },
    { id: 'grok-4.7', label: 'Grok 4.7', aa: { slug: 'grok-4-7', intelligenceIndex: 35.485, costPerTask: 7.77154 } },
    { id: 'glm-5.3', label: 'GLM-5.3', aa: { slug: 'glm-5-3', intelligenceIndex: 31.6534, costPerTask: 5.00926 } },
    { id: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', aa: { slug: 'deepseek-v4-1-flash-1017', intelligenceIndex: 32.5896, costPerTask: 0.602105 } },
    { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', aa: { slug: 'claude-haiku-5-5', intelligenceIndex: 36.4845, costPerTask: 0.411007 } },
  ];
  return over ? over.map((patch) => {
    const hit = base.find((m) => m.id === patch.id);
    return Object.assign({}, hit, patch, { aa: Object.assign({}, hit.aa, patch.aa) });
  }) : base;
}

function rulesFor(over = {}) {
  const rules = [];
  rules.push(over.workerRule ?? { test: WORKER_RE, json: { t: DEFAULT_CLOCK_START, models: over.workerModels ?? workerModels() } });
  rules.push(over.modelsDevRule ?? { test: 'https://models.dev/api.json', json: MODELS_DEV });
  rules.push(over.plansRule ?? { test: 'data/subsidy-plans.json', json: PLANS });
  rules.push(over.snapshotRule ?? { test: 'data/aa-subsidy-snapshot.json', json: SNAPSHOT });
  return rules;
}

async function makePage(over = {}) {
  const storage = over.storage ?? makeStorage();
  const fetch = makeFetch(rulesFor(over));
  const sb = createSandbox({
    fetchImpl: fetch,
    storage,
    loadApp: false,
    loadLive: over.loadLive !== false,
    clockStart: over.clockStart ?? DEFAULT_CLOCK_START,
  });
  sb.box.document = makeDocument(PAGE_SKELETON);
  sb.document = sb.box.document;
  sb.el = (id) => sb.document.getElementById(id);
  vm.runInContext(SUBSIDY_SRC, sb.box, { filename: path.join(ROOT, 'subsidy.js') });
  await sb.settle(10);
  return { sb, fetch, storage, test: sb.box.MVM_SUBSIDY_TEST, Date: sb.Date };
}

function pureDataset(test, over = {}) {
  return test.buildDataset({
    modelsDev: over.modelsDev ?? MODELS_DEV,
    snapshot: over.snapshot ?? SNAPSHOT,
    plans: over.plans ?? PLANS,
    workerModels: over.workerModels ?? [],
  });
}

function pureTest() {
  const sb = createSandbox();
  sb.box.document = undefined;
  vm.runInContext(SUBSIDY_SRC, sb.box, { filename: path.join(ROOT, 'subsidy.js') });
  return sb.box.MVM_SUBSIDY_TEST;
}

const dotKeys = (env) => [...env.sb.el('chart-holder').querySelectorAll('.dot-point')].map((d) => d.dataset.key);

// ---------- 1. slug normalization ----------

test('dash normalization bridges models.dev, AA and the plan table', () => {
  const T = pureTest();
  assert.equal(T.dashNorm('gpt-6.2-sol'), 'gpt-6-2-sol');
  assert.equal(T.dashNorm('GLM-5.3'), 'glm-5-3');
  assert.equal(T.dashNorm('deepseek-v4.1-flash'), 'deepseek-v4-1-flash');
  assert.equal(T.dashNorm('claude-opus-5-5'), 'claude-opus-5-5');
  assert.equal(T.dashNorm('gemini-4-neon'), 'gemini-4-neon');

  const ds = T.buildDataset({ modelsDev: MODELS_DEV, snapshot: SNAPSHOT, plans: PLANS, workerModels: [] });
  const byId = {};
  ds.models.forEach((m) => { byId[m.provider + '/' + m.id] = m; });
  assert.equal(byId['openai/gpt-6.2-sol'].aaSlug, 'gpt-6-2-sol');
  assert.equal(byId['opencode-go/deepseek-v4.1-flash'].aaSlug, 'deepseek-v4-1-flash-1017');
  assert.equal(byId['opencode-go/glm-5.3'].aaSlug, 'glm-5-3');
  assert.equal(byId['xai/grok-4.7'].aaSlug, 'grok-4-7');
  assert.equal(byId['google/gemini-4-neon'].aaSlug, 'gemini-4-neon');
  assert.equal(byId['anthropic/claude-opus-5-5'].aaSlug, 'claude-opus-5-5');

  // A family member is not silently upgraded to its newer sibling's score.
  const opus5 = byId['anthropic/claude-opus-5'];
  assert.ok(opus5, 'claude-opus-5 remains in the catalogue');
  assert.equal(opus5.intelligenceIndex, null, 'claude-opus-5 must not inherit claude-opus-5-5');
});

// ---------- 2. base-tier API cost ----------

test('api_cost uses base-tier cost.input/output and ignores tiers/context_over_200k', () => {
  const T = pureTest();
  const parsed = T.parseModelsDevCatalog(MODELS_DEV);
  const opus = parsed.find((m) => m.id === 'claude-opus-5-5');
  assert.equal(opus.apiInput, 4);
  assert.equal(opus.apiOutput, 20);
  const ds = T.buildDataset({ modelsDev: MODELS_DEV, snapshot: SNAPSHOT, plans: PLANS, workerModels: [] });
  const points = T.buildPoints(ds, 'api_cost', 'all', new Set());
  const p = points.points.find((x) => x.modelKey === 'anthropic/claude-opus-5-5');
  assert.equal(p.x, 20);
  assert.equal(p.apiInput, 4);
});

// ---------- 3. missing cost_per_task is absent ----------

test('missing cost_per_task is excluded, never coerced to zero', () => {
  const T = pureTest();
  const ds = T.buildDataset({ modelsDev: MODELS_DEV, snapshot: SNAPSHOT, plans: PLANS, workerModels: [] });
  const res = T.buildPoints(ds, 'cost_per_task', 'all', new Set());
  const luna = res.points.find((p) => p.modelKey === 'openai/gpt-6-luna');
  assert.equal(luna, undefined);
  const reason = res.excluded.find((e) => e.model.id === 'gpt-6-luna');
  assert.ok(reason);
  assert.match(reason.reason, /Sem cost_per_task/);
  assert.ok(!res.allPoints.some((p) => p.x === 0), 'no point is silently priced at zero');
});

// ---------- 4. subsidy math + multi-plan expansion ----------

test('subsidized points divide cost_per_task by the plan multiple', () => {
  const T = pureTest();
  const ds = T.buildDataset({ modelsDev: MODELS_DEV, snapshot: SNAPSHOT, plans: PLANS, workerModels: [] });
  const res = T.buildPoints(ds, 'subsidized', 'all', new Set());
  const opus = res.points.filter((p) => p.modelKey === 'anthropic/claude-opus-5-5');
  assert.equal(opus.length, 3);
  assert.deepEqual([...opus].map((p) => p.planName).sort(), ['Max 5x', 'Pro', 'Ultra']);
  const pro = opus.find((p) => p.planName === 'Pro');
  assert.equal(pro.planPrice, 20);
  assert.equal(pro.multiple, 64);
  assert.ok(Math.abs(pro.effectiveCostPerTask - (10.0364 / 64)) < 1e-12);
  assert.equal(pro.baseCostPerTask, 10.0364);
  assert.equal(new Set(opus.map((p) => p.key)).size, 3, 'one distinct key per plan');
});

// ---------- 5. provider filtering ----------

test('only anthropic, openai, google, xai and opencode-go enter the dataset', () => {
  const T = pureTest();
  const ds = T.buildDataset({ modelsDev: MODELS_DEV, snapshot: SNAPSHOT, plans: PLANS, workerModels: [] });
  const providers = new Set(ds.models.map((m) => m.provider));
  assert.deepEqual([...providers].sort(), ['anthropic', 'google', 'openai', 'opencode-go', 'xai']);
  assert.ok(!ds.models.some((m) => m.provider === 'zai'), 'Z.ai is never its own provider');
  assert.ok(ds.models.some((m) => m.provider === 'opencode-go' && m.id === 'glm-5.3'), 'Z.ai content enters via opencode-go');
});

// ---------- 6. mode switching + counts + sem tabela ----------

test('default mode is subsidized and all three modes switch without reload', async () => {
  const env = await makePage();
  const T = env.test;
  assert.equal(T.state.mode, 'subsidized');
  assert.equal(env.sb.document.querySelector('[data-mode="subsidized"]').getAttribute('aria-pressed'), 'true');
  const subsidyCount = dotKeys(env).length;
  assert.ok(subsidyCount >= 17, 'one point per model×plan: ' + subsidyCount);

  env.sb.document.querySelector('[data-mode="cost_per_task"]').dispatch('click', { target: env.sb.document.querySelector('[data-mode="cost_per_task"]') });
  assert.equal(T.state.mode, 'cost_per_task');
  const taskCount = dotKeys(env).length;
  assert.ok(taskCount > 0);
  assert.ok(!dotKeys(env).some((k) => k.includes('::')), 'cost_per_task is one point per model');

  env.sb.document.querySelector('[data-mode="api_cost"]').dispatch('click', { target: env.sb.document.querySelector('[data-mode="api_cost"]') });
  assert.equal(T.state.mode, 'api_cost');
  assert.ok(dotKeys(env).length > 0);
  assert.match(env.sb.el('visible-count').textContent, /modelos sem score AA/);
});

test('counts expose plotted, no-score, frontier and the sem tabela list', async () => {
  const env = await makePage();
  const count = env.sb.el('visible-count').textContent;
  assert.match(count, /de \d+ pontos plotados/);
  assert.match(count, /modelos sem score AA/);
  assert.match(count, /sem tabela de subsídio/);
  assert.match(env.sb.el('excluded-count').textContent, /\d+ modelos sem score AA/);
  assert.match(env.sb.el('no-plan-count').textContent, /sem múltiplo de subsídio publicado/);
  assert.match(env.sb.el('no-plan-list').innerHTML, /Sem tabela de subsídio publicada/);
  // claude-haiku-5-5 has an AA score but no plan table
  assert.match(env.sb.el('no-plan-list').innerHTML, /Claude Haiku 5\.5/);
  assert.ok(!dotKeys(env).some((k) => k.startsWith('opencode-go/claude-haiku-5-5::')));
  assert.match(env.sb.el('excluded-list').innerHTML, /Sem score AA/);
});

test('subsidized tooltip/readout carries plan, price, multiple and effective cost', async () => {
  const env = await makePage();
  const dot = [...env.sb.el('chart-holder').querySelectorAll('.dot-point')].find((d) => d.dataset.key === 'anthropic/claude-opus-5-5::Pro');
  assert.ok(dot);
  assert.match(dot.getAttribute('aria-label'), /Claude Opus 5\.5/);
  assert.match(dot.getAttribute('aria-label'), /Pro plan \$20\/mo at 64×/);
  dot.dispatch('focus');
  const html = env.sb.el('readout').innerHTML;
  assert.match(html, /Pro/);
  assert.match(html, /\$20\/mo/);
  assert.match(html, /64×/);
  assert.match(html, /cost_per_task base/);
  assert.match(html, /Custo subsidiado \/ tarefa/);
  assert.match(html, /59\.106/);
  assert.equal(env.sb.consoleCalls.error.length, 0);
});

test('hostile model names are escaped in the readout and trays', async () => {
  const hostile = JSON.parse(JSON.stringify(MODELS_DEV));
  hostile.anthropic.models['claude-opus-5-5'].name = '<img src=x onerror="alert(1)">';
  const env = await makePage({ modelsDevRule: { test: 'https://models.dev/api.json', json: hostile } });
  const html = env.sb.el('readout').innerHTML + env.sb.el('toggles').innerHTML + env.sb.el('no-plan-list').innerHTML;
  assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;') || html.includes('&lt;img'));
  assert.ok(!html.includes('<img src=x'));
});

// ---------- 7. graceful degradation ----------

test('worker failure falls back to the committed AA snapshot', async () => {
  const env = await makePage({ workerRule: { test: WORKER_RE, fail: true }, modelsDevRule: { test: 'https://models.dev/api.json', fail: true } });
  assert.ok(env.sb.el('stamp').classList.contains('snapshot'));
  assert.match(env.sb.el('stamp-text').textContent, /Snapshot · 2026-11-23/);
  assert.ok(dotKeys(env).length >= 17, 'snapshot still supplies scores and cost_per_task');
  assert.equal(env.sb.consoleCalls.error.length, 0);
});

test('expired cache falls back to lastgood when every origin is unreachable', async () => {
  const seed = createSandbox();
  seed.box.document = makeDocument(PAGE_SKELETON);
  vm.runInContext(SUBSIDY_SRC, seed.box, { filename: 'subsidy.js' });
  const T = seed.box.MVM_SUBSIDY_TEST;
  const dataset = T.buildDataset({ modelsDev: MODELS_DEV, snapshot: SNAPSHOT, plans: PLANS, workerModels: [] });
  const storage = makeStorage({
    'mvm.subsidy.lastgood': JSON.stringify({ t: DEFAULT_CLOCK_START - 90 * MIN, dataset }),
  });
  const env = await makePage({
    storage,
    clockStart: DEFAULT_CLOCK_START,
    workerRule: { test: WORKER_RE, fail: true },
    modelsDevRule: { test: 'https://models.dev/api.json', fail: true },
    plansRule: { test: 'data/subsidy-plans.json', fail: true },
    snapshotRule: { test: 'data/aa-subsidy-snapshot.json', fail: true },
  });
  assert.ok(env.sb.el('stamp').classList.contains('partial'));
  assert.match(env.sb.el('stamp-text').textContent, /Stale (live|subsidy) data/);
  assert.ok(dotKeys(env).length >= 17);
});

test('a fresh 30-minute cache is used without refetching', async () => {
  const seed = createSandbox();
  seed.box.document = makeDocument(PAGE_SKELETON);
  vm.runInContext(SUBSIDY_SRC, seed.box, { filename: 'subsidy.js' });
  const T = seed.box.MVM_SUBSIDY_TEST;
  const dataset = T.buildDataset({ modelsDev: MODELS_DEV, snapshot: SNAPSHOT, plans: PLANS, workerModels: [] });
  const storage = makeStorage({
    'mvm.subsidy.v2': JSON.stringify({ t: DEFAULT_CLOCK_START - 5 * MIN, dataset }),
  });
  const env = await makePage({
    storage,
    workerRule: { test: WORKER_RE, fail: true },
    modelsDevRule: { test: 'https://models.dev/api.json', fail: true },
    plansRule: { test: 'data/subsidy-plans.json', fail: true },
    snapshotRule: { test: 'data/aa-subsidy-snapshot.json', fail: true },
  });
  assert.ok(env.sb.el('stamp').classList.contains('live'));
  assert.match(env.sb.el('stamp-text').textContent, /Live · fetched 5 min ago/);
  assert.equal(env.fetch.calls.length, 0, 'fresh cache short-circuits every network call');
  assert.ok(dotKeys(env).length >= 17);
});

test('the merged cache stays compact and never stores the raw models.dev catalog', async () => {
  const env = await makePage();
  const raw = env.storage.getItem('mvm.subsidy.v2');
  assert.ok(raw, 'cache written');
  assert.ok(raw.length < 250000, 'cache must fit comfortably in localStorage: ' + raw.length + ' bytes');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.dataset.__modelsDev, undefined);
  assert.equal(parsed.dataset.__snapshot, undefined);
  assert.ok(env.storage.getItem('mvm.subsidy.lastgood'), 'lastgood mirror written');
  assert.ok(parsed.dataset.models.length > 0);
});

test('live worker costPerTask wins over the snapshot value', async () => {
  const env = await makePage({
    workerModels: workerModels([{ id: 'gpt-6.2-sol', aa: { costPerTask: 2 } }]),
  });
  const T = env.test;
  const res = T.buildPoints(T.state.dataset, 'cost_per_task', 'all', new Set());
  const p = res.points.find((x) => x.modelKey === 'openai/gpt-6-2-sol');
  assert.equal(p.x, 2, 'live cost_per_task takes precedence');
});

// ---------- 8. worker additive extraction ----------

test('worker aaRecordFromObj lifts finite positive costPerTask and nulls the rest', () => {
  const base = {
    slug: 'claude-opus-5-5',
    shortName: 'Claude Opus 5.5',
    name: 'Claude Opus 5.5',
    intelligenceIndex: 59.106,
  };
  const withCost = WORKER.aaRecordFromObj({ ...base, intelligenceIndexCostPerTask: { cost: { total: 10.0364097195 } } });
  assert.equal(withCost.costPerTask, 10.0364097195);
  const zero = WORKER.aaRecordFromObj({ ...base, intelligenceIndexCostPerTask: { cost: { total: 0 } } });
  assert.equal(zero.costPerTask, null);
  const negative = WORKER.aaRecordFromObj({ ...base, intelligenceIndexCostPerTask: { cost: { total: -1 } } });
  assert.equal(negative.costPerTask, null);
  const missing = WORKER.aaRecordFromObj(base);
  assert.equal(missing.costPerTask, null);
});

test('worker buildModels exposes aa.costPerTask without changing other fields', () => {
  const mdMap = WORKER.parseModelsDev({
    openai: { models: { 'gpt-6.2-sol': { id: 'gpt-6.2-sol', name: 'GPT-6.2 Sol', cost: { input: 2, output: 10 } } } },
  });
  const aaMap = new Map([['gpt-6-2-sol', {
    slug: 'gpt-6-2-sol',
    shortName: 'GPT-6.2 Sol',
    name: 'GPT-6.2 Sol',
    creator: 'OpenAI',
    intelligenceIndex: 57.26,
    costPerTask: 1.0144,
    effort: null,
    isOpenWeights: false,
    url: 'https://artificialanalysis.ai/models/gpt-6-2-sol',
  }]]);
  const models = WORKER.buildModels(mdMap, aaMap, new Set(['gpt-6.2-sol']));
  const hit = models.find((m) => m.id === 'gpt-6.2-sol');
  assert.ok(hit);
  assert.equal(hit.aa.costPerTask, 1.0144);
  assert.equal(hit.aa.intelligenceIndex, 57.26);
  assert.equal(hit.ocCostPerM, 10);
  assert.equal(hit.plot, true);
});

// ---------- 9. lab plan inheritance vs the OpenCode Go exception ----------

test('parsePlans preserves both per-model entries and lab tables (legacy shapes included)', () => {
  const T = pureTest();
  const parsed = T.parsePlans(PLANS);
  assert.equal(parsed.entries.length, PLANS.entries.length);
  assert.equal(parsed.labPlans.anthropic.plans.length, 3);
  assert.equal(parsed.labPlans.anthropic.source, 'reference chart, 2026-11-23');
  // lab tables use `plan`, which is normalized to `name`
  assert.equal(parsed.labPlans.anthropic.plans[0].name, 'Pro');
  assert.equal(parsed.labPlans.openai.plans.length, 4);

  const legacyArray = T.parsePlans(PLANS.entries);
  assert.equal(legacyArray.entries.length, PLANS.entries.length);
  assert.deepEqual(Object.keys(legacyArray.labPlans), []);

  const legacyObject = T.parsePlans({ entries: PLANS.entries });
  assert.equal(legacyObject.entries.length, PLANS.entries.length);
  assert.deepEqual(Object.keys(legacyObject.labPlans), []);
  // re-parsing an already-parsed bundle is stable
  assert.equal(JSON.stringify(T.parsePlans(parsed)), JSON.stringify(parsed));
});

test('every model of a lab inherits the lab plan table', () => {
  const T = pureTest();
  const ds = T.buildDataset({ modelsDev: INHERIT_MODELS_DEV, snapshot: INHERIT_SNAPSHOT, plans: PLANS, workerModels: [] });
  const byId = {};
  ds.models.forEach((m) => { byId[m.provider + '/' + m.id] = m; });

  assert.equal(byId['anthropic/claude-sonnet-5-5'].plans.length, 3);
  assert.equal(byId['openai/gpt-7-mini'].plans.length, 4);
  assert.equal(byId['google/gemini-5-pro'].plans.length, 3);
  assert.equal(byId['xai/grok-5'].plans.length, 3);
  assert.deepEqual(Array.from(byId['anthropic/claude-sonnet-5-5'].plans, (p) => p.name), ['Pro', 'Max 5x', 'Ultra']);
  assert.equal(byId['anthropic/claude-sonnet-5-5'].plans[0].multiple, 64);
  assert.equal(byId['anthropic/claude-sonnet-5-5'].planEntry.inherited, true);

  const res = T.buildPoints(ds, 'subsidized', 'all', new Set());
  const perLab = {};
  res.points.forEach((p) => { perLab[p.provider] = (perLab[p.provider] || 0) + 1; });
  assert.deepEqual(perLab, { anthropic: 3, openai: 4, google: 3, xai: 3 });
  assert.equal(res.plottedModelCount, 4);
  assert.equal(res.byProvider.anthropic.plottedPoints, 3);
  assert.equal(res.byProvider.openai.plottedPoints, 4);
});

test('legacy fixtures without lab_plans fall back to the provider entry', () => {
  const T = pureTest();
  const ds = T.buildDataset({
    modelsDev: INHERIT_MODELS_DEV,
    snapshot: INHERIT_SNAPSHOT,
    plans: PLANS.entries,
    workerModels: [],
  });
  const sonnet = ds.models.find((m) => m.provider === 'anthropic');
  assert.equal(sonnet.plans.length, 3);
  assert.equal(sonnet.plans[0].name, 'Pro');
});

test('OpenCode Go uses only its own published entries and never inherits lab plans', () => {
  const T = pureTest();
  const ds = T.buildDataset({ modelsDev: MODELS_DEV, snapshot: SNAPSHOT, plans: PLANS, workerModels: [] });
  const byId = {};
  ds.models.forEach((m) => { byId[m.provider + '/' + m.id] = m; });

  assert.deepEqual(Array.from(byId['opencode-go/glm-5.3'].plans, (p) => p.multiple), [50, 25]);
  assert.deepEqual(Array.from(byId['opencode-go/glm-5.3'].plans, (p) => p.name), ['Go', 'Go Plus']);
  assert.deepEqual(Array.from(byId['opencode-go/deepseek-v4.1-flash'].plans, (p) => p.multiple), [10, 5]);
  assert.equal(byId['opencode-go/claude-haiku-5-5'].plans.length, 0);

  const res = T.buildPoints(ds, 'subsidized', 'all', new Set());
  const haikuPoints = res.points.filter((p) => p.modelKey === 'opencode-go/claude-haiku-5-5');
  assert.equal(haikuPoints.length, 0, 'no lab plan is invented for an unlisted Go model');
  assert.ok(res.noPlan.some((m) => m.id === 'claude-haiku-5-5'));
  assert.equal(res.byProvider['opencode-go'].noPlan, 1);
  assert.equal(res.byProvider['opencode-go'].plottedPoints, 4, 'GLM 5.3 and DeepSeek V4.1 Flash × 2 plans');
  const deepseek = res.points.find((p) => p.modelKey === 'opencode-go/deepseek-v4-1-flash' && p.planName === 'Go');
  assert.equal(deepseek.multiple, 10, 'dated AA slug still matches its own per-model entry');
});

test('missing cost_per_task splits subsidized/cost_per_task from api_cost', () => {
  const T = pureTest();
  const ds = T.buildDataset({ modelsDev: MODELS_DEV, snapshot: SNAPSHOT, plans: PLANS, workerModels: [] });

  const sub = T.buildPoints(ds, 'subsidized', 'all', new Set());
  assert.ok(!sub.points.some((p) => p.modelKey === 'openai/gpt-6-luna'));
  assert.equal(sub.noCostPerTaskCount, 1);
  assert.equal(sub.byProvider.openai.noCostPerTask, 1);
  assert.ok(sub.excluded.some((e) => e.model.id === 'gpt-6-luna' && /Sem cost_per_task/.test(e.reason)));

  const task = T.buildPoints(ds, 'cost_per_task', 'all', new Set());
  assert.ok(!task.points.some((p) => p.modelKey === 'openai/gpt-6-luna'));
  assert.equal(task.noCostPerTaskCount, 1);

  const api = T.buildPoints(ds, 'api_cost', 'all', new Set());
  const luna = api.points.find((p) => p.modelKey === 'openai/gpt-6-luna');
  assert.ok(luna, 'a scored model without cost_per_task is still plotted in api_cost');
  assert.equal(luna.x, 0.5);
  assert.equal(api.noCostPerTaskCount, 0);
});

test('committed plans file records lab and OpenCode Go provenance honestly', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/subsidy-plans.json'), 'utf8'));
  const chart = 'reference chart, 2026-11-23';
  const go = 'https://opencode.ai/docs/go';
  assert.equal(raw.collected_at, '2026-11-23');
  assert.match(raw.source, /reference chart, 2026-11-23/);
  assert.match(raw.source, /opencode\.ai\/docs\/go/);
  assert.deepEqual(Object.keys(raw.lab_plans).sort(), ['anthropic', 'google', 'openai', 'xai']);

  const expectedCounts = { anthropic: 3, openai: 4, google: 3, xai: 3 };
  const expectedFirst = {
    anthropic: { plan: 'Pro', price: 20, multiple: 64 },
    openai: { plan: 'Plus', price: 20, multiple: 15 },
    google: { plan: 'Pro', price: 20, multiple: 21 },
    xai: { plan: 'SuperGrok', price: 30, multiple: 11 },
  };
  Object.keys(expectedCounts).forEach((lab) => {
    const entry = raw.lab_plans[lab];
    assert.equal(entry.source, chart, lab + ' lab source');
    assert.equal(entry.collected_at, '2026-11-23', lab + ' lab collected_at');
    assert.equal(entry.plans.length, expectedCounts[lab], lab + ' plan count');
    assert.deepEqual(entry.plans[0], expectedFirst[lab], lab + ' first published rate');
  });

  const labEntries = raw.entries.filter((e) => e.provider !== 'opencode-go');
  const goEntries = raw.entries.filter((e) => e.provider === 'opencode-go');
  assert.equal(labEntries.length, 4);
  assert.equal(goEntries.length, 2);
  labEntries.forEach((e) => assert.equal(e.source, chart, e.provider + ' entry source'));
  goEntries.forEach((e) => assert.equal(e.source, go, e.model + ' entry source'));
  raw.entries.forEach((e) => assert.equal(e.collected_at, '2026-11-23'));

  const T = pureTest();
  const parsed = T.parsePlans(raw);
  assert.equal(parsed.labPlans.anthropic.plans.length, 3);
  assert.equal(parsed.labPlans.openai.plans.length, 4);
});

// ---------- 10. visual upgrades + offline api_cost ----------

test('no plan trail lines render in any mode', async () => {
  const env = await makePage();
  const holder = env.sb.el('chart-holder');
  const clickMode = (mode) => {
    const btn = env.sb.document.querySelector(`[data-mode="${mode}"]`);
    btn.dispatch('click', { target: btn });
  };
  for (const mode of ['subsidized', 'cost_per_task', 'api_cost']) {
    clickMode(mode);
    assert.equal(holder.querySelectorAll('.plan-trail').length, 0, mode + ' draws no plan trails');
    assert.equal(holder.querySelectorAll('.layer-trails').length, 0, mode + ' has no trail layer');
  }
});

test('the lab legend hides and shows a whole lab', async () => {
  const env = await makePage();
  const T = env.test;
  assert.ok(dotKeys(env).some((k) => k.startsWith('anthropic/')));
  const before = dotKeys(env).length;

  let btn = env.sb.el('lab-legend').querySelector('[data-legend-provider="anthropic"]');
  assert.ok(btn);
  assert.equal(btn.getAttribute('aria-pressed'), 'true');
  btn.dispatch('click', { target: btn });

  assert.ok(T.state.hiddenProviders.has('anthropic'));
  assert.ok(!dotKeys(env).some((k) => k.startsWith('anthropic/')));
  assert.equal(dotKeys(env).length, before - 3);
  btn = env.sb.el('lab-legend').querySelector('[data-legend-provider="anthropic"]');
  assert.equal(btn.getAttribute('aria-pressed'), 'false');

  btn.dispatch('click', { target: btn });
  assert.ok(!T.state.hiddenProviders.has('anthropic'));
  assert.ok(dotKeys(env).some((k) => k.startsWith('anthropic/')));
  assert.equal(dotKeys(env).length, before);
});

test('toggles group by lab with the index.html chip structure', async () => {
  const env = await makePage();
  const groups = [...env.sb.el('toggles').querySelectorAll('.lab-group')];
  assert.equal(groups.length, 5);
  assert.deepEqual(
    groups.map((g) => g.getAttribute('data-lab')),
    ['anthropic', 'openai', 'google', 'xai', 'opencode-go'],
  );
  assert.deepEqual(
    groups.map((g) => g.querySelector('.lab-name').textContent),
    ['Anthropic', 'OpenAI', 'Google', 'xAI', 'OpenCode Go'],
  );

  groups.forEach((group) => {
    const key = group.getAttribute('data-lab');
    const row = group.querySelector('.lab-row');
    assert.ok(row, key + ' lab row');
    assert.equal(row.getAttribute('data-lab-toggle'), key);
    assert.match(row.querySelector('.lab-swatch').getAttribute('style'), /^--lab-c:#/);
    assert.match(row.querySelector('.lab-count').textContent, /^\d+ models?$/);
    assert.ok(row.querySelector('.lab-state'), key + ' lab state');
    assert.equal(row.querySelector('.lab-state').getAttribute('aria-hidden'), 'true');

    const chips = group.querySelector('.chips');
    assert.ok(chips, key + ' chips row');
    assert.equal(chips.getAttribute('role'), 'group');
    const buttons = chips.querySelectorAll('.chip');
    assert.ok(buttons.length > 0, key + ' has chips');
    buttons.forEach((chip) => {
      assert.match(chip.querySelector('.chip-dot').getAttribute('style'), /^--chip-c:#/);
      assert.ok(chip.querySelector('.chip-name').textContent);
      assert.match(chip.querySelector('.chip-rank').textContent, /^\d+(\.\d)?$/);
      assert.equal(chip.getAttribute('aria-pressed'), 'true');
    });
  });
});

test('lab counts reflect only models plottable in the current mode', async () => {
  const env = await makePage();
  const counts = () => [...env.sb.el('toggles').querySelectorAll('.lab-group')]
    .map((g) => g.querySelector('.lab-count').textContent);
  const chipKeys = () => [...env.sb.el('toggles').querySelectorAll('.chip')]
    .map((c) => c.getAttribute('data-model-key'));

  assert.deepEqual(counts(), ['1 model', '1 model', '1 model', '1 model', '2 models']);
  assert.ok(!chipKeys().includes('anthropic/claude-opus-5'), 'unscored model never enters a count');
  assert.ok(!chipKeys().includes('openai/gpt-6-luna'), 'missing cost_per_task excluded in subsidized mode');
  assert.ok(!chipKeys().includes('opencode-go/claude-haiku-5-5'), 'missing plan excluded in subsidized mode');

  const apiBtn = env.sb.document.querySelector('[data-mode="api_cost"]');
  apiBtn.dispatch('click', { target: apiBtn });
  assert.deepEqual(counts(), ['1 model', '2 models', '1 model', '1 model', '3 models']);
  assert.ok(!chipKeys().includes('anthropic/claude-opus-5'));
  assert.ok(chipKeys().includes('openai/gpt-6-luna'));
  assert.ok(chipKeys().includes('opencode-go/claude-haiku-5-5'));

  const goChips = env.sb.el('toggles').querySelector('[data-lab="opencode-go"]').querySelectorAll('.chip');
  assert.deepEqual(
    goChips.map((c) => c.querySelector('.chip-name').textContent),
    ['Claude Haiku 5.5', 'DeepSeek V4.1 Flash', 'GLM-5.3'],
    'descending intelligence, ties alphabetical',
  );
  assert.deepEqual(goChips.map((c) => c.querySelector('.chip-rank').textContent), ['36.5', '32.6', '31.7']);
});

test('a chip hides one model and a lab row toggles every model', async () => {
  const env = await makePage();
  const T = env.test;
  const toggles = env.sb.el('toggles');
  const chipFor = (key) => toggles.querySelectorAll('.chip')
    .find((c) => c.getAttribute('data-model-key') === key) || null;
  const goDots = () => dotKeys(env).filter((k) => k.startsWith('opencode-go/'));
  const labState = () => toggles.querySelector('[data-lab="opencode-go"]').querySelector('.lab-state').textContent;

  assert.equal(goDots().length, 4, 'two OpenCode Go models with two plans each');
  let chip = chipFor('opencode-go/deepseek-v4-1-flash');
  assert.ok(chip);
  chip.dispatch('click', { target: chip });

  chip = chipFor('opencode-go/deepseek-v4-1-flash');
  assert.equal(chip.getAttribute('aria-pressed'), 'false');
  assert.equal(labState(), '1/2');
  assert.ok(!goDots().some((k) => k.startsWith('opencode-go/deepseek-v4-1-flash::')));
  assert.ok(goDots().some((k) => k.startsWith('opencode-go/glm-5-3::')));
  assert.equal(toggles.querySelector('.lab-row[data-lab-toggle="opencode-go"]').getAttribute('aria-pressed'), 'true');

  let row = toggles.querySelector('[data-lab-toggle="opencode-go"]');
  row.dispatch('click', { target: row });
  assert.equal(labState(), 'off');
  row = toggles.querySelector('[data-lab-toggle="opencode-go"]');
  assert.equal(row.getAttribute('aria-pressed'), 'false');
  assert.ok(toggles.querySelector('[data-lab="opencode-go"]').querySelectorAll('.chip')
    .every((c) => c.getAttribute('aria-pressed') === 'false'));
  assert.equal(goDots().length, 0);
  assert.ok(T.state.hidden.has('opencode-go/glm-5-3') && T.state.hidden.has('opencode-go/deepseek-v4-1-flash'));

  row.dispatch('click', { target: row });
  assert.equal(labState(), 'all on');
  assert.equal(toggles.querySelector('[data-lab-toggle="opencode-go"]').getAttribute('aria-pressed'), 'true');
  assert.ok(toggles.querySelector('[data-lab="opencode-go"]').querySelectorAll('.chip')
    .every((c) => c.getAttribute('aria-pressed') === 'true'));
  assert.equal(goDots().length, 4);

  // A hidden lab (via the legend) plus a chip click reveals only that model.
  const legend = env.sb.el('lab-legend').querySelector('[data-legend-provider="opencode-go"]');
  legend.dispatch('click', { target: legend });
  assert.equal(goDots().length, 0);
  chip = chipFor('opencode-go/glm-5-3');
  chip.dispatch('click', { target: chip });
  assert.ok(!T.state.hiddenProviders.has('opencode-go'));
  assert.equal(chipFor('opencode-go/glm-5-3').getAttribute('aria-pressed'), 'true');
  assert.equal(chipFor('opencode-go/deepseek-v4-1-flash').getAttribute('aria-pressed'), 'false');
  assert.equal(labState(), '1/2');
  assert.ok(goDots().length > 0);
  assert.ok(goDots().every((k) => k.startsWith('opencode-go/glm-5-3::')));
});

test('summary counters expose plotted, no-score, no-cost and no-plan counts', async () => {
  const env = await makePage();
  const res = env.test.state.results;
  const el = env.sb.el('summary-counters');
  const text = el.textContent;
  assert.match(text, /Modelos plotados/);
  assert.match(text, /pontos/);
  assert.match(text, /Sem score AA/);
  assert.match(text, /Sem cost_per_task/);
  assert.match(text, /OpenCode Go sem tabela/);
  assert.equal(res.plottedModelCount, 6);
  assert.equal(res.noScoreCount, 1);
  assert.equal(res.noCostPerTaskCount, 1);
  assert.equal(res.noPlan.length, 1);
  assert.equal(el.querySelectorAll('.summary-counter').length, 4);
  assert.ok(text.includes(String(res.plottedModelCount)));
  assert.ok(text.includes(String(res.noScoreCount)));
  assert.ok(text.includes(String(res.noCostPerTaskCount)));
  assert.ok(text.includes(String(res.noPlan.length)));
});

test('chart tooltip carries the plan arithmetic and escapes hostile names', async () => {
  const env = await makePage();
  const holder = env.sb.el('chart-holder');
  const tip = env.sb.el('chart-tooltip');
  const dot = [...holder.querySelectorAll('.dot-point')].find((d) => d.dataset.key === 'anthropic/claude-opus-5-5::Pro');
  assert.ok(dot);
  dot.dispatch('focus');

  assert.equal(tip.getAttribute('hidden'), null);
  const html = tip.innerHTML;
  assert.match(html, /Claude Opus 5\.5/);
  assert.match(html, /Anthropic/);
  assert.match(html, /Score AA/);
  assert.match(html, /59\.106/);
  assert.match(html, /cost_per_task/);
  assert.match(html, /Plano/);
  assert.match(html, /Pro/);
  assert.match(html, /\$20\/mo/);
  assert.match(html, /64×/);
  assert.match(html, /Custo efetivo \/ task/);
  assert.ok(holder.querySelector('#chart-tooltip'), 'tooltip survives the chart re-render');

  dot.dispatch('blur');
  assert.equal(tip.getAttribute('hidden'), '');

  const hostile = JSON.parse(JSON.stringify(MODELS_DEV));
  hostile.anthropic.models['claude-opus-5-5'].name = '<img src=x onerror="alert(1)">';
  const evil = await makePage({ modelsDevRule: { test: 'https://models.dev/api.json', json: hostile } });
  const evilDot = [...evil.sb.el('chart-holder').querySelectorAll('.dot-point')]
    .find((d) => d.dataset.key === 'anthropic/claude-opus-5-5::Pro');
  assert.ok(evilDot);
  evilDot.dispatch('focus');
  const evilHtml = evil.sb.el('chart-tooltip').innerHTML;
  assert.ok(evilHtml.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'));
  assert.ok(!evilHtml.includes('<img src=x'));
  assert.equal(evil.sb.consoleCalls.error.length, 0);
});

test('tooltip fields follow cost_per_task and api_cost modes', async () => {
  const env = await makePage();
  const clickMode = (mode) => {
    const btn = env.sb.document.querySelector(`[data-mode="${mode}"]`);
    btn.dispatch('click', { target: btn });
  };

  clickMode('cost_per_task');
  let dot = [...env.sb.el('chart-holder').querySelectorAll('.dot-point')]
    .find((d) => d.dataset.key === 'openai/gpt-6-2-sol');
  assert.ok(dot);
  dot.dispatch('focus');
  let html = env.sb.el('chart-tooltip').innerHTML;
  assert.match(html, /cost_per_task/);
  assert.match(html, /Score AA/);
  assert.ok(!/Múltiplo/.test(html), 'no plan arithmetic outside subsidized mode');

  clickMode('api_cost');
  dot = [...env.sb.el('chart-holder').querySelectorAll('.dot-point')]
    .find((d) => d.dataset.key === 'openai/gpt-6-2-sol');
  assert.ok(dot);
  dot.dispatch('focus');
  html = env.sb.el('chart-tooltip').innerHTML;
  assert.match(html, /API output \/ 1M/);
  assert.match(html, /API input \/ 1M/);
  assert.match(html, /Score AA/);
  assert.ok(!/Múltiplo/.test(html));
});

test('flat snapshot modelsDev input/output feeds api_cost offline', () => {
  const T = pureTest();
  const flat = {
    anthropic: {
      name: 'Anthropic',
      models: { 'claude-flat': { name: 'Claude Flat', input: 2, output: 8 } },
    },
  };
  const parsed = T.parseModelsDevCatalog(flat);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].apiInput, 2);
  assert.equal(parsed[0].apiOutput, 8);

  const ds = T.buildDataset({
    modelsDev: flat,
    snapshot: { collected_at: '2026-11-23', models: [{ slug: 'claude-flat', intelligenceIndex: 40, costPerTask: 1 }] },
    plans: PLANS,
    workerModels: [],
  });
  const res = T.buildPoints(ds, 'api_cost', 'all', new Set());
  const p = res.points.find((x) => x.modelKey === 'anthropic/claude-flat');
  assert.ok(p);
  assert.equal(p.x, 8);
  assert.equal(p.apiInput, 2);
});

test('the cache key is v2 and the flat snapshot still renders offline', async () => {
  const env = await makePage({
    modelsDevRule: { test: 'https://models.dev/api.json', fail: true },
    workerRule: { test: WORKER_RE, fail: true },
  });
  assert.equal(env.test.CACHE_KEY, 'mvm.subsidy.v2');
  const raw = env.storage.getItem('mvm.subsidy.v2');
  assert.ok(raw, 'merged dataset cached under the v2 key');
  const apiDot = env.sb.document.querySelector('[data-mode="api_cost"]');
  apiDot.dispatch('click', { target: apiDot });
  assert.ok(dotKeys(env).length > 0, 'api_cost still plots from snapshot.modelsDev flat prices');
  assert.equal(env.sb.consoleCalls.error.length, 0);
});
