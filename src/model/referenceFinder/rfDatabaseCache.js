/**
 * rfDatabaseCache.js
 * Serializes a built rfEngine's mark/crease database to a compact,
 * structure-of-arrays representation (typed arrays, no class instances, no
 * circular references), and restores it back into live instances. This is
 * what makes it possible to cache a built database (IndexedDB — see
 * src/workers/rfDatabaseIndexedDb.js) across page loads: rfEngine.
 * makeAllMarksAndLines() only depends on paper size + settings, never on the
 * tree being edited, so the exact same database is reusable indefinitely for
 * any document with matching paper size/settings — see
 * REFERENCEFINDER_PLAN.md's Fase 6.
 *
 * Only a FINISHED engine's `marks.all`/`lines.all` (flat arrays, populated)
 * needs to survive — `maps`/`buffer` (the RfBasisContainer scratch state used
 * only *during* a build, for rank-bucketed iteration and uniqueness checks)
 * are already discarded by clearMaps() at the end of a normal build, and a
 * restored engine skips makeAllMarksAndLines() entirely, so it never needs
 * them either.
 *
 * FORMAT (bumped to 2, 2026-08-30): one typed array per field
 * ("structure-of-arrays") instead of one plain object per mark/crease. A
 * build at the default rank 6 can hold ~500,000 marks and ~500,000 creases;
 * an array of that many small objects (each with named properties like
 * `{ kind, rank, key, index, p: {x,y}, refs: [...] }`) serializes through
 * IndexedDB's structured-clone at ~179MB and dominates "with cache" load
 * time. Typed arrays clone as raw contiguous memory instead of walking each
 * object's own properties, and every mark/crease's ref fields are already
 * fully determined by its `kind` (MARK_KINDS/CREASE_KINDS below fix which
 * fields exist, and whether each one points into `marks` or `creases` — see
 * refFieldType()'s doc comment) — so per-entry type tags for refs, once
 * needed to disambiguate at read time, are redundant with `kind` and are no
 * longer stored. Same reasoning for `whoMoves`: stored as a small integer
 * code into a fixed per-kind string table instead of repeating the string
 * itself in every entry. Format 1 (array-of-objects) is not supported for
 * restore; rfDatabaseIndexedDb.js's DB_VERSION bump takes care of discarding
 * any cache entries written before this change.
 *
 * Reconstruction bypasses every class's constructor (which re-derives
 * geometry from scratch and re-validates it) — pointless work for state
 * that's already known-valid — and instead builds a bare instance via
 * Object.create() and assigns its fields directly. This also sidesteps a
 * real obstacle: rfCreaseL2l's constructor takes an `iroot` (0 or 1) and
 * rfCreaseP2lP2l's takes a cubic root `rc`, transient inputs used only to
 * derive the final `l` — neither is a stored field, so there'd be nothing to
 * serialize them FROM even if we wanted to replay the constructor.
 */

import { rfPoint } from './rfPoint.js';
import { rfLine } from './rfLine.js';
import {
  rfMark, rfMarkOriginal, rfMarkIntersection, resetMarkIndexCounter
} from './rfMark.js';
import {
  rfCrease, rfCreaseOriginal, rfCreaseC2pC2p, rfCreaseP2p, rfCreaseL2l, rfCreaseL2lC2p,
  rfCreaseP2lC2p, rfCreaseP2lP2l, rfCreaseL2lP2l, resetCreaseIndexCounter
} from './rfCrease.js';

export const CACHE_FORMAT_VERSION = 2;

// Every mark/crease kind's class and the order its own instance fields must
// be (de)serialized in — always the class's fixed constructor-parameter
// order, NOT prerequisites()'s order (which rearranges per `whoMoves` for the
// fold-sequence narration — see rfCrease.js). A field name starting with
// "mark"/"crease" is a reference into the other typed-array group — resolved
// generically from the field name, never stored per entry (see module doc
// comment above).
const MARK_KIND_NAMES = ['markOriginal', 'markIntersection'];
const MARK_KINDS = {
  markOriginal: { Class: rfMarkOriginal, refFields: [], extraFields: ['name'] },
  markIntersection: { Class: rfMarkIntersection, refFields: ['crease1', 'crease2'], extraFields: [] }
};
const MARK_REF_SLOTS = 2; // max(refFields.length) across MARK_KINDS

