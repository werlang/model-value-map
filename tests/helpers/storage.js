/** In-memory localStorage with fault injection for quota/private-mode paths. */
export function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  const storage = {
    /** when true, getItem throws (simulates blocked storage) */
    failGet: false,
    /** when true, setItem throws (simulates quota exceeded / private mode) */
    failSet: false,
    getItem(key) {
      if (storage.failGet) throw new Error('SecurityError');
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      if (storage.failSet) throw new Error('QuotaExceededError');
      map.set(key, String(value));
    },
    removeItem(key) { map.delete(key); },
    clear() { map.clear(); },
    key(i) { return [...map.keys()][i] ?? null; },
    get length() { return map.size; },
    dump() { return Object.fromEntries(map); },
  };
  return storage;
}
