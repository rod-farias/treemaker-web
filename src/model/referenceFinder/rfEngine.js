/**
 * rfEngine.js
 * The search engine: builds the database of every reachable rfMark/rfCrease
 * up to a maximum rank, and finds the best matches for a target point or
 * line. Equivalent to class ReferenceFinder in
 * original/ReferenceFinder/source/model/ReferenceFinder.h.
 *
 * Deliberately an instantiable class rather than the original's 100%-static
 * class (a single global database per process) — see
 * REFERENCEFINDER_PLAN.md section 3. Every setting the original reads off
 * `ReferenceFinder::sXxx` statics lives on `this.settings` instead, and
 * `this.context` is the subset of it (plus `this.paper`) that rfMark.js/
 * rfCrease.js constructors expect — see their file comments for that
 * contract.
 */

import { rfPaper } from './rfPaper.js';
import { rfMarkOriginal, rfMarkIntersection, resetMarkIndexCounter } from './rfMark.js';
import {
  rfCreaseOriginal, rfCreaseC2pC2p, rfCreaseP2p, rfCreaseL2l, rfCreaseL2lC2p,
  rfCreaseP2lC2p, rfCreaseP2lP2l, rfCreaseL2lP2l, solveP2LP2LCubic, resetCreaseIndexCounter
} from './rfCrease.js';
import { serializeEngine, restoreDatabase } from './rfDatabaseCache.js';

// Thrown internally to unwind out of a build when the caller's status
// callback requests cancellation (EXC_HALT in the original).
class RfHalt {}

// RefContainer<R>: organizes marks (or creases) by rank, deduplicating by
// key within a map per rank, plus a scratch buffer for the rank currently
// being built (so new candidates never corrupt the in-progress iteration
// over already-committed ranks — same reason the original buffers before
// FlushBuffer()).
class RfBasisContainer {
  constructor(maxRank) {
    this._rebuild(maxRank);
  }

  _rebuild(maxRank) {
    this.maps = Array.from({ length: maxRank + 1 }, () => new Map());
    this.buffer = new Map();
    this.all = [];
  }

  get totalSize() {
    return this.all.length + this.buffer.size;
  }

  contains(key) {
    for (const map of this.maps) if (map.has(key)) return true;
    return this.buffer.has(key);
  }

  add(item) {
    this.buffer.set(item.key, item);
  }

  // AddCopyIfValidAndUnique(): the original copies `ars` into a freshly
  // `new`-ed object before storing it, because its MakeAll() loops reuse a
  // single stack-allocated candidate across iterations. This port's MakeAll
  // loops construct a fresh object per candidate already, so there's
  // nothing to copy — just keep the instance itself if it's valid and new.
  addCopyIfValidAndUnique(candidate) {
    if (candidate.valid && !this.contains(candidate.key)) this.add(candidate);
  }

  flushBuffer() {
    for (const item of this.buffer.values()) {
      this.maps[item.rank].set(item.key, item);
      this.all.push(item);
    }
    this.buffer.clear();
  }

  clearMaps() {
    this.maps.forEach(map => map.clear());
  }
}

// CompareRankAndError<R>: the sort order FindBestMarks()/FindBestLines()
// use — errors within sGoodEnoughError of each other are treated as tied
// and broken by rank instead (prefer the simpler construction among
// near-equally-accurate candidates).
function compareRankAndError(a, b, distanceA, distanceB, goodEnoughError) {
  if (distanceA > goodEnoughError || distanceB > goodEnoughError) {
    return distanceA !== distanceB ? distanceA - distanceB : a.rank - b.rank;
  }
  return a.rank !== b.rank ? a.rank - b.rank : distanceA - distanceB;
}

const DEFAULT_SETTINGS = {
  useC2pC2p: true,
  useP2p: true,
  useL2l: true,
  useL2lC2p: true,
  useP2lC2p: true,
  useP2lP2l: true,
  useL2lP2l: true,

  maxRank: 6,
  maxLines: 500000,
  maxMarks: 500000,

  numX: 5000,
  numY: 5000,
  numA: 5000,
  numD: 5000,

  goodEnoughError: 0.005,
  minAspectRatio: 0.1,
  minAngleSine: 0.342, // sin(20 degrees)
  visibilityMatters: true,
  lineWorstCaseError: true,
  databaseStatusSkip: 200000
};

