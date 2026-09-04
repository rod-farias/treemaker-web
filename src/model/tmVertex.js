/**
 * tmVertex.js
 * Represents a vertex in the crease pattern
 * Can be owned by a node or a path
 * Equivalent to tmVertex class in TreeMaker C++
 */

import { tmPoint } from './tmPoint.js';
import { tmFacet } from './tmFacet.js';

export class tmVertex {
  constructor(id = null, location = null) {
    this.id = id || Math.random().toString(36).substr(2, 9);
    
    // Location on paper
    this.location = location instanceof tmPoint ? location.clone() : new tmPoint(0, 0);
    
    // Depth information (for 3D folded form) — a later phase than crease
    // classification; unrelated to `elevation` below.
    this.depth = 0;
    this.depthValid = false;

    // Equivalent to tmVertex::mDiscreteDepth: number of tree-graph hops
    // from the root node. Only meaningful for a vertex whose `treeNode` is
    // set (others get null, matching the original's size_t(-1) sentinel);
    // computed by tmTree.calcDepthAndBend() via node.calcDiscreteDepth().
    this.discreteDepth = null;

    // Equivalent to tmVertex::mIsBorderVertex: true only if this vertex's
    // owner (a node or a path — see setOwner()) is itself flagged as lying
    // on the border of the tree's polygon arrangement (node.isBorderNode /
    // path.isBorderPath), set at vertex-construction time by
    // tmNode.getOrMakeVertexSelf()/tmPath.getOrMakeVertex(). NOT a live
    // geometric check against the paper edge — see isBorderVertex() below.
    this.isBorderVertexFlag = false;

    // Scratch pad for facet-ordering graph construction (tmTree's
    // calcRootNetworks()/RootNetwork class) — equivalent to mCCFlag/mSTFlag.
    this.ccFlag = 0;
    this.stFlag = 0;

    // Equivalent to tmVertex::mElevation: perpendicular inset distance from
    // the paper's own base plane, inherited from the owning node's
    // elevation (see tmNode.getOrMakeVertexSelf()) or, for a vertex placed
    // partway along a path (tmPath.getOrMakeVertex()), linearly
    // interpolated between the path's front/back vertex elevations.
    this.elevation = 0;

    // Equivalent to tmVertex::mTreeNode: set only when this vertex
    // corresponds to an actual tree node (leaf or branch) — null for a
    // vertex that's a purely geometric construction (e.g. a molecule
    // junction with no coincident tree node). Determines UNFOLDED_HINGE vs
    // PSEUDOHINGE classification in tmPoly's crease-building pass.
    this.treeNode = null;

    // Equivalent to mLeftPseudohingeMate/mRightPseudohingeMate: cross-links
    // the two hinge vertices flanking a PSEUDOHINGE crease, set by
    // tmPoly's crease-building pass. Consumed by a later phase (folded-
    // state depth computation), not by anything ported so far.
    this.leftPseudohingeMate = null;
    this.rightPseudohingeMate = null;

    // Ownership
    this.owner = null;  // owner node or path
    
    // Associated parts
    this.creases = [];  // creases incident to this vertex
    this.facets = [];   // facets incident to this vertex
  }

  // Getters
  getLocation() {
    return this.location;
  }

  // Alias matching tmNode's getLoc(), so code that handles nodes and
  // vertices interchangeably (e.g. the ridgeline/hinge crease pass) doesn't
  // need to know which one it has.
  getLoc() {
    return this.location;
  }

  getLocX() {
    return this.location.x;
  }

  getLocY() {
    return this.location.y;
  }

  getDepth() {
    return this.depth;
  }

  getElevation() {
    return this.elevation;
  }

  isDepthValid() {
    return this.depthValid;
  }

  getDiscreteDepth() {
    return this.discreteDepth;
  }

  // Equivalent to tmVertex::IsBorderVertex(): whether this vertex's owner
  // (node or path) is itself on the border of the tree's polygon
  // arrangement — see isBorderVertexFlag above for how it's set.
  isBorderVertex() {
    return this.isBorderVertexFlag;
  }

  getOwner() {
    return this.owner;
  }

  // Readable stand-in for the raw `id` (a random string, meaningless to a
  // user) wherever a vertex needs to be identified in the UI: the owning
  // node/path's label when it has one, otherwise the per-Build sequential
  // number assigned by tmTree._collectVertices() — never empty, unlike
  // `owner.label`, which is '' for most paths.
  getDisplayLabel() {
    if (this.owner?.label) return this.owner.label;
    // "V" prefix distinguishes this from a node's plain numeric label (the
    // number shown next to its dot on the canvas), since both are small
    // integers and could otherwise be confused for the same vertex.
    return this.buildIndex != null ? `V${this.buildIndex}` : this.id;
  }

