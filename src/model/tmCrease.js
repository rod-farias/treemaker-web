/**
 * tmCrease.js
 * Represents a crease in the crease pattern
 * Connection between vertices or facets
 * Equivalent to tmCrease class in TreeMaker C++
 */

import { lineIntersectionParams, RADIAN } from './tmPoint.js';

// Equivalent to tmCrease::Kind. What each one means physically:
// AXIAL — along an active leaf (border) path, carrying the tree's edge
//   lengths directly; GUSSET — along an active non-border (interior/cross)
//   path; RIDGE — connects consecutive vertices along a ridgeline (the
//   inset construction's own skeleton), not tied to a specific tree node;
// UNFOLDED_HINGE — connects a point that maps to a real tree node up/down
//   to the ridgeline (will carry a real mountain/valley assignment once
//   fold-direction is resolved, a later phase); PSEUDOHINGE — a hinge that
//   doesn't project to any tree node itself, bridging a purely geometric
//   ridgeline peak whose immediate neighbors share the same tree node.
// FOLDED_HINGE is declared for completeness (matching the original enum)
// but is never assigned by anything ported so far — same as upstream,
// where it's seemingly reserved for a fold-direction-resolution phase that
// this codebase version never actually reaches.
export const CreaseKind = {
  AXIAL: 'AXIAL',
  GUSSET: 'GUSSET',
  RIDGE: 'RIDGE',
  UNFOLDED_HINGE: 'UNFOLDED_HINGE',
  FOLDED_HINGE: 'FOLDED_HINGE',
  PSEUDOHINGE: 'PSEUDOHINGE'
};

// Equivalent to tmCrease::Fold: the mountain/valley/flat/border fold-
// direction assignment, computed by calcFold() from the color and stacking
// order of the two facets on either side (see tmTree.calcFoldDirections()).
export const CreaseFold = {
  FLAT: 'FLAT',
  MOUNTAIN: 'MOUNTAIN',
  VALLEY: 'VALLEY',
  BORDER: 'BORDER'
};

export class tmCrease {
  constructor(id = null, vertex1 = null, vertex2 = null) {
    this.id = id || Math.random().toString(36).substr(2, 9);

    // Topology: connects two vertices
    this.vertices = [vertex1, vertex2];

    // Equivalent to tmCrease::mKind (see CreaseKind above). Null until
    // tmPoly's crease-building pass classifies it.
    this.kind = null;

    // Equivalent to tmCrease::mFold (see CreaseFold above). Null until
    // tmTree.calcFoldDirections() runs (the final step of the crease-
    // pattern pipeline, gated behind facet ordering + color).
    this.fold = null;

    // Equivalent to tmCrease::mFwdFacet/mBkdFacet: the (up to two) facets
    // incident to this crease, set by tmPoly's facet-construction pass
    // (buildFacetsFromCreases()). A border crease (on the paper's own
    // outer edge, or the sole boundary of a not-yet-facet-complete region)
    // has only one of these set.
    this.fwdFacet = null;
    this.bkdFacet = null;

    // Scratch pad for facet-ordering graph construction (tmTree's
    // RootNetwork class) — equivalent to mCCFlag/mSTFlag.
    this.ccFlag = 0;
    this.stFlag = 0;

    // Equivalent to tmCrease::mCreaseOwner: whichever tmPath or tmPoly
    // created this crease (via getOrMakeCrease()) — a path for AXIAL/
    // GUSSET, a poly for RIDGE/HINGE/PSEUDOHINGE. `ownerKind` avoids a
    // circular import between tmCrease.js and tmPoly.js/tmPath.js for an
    // instanceof check.
    this.owner = null;
    this.ownerKind = null; // 'path' | 'poly'

    // Register crease with vertices
    if (vertex1) vertex1.addCrease(this);
    if (vertex2) vertex2.addCrease(this);
  }

  // Equivalent to tmCrease::GetLowerVertex()/GetHigherVertex(): whichever
  // endpoint sits at the lower/higher elevation (e.g. for a hinge crease,
  // the path-side vertex vs. the ridgeline peak it hinges up to).
  getLowerVertex() {
    const [v1, v2] = this.vertices;
    if (!v1) return v2 || null;
    if (!v2) return v1;
    return v1.getElevation() <= v2.getElevation() ? v1 : v2;
  }

  getHigherVertex() {
    const [v1, v2] = this.vertices;
    if (!v1) return v2 || null;
    if (!v2) return v1;
    return v1.getElevation() < v2.getElevation() ? v2 : v1;
  }

  // Getters
  getVertices() {
    return this.vertices;
  }

  getVertex(index) {
    return this.vertices[index];
  }

  getOtherVertex(vertex) {
    if (this.vertices[0] === vertex) return this.vertices[1];
    if (this.vertices[1] === vertex) return this.vertices[0];
    return null;
  }

  getKind() {
    return this.kind;
  }

