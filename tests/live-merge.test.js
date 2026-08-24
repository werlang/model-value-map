import test from 'node:test';
import assert from 'node:assert/strict';
import { standardEnv, OC_INDEX } from './helpers/setup-live.js';
import {
  tinySnapshot, tinyCoverage, snapshot as fullSnapshot,
  aaModel, modelRow, boardRow, ocModelPageHtml,
} from './helpers/fixtures.js';

const byId = (models, id) => models.find((m) => m.id === id);

async function run(over = {}) {
  const env = standardEnv(over);
  const res = await env.sb.LiveData.load(over.models ?? tinySnapshot(), over.opts);
  return { ...env, res };
}

// ---------- cost precedence: board > per-model page > snapshot ----------

test('a board row wins and carries input/output/cached through', async () => {
  const cov = tinyCoverage();
  const { res } = await run({ coverage: cov });
  const kimi = byId(res.models, 'kimi-k3');
  assert.equal(kimi.ocCostPerM, 15);
  assert.equal(kimi.ocCost.input, 3);
  assert.equal(kimi.ocCost.output, 15);
  assert.equal(kimi.ocCost.cached, 0.3);
});

test('per-model page cost is used when the board omits the model', async () => {
  const cov = tinyCoverage();
  cov.board = [boardRow({ model: 'mimo-v2.5', total: 0.28 })]; // kimi missing
  const { res } = await run({
    coverage: cov,
    ocPages: {
      'kimi-k3': {
        name: 'Kimi K3', reasoning: true, openWeights: true,
        limit: { context: 262144 },
        cost: { input: 2.5, output: 12, cacheRead: 0.25 },
      },
    },
  });
  const kimi = byId(res.models, 'kimi-k3');
  assert.equal(kimi.ocCostPerM, 12); // page.cost.output is the headline rate
  assert.equal(kimi.ocCost.input, 2.5);
  assert.equal(kimi.ocCost.output, 12);
  assert.equal(kimi.ocCost.cached, 0.25); // cacheRead maps to cached
});

test('an invalid page cost falls back to the snapshot price', async () => {
  const cov = tinyCoverage();
  cov.board = [];
  const { res } = await run({
    coverage: cov,
    ocPages: { 'kimi-k3': { name: 'X', cost: { output: -1 } } },
  });
  assert.equal(byId(res.models, 'kimi-k3').ocCostPerM, 15);
  assert.ok(res.snapFallbacks >= 2); // both models fell back on cost
});

test('snapshot cost is the last resort for live rows', async () => {
  const cov = tinyCoverage();
  cov.board = [];
  const { res } = await run({ coverage: cov });
  assert.equal(byId(res.models, 'kimi-k3').ocCostPerM, 15);
});

// ---------- labels / metadata ----------

test('label precedence: page name > snapshot label > derived-from-id', async () => {
  const cov = tinyCoverage();
  cov.board = [];
  const { res } = await run({
    coverage: cov,
    ocPages: { 'kimi-k3': { name: 'Kimi K3 Turbo', cost: { output: 9 }, limit: {}, } },
  });
  assert.equal(byId(res.models, 'kimi-k3').label, 'Kimi K3 Turbo');
  assert.equal(byId(res.models, 'mimo-v2.5').label, 'MiMo-V2.5'); // snapshot label survives
});

test('a brand-new live id gets a derived Title-Case label', async () => {
  const cov = tinyCoverage();
  cov.rows.push(modelRow({ model: 'grok-9', provider: 'xai', author: 'xAI', rank: 3, tokens: 500 }));
  cov.board.push(boardRow({ model: 'grok-9', total: 2.5, output: 2.5, input: 0.5 }));
  cov.aaRecords.push(aaModel({ slug: 'grok-9', shortName: 'Grok 9', intelligenceIndex: 55 }));
  const { res } = await run({ coverage: cov });
  const grok = byId(res.models, 'grok-9');
  assert.equal(grok.label, 'Grok 9');
  assert.equal(grok.plot, true);
  assert.equal(grok.rank, 3);
});

test('negative or non-numeric weekly tokens clamp to 0', async () => {
  const cov = tinyCoverage();
  cov.rows[0].tokens = -50;
  cov.rows[1].tokens = 'lots';
  const { res } = await run({ coverage: cov });
  assert.equal(byId(res.models, 'kimi-k3').weeklyTokensT, 0);
  assert.equal(byId(res.models, 'mimo-v2.5').weeklyTokensT, 0);
});

test('positive tokens are scaled to T with 2-decimal rounding', async () => {
  const cov = tinyCoverage();
  cov.rows[0].tokens = 1234;
  const { res } = await run({ coverage: cov });
  assert.equal(byId(res.models, 'kimi-k3').weeklyTokensT, 1.23);
});

