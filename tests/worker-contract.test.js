import test from 'node:test';
import assert from 'node:assert/strict';
import { standardEnv } from './helpers/setup-live.js';
import {
  tinySnapshot, tinyCoverage, homeFrom, defaultWorker,
  modelRow, boardRow,
} from './helpers/fixtures.js';
import { FakeWorker } from './helpers/fake-worker.js';

const byId = (models, id) => models.find((m) => m.id === id);

test('the worker only receives the home job plus rows the board cannot price', async () => {
  const cov = tinyCoverage();
  cov.board = [boardRow()]; // mimo missing from board → page fetch for mimo only
  const env = standardEnv({
    coverage: cov,
    // the page fetch must SUCCEED ($R[ marker) or the job is dropped pre-worker
    ocPageRules: [{ test: /^https:\/\/opencode\.ai\/data\/.+/, body: '<script>if($R[0])void 0</script>' }],
  });
  const seen = [];
  FakeWorker.handler = (jobs) => {
    seen.push(...jobs.map((j) => j.id));
    return defaultWorker({ home: homeFrom(cov.rows, cov.board) })(jobs);
  };
  await env.sb.LiveData.load(tinySnapshot());
  assert.deepEqual([...seen], ['home', 'mimo-v2.5']);
});

test('per-model jobs whose worker result carries an error fall back to snapshot', async () => {
  const cov = tinyCoverage();
  cov.board = []; // both models fan out
  const env = standardEnv({ coverage: cov });
  FakeWorker.handler = (jobs) => jobs.map((job) =>
    job.id === 'home'
      ? { id: job.id, result: { home: homeFrom(cov.rows, []), info: null } }
      : { id: job.id, error: 'SyntaxError: unexpected token' });
  const res = await env.sb.LiveData.load(tinySnapshot());
  const kimi = byId(res.models, 'kimi-k3');
  assert.equal(kimi.ocCostPerM, 15); // snapshot cost
  assert.ok(res.snapFallbacks >= 1);
});

test('a worker that errors at construction time (onerror) degrades to snapshot-only', async () => {
  const env = standardEnv({});
  FakeWorker.mode = 'onerror'; // blob blocked / worker construct fails
  const res = await env.sb.LiveData.load(tinySnapshot());
  assert.equal(res, null); // home unparseable → load aborts cleanly
});

test('a crashing worker handler also degrades to null instead of throwing', async () => {
  const env = standardEnv({});
  FakeWorker.mode = 'throw';
  const res = await env.sb.LiveData.load(tinySnapshot());
  assert.equal(res, null);
});

test('an empty worker reply aborts the load', async () => {
  const env = standardEnv({});
  FakeWorker.handler = () => [];
  const res = await env.sb.LiveData.load(tinySnapshot());
  assert.equal(res, null);
});

test('a home result without a leaderboard array is rejected by the guard', async () => {
  const env = standardEnv({});
  FakeWorker.handler = defaultWorker({ home: { updatedAt: 'x', leaderboard: 'not-an-array', tokenCost: [] } });
  const res = await env.sb.LiveData.load(tinySnapshot());
  assert.equal(res, null);
});

test('per-model info with an invalid cost never becomes a live page price', async () => {
  const cov = tinyCoverage();
  cov.board = [];
  const env = standardEnv({ coverage: cov });
  FakeWorker.handler = (jobs) => jobs.map((job) =>
    job.id === 'home'
      ? { id: job.id, result: { home: homeFrom(cov.rows, []), info: null } }
      : job.id === 'kimi-k3'
        ? { id: job.id, result: { home: null, info: { name: 'Kimi K3', cost: { output: 'free' }, limit: {} } } }
        : { id: job.id, error: 'none' });
  const res = await env.sb.LiveData.load(tinySnapshot());
  assert.equal(byId(res.models, 'kimi-k3').ocCostPerM, 15); // validPageCost gate held
});
