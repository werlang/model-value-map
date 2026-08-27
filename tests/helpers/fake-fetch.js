/**
 * Recorded fetch router. Rules are matched in order; the first match wins.
 * Unmatched URLs throw a TypeError, mimicking a network failure — tests must
 * be explicit about every endpoint they expect to be hit.
 *
 *   rule = {
 *     test: string | RegExp | (url) => bool,
 *     status?: number          // HTTP status (default 200)
 *     body?: string | () => string,
 *     fail?: true              // simulate a network-level failure
 *     oncall?: (url) => void   // side-channel for assertions mid-flight
 *   }
 */
export function makeFetch(rules = []) {
  const calls = [];
  const matches = (rule, url, opts) => {
    if (rule.method && opts && opts.method && rule.method.toUpperCase() !== opts.method.toUpperCase()) return false;
    return typeof rule.test === 'string' ? url.includes(rule.test)
      : rule.test instanceof RegExp ? rule.test.test(url)
      : typeof rule.test === 'function' ? rule.test(url, opts)
      : false;
  };
  const impl = async (url, opts = {}) => {
    calls.push(url);
    const rule = rules.find((r) => matches(r, url, opts));
    if (!rule || rule.fail) throw new TypeError('Failed to fetch');
    if (rule.oncall) rule.oncall(url, opts);
    if (rule.hang) return new Promise(() => {}); // never settles — loading states
    const status = rule.status ?? 200;
    const body = typeof rule.body === 'function' ? rule.body(opts) : (rule.json !== undefined ? JSON.stringify(rule.json) : (rule.body ?? ''));
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
      json: async () => JSON.parse(body || '{}'),
    };
  };
  impl.calls = calls;
  impl.rules = rules;
  /** URLs requested since the last drain() */
  impl.drain = () => { const c = [...calls]; calls.length = 0; return c; };
  return impl;
}
