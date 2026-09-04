/**
 * referenceFinderClient.js
 * Thin, promise-based wrapper around src/workers/referenceFinderWorker.js
 * for main.js to use, so the Inspector's ReferenceFinder section doesn't
 * have to deal with postMessage/onmessage directly.
 *
 * A single worker is kept alive for the session (lazily created on first
 * use) and rebuilt only when the caller explicitly asks (build()) — e.g.
 * once per document, not once per search. See REFERENCEFINDER_PLAN.md
 * section 6 for the cancellation caveat build() documents below.
 */

// Vite's own inline-worker import (base64 data URI, no separate chunk on
// disk) rather than `new Worker(new URL(...))` — the app also ships as one
// self-contained HTML file (see vite.config.singlefile.js), and a worker
// referenced by URL has nowhere to resolve to once everything else has
// been inlined into that single file.
import ReferenceFinderWorker from './workers/referenceFinderWorker.js?worker&inline';

let worker = null;

function ensureWorker() {
  if (!worker) {
    worker = new ReferenceFinderWorker();
  }
  return worker;
}

/**
 * (Re)builds the worker's database. `onProgress(info)` is called for every
 * progress/rank-complete message (see referenceFinderWorker.js's protocol
 * doc comment) while the build runs.
 *
 * Cancellation: the build itself is synchronous, CPU-bound work inside the
 * worker — once started, it can't be interrupted by a message. To actually
 * cancel, call terminate() (which kills the worker outright); there is no
 * softer option, matching the note in referenceFinderWorker.js.
 */
export function build(options, onProgress) {
  const w = ensureWorker();
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const msg = event.data;
      if (msg.type === 'progress') { onProgress?.(msg.info); return; }
      if (msg.type === 'ready') {
        w.removeEventListener('message', onMessage);
        resolve({ numLines: msg.numLines, numMarks: msg.numMarks, fromCache: msg.fromCache });
      }
    };
    w.addEventListener('message', onMessage);
    w.addEventListener('error', function onError(err) {
      w.removeEventListener('error', onError);
      reject(err);
    }, { once: true });
    w.postMessage({ type: 'build', options });
  });
}

function requestOnce(message, matchType) {
  const w = ensureWorker();
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const msg = event.data;
      if (msg.type !== matchType && msg.type !== 'error') return;
      w.removeEventListener('message', onMessage);
      if (msg.type === 'error') reject(new Error(msg.message));
      else resolve(msg);
    };
    w.addEventListener('message', onMessage);
    w.postMessage(message);
  });
}

/** point: {x,y} in rfEngine's own coordinate space (Y-up) — see rfPoint.js. */
export async function findMarks(point, count) {
  const { results } = await requestOnce({ type: 'findMarks', point, count }, 'marks');
  return results;
}

/** p1/p2: {x,y} in rfEngine's own coordinate space (Y-up) — see rfPoint.js. */
export async function findLines(p1, p2, count) {
  const { results } = await requestOnce({ type: 'findLines', p1, p2, count }, 'lines');
  return results;
}

/** `id` is one handed back by a findMarks()/findLines() result. */
export async function sequence(id) {
  const { steps } = await requestOnce({ type: 'sequence', id }, 'sequence');
  return steps;
}

/** Ends the worker outright — see build()'s cancellation note. */
export function terminate() {
  worker?.terminate();
  worker = null;
}
