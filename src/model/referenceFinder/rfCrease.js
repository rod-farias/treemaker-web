/**
 * rfCrease.js
 * A candidate crease (fold line) found on the paper, together with the
 * pedigree (which marks/creases it was built from, via which Huzita-Hatori
 * axiom) that produced it. Equivalent to RefLine / RefLine_Original / the
 * seven RefLine_* axiom subclasses in
 * original/ReferenceFinder/source/model/ReferenceFinder.h.
 *
 * Named "rfCrease" rather than "rfLine" to avoid colliding with rfLine.js
 * (XYLine — bare line geometry, which every rfCrease wraps as `this.l`): see
 * REFERENCEFINDER_PLAN.md section 2.
 *
 * Like rfMark.js, every constructor takes an explicit `context` — the
 * subset of `{ paper, numA, numD, minAngleSine, minAspectRatio,
 * visibilityMatters, lineWorstCaseError }` it needs — instead of reading
 * engine-wide settings off a static ReferenceFinder class, so this module
 * has no dependency on rfEngine.js (Phase 3).
 *
 * PutHowto()/PutName()/DrawSelf() (the original's English sentence
 * generation and diagram drawing) are deliberately NOT ported here — they're
 * presentation concerns, redone in Phase 5 against this project's own i18n
 * strings, driven by each crease's `whoMoves`/pedigree fields rather than by
 * porting hardcoded English templates.
 */

import { rfPoint, midPoint } from './rfPoint.js';
import { rfLine } from './rfLine.js';

const RF_EPS = 1.0e-8;

let creaseIndexCounter = 0;

// RefLine::CalcLineRank(...) overloads (2, 3, or 4 prerequisites).
export function calcCreaseRank(...refs) {
  return 1 + refs.reduce((sum, ref) => sum + ref.rank, 0);
}

// RefLine base class.
export class rfCrease {
  constructor(l, rank) {
    this.l = l; // rfLine, or null until the subclass constructor sets it
    this.rank = rank;
    this.key = null;
    this.valid = false;
    this.index = 0;
  }

  // FinishConstructor(): resolves the line's orientation ambiguity (d>=0)
  // and computes the dedup key from (angle, distance-from-origin), each
  // quantized into an sNumA/sNumD grid.
  finishConstructor(context) {
    if (this.l.d < 0) {
      this.l.d = -this.l.d;
      this.l.u = this.l.u.scale(-1);
    }

    let fa = (1 + Math.atan2(this.l.u.y, this.l.u.x) / Math.PI) / 2; // 0..1
    const dmax = Math.sqrt(context.paper.width ** 2 + context.paper.height ** 2);
    const fd = this.l.d / dmax;

    const nd = Math.floor(0.5 + fd * context.numD);
    if (nd === 0) fa = (2 * fa) % 1; // d=0: alpha and pi+alpha map to the same key
    const na = Math.floor(0.5 + fa * context.numA);
    this.key = 1 + na * context.numD + nd;
    this.valid = true;
  }

  // DistanceTo(al)
  distanceTo(otherLine, context) {
    if (context.lineWorstCaseError) {
      const clipped1 = context.paper.clipLine(this.l);
      const clipped2 = context.paper.clipLine(otherLine);
      if (clipped1 && clipped2) {
        const { p1: p1a, p2: p1b } = clipped1;
        const { p1: p2a, p2: p2b } = clipped2;
        const err1 = Math.max(p1a.subtract(p2a).mag(), p1b.subtract(p2b).mag());
        const err2 = Math.max(p1a.subtract(p2b).mag(), p1b.subtract(p2a).mag());
        return Math.min(err1, err2);
      }
      return 1 / RF_EPS; // lines don't intersect the paper: very large number
    }
    return Math.sqrt(
      this.l.u.dot(otherLine.u.rotate90()) ** 2 +
      (this.l.d - otherLine.d * this.l.u.dot(otherLine.u)) ** 2
    );
  }

  // IsOnEdge()
  isOnEdge(paper) {
    return (
      paper.leftEdge.equals(this.l) || paper.topEdge.equals(this.l) ||
      paper.rightEdge.equals(this.l) || paper.bottomEdge.equals(this.l)
    );
  }

  // IsActionLine(): true for most creases (they're folds the user makes);
  // rfCreaseOriginal overrides this to false.
  isActionLine() {
    return true;
  }

  usesImmediate(_other) {
    return false;
  }

  isDerived() {
    return true;
  }

