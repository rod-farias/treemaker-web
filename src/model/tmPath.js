/**
 * tmPath.js
 * Represents a path through the tree (sequence of nodes)
 * Equivalent to tmPath class in TreeMaker C++
 */

import { tmVertex } from './tmVertex.js';
import { tmCrease } from './tmCrease.js';

// Equivalent to tmVertex::VERTEX_TOL (0.003): deliberately looser than
// tmPart::DistTol() (1e-4) for vertex coincidence, "to cut down on
// spurious closely-spaced creases".
const VERTEX_TOL = 0.003;

export class tmPath {
  constructor(id = null) {
    this.id = id || Math.random().toString(36).substr(2, 9);
    this.label = '';
    
    // Topology: sequence of nodes that form the path
    this.nodes = [];  // ordered array of nodes
    this.minTreeLength = 0; // minimum tree distance along the path
    this.scale = 1;
    
    // Properties
    this.isActive = false;      // path is active (used for origami)
    this.isActiveGeometry = false; // actual length equals minimum length
    this.isFeasible = true;     // path satisfies its current minimum constraints
    this.angleFixed = false;    // angle is fixed
    this.angle = 0;             // fixed angle
    this.angleQuant = false;    // angle is quantized
    this.quantValue = 4;        // number of quantizations
    this.quantOffset = 0;       // offset for quantization

    // Polygon-partition classification (see tmTree._classifyLeafPaths()/
    // _calcBorderNodesAndPaths()/_calcPolygonNetwork()). Only meaningful for
    // leaf-to-leaf paths; recomputed from scratch on every buildTreePolys().
    this.isLeafPath = false;    // both endpoints are leaf nodes
    this.isBorderPath = false;  // an edge of the leaf nodes' convex hull
    this.isPolygonPath = false; // taut or feasible-border: a candidate edge of the polygon arrangement
    this.fwdPoly = null;        // polygon to the left when walked front->back
    this.bkdPoly = null;        // polygon to the left when walked back->front

    // Set directly (not via minTreeLength/scale) for the synthetic inset
    // paths tmPoly.buildPolyContents() creates between inset nodes — those
    // aren't tree-graph paths, so there's no tree distance to derive a
    // paper length from; see tmPoly.js's inset-path construction.
    this.minPaperLength = 0;
    this.actPaperLength = 0;
    this.frontReduction = 0;    // how much inset shrank this path from its outset path, at the front end
    this.backReduction = 0;     // ...at the back end
    this.outsetPath = null;     // the path one level up in the inset recursion that this one narrows

    // Equivalent to tmPath::mMinDepth/mMinDepthDist: the local 1D depth
    // coordinate system established along this path (front-node depth, and
    // how far in from the front the path's minimum-depth point sits) — set
    // by tmTree.calcDepthAndBend() for every leaf path and every gusset
    // path, and consumed by setVertexDepth() below to place any vertex
    // that projects onto this path's line.
    this.minDepth = 0;
    this.minDepthDist = 0;

    // Associated parts. `vertices` doubles as tmPath::mOwnedVertices — the
    // path-interior vertices built by buildSelfVertices()/getOrMakeVertex(),
    // kept in path order (front to back) — and `creases` as
    // tmPath::mOwnedCreases — the AXIAL/GUSSET creases this path owns,
    // built by connectSelfVertices() (see tmPoly.js's crease-building pass
    // for the RIDGE/HINGE creases owned by the polygon instead).
    this.creases = [];  // creases on this path
    this.vertices = []; // vertices along this path
    this.conditions = [];
  }

  // Getters
  getLabel() {
    return this.label;
  }

  getNodes() {
    return this.nodes;
  }

  getNumNodes() {
    return this.nodes.length;
  }

  isPathActive() {
    return this.isActive;
  }

  isFeasiblePath() {
    return this.isFeasible;
  }

  isInfeasiblePath() {
    return !this.isFeasible;
  }

  isGeometricallyActive() {
    return this.isActiveGeometry;
  }

  // Equivalent to tmPath::IsActivePath(): alias kept alongside
  // isGeometricallyActive() so code porting the crease-classification pass
  // can match the original's method name directly.
  isActivePath() {
    return this.isActiveGeometry;
  }

