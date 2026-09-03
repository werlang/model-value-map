/**
 * Bar-mode tests — the free-roster page (window.MVM_BAR_CHART) renders a
 * descending intelligence bar chart instead of the cost scatter.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { standardEnv } from './helpers/setup-live.js';

const FREE_FLAGS = { prelude: 'window.MVM_BAR_CHART=1;window.MVM_NO_CURATED=1;' };

function freeModel(over = {}) {
  return {
    id: 'free-x',
    label: 'Free X',
    author: 'Lab X',
    hue: '#3B5BDB',
    rank: null,
    weeklyTokensT: null,
    ocCostPerM: 0,
    ocCost: { input: 0, output: 0, cacheRead: null, cacheWrite: null },
    reasoning: true,
    openWeights: null,
    contextWindowTokens: 128000,
    plot: false,
    excludeReason: 'Free on OpenRouter — $0/1M output (off the log cost scale).',
    aa: null,
    ...over,
  };
}

function scored(id, label, score, author = 'Lab') {
  return freeModel({
    id,
    label,
    author,
    aa: { name: label, intelligenceIndex: score, effort: null, url: 'https://artificialanalysis.ai/models/' + id },
  });
}

function unscored(id, label) {
  return freeModel({
    id,
    label,
    excludeReason: 'Not scored on the Artificial Analysis Intelligence Index yet.',
  });
}

function freeSnapshot() {
  return [
    scored('mid-model', 'Mid Model', 37.82, 'Beta'),
    scored('top-model', 'Top Model', 45.4, 'Alpha'),
    scored('low-model', 'Low Model', 20.2, 'Alpha'),
    unscored('new-thing', 'New Thing'),
  ];
}

async function bootFree(models = freeSnapshot()) {
  const env = standardEnv({ loadApp: true, snapshot: models, workerFail: true, ...FREE_FLAGS });
  await env.sb.settle();
  return env;
}

const barsOf = (env) => [...env.sb.el('chart-holder').querySelectorAll('.bar-row')];
const barOf = (env, id) => barsOf(env).find((b) => b.dataset.id === id);

test('scored free models render as descending bars, not scatter dots', async () => {
  const env = await bootFree();
  assert.equal(env.sb.el('chart-holder').querySelectorAll('.dot-point').length, 0);
  const bars = barsOf(env);
  assert.deepEqual(bars.map((b) => b.dataset.id), ['top-model', 'mid-model', 'low-model']);
  for (const b of bars) {
    assert.equal(b.getAttribute('tabindex'), '0');
    assert.equal(b.getAttribute('role'), 'img');
    assert.match(b.getAttribute('aria-label'), /free on OpenRouter/);
    assert.ok(b.querySelector('.bar-fill'));
    assert.ok(b.querySelector('.bar-value'));
  }
  assert.equal(barOf(env, 'top-model').getAttribute('aria-label'),
    '1. Top Model, intelligence 45.4 out of 100, free on OpenRouter.');
  // values descend down the chart
  const vals = bars.map((b) => parseFloat(b.querySelector('.bar-value').textContent));
  assert.deepEqual(vals, [45.4, 37.82, 20.2]);
});

test('bar widths are proportional to score', async () => {
  const env = await bootFree();
  const w = (id) => parseFloat(barOf(env, id).querySelector('.bar-fill').getAttribute('width'));
  assert.ok(w('top-model') > w('mid-model') && w('mid-model') > w('low-model'));
});

test('unscored models skip the chart and list in the tray', async () => {
  const env = await bootFree();
  assert.equal(barOf(env, 'new-thing'), undefined);
  const tray = env.sb.el('excluded-list').innerHTML;
  assert.match(tray, /New Thing/);
  assert.match(tray, /Not scored on the Artificial Analysis Intelligence Index yet/);
  assert.ok(!tray.includes('Top Model'), 'scored models are charted, not trayed');
});

test('the counter reports scored and awaiting counts', async () => {
  const env = await bootFree();
  assert.equal(env.sb.el('visible-count').textContent,
    '3 of 3 scored · 1 awaiting a score · toggling redraws it');
});

test('the idle readout ranks the charted models smartest-first', async () => {
  const env = await bootFree();
  const html = env.sb.el('readout').innerHTML;
  assert.match(html, /Free models, smartest first/);
  const iTop = html.indexOf('Top Model');
  const iMid = html.indexOf('Mid Model');
  const iLow = html.indexOf('Low Model');
  assert.ok(iTop < iMid && iMid < iLow, 'ranked descending');
  assert.match(html, /1 more free without a score/);
});

test('clicking a chip hides its bar and persists', async () => {
  const env = await bootFree();
  const chip = env.sb.el('toggles').querySelector('[data-chip="top-model"]');
  chip.dispatch('click', { target: chip });
  assert.deepEqual(barsOf(env).map((b) => b.dataset.id), ['mid-model', 'low-model']);
  assert.equal(chip.getAttribute('aria-pressed'), 'false');
  assert.equal(env.sb.el('visible-count').textContent,
    '2 of 3 scored · 1 awaiting a score · toggling redraws it');
});

test('frontier filter and cost sort are hidden in bar mode', async () => {
  const env = await bootFree();
  assert.equal(env.sb.document.querySelector('[data-action="frontier"]').style.display, 'none');
  assert.equal(env.sb.document.querySelector('[data-sort="cost"]').style.display, 'none');
  // all/none still work
  const act = (name) => env.sb.document.querySelector(`[data-action="${name}"]`);
  act('none').dispatch('click', { target: act('none') });
  assert.equal(barsOf(env).length, 0);
  assert.match(env.sb.el('readout').innerHTML, /No models selected/);
  act('all').dispatch('click', { target: act('all') });
  assert.equal(barsOf(env).length, 3);
});

test('hovering a bar drives the readout with free pricing', async () => {
  const env = await bootFree();
  barOf(env, 'mid-model').dispatch('pointerenter');
  const html = env.sb.el('readout').innerHTML;
  assert.match(html, /Mid Model/);
  assert.match(html, /Free/);
  assert.ok(html.includes('OpenRouter ↗'));
  assert.ok(!html.includes('models.dev'));
  assert.ok(!html.includes('on frontier'));
});

test('keyboard focus drives the readout; blur keeps it sticky', async () => {
  const env = await bootFree();
  const bar = barOf(env, 'low-model');
  bar.dispatch('focus');
  assert.match(env.sb.el('readout').innerHTML, /Low Model/);
  assert.ok(bar.classList.contains('is-active'));
  bar.dispatch('blur');
  assert.ok(!bar.classList.contains('is-active'));
  assert.match(env.sb.el('readout').innerHTML, /Low Model/);
});

test('the screen-reader table ranks scored rows before awaiting ones', async () => {
  const env = await bootFree();
  const html = env.sb.document.querySelector('#sr-data-table tbody').innerHTML;
  const iTop = html.indexOf('<td>Top Model</td>');
  const iLow = html.indexOf('<td>Low Model</td>');
  const iNew = html.indexOf('New Thing (awaiting score)');
  assert.ok(iTop >= 0 && iLow >= 0 && iNew >= 0);
  assert.ok(iTop < iLow && iLow < iNew);
});

test('bar boot produces no console errors', async () => {
  const env = await bootFree();
  assert.equal(env.sb.consoleCalls.error.length, 0);
});

function approxModel() {
  return freeModel({
    id: 'glm-5.2',
    label: 'GLM 5.2',
    author: 'Z AI',
    orId: 'z-ai/glm-5.2:free',
    aa: { name: 'GLM-5 (Reasoning)', slug: 'glm-5', intelligenceIndex: 40.6, effort: null, url: 'https://artificialanalysis.ai/models/glm-5', match: 'approximate' },
  });
}

async function bootApprox() {
  const env = standardEnv({ loadApp: true, snapshot: [scored('top-model', 'Top Model', 45.4, 'Alpha'), approxModel(), unscored('new-thing', 'New Thing')], workerFail: true, ...FREE_FLAGS });
  await env.sb.settle();
  return env;
}

test('approximate bars show ≈ and name the closest match', async () => {
  const env = await bootApprox();
  const bar = [...env.sb.el('chart-holder').querySelectorAll('.bar-row')].find((b) => b.dataset.id === 'glm-5.2');
  assert.ok(bar, 'approximate model still charted');
  assert.equal(bar.querySelector('.bar-value').textContent, '≈40.6');
  assert.equal(bar.getAttribute('aria-label'),
    '2. GLM 5.2, intelligence approximately 40.6 out of 100 (closest Artificial Analysis match), free on OpenRouter as z-ai/glm-5.2:free.');
  // exact bar keeps the plain rendering
  const top = [...env.sb.el('chart-holder').querySelectorAll('.bar-row')].find((b) => b.dataset.id === 'top-model');
  assert.equal(top.querySelector('.bar-value').textContent, '45.4');
});

test('approximate readout carries the OpenRouter id and closest-match note', async () => {
  const env = await bootApprox();
  const bar = [...env.sb.el('chart-holder').querySelectorAll('.bar-row')].find((b) => b.dataset.id === 'glm-5.2');
  bar.dispatch('pointerenter');
  const html = env.sb.el('readout').innerHTML;
  assert.match(html, /GLM 5\.2/);
  assert.match(html, /≈40\.6/);
  assert.ok(html.includes('z-ai/glm-5.2:free'));
  assert.match(html, /Closest Artificial Analysis match: GLM-5 \(Reasoning\) — approximate/);
});