const CREASE_KIND_NAMES = [
  'creaseOriginal', 'creaseC2pC2p', 'creaseP2p', 'creaseL2l', 'creaseL2lC2p',
  'creaseP2lC2p', 'creaseP2lP2l', 'creaseL2lP2l'
];
const CREASE_KINDS = {
  creaseOriginal: { Class: rfCreaseOriginal, refFields: [], extraFields: ['name'] },
  creaseC2pC2p: { Class: rfCreaseC2pC2p, refFields: ['mark1', 'mark2'], extraFields: [] },
  creaseP2p: { Class: rfCreaseP2p, refFields: ['mark1', 'mark2'], extraFields: ['whoMoves'] },
  creaseL2l: { Class: rfCreaseL2l, refFields: ['crease1', 'crease2'], extraFields: ['whoMoves'] },
  creaseL2lC2p: { Class: rfCreaseL2lC2p, refFields: ['mark1', 'crease1'], extraFields: [] },
  creaseP2lC2p: { Class: rfCreaseP2lC2p, refFields: ['mark1', 'crease1', 'mark2'], extraFields: ['whoMoves'] },
  creaseP2lP2l: { Class: rfCreaseP2lP2l, refFields: ['mark1', 'crease1', 'mark2', 'crease2'], extraFields: ['whoMoves'] },
  creaseL2lP2l: { Class: rfCreaseL2lP2l, refFields: ['crease1', 'mark1', 'crease2'], extraFields: ['whoMoves'] }
};
const CREASE_REF_SLOTS = 4; // max(refFields.length) across CREASE_KINDS

// `whoMoves` is always one of a small, fixed set of strings *per kind* (see
// each rfCrease* constructor in rfCrease.js) — coded here as an index into
// these tables instead of repeating the string per entry. 255 marks "no
// whoMoves field on this kind" (kinds not listed here never read it back).
const WHO_MOVES_TABLES = {
  creaseP2p: ['p1', 'p2'],
  creaseL2l: ['l1', 'l2'],
  creaseP2lC2p: ['p1', 'l1'],
  creaseP2lP2l: ['p1p2', 'l1l2', 'p1l2', 'p2l1'],
  creaseL2lP2l: ['p1', 'l1']
};
const NO_WHO_MOVES = 255;

function creaseKindNameOf(crease) {
  return CREASE_KIND_NAMES.find(name => crease.constructor === CREASE_KINDS[name].Class);
}

/**
 * Serializes `engine.marks.all` and `engine.lines.all` into a compact,
 * structured-clone-friendly object of typed arrays (see module doc comment).
 */
export function serializeEngine(engine) {
  const marks = engine.marks.all;
  const creases = engine.lines.all;
  const markPos = new Map(marks.map((m, i) => [m, i]));
  const creasePos = new Map(creases.map((c, i) => [c, i]));
  // Every ref field's target array is fixed by its own name, never by the
  // referencing entry's kind — see refFieldType()'s doc comment above.
  const refIndexOf = (obj, fieldName) => (fieldName.startsWith('mark') ? markPos.get(obj) : creasePos.get(obj));

  const nm = marks.length;
  const markKind = new Uint8Array(nm);
  const markRank = new Uint8Array(nm);
  const markKey = new Int32Array(nm);
  const markIndex = new Int32Array(nm);
  const markPx = new Float64Array(nm);
  const markPy = new Float64Array(nm);
  const markRefs = new Int32Array(nm * MARK_REF_SLOTS).fill(-1);
  const markNames = [];

  marks.forEach((mark, i) => {
    const kindName = mark.constructor === rfMarkOriginal ? 'markOriginal' : 'markIntersection';
    const spec = MARK_KINDS[kindName];
    markKind[i] = MARK_KIND_NAMES.indexOf(kindName);
    markRank[i] = mark.rank;
    markKey[i] = mark.key;
    markIndex[i] = mark.index;
    markPx[i] = mark.p.x;
    markPy[i] = mark.p.y;
    spec.refFields.forEach((f, slot) => { markRefs[i * MARK_REF_SLOTS + slot] = refIndexOf(mark[f], f); });
    if (kindName === 'markOriginal') markNames.push([i, mark.name]);
  });

  const nc = creases.length;
  const creaseKind = new Uint8Array(nc);
  const creaseRank = new Uint8Array(nc);
  const creaseKey = new Int32Array(nc);
  const creaseIndex = new Int32Array(nc);
  const creaseLd = new Float64Array(nc);
  const creaseLux = new Float64Array(nc);
  const creaseLuy = new Float64Array(nc);
  const creaseWhoMoves = new Uint8Array(nc).fill(NO_WHO_MOVES);
  const creaseRefs = new Int32Array(nc * CREASE_REF_SLOTS).fill(-1);
  const creaseNames = [];

  creases.forEach((crease, i) => {
    const kindName = creaseKindNameOf(crease);
    const spec = CREASE_KINDS[kindName];
    creaseKind[i] = CREASE_KIND_NAMES.indexOf(kindName);
    creaseRank[i] = crease.rank;
    creaseKey[i] = crease.key;
    creaseIndex[i] = crease.index;
    creaseLd[i] = crease.l.d;
    creaseLux[i] = crease.l.u.x;
    creaseLuy[i] = crease.l.u.y;
    spec.refFields.forEach((f, slot) => { creaseRefs[i * CREASE_REF_SLOTS + slot] = refIndexOf(crease[f], f); });
    if (spec.extraFields.includes('whoMoves')) {
      creaseWhoMoves[i] = WHO_MOVES_TABLES[kindName].indexOf(crease.whoMoves);
    }
    if (kindName === 'creaseOriginal') creaseNames.push([i, crease.name]);
  });

  return {
    format: CACHE_FORMAT_VERSION,
    settings: engine.settings,
    paperWidth: engine.paper.width,
    paperHeight: engine.paper.height,
    markCount: nm,
    creaseCount: nc,
    markKind, markRank, markKey, markIndex, markPx, markPy, markRefs, markNames,
    creaseKind, creaseRank, creaseKey, creaseIndex, creaseLd, creaseLux, creaseLuy, creaseWhoMoves, creaseRefs, creaseNames
  };
}