  // Equivalent to tmPath::IsAxialPath(): a leaf path that's also a polygon
  // (border-of-the-arrangement) path — the crease pattern's "spine".
  isAxialPath() {
    return this.isLeafPath && this.isPolygonPath;
  }

  // Equivalent to tmPath::IsGussetPath(): active but not on the polygon
  // border — an active interior/cross path.
  isGussetPath() {
    return this.isActiveGeometry && !this.isBorderPath;
  }

  // Equivalent to tmPath::IsActiveAxialPath().
  isActiveAxialPath() {
    return this.isActiveGeometry && this.isLeafPath;
  }

  getActualLength() {
    return this.getLength();
  }

  getTreeLength() {
    return this.getActualLength() / Math.max(this.scale, 1e-12);
  }

  getLengthSlack() {
    return this.getTreeLength() - this.minTreeLength;
  }

  getAngle() {
    return this.angle;
  }

  getGeometricAngle() {
    if (this.nodes.length < 2) return 0;
    const first = this.nodes[0].getLoc();
    const last = this.nodes[this.nodes.length - 1].getLoc();
    return Math.atan2(last.y - first.y, last.x - first.x);
  }

  getPositiveGeometricAngle() {
    const angle = this.getGeometricAngle();
    return angle >= 0 ? angle : angle + Math.PI * 2;
  }

  // Setters
  setLabel(label) {
    this.label = label;
  }

  setActive(active) {
    this.isActive = Boolean(active);
  }

  setAngleFixed(angle) {
    this.angleFixed = true;
    this.angle = Number(angle);
    this.angleQuant = false;
  }

  setAngleQuant(quantValue, quantOffset = 0) {
    this.angleQuant = true;
    this.quantValue = Number(quantValue);
    this.quantOffset = Number(quantOffset);
    this.angleFixed = false;
  }

  // Add node to path
  addNode(node) {
    if (!this.nodes.includes(node)) {
      this.nodes.push(node);
    }
  }

  // Remove node from path
  removeNode(node) {
    const idx = this.nodes.indexOf(node);
    if (idx >= 0) {
      this.nodes.splice(idx, 1);
    }
  }

  // Get first node
  getFirstNode() {
    return this.nodes.length > 0 ? this.nodes[0] : null;
  }

  // Get last node
  getLastNode() {
    return this.nodes.length > 0 ? this.nodes[this.nodes.length - 1] : null;
  }

  // Get length (sum of edge lengths along path)
  getLength() {
    if (this.nodes.length < 2) return 0;
    let length = 0;
    for (let i = 0; i < this.nodes.length - 1; i++) {
      const n1 = this.nodes[i];
      const n2 = this.nodes[i + 1];
      length += n1.location.distance(n2.location);
    }
    return length;
  }

  getMinTreeLength() {
    return this.minTreeLength;
  }

  getMinPaperLength() {
    return this.minPaperLength;
  }

  // Add crease
  addCrease(crease) {
    if (!this.creases.includes(crease)) {
      this.creases.push(crease);
    }
  }

  // Add vertex
  addVertex(vertex) {
    if (!this.vertices.includes(vertex)) {
      this.vertices.push(vertex);
    }
  }

  // Add condition
  addCondition(condition) {
    if (!this.conditions.includes(condition)) {
      this.conditions.push(condition);
    }
  }

  /**
   * Whether this path and `other` share an endpoint node. Two leaf paths
   * that meet at a shared leaf are defined to never "intersect" (they
   * legitimately touch there, that's not a crossing) — used by
   * IntersectsInterior() below and by tmTree._buildPolysFromPaths()'s
   * sliver-culling pass.
   */
  sharesEndNodeWith(other) {
    const a1 = this.getFirstNode();
    const a2 = this.getLastNode();
    const b1 = other.getFirstNode();
    const b2 = other.getLastNode();
    return a1 === b1 || a1 === b2 || a2 === b1 || a2 === b2;
  }