export class rfEngine {
  constructor({ paperWidth = 1, paperHeight = 1, ...settings } = {}) {
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.paper = new rfPaper(paperWidth, paperHeight);
    this.lines = new RfBasisContainer(this.settings.maxRank);
    this.marks = new RfBasisContainer(this.settings.maxRank);
    this.curRank = 0;
    this._statusCount = 0;
    // Memoized per-rank array snapshots of this.lines.maps[r]/marks.maps[r]
    // (Maps), read by every _makeAllX() axiom builder below. Safe to cache
    // for the whole of one _makeAllOfRank() call because none of the axiom
    // builders mutate `maps` directly — new candidates go into `buffer`
    // until flushBuffer() merges them in, which only happens twice per rank
    // (see _makeAllOfRank()), at each of which the relevant cache is
    // invalidated. See profile.mjs commentary below on why this matters.
    this._lineSnapshotCache = new Map();
    this._markSnapshotCache = new Map();
  }

  /**
   * Array snapshot of `this.lines.maps[rank]` (a Map), memoized for the
   * current rank build. Every axiom builder needs one of these per rank it
   * touches, sometimes several times per rank inside nested loops over
   * OTHER ranks — re-deriving `[...map.values()]` on every one of those
   * inner-loop visits (rather than once per rank) was, before this cache
   * existed, the dominant cost of building the database: measured at ~45%
   * of total build time for _makeAllP2lP2l() alone (see
   * tools/rfparity/profile.mjs), which iterates line-rank pairs (krank,
   * lrank) inside a loop over mark pairs, needlessly re-slicing the same
   * per-rank line list for every mark pair instead of once per rank pair.
   */
  _linesAtRank(rank) {
    if (!this._lineSnapshotCache.has(rank)) this._lineSnapshotCache.set(rank, [...this.lines.maps[rank].values()]);
    return this._lineSnapshotCache.get(rank);
  }

  // See _linesAtRank() — same memoization, for this.marks.maps[rank].
  _marksAtRank(rank) {
    if (!this._markSnapshotCache.has(rank)) this._markSnapshotCache.set(rank, [...this.marks.maps[rank].values()]);
    return this._markSnapshotCache.get(rank);
  }

  get context() {
    const s = this.settings;
    return {
      paper: this.paper,
      numX: s.numX, numY: s.numY, numA: s.numA, numD: s.numD,
      minAngleSine: s.minAngleSine,
      minAspectRatio: s.minAspectRatio,
      visibilityMatters: s.visibilityMatters,
      lineWorstCaseError: s.lineWorstCaseError
    };
  }

  get numLines() { return this.lines.totalSize; }
  get numMarks() { return this.marks.totalSize; }

  // CheckDatabaseStatus(): called after every attempt (valid or not) to
  // throttle how often onStatus actually fires. onStatus may return `true`
  // to request cancellation, matching the original's `haltFlag` out-param.
  _checkStatus(onStatus) {
    this._statusCount += 1;
    if (this._statusCount < this.settings.databaseStatusSkip) return;
    this._statusCount = 0;
    if (onStatus?.({ status: 'working', rank: this.curRank, numLines: this.numLines, numMarks: this.numMarks })) {
      throw new RfHalt();
    }
  }

  _addLine(candidate, onStatus) {
    this.lines.addCopyIfValidAndUnique(candidate);
    this._checkStatus(onStatus);
  }

  _addMark(candidate, onStatus) {
    this.marks.addCopyIfValidAndUnique(candidate);
    this._checkStatus(onStatus);
  }

  _lineBudgetLeft() {
    return this.numLines < this.settings.maxLines;
  }

  _markBudgetLeft() {
    return this.numMarks < this.settings.maxMarks;
  }

