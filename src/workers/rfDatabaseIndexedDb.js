/**
 * rfDatabaseIndexedDb.js
 * Caches a serialized ReferenceFinder database (rfDatabaseCache.js) in
 * IndexedDB, across page loads — see REFERENCEFINDER_PLAN.md's Fase 6.
 * rfEngine.makeAllMarksAndLines() depends only on paper size + settings,
 * never on the document being edited, so the same cached database serves
 * every future document with matching paper size/settings, skipping a
 * build that (at the default rank 6) takes several seconds.
 *
 * Runs inside the Web Worker (referenceFinderWorker.js) — IndexedDB is
 * available there the same as on the main thread. Every failure mode here
 * (quota exceeded, private browsing blocking storage, a corrupted or
 * version-mismatched entry) is handled by falling back to "no cache" rather
 * than throwing: a cache is a pure optimization, never a correctness
 * dependency — the worst case is the same build the app already did before
 * this existed.
 */

const DB_NAME = 'treemaker-referencefinder-cache';
// Bumped from 1 to 2 when rfDatabaseCache.js's serialization format changed
// (see its CACHE_FORMAT_VERSION doc comment) — the store is dropped and
// recreated on upgrade so no format-1 entry is ever handed to format-2's
// restoreDatabase(), which doesn't know how to read it.
const DB_VERSION = 2;
const STORE_NAME = 'databases';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.deleteObjectStore(STORE_NAME);
      }
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * A cache entry's identity is every setting that affects
 * makeAllMarksAndLines()'s output — paper size plus the full rfEngine
 * settings object (axiom on/off flags, sMaxRank, key-quantization
 * granularity, thresholds...). Any change to any of these is a different
 * database and gets its own cache entry, never silently reused.
 */
export function cacheKeyFor(settings, paperWidth, paperHeight) {
  return JSON.stringify({ paperWidth, paperHeight, ...settings });
}

export async function loadCachedDatabase(key) {
  try {
    const db = await openDb();
    const data = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return data;
  } catch (err) {
    console.warn('rfDatabaseIndexedDb: failed to read cache, building fresh', err);
    return null;
  }
}

export async function saveCachedDatabase(key, data) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(data, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (err) {
    console.warn('rfDatabaseIndexedDb: failed to write cache, continuing without it', err);
  }
}
