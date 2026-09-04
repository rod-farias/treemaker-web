/**
 * tmPoly.js
 * Represents a polygon in the crease pattern
 * Equivalent to tmPoly class in TreeMaker C++
 */

import { tmPoint, incenter, inradius, lineIntersection, areParallel, areCCW, areCW, projectPtoQ, projectQtoP } from './tmPoint.js';
import { tmNode } from './tmNode.js';
import { tmPath } from './tmPath.js';
import { tmCrease, CreaseKind } from './tmCrease.js';
import { tmFacet } from './tmFacet.js';
import { buildPolysFromPaths } from './solvers/PolygonPartition.js';

// Distance/equality tolerance used throughout the inset search — equivalent
// to tmPart::DistTol() (1e-4), as used by tmPoly.cpp's GetOrMakeInsetNode
// and TestIsActive.
const DIST_TOL = 1e-4;

// Equivalent to tmPoint.cpp's AngleChange(p1,p2,p3): the turn angle (in
// radians, normalized to [-PI, PI)) from the direction p1->p2 to the
// direction p2->p3. Positive = left/CCW turn, negative = right/CW turn.
function angleChange(p1, p2, p3) {
  const a1 = p2.subtract(p1).angle();
  const a2 = p3.subtract(p2).angle();
  let delta = a2 - a1;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  while (delta >= Math.PI) delta -= 2 * Math.PI;
  return delta;
}

export class tmPoly {
  constructor(id = null) {
    this.id = id || Math.random().toString(36).substr(2, 9);
    
    // Topology: ordered vertices that form polygon boundary
    this.vertices = [];  // ordered array of tmVertex
    
    // Classification flags
    this.isTreePoly = true;      // tree poly (vs sub-poly)
    this.isConvex = true;        // polygon is convex
    this.hasInnerBoundary = false; // has inner sub-polys
    
    // Related parts
    this.subPolys = [];   // sub-polygons inside this poly
    // Equivalent to tmFacetOwner::mOwnedFacets: only ever populated for a
    // top-level (isTreePoly) poly — see buildFacetsFromCreases() — since a
    // subPoly never builds facets of its own (matches the original's
    // `if (mIsSubPoly) return;` guard).
    this.facets = [];
    this.creases = [];    // creases that bound this poly

    // Equivalent to tmPoly::mLocalRootVertices/mLocalRootCreases: the
    // hinge vertices/creases closest to the tree's root within this poly's
    // own molecule, computed by calcBend() and consumed by
    // tmTree.calcRootNetworks() when splicing together the global facet-
    // ordering graph.
    this.localRootVertices = [];
    this.localRootCreases = [];

    // Polygon-partition ring (see tmTree._buildPolysFromPaths()): the tree
    // nodes/paths that trace this polygon's boundary in CCW order, paired
    // so that leaving ringNodes[i] via ringPaths[i] arrives at
    // ringNodes[(i+1) % n]. `vertices` (above) holds the tmVertex wrapper
    // for each ringNode, built once ring tracing is done, and is what the
    // rest of the crease-pattern pipeline (buildPolysAndCreasePattern())
    // actually consumes.
    this.ringNodes = [];
    this.ringPaths = [];
    this.centroid = null;

    // Universal-molecule contents (see buildPolyContents()). `polyOwner` is
    // whoever's job it was to build THIS poly — the tmTree for a top-level
    // poly, or the parent tmPoly when this is a subPoly created during that
    // parent's own buildPolyContents() — mirroring tmPolyOwner being the
    // shared base class of both in the original. findAnyPath() needs it to
    // look up the pre-existing path between two of this poly's own ring
    // nodes (built one recursion level up).
    this.polyOwner = null;
    this.insetNodes = [];   // insetNodes[i] = where ringNodes[i] moves to after the inset
    this.ownedNodes = [];   // the distinct new tmNodes created by insetting (junction nodes among them)
    this.ownedPaths = [];   // the complete path network built among the distinct inset nodes
    this.spokePaths = [];   // one path per ring node, from that ring node to its inset node
    this.ridgePath = null;  // only set when insetting collapses the ring onto a single segment

    // Equivalent to tmPoly (as a tmCreaseOwner): RIDGE creases, and the
    // upward-propagated UNFOLDED_HINGE creases, always owned by
    // getOutermostPoly() — but the downward-propagated UNFOLDED_HINGE/
    // PSEUDOHINGE creases for an inactive axial ring path are (matching the
    // original's literal, seemingly deliberate, unqualified call) owned by
    // whichever poly is currently being processed, which can be a subPoly.
    // See _buildCreases().
    this.ownedCreases = [];
  }

  // Getters
  getVertices() {
    return this.vertices;
  }

  getNumVertices() {
    return this.vertices.length;
  }

  // Equivalent to tmPoly::GetRingNodes(): the tree nodes at this poly's
  // corners, in CCW order (see the ringNodes field comment).
  getRingNodes() {
    return this.ringNodes;
  }

  // Equivalent to tmPoly::GetRingPaths(): the paths connecting consecutive
  // ringNodes (ringPaths[i] leaves ringNodes[i] and arrives at
  // ringNodes[(i + 1) % n]).
  getRingPaths() {
    return this.ringPaths;
  }

  // Equivalent to tmPoly::GetCentroid(): the average location of the ring
  // nodes, computing it on demand (via calcCentroid()) if it hasn't been
  // cached yet.
  getCentroid() {
    if (!this.centroid) this.calcCentroid();
    return this.centroid;
  }

  isTriangle() {
    return this.vertices.length === 3;
  }

  isQuad() {
    return this.vertices.length === 4;
  }

