/**
 * tmFacet.js
 * Represents a facet (3D face) in the folded form
 * Equivalent to tmFacet class in TreeMaker C++
 */

import { tmPoint } from './tmPoint.js';

// Equivalent to tmFacet::Color: which side of the paper faces up in the
// folded form. Propagated across the crease pattern by calcColor(),
// starting from the tree's single "source facet" (see
// tmFacetOwner-equivalent code in tmPoly.js / tmTree.calcFacetColor()).
export const FacetColor = {
  NOT_ORIENTED: 'NOT_ORIENTED',
  WHITE_UP: 'WHITE_UP',
  COLOR_UP: 'COLOR_UP'
};

export class tmFacet {
  constructor(id = null) {
    this.id = id || Math.random().toString(36).substr(2, 9);

    // Built at construction (calcContents())
    this.centroid = new tmPoint(0, 0);
    // Equivalent to tmFacet::mIsWellFormed: true once this facet has a
    // bottom crease (axial or gusset) as mCreases.front() after rotation.
    // False only for a degenerate "sliver" facet with no axial/gusset
    // crease at all — prevents facet ordering/color but not crease-pattern
    // construction.
    this.isWellFormed = false;
    this.vertices = [];  // CCW order; once well-formed, [0]/[1] are the two bottom vertices
    this.creases = [];   // CCW order; once well-formed, starts with the bottom crease

    // Rebuilt at cleanup
    this.corridorEdge = null;
    this.tailFacets = [];
    this.headFacets = [];
    this.order = null;
    this.color = FacetColor.NOT_ORIENTED;

    // owner
    this.poly = null;
  }

  // Getters
  getCentroid() {
    return this.centroid;
  }

  getVertices() {
    return this.vertices;
  }

  getNumVertices() {
    return this.vertices.length;
  }

  getCreases() {
    return this.creases;
  }

  getCorridorEdge() {
    return this.corridorEdge;
  }

  // Equivalent to tmFacet::GetBottomCrease()/GetLeftCrease()/
  // GetRightCrease(): valid once isWellFormed and creases are CCW-rotated
  // so the bottom (axial/gusset) crease is first.
  getBottomCrease() {
    return this.creases[0];
  }

  getLeftCrease() {
    return this.creases[this.creases.length - 1];
  }

  getRightCrease() {
    return this.creases[1];
  }

  getTailFacets() {
    return this.tailFacets;
  }

  getHeadFacets() {
    return this.headFacets;
  }

  getOrder() {
    return this.order;
  }

  getColor() {
    return this.color;
  }

  isWhiteUpFacet() {
    return this.color === FacetColor.WHITE_UP;
  }

  isColorUpFacet() {
    return this.color === FacetColor.COLOR_UP;
  }

  isUnorientedFacet() {
    return this.color === FacetColor.NOT_ORIENTED;
  }

  isOrientedFacet() {
    return this.color === FacetColor.WHITE_UP || this.color === FacetColor.COLOR_UP;
  }

  getFacetOwner() {
    return this.poly;
  }

  setOwnerPoly(poly) {
    this.poly = poly;
    if (poly) poly.addFacet(this);
  }

  // Equivalent to tmFacet::IsSourceFacet()/IsSinkFacet(): a source has
  // heads but no tails in the facet-ordering graph; a sink is the reverse.
  isSourceFacet() {
    return this.headFacets.length > 0 && this.tailFacets.length === 0;
  }

  isSinkFacet() {
    return this.tailFacets.length > 0 && this.headFacets.length === 0;
  }

  // Equivalent to tmFacet::ConvexEncloses().
  convexEncloses(point) {
    const n = this.vertices.length;
    if (n < 3) return false;
    let inside = true;
    for (let i = 0; i < n; i += 1) {
      const a = this.vertices[i].getLoc();
      const b = this.vertices[(i + 1) % n].getLoc();
      if (b.subtract(a).cross(point.subtract(a)) < 0) inside = false;
    }
    return inside;
  }

  // Facet queries related to incident crease type
  isAxialFacet() {
    return !!this.getAxialCrease();
  }

  isGussetFacet() {
    return !!this.getGussetCrease();
  }

  isPseudohingeFacet() {
    return this.getLeftCrease().isPseudohingeCrease() || this.getRightCrease().isPseudohingeCrease();
  }

  isNotPseudohingeFacet() {
    return !this.getLeftCrease().isPseudohingeCrease() && !this.getRightCrease().isPseudohingeCrease();
  }

  getAxialCrease() {
    const crease = this.creases[0];
    return crease && crease.isAxialCrease() ? crease : null;
  }

  getGussetCrease() {
    const crease = this.creases[0];
    return crease && crease.isGussetCrease() ? crease : null;
  }

  // Equivalent to tmFacet::GetRidgeCreases(): every ridge crease among this
  // facet's non-bottom sides.
  getRidgeCreases() {
    return this.creases.slice(1).filter(c => c.isRidgeCrease());
  }

  // Equivalent to tmFacet::GetOtherSideCrease(): given one of the two side
  // (left/right) creases, return the other.
  getOtherSideCrease(crease) {
    const left = this.getLeftCrease();
    const right = this.getRightCrease();
    if (crease === left) return right;
    if (crease === right) return left;
    throw new Error('tmFacet.getOtherSideCrease(): argument was not a side crease');
  }

  // Equivalent to tmFacet::GetOtherCorridorCreases(): every crease around
  // this facet except `crease` and any regular (non-pseudo) hinge crease —
  // those lie outside the corridor this facet is part of.
  getOtherCorridorCreases(crease) {
    return this.creases.filter(c => c !== crease && !c.isRegularHingeCrease());
  }

  // Facet-to-facet queries
  getLeftFacet() {
    return this.getLeftCrease().getLeftFacet();
  }

