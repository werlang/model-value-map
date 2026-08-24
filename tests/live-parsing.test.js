import test from 'node:test';
import assert from 'node:assert/strict';
import { standardEnv } from './helpers/setup-live.js';
import {
  aaModel, aaIndexHtml, flightPush, uuid,
  tinySnapshot, tinyCoverage, homeFrom, defaultWorker,
  modelRow, boardRow, ocHomeHtml,
} from './helpers/fixtures.js';
import { FakeWorker } from './helpers/fake-worker.js';

const byId = (models, id) => models.find((m) => m.id === id);

/** Run a load() with the standard env; `over` customizes routes/worker/fixtures. */
async function run(over = {}) {
  const env = standardEnv(over);
  const res = await env.sb.LiveData.load(over.models ?? tinySnapshot());
  return { ...env, res };
}

// ---------- flight extraction & record validation ----------

test('flight records on the AA index are extracted into live AA entries', async () => {
  const { res } = await run();
  assert.equal(res.state, 'live');
  const kimi = byId(res.models, 'kimi-k3');
  assert.equal(kimi.aa.intelligenceIndex, 59.7);
  assert.equal(kimi.aa.url, 'https://artificialanalysis.ai/models/kimi-k3');
});

test('intelligence index is rounded to two decimals', async () => {
  const cov = tinyCoverage();
  cov.aaRecords = [aaModel({ slug: 'kimi-k3', intelligenceIndex: 59.768 })];
  const { res } = await run({ coverage: cov });
  assert.equal(byId(res.models, 'kimi-k3').aa.intelligenceIndex, 59.77);
});

test('effort.label is lifted to the effort field; absent effort stays null', async () => {
  const cov = tinyCoverage();
  cov.aaRecords = [
    aaModel({ slug: 'kimi-k3', effort: { label: 'max' } }),
    aaModel({ slug: 'mimo-v2-5-0424', effort: null }),
  ];
  const { res } = await run({ coverage: cov });
  assert.equal(byId(res.models, 'kimi-k3').aa.effort, 'max');
  assert.equal(byId(res.models, 'mimo-v2.5').aa.effort, null);
});

test('isOpenWeights is coerced to a real boolean', async () => {
  const cov = tinyCoverage();
  cov.aaRecords = [aaModel({ slug: 'kimi-k3', isOpenWeights: 'truthy-string' })];
  const { res } = await run({ coverage: cov });
  assert.equal(byId(res.models, 'kimi-k3').aa.isOpenWeights, true);
});

test('a negative intelligence index is rejected — snapshot score survives', async () => {
  const cov = tinyCoverage();
  cov.aaRecords = [aaModel({ slug: 'kimi-k3', intelligenceIndex: -1 })];
  const { res } = await run({ coverage: cov });
  const kimi = byId(res.models, 'kimi-k3');
  assert.equal(kimi.aa.intelligenceIndex, 59.7); // snapshot value
  assert.equal(res.state, 'partial');
  assert.ok(res.snapFallbacks >= 1);
});

test('a non-numeric intelligence index is rejected', async () => {
  const cov = tinyCoverage();
  cov.aaRecords = [aaModel({ slug: 'kimi-k3', intelligenceIndex: '59.7' })];
  const { res } = await run({ coverage: cov });
  assert.equal(byId(res.models, 'kimi-k3').aa.intelligenceIndex, 59.7);
});

test('a record missing shortName is rejected (slug alone is not trusted)', async () => {
  const cov = tinyCoverage();
  const rec = aaModel({ slug: 'kimi-k3' });
  delete rec.shortName;
  cov.aaRecords = [rec];
  const { res } = await run({ coverage: cov });
  assert.equal(byId(res.models, 'kimi-k3').aa.intelligenceIndex, 59.7);
});

test('duplicate slugs resolve to the first occurrence', async () => {
  const cov = tinyCoverage();
  cov.aaRecords = [
    aaModel({ slug: 'kimi-k3', intelligenceIndex: 60.5 }),
    aaModel({ slug: 'kimi-k3', intelligenceIndex: 40 }),
  ];
  const { res } = await run({ coverage: cov });
  assert.equal(byId(res.models, 'kimi-k3').aa.intelligenceIndex, 60.5);
});

