import test from 'node:test';
import assert from 'node:assert/strict';
import { standardEnv, OC_INDEX, AA_INDEX, RELAY_HOSTS } from './helpers/setup-live.js';
import {
  tinySnapshot, tinyCoverage, aaModel, aaPageHtml,
  ocHomeHtml, homeFrom, defaultWorker,
} from './helpers/fixtures.js';
import { FakeWorker } from './helpers/fake-worker.js';

const ocCalls = (calls) => calls.filter((u) => u.includes('opencode.ai'));
const aaCalls = (calls) => calls.filter((u) => u.includes('artificialanalysis.ai'));

async function run(over = {}) {
  const env = standardEnv(over);
  const res = await env.sb.LiveData.load(over.models ?? tinySnapshot(), over.opts);
  return { ...env, res };
}

// Body satisfying every endpoint validator at once (validators are substring
// checks; the fake worker sources its results from fixtures, not the HTML).
const UNIVERSAL_BODY = 'tokenCost leaderboard $R[ currentModel intelligenceIndex';

// ---------- transport ordering ----------

test('OpenCode requests start at the relays; direct is the last resort', async () => {
  // every transport fails → load null, but the attempt order is observable
  const { fetch, res } = await run({ ocIndexRule: { test: OC_INDEX, fail: true } });
  assert.equal(res, null);
  const seq = ocCalls(fetch.calls);
  const hosts = seq.map((u) => (u.startsWith('https://opencode.ai') ? 'direct' : RELAY_HOSTS.find((h) => u.includes(h))));
  assert.deepEqual(hosts, [...RELAY_HOSTS, 'direct']);
});

test('Artificial Analysis requests try direct first, relays as backup', async () => {
  const { fetch, res } = await run({ aaIndexRule: { test: AA_INDEX, fail: true } });
  assert.ok(res); // OC side succeeded
  const seq = aaCalls(fetch.calls).filter((u) => {
    if (u.startsWith('https://artificialanalysis.ai')) return !/\/models\/.+/.test(u); // index page only
    return decodeURIComponent(u).endsWith('.ai/models'); // relay-wrapped index fetches
  });
  const hosts = seq.map((u) => (u === AA_INDEX ? 'direct' : RELAY_HOSTS.find((h) => u.includes(h))));
  assert.equal(hosts[0], 'direct');
  assert.deepEqual(hosts.slice(1), ['api.codetabs.com', 'corsproxy.io', 'api.allorigins.win']);
});

test('the starting relay rotates across successive loads', async () => {
  const env = standardEnv({});
  const starts = [];
  for (let i = 0; i < 3; i++) {
    await env.sb.LiveData.load(tinySnapshot(), { force: true });
    const seg = env.fetch.drain();
    const firstOc = ocCalls(seg)[0];
    starts.push(RELAY_HOSTS.find((h) => firstOc.includes(h)));
  }
  // The AA fetch also consumes the rotation cursor each load, so the OC
  // starting relay advances by two per load through the three-relay circle.
  assert.deepEqual(starts, ['api.allorigins.win', 'corsproxy.io', 'api.codetabs.com']);
});

// ---------- relay health (benching) ----------

test('a repeatedly failing relay gets benched and stops being tried', async () => {
  const cov = tinyCoverage();
  cov.board = []; // fan out per-model OC pages → many OC fetches per load
  cov.aaRecords = [aaModel({ slug: 'kimi-k3' }), aaModel({ slug: 'mimo-v2-5-0424' })];

  const env = standardEnv({
    coverage: cov,
    ocIndexRule: { test: OC_INDEX, body: ocHomeHtml({ rows: cov.rows }) },
    extraRules: [
      { test: 'api.codetabs.com', status: 502 },
      { test: 'api.allorigins.win', body: UNIVERSAL_BODY },
      { test: 'corsproxy.io', body: UNIVERSAL_BODY },
    ],
  });

  for (let i = 0; i < 4; i++) await env.sb.LiveData.load(tinySnapshot(), { force: true });

  const calls = ocCalls(env.fetch.calls);
  const codetabsPositions = calls
    .map((u, i) => (u.includes('api.codetabs.com') ? i : -1))
    .filter((i) => i >= 0);
  assert.ok(codetabsPositions.length >= 3, 'codetabs must be tried at least 3 times before benching');
  const lastTry = codetabsPositions[codetabsPositions.length - 1];
  assert.ok(
    !calls.slice(lastTry + 1).some((u) => u.includes('api.codetabs.com')),
    'no codetabs attempts after it was benched',
  );
});