test('hue comes from the snapshot when known, else a deterministic hash pick', async () => {
  const cov = tinyCoverage();
  cov.rows.push(modelRow({ model: 'grok-9', provider: 'xai', author: 'xAI', rank: 3, tokens: 10 }));
  cov.board.push(boardRow({ model: 'grok-9' }));
  cov.aaRecords.push(aaModel({ slug: 'grok-9', shortName: 'Grok 9' }));

  const FALLBACK_HUES = ['#3B5BDB', '#D9480F', '#0CA678', '#9C36B5', '#0C8599', '#C2255C', '#6741D9', '#E8890C', '#2F9E44'];
  let h = 0;
  for (let i = 0; i < 'xAI'.length; i++) h = (h * 31 + 'xAI'.charCodeAt(i)) >>> 0;
  const expected = FALLBACK_HUES[h % FALLBACK_HUES.length];

  const { res } = await run({ coverage: cov });
  assert.equal(byId(res.models, 'kimi-k3').hue, '#9C36B5'); // snapshot hue kept
  assert.equal(byId(res.models, 'grok-9').hue, expected);   // hash pick matches the documented algorithm
});

// ---------- AA matching tiers ----------

test('curated slug beats a coinciding normalized slug', async () => {
  const cov = tinyCoverage();
  cov.aaRecords = [
    aaModel({ slug: 'mimo-v2-5-0424', shortName: 'MiMo-V2.5 curated', intelligenceIndex: 41 }),
    aaModel({ slug: 'mimo-v2-5', shortName: 'MiMo normalized decoy', intelligenceIndex: 22 }),
    aaModel({ slug: 'kimi-k3' }),
  ];
  const { res } = await run({ coverage: cov });
  const mimo = byId(res.models, 'mimo-v2.5');
  assert.equal(mimo.aa.intelligenceIndex, 41);
  assert.equal(mimo.aa.url, 'https://artificialanalysis.ai/models/mimo-v2-5-0424');
});

test('a dotted id matches by dots-to-dashes normalization alone', async () => {
  const cov = tinyCoverage();
  cov.aaRecords = [
    aaModel({ slug: 'kimi-k3' }),
    aaModel({ slug: 'mimo-v2-5', shortName: 'MiMo via normalization', intelligenceIndex: 39.5 }),
  ];
  const { res } = await run({ coverage: cov });
  const mimo = byId(res.models, 'mimo-v2.5');
  assert.equal(mimo.aa.intelligenceIndex, 39.5);
  assert.equal(mimo.aa.url, 'https://artificialanalysis.ai/models/mimo-v2-5');
});

test('near-miss slugs never match — no fuzzy pairing is invented', async () => {
  const cov = tinyCoverage();
  cov.aaRecords = [aaModel({ slug: 'kimi-k3' }), aaModel({ slug: 'mimo-v2-5-pro', shortName: 'Different model!' })];
  const env = standardEnv({
    coverage: cov,
    aaPageRules: [{ test: /^https:\/\/artificialanalysis\.ai\/models\/.+/, status: 404 }],
  });
  const res = await env.sb.LiveData.load(tinySnapshot());
  const mimo = byId(res.models, 'mimo-v2.5');
  assert.equal(mimo.aa.intelligenceIndex, 38.04, 'snapshot score survives');
  // candidates requested were exactly curated then normalized — nothing fuzzy
  const pageUrls = [...env.fetch.calls]
    .filter((u) => u.startsWith('https://artificialanalysis.ai/models/'))
    .map((u) => u.split('/models/')[1])
    .filter((slug) => slug.includes('mimo'));
  assert.deepEqual([...pageUrls], ['mimo-v2-5-0424', 'mimo-v2-5']);
});

// ---------- page metadata propagation ----------

test('context window comes from the page when valid, else snapshot, else null', async () => {
  const cov = tinyCoverage();
  cov.board = [];
  const { res } = await run({
    coverage: cov,
    ocPages: { 'kimi-k3': { name: 'K', cost: { output: 9 }, limit: { context: 262144 } } },
  });
  assert.equal(byId(res.models, 'kimi-k3').contextWindowTokens, 262144);
  const { res: res2 } = await run({
    coverage: cov,
    ocPages: { 'kimi-k3': { name: 'K', cost: { output: 9 }, limit: { context: 'big' } } },
  });
  assert.equal(byId(res2.models, 'kimi-k3').contextWindowTokens, 1048576); // snapshot
});

test('reasoning/openWeights follow the page booleans; without a page they keep snapshot values', async () => {
  const cov = tinyCoverage();
  cov.board = [];
  const { res } = await run({
    coverage: cov,
    ocPages: {
      'kimi-k3': { name: 'K', cost: { output: 9 }, reasoning: false, openWeights: false },
    },
  });
  const kimi = byId(res.models, 'kimi-k3');
  assert.equal(kimi.reasoning, false);
  assert.equal(kimi.openWeights, false);
  assert.equal(byId(res.models, 'mimo-v2.5').reasoning, true); // untouched snapshot row
});