  /**
   * Whether this path's straight paper segment (front node to back node)
   * crosses `other`'s in their strict interior (not just touching at an
   * endpoint). Used to cull spuriously-both-active diagonals of a
   * near-degenerate ("sliver") polygon before face-tracing — see
   * tmTree._buildPolysFromPaths().
   */
  intersectsInterior(other) {
    if (this.sharesEndNodeWith(other)) return false;
    const p1 = this.getFirstNode().getLoc();
    const p2 = this.getLastNode().getLoc();
    const p3 = other.getFirstNode().getLoc();
    const p4 = other.getLastNode().getLoc();
    const d = p2.subtract(p1).cross(p4.subtract(p3));
    if (Math.abs(d) < 1e-12) return false; // parallel (or one is zero-length)
    const t = p3.subtract(p1).cross(p4.subtract(p3)) / d;
    const u = p3.subtract(p1).cross(p2.subtract(p1)) / d;
    return t > 0 && t < 1 && u > 0 && u < 1;
  }

  getFrontVertex() {
    return this.getFirstNode().getVertex();
  }

  getBackVertex() {
    return this.getLastNode().getVertex();
  }

  /**
   * Equivalent to tmPath::GetMaxOutsetPath(): walks the outsetPath chain
   * up to the original, un-inset leaf path, accumulating how much of the
   * front/back end has been eaten by insetting along the way.
   */
  getMaxOutsetPath() {
    let path = this;
    let frontReduction = 0;
    let backReduction = 0;
    while (path.outsetPath) {
      frontReduction += path.frontReduction;
      backReduction += path.backReduction;
      path = path.outsetPath;
    }
    return { maxOutsetPath: path, maxFrontReduction: frontReduction, maxBackReduction: backReduction };
  }

  _edgeBetween(nodeA, nodeB) {
    return nodeA.edges.find(edge => edge.getOtherNode(nodeA) === nodeB) || null;
  }

  /**
   * Equivalent to tmPath::BuildSelfVertices(): creates this path's front/
   * back vertices, and — only if the path is active (taut) — a vertex for
   * every tree branch node the *original, un-inset* leaf path's route
   * passes through, placed by pure 1D arc-length interpolation along that
   * original route (rebased for how much insetting ate off the front, then
   * rescaled onto this path's own straight paper segment). This only needs
   * arc length, not any 2D branch-node position, because an active path's
   * paper length equals its tree length exactly — there's no slack to
   * create ambiguity.
   */
  buildSelfVertices() {
    const frontVertex = this.getFirstNode().getOrMakeVertexSelf();
    const backVertex = this.getLastNode().getOrMakeVertexSelf();
    if (this.vertices.length > 0) return; // idempotent
    if (!this.isActiveGeometry) return;

    const q1 = frontVertex.getLoc();
    const q2 = backVertex.getLoc();
    if (this.actPaperLength < 1e-12) return;
    const qu = q2.subtract(q1).divideScalar(this.actPaperLength);
    const { maxOutsetPath, maxFrontReduction } = this.getMaxOutsetPath();

    let curPos = -maxFrontReduction;
    const routeNodes = maxOutsetPath.nodes;
    for (let i = 0; i < routeNodes.length - 1; i += 1) {
      const curNode = routeNodes[i + 1];
      const edge = this._edgeBetween(routeNodes[i], curNode);
      if (!edge) continue;
      curPos += edge.getStrainedScaledLength(maxOutsetPath.scale);
      if (curPos <= 0) continue;
      if (curPos >= this.actPaperLength) break;
      this.getOrMakeVertex(q1.add(qu.scale(curPos)), curNode);
    }
  }

