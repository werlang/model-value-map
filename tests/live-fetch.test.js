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

// ---------- direct fetching ----------

test('requests are sent directly to models.dev and artificialanalysis.ai', async () => {
  const { fetch, res } = await run();
  assert.ok(res);
  assert.equal(res.state, 'live');
  assert.ok(fetch.calls.includes(MODELS_DEV), 'models.dev requested directly');
  assert.ok(fetch.calls.includes(AA_INDEX), 'artificialanalysis.ai requested directly');
});

test('parallel fetch: both endpoints are hit in the same load', async () => {
  const { fetch, res } = await run();
  assert.equal(res.state, 'live');
  const mdIdx = fetch.calls.indexOf(MODELS_DEV);
  const aaIdx = fetch.calls.indexOf(AA_INDEX);
  assert.ok(mdIdx >= 0 && aaIdx >= 0);
});

test('a missing AA index model fetches per-model page if needed', async () => {
  const cov = tinyCoverage();
  cov.aaRecords = [aaModel({ slug: 'kimi-k3' })]; // mimo missing from index

  const { fetch, res } = await run({
    coverage: cov,
    aaPageRules: [
      { test: /models\/mimo-v2-5-0424$/, body: aaPageHtml(aaModel({ slug: 'mimo-v2-5-0424', intelligenceIndex: 39.5 })) },
    ],
  });

  assert.equal(res.state, 'live');
  assert.ok(fetch.calls.some((u) => u.includes('mimo-v2-5-0424')));
  const mimo = res.models.find((m) => m.id === 'mimo-v2.5');
  assert.equal(mimo.aa.intelligenceIndex, 39.5);
});

test('both origins unreachable returns null when no cache exists', async () => {
  const { res } = await run({
    modelsDevRule: { test: MODELS_DEV, fail: true },
    aaIndexRule: { test: AA_INDEX, fail: true },
  });
  assert.equal(res, null);
});
