import test from 'node:test';
import assert from 'node:assert/strict';
import { standardEnv, MODELS_DEV, AA_INDEX } from './helpers/setup-live.js';
import {
  tinySnapshot, tinyCoverage,
  aaModel, aaPageHtml, modelsDevCatalog,
} from './helpers/fixtures.js';

const byId = (models, id) => models.find((m) => m.id === id);

async function run(over = {}) {
  const env = standardEnv(over);
  const res = await env.sb.LiveData.load(over.models ?? tinySnapshot(), over.opts);
  return { ...env, res };
}

// ---------- models.dev pricing & limits ----------

test('models.dev pricing carries input/output/cached and limits through', async () => {
  const { res } = await run();
  const kimi = byId(res.models, 'kimi-k3');
  assert.equal(kimi.ocCostPerM, 15);
  assert.equal(kimi.ocCost.input, 3);
  assert.equal(kimi.ocCost.output, 15);
  assert.equal(kimi.ocCost.cacheRead, 0.3);
  assert.equal(kimi.contextWindowTokens, 1048576);
  assert.equal(kimi.reasoning, true);
  assert.equal(kimi.openWeights, true);
});

test('first-party provider rate is prioritized over third-party duplicates', async () => {
  const { res } = await run({
    modelsDev: {
      thirdparty: {
        name: 'ThirdParty Host',
        models: {
          'kimi-k3': { name: 'Kimi K3 (Expensive)', cost: { output: 99 } },
        },
      },
      moonshot: {
        name: 'Moonshot',
        models: {
          'kimi-k3': { name: 'Kimi K3', cost: { input: 3, output: 15, cache_read: 0.3 }, limit: { context: 1048576 } },
        },
      },
    },
  });
  const kimi = byId(res.models, 'kimi-k3');
  assert.equal(kimi.ocCostPerM, 15);
  assert.equal(kimi.author, 'Moonshot');
});

// ---------- AA matching tiers ----------

test('curated slug matches the exact AA flight entry', async () => {
  const cov = tinyCoverage();
  cov.aaRecords = [
    aaModel({ slug: 'mimo-v2-5-0424', shortName: 'MiMo-V2.5 curated', intelligenceIndex: 41 }),
    aaModel({ slug: 'kimi-k3' }),
  ];
  const { res } = await run({ coverage: cov });
  const mimo = byId(res.models, 'mimo-v2.5');
  assert.equal(mimo.aa.intelligenceIndex, 41);
});

test('a dotted id matches by dots-to-dashes normalization', async () => {
  const cov = tinyCoverage();
  cov.aaRecords = [
    aaModel({ slug: 'kimi-k3' }),
    aaModel({ slug: 'mimo-v2-5', shortName: 'MiMo via normalization', intelligenceIndex: 39.5 }),
  ];
  const { res } = await run({ coverage: cov });
  const mimo = byId(res.models, 'mimo-v2-5') || byId(res.models, 'mimo-v2.5');
  assert.ok(mimo);
  assert.equal(mimo.intelligenceIndex, 39.5);
});

// ---------- honest exclusion ----------

test('a missing AA score marks the model as excluded with reason', async () => {
  const { res } = await run({
    aaIndexRule: { test: AA_INDEX, body: '' },
    aaPageRules: [{ test: /^https:\/\/artificialanalysis\.ai\/models\/.+/, status: 404 }],
    models: [{ id: 'unscored-model', label: 'Unscored Model', author: 'TestLab', ocCostPerM: 5, aa: null, plot: false }],
  });
  const unscored = byId(res.models, 'unscored-model');
  assert.ok(unscored);
  assert.equal(unscored.plot, false);
  assert.equal(unscored.excludeReason, 'Missing intelligence score');
});

test('missing cost marks the model as excluded with reason', async () => {
  const cov = tinyCoverage();
  cov.aaRecords.push(aaModel({ slug: 'free-eval', shortName: 'Free Eval', intelligenceIndex: 60 }));
  const { res } = await run({
    coverage: cov,
  });
  const model = byId(res.models, 'free-eval');
  assert.ok(model);
  assert.equal(model.plot, false);
  assert.equal(model.excludeReason, 'Missing pricing');
});

test('all plotted models have positive cost and positive intelligence', async () => {
  const { res } = await run();
  for (const m of res.models) {
    if (m.plot) {
      assert.ok(m.ocCostPerM > 0);
      assert.ok(m.aa && m.aa.intelligenceIndex > 0);
    }
  }
});