  /**
   * Equivalent to tmPath::GetOrMakeVertex(): finds an existing vertex
   * (this path's front/back node, or one already built along its
   * interior) within VERTEX_TOL of `pos`, or creates a new one — placed in
   * path order (front to back) among `vertices` — with elevation linearly
   * interpolated between the front/back vertex elevations. Either way, if
   * the found/created vertex has no tree-node association yet and one is
   * supplied, it's filled in now.
   */
  getOrMakeVertex(pos, treeNode) {
    const front = this.getFirstNode();
    const back = this.getLastNode();
    let vertex;
    if (pos.distance(front.getLoc()) < VERTEX_TOL) {
      vertex = front.getOrMakeVertexSelf();
    } else if (pos.distance(back.getLoc()) < VERTEX_TOL) {
      vertex = back.getOrMakeVertexSelf();
    } else {
      vertex = this.vertices.find(v => v.getLoc().distance(pos) < VERTEX_TOL);
      if (!vertex) {
        vertex = new tmVertex(null, pos);
        vertex.setOwner(this);
        vertex.isBorderVertexFlag = this.isBorderPath;
        const frontVertex = front.getOrMakeVertexSelf();
        const backVertex = back.getOrMakeVertexSelf();
        const total = frontVertex.getLoc().distance(backVertex.getLoc());
        const x = total > 1e-12 ? pos.distance(frontVertex.getLoc()) / total : 0;
        vertex.elevation = (1 - x) * frontVertex.getElevation() + x * backVertex.getElevation();
        const distFromFront = (v) => v.getLoc().distance(frontVertex.getLoc());
        const insertAt = this.vertices.findIndex(v => distFromFront(v) > distFromFront(vertex));
        this.vertices.splice(insertAt === -1 ? this.vertices.length : insertAt, 0, vertex);
      }
    }
    if (!vertex.treeNode && treeNode) vertex.treeNode = treeNode;
    return vertex;
  }

  // Equivalent to tmCreaseOwner::GetCrease(): order-independent lookup
  // among this path's own owned creases.
  getCrease(v1, v2) {
    return this.creases.find(c => (
      (c.getVertex(0) === v1 && c.getVertex(1) === v2) ||
      (c.getVertex(0) === v2 && c.getVertex(1) === v1)
    )) || null;
  }

  // Equivalent to tmCreaseOwner::GetOrMakeCrease(). If a crease already
  // exists between v1/v2, it's returned as-is and `kind` is ignored —
  // matching the original (no mismatch check).
  getOrMakeCrease(v1, v2, kind) {
    const existing = this.getCrease(v1, v2);
    if (existing) return existing;
    const crease = new tmCrease(null, v1, v2);
    crease.kind = kind;
    crease.owner = this;
    crease.ownerKind = 'path';
    this.creases.push(crease);
    return crease;
  }

  /**
   * Equivalent to tmPath::ConnectSelfVertices(): connects front vertex ->
   * each interior vertex (in path order) -> back vertex with `kind`
   * creases (AXIAL or GUSSET), owned by this path.
   */
  connectSelfVertices(kind) {
    let frontVertex = this.getFirstNode().getOrMakeVertexSelf();
    for (const vertex of this.vertices) {
      this.getOrMakeCrease(frontVertex, vertex, kind);
      frontVertex = vertex;
    }
    this.getOrMakeCrease(frontVertex, this.getLastNode().getOrMakeVertexSelf(), kind);
  }

  /**
   * Equivalent to tmPath::SetVertexDepth(): projects `vertex` onto this
   * path's front-to-back line and sets its 3D-fold depth from the 1D depth
   * coordinate system this path established in minDepth/minDepthDist
   * (tmTree.calcDepthAndBend()) — used for both ridgeline vertices and this
   * path's own owned vertices.
   */
  setVertexDepth(vertex) {
    const p = vertex.getLoc();
    const p1 = this.getFirstNode().getLoc();
    const p2 = this.getLastNode().getLoc();
    const len = p2.distance(p1);
    const d = len > 1e-12 ? p.subtract(p1).dot(p2.subtract(p1)) / len : 0;
    if (d < this.minDepthDist) {
      vertex.setDepth(this.minDepth + this.minDepthDist - d);
    } else {
      vertex.setDepth(this.minDepth + d - this.minDepthDist);
    }
  }

  // Clone
  clone() {
    const path = new tmPath(this.id);
    path.label = this.label;
    path.isActive = this.isActive;
    path.isActiveGeometry = this.isActiveGeometry;
    path.angleFixed = this.angleFixed;
    path.angle = this.angle;
    path.angleQuant = this.angleQuant;
    path.quantValue = this.quantValue;
    path.quantOffset = this.quantOffset;
    path.minTreeLength = this.minTreeLength;
    path.scale = this.scale;
    path.nodes = [...this.nodes];
    return path;
  }

  // String representation
  toString() {
    const nodeLabels = this.nodes.map(n => n.label).join(' -> ');
    return `Path(${this.id}, ${nodeLabels})`;
  }
}
