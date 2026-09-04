/**
 * rfMark.js
 * A reference mark (point) found on the paper, together with the pedigree
 * (which lines it's the intersection of, or which named corner it is) that
 * produced it. Equivalent to RefMark / RefMark_Original / RefMark_Intersection
 * in original/ReferenceFinder/source/model/ReferenceFinder.h.
 *
 * Distinct from rfPoint.js: a rfPoint is bare 2D geometry; a rfMark is a node
 * in the search graph — it carries a rank (how many creases it takes to
 * make), a construction history (for the fold sequence), and a `key` used to
 * deduplicate near-identical marks (see finishConstructor()).
 *
 * The original reads engine-wide settings (paper size, sNumX/sNumY,
 * sMinAngleSine) directly off the static ReferenceFinder class inside these
 * constructors. This port takes them instead as an explicit `context`
 * parameter — `{ paper, numX, numY, minAngleSine }` — so rfMark.js has no
 * dependency on rfEngine.js (same decoupling as rfPaper.js's
 * makesSkinnyFlap(); see REFERENCEFINDER_PLAN.md section 2). rfEngine.js
 * (Phase 3) owns the canonical settings and passes this same shape down to
 * every mark/crease it constructs.
 *
 * A mark that fails validation during construction (e.g. two lines that
 * don't actually cross within the paper) is left with `valid = false` and
 * `key = null` — mirroring the original's pattern of an early `return` from
 * the constructor before FinishConstructor() runs, rather than throwing.
 */

const RF_EPS = 1.0e-8;

// RefMark::sCount: numbers marks 1, 2, 3... independently of rfCrease's own
// counter (original has a SEPARATE RefLine::sCount — marks and creases each
// get their own label alphabet, P-Z for marks and A-J for lines, even though
// they're numbered while walking a single interleaved fold sequence — see
// buildAndNumberSequence() in rfEngine.js, Phase 3).
let markIndexCounter = 0;

// RefMark::CalcMarkRank(ar1, ar2) — the shared static helper (also declared
// as a RefMark member, but it's pure and takes no `this`, so it's a plain
// function here).
export function calcMarkRank(a, b) {
  return a.rank + b.rank;
}

export class rfMark {
  constructor(p, rank) {
    this.p = p; // rfPoint
    this.rank = rank;
    this.key = null; // set by finishConstructor(); null means "not yet valid"
    this.valid = false;
    this.index = 0; // assigned by buildAndNumberSequence()
  }

  // FinishConstructor(): computes the dedup key from this mark's position,
  // quantized into an sNumX x sNumY grid over the paper. Call this at the
  // end of every subclass constructor, but ONLY if the mark is otherwise
  // valid (matching the original's convention).
  finishConstructor(context) {
    const fx = this.p.x / context.paper.width;
    const fy = this.p.y / context.paper.height;
    const nx = Math.floor(0.5 + fx * context.numX);
    const ny = Math.floor(0.5 + fy * context.numY);
    this.key = 1 + nx * context.numY + ny;
    this.valid = true;
  }

  // DistanceTo(ap)
  distanceTo(point) {
    return this.p.subtract(point).mag();
  }

  // IsOnEdge()
  isOnEdge(paper) {
    return (
      paper.leftEdge.containsPoint(this.p) ||
      paper.rightEdge.containsPoint(this.p) ||
      paper.topEdge.containsPoint(this.p) ||
      paper.bottomEdge.containsPoint(this.p)
    );
  }

  // IsActionLine(): marks are never actions.
  isActionLine() {
    return false;
  }

  // UsesImmediate(rb): default false, overridden by rfMarkIntersection.
  usesImmediate(_other) {
    return false;
  }

  // Not part of the original: the marks/creases this one was directly built
  // from, in the same order sequencePushSelf() visits them. Generic
  // counterpart to usesImmediate()'s membership test — used by
  // rfEngine.js's buildFoldSequence() to describe a result's pedigree
  // without a type-switch per axiom.
  prerequisites() {
    return [];
  }

  // IsDerived(): true by default, overridden by rfMarkOriginal.
  isDerived() {
    return true;
  }

  // SequencePushSelf(): appends this mark (and, in subclasses, its
  // prerequisites first) to `sequence` if not already present. `sequence` is
  // passed explicitly rather than kept as a RefBase static, so multiple
  // sequences (or concurrent searches) never collide — see rfEngine.js.
  sequencePushSelf(sequence) {
    if (!sequence.includes(this)) sequence.push(this);
  }

  // SetIndex(): most marks take the next number from a shared counter reset
  // per fold-sequence build (see buildAndNumberSequence() below);
  // rfMarkOriginal overrides this to stay unindexed (index 0).
  setIndex() {
    markIndexCounter += 1;
    this.index = markIndexCounter;
  }
}

// RefMark_Original: a named mark, like a paper corner.
export class rfMarkOriginal extends rfMark {
  constructor(p, rank, name, context) {
    super(p, rank);
    this.name = name;
    this.finishConstructor(context); // always valid
  }

  isDerived() {
    return false;
  }

  // Overridden because named marks don't use the shared index counter.
  setIndex() {
    this.index = 0;
  }
}

// RefMark_Intersection: the intersection of two rfCreases, if it exists,
// falls within the paper, and crosses at a shallow-enough angle to be a
// numerically reliable reference point.
export class rfMarkIntersection extends rfMark {
  constructor(crease1, crease2, context) {
    super(null, calcMarkRank(crease1, crease2));
    this.crease1 = crease1;
    this.crease2 = crease2;

    const l1 = crease1.l;
    const u1 = l1.u;
    const l2 = crease2.l;
    const u2 = l2.u;

    const p = l1.intersectLine(l2);
    if (!p) return; // lines don't intersect
    this.p = p;

    if (!context.paper.encloses(p)) return;

    // Intersections at less than a 30-degree angle (by default) are
    // imprecise to use as reference points.
    if (Math.abs(u1.dot(u2.rotate90())) < context.minAngleSine) return;

    this.finishConstructor(context);
  }

  usesImmediate(other) {
    return other === this.crease1 || other === this.crease2;
  }

  prerequisites() {
    return [this.crease1, this.crease2];
  }

  sequencePushSelf(sequence) {
    this.crease1.sequencePushSelf(sequence);
    this.crease2.sequencePushSelf(sequence);
    super.sequencePushSelf(sequence);
  }
}

// RefMark::ResetCount(). rfCrease.js has its own matching
// resetCreaseIndexCounter() for RefLine::ResetCount() — see rfEngine.js's
// buildAndNumberSequence() (Phase 3), which calls both before renumbering a
// fresh fold sequence, exactly as RefBase::BuildAndNumberSequence() does.
export function resetMarkIndexCounter() {
  markIndexCounter = 0;
}
