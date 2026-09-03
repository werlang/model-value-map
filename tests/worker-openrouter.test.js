/**
 * Worker /openrouter unit tests — free OpenRouter roster joined with AA.
 *
 * Exercises the pure helpers via __TEST__ (no Cloudflare globals touched).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { __TEST__ } from '../worker/index.js';

const { parseOpenRouter, buildOpenRouterFreeModels, orBaseId, orDisplayName, resolveAaMatchForOc } = __TEST__;

function orModel(over = {}) {
  return {
    id: 'minimax/minimax-m3:free',
    name: 'MiniMax: MiniMax M3',
    context_length: 200000,
    pricing: { prompt: '0', completion: '0', input_cache_read: '0' },
    top_provider: { max_completion_tokens: 64000 },
    reasoning: { mandatory: false },
    ...over,
  };
}

function aaRec(over = {}) {
  return {
    slug: 'minimax-m3',
    shortName: 'MiniMax M3',
    name: 'MiniMax M3',
    creator: 'MiniMax',
    creatorColor: null,
    intelligenceIndex: 52.1,
    effort: null,
    isOpenWeights: true,
    url: 'https://artificialanalysis.ai/models/minimax-m3',
    ...over,
  };
}

test('orBaseId strips provider prefix and variant suffix', () => {
  assert.equal(orBaseId('minimax/minimax-m3:free'), 'minimax-m3');
  assert.equal(orBaseId('nvidia/nemotron-3-ultra-550b-a55b:free'), 'nemotron-3-ultra-550b-a55b');
  assert.equal(orBaseId('google/lyria-3-pro-preview'), 'lyria-3-pro-preview');
  assert.equal(orBaseId('glm-5.2'), 'glm-5.2');
});

test('parseOpenRouter keeps only $0 prompt + $0 completion models', () => {
  const { list } = parseOpenRouter({ data: [
    orModel(),
    orModel({ id: 'x/paid:free', pricing: { prompt: '0.000001', completion: '0' } }),
    orModel({ id: 'x/paid2', pricing: { prompt: '0', completion: '0.000002' } }),
    orModel({ id: 'x/numeric-free', pricing: { prompt: 0, completion: 0 } }),
    { id: 'x/missing-pricing', name: 'No pricing' },
    orModel({ id: 'BAD ID WITH SPACES:free' }),
  ] });
  const ids = list.map((m) => m.id);
  assert.ok(ids.includes('minimax-m3'), 'string-zero free model kept');
  assert.ok(ids.includes('numeric-free'), 'numeric-zero free model kept');
  assert.equal(ids.length, 2, 'paid, unpriced, and malformed ids dropped');
});

test('parseOpenRouter dedupes repeat bases and reads limits', () => {
  const { list } = parseOpenRouter({ data: [
    orModel({ id: 'a/minimax-m3:free' }),
    orModel({ id: 'b/minimax-m3', name: 'Other: MiniMax M3 dup' }),
  ] });
  assert.equal(list.length, 1);
  assert.equal(list[0].limit.context, 200000);
  assert.equal(list[0].limit.output, 64000);
  assert.equal(list[0].author, 'MiniMax');
});

test('parseOpenRouter returns empty roster for invalid payloads', () => {
  for (const bad of [null, {}, { data: 'nope' }, { data: [null, 42] }]) {
    const { list, map } = parseOpenRouter(bad);
    assert.equal(list.length, 0);
    assert.equal(map.size, 0);
  }
});

test('buildOpenRouterFreeModels joins AA scores in the main-app shape', () => {
  const { list } = parseOpenRouter({ data: [orModel()] });
  const models = buildOpenRouterFreeModels(list, new Map([['minimax-m3', aaRec()]]));
  assert.equal(models.length, 1);
  const m = models[0];
  assert.equal(m.id, 'minimax-m3');
  assert.equal(m.ocCostPerM, 0);
  assert.equal(m.intelligenceIndex, 52.1);
  assert.equal(m.aa.slug, 'minimax-m3');
  assert.equal(m.plot, false, 'free models never claim a log-scale slot');
  assert.match(m.excludeReason, /Free on OpenRouter/);
  assert.equal(m.contextWindowTokens, 200000);
});

test('buildOpenRouterFreeModels keeps unscored free models with an explicit reason', () => {
  const { list } = parseOpenRouter({ data: [orModel({ id: 'x/brand-new-free-thing:free', name: 'X: New Thing' })] });
  const models = buildOpenRouterFreeModels(list, new Map());
  assert.equal(models.length, 1, 'never silently dropped');
  assert.equal(models[0].plot, false);
  assert.equal(models[0].aa, null);
  assert.match(models[0].excludeReason, /Not scored/);
});

test('buildOpenRouterFreeModels sorts scored-first by intelligence', () => {
  const { list } = parseOpenRouter({ data: [
    orModel({ id: 'x/unscored:free', name: 'X: Unscored' }),
    orModel({ id: 'a/minimax-m3:free' }),
    orModel({ id: 'z-ai/glm-5.2:free', name: 'Zhipu: GLM 5.2' }),
  ] });
  const models = buildOpenRouterFreeModels(list, new Map([
    ['minimax-m3', aaRec({ slug: 'minimax-m3', intelligenceIndex: 40 })],
    ['glm-5-2', aaRec({ slug: 'glm-5-2', shortName: 'GLM 5.2', intelligenceIndex: 55 })],
  ]));
  assert.deepEqual(models.map((m) => m.id), ['glm-5.2', 'minimax-m3', 'unscored']);
});

test('resolveAaMatchForOc marks override and literal hits exact', () => {
  const aaMap = new Map([
    ['minimax-m3', aaRec({ slug: 'minimax-m3' })],
    ['glm-5-2', aaRec({ slug: 'glm-5-2' })],
  ]);
  assert.equal(resolveAaMatchForOc('minimax-m3', aaMap).match, 'exact');
  // curator override glm-5.2 → glm-5-2 resolves exact while the slug exists
  assert.equal(resolveAaMatchForOc('glm-5.2', aaMap).match, 'exact');
  assert.equal(resolveAaMatchForOc('glm-5.2', aaMap).rec.slug, 'glm-5-2');
});

test('resolveAaMatchForOc marks stripped/prefix fallbacks approximate', () => {
  const aaMap = new Map([
    ['glm-5', aaRec({ slug: 'glm-5', shortName: 'GLM-5' })],
    ['inkling', aaRec({ slug: 'inkling', shortName: 'Inkling' })],
  ]);
  // no glm-5-2 in the map → falls back to glm-5, a different model
  const glm = resolveAaMatchForOc('glm-5.2', aaMap);
  assert.equal(glm.match, 'approximate');
  assert.equal(glm.rec.slug, 'glm-5');
  const ink = resolveAaMatchForOc('inkling-small', aaMap);
  assert.equal(ink.match, 'approximate');
  assert.equal(ink.rec.slug, 'inkling');
  assert.equal(resolveAaMatchForOc('no-such-model', aaMap), null);
});

test('orDisplayName strips the provider prefix and free suffix', () => {
  assert.equal(orDisplayName({ id: 'z-ai/glm-5.2:free', name: 'Z.ai: GLM 5.2 (free)' }), 'GLM 5.2');
  assert.equal(orDisplayName({ id: 'a/b:free', name: 'Thinking Machines: Inkling Small (free)' }), 'Inkling Small');
  assert.equal(orDisplayName({ id: 'x/y', name: 'Ling 3.0 Flash Fin (free)' }), 'Ling 3.0 Flash Fin');
  assert.equal(orDisplayName({ id: 'openrouter/free', name: 'Free Models Router' }), 'Free Models Router');
});

test('approximate matches keep the OpenRouter name so the bar is recognizable', () => {
  const { list } = parseOpenRouter({ data: [
    orModel({ id: 'z-ai/glm-5.2:free', name: 'Z.ai: GLM 5.2 (free)' }),
  ] });
  const models = buildOpenRouterFreeModels(list, new Map([
    ['glm-5', aaRec({ slug: 'glm-5', shortName: 'GLM-5 (Reasoning)', intelligenceIndex: 40.6 })],
  ]));
  assert.equal(models.length, 1);
  assert.equal(models[0].label, 'GLM 5.2');
  assert.equal(models[0].orId, 'z-ai/glm-5.2:free');
  assert.equal(models[0].aa.match, 'approximate');
  assert.equal(models[0].aa.slug, 'glm-5');
  assert.equal(models[0].plot, false);
});

test('exact matches keep the benchmark canonical name and orId', () => {
  const { list } = parseOpenRouter({ data: [orModel()] });
  const models = buildOpenRouterFreeModels(list, new Map([['minimax-m3', aaRec()]]));
  assert.equal(models[0].label, 'MiniMax M3');
  assert.equal(models[0].aa.match, 'exact');
  assert.equal(models[0].orId, 'minimax/minimax-m3:free');
});