  // Equivalent to tmCrease::GetAngle(): the direction of this crease in the
  // flat crease pattern (degrees CCW from the x-axis, second vertex minus
  // first), in (-180, 180].
  getAngle() {
    const [v1, v2] = this.vertices;
    const dx = v2.getLocX() - v1.getLocX();
    const dy = v2.getLocY() - v1.getLocY();
    return Math.atan2(dy, dx) * RADIAN;
  }

  // Equivalent to tmCrease::GetPositiveAngle(): the same direction, but
  // folded into [0, 180) since a crease is an undirected line — its angle
  // and that angle plus 180° describe the same line.
  getPositiveAngle() {
    const angle = this.getAngle();
    return angle >= 0 ? angle : angle + 180;
  }

  // Equivalent to tmCrease::GetOwnerAsPath()/GetOwnerAsPoly().
  getOwnerAsPath() {
    return this.ownerKind === 'path' ? this.owner : null;
  }

  getOwnerAsPoly() {
    return this.ownerKind === 'poly' ? this.owner : null;
  }

  // Structural kind predicates — equivalent to the tmCrease.h inline getters.
  isAxialCrease() {
    return this.kind === CreaseKind.AXIAL;
  }

  isGussetCrease() {
    return this.kind === CreaseKind.GUSSET;
  }

  isRidgeCrease() {
    return this.kind === CreaseKind.RIDGE;
  }

  isAxialOrGussetCrease() {
    return this.kind === CreaseKind.AXIAL || this.kind === CreaseKind.GUSSET;
  }

  isHingeCrease() {
    return this.kind === CreaseKind.UNFOLDED_HINGE || this.kind === CreaseKind.FOLDED_HINGE ||
      this.kind === CreaseKind.PSEUDOHINGE;
  }

  isRegularHingeCrease() {
    return this.kind === CreaseKind.UNFOLDED_HINGE || this.kind === CreaseKind.FOLDED_HINGE;
  }

  isPseudohingeCrease() {
    return this.kind === CreaseKind.PSEUDOHINGE;
  }

  isUnfoldedHingeCrease() {
    return this.kind === CreaseKind.UNFOLDED_HINGE;
  }

  isFoldedHingeCrease() {
    return this.kind === CreaseKind.FOLDED_HINGE;
  }

  isMajorCrease() {
    return this.kind === CreaseKind.AXIAL || this.kind === CreaseKind.RIDGE || this.kind === CreaseKind.GUSSET;
  }

  isMinorCrease() {
    return this.isHingeCrease();
  }

  isFoldedCrease() {
    return this.kind === CreaseKind.AXIAL || this.kind === CreaseKind.GUSSET || this.kind === CreaseKind.RIDGE ||
      this.kind === CreaseKind.FOLDED_HINGE || this.kind === CreaseKind.PSEUDOHINGE;
  }

  // Equivalent to tmCrease::IsBorderCrease(): incident to only one facet.
  // Only meaningful after facets have been fully constructed.
  isBorderCrease() {
    return !this.fwdFacet || !this.bkdFacet;
  }

  getFold() {
    return this.fold;
  }

  isFlatCrease() {
    return this.fold === CreaseFold.FLAT;
  }

  // Crease type (fold direction, once calcFold() has run)
  isCreaseValley() {
    return this.fold === CreaseFold.VALLEY;
  }

  isCreaseMountain() {
    return this.fold === CreaseFold.MOUNTAIN;
  }

  isCreaseBorder() {
    return this.isBorderCrease();
  }

  // Equivalent to tmCrease::GetOtherFacet(): the facet on the other side of
  // this crease from `facet`, which must be one of the two incident facets.
  // Returns null for a border crease (only one incident facet).
  getOtherFacet(facet) {
    if (facet === this.fwdFacet) return this.bkdFacet;
    return this.fwdFacet;
  }

  // Equivalent to tmCrease::GetLeftFacet()/GetRightFacet(): the facet to
  // the left/right of this hinge or ridge crease, determined by which
  // facet's own left/right-crease slot points back at this crease.
  getLeftFacet() {
    if (this.fwdFacet && this.fwdFacet.getRightCrease() === this) return this.fwdFacet;
    return this.bkdFacet;
  }

  getRightFacet() {
    if (this.fwdFacet && this.fwdFacet.getLeftCrease() === this) return this.fwdFacet;
    return this.bkdFacet;
  }

  // Equivalent to tmCrease::GetLeftNonPseudohingeFacet()/
  // GetRightNonPseudohingeFacet(): step across pseudohinge facets until a
  // normal one is reached.
  getLeftNonPseudohingeFacet() {
    let facet = this.getLeftFacet();
    while (facet.isPseudohingeFacet()) facet = facet.getLeftFacet();
    return facet;
  }

  getRightNonPseudohingeFacet() {
    let facet = this.getRightFacet();
    while (facet.isPseudohingeFacet()) facet = facet.getRightFacet();
    return facet;
  }

