import test from 'node:test';
import assert from 'node:assert/strict';
import { createSandbox } from './helpers/sandbox.js';
import { snapshot } from './helpers/fixtures.js';
import { standardEnv } from './helpers/setup-live.js';

test('smoke: snapshot loads and LiveData exists', async () => {
  const sb = createSandbox({ snapshotSource: 'window.DASHBOARD_DATA = { meta:{}, models: ' + JSON.stringify(snapshot()) + ' };' });
  assert.ok(sb.LiveData, 'LiveData global');
  assert.equal(sb.DASHBOARD_DATA.models.length, 6);
});

test('smoke: full happy-path load', async () => {
  const { sb } = standardEnv();
  const res = await sb.LiveData.load(sb.DASHBOARD_DATA.models, {});
  assert.equal(res.state, 'live');
  assert.equal(res.models.length, 2);
  const kimi = res.models.find((m) => m.id === 'kimi-k3');
  assert.equal(kimi.ocCostPerM, 15);
  assert.equal(kimi.aa.intelligenceIndex, 59.7);
  assert.equal(kimi.plot, true);
});
