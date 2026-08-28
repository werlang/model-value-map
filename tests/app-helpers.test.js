import test from 'node:test';
import assert from 'node:assert/strict';
import { createSandbox } from './helpers/sandbox.js';

/** Offline full-page sandbox; internals are exposed synchronously at boot. */
function page() {
  return createSandbox({ loadApp: true });
}

const m = (id, cost, ii) => ({
  id, label: id, author: 'A', hue: '#000000', rank: 1, weeklyTokensT: 1,
  ocCostPerM: cost, ocCost: null, reasoning: null, openWeights: null,
  contextWindowTokens: null,
  aa: { name: id, intelligenceIndex: ii, effort: null, url: 'https://x/' + id },
  plot: true,
});

// ---------- frontierOf ----------

test('frontierOf: empty selection → empty frontier', () => {
  assert.deepEqual([...page().internals.frontierOf([])], []);
});

test('frontierOf: a single model is its own frontier', () => {
  const f = page().internals.frontierOf([m('a', 1, 50)]);
  assert.equal(f.length, 1);
  assert.equal(f[0].id, 'a');
});

test('frontierOf: dominated models are excluded', () => {
  // c is dominated by b (cheaper AND smarter); a survives as cheapest
  const f = page().internals.frontierOf([m('a', 1, 40), m('b', 2, 55), m('c', 3, 50)]);
  assert.deepEqual([...f].map((x) => x.id), ['a', 'b']);
});

test('frontierOf: equal cost — only the smarter model survives', () => {
  const f = page().internals.frontierOf([m('weak', 2, 40), m('strong', 2, 55)]);
  assert.deepEqual([...f].map((x) => x.id), ['strong']);
});

test('frontierOf: exact duplicates collapse to one member', () => {
  const f = page().internals.frontierOf([m('a', 2, 50), m('b', 2, 50)]);
  assert.equal(f.length, 1);
});

test('frontierOf: equal intelligence keeps only the cheaper model', () => {
  const f = page().internals.frontierOf([m('cheap', 1, 50), m('pricey', 2, 50)]);
  assert.deepEqual([...f].map((x) => x.id), ['cheap']);
});

test('frontierOf: input order never changes the result set', () => {
  const i = page().internals;
  const set = [m('a', 1, 30), m('b', 2, 35), m('c', 3, 40)];
  const forward = [...i.frontierOf(set)].map((x) => x.id).sort();
  const shuffled = [...i.frontierOf([set[2], set[0], set[1]])].map((x) => x.id).sort();
  assert.deepEqual(shuffled, forward);
  assert.deepEqual(forward, ['a', 'b', 'c']); // classic staircase — all members
});

test('frontierOf: a pricier-but-weaker latecomer never joins', () => {
  const f = page().internals.frontierOf([m('a', 15, 59.7), m('b', 18, 50.02)]);
  assert.deepEqual([...f].map((x) => x.id), ['a']);
});

// ---------- makeScales ----------

test('makeScales maps domain edges to the chart margins', () => {
  const { makeScales } = page().internals;
  const s = makeScales(800, 400, [1, 100], [40, 60]);
  assert.equal(s.x(1), 52);            // left margin
  assert.equal(s.x(100), 800 - 24);    // width − right margin
  assert.equal(s.y(60), 26);           // top margin
  assert.equal(s.y(40), 26 + (400 - 26 - 44)); // top + inner height
});

test('makeScales is log on x and linear on y', () => {
  const { makeScales } = page().internals;
  const s = makeScales(800, 400, [1, 100], [40, 60]);
  assert.equal(s.x(10), 52 + (800 - 52 - 24) / 2); // log midpoint
  assert.equal(s.y(50), 26 + (400 - 26 - 44) / 2); // linear midpoint
  assert.ok(s.x(5) < s.x(10) && s.x(10) < s.x(50));
  assert.ok(s.y(45) > s.y(50) && s.y(50) > s.y(55)); // y decreases upward
});

// ---------- esc / formatters ----------

test('esc() neutralizes all five HTML-sensitive characters', () => {
  assert.equal(page().internals.esc(`a&b<c>d"e'f`), 'a&amp;b&lt;c&gt;d&quot;e&#39;f');
});

test('esc() leaves safe strings untouched and coerces non-strings', () => {
  const { esc } = page().internals;
  assert.equal(esc('Kimi K3 (max)'), 'Kimi K3 (max)');
  assert.equal(esc(42), '42');
});

test('fmt$ trims trailing zeros above $1, keeps two decimals below', () => {
  const { fmt$ } = page().internals;
  assert.equal(fmt$(3), '$3');
  assert.equal(fmt$(3.456), '$3.46');
  assert.equal(fmt$(12.5), '$12.5');
  assert.equal(fmt$(0.28), '$0.28');
  assert.equal(fmt$(0.3), '$0.3');
});

test('fmtCtx renders token windows in compact notation', () => {
  const { fmtCtx } = page().internals;
  assert.equal(fmtCtx(null), '—');
  assert.equal(fmtCtx(1048576), '1M');
  assert.equal(fmtCtx(256000), '256k');
});

// ---------- extractCuratedIds (Go/Zen docs) ----------

test('extractCuratedIds reads MODEL ID table cells and list items', () => {
  const { extractCuratedIds } = page().internals;
  const html = `<table><thead><tr><th>Model</th><th>Model ID</th></tr></thead><tbody>
    <tr><td>GPT 5.6 Luna</td><td>gpt-5.6-luna</td></tr>
    <tr><td>DeepSeek V4 Flash</td><td>deepseek-v4-flash</td></tr>
  </tbody></table><ul><li><strong>MiMo-V2.5</strong></li></ul>`;
  const ids = extractCuratedIds(html);
  assert.ok(ids.has('gpt-5.6-luna'), 'exact MODEL ID cell');
  assert.ok(ids.has('deepseek-v4-flash'), 'exact MODEL ID cell');
  assert.ok(ids.has('mimo-v2.5'), 'list item raw form');
  assert.ok(ids.has('mimo-v2-5'), 'list item normalized form');
});

test('extractCuratedIds ignores limit rows, prices and column headers', () => {
  const { extractCuratedIds } = page().internals;
  const html = `<table><thead><tr><th>Model</th><th>requests per week</th></tr></thead><tbody>
    <tr><td>Kimi K3</td><td>250</td></tr></tbody></table>
    <table><thead><tr><th>Model</th><th>Input</th></tr></thead><tbody>
    <tr><td>GLM 5.2</td><td>$1.40</td></tr></tbody></table>
    <ul><li><strong>5 hour limit</strong></li><li><strong>Weekly limit</strong></li></ul>`;
  const ids = extractCuratedIds(html);
  assert.ok(ids.has('kimi-k3'));
  assert.ok(ids.has('glm-5-2'), 'display name normalized to dashes');
  for (const s of ids) {
    assert.ok(!s.toLowerCase().includes('limit'), 'no limit rows: ' + s);
    assert.ok(!s.toLowerCase().includes('requests per'), 'no requests-per cells: ' + s);
    assert.ok(!s.startsWith('$'), 'no prices: ' + s);
  }
});

test('extractCuratedIds normalizes display names to dash slugs', () => {
  const { extractCuratedIds } = page().internals;
  const ids = extractCuratedIds('<ul><li><strong>Muse Spark 1.2 Contributor</strong></li></ul>');
  assert.ok(ids.has('muse-spark-1-2-contributor'), 'spaces and dots normalized to dashes');
  assert.ok(ids.has('Muse Spark 1.2 Contributor'), 'raw display name kept');
});