test('braces and quotes inside string values do not break brace matching', async () => {
  const cov = tinyCoverage();
  cov.aaRecords = [aaModel({
    slug: 'kimi-k3',
    shortName: 'Kimi "K3" {beta}',
    description: 'nested {braces} and [brackets] inside a string',
    meta: { nested: { deep: '}{ [' } },
  })];
  const { res } = await run({ coverage: cov });
  const kimi = byId(res.models, 'kimi-k3');
  assert.equal(kimi.aa.name, 'Kimi "K3" {beta}');
  assert.equal(kimi.aa.intelligenceIndex, 59.7);
});

test('escaped backslash-quote sequences survive JSON round-trip', async () => {
  const cov = tinyCoverage();
  cov.aaRecords = [aaModel({ slug: 'kimi-k3', shortName: 'back\\\\"slash' })];
  const { res } = await run({ coverage: cov });
  assert.match(byId(res.models, 'kimi-k3').aa.name, /back.*slash/);
});

test('a malformed record push is skipped without killing sibling records', async () => {
  const cov = tinyCoverage();
  const good = flightPush(aaModel({ slug: 'kimi-k3' }));
  // valid JS string, invalid JSON (unquoted key) → extractFlight skips it
  const invalidJsonPush = 'self.__next_f.push([1,"{slug:\\"nope\\"}"])';
  const html = aaIndexHtml([aaModel({ slug: 'mimo-v2-5-0424', intelligenceIndex: 38.04 })], { extra: '\n' + good + '\n' + invalidJsonPush });
  const { res } = await run({
    coverage: cov,
    aaIndexRule: { test: /^https:\/\/artificialanalysis\.ai\/models$/, body: html },
  });
  assert.equal(byId(res.models, 'kimi-k3').aa.intelligenceIndex, 59.7);
  assert.equal(byId(res.models, 'mimo-v2.5').aa.intelligenceIndex, 38.04);
});

test('a record truncated mid-object (no matching brace) is skipped, siblings parsed', async () => {
  const cov = tinyCoverage();
  // valid JSON string whose object never closes → matchBrace returns -1 → skipped
  const unclosed = flightPush({ id: uuid(), slug: 'half-record', shortName: 'Half' }).replace('}}]', '}');
  const html = aaIndexHtml([aaModel({ slug: 'kimi-k3' })], { extra: '\n' + unclosed });
  const { res } = await run({
    coverage: cov,
    aaIndexRule: { test: /^https:\/\/artificialanalysis\.ai\/models$/, body: html },
  });
  assert.equal(byId(res.models, 'kimi-k3').aa.intelligenceIndex, 59.7);
});

test('a record with an unterminated nested object never closes (brace scan bail-out)', async () => {
  const cov = tinyCoverage();
  // payload opens nested objects that never close → matchBrace hits its scan
  // limit and returns -1 → the record is skipped, siblings still parsed
  const flightText = '{"id":"' + uuid() + '","slug":"abyss","meta":{"deep":{"deeper":1';
  const raw = 'self.__next_f.push([1,' + JSON.stringify(flightText) + '])';
  const html = aaIndexHtml([aaModel({ slug: 'kimi-k3' })], { extra: '\n' + flightPush(aaModel({ slug: 'mimo-v2-5-0424', intelligenceIndex: 38.04 })) + '\n' + raw });
  const { res } = await run({
    coverage: cov,
    aaIndexRule: { test: /^https:\/\/artificialanalysis\.ai\/models$/, body: html },
  });
  assert.equal(byId(res.models, 'kimi-k3').aa.intelligenceIndex, 59.7);
  assert.equal(byId(res.models, 'mimo-v2.5').aa.intelligenceIndex, 38.04); // sibling unaffected
});

