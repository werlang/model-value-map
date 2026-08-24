/**
 * Loads the app's classic scripts into a vm sandbox with browser globals
 * stubbed: window/localStorage/fetch/Worker/Blob/URL/document/ResizeObserver/
 * requestAnimationFrame and a controllable clock (box.Date).
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeStorage } from './storage.js';
import { FakeWorker } from './fake-worker.js';
import { makeDocument } from './minidom.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

export const DEFAULT_CLOCK_START = 1_755_000_000_000;

export function makeClock(startMs = DEFAULT_CLOCK_START) {
  let now = startMs;
  class FDate extends Date {
    static now() { return now; }
    static advance(ms) { now += ms; }
    static setTo(ms) { now = ms; }
    static get current() { return now; }
    constructor(v) { super(v === undefined ? now : v); }
  }
  return FDate;
}

export function createSandbox({
  snapshotSource = null,          // string overriding data.js entirely
  storage = makeStorage(),
  fetchImpl,
  WorkerClass = FakeWorker,
  loadApp = false,
  clockStart = DEFAULT_CLOCK_START, // 2025-08-15-ish; tests advance via sandbox.Date
} = {}) {
  const DateImpl = makeClock(clockStart);
  const doc = loadApp ? makeDocument() : null;
  const consoleCalls = { error: [], warn: [], log: [] };
  const box = {
    window: null, // set below
    localStorage: storage,
    fetch: fetchImpl ?? (async () => { throw new TypeError('Failed to fetch'); }),
    Worker: WorkerClass,
    Blob: class { constructor(parts) { this.parts = parts; } },
    URL: { createObjectURL: () => 'blob:mvm/test', revokeObjectURL() {} },
    AbortController,
    AbortSignal,
    Date: DateImpl,
    document: doc,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    requestAnimationFrame: (cb) => setTimeout(() => cb(DateImpl.now()), 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    navigator: {},
    console: {
      error: (...a) => consoleCalls.error.push(a),
      warn: (...a) => consoleCalls.warn.push(a),
      log: (...a) => consoleCalls.log.push(a),
    },
    setTimeout,
    clearTimeout,
    queueMicrotask,
  };
  box.window = box;
  box.self = box;
  box.globalThis = box;
  vm.createContext(box);

  vm.runInContext(snapshotSource ?? read('data.js'), box, { filename: 'data.js' });
  vm.runInContext(read('live.js'), box, { filename: 'live.js' });
  if (loadApp) vm.runInContext(read('app.js'), box, { filename: 'app.js' });

  return {
    box,
    LiveData: box.LiveData,
    DASHBOARD_DATA: box.DASHBOARD_DATA,
    internals: box.MVM_TEST ?? null,
    storage,
    document: doc,
    Date: DateImpl,
    consoleCalls,
    el(id) { return doc ? doc.getElementById(id) : null; },
    /** run one macro-task flush for queued microtasks/promises */
    async settle(ticks = 3) { for (let i = 0; i < ticks; i++) await new Promise((r) => setImmediate(r)); },
  };
}