  // See rfMark.js's prerequisites() doc comment.
  prerequisites() {
    return [];
  }

  sequencePushSelf(sequence) {
    if (!sequence.includes(this)) sequence.push(this);
  }

  setIndex() {
    creaseIndexCounter += 1;
    this.index = creaseIndexCounter;
  }
}

// RefLine::ResetCount(). See rfMark.js's resetMarkIndexCounter() for why
// this is a separate counter from marks'.
export function resetCreaseIndexCounter() {
  creaseIndexCounter = 0;
}

// RefLine_Original: the edge of the paper, or an initial crease (e.g. a
// diagonal) present before any folding.
export class rfCreaseOriginal extends rfCrease {
  constructor(l, rank, name, context) {
    super(l, rank);
    this.name = name;
    this.finishConstructor(context); // always valid
  }

  isActionLine() {
    return false; // present from the start, not something the user folds
  }

  isDerived() {
    return false;
  }

  setIndex() {
    this.index = 0;
  }
}

// RefLine_C2P_C2P - Huzita-Hatori Axiom O1: crease through two points.
export class rfCreaseC2pC2p extends rfCrease {
  constructor(mark1, mark2, context) {
    super(new rfLine(), calcCreaseRank(mark1, mark2));
    this.mark1 = mark1;
    this.mark2 = mark2;

    const p1 = mark1.p;
    const p2 = mark2.p;
    this.l.u = p2.subtract(p1).rotate90().normalize();
    this.l.d = midPoint(p1, p2).dot(this.l.u);

    // Always visible; skip straight to the skinny-flap check.
    if (context.paper.makesSkinnyFlap(this.l, context.minAspectRatio)) return;
    this.finishConstructor(context);
  }

  usesImmediate(other) {
    return other === this.mark1 || other === this.mark2;
  }

  prerequisites() {
    return [this.mark1, this.mark2];
  }

  sequencePushSelf(sequence) {
    this.mark1.sequencePushSelf(sequence);
    this.mark2.sequencePushSelf(sequence);
    super.sequencePushSelf(sequence);
  }
}

// RefLine_P2P - Huzita-Hatori Axiom O2: bring p1 to p2.
export class rfCreaseP2p extends rfCrease {
  constructor(mark1, mark2, context) {
    super(new rfLine(), calcCreaseRank(mark1, mark2));
    this.mark1 = mark1;
    this.mark2 = mark2;

    const p1 = mark1.p;
    const p2 = mark2.p;
    this.l.u = p2.subtract(p1).normalize();
    this.l.d = midPoint(p1, p2).dot(this.l.u);

    const p1edge = mark1.isOnEdge(context.paper);
    const p2edge = mark2.isOnEdge(context.paper);
    if (context.visibilityMatters) {
      if (p1edge) this.whoMoves = 'p1';
      else if (p2edge) this.whoMoves = 'p2';
      else return;
    } else {
      this.whoMoves = 'p1';
    }

    if (context.paper.makesSkinnyFlap(this.l, context.minAspectRatio)) return;
    this.finishConstructor(context);
  }

  usesImmediate(other) {
    return other === this.mark1 || other === this.mark2;
  }

  prerequisites() {
    return this.whoMoves === 'p1' ? [this.mark2, this.mark1] : [this.mark1, this.mark2];
  }

  sequencePushSelf(sequence) {
    if (this.whoMoves === 'p1') { this.mark2.sequencePushSelf(sequence); this.mark1.sequencePushSelf(sequence); }
    else { this.mark1.sequencePushSelf(sequence); this.mark2.sequencePushSelf(sequence); }
    super.sequencePushSelf(sequence);
  }
}

