import test from 'node:test';
import assert from 'node:assert/strict';
import { standardEnv, MODELS_DEV, AA_INDEX } from './helpers/setup-live.js';
import { makeStorage } from './helpers/storage.js';
import { DEFAULT_CLOCK_START } from './helpers/sandbox.js';
import {
  tinySnapshot, tinyCoverage, modelsDevCatalog,
} from './helpers/fixtures.js';

const CACHE_KEY = 'mvm.live.v1';
const LASTGOOD = 'mvm.live.lastgood';
const MIN = 60 * 1000;

async function run(over = {}) {
  const env = standardEnv(over);
  const res = await env.sb.LiveData.load(over.models ?? tinySnapshot(), over.opts);
  return { ...env, res };
}

// ---------- write semantics ----------

test('a clean load caches the parsed payload under mvm.live.v1', async () => {
  const { sb } = await run();
  const raw = sb.storage.getItem(CACHE_KEY);
  assert.ok(raw, 'cache entry written');
  const entry = JSON.parse(raw);
  assert.equal(typeof entry.t, 'number');
  assert.ok(Array.isArray(entry.models));
  assert.ok(entry.models.length > 0);
});

test('the same payload is mirrored to the un-TTLd lastgood key', async () => {
  const { sb } = await run();
  assert.deepEqual(
    JSON.parse(sb.storage.getItem(CACHE_KEY)),
    JSON.parse(sb.storage.getItem(LASTGOOD)),
  );
});

// ---------- read semantics / TTL ----------

test('a fresh cache serves the second load with zero network calls', async () => {
  const env = standardEnv({});
  await env.sb.LiveData.load(tinySnapshot());
  const callsAfterFirst = env.fetch.calls.length;
  const res2 = await env.sb.LiveData.load(tinySnapshot());
  assert.equal(res2.state, 'cached');
  assert.equal(env.fetch.calls.length, callsAfterFirst, 'no refetch within TTL');
});

test('force bypasses a fresh cache and hits the network', async () => {
  const env = standardEnv({});
  await env.sb.LiveData.load(tinySnapshot());
  const before = env.fetch.calls.length;
  const res = await env.sb.LiveData.load(tinySnapshot(), { force: true });
  assert.notEqual(res.state, 'cached');
  assert.ok(env.fetch.calls.length > before);
});

test('an expired cache answers stale instantly and refreshes in the background', async () => {
  const env = standardEnv({});
  await env.sb.LiveData.load(tinySnapshot());
  const t1 = JSON.parse(env.sb.storage.getItem(CACHE_KEY)).t;

  // inside TTL → served from cache
  env.Date.advance(29 * MIN);
  const cached = await env.sb.LiveData.load(tinySnapshot());
  assert.equal(cached.state, 'cached');

  // past TTL → the aged payload paints immediately as stale (refreshing), and
  // fetchFresh runs behind the callback
  env.Date.advance(2 * MIN);
  const seen = [];
  const res = await env.sb.LiveData.load(tinySnapshot(), { onUpdate: (r) => seen.push(r) });
  assert.equal(res.state, 'stale');
  assert.equal(res.refreshing, true);
  assert.equal(res.fetchedAt, t1, 'painted from the aged payload');

  await env.sb.settle(); // let the background refresh land
  assert.deepEqual([...seen.map((s) => s.state)], ['live'], 'fresh outcome reported via onUpdate');
  const t2 = JSON.parse(env.sb.storage.getItem(CACHE_KEY)).t;
  assert.ok(t2 > t1, 'background refresh rewrote the fast cache');

  const third = await env.sb.LiveData.load(tinySnapshot());
  assert.equal(third.state, 'cached'); // next visit rides the rewritten cache
});

// ---------- hostile / damaged cache content ----------

test('corrupt JSON in the cache key is ignored without crashing', async () => {
  const storage = makeStorage({ [CACHE_KEY]: '{definitely::not json::' });
  const { res } = await run({ storage });
  assert.equal(res.state, 'live'); // fell through to the network
});

test('a structurally invalid cache entry (models not an array) is ignored', async () => {
  const storage = makeStorage();
  storage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), models: 'nope' }));
  const { res } = await run({ storage });
  assert.equal(res.state, 'live');
});

// ---------- outage layer (stale) ----------

test('with origins unreachable, the newest clean fetch renders as stale', async () => {
  const storage = makeStorage();
  const env = standardEnv({ storage });
  await env.sb.LiveData.load(tinySnapshot());

  // Origins now fail
  const env2 = standardEnv({
    storage,
    modelsDevRule: { test: MODELS_DEV, fail: true },
    aaIndexRule: { test: AA_INDEX, fail: true },
  });
  env2.Date.advance(40 * MIN);
  const res = await env2.sb.LiveData.load(tinySnapshot());

  assert.equal(res.state, 'stale');
  const kimi = res.models.find((m) => m.id === 'kimi-k3');
  assert.ok(kimi);
  assert.equal(kimi.ocCostPerM, 15);
});

test('origins down with NO lastgood ever fetched → returns null', async () => {
  const { res } = await run({
    modelsDevRule: { test: MODELS_DEV, fail: true },
    aaIndexRule: { test: AA_INDEX, fail: true },
  });
  assert.equal(res, null);
});

// ---------- storage faults ----------

test('setItem failures (quota / private mode) never break the load', async () => {
  const storage = makeStorage();
  storage.failSet = true;
  const { sb, res } = await run({ storage });
  assert.equal(res.state, 'live');
  assert.equal(Object.keys(sb.storage.dump()).length, 0);
});

test('getItem failures are treated as an empty store', async () => {
  const storage = makeStorage();
  storage.failGet = true;
  const { res } = await run({ storage });
  assert.equal(res.state, 'live');
});