test('records without the 36-char lowercase id marker are ignored', async () => {
  const cov = tinyCoverage();
  const noId = flightPush({ slug: 'decoy-a', shortName: 'Decoy', intelligenceIndex: 99 });
  const upperId = aaModel({ slug: 'decoy-b' });
  upperId.id = upperId.id.toUpperCase();
  const html = aaIndexHtml([aaModel({ slug: 'kimi-k3' })], {
    extra: '\n' + noId + '\n' + flightPush(upperId) +
      '\nself.__next_f.push([1,"<img src=x onerror=alert(1)>"])',
  });
  const { res } = await run({
    coverage: cov,
    aaIndexRule: { test: /^https:\/\/artificialanalysis\.ai\/models$/, body: html },
  });
  assert.equal(byId(res.models, 'kimi-k3').aa.intelligenceIndex, 59.7);
});

test('hostile script content in the AA payload never executes (inert text)', async () => {
  const canary = 'sb-canary-must-stay-undefined';
  const cov = tinyCoverage();
  const hostile = 'self.__next_f.push([1,' + JSON.stringify(JSON.stringify(
    'x"));globalThis["' + canary + '"]=1;("'
  )) + '])';
  const html = '<script>window.__shouldNeverRun = true</script>' +
    aaIndexHtml([aaModel({ slug: 'kimi-k3' })], { extra: '\n' + hostile });
  const env = standardEnv({
    coverage: cov,
    aaIndexRule: { test: /^https:\/\/artificialanalysis\.ai\/models$/, body: html },
  });
  await env.sb.LiveData.load(tinySnapshot());
  assert.equal(env.sb.box.window.__shouldNeverRun, undefined);
  assert.equal(env.sb.box[canary], undefined);
});

// ---------- canonical OC page links (harvestOcLinks / ocUrlFor) ----------

test('a harvested matching link is requested verbatim from the HTML', async () => {
  const cov = tinyCoverage();
  cov.board = [boardRow({ model: 'mimo-v2.5' })]; // kimi-k3 loses its board row → per-model page fetch
  const { fetch, res } = await run({
    coverage: cov,
    links: { 'moonshot/kimi-k3': '/data/moonshot/kimi-k3' },
  });
  assert.ok(fetch.calls.includes('https://opencode.ai/data/moonshot/kimi-k3'));
  assert.equal(res.state, 'partial'); // page had no parseable info → snapshot cost fallback
});

test('without a link the constructed provider/model URL is used (dots dashed)', async () => {
  const cov = tinyCoverage();
  cov.board = [];
  const { fetch } = await run({ coverage: cov });
  assert.ok(fetch.calls.includes('https://opencode.ai/data/moonshot/kimi-k3'));
  assert.ok(fetch.calls.includes('https://opencode.ai/data/xiaomi/mimo-v2-5'));
});

test('_build/ and compare/ links are never harvested as model pages', async () => {
  const cov = tinyCoverage();
  cov.board = [boardRow({ model: 'mimo-v2.5' })];
  const html = ocHomeHtml({
    rows: [],
    links: {},
  }) + '<a href="/data/_build/x/kimi-k3">b</a><a href="/data/compare/y/kimi-k3">c</a>';
  const { fetch } = await run({
    coverage: cov,
    ocIndexRule: { test: /^https:\/\/opencode\.ai\/data$/, body: html },
  });
  assert.ok(!fetch.calls.some((u) => u.includes('_build') || u.includes('compare')));
  assert.ok(fetch.calls.includes('https://opencode.ai/data/moonshot/kimi-k3')); // constructed fallback
});

test('leaderboard rows without a string model are dropped before merge', async () => {
  const cov = tinyCoverage();
  cov.rows = [
    ...cov.rows,
    null,
    { author: 'Ghost', rank: 99 },            // no model
    { model: 42, author: 'Numeric', rank: 98 }, // non-string model
  ];
  const { res } = await run({ coverage: cov });
  assert.equal(res.models.length, 2);
  assert.ok(byId(res.models, 'kimi-k3'));
  assert.ok(byId(res.models, 'mimo-v2.5'));
});