// RefLine_L2L - Huzita-Hatori Axiom O3: bring line l1 to line l2. iroot
// selects which of the two angle bisectors (0 or 1).
export class rfCreaseL2l extends rfCrease {
  constructor(crease1, crease2, iroot, context) {
    super(new rfLine(), calcCreaseRank(crease1, crease2));
    this.crease1 = crease1;
    this.crease2 = crease2;

    const l1 = crease1.l;
    const u1 = l1.u;
    const l2 = crease2.l;
    const u2 = l2.u;

    if (l1.isParallelTo(l2)) {
      if (iroot !== 0) return; // iroot=1 isn't valid for parallel lines
      this.l.u = u1;
      this.l.d = 0.5 * (l1.d + l2.d * u2.dot(u1));
    } else {
      this.l.u = (iroot === 0 ? u1.add(u2) : u1.subtract(u2)).normalize();
      this.l.d = l1.intersectLine(l2).dot(this.l.u);
    }

    if (!context.paper.interiorOverlaps(this.l)) return;

    const l1edge = crease1.isOnEdge(context.paper);
    const l2edge = crease2.isOnEdge(context.paper);
    if (context.visibilityMatters) {
      if (l1edge) this.whoMoves = 'l1';
      else if (l2edge) this.whoMoves = 'l2';
      else {
        const clipped1 = context.paper.clipLine(l1);
        if (clipped1 && context.paper.encloses(this.l.fold(clipped1.p1)) && context.paper.encloses(this.l.fold(clipped1.p2))) {
          this.whoMoves = 'l1';
        } else {
          const clipped2 = context.paper.clipLine(l2);
          if (clipped2 && context.paper.encloses(this.l.fold(clipped2.p1)) && context.paper.encloses(this.l.fold(clipped2.p2))) {
            this.whoMoves = 'l2';
          } else return;
        }
      }
    } else {
      this.whoMoves = 'l1';
    }

    if (context.paper.makesSkinnyFlap(this.l, context.minAspectRatio)) return;
    this.finishConstructor(context);
  }

  usesImmediate(other) {
    return other === this.crease1 || other === this.crease2;
  }

  prerequisites() {
    return this.whoMoves === 'l1' ? [this.crease2, this.crease1] : [this.crease1, this.crease2];
  }

  sequencePushSelf(sequence) {
    if (this.whoMoves === 'l1') { this.crease2.sequencePushSelf(sequence); this.crease1.sequencePushSelf(sequence); }
    else { this.crease1.sequencePushSelf(sequence); this.crease2.sequencePushSelf(sequence); }
    super.sequencePushSelf(sequence);
  }
}

// RefLine_L2L_C2P - Huzita-Hatori Axiom O4: bring line l1 to itself so the
// crease passes through point p1 (a perpendicular through p1).
export class rfCreaseL2lC2p extends rfCrease {
  constructor(crease1, mark1, context) {
    super(new rfLine(), calcCreaseRank(crease1, mark1));
    this.crease1 = crease1;
    this.mark1 = mark1;

    const u1 = crease1.l.u;
    const d1 = crease1.l.d;
    const p1 = mark1.p;

    this.l.u = u1.rotate90();
    this.l.d = p1.dot(this.l.u);

    // The intersection of the fold line with l1 (the projection of p1 onto
    // l1) must lie within the paper.
    const p1p = p1.add(u1.scale(d1 - p1.dot(u1)));
    if (!context.paper.encloses(p1p)) return;

    // Always visible; skip straight to the skinny-flap check.
    if (context.paper.makesSkinnyFlap(this.l, context.minAspectRatio)) return;
    this.finishConstructor(context);
  }

  usesImmediate(other) {
    return other === this.crease1 || other === this.mark1;
  }

  prerequisites() {
    return [this.mark1, this.crease1];
  }

  sequencePushSelf(sequence) {
    this.mark1.sequencePushSelf(sequence);
    this.crease1.sequencePushSelf(sequence);
    super.sequencePushSelf(sequence);
  }
}

// RefLine_P2L_C2P - Huzita-Hatori Axiom O5: bring point p1 to line l1 so the
// crease passes through point p2. iroot selects which of up to 2 solutions.
export class rfCreaseP2lC2p extends rfCrease {
  constructor(mark1, crease1, mark2, iroot, context) {
    super(new rfLine(), calcCreaseRank(mark1, crease1, mark2));
    this.mark1 = mark1;
    this.crease1 = crease1;
    this.mark2 = mark2;

    const p1 = mark1.p;
    const l1 = crease1.l;
    const u1 = l1.u;
    const d1 = l1.d;
    const p2 = mark2.p;

    // Trivial Haga construction if either point is already on the line.
    if (l1.containsPoint(p1) || l1.containsPoint(p2)) return;

    const a = d1 - p2.dot(u1);
    const b2 = p2.subtract(p1).mag2() - a * a;
    if (b2 < 0) return; // no real solution

    const b = Math.sqrt(b2);
    if (b < RF_EPS && iroot === 1) return; // degenerate: only one solution

    const u1p = u1.rotate90();
    let p1p = p2.add(u1.scale(a));
    p1p = iroot === 0 ? p1p.add(u1p.scale(b)) : p1p.subtract(u1p.scale(b));

    if (!context.paper.encloses(p1p)) return;

    this.l.u = p1p.subtract(p1).normalize();
    this.l.d = p2.dot(this.l.u);

    const p1edge = mark1.isOnEdge(context.paper);
    const l1edge = crease1.isOnEdge(context.paper);
    if (context.visibilityMatters) {
      if (p1edge) this.whoMoves = 'p1';
      else if (l1edge) this.whoMoves = 'l1';
      else return;
    } else {
      this.whoMoves = 'p1';
    }

    if (context.paper.makesSkinnyFlap(this.l, context.minAspectRatio)) return;
    this.finishConstructor(context);
  }

