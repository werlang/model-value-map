/**
 * Endpoint-namespaced cache tests — the root and /openrouter pages must never
 * read each other's roster out of localStorage.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { standardEnv } from './helpers/setup-live.js';
import { makeStorage } from './helpers/storage.js';
import { DEFAULT_CLOCK_START } from './helpers/sandbox.js';

const FREE_URL = 'https://model-value-map-api.pswerlang.workers.dev/openrouter';
const FREE_RULE = /^https:\/\/model-value-map-api\.pswerlang\.workers\.dev\/openrouter$/;
const FREE_FLAGS = { prelude: `window.MVM_WORKER_URL='${FREE_URL}';window.MVM_NO_CURATED=1;window.MVM_BAR_CHART=1;` };
const FREE_CACHE = 'mvm.live.openrouter.v1';
const FREE_LASTGOOD = 'mvm.live.openrouter.lastgood';
const MAIN_CACHE = 'mvm.live.v1';
const MAIN_LASTGOOD = 'mvm.live.lastgood';

function freeMarker() {
  return [{ id: 'free-marker', label: 'Free Marker', author: 'OR', hue: '#3B5BDB', rank: null, weeklyTokensT: null, ocCostPerM: 0, ocCost: { input: 0, output: 0 }, reasoning: false, openWeights: null, contextWindowTokens: null, plot: false, excludeReason: 'x', aa: null }];
}

function freeEnv(over = {}) {
  return standardEnv({
    ...FREE_FLAGS,
    workerRule: { test: FREE_RULE, json: { t: DEFAULT_CLOCK_START, meta: {}, models: freeMarker() } },
    ...over,
  });
}

test('the free endpoint caches under its own keys, not the shared ones', async () => {
  const env = freeEnv();
  const res = await env.sb.LiveData.load([]);
  assert.equal(res.state, 'live');
  assert.ok(env.sb.storage.getItem(FREE_CACHE), 'namespaced cache written');
  assert.ok(env.sb.storage.getItem(FREE_LASTGOOD), 'namespaced lastgood written');
  assert.equal(env.sb.storage.getItem(MAIN_CACHE), null);
  assert.equal(env.sb.storage.getItem(MAIN_LASTGOOD), null);
  const calls = env.fetch.calls.length;
  const res2 = await env.sb.LiveData.load([]);
  assert.equal(res2.state, 'cached');
  assert.equal(res2.models.map((m) => m.id).join(','), 'free-marker');
  assert.equal(env.fetch.calls.length, calls, 'second load rides the namespaced cache');
});

test('a fresh main-page cache is invisible to the free page', async () => {
  const mainModels = [{ id: 'main-marker', label: 'Main', author: 'OC', hue: '#3B5BDB', rank: 1, weeklyTokensT: 1, ocCostPerM: 15, ocCost: { input: 3, output: 15 }, reasoning: true, openWeights: true, contextWindowTokens: 100, plot: true, aa: { name: 'Main', intelligenceIndex: 50, effort: null, url: 'https://x' } }];
  const storage = makeStorage({ [MAIN_CACHE]: JSON.stringify({ t: DEFAULT_CLOCK_START, models: mainModels }) });
  const env = freeEnv({ storage });
  const res = await env.sb.LiveData.load([]);
  assert.equal(res.state, 'live', 'cross-endpoint cache must not satisfy the load');
  assert.equal(res.models.map((m) => m.id).join(','), 'free-marker');
  assert.ok(env.fetch.calls.some((u) => u.includes('/openrouter')), 'free endpoint actually fetched');
});

test('a fresh free-page cache is invisible to the root page', async () => {
  const storage = makeStorage({ [FREE_CACHE]: JSON.stringify({ t: DEFAULT_CLOCK_START, models: freeMarker() }) });
  const env = standardEnv({ storage });
  const res = await env.sb.LiveData.load([]);
  assert.equal(res.state, 'live', 'cross-endpoint cache must not satisfy the load');
  assert.ok(!res.models.some((m) => m.id === 'free-marker'));
});

test('the root endpoint keeps its historic cache keys', async () => {
  const env = standardEnv({});
  await env.sb.LiveData.load([]);
  assert.ok(env.sb.storage.getItem(MAIN_CACHE));
  assert.ok(env.sb.storage.getItem(MAIN_LASTGOOD));
  assert.equal(env.sb.storage.getItem(FREE_CACHE), null);
});
