import test from 'node:test';
import assert from 'node:assert/strict';
import { standardEnv } from './helpers/setup-live.js';
import {
  aaModel, aaIndexHtml, flightPush, uuid,
  tinySnapshot, tinyCoverage,
} from './helpers/fixtures.js';

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
  // mimo-v2-5-0424 maps to curated OC id mimo-v2.5 (AA_SLUG)
  assert.equal(byId(res.models, 'mimo-v2.5').aa.effort, null);
});

test('isOpenWeights is coerced to a real boolean', async () => {
  const cov = tinyCoverage();
  cov.aaRecords = [aaModel({ slug: 'kimi-k3', isOpenWeights: 'truthy-string' })];
  const { res } = await run({ coverage: cov });
  assert.equal(byId(res.models, 'kimi-k3').aa.isOpenWeights, true);
});

test('a negative intelligence index is rejected', async () => {
  const cov = tinyCoverage();
  cov.aaRecords = [aaModel({ slug: 'kimi-k3', intelligenceIndex: -1 })];
  const { res } = await run({ models: [], coverage: cov });
  const kimi = byId(res.models, 'kimi-k3');
  assert.equal(kimi, undefined);
});

test('a non-numeric intelligence index is rejected', async () => {
  const cov = tinyCoverage();
  cov.aaRecords = [aaModel({ slug: 'kimi-k3', intelligenceIndex: '59.7' })];
  const { res } = await run({ models: [], coverage: cov });
  const kimi = byId(res.models, 'kimi-k3');
  assert.equal(kimi, undefined);
});

test('a record missing shortName is rejected (slug alone is not trusted)', async () => {
  const cov = tinyCoverage();
  const rec = aaModel({ slug: 'kimi-k3' });
  delete rec.shortName;
  cov.aaRecords = [rec];
  const { res } = await run({ models: [], coverage: cov });
  const kimi = byId(res.models, 'kimi-k3');
  assert.equal(kimi, undefined);
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
  const invalidJsonPush = 'self.__next_f.push([1,"{slug:\\"nope\\"}"])';
  const html = aaIndexHtml([aaModel({ slug: 'mimo-v2-5-0424', intelligenceIndex: 38.04 })], { extra: '\n' + good + '\n' + invalidJsonPush });
  const { res } = await run({
    coverage: cov,
    aaIndexRule: { test: /^https:\/\/artificialanalysis\.ai\/models$/, body: html },
  });
  assert.equal(byId(res.models, 'kimi-k3').aa.intelligenceIndex, 59.7);
  assert.equal(byId(res.models, 'mimo-v2.5').aa.intelligenceIndex, 38.04);
});

test('a record truncated mid-object is skipped, siblings parsed', async () => {
  const cov = tinyCoverage();
  const unclosed = flightPush({ id: uuid(), slug: 'half-record', shortName: 'Half' }).replace('}}]', '}');
  const html = aaIndexHtml([aaModel({ slug: 'kimi-k3' })], { extra: '\n' + unclosed });
  const { res } = await run({
    coverage: cov,
    aaIndexRule: { test: /^https:\/\/artificialanalysis\.ai\/models$/, body: html },
  });
  assert.equal(byId(res.models, 'kimi-k3').aa.intelligenceIndex, 59.7);
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