// Builds a bare instance of `Class` with `fields` assigned directly —
// bypassing the constructor (and therefore its geometry re-derivation/
// validation) entirely. Safe because every field the class's methods
// actually use (rank/key/index/valid/p or l/name/whoMoves/its named
// pedigree fields) is being restored here exactly as it was.
function restoreBare(Class, fields) {
  return Object.assign(Object.create(Class.prototype), { valid: true, ...fields });
}

/**
 * Restores `serializeEngine()`'s output into live rfMark/rfCrease instances,
 * in the same rank-interleaved order they were originally built in (a
 * crease's own prerequisites are always strictly lower rank than itself, but
 * a mark can reference a same-rank crease — see rfEngine.js's
 * _makeAllIntersections() — so creases and marks can't simply be restored as
 * two independent passes; they're merged one rank at a time, creases before
 * marks within each rank, mirroring _makeAllOfRank()'s own order). Returns
 * `{ marks, creases }`, both flat arrays positionally matching the original
 * `engine.marks.all`/`engine.lines.all`.
 */
export function restoreDatabase(data) {
  if (data.format !== CACHE_FORMAT_VERSION) {
    throw new Error(`rfDatabaseCache: unsupported cache format ${data.format}`);
  }

  const nm = data.markCount;
  const nc = data.creaseCount;
  const restoredMarks = new Array(nm);
  const restoredCreases = new Array(nc);
  // Every ref slot's target array is fixed by its field name (see
  // serializeEngine()) — never by which array position the current entry
  // itself lives in.
  const resolve = (fieldName, idx) => (fieldName.startsWith('mark') ? restoredMarks[idx] : restoredCreases[idx]);

  resetMarkIndexCounter();
  resetCreaseIndexCounter();

  const markNameOf = new Map(data.markNames);
  const creaseNameOf = new Map(data.creaseNames);

  let mi = 0;
  let ci = 0;
  const maxRank = Math.max(nm ? data.markRank[nm - 1] : 0, nc ? data.creaseRank[nc - 1] : 0);
  for (let rank = 0; rank <= maxRank; rank += 1) {
    while (ci < nc && data.creaseRank[ci] === rank) {
      const kindName = CREASE_KIND_NAMES[data.creaseKind[ci]];
      const spec = CREASE_KINDS[kindName];
      const fields = {
        rank: data.creaseRank[ci], key: data.creaseKey[ci], index: data.creaseIndex[ci],
        l: new rfLine(data.creaseLd[ci], new rfPoint(data.creaseLux[ci], data.creaseLuy[ci]))
      };
      spec.refFields.forEach((f, slot) => { fields[f] = resolve(f, data.creaseRefs[ci * CREASE_REF_SLOTS + slot]); });
      if (spec.extraFields.includes('whoMoves')) fields.whoMoves = WHO_MOVES_TABLES[kindName][data.creaseWhoMoves[ci]];
      if (spec.extraFields.includes('name')) fields.name = creaseNameOf.get(ci);
      restoredCreases[ci] = restoreBare(spec.Class, fields);
      ci += 1;
    }
    while (mi < nm && data.markRank[mi] === rank) {
      const kindName = MARK_KIND_NAMES[data.markKind[mi]];
      const spec = MARK_KINDS[kindName];
      const fields = {
        rank: data.markRank[mi], key: data.markKey[mi], index: data.markIndex[mi],
        p: new rfPoint(data.markPx[mi], data.markPy[mi])
      };
      spec.refFields.forEach((f, slot) => { fields[f] = resolve(f, data.markRefs[mi * MARK_REF_SLOTS + slot]); });
      if (spec.extraFields.includes('name')) fields.name = markNameOf.get(mi);
      restoredMarks[mi] = restoreBare(spec.Class, fields);
      mi += 1;
    }
  }

  return { marks: restoredMarks, creases: restoredCreases };
}