  getRightFacet() {
    return this.getRightCrease().getRightFacet();
  }

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

  /**
   * Equivalent to tmFacet::CalcContents(): computes the centroid, then
   * rotates `vertices`/`creases` (kept in lockstep) so the sole axial or
   * gusset crease is first — letting getBottomCrease()/getLeftCrease()/
   * getRightCrease() work without searching. A "sliver" facet with no
   * axial/gusset crease at all is marked not well-formed instead of
   * infinite-looping.
   */
  calcContents() {
    const n = this.vertices.length;
    let x = 0;
    let y = 0;
    for (const vertex of this.vertices) {
      x += vertex.getLocX();
      y += vertex.getLocY();
    }
    this.centroid = new tmPoint(x / n, y / n);

    this.isWellFormed = true;
    let rotations = 0;
    while (!this.creases[0].isAxialOrGussetCrease()) {
      this.vertices.push(this.vertices.shift());
      this.creases.push(this.creases.shift());
      rotations += 1;
      if (rotations >= n) {
        this.isWellFormed = false;
        break;
      }
    }

    for (const vertex of this.vertices) vertex.addFacet(this);
  }

  // Equivalent to tmFacet::ClearCleanupData().
  clearCleanupData() {
    this.corridorEdge = null;
    this.tailFacets = [];
    this.headFacets = [];
    this.order = null;
    this.color = FacetColor.NOT_ORIENTED;
  }

  hasTailFacet(facet) {
    return this.tailFacets.includes(facet);
  }

  hasHeadFacet(facet) {
    return this.headFacets.includes(facet);
  }

  clearLinks() {
    this.tailFacets = [];
    this.headFacets = [];
  }

  // Equivalent to tmFacet::LinkTo(): add a facet-ordering-graph edge with
  // `this` as tail and `headFacet` as head.
  linkTo(headFacet) {
    this.headFacets.push(headFacet);
    headFacet.tailFacets.push(this);
  }

  // STATIC — equivalent to tmFacet::AreLinked().
  static areLinked(facet1, facet2) {
    return facet1.headFacets.includes(facet2) || facet2.headFacets.includes(facet1);
  }

  // STATIC — equivalent to tmFacet::Link(): add an edge from whichever
  // facet is currently a sink to whichever is currently a source.
  static link(facet1, facet2) {
    if (facet1.isSinkFacet()) {
      facet1.linkTo(facet2);
      return;
    }
    facet2.linkTo(facet1);
  }

  // STATIC — equivalent to tmFacet::Unlink(): remove the edge between the
  // two facets, in whichever direction it runs.
  static unlink(facet1, facet2) {
    if (facet1.headFacets.includes(facet2)) {
      facet1.headFacets = facet1.headFacets.filter(f => f !== facet2);
      facet2.tailFacets = facet2.tailFacets.filter(f => f !== facet1);
      return;
    }
    facet1.tailFacets = facet1.tailFacets.filter(f => f !== facet2);
    facet2.headFacets = facet2.headFacets.filter(f => f !== facet1);
  }

  /**
   * Equivalent to tmFacet::CalcOrder(): assigns this facet the next order
   * value once every one of its tail facets already has one, then
   * recurses to its head facets. `state` is a single-field mutable counter
   * ({ next }) shared across the whole recursion (JS has no by-reference
   * primitive out-param).
   */
  calcOrder(state) {
    if (this.order !== null) return;
    for (const tailFacet of this.tailFacets) {
      if (tailFacet.order === null) return;
    }
    this.order = state.next;
    state.next += 1;
    for (const headFacet of this.headFacets) headFacet.calcOrder(state);
  }

  /**
   * Equivalent to tmFacet::CalcColor(): propagates a two-coloring across
   * the crease pattern — a facet on the other side of a "folding" crease
   * (AXIAL/GUSSET/RIDGE/FOLDED_HINGE/PSEUDOHINGE) gets the opposite color;
   * across an UNFOLDED_HINGE (paper that doesn't actually fold there) it
   * gets the same color.
   */
  calcColor(color) {
    this.color = color;
    for (const crease of this.creases) {
      const otherFacet = crease.getOtherFacet(this);
      if (!otherFacet || otherFacet.color !== FacetColor.NOT_ORIENTED) continue;
      switch (crease.getKind()) {
        case 'AXIAL':
        case 'GUSSET':
        case 'RIDGE':
        case 'FOLDED_HINGE':
        case 'PSEUDOHINGE':
          otherFacet.calcColor(tmFacet.oppositeColor(color));
          break;
        case 'UNFOLDED_HINGE':
          otherFacet.calcColor(color);
          break;
        default:
          throw new Error('tmFacet.calcColor(): crease kind was not defined');
      }
    }
  }

  // STATIC — equivalent to tmFacet::OppositeColor().
  static oppositeColor(color) {
    if (color === FacetColor.WHITE_UP) return FacetColor.COLOR_UP;
    if (color === FacetColor.COLOR_UP) return FacetColor.WHITE_UP;
    throw new Error('tmFacet.oppositeColor(): facet color was not yet defined');
  }

  // Calculate area (shoelace) — not part of the original tmFacet interface,
  // kept as a convenience for the UI (NodeEditor's facet inspector).
  getArea() {
    if (this.vertices.length < 3) return 0;
    let area = 0;
    for (let i = 0; i < this.vertices.length; i++) {
      const v1 = this.vertices[i].getLocation();
      const v2 = this.vertices[(i + 1) % this.vertices.length].getLocation();
      area += v1.x * v2.y;
      area -= v2.x * v1.y;
    }
    return Math.abs(area / 2);
  }

  // String representation
  toString() {
    return `Facet(${this.id}, ${this.vertices.length} vertices, order=${this.order})`;
  }
}