  usesImmediate(other) {
    return other === this.crease1 || other === this.mark1 || other === this.mark2;
  }

  prerequisites() {
    const moving = this.whoMoves === 'p1' ? [this.crease1, this.mark1] : [this.mark1, this.crease1];
    return [this.mark2, ...moving];
  }

  sequencePushSelf(sequence) {
    this.mark2.sequencePushSelf(sequence);
    if (this.whoMoves === 'p1') { this.crease1.sequencePushSelf(sequence); this.mark1.sequencePushSelf(sequence); }
    else { this.mark1.sequencePushSelf(sequence); this.crease1.sequencePushSelf(sequence); }
    super.sequencePushSelf(sequence);
  }
}

// CubeRoot(x): the real cube root, extended to negative x (unlike Math.cbrt,
// which the original doesn't use here — kept as pow-based to match exactly).
function cubeRoot(x) {
  return x >= 0 ? x ** (1 / 3) : -((-x) ** (1 / 3));
}

/**
 * Solves the cubic (or lower-order, if the leading coefficients vanish)
 * equation behind Huzita-Hatori Axiom O6, for the fold parameter `rc` along
 * the perpendicular to l1 through d1*u1 (see rfCreaseP2lP2l below for how
 * `rc` becomes an actual candidate line).
 *
 * Ported from the shared math in RefLine_P2L_P2L's constructor (iroot==0
 * case) plus the iroot==1/iroot==2 branches that reuse it. The original
 * spreads this single derivation across 3 separate constructor calls that
 * communicate through mutable class-static scratch variables (order,
 * irootMax, q1, q2, S, Sr, Si, U) — fragile, and only correct if those 3
 * calls happen in order (0, then 1, then 2) with nothing else touching
 * RefLine_P2L_P2L's statics in between. This port instead computes every
 * real root up front as a plain array, in the same order the original's
 * iroot 0/1/2 would produce them, so rfEngine.js (Phase 3) can construct 0
 * to 3 independent rfCreaseP2lP2l candidates from it directly.
 *
 * Preserves an original quirk: the doubled-root case (`order === 3 && D≈0`)
 * takes `Math.pow(R, 1/3)` rather than the odd-extended cubeRoot() used just
 * above it for D>0 — for negative R this yields NaN (as it did in the
 * original's `pow(R, 1./3)` on a negative double), not a real cube root. Not
 * "fixed" here, to keep this port's roots bit-for-bit comparable to the
 * original's for every case that isn't already on this knife-edge.
 */
export function solveP2LP2LCubic(p1, l1, p2, l2) {
  const u1 = l1.u;
  const d1 = l1.d;
  const u2 = l2.u;
  const d2 = l2.d;
  const u1p = u1.rotate90();

  const v1 = p1.add(u1.scale(d1)).subtract(p2.scale(2));
  const v2 = u1.scale(d1).subtract(p1);

  const c1 = p2.dot(u2) - d2;
  const c2 = 2 * v2.dot(u1p);
  const c3 = v2.dot(v2);
  const c4 = v1.add(v2).dot(u1p);
  const c5 = v1.dot(v2);
  const c6 = u1p.dot(u2);
  const c7 = v2.dot(u2);

  const a = c6;
  const b = c1 + c4 * c6 + c7;
  const c = c1 * c2 + c5 * c6 + c4 * c7;
  const d = c1 * c3 + c5 * c7;

  if (Math.abs(a) > RF_EPS) {
    // Cubic: Cardano's formula.
    const a2 = b / a;
    const a1 = c / a;
    const a0 = d / a;
    const Q = (3 * a1 - a2 ** 2) / 9;
    const R = (9 * a2 * a1 - 27 * a0 - 2 * a2 ** 3) / 54;
    const D = Q ** 3 + R ** 2;
    const U = -a2 / 3;

    if (D > 0) {
      const rD = Math.sqrt(D);
      const S = cubeRoot(R + rD);
      const T = cubeRoot(R - rD);
      return [U + S + T];
    }
    if (Math.abs(D) < RF_EPS) {
      const S = R ** (1 / 3); // see doc comment: intentionally not cubeRoot()
      return [U + 2 * S, U - S];
    }
    const rD = Math.sqrt(-D);
    const phi = Math.atan2(rD, R) / 3;
    const rS = (R ** 2 - D) ** (1 / 6);
    const Sr = rS * Math.cos(phi);
    const Si = rS * Math.sin(phi);
    return [U + 2 * Sr, U - Sr - Math.sqrt(3) * Si, U - Sr + Math.sqrt(3) * Si];
  }
  if (Math.abs(b) > RF_EPS) {
    // Quadratic.
    const disc = c ** 2 - 4 * b * d;
    const q1 = -c / (2 * b);
    if (disc < 0) return [];
    if (Math.abs(disc) < RF_EPS) return [q1];
    const q2 = Math.sqrt(disc) / (2 * b);
    return [q1 + q2, q1 - q2];
  }
  if (Math.abs(c) > RF_EPS) return [-d / c]; // linear
  return []; // ill-formed: no variables
}