  // Equivalent to tmPoly::HasPolyContents(): whether this polygon's interior
  // has already been filled — either by buildPolyContents() (it owns at
  // least one inset node) or, for the still-separate "Triangulate Pattern"
  // feature, by a plain fan triangulation into subPolys with no inset nodes
  // of its own.
  hasPolyContents() {
    return this.ownedNodes.length > 0 || this.subPolys.length > 0;
  }

  // Equivalent to tmPoly::GetNumInactiveBorderPaths(): despite the name,
  // this counts every inactive path around THIS poly's own ring (top-level
  // ring paths are the tree's leaf paths; a subPoly's ring paths are its
  // inset cross-paths) — not filtered by tmPath::isBorderPath, which is a
  // different, paper-convex-hull-specific concept. A plain triangle
  // legitimately has all 3 ring paths simultaneously inactive with no
  // problem; this only becomes POLYS_MULTIPLE_IBPS when a poly has *more
  // than one* inactive ring path (see tmTree.getCPStatus()).
  getNumInactiveBorderPaths() {
    return this.ringPaths.filter(path => !path.isActivePath()).length;
  }

  // Setters
  addVertex(vertex) {
    if (!this.vertices.includes(vertex)) {
      this.vertices.push(vertex);
    }
  }

  // Add sub-polygon
  addSubPoly(subPoly) {
    if (!this.subPolys.includes(subPoly)) {
      this.subPolys.push(subPoly);
      subPoly.isTreePoly = false;
    }
  }

  // Add facet
  addFacet(facet) {
    if (!this.facets.includes(facet)) {
      this.facets.push(facet);
    }
  }

  // Add crease
  addCrease(crease) {
    if (!this.creases.includes(crease)) {
      this.creases.push(crease);
    }
  }

  // Calculate area using shoelace formula
  getArea() {
    if (this.vertices.length < 3) return 0;
    
    let area = 0;
    for (let i = 0; i < this.vertices.length; i++) {
      const v1 = this.vertices[i];
      const v2 = this.vertices[(i + 1) % this.vertices.length];
      area += v1.getLocation().x * v2.getLocation().y;
      area -= v2.getLocation().x * v1.getLocation().y;
    }
    return Math.abs(area / 2);
  }

  // Equivalent to tmPoly::CalcContents()'s centroid part: the average
  // location of the ring nodes (not the vertex-array `vertices`, which may
  // not be populated yet when this is needed during ring tracing).
  calcCentroid() {
    if (this.ringNodes.length === 0) return null;
    let x = 0;
    let y = 0;
    for (const node of this.ringNodes) {
      x += node.getLocX();
      y += node.getLocY();
    }
    this.centroid = new tmPoint(x / this.ringNodes.length, y / this.ringNodes.length);
    return this.centroid;
  }

  /**
   * Equivalent to tmPoly::CalcPolyIsConvex(): true iff every consecutive
   * turn around the (CCW-wound) ring is a left turn, within tolerance — a
   * clockwise-wound ring fails this the same way a genuinely concave one
   * does, since its turns are consistently right turns.
   */
  calcPolyIsConvex(tolerance = 1e-4) {
    const n = this.ringNodes.length;
    if (n < 3) return false;
    for (let i = 0; i <= n - 3; i += 1) {
      const p1 = this.ringNodes[i].getLoc();
      const p2 = this.ringNodes[(i + 1) % n].getLoc();
      const p3 = this.ringNodes[(i + 2) % n].getLoc();
      if (angleChange(p1, p2, p3) < -tolerance) return false;
    }
    return true;
  }

  /**
   * Equivalent to tmPoly::CalcPolyEnclosesNode(): true if this (assumed
   * convex) polygon's interior contains the location of any node in
   * `nodeList` that isn't itself one of the polygon's own ring nodes.
   */
  calcPolyEnclosesNode(nodeList) {
    for (const node of nodeList) {
      if (!this.ringNodes.includes(node) && this.convexEncloses(node.getLoc())) return true;
    }
    return false;
  }

  /**
   * Equivalent to tmPoly::ConvexEncloses(): half-plane intersection test
   * against each ring edge, valid only for a convex ring. Each edge's
   * normal is oriented toward the centroid first, so the test is correct
   * regardless of the ring's actual winding direction.
   */
  convexEncloses(point) {
    if (!this.centroid) this.calcCentroid();
    if (!this.centroid) return false;
    const n = this.ringPaths.length;
    for (let i = 0; i < n; i += 1) {
      const path = this.ringPaths[i];
      const p1 = path.getFirstNode().getLoc();
      const p2 = path.getLastNode().getLoc();
      let normal = p2.subtract(p1).perpendicular();
      if (this.centroid.subtract(p1).dot(normal) < 0) normal = normal.scale(-1);
      if (point.subtract(p1).dot(normal) < 0) return false;
    }
    return true;
  }

  /**
   * Equivalent to tmPoly::FindAnyPath(): looks up the pre-existing path
   * between two of this poly's own ring nodes, among the paths this poly
   * itself built one recursion level ago (buildPolyContents()'s Part II).
   */
  findAnyPath(nodeA, nodeB) {
    return this.ownedPaths.find(p => (
      (p.getFirstNode() === nodeA && p.getLastNode() === nodeB) ||
      (p.getFirstNode() === nodeB && p.getLastNode() === nodeA)
    )) || null;
  }

