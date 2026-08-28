import test from 'node:test';
import assert from 'node:assert/strict';
import { standardEnv, MODELS_DEV, AA_INDEX } from './helpers/setup-live.js';
import {
  tinySnapshot, tinyCoverage, aaModel, aaPageHtml, modelsDevCatalog,
} from './helpers/fixtures.js';

async function run(over = {}) {
  const env = standardEnv(over);
  const res = await env.sb.LiveData.load(over.models ?? tinySnapshot(), over.opts);
  return { ...env, res };
}

// ---------- worker fetching ----------

test('requests are sent to the sanitized worker', async () => {
  const { fetch, res } = await run();
  assert.ok(res);
  assert.equal(res.state, 'live');
  assert.ok(fetch.calls.some((u) => u.includes('model-value-map-api')), 'worker requested');
});

test('worker payload is used directly (no per-model fallback needed)', async () => {
  const cov = tinyCoverage();
  cov.aaRecords = [aaModel({ slug: 'kimi-k3' }), aaModel({ slug: 'mimo-v2-5-0424', intelligenceIndex: 39.5 })];
  const { res } = await run({ coverage: cov });
  assert.equal(res.state, 'live');
  const mimo = res.models.find((m) => m.id === 'mimo-v2.5');
  assert.equal(mimo.aa.intelligenceIndex, 39.5);
});

test('worker unreachable returns null when no cache exists', async () => {
  const { res } = await run({ workerFail: true });
  assert.equal(res, null);
});
