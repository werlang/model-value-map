import test from 'node:test';
import assert from 'node:assert/strict';
import { standardEnv, OC_INDEX, AA_INDEX } from './helpers/setup-live.js';
import { makeStorage } from './helpers/storage.js';
import { tinySnapshot, tinyCoverage, homeFrom, defaultWorker } from './helpers/fixtures.js';
import { FakeWorker } from './helpers/fake-worker.js';

const API_URL = 'https://model-value-map-api.werlang.workers.dev';
const CACHE_KEY = 'mvm.live.v1';

function sampleApiPayload() {
  return {
    t: 1756000000000,
    live: {
      updatedAt: '2026-08-24T10:00:00Z',
      leaderboard: [
        { model: 'kimi-k3', author: 'Moonshot', rank: 1, tokens: 5000 },
        { model: 'mimo-v2.5', author: 'Xiaomi', rank: 2, tokens: 3000 },
      ],
      tokenCost: [
        { model: 'kimi-k3', output: 15, total: 15, input: 2.5 },
        { model: 'mimo-v2.5', output: 0.28, total: 0.28, input: 0.14 },
      ],
      ocPages: {},
      aaIndex: [
        ['kimi-k3', { slug: 'kimi-k3', shortName: 'Kimi K3', intelligenceIndex: 59.7, effort: null, isOpenWeights: true }],
        ['mimo-v2-5-0424', { slug: 'mimo-v2-5-0424', shortName: 'MiMo-V2.5', intelligenceIndex: 38.04, effort: null, isOpenWeights: true }],
      ],
      aaPages: {},
    },
  };
}

test('Step 1 (LS hit): warm LS serves immediately without hitting API or scrapers', async () => {
  const storage = makeStorage();
  const apiPayload = sampleApiPayload();
  storage.setItem(CACHE_KEY, JSON.stringify(apiPayload));

  const env = standardEnv({ storage });
  const callsBefore = env.fetch.calls.length;

  const res = await env.sb.LiveData.load(tinySnapshot(), { apiUrl: API_URL });
  assert.equal(res.state, 'cached');
  assert.equal(env.fetch.calls.length, callsBefore, 'zero network calls on fresh LS hit');
  assert.equal(res.models.length, 2);
});

test('Step 2 (LS miss, API hit): fetches from API, stores in LS, skips scrapers', async () => {
  const storage = makeStorage();
  const apiPayload = sampleApiPayload();
  const env = standardEnv({
    storage,
    extraRules: [
      { test: API_URL, body: JSON.stringify(apiPayload) },
    ],
  });

  const res = await env.sb.LiveData.load(tinySnapshot(), { apiUrl: API_URL });
  assert.equal(res.state, 'live');
  assert.equal(res.models.length, 2);

  // Stored in localStorage
  const stored = JSON.parse(storage.getItem(CACHE_KEY));
  assert.ok(stored, 'cached in LS');
  assert.equal(stored.t, apiPayload.t);
  assert.equal(stored.live.updatedAt, '2026-08-24T10:00:00Z');

  // Verify that OpenCode and AA scrapers were NOT called
  assert.ok(env.fetch.calls.includes(API_URL), 'API was called');
  assert.ok(!env.fetch.calls.includes(OC_INDEX), 'OpenCode scraper skipped');
  assert.ok(!env.fetch.calls.includes(AA_INDEX), 'AA scraper skipped');

  // Second load hits LS with zero new fetches
  const callCount = env.fetch.calls.length;
  const res2 = await env.sb.LiveData.load(tinySnapshot(), { apiUrl: API_URL });
  assert.equal(res2.state, 'cached');
  assert.equal(env.fetch.calls.length, callCount, 'subsequent load rides LS cache');
});

test('Step 3 & 4 (LS miss, API miss): performs scraping and POSTs updated data to API', async () => {
  const storage = makeStorage();
  const cov = tinyCoverage();
  FakeWorker.reset();
  FakeWorker.handler = defaultWorker({ home: homeFrom(cov.rows, cov.board) });

  let postedBody = null;
  const env = standardEnv({
    storage,
    coverage: cov,
    extraRules: [
      {
        test: API_URL,
        method: 'POST',
        oncall: (_url, opts) => {
          postedBody = JSON.parse(opts.body);
        },
        body: JSON.stringify({ ok: true }),
      },
      {
        test: API_URL,
        method: 'GET',
        status: 404, // API miss (e.g. empty worker on cold deploy)
        body: JSON.stringify({ error: 'No data stored yet' }),
      },
    ],
  });

  const res = await env.sb.LiveData.load(tinySnapshot(), { apiUrl: API_URL });
  assert.equal(res.state, 'live');
  assert.equal(res.models.length, 2);

  // Stored in localStorage
  assert.ok(storage.getItem(CACHE_KEY), 'stored in LS after scrape');

  // Verified that a POST request was sent to update the API
  assert.ok(postedBody !== null, 'POST was made to API');
  assert.equal(typeof postedBody.t, 'number');
  assert.ok(Array.isArray(postedBody.live.leaderboard));
  assert.ok(Array.isArray(postedBody.live.tokenCost));
  assert.ok(Array.isArray(postedBody.live.aaIndex));
});

test('force refresh: bypasses LS and API GET, performs scrape, and POSTs to API', async () => {
  const storage = makeStorage();
  const apiPayload = sampleApiPayload();
  storage.setItem(CACHE_KEY, JSON.stringify(apiPayload));

  const cov = tinyCoverage();
  FakeWorker.reset();
  FakeWorker.handler = defaultWorker({ home: homeFrom(cov.rows, cov.board) });

  let postCount = 0;
  const env = standardEnv({
    storage,
    coverage: cov,
    extraRules: [
      {
        test: API_URL,
        method: 'POST',
        oncall: () => { postCount++; },
        body: JSON.stringify({ ok: true }),
      },
      {
        test: API_URL,
        method: 'GET',
        body: JSON.stringify(apiPayload),
      },
    ],
  });

  const res = await env.sb.LiveData.load(tinySnapshot(), { force: true, apiUrl: API_URL });
  assert.equal(res.state, 'live');
  assert.ok(env.fetch.calls.includes(OC_INDEX), 'OpenCode scraped during force refresh');
  assert.equal(postCount, 1, 'POST made to API on force refresh');
});

test('corrupt API response degrades gracefully to full scrape', async () => {
  const storage = makeStorage();
  const cov = tinyCoverage();
  FakeWorker.reset();
  FakeWorker.handler = defaultWorker({ home: homeFrom(cov.rows, cov.board) });

  const env = standardEnv({
    storage,
    coverage: cov,
    extraRules: [
      { test: API_URL, body: '{"t": 123, "live": "corrupted"}' }, // Invalid format
    ],
  });

  const res = await env.sb.LiveData.load(tinySnapshot(), { apiUrl: API_URL });
  assert.equal(res.state, 'live');
  assert.ok(env.fetch.calls.includes(OC_INDEX), 'Scraper executed when API payload was invalid');
});