  /**
   * Equivalent to tmPoly::BuildPolyContents(): the "universal molecule"
   * algorithm — fills this polygon's interior with inset nodes/paths (and,
   * for a 3+ sided result, recursively partitions and insets further), so
   * every ring node ends up connected by a spoke to where it lands after
   * insetting as far as the tree's geometry allows — then, once all of
   * that (and any recursion into subPolys) is done, classifies the actual
   * AXIAL/GUSSET/RIDGE/HINGE creases (_buildCreases()).
   */
  buildPolyContents() {
    if (this.hasPolyContents()) return;
    const n = this.ringNodes.length;
    if (n < 3) return; // shouldn't happen for a validly-built poly

    if (n === 3) {
      this._buildTriangleContents();
    } else {
      this._buildGeneralContents();
    }
    this._buildCreases();
  }

  // Equivalent to tmPoly::GetOutermostPoly(): walks up polyOwner (tmTree
  // for a top-level poly, otherwise the parent tmPoly) to the top-level
  // poly that owns this one.
  getOutermostPoly() {
    return this.polyOwner instanceof tmPoly ? this.polyOwner.getOutermostPoly() : this;
  }

  // Equivalent to tmCreaseOwner::GetCrease()/GetOrMakeCrease() on a tmPoly
  // (RIDGE and upward-propagated HINGE creases are always requested on
  // getOutermostPoly(), never on `this` directly from outside — see
  // _buildCreases()).
  getCrease(v1, v2) {
    return this.ownedCreases.find(c => (
      (c.getVertex(0) === v1 && c.getVertex(1) === v2) ||
      (c.getVertex(0) === v2 && c.getVertex(1) === v1)
    )) || null;
  }

  getOrMakeCrease(v1, v2, kind) {
    const existing = this.getCrease(v1, v2);
    if (existing) return existing;
    const crease = new tmCrease(null, v1, v2);
    crease.kind = kind;
    crease.owner = this;
    crease.ownerKind = 'poly';
    this.ownedCreases.push(crease);
    return crease;
  }

  /**
   * Equivalent to tmPoly::GetRidgelineNodesAndPaths(): the chain of nodes/
   * paths from `frontNode` up through this poly's own inset construction
   * (spoke -> [ridge | recurse into whichever subPoly bridges the two
   * corners' inset images] -> spoke) back down to `backNode`. Precondition
   * (unchecked here, matching the original which only asserts it in debug
   * builds): frontNode/backNode must be CCW-consecutive entries of
   * this.ringNodes.
   */
  getRidgelineNodesAndPaths(frontNode, backNode) {
    const n = this.ringNodes.length;
    const frontOffset = this.ringNodes.indexOf(frontNode);
    const backOffset = (frontOffset + 1) % n;

    const ridgeNodes = [frontNode];
    const ridgePaths = [this.spokePaths[frontOffset]];

    if (this.ownedNodes.length === 1) {
      ridgeNodes.push(this.ownedNodes[0]);
    } else if (this.ownedNodes.length === 2) {
      const frontInset = this.insetNodes[frontOffset];
      const backInset = this.insetNodes[backOffset];
      ridgeNodes.push(frontInset);
      if (frontInset !== backInset) {
        ridgePaths.push(this.ridgePath);
        ridgeNodes.push(backInset);
      }
    } else {
      const frontInset = this.insetNodes[frontOffset];
      const backInset = this.insetNodes[backOffset];
      if (frontInset === backInset) {
        ridgeNodes.push(frontInset);
      } else {
        const subPoly = this.subPolys.find(sp => (
          sp.ringNodes.includes(frontInset) && sp.ringNodes.includes(backInset)
        ));
        if (!subPoly) {
          console.warn('getRidgelineNodesAndPaths: no subPoly connects the two inset corners');
        } else {
          const sub = subPoly.getRidgelineNodesAndPaths(frontInset, backInset);
          ridgeNodes.push(...sub.ridgeNodes);
          ridgePaths.push(...sub.ridgePaths);
        }
      }
    }

    ridgePaths.push(this.spokePaths[backOffset]);
    ridgeNodes.push(backNode);
    return { ridgeNodes, ridgePaths };
  }

  // Equivalent to tmPoly.cpp's SortableRidgeVertex sort key: angle of the
  // vertex around the midpoint of chord frontPt-backPt, chosen (per the
  // original's own comment) over dot-product-along-the-chord sorting
  // because vertices at each end of a 90-degree ridge crease would tie on
  // dot product to roundoff.
  _ridgeSortValue(p, frontPt, backPt) {
    const pu = backPt.subtract(frontPt).normalize();
    const pv = pu.perpendicular();
    const mid = frontPt.add(backPt).scale(0.5);
    const dp = p.subtract(mid);
    return Math.atan2(dp.dot(pu), dp.dot(pv));
  }

  /**
   * Equivalent to tmPoly::GetRidgelineVertices(): every vertex along the
   * ridgeline from `frontNode` to `backNode` (junction nodes get their
   * vertex lazily created here if they don't have one yet — a ridgeline
   * peak above an inactive border path might not have needed one before
   * now), sorted front-to-back by _ridgeSortValue().
   */
  getRidgelineVertices(frontNode, backNode) {
    const { ridgeNodes, ridgePaths } = this.getRidgelineNodesAndPaths(frontNode, backNode);
    const frontPt = frontNode.getLoc();
    const backPt = backNode.getLoc();
    const entries = [];
    for (const node of ridgeNodes) {
      if (node.isJunctionNode) node.getOrMakeVertexSelf();
      const vertex = node.getVertex();
      if (vertex) entries.push({ vertex, sortValue: this._ridgeSortValue(vertex.getLoc(), frontPt, backPt) });
    }
    for (const path of ridgePaths) {
      for (const vertex of path.vertices) {
        entries.push({ vertex, sortValue: this._ridgeSortValue(vertex.getLoc(), frontPt, backPt) });
      }
    }
    entries.sort((a, b) => a.sortValue - b.sortValue);
    return entries.map(entry => entry.vertex);
  }