  // RefLine_C2P_C2P::MakeAll() — Axiom O1.
  _makeAllC2pC2p(arank, onStatus) {
    const ctx = this.context;
    for (let irank = 0; irank <= (arank - 1) / 2; irank += 1) {
      const jrank = arank - irank - 1;
      const sameRank = irank === jrank;
      const mi = this._marksAtRank(irank);
      const mj = this._marksAtRank(jrank);
      for (let i = sameRank ? 1 : 0; i < mi.length; i += 1) {
        const jEnd = sameRank ? i : mj.length;
        for (let j = 0; j < jEnd; j += 1) {
          if (!this._lineBudgetLeft()) return;
          this._addLine(new rfCreaseC2pC2p(mi[i], mj[j], ctx), onStatus);
        }
      }
    }
  }

  // RefLine_P2P::MakeAll() — Axiom O2.
  _makeAllP2p(arank, onStatus) {
    const ctx = this.context;
    for (let irank = 0; irank <= (arank - 1) / 2; irank += 1) {
      const jrank = arank - irank - 1;
      const sameRank = irank === jrank;
      const mi = this._marksAtRank(irank);
      const mj = this._marksAtRank(jrank);
      for (let i = sameRank ? 1 : 0; i < mi.length; i += 1) {
        const jEnd = sameRank ? i : mj.length;
        for (let j = 0; j < jEnd; j += 1) {
          if (!this._lineBudgetLeft()) return;
          this._addLine(new rfCreaseP2p(mi[i], mj[j], ctx), onStatus);
        }
      }
    }
  }

  // RefLine_L2L::MakeAll() — Axiom O3.
  _makeAllL2l(arank, onStatus) {
    const ctx = this.context;
    for (let irank = 0; irank <= (arank - 1) / 2; irank += 1) {
      const jrank = arank - irank - 1;
      const sameRank = irank === jrank;
      const li = this._linesAtRank(irank);
      const lj = this._linesAtRank(jrank);
      for (let i = sameRank ? 1 : 0; i < li.length; i += 1) {
        const jEnd = sameRank ? i : lj.length;
        for (let j = 0; j < jEnd; j += 1) {
          if (!this._lineBudgetLeft()) return;
          this._addLine(new rfCreaseL2l(li[i], lj[j], 0, ctx), onStatus);
          if (!this._lineBudgetLeft()) return;
          this._addLine(new rfCreaseL2l(li[i], lj[j], 1, ctx), onStatus);
        }
      }
    }
  }

  // RefLine_L2L_C2P::MakeAll() — Axiom O4.
  _makeAllL2lC2p(arank, onStatus) {
    const ctx = this.context;
    for (let irank = 0; irank <= arank - 1; irank += 1) {
      const jrank = arank - irank - 1;
      const li = this._linesAtRank(irank);
      const mj = this._marksAtRank(jrank);
      for (const l of li) {
        for (const m of mj) {
          if (!this._lineBudgetLeft()) return;
          this._addLine(new rfCreaseL2lC2p(l, m, ctx), onStatus);
        }
      }
    }
  }

  /**
   * RefLine_P2L_C2P::MakeAll() — Axiom O5.
   *
   * DELIBERATE FIX of a real bug in the original (ReferenceFinder.cpp
   * ~line 2429-2434): it constructs both iroot candidates (rlh1, rlh2) but
   * calls `AddCopyIfValidAndUnique(rlh1)` twice — a copy-paste mistake that
   * silently discards the second root every single time, halving this
   * axiom's yield. See REFERENCEFINDER_PLAN.md's Phase 2 notes: this was
   * flagged as a decision to make explicitly rather than replicate quietly.
   * Fixed here (adds rlh2, not a second copy of rlh1) because it's
   * unambiguously a typo, not a deliberate design choice — replicating it
   * would only make this port's search weaker than the axiom is capable of,
   * for no fidelity benefit (nothing downstream depends on O5 producing
   * exactly the original's — buggy — candidate set).
   */
  _makeAllP2lC2p(arank, onStatus) {
    const ctx = this.context;
    for (let irank = 0; irank <= arank - 1; irank += 1) {
      for (let jrank = 0; jrank <= arank - 1 - irank; jrank += 1) {
        const krank = arank - irank - jrank - 1;
        const mi = this._marksAtRank(irank);
        const lj = this._linesAtRank(jrank);
        const mk = this._marksAtRank(krank);
        for (let i = 0; i < mi.length; i += 1) {
          for (const l of lj) {
            for (let k = 0; k < mk.length; k += 1) {
              if (irank === krank && i === k) continue; // m1 must not be m2
              if (!this._lineBudgetLeft()) return;
              this._addLine(new rfCreaseP2lC2p(mi[i], l, mk[k], 0, ctx), onStatus);
              if (!this._lineBudgetLeft()) return;
              this._addLine(new rfCreaseP2lC2p(mi[i], l, mk[k], 1, ctx), onStatus);
            }
          }
        }
      }
    }
  }

