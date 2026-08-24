import { createSandbox } from './helpers/sandbox.js';
import { makeFetch } from './helpers/fake-fetch.js';
import { FakeWorker } from './helpers/fake-worker.js';
import { tinySnapshot, tinyCoverage, ocHomeHtml, aaIndexHtml, homeFrom, defaultWorker } from './helpers/fixtures.js';

const cov = tinyCoverage();
FakeWorker.reset();
FakeWorker.handler = defaultWorker({ home: homeFrom(cov.rows, cov.board), pagesByModel: {} });

const fetch = makeFetch([
  { test: /^https:\/\/opencode\.ai\/data\/.+/, status: 404 },
  { test: /^https:\/\/artificialanalysis\.ai\/models\/.+/, status: 404 },
  { test: 'https://opencode.ai/data', body: ocHomeHtml({ rows: cov.rows }) },
  { test: /^https:\/\/artificialanalysis\.ai\/models$/, body: aaIndexHtml(cov.aaRecords) },
]);

const sb = createSandbox({
  snapshotSource: 'window.DASHBOARD_DATA={meta:{},models:' + JSON.stringify(tinySnapshot()) + '};',
  fetchImpl: fetch,
});

// wrap fetch to trace invocation from the sandbox side
const inner = sb.box.fetch;
let n = 0;
sb.box.fetch = (u, o) => { console.log('FETCH #' + ++n, u); return inner(u, o); };

console.log('typeof load:', typeof sb.LiveData?.load);
console.log('LiveData keys:', Object.keys(sb.LiveData ?? {}));

try {
  const p = sb.LiveData.load(tinySnapshot(), {});
  console.log('thenable?', !!p && typeof p.then === 'function');
  const res = await p;
  console.log('res:', res && res.state, 'calls:', n);
} catch (e) {
  console.log('LOAD THREW:', e && e.stack);
}
console.log('worker instances:', FakeWorker.instances.length);