  /**
   * Equivalent to the crease-classification block inside
   * tmPoly::BuildPolyContents() (tmPoly.cpp:1007-1135): decides which
   * actual tmCrease objects exist along this poly's ring and what kind
   * each is. Two full passes over ringPaths, deliberately not merged: pass
   * 1 builds every ring path's own interior vertices and propagates hinge
   * creases UP onto the ridgeline; pass 2 needs every ridgeline fully
   * populated (which can receive vertices from more than one ring path)
   * before it can correctly sort/connect ridge creases, propagate hinges
   * DOWN for inactive axial paths, and finally connect each path's own
   * AXIAL/GUSSET creases.
   */
  _buildCreases() {
    const n = this.ringNodes.length;
    const outermost = this.getOutermostPoly();

    // Pass 1: self-vertices, then hinge creases propagated up onto the ridgeline.
    for (let i = 0; i < n; i += 1) {
      const frontNode = this.ringNodes[i];
      const backNode = this.ringNodes[(i + 1) % n];
      const thePath = this.ringPaths[i];

      if (thePath.isAxialPath() || thePath.isGussetPath()) {
        thePath.buildSelfVertices();
      }
      if (thePath.isActiveAxialPath() || thePath.isGussetPath()) {
        const { ridgePaths } = this.getRidgelineNodesAndPaths(frontNode, backNode);
        for (const botVertex of thePath.vertices) {
          for (const ridgePath of ridgePaths) {
            const q1 = ridgePath.getFirstNode().getLoc();
            const q2 = ridgePath.getLastNode().getLoc();
            const q = projectPtoQ(frontNode.getLoc(), backNode.getLoc(), botVertex.getLoc(), q1, q2);
            if (!q) continue;
            const topVertex = ridgePath.getOrMakeVertex(q, botVertex.treeNode);
            outermost.getOrMakeCrease(botVertex, topVertex, CreaseKind.UNFOLDED_HINGE);
            break;
          }
        }
      }
    }

    // Pass 2: RIDGE creases, hinge/pseudohinge propagated down for
    // inactive axial paths, and each path's own AXIAL/GUSSET creases.
    for (let i = 0; i < n; i += 1) {
      const frontNode = this.ringNodes[i];
      const backNode = this.ringNodes[(i + 1) % n];
      const thePath = this.ringPaths[i];

      if (thePath.isAxialPath() || thePath.isGussetPath()) {
        const ridgeVertices = this.getRidgelineVertices(frontNode, backNode);
        for (let k = 0; k < ridgeVertices.length - 1; k += 1) {
          outermost.getOrMakeCrease(ridgeVertices[k], ridgeVertices[k + 1], CreaseKind.RIDGE);
        }
      }

      if (thePath.isAxialPath() && !thePath.isActivePath()) {
        const frontVertex = frontNode.getVertex();
        const backVertex = backNode.getVertex();
        if (frontVertex && backVertex) {
          const p1 = frontVertex.getLoc();
          const p2 = backVertex.getLoc();
          const ridgeVertices = this.getRidgelineVertices(frontNode, backNode);
          let crease0 = null;
          let crease1 = null;
          let crease2 = null;
          for (let m = 1; m <= ridgeVertices.length - 2; m += 1) {
            const ridgeVertex = ridgeVertices[m];
            let kind = null;
            if (ridgeVertex.treeNode) {
              kind = CreaseKind.UNFOLDED_HINGE;
            } else {
              const prev = ridgeVertices[m - 1];
              const next = ridgeVertices[m + 1];
              if (prev.treeNode && next.treeNode && prev.treeNode === next.treeNode) kind = CreaseKind.PSEUDOHINGE;
            }
            if (!kind) continue;

            const p = projectQtoP(ridgeVertex.getLoc(), p1, p2);
            if (!p) continue;
            const botVertex = thePath.getOrMakeVertex(p, ridgeVertex.treeNode);
            crease2 = crease1;
            crease1 = crease0;
            // Unqualified (called on `this`, not getOutermostPoly()) —
            // matches the original's literal, possibly deliberate quirk;
            // see the ownedCreases field comment.
            crease0 = this.getOrMakeCrease(botVertex, ridgeVertex, kind);
            if (
              crease0 && crease1 && crease2 &&
              crease0.kind === CreaseKind.UNFOLDED_HINGE &&
              crease1.kind === CreaseKind.PSEUDOHINGE &&
              crease2.kind === CreaseKind.UNFOLDED_HINGE
            ) {
              const mate0 = crease0.getLowerVertex();
              const mate2 = crease2.getLowerVertex();
              mate0.rightPseudohingeMate = mate2;
              mate2.leftPseudohingeMate = mate0;
            }
          }
        }
      }

      if (thePath.isAxialPath() || thePath.isGussetPath()) {
        thePath.connectSelfVertices(thePath.isAxialPath() ? CreaseKind.AXIAL : CreaseKind.GUSSET);
      }
    }

    // Facet construction only applies to major (top-level) polys — matches
    // tmPoly::BuildPolyContents()'s `if (mIsSubPoly) return;` guard. All
    // creases at every recursion depth funnel up onto either the outermost
    // poly's ownedCreases (RIDGE + most HINGE/PSEUDOHINGE) or the
    // individual ring paths' own creases (AXIAL/GUSSET), so this list is
    // enough to seed a facet-construction walk that reaches every facet in
    // the whole nested molecule — see buildFacetsFromCreases().
    if (!this.isTreePoly) return;
    const facetCreases = [...this.ownedCreases];
    for (const path of this.ringPaths) facetCreases.push(...path.creases);
    this.buildFacetsFromCreases(facetCreases);
  }

