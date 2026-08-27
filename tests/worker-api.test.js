import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { validatePayload, resetMemoryStore, CORS_HEADERS } from '../worker/index.js';

function validPayload() {
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
      ocPages: {
        'mimo-v2.5': { name: 'MiMo-V2.5', cost: { output: 0.28, input: 0.14 } },
      },
      aaIndex: [
        ['kimi-k3', { slug: 'kimi-k3', shortName: 'Kimi K3', intelligenceIndex: 59.7, effort: null, isOpenWeights: true }],
        ['mimo-v2-5-0424', { slug: 'mimo-v2-5-0424', shortName: 'MiMo-V2.5', intelligenceIndex: 38.04, effort: null, isOpenWeights: true }],
      ],
      aaPages: {},
    },
  };
}

test('OPTIONS request returns 204 with full CORS headers', async () => {
  const req = new Request('https://api.test/', { method: 'OPTIONS' });
  const res = await worker.fetch(req, {});
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  assert.ok(res.headers.get('Access-Control-Allow-Methods').includes('POST'));
});

test('GET on empty store returns 404 with CORS header', async () => {
  resetMemoryStore();
  const req = new Request('https://api.test/', { method: 'GET' });
  const res = await worker.fetch(req, {});
  assert.equal(res.status, 404);
  const json = await res.json();
  assert.equal(json.error, 'No data stored yet');
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
});

test('POST with valid payload updates the store and returns 200 with timestamp', async () => {
  resetMemoryStore();
  const payload = validPayload();
  const req = new Request('https://api.test/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const res = await worker.fetch(req, {});
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(json.t, payload.t);

  // Subsequent GET returns the exact stored payload
  const getReq = new Request('https://api.test/', { method: 'GET' });
  const getRes = await worker.fetch(getReq, {});
  assert.equal(getRes.status, 200);
  const getJson = await getRes.json();
  assert.deepEqual(getJson, payload);
  assert.equal(getRes.headers.get('Access-Control-Allow-Origin'), '*');
});

test('POST with malformed JSON body returns 400', async () => {
  const req = new Request('https://api.test/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not:json',
  });
  const res = await worker.fetch(req, {});
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.equal(json.ok, false);
  assert.match(json.error, /Malformed JSON/);
});

// ---------- Validation Tests ----------

test('validatePayload rejects non-object or null payloads', () => {
  assert.equal(validatePayload(null).valid, false);
  assert.equal(validatePayload('string').valid, false);
  assert.equal(validatePayload(123).valid, false);
});

test('validatePayload rejects invalid or missing timestamp', () => {
  const p = validPayload();
  p.t = -5;
  assert.equal(validatePayload(p).valid, false);
  p.t = 'invalid';
  assert.equal(validatePayload(p).valid, false);
  p.t = NaN;
  assert.equal(validatePayload(p).valid, false);
});

test('validatePayload rejects missing or empty leaderboard', () => {
  const p1 = validPayload();
  delete p1.live.leaderboard;
  assert.equal(validatePayload(p1).valid, false);

  const p2 = validPayload();
  p2.live.leaderboard = [];
  assert.equal(validatePayload(p2).valid, false);
});

test('validatePayload rejects invalid leaderboard rows', () => {
  const p = validPayload();
  p.live.leaderboard[0].model = '';
  assert.equal(validatePayload(p).valid, false);

  const p2 = validPayload();
  p2.live.leaderboard[0].rank = -1;
  assert.equal(validatePayload(p2).valid, false);

  const p3 = validPayload();
  delete p3.live.leaderboard[0].author;
  assert.equal(validatePayload(p3).valid, false);
});

test('validatePayload rejects invalid tokenCost array or rows', () => {
  const p1 = validPayload();
  p1.live.tokenCost = 'not-an-array';
  assert.equal(validatePayload(p1).valid, false);

  const p2 = validPayload();
  p2.live.tokenCost = [{ model: 'kimi-k3', output: -1, total: -1 }];
  assert.equal(validatePayload(p2).valid, false);
});

test('validatePayload rejects invalid aaIndex array or entries', () => {
  const p1 = validPayload();
  p1.live.aaIndex = 'not-an-array';
  assert.equal(validatePayload(p1).valid, false);

  const p2 = validPayload();
  p2.live.aaIndex = [['kimi-k3', { slug: 'kimi-k3', intelligenceIndex: 'high' }]];
  assert.equal(validatePayload(p2).valid, false);

  const p3 = validPayload();
  p3.live.aaIndex = [['kimi-k3', { slug: 'kimi-k3', intelligenceIndex: -5 }]];
  assert.equal(validatePayload(p3).valid, false);
});

test('KV binding integration works when env.DATA_KV is supplied', async () => {
  let kvStore = null;
  const env = {
    DATA_KV: {
      get: async (key) => (key === 'latest' ? kvStore : null),
      put: async (key, val) => { if (key === 'latest') kvStore = val; },
    },
  };

  const payload = validPayload();
  const postReq = new Request('https://api.test/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const postRes = await worker.fetch(postReq, env);
  assert.equal(postRes.status, 200);
  assert.ok(kvStore !== null);

  const getReq = new Request('https://api.test/', { method: 'GET' });
  const getRes = await worker.fetch(getReq, env);
  assert.equal(getRes.status, 200);
  assert.deepEqual(await getRes.json(), payload);
});
