/** Shared env builder for live.js behavioral tests. */
import { createSandbox } from './sandbox.js';
import { makeFetch } from './fake-fetch.js';
import {
  aaIndexHtml, modelsDevCatalog,
  tinySnapshot, tinyCoverage,
} from './fixtures.js';

export const MODELS_DEV = 'https://models.dev/api.json';
export const AA_INDEX = 'https://artificialanalysis.ai/models';

/**
 * Builds a sandbox + fetch router with happy-path defaults:
 * tiny snapshot fully covered by live data → load() resolves state 'live'.
 * Override any piece via `over`.
 */
export function standardEnv(over = {}) {
  const snapshot = over.snapshot ?? tinySnapshot();
  const cov = { ...tinyCoverage(), ...(over.coverage ?? {}) };
  const records = cov.aaRecords;

  const rules = [];
  if (over.aaPageRules) rules.push(...over.aaPageRules);
  else if (over.aaPageRule) rules.push(over.aaPageRule);
  else rules.push({ test: /^https:\/\/artificialanalysis\.ai\/models\/.+/, status: 404 });

  rules.push(
    over.modelsDevRule ?? { test: MODELS_DEV, json: over.modelsDev ?? modelsDevCatalog(over.modelsDevModels) },
    over.aaIndexRule ?? { test: AA_INDEX, body: aaIndexHtml(records) },
    ...(over.extraRules ?? []),
  );

  const fetch = makeFetch(rules);
  const sb = createSandbox({
    snapshotSource:
      'window.DASHBOARD_DATA={meta:{sources:[' +
      '{name:"models.dev",url:"https://models.dev/api.json"},' +
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