  // Equivalent to tmFacetOwner::CanStartFacetFwd()/CanStartFacetBkd(): a
  // crease may seed a facet walk in a direction only if that slot
  // (fwdFacet/bkdFacet) is still empty, and — for an axial crease — only
  // if walking that direction actually faces into this poly's interior
  // (an axial crease facing outward would try to build a "facet" outside
  // the poly).
  _canStartFacetFwd(crease) {
    if (crease.fwdFacet) return false;
    if (!crease.isAxialCrease()) return true;
    return areCCW(crease.getVertex(0).getLoc(), crease.getVertex(1).getLoc(), this.centroid);
  }

  _canStartFacetBkd(crease) {
    if (crease.bkdFacet) return false;
    if (!crease.isAxialCrease()) return true;
    return areCW(crease.getVertex(0).getLoc(), crease.getVertex(1).getLoc(), this.centroid);
  }

  // Equivalent to tmFacetOwner::CalcHasPlanarCreases(): false if any pair
  // of creases in the list cross in their interior — the facet-walk
  // algorithm assumes a planar embedding.
  _calcHasPlanarCreases(creaseList) {
    for (let i = 1; i < creaseList.length; i += 1) {
      for (let j = 0; j < i; j += 1) {
        if (creaseList[i].intersectsInterior(creaseList[j])) return false;
      }
    }
    return true;
  }

  /**
   * Equivalent to tmFacetOwner::GetNextCreaseAndVertex(): starting from
   * `thisCrease` incident to `thisVertex`, find the next crease
   * counterclockwise around `thisVertex` (the smallest positive angular
   * step away from thisCrease's own direction), and the vertex at its far
   * end.
   */
  _getNextCreaseAndVertex(thisCrease, thisVertex) {
    const thatVertexOf = (crease) => (crease.getVertex(0) === thisVertex ? crease.getVertex(1) : crease.getVertex(0));
    const thisAngle = thatVertexOf(thisCrease).getLoc().subtract(thisVertex.getLoc()).angle();

    let delta = 2 * Math.PI;
    let nextCrease = thisCrease;
    let nextVertex = null;
    for (const thatCrease of thisVertex.creases) {
      if (thatCrease === thisCrease) continue;
      const thatVertex = thatVertexOf(thatCrease);
      const nextAngle = thatVertex.getLoc().subtract(thisVertex.getLoc()).angle();
      let newDelta = thisAngle - nextAngle;
      while (newDelta < 0) newDelta += 2 * Math.PI;
      while (newDelta >= 2 * Math.PI) newDelta -= 2 * Math.PI;
      if (newDelta < delta) {
        delta = newDelta;
        nextCrease = thatCrease;
        nextVertex = thatVertex;
      }
    }
    return { nextCrease, nextVertex };
  }

  /**
   * Equivalent to tmFacetOwner::BuildFacetsFromCreases(): starting from a
   * seed list of creases, construct a complete network of counterclockwise
   * facets with their creases and vertices — walking around each not-yet-
   * used direction of a crease (fwdFacet/bkdFacet) via
   * _getNextCreaseAndVertex() until the walk returns to its starting
   * vertex.
   */
  buildFacetsFromCreases(creaseList) {
    if (creaseList.length === 0) return;
    if (!this._calcHasPlanarCreases(creaseList)) {
      console.warn('buildFacetsFromCreases: crease network is not planar, skipping facet construction');
      return;
    }

    const walk = (startCrease, forward) => {
      const facet = new tmFacet();
      facet.setOwnerPoly(this);
      const firstVertex = startCrease.getVertex(forward ? 0 : 1);
      if (forward) startCrease.fwdFacet = facet;
      else startCrease.bkdFacet = facet;
      let thisCrease = startCrease;
      let thisVertex = startCrease.getVertex(forward ? 1 : 0);
      facet.vertices.push(firstVertex);
      facet.creases.push(thisCrease);
      let guard = 0;
      let nextVertex;
      do {
        const next = this._getNextCreaseAndVertex(thisCrease, thisVertex);
        const nextCrease = next.nextCrease;
        nextVertex = next.nextVertex;
        facet.vertices.push(thisVertex);
        facet.creases.push(nextCrease);
        if (nextCrease.getVertex(0) === thisVertex) nextCrease.fwdFacet = facet;
        else nextCrease.bkdFacet = facet;
        thisCrease = nextCrease;
        thisVertex = nextVertex;
        guard += 1;
        if (guard >= 100) {
          console.warn('buildFacetsFromCreases: facet walk exceeded 100 steps, aborting');
          break;
        }
      } while (nextVertex !== firstVertex);
      facet.calcContents();
    };

    for (const crease of creaseList) {
      if (this._canStartFacetFwd(crease)) walk(crease, true);
      if (this._canStartFacetBkd(crease)) walk(crease, false);
    }
  }

