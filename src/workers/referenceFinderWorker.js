/**
 * referenceFinderWorker.js
 * Runs rfEngine's combinatorial search (MakeAllMarksAndLines()) off the main
 * thread, so building a database with a real-world rank/budget doesn't
 * freeze the UI — see REFERENCEFINDER_PLAN.md section 6.
 *
 * Protocol (all messages are plain, structured-cloneable objects):
 *
 *   IN  { type: 'build', options }
 *         options is the same shape rfEngine's constructor takes (paperWidth,
 *         paperHeight, maxRank, maxLines, maxMarks, ...).
 *   OUT { type: 'progress', info }      — zero or more, info mirrors the
 *                                          original's DatabaseInfo shape
 *                                          ({ status, rank, numLines, numMarks }),
 *                                          skipped entirely on a cache hit.
 *   OUT { type: 'ready', numLines, numMarks, fromCache }
 *         `fromCache` is true when this database was loaded from the
 *         IndexedDB cache instead of freshly built — see
 *         rfDatabaseIndexedDb.js and REFERENCEFINDER_PLAN.md's Fase 6.
 *
 *   IN  { type: 'findMarks', point: {x,y}, count }
 *   OUT { type: 'marks', results: [{ id, x, y, rank, error }, ...] }
 *
 *   IN  { type: 'findLines', p1: {x,y}, p2: {x,y}, count }
 *   OUT { type: 'lines', results: [{ id, d, ux, uy, rank, error }, ...] }
 *       — or { type: 'error', message } if p1/p2 aren't distinct.
 *
 *   IN  { type: 'sequence', id }
 *   OUT { type: 'sequence', id, steps }
 *       — `id` is one handed back by a prior 'marks'/'lines' result; `steps`
 *         is buildFoldSequence()'s plain-data array (see rfEngine.js).
 *
 * The engine and every mark/crease it has ever handed back to the main
 * thread stay alive in this worker's memory for the lifetime of the worker
 * (keyed by `id`, an incrementing counter) — that's what lets 'sequence'
 * look a result back up later without re-sending the whole database.
 */

import { rfPoint } from '../model/referenceFinder/rfPoint.js';
import { rfLine } from '../model/referenceFinder/rfLine.js';
import { rfEngine, buildFoldSequence } from '../model/referenceFinder/rfEngine.js';
import { cacheKeyFor, loadCachedDatabase, saveCachedDatabase } from './rfDatabaseIndexedDb.js';

let engine = null;
let nextId = 1;
const resultsById = new Map();

function storeResult(item) {
  const id = nextId;
  nextId += 1;
  resultsById.set(id, item);
  return id;
}

self.onmessage = async (event) => {
  const msg = event.data;
  switch (msg.type) {
    case 'build': {
      engine = new rfEngine(msg.options);
      resultsById.clear();
      const cacheKey = cacheKeyFor(engine.settings, engine.paper.width, engine.paper.height);
      const cached = await loadCachedDatabase(cacheKey);
      let fromCache = false;
      if (cached) {
        try {
          engine.loadFromCache(cached);
          fromCache = true;
        } catch (err) {
          // A cache is a pure optimization, never a correctness dependency
          // (see rfDatabaseIndexedDb.js's header) — an unreadable entry
          // (e.g. a stale format DB_VERSION didn't catch) falls back to a
          // fresh build below rather than failing the whole request.
          console.warn('referenceFinderWorker: failed to restore cached database, building fresh', err);
        }
      }
      if (!fromCache) {
        engine.makeAllMarksAndLines((info) => {
          self.postMessage({ type: 'progress', info });
          return false; // this worker itself is the cancellation point (terminate() from the main thread)
        });
        await saveCachedDatabase(cacheKey, engine.exportForCache());
      }
      self.postMessage({ type: 'ready', numLines: engine.numLines, numMarks: engine.numMarks, fromCache });
      break;
    }

    case 'findMarks': {
      const point = new rfPoint(msg.point.x, msg.point.y);
      const marks = engine.findBestMarks(point, msg.count);
      const results = marks.map(mark => ({
        id: storeResult(mark),
        x: mark.p.x,
        y: mark.p.y,
        rank: mark.rank,
        error: mark.distanceTo(point)
      }));
      self.postMessage({ type: 'marks', results });
      break;
    }

    case 'findLines': {
      const p1 = new rfPoint(msg.p1.x, msg.p1.y);
      const p2 = new rfPoint(msg.p2.x, msg.p2.y);
      const { valid, error } = engine.validateLine(p1, p2);
      if (!valid) {
        self.postMessage({ type: 'error', message: error });
        break;
      }
      const targetLine = rfLine.throughPoints(p1, p2);
      const creases = engine.findBestLines(targetLine, msg.count);
      const context = engine.context;
      const results = creases.map(crease => ({
        id: storeResult(crease),
        d: crease.l.d,
        ux: crease.l.u.x,
        uy: crease.l.u.y,
        rank: crease.rank,
        error: crease.distanceTo(targetLine, context)
      }));
      self.postMessage({ type: 'lines', results });
      break;
    }

    case 'sequence': {
      const item = resultsById.get(msg.id);
      self.postMessage({ type: 'sequence', id: msg.id, steps: buildFoldSequence(item) });
      break;
    }

    default:
      break;
  }
};
