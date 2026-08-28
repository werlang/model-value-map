import test from 'node:test';
import assert from 'node:assert/strict';
import { standardEnv, MODELS_DEV, AA_INDEX, CURATED_GO, WORKER_CURATED } from './helpers/setup-live.js';
import { makeStorage } from './helpers/storage.js';
import { DEFAULT_CLOCK_START } from './helpers/sandbox.js';
import {
  snapshot as fullSnapshot, tinySnapshot, tinyCoverage,
  aaIndexHtml, modelsDevCatalog,
} from './helpers/fixtures.js';

const MIN = 60 * 1000;
const OFFLINE = { workerFail: true };

function page(over = {}) {
  const models = over.models ?? fullSnapshot();
  const env = standardEnv({
    loadApp: true,
    snapshot: models,
    ...over,
  });
  return env;
}

async function bootOffline(over = {}) {
  const env = page({ ...OFFLINE, ...over });
  await env.sb.settle();
  return env;
}

const dotsOf = (env) => [...env.sb.el('chart-holder').querySelectorAll('.dot-point')];
const dotOf = (env, id) => dotsOf(env).find((d) => d.dataset.id === id);

// ---------- boot & static render ----------

test('offline boot paints the snapshot: four plotted dots with a11y attributes', async () => {
  const env = await bootOffline();
  const dots = dotsOf(env);
  assert.equal(dots.length, 4);
  for (const d of dots) {
    assert.equal(d.getAttribute('tabindex'), '0');
    assert.equal(d.getAttribute('role'), 'img');
    assert.ok(d.getAttribute('aria-label').includes('per million tokens'));
    const mark = d.querySelector('.dot-mark');
    assert.ok(mark);
    const r = parseFloat(mark.getAttribute('r'));
    assert.ok(!isNaN(r) && r > 0, 'dot radius must be a valid positive number');
    assert.ok(!mark.style.animationDelay.includes('NaN'), 'animationDelay must not be NaN');
  }
});

test('dot aria-labels carry price, score and frontier membership', async () => {
  const env = await bootOffline();
  assert.equal(
    dotOf(env, 'kimi-k3').getAttribute('aria-label'),
    'Kimi K3, rank 17. $15 per million tokens, intelligence 59.7, on the Pareto frontier.',
  );
  // dominated model gets no frontier suffix
  assert.equal(
    dotOf(env, 'kimi-k2.7-code').getAttribute('aria-label'),
    'Kimi K2.7 Code, rank 11. $18 per million tokens, intelligence 50.02.',
  );
});

test('frontier membership classes mark exactly the non-dominated set', async () => {
  const env = await bootOffline();
  for (const id of ['kimi-k3', 'glm-5.3', 'mimo-v2.5']) {
    assert.ok(dotOf(env, id).classList.contains('frontier-member'), id + ' on frontier');
  }
  assert.ok(!dotOf(env, 'kimi-k2.7-code').classList.contains('frontier-member'));
});

test('the idle readout explains the map and lists frontier members in cost order', async () => {
  const env = await bootOffline();
  const html = env.sb.el('readout').innerHTML;
  assert.match(html, /Reading the map/);
  const iMimo = html.indexOf('MiMo-V2.5');
  const iGlm = html.indexOf('GLM-5.3');
  const iKimi = html.indexOf('Kimi K3<');
  assert.ok(iMimo < iGlm && iGlm < iKimi, 'frontier members listed cheapest-first');
  assert.match(html, /Frontier recomputed over the 4 models currently toggled on\./);
});

test('the counter reports plotted and frontier counts', async () => {
  const env = await bootOffline();
  assert.equal(
    env.sb.el('visible-count').textContent,
    '4 of 4 plotted · frontier has 3 models · toggling redraws it',
  );
});

test('unplottable models are listed off-map with their reasons', async () => {
  const env = await bootOffline();
  const html = env.sb.el('excluded-list').innerHTML;
  assert.match(html, /Ox-Alpha/);
  assert.match(html, /No token cost published on OpenCode; not scored by Artificial Analysis\./);
  assert.match(html, /Muse Spark 1\.2 \(contrib\)/);
});