  /**
   * Equivalent to tmPoly::CalcBend(): tells this poly's own owned creases
   * (RIDGE + most/all HINGE — see the ownedCreases field comment) to
   * refine their own bend status, then rebuilds mLocalRootVertices/
   * mLocalRootCreases — the hinge creases/vertices at the *smallest*
   * discrete depth found among every vertex in this poly (i.e. closest to
   * the tree's root), which is what tmTree.calcRootNetworks() splices
   * together into the global facet-ordering graph.
   */
  calcBend() {
    for (const crease of this.ownedCreases) crease.calcBend();

    const allVertices = new Set();
    for (const crease of this.ownedCreases) {
      for (const vertex of crease.getVertices()) if (vertex) allVertices.add(vertex);
    }
    for (const node of this.ringNodes) {
      const vertex = node.getVertex();
      if (vertex) allVertices.add(vertex);
    }

    this.localRootVertices = [];
    this.localRootCreases = [];
    let minDiscreteDepth = Infinity;
    for (const vertex of allVertices) {
      const discreteDepth = vertex.getDiscreteDepth();
      if (discreteDepth === null) continue;
      if (minDiscreteDepth > discreteDepth) {
        minDiscreteDepth = discreteDepth;
        this.localRootVertices = [];
        this.localRootCreases = [];
      }
      if (minDiscreteDepth === discreteDepth) {
        if (!this.localRootVertices.includes(vertex)) this.localRootVertices.push(vertex);
        for (const crease of vertex.creases) {
          if (crease.isHingeCrease() && this.ownedCreases.includes(crease) && !this.localRootCreases.includes(crease)) {
            this.localRootCreases.push(crease);
          }
        }
      }
    }
  }

  // Equivalent to tmPoly::GetIncidentInteriorFacet(): the facet incident to
  // `axialCrease` that's actually owned by this poly (as opposed to
  // whatever poly lies on the other side of the crease).
  getIncidentInteriorFacet(axialCrease) {
    if (axialCrease.fwdFacet && this.facets.includes(axialCrease.fwdFacet)) return axialCrease.fwdFacet;
    return axialCrease.bkdFacet;
  }

  // Equivalent to tmPoly::GetIncidentInteriorCrease(): the hinge or ridge
  // crease incident to `axialVertex` that this poly owns.
  getIncidentInteriorCrease(axialVertex) {
    for (const crease of axialVertex.creases) {
      if ((crease.isHingeCrease() || crease.isRidgeCrease()) && this.ownedCreases.includes(crease)) return crease;
    }
    throw new Error("tmPoly.getIncidentInteriorCrease(): couldn't find crease");
  }

  /**
   * Equivalent to tmPoly::BuildCorridorLinks(): recursively links facets
   * along a corridor (the strip of facets between two consecutive ridge
   * creases, running from an axial/gusset "bottom" up to another bottom)
   * into the facet-ordering graph, starting from `fromCrease`/`fromFacet`.
   */
  buildCorridorLinks(fromCrease, fromFacet) {
    const botCrease = fromFacet.getBottomCrease();
    if (botCrease === fromCrease) {
      // Going up: propagate across every ridge crease incident to the facet.
      for (const nextCrease of fromFacet.getCreases()) {
        if (!nextCrease.isRidgeCrease()) continue;
        const nextFacet = nextCrease.getOtherFacet(fromFacet);
        if (botCrease.isAxialCrease()) {
          // Don't need to cross ridges that will be crossed as part of the axial loop.
          if (nextFacet === fromFacet.getLeftFacet() || nextFacet === fromFacet.getRightFacet()) continue;
        }
        if (tmFacet.areLinked(fromFacet, nextFacet)) continue;
        fromFacet.linkTo(nextFacet);
        this.buildCorridorLinks(nextCrease, nextFacet);
      }
    } else if (botCrease.isGussetCrease()) {
      // Going down, bottom crease is gusset: propagate across it.
      const nextFacet = botCrease.getOtherFacet(fromFacet);
      fromFacet.linkTo(nextFacet);
      this.buildCorridorLinks(botCrease, nextFacet);
    } else {
      // Going down, bottom crease is axial. A normal facet stops here.
      if (fromFacet.isNotPseudohingeFacet()) return;
      // A pseudohinge facet connects to its adjacent pseudohinge facet and
      // starts back upward.
      let phCrease = fromFacet.getLeftCrease();
      let nextFacet;
      if (phCrease.isPseudohingeCrease()) {
        nextFacet = phCrease.getLeftFacet();
      } else {
        phCrease = fromFacet.getRightCrease();
        nextFacet = phCrease.getRightFacet();
      }
      fromFacet.linkTo(nextFacet);
      this.buildCorridorLinks(nextFacet.getBottomCrease(), nextFacet);
    }
  }

  /**
   * Equivalent to tmPoly::CalcLocalFacetOrder(): constructs the facet-
   * ordering graph within this poly alone — a complete loop around the
   * axial boundary, plus every corridor crossing launched from each facet
   * on that loop. Breaking the loop at any local-root vertex (done later,
   * across the whole tree, by tmTree.calcFacetOrder()) turns this into a
   * valid ordering graph.
   */
  calcLocalFacetOrder() {
    for (const facet of this.facets) facet.clearLinks();

    let startVertex = null;
    for (const vertex of this.localRootVertices) {
      if (vertex.isAxialVertex()) {
        startVertex = vertex;
        break;
      }
    }
    if (!startVertex) throw new Error('tmPoly.calcLocalFacetOrder(): no local root axial vertex found');
    let startFacet = this.getIncidentInteriorCrease(startVertex).getRightNonPseudohingeFacet();

    let curFacet = startFacet;
    do {
      const nextFacet = curFacet.getRightNonPseudohingeFacet();
      curFacet.linkTo(nextFacet);
      this.buildCorridorLinks(curFacet.getBottomCrease(), curFacet);
      curFacet = nextFacet;
    } while (curFacet !== startFacet);
  }