// RefLine_P2L_P2L - Huzita-Hatori Axiom O6 (the cubic): bring point p1 to
// line l1 and point p2 to line l2. `rc` is one root from solveP2LP2LCubic().
export class rfCreaseP2lP2l extends rfCrease {
  constructor(mark1, crease1, mark2, crease2, rc, context) {
    super(new rfLine(), calcCreaseRank(mark1, crease1, mark2, crease2));
    this.mark1 = mark1;
    this.crease1 = crease1;
    this.mark2 = mark2;
    this.crease2 = crease2;

    const p1 = mark1.p;
    const l1 = crease1.l;
    const u1 = l1.u;
    const d1 = l1.d;
    const p2 = mark2.p;
    const l2 = crease2.l;
    const u1p = u1.rotate90();

    // Trivial/degenerate configurations, matching the original's own
    // constructor order (checked before ever touching the cubic equation).
    // rfEngine.js's _makeAllP2lP2l() already checks these itself — more
    // cheaply, before calling solveP2LP2LCubic() at all — but they're
    // repeated here too so this class rejects them correctly even when
    // constructed directly (e.g. from a test), not just via the search loop.
    if (l1.containsPoint(p1) || l2.containsPoint(p2)) return;
    if (p1.equals(p2) || l1.equals(l2)) return;

    const p1p = u1.scale(d1).add(u1p.scale(rc));
    if (p1p.equals(p1)) return; // p1 must be off the fold line

    this.l.u = p1p.subtract(p1).normalize();
    this.l.d = this.l.u.dot(midPoint(p1p, p1));
    const p2p = this.l.fold(p2);

    if (!context.paper.encloses(p1p) || !context.paper.encloses(p2p)) return;

    const sameSide = (p1.dot(this.l.u) - this.l.d) * (p2.dot(this.l.u) - this.l.d) >= 0;
    const p1edge = mark1.isOnEdge(context.paper);
    const p2edge = mark2.isOnEdge(context.paper);
    const l1edge = crease1.isOnEdge(context.paper);
    const l2edge = crease2.isOnEdge(context.paper);

    if (context.visibilityMatters) {
      if (sameSide) {
        if (p1edge && p2edge) this.whoMoves = 'p1p2';
        else if (l1edge && l2edge) this.whoMoves = 'l1l2';
        else return;
      } else if (p1edge && l2edge) this.whoMoves = 'p1l2';
      else if (p2edge && l1edge) this.whoMoves = 'p2l1';
      else return;
    } else {
      this.whoMoves = sameSide ? 'p1p2' : 'p1l2';
    }

    if (context.paper.makesSkinnyFlap(this.l, context.minAspectRatio)) return;
    this.finishConstructor(context);
  }

  usesImmediate(other) {
    return other === this.crease1 || other === this.mark1 || other === this.crease2 || other === this.mark2;
  }

  // Order matches sequencePushSelf() below exactly, per whoMoves.
  prerequisites() {
    switch (this.whoMoves) {
      case 'p1p2': return [this.crease2, this.crease1, this.mark2, this.mark1];
      case 'l1l2': return [this.mark2, this.mark1, this.crease2, this.crease1];
      case 'p1l2': return [this.crease2, this.mark2, this.mark1, this.crease1];
      case 'p2l1': return [this.crease1, this.mark1, this.mark2, this.crease2];
      default: return [];
    }
  }