  // Equivalent to tmCrease::GetCommonVertex()/HasCommonVertex(): the vertex
  // (if any) shared between this crease and `other`.
  getCommonVertex(other) {
    const [v1a, v1b] = this.vertices;
    const [v2a, v2b] = other.vertices;
    if (v1a === v2a || v1a === v2b) return v1a;
    if (v1b === v2a || v1b === v2b) return v1b;
    return null;
  }

  hasCommonVertex(other) {
    return !!this.getCommonVertex(other);
  }

  isIncidentTo(vertex) {
    return this.vertices.includes(vertex);
  }

  // Equivalent to tmCrease::IntersectsInterior(): true if this crease and
  // `other` cross in their shared interior (not just touching at an
  // endpoint) — used to detect a nonplanar crease embedding before facet
  // construction (tmPoly.buildFacetsFromCreases()).
  intersectsInterior(other) {
    if (this.hasCommonVertex(other)) return false;
    const p = this.vertices[0].getLoc();
    const rp = this.vertices[1].getLoc().subtract(p);
    const q = other.vertices[0].getLoc();
    const rq = other.vertices[1].getLoc().subtract(q);
    const params = lineIntersectionParams(p, rp, q, rq);
    if (!params) return false;
    return params.tp > 0 && params.tp < 1 && params.tq > 0 && params.tq < 1;
  }

  /**
   * Equivalent to tmCrease::CalcBend(): for a hinge (non-pseudohinge)
   * crease, refine `kind` between FOLDED_HINGE and UNFOLDED_HINGE by
   * finding the bottom (lowest-elevation, axial/gusset) vertex and
   * comparing 3D fold depth across it and the two vertices at the far ends
   * of its flanking axial/gusset creases — a strict local max or min means
   * the paper actually folds back on itself here (FOLDED_HINGE); a
   * monotonic run means it doesn't (UNFOLDED_HINGE).
   */
  calcBend() {
    if (!this.isHingeCrease() || this.isPseudohingeCrease()) return;
    let vertex2 = this.vertices[0];
    let vertex2a = this.vertices[1];
    // The bottom (axial/gusset) vertex is always at the lower construction
    // elevation — a stable geometric fact from the inset construction,
    // independent of the 3D fold depth compared just below.
    if (vertex2.getElevation() > vertex2a.getElevation()) vertex2 = vertex2a;
    const [crease1, crease3] = vertex2.getAxialOrGussetCreases();
    const vertex1 = crease1.getOtherVertex(vertex2);
    const vertex3 = crease3.getOtherVertex(vertex2);
    const depth1 = vertex1.getDepth();
    const depth2 = vertex2.getDepth();
    const depth3 = vertex3.getDepth();
    if ((depth1 > depth2 && depth2 < depth3) || (depth1 < depth2 && depth2 > depth3)) {
      this.kind = CreaseKind.FOLDED_HINGE;
    } else {
      this.kind = CreaseKind.UNFOLDED_HINGE;
    }
  }

  /**
   * Equivalent to tmCrease::CalcFold(): the actual mountain/valley
   * assignment, from the color and relative stacking order of the two
   * facets on either side. Requires facet color + order to already be set
   * (tmTree.calcFacetColor()/calcFacetOrder(), which in turn require the
   * full facet-ordering graph to be resolved).
   */
  calcFold() {
    if (!this.fwdFacet || !this.bkdFacet) {
      this.fold = CreaseFold.BORDER;
    } else if (this.fwdFacet.getColor() === this.bkdFacet.getColor()) {
      this.fold = CreaseFold.FLAT;
    } else if (this.fwdFacet.isColorUpFacet()) {
      this.fold = this.fwdFacet.getOrder() > this.bkdFacet.getOrder() ? CreaseFold.MOUNTAIN : CreaseFold.VALLEY;
    } else {
      this.fold = this.fwdFacet.getOrder() > this.bkdFacet.getOrder() ? CreaseFold.VALLEY : CreaseFold.MOUNTAIN;
    }
  }

  // Equivalent to tmCrease::ClearCleanupData().
  clearCleanupData() {
    this.fold = CreaseFold.FLAT;
  }

  // Get length (distance between vertices)
  getLength() {
    if (this.vertices[0] && this.vertices[1]) {
      return this.vertices[0].getLocation().distance(this.vertices[1].getLocation());
    }
    return 0;
  }

  // Clone
  clone() {
    const crease = new tmCrease(this.id, this.vertices[0], this.vertices[1]);
    crease.kind = this.kind;
    crease.fold = this.fold;
    return crease;
  }

  // String representation
  toString() {
    const type = this.fold === CreaseFold.VALLEY ? 'Valley' : this.fold === CreaseFold.MOUNTAIN ? 'Mountain' : 'Crease';
    return `${type}(${this.id}, length=${this.getLength().toFixed(3)})`;
  }
}