  // Equivalent to tmPoly::SetFacetCorridorEdge(): assigns `edge` as the
  // corridor edge of `facet`, then propagates to every adjacent facet
  // still within this poly and the same corridor (not crossing a regular
  // hinge crease, which bounds a corridor).
  setFacetCorridorEdge(facet, edge) {
    facet.corridorEdge = edge;
    for (const crease of facet.getCreases()) {
      if (crease.isRegularHingeCrease()) continue;
      const otherFacet = crease.getOtherFacet(facet);
      if (!otherFacet || !this.facets.includes(otherFacet) || otherFacet.corridorEdge) continue;
      this.setFacetCorridorEdge(otherFacet, edge);
    }
  }

  // Equivalent to tmPoly::CalcFacetCorridorEdges(): launches corridor-edge
  // assignment from every axial facet whose bottom crease's vertices both
  // project to real tree nodes (giving an unambiguous tree edge). Only
  // ever called (via tmTree.calcFacetCorridorEdges()) on a top-level poly,
  // whose polyOwner is the tree itself.
  calcFacetCorridorEdges() {
    for (const facet of this.facets) {
      if (facet.corridorEdge || !facet.isAxialFacet()) continue;
      const botCrease = facet.getBottomCrease();
      const n1 = botCrease.getVertex(0).treeNode;
      const n2 = botCrease.getVertex(1).treeNode;
      if (!n1 || !n2) continue;
      const edge = this.polyOwner.getEdge(n1, n2);
      if (!edge) continue;
      this.setFacetCorridorEdge(facet, edge);
    }
  }

  /**
   * A triangle's three angle bisectors always meet at one point (the
   * incenter), so there's no need to run the general inset search: inset
   * every corner all the way to the incenter in one step.
   */
  _buildTriangleContents() {
    const [p1, p2, p3] = this.ringNodes.map(node => node.getLoc());
    const center = incenter(p1, p2, p3);
    const node = new tmNode(null, center);
    node.isSubNode = true; // purely geometric — not an actual tree node
    node.isJunctionNode = true;
    node.elevation = this.ringNodes[0].getElevation() + inradius(p1, p2, p3);
    this.ownedNodes.push(node);
    this.insetNodes = this.ringNodes.map(() => node);
    this._buildSpokePaths();
  }