test('benched relays return to the pool after a full sweep of failures', async () => {
  const env = standardEnv({
    ocIndexRule: { test: OC_INDEX, fail: true },
    aaIndexRule: { test: AA_INDEX, fail: true },
  });
  for (let i = 0; i < 3; i++) {
    const res = await env.sb.LiveData.load(tinySnapshot(), { force: true });
    assert.equal(res, null);
  }
  const before = ocCalls(env.fetch.calls).length;

  // 4th load: every relay is benched → the full sweep returns them to duty
  const res4 = await env.sb.LiveData.load(tinySnapshot(), { force: true });
  assert.equal(res4, null);
  const after = ocCalls(env.fetch.calls).slice(before);
  for (const host of RELAY_HOSTS) {
    assert.ok(after.some((u) => u.includes(host)), `${host} retried after full sweep`);
  }
});

// ---------- response handling ----------

test('a non-200 response moves down the chain to a healthy transport', async () => {
  const cov = tinyCoverage();
  const { fetch, res } = await run({
    coverage: cov,
    extraRules: [{ test: 'api.allorigins.win', status: 500 }],
  });
  assert.equal(res.state, 'live');
  assert.ok(fetch.calls.some((u) => u.includes('api.codetabs.com')));
});

test('a body failing validation moves down the chain', async () => {
  const cov = tinyCoverage();
  const { res } = await run({
    coverage: cov,
    extraRules: [{ test: 'api.allorigins.win', body: 'garbage without markers' }],
  });
  assert.equal(res.state, 'live');
});

// ---------- authoritative misses (HTTP 404/410) ----------

async function authoritativeMiss(status) {
  const cov = tinyCoverage();
  cov.aaRecords = []; // nothing in the index → both models fan out to AA pages
  const { sb, res } = await run({
    coverage: cov,
    aaIndexRule: { test: AA_INDEX, body: '<script>intelligenceIndex</script>' }, // marker-only, zero records
    aaPageRules: [{ test: /^https:\/\/artificialanalysis\.ai\/models\/.+/, status }],
  });
  return { sb, res };
}

test('HTTP 404 on an AA model page is an authoritative miss, not a transport failure', async () => {
  const { sb, res } = await authoritativeMiss(404);
  assert.equal(res.state, 'partial');            // scores fell back to snapshot…
  const entry = JSON.parse(sb.storage.getItem('mvm.live.v1'));
  assert.equal(typeof entry.t, 'number');        // …but a clean-fetch cache was still earned
  assert.ok(sb.storage.getItem('mvm.live.lastgood'));
});

test('HTTP 410 is treated as an authoritative miss too', async () => {
  const { sb, res } = await authoritativeMiss(410);
  assert.equal(res.state, 'partial');
  assert.ok(sb.storage.getItem('mvm.live.v1'));
});

test('a 404 on the curated slug still lets the normalized slug page answer', async () => {
  const cov = tinyCoverage();
  cov.aaRecords = [aaModel({ slug: 'kimi-k3' })]; // mimo missing from the index
  const { fetch, res } = await run({
    coverage: cov,
    aaPageRules: [
      { test: /models\/mimo-v2-5$/, body: aaPageHtml(aaModel({ slug: 'mimo-v2-5', intelligenceIndex: 44.44 })) },
      { test: /^https:\/\/artificialanalysis\.ai\/models\/.+/, status: 404 },
    ],
  });
  const tried = fetch.calls
    .filter((u) => /artificialanalysis\.ai\/models\/mimo/.test(u))
    .map((u) => u.split('/models/')[1]);
  assert.deepEqual(tried, ['mimo-v2-5-0424', 'mimo-v2-5']); // both candidates tried, in order

  const mimo = res.models.find((m) => m.id === 'mimo-v2.5');
  assert.equal(mimo.aa.intelligenceIndex, 44.44);
  assert.equal(mimo.aa.url, 'https://artificialanalysis.ai/models/mimo-v2-5'); // renamed slug surfaces in the url
});

// ---------- future-proofing ----------

test('if OpenCode ever ships CORS headers, the direct attempt rescues a dead relay chain', async () => {
  const { res } = await run({
    extraRules: [
      { test: 'api.allorigins.win', fail: true },
      { test: 'api.codetabs.com', fail: true },
      { test: 'corsproxy.io', fail: true },
    ],
  });
  assert.equal(res.state, 'live');
});