  // Equivalent to tmVertex::GetNumMajorCreases()/IsMajorVertex()/
  // IsMinorVertex(): a "major" vertex has 3+ axial/ridge creases meeting
  // there (a facet-ordering branch point); "minor" is the complement.
  getNumMajorCreases() {
    return this.creases.filter(c => c.isMajorCrease()).length;
  }

  isMajorVertex() {
    return this.getNumMajorCreases() > 2;
  }

  isMinorVertex() {
    return this.getNumMajorCreases() <= 2;
  }

  // Equivalent to tmVertex::GetNumHingeCreases().
  getNumHingeCreases() {
    return this.creases.filter(c => c.isHingeCrease()).length;
  }

  // Equivalent to tmVertex::IsAxialVertex(): incident to an axial crease,
  // which puts it on the border of a tree poly. Only meaningful once all
  // creases within the poly have been constructed.
  isAxialVertex() {
    return this.creases.some(c => c.isAxialCrease());
  }

  // Equivalent to tmVertex::IsAxialOrGussetVertex().
  isAxialOrGussetVertex() {
    return this.creases.some(c => c.isAxialOrGussetCrease());
  }

  // Equivalent to tmVertex::IsHingeVertex().
  isHingeVertex() {
    return this.creases.some(c => c.isHingeCrease());
  }

  // Equivalent to tmVertex::GetDegree(creaseList): how many of this
  // vertex's incident creases appear in the given list.
  getDegree(creaseList) {
    return this.creases.filter(c => creaseList.includes(c)).length;
  }

  // Equivalent to tmVertex::GetHingeCrease(): the first incident hinge
  // crease (meaningful when this vertex is known to have exactly one, e.g.
  // a border hinge vertex).
  getHingeCrease() {
    return this.creases.find(c => c.isHingeCrease()) || null;
  }

  // Equivalent to tmVertex::GetAxialOrGussetCreases(): the (exactly) two
  // axial/gusset creases to either side of this vertex.
  getAxialOrGussetCreases() {
    const found = this.creases.filter(c => c.isAxialOrGussetCrease());
    return [found[0] || null, found[1] || null];
  }

  // Equivalent to tmVertex::GetHingeCreases(): the zero, one, or two hinge
  // creases incident to this vertex.
  getHingeCreases() {
    const found = this.creases.filter(c => c.isHingeCrease());
    return [found[0] || null, found[1] || null];
  }

  /**
   * Equivalent to tmVertex::SwapLinks(): this vertex is an axial hinge
   * vertex where the facet-ordering graph currently runs along the two
   * hinge creases; rewire it to instead run across them (left-of-hinge1 to
   * right-of-hinge2, and left-of-hinge2 to right-of-hinge1). Used both to
   * connect a molecule's local facet-ordering loop into a single sortable
   * graph, and to splice separate local root networks together.
   */
  swapLinks() {
    const [hinge1, hinge2] = this.getHingeCreases();
    const facetA = hinge1.getLeftFacet();
    const facetB = hinge1.getRightFacet();
    const facetC = hinge2.getRightFacet();
    const facetD = hinge2.getLeftFacet();
    tmFacet.unlink(facetA, facetB);
    tmFacet.unlink(facetC, facetD);
    facetA.linkTo(facetC);
    facetD.linkTo(facetB);
  }

  // Equivalent to tmVertex::ClearCleanupData(): reset depth/discreteDepth
  // ahead of a fresh tmTree.calcDepthAndBend() pass.
  clearCleanupData() {
    this.depth = 0;
    this.depthValid = false;
    this.discreteDepth = null;
  }

  // Setters
  setLocation(point) {
    if (point instanceof tmPoint) {
      this.location = point.clone();
    }
  }

  setLocationXY(x, y) {
    this.location = new tmPoint(x, y);
  }

  setDepth(depth) {
    this.depth = Number(depth);
    this.depthValid = true;
  }

  setOwner(owner) {
    this.owner = owner;
  }

  // Add crease
  addCrease(crease) {
    if (!this.creases.includes(crease)) {
      this.creases.push(crease);
    }
  }

  // Add facet
  addFacet(facet) {
    if (!this.facets.includes(facet)) {
      this.facets.push(facet);
    }
  }

  // Clone
  clone() {
    const vertex = new tmVertex(this.id, this.location);
    vertex.depth = this.depth;
    vertex.depthValid = this.depthValid;
    return vertex;
  }

  // String representation
  toString() {
    return `Vertex(${this.id}, ${this.location.toString()}, depth=${this.depth.toFixed(3)})`;
  }
}