  /**
   * The general n>=4 inset: find the largest inset distance `h` that (a)
   * doesn't collapse any ring edge past zero length and (b) doesn't make
   * any cross-path (diagonal) shorter than the tree demands, move every
   * corner inward by `h` along its bisector, merge corners that land on
   * the same point into junction nodes, and — if 3 or more distinct points
   * remain — build a full path network among them and recurse.
   */
  _buildGeneralContents() {
    const n = this.ringNodes.length;
    const p = this.ringNodes.map(node => node.getLoc());

    // Part I: per-corner bisector data and the max inset distance search.
    const rp = []; // unit vector from corner i toward its previous neighbor
    const rn = []; // unit vector from corner i toward its next neighbor
    const r = [];  // motion vector for corner i, scaled so h=1 means "inset by 1 unit"
    const mr = []; // projection of r[i] onto rp[i] — how fast the adjacent edge shrinks per unit of h
    for (let i = 0; i < n; i += 1) {
      const ip = (i - 1 + n) % n;
      const iN = (i + 1) % n;
      const rpi = p[ip].subtract(p[i]).normalize();
      const rni = p[iN].subtract(p[i]).normalize();
      rp.push(rpi);
      rn.push(rni);
      const bis = rni.subtract(rpi).perpendicular().normalize();
      const ri = bis.divideScalar(bis.dot(rni.perpendicular()));
      r.push(ri);
      mr.push(ri.dot(rpi));
    }

    let h = 1e10; // HMAX sentinel
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        if (areParallel(r[i], r[j]) && r[i].dot(r[j]) > 0) continue;
        const adjacent = j === i + 1 || (i === 0 && j === n - 1);
        if (adjacent) {
          const bi = lineIntersection(p[i], r[i], p[j], r[j]);
          if (!bi) continue;
          const h1 = bi.subtract(p[i]).dot(rn[i].perpendicular());
          if (h1 > 0 && h > h1) h = h1;
        } else {
          const outsetPath = this.polyOwner.findAnyPath(this.ringNodes[i], this.ringNodes[j]);
          if (!outsetPath) continue;
          const lij = outsetPath.minPaperLength;
          const u = p[i].subtract(p[j]);
          const v = r[i].subtract(r[j]);
          const w = mr[i] + mr[j];
          const a = v.dot(v) - w * w;
          const b = u.dot(v) + lij * w;
          const c = u.dot(u) - lij * lij;
          const d = b * b - a * c;
          if (d < 0) continue;
          const sqrtD = Math.sqrt(d);
          for (const h1 of [(-b + sqrtD) / a, (-b - sqrtD) / a]) {
            const lijp = lij - h1 * w;
            if (lijp > 0 && h1 > 0 && h > h1) h = h1;
          }
        }
      }
    }
    if (!(h < 1e10)) {
      console.warn('buildPolyContents: no valid inset distance found, leaving polygon empty');
      return;
    }

    // Part II: inset every corner by h, merging coincident results.
    this.insetNodes = p.map((corner, i) => this._getOrMakeInsetNode(corner.add(r[i].scale(h)), h));
    const distinctNodes = [...new Set(this.insetNodes)];

    if (distinctNodes.length === 1) {
      this._buildSpokePaths();
      return;
    }
    if (distinctNodes.length === 2) {
      const ridge = new tmPath();
      ridge.nodes = [distinctNodes[0], distinctNodes[1]];
      this.ridgePath = ridge;
      this.ownedPaths.push(ridge);
      this._buildSpokePaths();
      return;
    }

    this._buildInsetPathNetwork(h, r, mr);
    const nodeToPaths = new Map(distinctNodes.map(node => [node, []]));
    for (const path of this.ownedPaths) {
      nodeToPaths.get(path.getFirstNode())?.push(path);
      nodeToPaths.get(path.getLastNode())?.push(path);
    }
    const built = buildPolysFromPaths({
      paths: this.ownedPaths,
      borderNodes: distinctNodes,
      nodeToPaths,
      createPoly: () => {
        const sub = new tmPoly();
        sub.isTreePoly = false;
        sub.polyOwner = this;
        return sub;
      }
    });
    this.subPolys.push(...built);
    for (const sub of this.subPolys) sub.buildPolyContents();

    this._buildSpokePaths();
  }

  /**
   * Equivalent to tmPoly::GetOrMakeInsetNode(): finds the existing owned
   * node within DIST_TOL of `pos`, marking it a junction node (since ≥2
   * ring corners now land on it) — or creates a fresh one.
   */
  _getOrMakeInsetNode(pos, h) {
    for (const node of this.ownedNodes) {
      if (node.getLoc().distance(pos) < DIST_TOL) {
        node.isJunctionNode = true;
        return node;
      }
    }
    const node = new tmNode(null, pos);
    node.isSubNode = true; // purely geometric — not an actual tree node
    node.elevation = this.ringNodes[0].getElevation() + h;
    this.ownedNodes.push(node);
    return node;
  }

  /**
   * Equivalent to the path-network-building part of tmPoly::BuildPolyContents():
   * a complete graph of paths among the distinct inset nodes, one per pair
   * of original ring corners whose inset images differ, processed in order
   * of increasing ring-index distance `dij` so that dij==1 (originally-
   * adjacent) pairs — which become the new ring — are flagged as border
   * paths.
   */
  _buildInsetPathNetwork(h, r, mr) {
    const n = this.ringNodes.length;
    const pairs = [];
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        const step = j - i;
        pairs.push({ i, j, dij: Math.min(step, n - step) });
      }
    }
    pairs.sort((first, second) => first.dij - second.dij);

    const seen = new Set();
    for (const { i, j, dij } of pairs) {
      const ni = this.insetNodes[i];
      const nj = this.insetNodes[j];
      if (ni === nj) continue;
      const key = ni.id < nj.id ? `${ni.id}:${nj.id}` : `${nj.id}:${ni.id}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const outsetPath = this.polyOwner.findAnyPath(this.ringNodes[i], this.ringNodes[j]);
      if (!outsetPath) continue;

      // Preserve the outset path's front/back orientation so the new path
      // network keeps the same CCW convention the ring-tracing depends on.
      const iIsFront = outsetPath.getFirstNode() === this.ringNodes[i];
      const frontNode = iIsFront ? ni : nj;
      const backNode = iIsFront ? nj : ni;
      const frontReduction = h * (iIsFront ? mr[i] : mr[j]);
      const backReduction = h * (iIsFront ? mr[j] : mr[i]);
      const minPaperLength = Math.max(0, outsetPath.minPaperLength - frontReduction - backReduction);
      const actPaperLength = frontNode.getLoc().distance(backNode.getLoc());
      // Equivalent to tmPath::TestIsActive()/TestIsFeasible(): both compare
      // paper-unit lengths against tmPart::DistTol() (1e-4), not a tighter
      // ad hoc epsilon.
      const isActiveGeometry = outsetPath.isActiveGeometry || Math.abs(actPaperLength - minPaperLength) < DIST_TOL;

      const path = new tmPath();
      path.nodes = [frontNode, backNode];
      path.outsetPath = outsetPath;
      path.frontReduction = frontReduction;
      path.backReduction = backReduction;
      path.minPaperLength = minPaperLength;
      path.actPaperLength = actPaperLength;
      path.isActiveGeometry = isActiveGeometry;
      path.isFeasible = actPaperLength >= minPaperLength - DIST_TOL;
      path.isBorderPath = dij === 1;
      path.isPolygonPath = isActiveGeometry || path.isBorderPath;

      this.ownedPaths.push(path);
    }
  }

  _buildSpokePaths() {
    for (let i = 0; i < this.ringNodes.length; i += 1) {
      const spoke = new tmPath();
      spoke.nodes = [this.ringNodes[i], this.insetNodes[i]];
      this.spokePaths.push(spoke);
    }
  }

  // Get bounding box
  getBoundingBox() {
    if (this.vertices.length === 0) {
      return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    }
    
    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;
    
    for (const vertex of this.vertices) {
      const loc = vertex.getLocation();
      minX = Math.min(minX, loc.x);
      minY = Math.min(minY, loc.y);
      maxX = Math.max(maxX, loc.x);
      maxY = Math.max(maxY, loc.y);
    }
    
    return { minX, minY, maxX, maxY };
  }

  // Check if point is inside polygon (using ray casting)
  containsPoint(point) {
    if (this.vertices.length < 3) return false;
    
    let inside = false;
    for (let i = 0, j = this.vertices.length - 1; i < this.vertices.length; j = i++) {
      const xi = this.vertices[i].getLocation().x;
      const yi = this.vertices[i].getLocation().y;
      const xj = this.vertices[j].getLocation().x;
      const yj = this.vertices[j].getLocation().y;
      
      const intersect = ((yi > point.y) !== (yj > point.y))
        && (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    
    return inside;
  }

  // Clone
  clone() {
    const poly = new tmPoly(this.id);
    poly.isTreePoly = this.isTreePoly;
    poly.isConvex = this.isConvex;
    poly.hasInnerBoundary = this.hasInnerBoundary;
    poly.vertices = [...this.vertices];
    return poly;
  }

  // String representation
  toString() {
    return `Poly(${this.id}, ${this.vertices.length} vertices)`;
  }
}
