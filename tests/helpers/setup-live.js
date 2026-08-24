/** Shared env builder for live.js behavioral tests. */
import { createSandbox } from './sandbox.js';
import { makeFetch } from './fake-fetch.js';
import { FakeWorker } from './fake-worker.js';
import {
  ocHomeHtml, ocModelPageHtml, aaIndexHtml, homeFrom, defaultWorker,
  tinySnapshot, tinyCoverage,
} from './fixtures.js';

export const OC_INDEX = 'https://opencode.ai/data';
export const AA_INDEX = 'https://artificialanalysis.ai/models';
export const RELAY_HOSTS = ['api.allorigins.win', 'api.codetabs.com', 'corsproxy.io'];

export function urlsOnHost(host) {
  return (url) => url.includes(host);
}

/**
 * Builds a sandbox + fetch router with happy-path defaults:
 * tiny snapshot fully covered by live data → load() resolves state 'live'.
 * Override any piece via `over`.
 */
export function standardEnv(over = {}) {
  const snapshot = over.snapshot ?? tinySnapshot();
  const cov = { ...tinyCoverage(), ...(over.coverage ?? {}) };
  const rows = cov.rows;
  const board = cov.board;
  const records = cov.aaRecords;

  FakeWorker.reset();
  FakeWorker.handler = defaultWorker({
    home: over.home ?? homeFrom(rows, board, over.updatedAt),
    pagesByModel: over.ocPages ?? {},
  });

  const rules = [];
  if (over.ocPageRules) rules.push(...over.ocPageRules);
  else if (over.ocPages) rules.push({ test: /^https:\/\/opencode\.ai\/data\/.+/, body: '<script>if($R[0])void 0</script>' });
  else rules.push({ test: /^https:\/\/opencode\.ai\/data\/.+/, status: 404 });

  if (over.aaPageRules) rules.push(...over.aaPageRules);
  else if (over.aaPageRule) rules.push(over.aaPageRule);
  else rules.push({ test: /^https:\/\/artificialanalysis\.ai\/models\/.+/, status: 404 });

  rules.push(
    over.ocIndexRule ?? { test: OC_INDEX, body: ocHomeHtml({ rows, links: over.links }) },
    over.aaIndexRule ?? { test: AA_INDEX, body: aaIndexHtml(records) },
    ...(over.extraRules ?? []),
  );

  const fetch = makeFetch(rules);
  const sb = createSandbox({
    snapshotSource:
      'window.DASHBOARD_DATA={meta:{sources:[' +
      '{name:"opencode.ai/data",url:"https://opencode.ai/data"},' +
      '{name:"artificialanalysis.ai/models",url:"https://artificialanalysis.ai/models"}' +
      ']},models:' + JSON.stringify(snapshot) + '};',
    fetchImpl: fetch,
    storage: over.storage,
    loadApp: !!over.loadApp,
    loadLive: over.loadLive !== false,
    clockStart: over.clockStart,
  });
  return { sb, fetch, Date: sb.Date };
}
