import test from 'node:test';
import assert from 'node:assert/strict';
import { standardEnv, OC_INDEX, AA_INDEX } from './helpers/setup-live.js';
import { makeStorage } from './helpers/storage.js';
import { DEFAULT_CLOCK_START } from './helpers/sandbox.js';
import {
  tinySnapshot, tinyCoverage, modelRow, boardRow,
  homeFrom, defaultWorker, aaModel,
} from './helpers/fixtures.js';
import { FakeWorker } from './helpers/fake-worker.js';

const CACHE_KEY = 'mvm.live.v1';
const LASTGOOD = 'mvm.live.lastgood';
const MIN = 60 * 1000;
const UNIVERSAL = 'tokenCost leaderboard $R[ currentModel intelligenceIndex';

async function run(over = {}) {
  const env = standardEnv(over);
  const res = await env.sb.LiveData.load(over.models ?? tinySnapshot(), over.opts);
  return { ...env, res };
}

/** Clean load against a shared storage. */
async function seedClean(storage, coverageOver = {}) {
  const cov = { ...tinyCoverage(), ...coverageOver };
  FakeWorker.reset();
  FakeWorker.handler = defaultWorker({ home: homeFrom(cov.rows, cov.board) });
  const env = standardEnv({ coverage: cov, storage });
  const res = await env.sb.LiveData.load(tinySnapshot());
  return { env, res };
}

// ---------- write semantics ----------

test('a clean load caches the parsed payload under mvm.live.v1', async () => {
  const { sb } = await run();
  const raw = sb.storage.getItem(CACHE_KEY);
  assert.ok(raw, 'cache entry written');
  const entry = JSON.parse(raw);
  assert.equal(typeof entry.t, 'number');
  assert.ok(Array.isArray(entry.live.leaderboard));
  assert.ok(Array.isArray(entry.live.tokenCost));
  assert.ok(Array.isArray(entry.live.aaIndex), 'Map serialized as entries');
  assert.equal(entry.live.updatedAt, '2026-08-24T10:00:00Z');
});

test('the same payload is mirrored to the un-TTLd lastgood key', async () => {
  const { sb } = await run();
  assert.deepEqual(
    JSON.parse(sb.storage.getItem(CACHE_KEY)),
    JSON.parse(sb.storage.getItem(LASTGOOD)),
  );
});

test('a transport failure poisons the fast cache but not lastgood', async () => {
  // AA index unreachable: direct fails by rule, relays have no matching rule
  // (the UNIVERSAL bodies are scoped to OpenCode URLs) → transport exhausted.
  const ocRelay = (host) => (u) => u.includes(host) && u.includes('opencode.ai');
  const { sb } = await run({
    extraRules: [
      { test: ocRelay('api.allorigins.win'), body: UNIVERSAL },
      { test: ocRelay('api.codetabs.com'), body: UNIVERSAL },
      { test: ocRelay('corsproxy.io'), body: UNIVERSAL },
    ],
    aaIndexRule: { test: AA_INDEX, fail: true },
  });
  assert.equal(sb.storage.getItem(CACHE_KEY), null, 'failed fetch must not be cached');
  assert.ok(sb.storage.getItem(LASTGOOD), 'backbone success still refreshes lastgood');
});

// ---------- read semantics / TTL ----------

test('a fresh cache serves the second load with zero network calls', async () => {
  const env = standardEnv({});
  await env.sb.LiveData.load(tinySnapshot());
  const callsAfterFirst = env.fetch.calls.length;
  const res2 = await env.sb.LiveData.load(tinySnapshot());
  assert.equal(res2.state, 'cached');
  assert.equal(env.fetch.calls.length, callsAfterFirst, 'no refetch within TTL');
  assert.equal(res2.ocUpdatedAt, '2026-08-24T10:00:00Z');
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

function baseLiveEntries() {
  return {
    updatedAt: '2026-08-24T10:00:00Z',
    leaderboard: [
      modelRow(),
      modelRow({ model: 'mimo-v2.5', provider: 'xiaomi', author: 'Xiaomi', rank: 2, tokens: 12610 }),
    ],
    tokenCost: [boardRow(), boardRow({ model: 'mimo-v2.5', total: 0.28, output: 0.28, input: 0.14 })],
    ocPages: {},
    aaIndex: [
      ['kimi-k3', { slug: 'kimi-k3', shortName: 'Kimi K3', name: 'Kimi K3', intelligenceIndex: 61.23, effort: null, isOpenWeights: true }],
      ['mimo-v2-5-0424', { slug: 'mimo-v2-5-0424', shortName: 'MiMo-V2.5', name: 'M', intelligenceIndex: 38.04, effort: null, isOpenWeights: true }],
    ],
    aaPages: {},
  };
}
function seedCache(storage, live, ageMs = 0) {
  // Timestamps are relative to the sandbox clock epoch, not the host clock.
  storage.setItem(CACHE_KEY, JSON.stringify({ t: DEFAULT_CLOCK_START - ageMs, live }));
}

test('corrupt JSON in the cache key is ignored without crashing', async () => {
  const storage = makeStorage({ [CACHE_KEY]: '{definitely::not json::' });
  const { res } = await run({ storage });
  assert.equal(res.state, 'live'); // fell through to the network
});

test('a structurally invalid cache entry (leaderboard not an array) is ignored', async () => {
  const storage = makeStorage();
  storage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), live: { leaderboard: 'nope' } }));
  const { res } = await run({ storage });
  assert.equal(res.state, 'live');
});

