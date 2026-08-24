/**
 * Deterministic Worker stand-in. live.js constructs `new Worker(blobUrl)` and
 * exchanges a single message: postMessage(jobs) → onmessage({data: results}).
 * Tests install FakeWorker.handler to fabricate parse results per job.
 *
 * Modes:
 *   'ok'       — handler(jobs) result is posted back
 *   'throw'    — handler throws → onerror fires (worker crashed)
 *   'onerror'  — onerror fires directly (e.g. blob blocked by CSP)
 */
export class FakeWorker {
  static mode = 'ok';
  static handler = null;
  static instances = [];

  constructor() {
    this.terminated = false;
    this.jobs = null;
    FakeWorker.instances.push(this);
  }
  postMessage(jobs) {
    this.jobs = jobs;
    queueMicrotask(() => {
      if (FakeWorker.mode === 'onerror') { this.onerror?.(new Error('blob worker blocked')); return; }
      try {
        if (FakeWorker.mode === 'throw') throw new Error('handler exploded');
        this.onmessage?.({ data: FakeWorker.handler ? FakeWorker.handler(jobs) : [] });
      } catch (err) {
        this.onerror?.(err);
      }
    });
  }
  terminate() { this.terminated = true; }

  static reset() { FakeWorker.mode = 'ok'; FakeWorker.handler = null; FakeWorker.instances.length = 0; }
}