// ---------- honest exclusion ----------

test('a missing AA score excludes a model from plotting with the right reason', async () => {
  // snapshot variant of mimo that has never been scored
  const models = tinySnapshot().map((m) => (
    m.id === 'mimo-v2.5' ? { ...m, aa: null, plot: false, excludeReason: 'Not scored on the Artificial Analysis Intelligence Index yet.' } : m
  ));
  const cov = tinyCoverage();
  cov.aaRecords = [aaModel({ slug: 'kimi-k3' })]; // mimo unscored live too
  const { res } = await run({ models, coverage: cov });
  const mimo = byId(res.models, 'mimo-v2.5');
  assert.equal(mimo.plot, false);
  assert.equal(mimo.ocCostPerM, 0.28, 'cost is known — only the score is missing');
  assert.equal(mimo.excludeReason, 'Not scored on the Artificial Analysis Intelligence Index yet.');
});

test('missing cost and score together produce the combined exclusion reason', async () => {
  const models = tinySnapshot().map((m) => (
    m.id === 'kimi-k3'
      ? { ...m, ocCostPerM: null, ocCost: null, aa: null, plot: false,
          excludeReason: 'No token cost published on OpenCode; not scored by Artificial Analysis either.' }
      : m
  ));
  const cov = tinyCoverage();
  cov.board = [];
  cov.aaRecords = [aaModel({ slug: 'mimo-v2-5-0424', intelligenceIndex: 38.04 })];
  const { res } = await run({
    models,
    coverage: cov,
    aaPageRules: [{ test: /^https:\/\/artificialanalysis\.ai\/models\/.+/, status: 404 }],
  });
  const kimi = byId(res.models, 'kimi-k3');
  assert.equal(kimi.plot, false);
  assert.match(kimi.excludeReason, /No token cost published/);
  assert.match(kimi.excludeReason, /not scored by Artificial Analysis either/);
});

test('a free model (zero output rate) stays visible but off the log-cost chart', async () => {
  const cov = tinyCoverage();
  cov.board[0] = boardRow({ model: 'kimi-k3', total: 0, output: 0, input: 0, cached: 0 });
  const { res } = await run({ coverage: cov });
  const kimi = byId(res.models, 'kimi-k3');
  assert.equal(kimi.ocCostPerM, 0, 'the data itself is preserved honestly');
  assert.equal(kimi.aa.intelligenceIndex, 59.7);
  assert.equal(kimi.plot, false);
  assert.equal(kimi.excludeReason, 'Free model (zero output rate) — cannot sit on a log-cost axis.');
});

// ---------- dataset integrity across loads ----------

test('a model dropped from the live leaderboard stays visible from the snapshot', async () => {
  const cov = tinyCoverage();
  cov.rows = [cov.rows[0]]; // OpenCode "dropped" mimo-v2.5
  const { res } = await run({ coverage: cov });
  const mimo = byId(res.models, 'mimo-v2.5');
  assert.ok(mimo, 'not silently vanished');
  assert.equal(mimo.ocCostPerM, 0.28); // snapshot axes intact
  assert.equal(mimo.aa.intelligenceIndex, 38.04);
  assert.equal(mimo.label, 'MiMo-V2.5'); // full original record re-appended
});

test('fallback accounting: exact counts drive the partial/live boundary', async () => {
  // kimi fully live; mimo keeps snapshot cost only → exactly 1 fallback
  const cov = tinyCoverage();
  cov.board = [boardRow()]; // mimo loses board row; no page → snapshot cost
  const { res } = await run({
    coverage: cov,
    aaPageRules: [{ test: /^https:\/\/artificialanalysis\.ai\/models\/.+/, status: 404 }],
  });
  assert.equal(res.snapFallbacks, 1);
  assert.equal(res.state, 'partial');

  // everything live → zero fallbacks
  const full = standardEnv({});
  const resLive = await full.sb.LiveData.load(tinySnapshot());
  assert.equal(resLive.state, 'live');
  assert.equal(resLive.snapFallbacks, 0);
});

test('ocUpdatedAt surfaces the leaderboard timestamp for the stamp clock', async () => {
  const { res } = await run({ updatedAt: '2026-08-24T09:30:00Z' });
  assert.equal(res.ocUpdatedAt, '2026-08-24T09:30:00Z');
});

test('an empty live leaderboard still yields the full snapshot roster', async () => {
  const cov = tinyCoverage();
  cov.rows = [];
  const { res } = await run({ coverage: cov });
  assert.deepEqual(
    [...res.models].map((m) => m.id).sort(),
    ['kimi-k3', 'mimo-v2.5'],
  );
  assert.equal(res.snapFallbacks, 2);
});