test('garbage tokenCost rows in a tampered cache never reach the chart', async () => {
  const live = baseLiveEntries();
  live.tokenCost = [{ model: 'kimi-k3', total: '9e99999', output: null }];
  const storage = makeStorage();
  seedCache(storage, live);
  const { res } = await run({ storage });
  assert.equal(res.state, 'cached'); // served from the (tampered) cache
  const kimi = res.models.find((m) => m.id === 'kimi-k3');
  assert.equal(kimi.ocCostPerM, 15, 'falls back to the snapshot price');
  assert.ok(res.snapFallbacks >= 1);
});

test('string intelligence indices in a tampered cache are sanitized out', async () => {
  const live = baseLiveEntries();
  live.aaIndex = [['kimi-k3', { slug: 'kimi-k3', shortName: 'K', intelligenceIndex: 'high' }]];
  const storage = makeStorage();
  seedCache(storage, live);
  const { res } = await run({ storage });
  const kimi = res.models.find((m) => m.id === 'kimi-k3');
  assert.equal(kimi.aa.intelligenceIndex, 59.7, 'snapshot score survives the tampered entry');
});

// ---------- outage layer (stale) ----------

async function seedThenOutage({ advanceMin = 40, seedCoverageOver = {} } = {}) {
  const storage = makeStorage();
  const seeded = await seedClean(storage, seedCoverageOver);
  void seeded;

  FakeWorker.reset(); // outage runs should never need the worker
  const env = standardEnv({
    storage,
    ocIndexRule: { test: OC_INDEX, fail: true }, // OpenCode unreachable everywhere
  });
  env.Date.advance(advanceMin * MIN);
  const res = await env.sb.LiveData.load(tinySnapshot());
  return { env, res };
}

test('with OpenCode unreachable, the newest clean fetch renders as stale', async () => {
  const cov = { ...tinyCoverage() };
  cov.board = [boardRow({ total: 14.5 }), ...cov.board.slice(1)]; // marker value unique to lastgood
  const { env, res } = await seedThenOutage({
    advanceMin: 40,
    seedCoverageOver: cov,
  });

  assert.equal(res.state, 'stale');
  assert.equal(res.ocUpdatedAt, '2026-08-24T10:00:00Z', 'timestamp preserved from lastgood');
  const kimi = res.models.find((m) => m.id === 'kimi-k3');
  assert.equal(kimi.ocCostPerM, 14.5, 'values come from lastgood, not the ancient snapshot');
  const t = JSON.parse(env.sb.storage.getItem(LASTGOOD)).t;
  assert.equal(res.fetchedAt, t);
});

test('the stale path keeps dropped-from-leaderboard models visible (union)', async () => {
  const cov = tinyCoverage();
  cov.rows = [cov.rows[0]]; // leaderboard carries only kimi-k3
  const { res } = await seedThenOutage({ seedCoverageOver: cov });

  assert.equal(res.state, 'stale');
  const ids = [...res.models].map((m) => m.id).sort();
  assert.deepEqual(ids, ['kimi-k3', 'mimo-v2.5']);
  assert.ok(res.models.every((m) => m.plot || m.excludeReason != null));
});

test('an expired v1 cache does not block the stale rescue', async () => {
  // seedClean writes v1+lastgood; the outage env advances past TTL first
  const { res } = await seedThenOutage({ advanceMin: 90 });
  assert.equal(res.state, 'stale');
});

test('OpenCode down with NO lastgood ever fetched → stay on snapshot (null)', async () => {
  const { res } = await run({ ocIndexRule: { test: OC_INDEX, fail: true } });
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

void aaModel;