test('remote-looking labels are escaped everywhere they render', async () => {
  const hostile = '<img src=x onerror="alert(1)">';
  const models = fullSnapshot().map((m) => (m.id === 'kimi-k3' ? { ...m, label: hostile } : m));
  const env = await bootOffline({ models });
  const readout = env.sb.el('readout').innerHTML;
  assert.ok(readout.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'));
  assert.ok(!readout.includes('<img src=x'));
  // toggles + screen-reader table too
  const toggles = env.sb.el('toggles').innerHTML;
  assert.ok(toggles.includes('&lt;img'));
  const table = env.sb.document.querySelector('#sr-data-table tbody');
  assert.ok(table.innerHTML.includes('&lt;img'));
});

test('the screen-reader table carries plotted and excluded rows', async () => {
  const env = await bootOffline();
  const html = env.sb.document.querySelector('#sr-data-table tbody').innerHTML;
  assert.ok(html.includes('<td>Kimi K3</td><td>Moonshot</td><td>17</td><td>15</td><td>59.7</td>'));
  assert.match(html, /\(not plottable\)/);
});

test('models switcher sorts toggle chips and lab groups by score, cost, and provider', async () => {
  const env = await bootOffline();
  const costBtn = env.sb.document.querySelector('.sort-btn[data-sort="cost"]');
  const provBtn = env.sb.document.querySelector('.sort-btn[data-sort="provider"]');
  const scoreBtn = env.sb.document.querySelector('.sort-btn[data-sort="score"]');

  // Switch to Cost
  costBtn.dispatch('click');
  assert.equal(costBtn.getAttribute('aria-pressed'), 'true');
  let firstLab = env.sb.el('toggles').querySelector('.lab-name').textContent;
  let firstChip = env.sb.el('toggles').querySelector('.chip-name').textContent;
  // Lowest cost plotted in snapshot is Xiaomi (MiMo-V2.5 @ $0.28)
  assert.equal(firstLab, 'Xiaomi');
  assert.equal(firstChip, 'MiMo-V2.5');

  // Switch to Provider (Alphabetical)
  provBtn.dispatch('click');
  assert.equal(provBtn.getAttribute('aria-pressed'), 'true');
  firstLab = env.sb.el('toggles').querySelector('.lab-name').textContent;
  // Alphabetical first in snapshot is Meta
  assert.equal(firstLab, 'Meta');

  // Switch back to Score
  scoreBtn.dispatch('click');
  assert.equal(scoreBtn.getAttribute('aria-pressed'), 'true');
  firstLab = env.sb.el('toggles').querySelector('.lab-name').textContent;
  firstChip = env.sb.el('toggles').querySelector('.chip-name').textContent;
  // Highest score in snapshot is Moonshot (Kimi K3 @ 59.7)
  assert.equal(firstLab, 'Moonshot');
  assert.equal(firstChip, 'Kimi K3');
});

test('hovering a model dot brings it to the front and activates highlight', async () => {
  const env = await bootOffline();
  const dot = dotOf(env, 'kimi-k3');
  const gTop = env.sb.document.querySelector('.layer-top');
  
  dot.dispatch('pointerenter');
  assert.ok(dot.classList.contains('is-active'));
  assert.ok(gTop.children.length > 0); // brought to front via top layer overlay

  dot.dispatch('pointerleave');
  assert.ok(!dot.classList.contains('is-active'));
  assert.equal(gTop.children.length, 0);
});

test('boot produces no console errors', async () => {
  const env = await bootOffline();
  assert.equal(env.sb.consoleCalls.error.length, 0);
});

// ---------- toggling ----------

test('clicking a chip hides the dot, recomputes the frontier, and persists', async () => {
  const storage = makeStorage();
  const env = await bootOffline({ storage });
  const chip = env.sb.el('toggles').querySelector('[data-chip="kimi-k3"]');
  chip.dispatch('click', { target: chip });

  assert.equal(dotsOf(env).length, 3);
  assert.equal(chip.getAttribute('aria-pressed'), 'false');
  // the previously dominated kimi-k2.7-code joins the redrawn frontier
  assert.ok(dotOf(env, 'kimi-k2.7-code').classList.contains('frontier-member'));
  assert.deepEqual(JSON.parse(storage.getItem('mvm.hidden.v1')), ['kimi-k3']);

  chip.dispatch('click', { target: chip }); // restore
  assert.equal(dotsOf(env).length, 4);
  assert.deepEqual(JSON.parse(storage.getItem('mvm.hidden.v1')), []);
});

test('lab rows toggle every model of an author at once', async () => {
  const env = await bootOffline();
  const labBtn = env.sb.el('toggles').querySelector('[data-lab-toggle="Moonshot"]');
  labBtn.dispatch('click', { target: labBtn });
  assert.equal(dotOf(env, 'kimi-k3'), undefined);
  assert.equal(dotOf(env, 'kimi-k2.7-code'), undefined);
  const state = labBtn.querySelector('.lab-state');
  assert.equal(state.textContent, 'off');

  labBtn.dispatch('click', { target: labBtn });
  assert.equal(dotsOf(env).length, 4);
});

test('quick actions: none → empty state, all → restore, frontier → members only', async () => {
  const storage = makeStorage();
  const env = await bootOffline({ storage });
  const act = (name) => env.sb.document.querySelector(`[data-action="${name}"]`);

  act('none').dispatch('click', { target: act('none') });
  assert.equal(dotsOf(env).length, 0);
  assert.match(env.sb.el('readout').innerHTML, /No models selected/);
  assert.equal(
    env.sb.el('visible-count').textContent,
    '0 of 4 plotted · frontier has 0 models · toggling redraws it',
  );

  act('all').dispatch('click', { target: act('all') });
  assert.equal(dotsOf(env).length, 4);

  act('frontier').dispatch('click', { target: act('frontier') });
  assert.deepEqual(dotsOf(env).map((d) => d.dataset.id).sort(),
    ['glm-5.3', 'kimi-k3', 'mimo-v2.5']);
  assert.deepEqual(JSON.parse(storage.getItem('mvm.hidden.v1')).sort(), ['kimi-k2.7-code']);
});

test('hidden models survive a reload via localStorage', async () => {
  const storage = makeStorage({ 'mvm.hidden.v1': JSON.stringify(['kimi-k3']) });
  const env = await bootOffline({ storage });
  assert.equal(dotOf(env, 'kimi-k3'), undefined);
  assert.equal(env.sb.el('toggles').querySelector('[data-chip="kimi-k3"]').getAttribute('aria-pressed'), 'false');
});

test('keyboard focus drives the readout; blur keeps the last selection sticky', async () => {
  const env = await bootOffline();
  const dot = dotOf(env, 'kimi-k3');
  dot.dispatch('focus');
  const title = env.sb.el('readout').querySelector('.readout-model-title');
  assert.match(title.textContent, /Kimi K3/);
  assert.match(env.sb.el('readout').innerHTML, /on frontier/);

  // blur clears the crosshair + ring but the readout intentionally keeps the
  // last-selected model visible for screen-reader context (aria-live panel)
  dot.dispatch('blur');
  assert.equal(dot.querySelector('.dot-ring').style.opacity, 0);
  assert.match(env.sb.el('readout').innerHTML, /Kimi K3/);
});

test('a stray blur with nothing focused is a harmless no-op', async () => {
  const env = await bootOffline();
  const before = env.sb.el('readout').innerHTML;
  dotOf(env, 'mimo-v2.5').dispatch('blur'); // never focused
  assert.equal(env.sb.el('readout').innerHTML, before);
});

test('ResizeObserver ticks repaint the chart at the new width', async () => {
  const env = await bootOffline();
  const holder = env.sb.el('chart-holder');
  holder.clientWidth = 900;
  env.sb.triggerResize();
  await new Promise((r) => setTimeout(r, 10)); // rAF stub rides a timer
  assert.equal(holder.querySelectorAll('.dot-label').length, 4); // labels appear ≥640px
});

test('without the live layer at all, boot stamps the pure snapshot state', async () => {
  const env = standardEnv({ loadApp: true, loadLive: false });
  await env.sb.settle();
  assert.ok(env.sb.el('stamp').classList.contains('snapshot'));
  assert.equal(env.sb.el('stamp-text').textContent, 'Snapshot · Aug 23, 2026');
});

// ---------- responsive labels ----------

test('dot labels yield to the readout below 640px of chart width', async () => {
  const env = await bootOffline();
  const holder = env.sb.el('chart-holder');
  assert.equal(holder.querySelectorAll('.dot-label').length, 0); // default stub width is 0

  holder.clientWidth = 900;
  const chip = env.sb.el('toggles').querySelector('[data-chip="kimi-k3"]'); // any re-render trigger
  chip.dispatch('click', { target: chip });
  chip.dispatch('click', { target: chip });
  assert.equal(holder.querySelectorAll('.dot-label').length, 4);
});

// ---------- status stamps ----------

test('failed live fetch stamps the snapshot fallback state', async () => {
  const env = await bootOffline();
  const stamp = env.sb.el('stamp');
  assert.ok(stamp.classList.contains('error'));
  assert.match(env.sb.el('stamp-text').textContent, /Failed to load data/);
});

async function happyPage(storage) {
  const cov = tinyCoverage();
  const env = page({
    models: tinySnapshot(),
    coverage: cov,
    loadApp: true,
    storage,
  });
  return env;
}

test('a successful live fetch stamps the live state', async () => {
  const env = await happyPage();
  await env.sb.settle();
  const stamp = env.sb.el('stamp');
  assert.ok(stamp.classList.contains('live'));
  assert.match(env.sb.el('stamp-text').textContent, /Live · updated/);
  // live data replaced the roster
  assert.equal(dotsOf(env).length, 2);
});

test('cached loads stamp their age in minutes', async () => {
  const storage = makeStorage();
  const seeded = await happyPage(storage);
  await seeded.sb.settle();

  const later = page({ models: tinySnapshot(), storage, ...OFFLINE });
  later.Date.advance(2 * MIN);
  await later.sb.settle();
  assert.ok(later.sb.el('stamp').classList.contains('live'));
  assert.match(later.sb.el('stamp-text').textContent, /Live · fetched \d+ min ago/);
});

test('stale lastgood renders with the stale stamp when origins are unreachable', async () => {
  const storage = makeStorage();
  const seeded = await happyPage(storage);
  await seeded.sb.settle();

  // the replacement sandbox boots with a clock already past the cache TTL
  const later = page({ models: tinySnapshot(), storage, ...OFFLINE, clockStart: DEFAULT_CLOCK_START + 40 * MIN });
  await later.sb.settle();
  assert.ok(later.sb.el('stamp').classList.contains('partial'));
  assert.equal(later.sb.el('stamp-text').textContent,
    'Stale live data · fetched 40 min ago · sources unreachable');
});

test('staleness beyond an hour switches the stamp to hour formatting', async () => {
  const storage = makeStorage();
  const seeded = await happyPage(storage);
  await seeded.sb.settle();

  const later = page({ models: tinySnapshot(), storage, ...OFFLINE, clockStart: DEFAULT_CLOCK_START + 90 * MIN });
  await later.sb.settle();
  assert.equal(later.sb.el('stamp-text').textContent,
    'Stale live data · fetched 1h 30m ago · sources unreachable');
});

test('the ⟳ button recovers a failed boot into a live one (force refresh)', async () => {
  const env = await bootOffline({ models: tinySnapshot() });
  assert.ok(env.sb.el('stamp').classList.contains('error'));

  // worker comes back online — new rule must PRECEDE the failing one
  env.fetch.rules.unshift({ test: 'model-value-map-api.pswerlang.workers.dev', json: { t: Date.now(), models: tinySnapshot().filter((m)=>m.plot).slice(0,2) } });

  env.sb.el('stamp-refresh').dispatch('click', { target: env.sb.el('stamp-refresh') });
  await env.sb.settle();
  assert.ok(env.sb.el('stamp').classList.contains('live'));
});

test('an in-flight fetch shows the loading state with a disabled ⟳ and visible chart spinner', async () => {
  const env = page({
    loadApp: true,
    models: tinySnapshot(),
    workerRule: { test: 'model-value-map-api.pswerlang.workers.dev', hang: true },
  });
  await env.sb.settle();
  assert.equal(env.sb.el('stamp-text').textContent, 'Fetching live data…');
  const btn = env.sb.el('stamp-refresh');
  assert.ok(btn.classList.contains('spinning'));
  assert.equal(btn.disabled, true);
  const chartLoading = env.sb.el('chart-loading');
  assert.ok(chartLoading.classList.contains('is-visible'), 'chart loading spinner is visible during fetch');
});

test('chart loading spinner hides when live fetch succeeds', async () => {
  const env = await happyPage();
  await env.sb.settle();
  const chartLoading = env.sb.el('chart-loading');
  assert.ok(!chartLoading.classList.contains('is-visible'), 'chart loading spinner is hidden after successful fetch');
});

test('chart loading spinner hides when live fetch fails', async () => {
  const env = await bootOffline();
  const chartLoading = env.sb.el('chart-loading');
  assert.ok(!chartLoading.classList.contains('is-visible'), 'chart loading spinner is hidden after failed fetch');
});

// ---------- curated Go table filtering ----------

/** Worker returns the full roster (curated + non-curated noise), like the real worker. */
function noiseModel() {
  return {
    id: 'claude-fable-5', label: 'Claude Fable 5', author: 'Anthropic', hue: '#0C8599',
    rank: 30, weeklyTokensT: 0.5, ocCostPerM: 50, ocCost: { input: 10, output: 50, cached: 1 },
    reasoning: true, openWeights: false, contextWindowTokens: 200000,
    aa: { name: 'Claude Fable 5', intelligenceIndex: 60, effort: null, url: 'https://artificialanalysis.ai/models/claude-fable-5' },
    plot: true,
  };
}

function curatedPage(over = {}) {
  const models = over.models ?? fullSnapshot();
  const full = [...models, noiseModel()];
  return standardEnv({ loadApp: true, snapshot: models, workerModels: full, ...over });
}

test('boot filters the full worker roster down to the Go table set', async () => {
  const env = curatedPage();
  await env.sb.settle();
  // noise model (claude-fable-5) is not on the Go docs → hidden everywhere
  assert.equal(dotOf(env, 'claude-fable-5'), undefined);
  assert.equal(env.sb.el('toggles').querySelector('[data-chip="claude-fable-5"]'), null);
  assert.equal(env.sb.el('toggles').querySelectorAll('[data-chip]').length, 6);
  // curated members stay: 4 plotted dots
  assert.equal(dotsOf(env).length, 4);
});

test('live refresh keeps the curated filter applied', async () => {
  const env = curatedPage();
  await env.sb.settle();
  assert.ok(env.sb.el('stamp').classList.contains('live'));
  assert.equal(dotsOf(env).length, 4);
  assert.equal(dotOf(env, 'claude-fable-5'), undefined);
});

test('when the Go docs and the worker curated endpoint all fail, nothing is filtered', async () => {
  const env = curatedPage({ curatedGoFail: true, workerCuratedFail: true });
  await env.sb.settle();
  assert.equal(dotsOf(env).length, 5); // full roster including the noise model
});

test('worker curated endpoint covers a direct docs failure (CORS blocked)', async () => {
  const env = curatedPage({ curatedGoFail: true });
  await env.sb.settle();
  assert.equal(dotOf(env, 'claude-fable-5'), undefined);
  assert.equal(dotsOf(env).length, 4);
});

test('every model on the Go table shows, even ones absent from Zen (e.g. glm-5.3)', async () => {
  const models = fullSnapshot();
  const goHtml = `<table><thead><tr><th>Model</th><th>Model ID</th></tr></thead><tbody>` +
    models.map((m) => `<tr><td>${m.label}</td><td>${m.id}</td></tr>`).join('') +
    `<tr><td>GLM-5.3</td><td>glm-5.3</td></tr></tbody></table>`;
  const glm53 = {
    ...models[0], id: 'glm-5.3', label: 'GLM-5.3', author: 'Zhipu', hue: '#0CA678',
    ocCostPerM: 4.4, ocCost: { input: 1.4, output: 4.4, cached: 0.26 },
    aa: { name: 'GLM-5.3 (max)', intelligenceIndex: 59.51, effort: 'max', url: 'https://artificialanalysis.ai/models/glm-5-3' },
  };
  const full = [...models, glm53, noiseModel()];
  const env = standardEnv({ loadApp: true, snapshot: models, workerModels: full, curatedGoHtml: goHtml });
  await env.sb.settle();
  assert.ok(dotOf(env, 'glm-5.3'), 'glm-5.3 is on the Go table → must be plotted');
  assert.equal(dotOf(env, 'claude-fable-5'), undefined, 'off-table models stay hidden');
  assert.equal(dotsOf(env).length, 5); // 4 snapshot plotted + glm-5.3
});