  // RefLine_P2L_P2L::MakeAll() — Axiom O6 (the cubic). Point order doesn't
  // matter (p1/p2 dedup like the pair-avoidance pattern above); line order
  // DOES matter (l1/l2 range fully over each other, only self-identity is
  // excluded) since "p1 to l1 and p2 to l2" isn't the same alignment as
  // "p1 to l2 and p2 to l1".
  _makeAllP2lP2l(arank, onStatus) {
    const ctx = this.context;
    for (let psrank = 0; psrank <= arank - 1; psrank += 1) {
      for (let lsrank = 0; lsrank <= arank - 1 - psrank; lsrank += 1) {
        for (let irank = 0; irank <= psrank / 2; irank += 1) {
          const jrank = psrank - irank;
          const pSameRank = irank === jrank;
          const mi = this._marksAtRank(irank);
          const mj = this._marksAtRank(jrank);
          for (let i = pSameRank ? 1 : 0; i < mi.length; i += 1) {
            const jEnd = pSameRank ? i : mj.length;
            for (let j = 0; j < jEnd; j += 1) {
              for (let krank = 0; krank <= lsrank; krank += 1) {
                const lk = this._linesAtRank(krank);
                for (let lrank = 0; lrank <= lsrank - krank; lrank += 1) {
                  const ll = this._linesAtRank(lrank);
                  for (let k = 0; k < lk.length; k += 1) {
                    for (let l = 0; l < ll.length; l += 1) {
                      if (krank === lrank && k === l) continue; // l1 must not be l2 (same object)
                      if (!this._lineBudgetLeft()) return;
                      const m1 = mi[i], l1 = lk[k], m2 = mj[j], l2 = ll[l];
                      // RefLine_P2L_P2L's own constructor checks these four
                      // conditions (trivial/degenerate combinations) BEFORE
                      // ever touching the cubic — see ReferenceFinder.cpp
                      // ~line 2508. This port used to call
                      // solveP2LP2LCubic() unconditionally instead, which
                      // wasted the (expensive) cubic solve on combinations
                      // guaranteed to be rejected anyway, and — more
                      // importantly — skipped the `l1.equals(l2)` geometric
                      // check entirely (the `krank === lrank && k === l`
                      // guard above only catches the same *object* being
                      // picked twice, not two different-rank creases that
                      // happen to be the same line), which could seed the
                      // cubic with a genuinely degenerate/duplicate
                      // configuration the original would never construct.
                      if (l1.l.containsPoint(m1.p) || l2.l.containsPoint(m2.p)) continue;
                      if (m1.p.equals(m2.p) || l1.l.equals(l2.l)) continue;
                      const roots = solveP2LP2LCubic(m1.p, l1.l, m2.p, l2.l);
                      for (const rc of roots) {
                        if (!this._lineBudgetLeft()) return;
                        this._addLine(new rfCreaseP2lP2l(m1, l1, m2, l2, rc, ctx), onStatus);
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  // RefLine_L2L_P2L::MakeAll() — Axiom O7 (Hatori's axiom). l1/l2 are
  // asymmetric (fold l1 onto itself so p1 lands on l2), so only self-
  // identity is excluded, same as O6's line handling.
  _makeAllL2lP2l(arank, onStatus) {
    const ctx = this.context;
    for (let irank = 0; irank <= arank - 1; irank += 1) {
      for (let jrank = 0; jrank <= arank - 1 - irank; jrank += 1) {
        const krank = arank - irank - jrank - 1;
        const li = this._linesAtRank(irank);
        const mj = this._marksAtRank(jrank);
        const lk = this._linesAtRank(krank);
        for (let i = 0; i < li.length; i += 1) {
          for (const m of mj) {
            for (let k = 0; k < lk.length; k += 1) {
              if (irank === krank && i === k) continue; // l1 must not be l2
              if (!this._lineBudgetLeft()) return;
              this._addLine(new rfCreaseL2lP2l(li[i], m, lk[k], ctx), onStatus);
            }
          }
        }
      }
    }
  }

  // RefMark_Intersection::MakeAll().
  _makeAllIntersections(arank, onStatus) {
    const ctx = this.context;
    for (let irank = 0; irank <= arank / 2; irank += 1) {
      const jrank = arank - irank;
      const sameRank = irank === jrank;
      const li = this._linesAtRank(irank);
      const lj = this._linesAtRank(jrank);
      for (let i = sameRank ? 1 : 0; i < li.length; i += 1) {
        const jEnd = sameRank ? i : lj.length;
        for (let j = 0; j < jEnd; j += 1) {
          if (!this._markBudgetLeft()) return;
          this._addMark(new rfMarkIntersection(li[i], lj[j], ctx), onStatus);
        }
      }
    }
  }

  // ReferenceFinder::MakeAllMarksAndLinesOfRank().
  _makeAllOfRank(arank, onStatus) {
    this.curRank = arank;
    // Fresh per rank: maps[arank] itself is about to gain new entries (via
    // the two flushBuffer() calls below), so a snapshot cached under a
    // previous rank's build could be stale.
    this._lineSnapshotCache.clear();
    this._markSnapshotCache.clear();

    // Preference order matches the original: lines that don't require a
    // crease through a point first (hardest to fold accurately), then
    // single-point creases, then two-point creases. This order determines
    // which construction "wins" a given quantized key when two different
    // axioms would otherwise produce the same line.
    if (this.settings.useL2l) this._makeAllL2l(arank, onStatus);
    if (this.settings.useP2p) this._makeAllP2p(arank, onStatus);
    if (this.settings.useL2lP2l) this._makeAllL2lP2l(arank, onStatus);
    if (this.settings.useP2lP2l) this._makeAllP2lP2l(arank, onStatus);
    if (this.settings.useP2lC2p) this._makeAllP2lC2p(arank, onStatus);
    if (this.settings.useL2lC2p) this._makeAllL2lC2p(arank, onStatus);
    if (this.settings.useC2pC2p) this._makeAllC2pC2p(arank, onStatus);

    this.lines.flushBuffer();
    // lines.maps[arank] just gained this rank's lines — _makeAllIntersections()
    // below can read exactly that rank (when irank=0, jrank=arank), so any
    // cached snapshot of it from before the flush is now stale.
    this._lineSnapshotCache.clear();

    this._makeAllIntersections(arank, onStatus);
    this.marks.flushBuffer();

    if (onStatus?.({ status: 'rank-complete', rank: arank, numLines: this.numLines, numMarks: this.numMarks })) {
      throw new RfHalt();
    }
  }

  /**
   * ReferenceFinder::MakeAllMarksAndLines(): (re)builds the entire database
   * from scratch, from rank 0 (the paper's own edges and corners) up to
   * `settings.maxRank`.
   *
   * `onStatus(info)` is called periodically (throttled by
   * `settings.databaseStatusSkip`) and once per completed rank; return
   * `true` from it to cancel the build early (matching the original's
   * `haltFlag` out-param) — whatever was already flushed stays in the
   * database, same as the original's EXC_HALT handling.
   */
  makeAllMarksAndLines(onStatus) {
    this.lines._rebuild(this.settings.maxRank);
    this.marks._rebuild(this.settings.maxRank);
    this.curRank = 0;
    this._statusCount = 0;

    onStatus?.({ status: 'initializing', rank: 0, numLines: 0, numMarks: 0 });

    // Rank 0: the four edges and four corners of the paper.
    this.lines.add(new rfCreaseOriginal(this.paper.bottomEdge, 0, 'the bottom edge', this.context));
    this.lines.add(new rfCreaseOriginal(this.paper.leftEdge, 0, 'the left edge', this.context));
    this.lines.add(new rfCreaseOriginal(this.paper.rightEdge, 0, 'the right edge', this.context));
    this.lines.add(new rfCreaseOriginal(this.paper.topEdge, 0, 'the top edge', this.context));
    this.marks.add(new rfMarkOriginal(this.paper.botLeft, 0, 'the bottom left corner', this.context));
    this.marks.add(new rfMarkOriginal(this.paper.botRight, 0, 'the bottom right corner', this.context));
    this.marks.add(new rfMarkOriginal(this.paper.topLeft, 0, 'the top left corner', this.context));
    this.marks.add(new rfMarkOriginal(this.paper.topRight, 0, 'the top right corner', this.context));

    if (onStatus?.({ status: 'rank-complete', rank: 0, numLines: this.numLines, numMarks: this.numMarks })) {
      this.lines.flushBuffer();
      this.marks.flushBuffer();
      return;
    }

    // Rank 1: the two diagonals.
    this.lines.add(new rfCreaseOriginal(this.paper.upwardDiagonal, 1, 'the upward diagonal', this.context));
    this.lines.add(new rfCreaseOriginal(this.paper.downwardDiagonal, 1, 'the downward diagonal', this.context));
    this.lines.flushBuffer();
    this.marks.flushBuffer();

    try {
      for (let rank = 1; rank <= this.settings.maxRank; rank += 1) {
        this._makeAllOfRank(rank, onStatus);
      }
    } catch (err) {
      if (!(err instanceof RfHalt)) throw err;
      this.lines.flushBuffer();
      this.marks.flushBuffer();
    }

    this.lines.clearMaps();
    this.marks.clearMaps();

    onStatus?.({ status: 'ready', rank: this.curRank, numLines: this.numLines, numMarks: this.numMarks });
  }

  /**
   * Plain, JSON-safe snapshot of this (already-built) engine's database —
   * see rfDatabaseCache.js. Not part of the original: makeAllMarksAndLines()
   * only depends on paper size + settings, never on the tree being edited,
   * so this lets a caller (referenceFinderWorker.js) cache the result across
   * page loads instead of rebuilding it every time — see
   * REFERENCEFINDER_PLAN.md's Fase 6.
   */
  exportForCache() {
    return serializeEngine(this);
  }

  /**
   * Populates this engine directly from a previously exportForCache()'d
   * snapshot, skipping makeAllMarksAndLines() entirely. The caller is
   * responsible for only doing this when `data.settings`/paper size
   * actually match this engine's own (see rfDatabaseCache.js's doc comment
   * and referenceFinderWorker.js's cache-key logic) — this method itself
   * doesn't re-check that.
   */
  loadFromCache(data) {
    const { marks, creases } = restoreDatabase(data);
    this.marks.all = marks;
    this.lines.all = creases;
  }

  // ReferenceFinder::FindBestMarks(): the `numMarks` marks closest to `point`.
  findBestMarks(point, numMarks) {
    const distances = this.marks.all.map(mark => mark.distanceTo(point));
    return this.marks.all
      .map((mark, i) => ({ mark, distance: distances[i] }))
      .sort((a, b) => compareRankAndError(a.mark, b.mark, a.distance, b.distance, this.settings.goodEnoughError))
      .slice(0, numMarks)
      .map(({ mark }) => mark);
  }

  // ReferenceFinder::FindBestLines(): the `numLines` creases closest to `line`.
  findBestLines(line, numLines) {
    const context = this.context;
    const distances = this.lines.all.map(crease => crease.distanceTo(line, context));
    return this.lines.all
      .map((crease, i) => ({ crease, distance: distances[i] }))
      .sort((a, b) => compareRankAndError(a.crease, b.crease, a.distance, b.distance, this.settings.goodEnoughError))
      .slice(0, numLines)
      .map(({ crease }) => crease);
  }

  // ReferenceFinder::ValidateMark(): true if `point` lies within the paper.
  validateMark(point) {
    if (point.x < 0 || point.x > this.paper.width) {
      return { valid: false, error: `Error -- x coordinate should lie between 0 and ${this.paper.width}` };
    }
    if (point.y < 0 || point.y > this.paper.height) {
      return { valid: false, error: `Error -- y coordinate should lie between 0 and ${this.paper.height}` };
    }
    return { valid: true, error: null };
  }

  // ReferenceFinder::ValidateLine(): true if the two points are distinct.
  validateLine(p1, p2) {
    const RF_EPS = 1.0e-8;
    if (p1.subtract(p2).mag() > RF_EPS) return { valid: true, error: null };
    return { valid: false, error: `Error -- the two points must be distinct (separated by at least ${RF_EPS}).` };
  }
}

// Maps each mark/crease class to the plain string tag buildFoldSequence()
// puts in its serialized output, so callers (the UI, or a Web Worker
// boundary) don't need to import every class just to branch on `instanceof`.
const KIND_BY_CLASS = new Map([
  [rfMarkOriginal, 'markOriginal'],
  [rfMarkIntersection, 'markIntersection'],
  [rfCreaseOriginal, 'creaseOriginal'],
  [rfCreaseC2pC2p, 'creaseC2pC2p'],
  [rfCreaseP2p, 'creaseP2p'],
  [rfCreaseL2l, 'creaseL2l'],
  [rfCreaseL2lC2p, 'creaseL2lC2p'],
  [rfCreaseP2lC2p, 'creaseP2lC2p'],
  [rfCreaseP2lP2l, 'creaseP2lP2l'],
  [rfCreaseL2lP2l, 'creaseL2lP2l']
]);

/**
 * RefBase::BuildAndNumberSequence() + a plain-data serialization of the
 * result: the ordered list of every mark/crease needed to construct
 * `target`, each written as a JSON-safe descriptor (no class instances or
 * circular references — safe to postMessage() across a Web Worker
 * boundary). `refs` on each step are indices into the SAME returned array,
 * always pointing earlier (a step's prerequisites always appear before it,
 * since sequencePushSelf() only ever pushes a mark/crease after its own
 * prerequisites).
 *
 * This is the plain-data analog of the original's PutHowtoSequence(): the
 * original renders English sentences directly from the live object graph;
 * this port hands back structured data instead, so Phase 5 (the Inspector
 * UI) can render it with this project's own i18n strings.
 */
export function buildFoldSequence(target) {
  resetMarkIndexCounter();
  resetCreaseIndexCounter();

  const sequence = [];
  target.sequencePushSelf(sequence);
  sequence.forEach(item => item.setIndex());

  const indexOf = new Map(sequence.map((item, i) => [item, i]));
  return sequence.map((item) => {
    const kind = KIND_BY_CLASS.get(item.constructor) ?? 'unknown';
    const step = {
      kind,
      rank: item.rank,
      // RefMark/RefLine's own per-type index (see RefBase::SetIndex()), used
      // to reproduce the original's P-Z / A-J lettering — see stepLabel().
      index: item.index,
      refs: item.prerequisites().map(ref => indexOf.get(ref))
    };
    if ('p' in item) step.point = { x: item.p.x, y: item.p.y };
    if ('l' in item) step.line = { d: item.l.d, u: { x: item.l.u.x, y: item.l.u.y } };
    if ('name' in item) step.name = item.name;
    if ('whoMoves' in item) step.whoMoves = item.whoMoves;
    return step;
  });
}

// RefMark::sLabels / RefLine::sLabels: the letter alphabets the original
// assigns marks and lines in a fold sequence (independent counters — see
// rfMark.js's resetMarkIndexCounter() doc comment). "Original" marks/creases
// (index 0, i.e. rfMarkOriginal/rfCreaseOriginal) get no letter — they're
// already named (a corner, an edge, a diagonal), matching GetLabel()'s
// original-type overrides.
export const MARK_LABELS = 'PQRSTUVWXYZ';
export const CREASE_LABELS = 'ABCDEFGHIJ';

export function stepLabel(step) {
  if (!step.index) return null;
  const isMark = step.kind.startsWith('mark');
  const alphabet = isMark ? MARK_LABELS : CREASE_LABELS;
  return alphabet[(step.index - 1) % alphabet.length];
}
