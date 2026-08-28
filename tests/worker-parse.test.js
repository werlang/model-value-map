/**
 * Worker parse/join unit tests.
 *
 * Imports worker/index.js directly and exercises the pure helpers via
 * __TEST__ (no Cloudflare globals are touched at import time — `caches`,
 * `env` and network only appear inside the fetch handler).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { __TEST__ } from '../worker/index.js';
import { aaModel, aaIndexHtml } from './helpers/fixtures.js';

const {
  parseAaFree,
  parseModelsDev,
  extractAaIndexScores,
  extractAaModelPageRecord,
  mergeAaScores,
  buildModels,
  extractCuratedIdsFromHtml,
} = __TEST__;

// ---------- keyed free-tier API ----------

test('parseAaFree lifts the evaluations index and drops records without it', () => {
  const pages = [{ data: [
    { slug: 'kimi-k3', name: 'Kimi K3', evaluations: { artificial_analysis_intelligence_index: 59.699 } },
    { slug: 'no-score', name: 'No Score', evaluations: {} },
    { slug: 'neg', name: 'Negative', evaluations: { artificial_analysis_intelligence_index: -1 } },
  ] }];
  const map = parseAaFree(pages);
  assert.equal(map.size, 1);
  assert.equal(map.get('kimi-k3').intelligenceIndex, 59.7);
  assert.equal(map.get('kimi-k3').url, 'https://artificialanalysis.ai/models/kimi-k3');
});

// ---------- keyless AA pages ----------

test('extractAaIndexScores parses flight records and JSON-LD leaderboard rows', () => {
  const flightHtml = aaIndexHtml([aaModel({ slug: 'kimi-k3', intelligenceIndex: 59.7 })]);
  const jsonld = '<script type="application/ld+json">{"data":[{"label":"DeepSeek V4 Flash 0731 (max)","intelligenceIndex":51.7665776089032,"detailsUrl":"/models/deepseek-v4-flash"}]}</script>';
  const map = extractAaIndexScores(flightHtml + jsonld);
  assert.equal(map.get('kimi-k3').intelligenceIndex, 59.7);
  assert.equal(map.get('kimi-k3').shortName, 'Kimi K3');
  assert.equal(map.get('deepseek-v4-flash').intelligenceIndex, 51.77);
  assert.equal(map.get('deepseek-v4-flash').shortName, 'DeepSeek V4 Flash 0731');
});

test('extractAaIndexScores treats hostile flight content as inert text', () => {
  const canary = 'worker-canary-must-stay-undefined';
  const html = '<script>globalThis["' + canary + '"] = 1</script>' +
    aaIndexHtml([aaModel({ slug: 'kimi-k3', intelligenceIndex: 55 })]) +
    'self.__next_f.push([1,"x\\"));globalThis["' + canary + '2"]=1;(""])';
  const map = extractAaIndexScores(html);
  assert.equal(map.get('kimi-k3').intelligenceIndex, 55);
  assert.equal(globalThis[canary], undefined);
  assert.equal(globalThis[canary + '2'], undefined);
});

test('extractAaModelPageRecord returns the model own record or null', () => {
  const html = aaIndexHtml([aaModel({ slug: 'deepseek-v4-flash', shortName: 'DeepSeek V4 Flash 0731 (max)', intelligenceIndex: 51.77 })]);
  const rec = extractAaModelPageRecord(html, 'deepseek-v4-flash');
  assert.ok(rec);
  assert.equal(rec.intelligenceIndex, 51.77);
  assert.equal(extractAaModelPageRecord(html, 'kimi-k3'), null);
});

test('mergeAaScores fills only slugs the keyed map omitted', () => {
  const aaMap = new Map([['kimi-k3', { slug: 'kimi-k3', intelligenceIndex: 59.7 }]]);
  mergeAaScores(aaMap, new Map([
    ['kimi-k3', { slug: 'kimi-k3', intelligenceIndex: 99 }],
    ['deepseek-v4-flash', { slug: 'deepseek-v4-flash', intelligenceIndex: 51.77 }],
  ]));
  assert.equal(aaMap.size, 2);
  assert.equal(aaMap.get('kimi-k3').intelligenceIndex, 59.7, 'keyed value wins');
  assert.equal(aaMap.get('deepseek-v4-flash').intelligenceIndex, 51.77);
});

// ---------- join: keyless scores land curated models on both axes ----------

test('buildModels plots a model whose score came only from a keyless AA page', () => {
  const mdMap = parseModelsDev({
    deepseek: {
      name: 'DeepSeek',
      models: {
        'deepseek-v4-flash': { name: 'DeepSeek V4 Flash', cost: { input: 0.14, output: 0.28 }, limit: { context: 1000000 }, open_weights: true, reasoning: true },
      },
    },
  });
  const aaMap = parseAaFree([]); // keyed API omits this model entirely
  mergeAaScores(aaMap, extractAaIndexScores(
    aaIndexHtml([aaModel({ slug: 'deepseek-v4-flash', shortName: 'DeepSeek V4 Flash 0731 (max)', intelligenceIndex: 51.77 })]),
  ));
  const models = buildModels(mdMap, aaMap);
  const m = models.find((x) => x.id === 'deepseek-v4-flash');
  assert.ok(m, 'model present in payload');
  assert.equal(m.plot, true);
  assert.equal(m.ocCostPerM, 0.28);
  assert.equal(m.aa.intelligenceIndex, 51.77);
});

test('buildModels keeps docs-curated OC-only models off-map with clean ids', () => {
  const mdMap = parseModelsDev({
    xai: {
      name: 'xAI',
      models: {
        'grok-4.6': { name: 'Grok 4.6', cost: { input: 2, output: 6 }, limit: { context: 262144 }, open_weights: false, reasoning: true },
      },
    },
  });
  const aaMap = parseAaFree([]);
  const curated = new Set(['Grok 4.6', 'grok-4-6', 'grok-4.6']);
  const models = buildModels(mdMap, aaMap, curated);
  const m = models.find((x) => x.id === 'grok-4.6');
  assert.ok(m, 'curated OC-only model emitted');
  assert.equal(m.plot, false);
  assert.equal(m.ocCostPerM, 6);
  assert.match(m.excludeReason, /Not scored/);
});

test('buildModels emits roster models with no OC pricing as off-map, not silently dropped', () => {
  // LongCat-2.0 exists on the Go table; simulate models.dev lacking pricing for it
  const mdMap = parseModelsDev({});
  const aaMap = parseAaFree([]);
  mergeAaScores(aaMap, extractAaIndexScores(
    aaIndexHtml([aaModel({ slug: 'longcat-2-0', shortName: 'LongCat 2.0', intelligenceIndex: 33.97 })]),
  ));
  const curated = new Set(['LongCat-2.0', 'longcat-2-0', 'longcat-2.0']);
  const models = buildModels(mdMap, aaMap, curated);
  const m = models.find((x) => x.id === 'longcat-2.0' || x.id === 'longcat-2-0');
  assert.ok(m, 'roster model without pricing still emitted');
  assert.equal(m.plot, false);
  assert.equal(m.ocCostPerM, null);
  assert.equal(m.excludeReason, 'Missing pricing');
  assert.equal(m.aa.intelligenceIndex, 33.97, 'AA score still surfaces in the tray');
});

// ---------- curated docs parsing ----------

test('extractCuratedIdsFromHtml reads MODEL ID tables and skips limit rows', () => {
  const html = `<table><thead><tr><th>Model</th><th>Model ID</th></tr></thead><tbody>
    <tr><td>GPT 5.6 Luna</td><td>gpt-5.6-luna</td></tr></tbody></table>
    <table><thead><tr><th>Model</th><th>requests per week</th></tr></thead><tbody>
    <tr><td>Kimi K3</td><td>250</td></tr></tbody></table>`;
  const ids = extractCuratedIdsFromHtml(html);
  assert.ok(ids.has('gpt-5.6-luna'));
  assert.ok(![...ids].some((s) => s.toLowerCase().includes('limit') || s.toLowerCase().includes('requests')));
});