  sequencePushSelf(sequence) {
    switch (this.whoMoves) {
      case 'p1p2':
        this.crease2.sequencePushSelf(sequence);
        this.crease1.sequencePushSelf(sequence);
        this.mark2.sequencePushSelf(sequence);
        this.mark1.sequencePushSelf(sequence);
        break;
      case 'l1l2':
        this.mark2.sequencePushSelf(sequence);
        this.mark1.sequencePushSelf(sequence);
        this.crease2.sequencePushSelf(sequence);
        this.crease1.sequencePushSelf(sequence);
        break;
      case 'p1l2':
        this.crease2.sequencePushSelf(sequence);
        this.mark2.sequencePushSelf(sequence);
        this.mark1.sequencePushSelf(sequence);
        this.crease1.sequencePushSelf(sequence);
        break;
      case 'p2l1':
        this.crease1.sequencePushSelf(sequence);
        this.mark1.sequencePushSelf(sequence);
        this.mark2.sequencePushSelf(sequence);
        this.crease2.sequencePushSelf(sequence);
        break;
      default:
        break;
    }
    super.sequencePushSelf(sequence);
  }
}

// RefLine_L2L_P2L - Huzita-Hatori Axiom O7 (Hatori's Axiom): bring line l1
// onto itself so that point p1 falls on line l2.
export class rfCreaseL2lP2l extends rfCrease {
  constructor(crease1, mark1, crease2, context) {
    super(new rfLine(), calcCreaseRank(crease1, mark1, crease2));
    this.crease1 = crease1;
    this.mark1 = mark1;
    this.crease2 = crease2;

    const l1 = crease1.l;
    const u1 = l1.u;
    const d1 = l1.d;
    const p1 = mark1.p;
    const l2 = crease2.l;
    const u2 = l2.u;

    this.l.u = u2.rotate90();
    const uf1 = this.l.u.dot(u1);
    if (Math.abs(uf1) < RF_EPS) return; // parallel lines: no solution

    this.l.d = (d1 + 2 * p1.dot(this.l.u) * uf1 - p1.dot(u1)) / (2 * uf1);

    const pt = this.l.intersectLine(l2);
    if (!pt || !context.paper.encloses(pt)) return;

    const p1p = this.l.fold(p1);
    if (!context.paper.encloses(p1p)) return;

    if (l1.containsPoint(p1)) return; // p1 already on l1: ill-defined

    const p1edge = mark1.isOnEdge(context.paper);
    const l1edge = crease1.isOnEdge(context.paper);
    if (context.visibilityMatters) {
      // Not null-checked in the original either (ClipLine()'s bool return is
      // ignored here, same quirk as rfPaper.makesSkinnyFlap() — see its doc
      // comment); `pt` already known enclosed makes failure unreachable in
      // practice, so fall back to (0,0) rather than crashing if it ever isn't.
      const clipped = context.paper.clipLine(this.l) ?? { p1: new rfPoint(0, 0), p2: new rfPoint(0, 0) };
      let t1 = clipped.p1.subtract(pt).dot(this.l.u);
      let t2 = clipped.p2.subtract(pt).dot(this.l.u);
      const tp = p1.subtract(pt).dot(this.l.u);
      if (t1 * tp < 0) { const ti = t2; t2 = t1; t1 = ti; }
      // t1 is now the parameter for the endpoint on p1's side of l2.
      if (p1edge && Math.abs(t1) <= Math.abs(t2)) this.whoMoves = 'p1';
      else if (l1edge && Math.abs(t1) >= Math.abs(t2)) this.whoMoves = 'l1';
      else return;
    } else {
      this.whoMoves = 'p1';
    }

    if (context.paper.makesSkinnyFlap(this.l, context.minAspectRatio)) return;
    this.finishConstructor(context);
  }

  usesImmediate(other) {
    return other === this.crease1 || other === this.mark1 || other === this.crease2;
  }

  prerequisites() {
    const moving = this.whoMoves === 'p1' ? [this.crease1, this.mark1] : [this.mark1, this.crease1];
    return [...moving, this.crease2];
  }

  sequencePushSelf(sequence) {
    if (this.whoMoves === 'p1') { this.crease1.sequencePushSelf(sequence); this.mark1.sequencePushSelf(sequence); }
    else { this.mark1.sequencePushSelf(sequence); this.crease1.sequencePushSelf(sequence); }
    this.crease2.sequencePushSelf(sequence);
    super.sequencePushSelf(sequence);
  }
}
