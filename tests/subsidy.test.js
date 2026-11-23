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
  <div class="chart-holder" id="chart-holder">
    <div class="chart-loading" id="chart-loading" aria-hidden="true">
      <span class="chart-loading-text">Fetching…</span>
    </div>
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

const PLANS = {
  source: 'https://opencode.ai/docs/go',
  collected_at: '2026-11-23',
  entries: [
    { provider: 'anthropic', providerName: 'Anthropic', model: 'claude-opus-5-5', modelName: 'Opus 5.5', plans: [{ name: 'Pro', price: 20, multiple: 64 }, { name: 'Max 5x', price: 100, multiple: 77 }, { name: 'Ultra', price: 200, multiple: 66 }] },
    { provider: 'openai', providerName: 'OpenAI', model: 'gpt-6.2-sol', modelName: 'GPT-6.2 Sol', plans: [{ name: 'Plus', price: 20, multiple: 15 }, { name: 'Pro 10x', price: 100, multiple: 30 }, { name: 'Pro 20x', price: 200, multiple: 30 }, { name: 'Pro 500', price: 500, multiple: 30 }] },
    { provider: 'google', providerName: 'Google', model: 'gemini-4-neon', modelName: 'Gemini 4 Neon', plans: [{ name: 'Pro', price: 20, multiple: 21 }, { name: 'Ultra 5x', price: 100, multiple: 24 }, { name: 'Ultra 20x', price: 200, multiple: 48 }] },
    { provider: 'xai', providerName: 'xAI', model: 'grok-4.7', modelName: 'Grok 4.7', plans: [{ name: 'SuperGrok', price: 30, multiple: 11 }, { name: 'Plus', price: 100, multiple: 13 }, { name: 'Heavy', price: 300, multiple: 11 }] },
    { provider: 'opencode-go', providerName: 'OpenCode Go', model: 'glm-5.3', modelName: 'GLM 5.3', plans: [{ name: 'Go', price: 10, multiple: 50 }, { name: 'Go Plus', price: 40, multiple: 25 }] },
    { provider: 'opencode-go', providerName: 'OpenCode Go', model: 'deepseek-v4.1-flash', modelName: 'DeepSeek V4.1 Flash', plans: [{ name: 'Go', price: 10, multiple: 10 }, { name: 'Go Plus', price: 40, multiple: 5 }] },
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
    'mvm.subsidy.v1': JSON.stringify({ t: DEFAULT_CLOCK_START - 5 * MIN, dataset }),
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
  const raw = env.storage.getItem('mvm.subsidy.v1');
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
