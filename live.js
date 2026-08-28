/* Live data layer — worker only, no direct fallback.
 *
 * Single endpoint: GET https://model-value-map-api.workers.dev/ → { t, meta, models }
 *  Worker fetches OC (models.dev) + AA (api/v2/language/models/free with server key),
 *  joins and sanitizes. Page uses it directly. No direct CORS fallback.
 */
window.LiveData = (function () {
  'use strict';

  const WORKER_URL = 'https://model-value-map-api.pswerlang.workers.dev/';
  const CACHE_KEY = 'mvm.live.v1';
  const CACHE_LASTGOOD = 'mvm.live.lastgood';
  const TTL_MS = 30 * 60 * 1000;

  async function fetchWorker() {
    const res = await fetch(WORKER_URL, {
      headers: { 'Accept': 'application/json' },
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    if (!res.ok) throw new Error('Worker fetch failed ' + res.status);
    const data = await res.json();
    if (!data || !Array.isArray(data.models) || typeof data.t !== 'number') throw new Error('Invalid worker payload');
    return data;
  }

  function readCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const entry = JSON.parse(raw);
      if (!entry || typeof entry !== 'object' || typeof entry.t !== 'number' || !Array.isArray(entry.models)) return null;
      return entry;
    } catch (_) { return null; }
  }

  function readLastGood() {
    try {
      const raw = localStorage.getItem(CACHE_LASTGOOD);
      if (!raw) return null;
      const entry = JSON.parse(raw);
      if (!entry || typeof entry !== 'object' || typeof entry.t !== 'number' || !Array.isArray(entry.models)) return null;
      return entry;
    } catch (_) { return null; }
  }

  function writeCache(models, t) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ t: t || Date.now(), models })); } catch (_) {}
  }

  function writeLastGood(models, t) {
    try { localStorage.setItem(CACHE_LASTGOOD, JSON.stringify({ t: t || Date.now(), models })); } catch (_) {}
  }

  async function fetchFresh() {
    const data = await fetchWorker();
    const now = data.t || Date.now();
    writeCache(data.models, now);
    writeLastGood(data.models, now);
    return {
      state: 'live',
      models: data.models,
      fetchedAt: now,
      ocUpdatedAt: new Date(now).toISOString(),
      meta: data.meta || null,
    };
  }

  async function load(snapshotOrOpts, maybeOpts) {
    const hasSnapshot = Array.isArray(snapshotOrOpts);
    const opts = hasSnapshot ? (maybeOpts || {}) : (snapshotOrOpts || {});
    const force = !!opts.force;
    const report = typeof opts.onUpdate === 'function' ? opts.onUpdate : null;

    if (!force) {
      const cached = readCache();
      if (cached && Date.now() - cached.t < TTL_MS) {
        return { state: 'cached', models: cached.models, fetchedAt: cached.t, ocUpdatedAt: new Date(cached.t).toISOString() };
      }
      const bg = cached || readLastGood();
      if (bg) {
        const staleResult = { state: 'stale', models: bg.models, fetchedAt: bg.t, ocUpdatedAt: new Date(bg.t).toISOString(), refreshing: true };
        fetchFresh().then((fresh) => { if (report) report(fresh); }).catch(() => { if (report) report({ ...staleResult, refreshing: false }); });
        return staleResult;
      }
    }

    try {
      return await fetchFresh();
    } catch (_) {
      const lastGood = readLastGood();
      if (lastGood) return { state: 'stale', models: lastGood.models, fetchedAt: lastGood.t, ocUpdatedAt: new Date(lastGood.t).toISOString() };
      return null;
    }
  }

  return { load };
})();
