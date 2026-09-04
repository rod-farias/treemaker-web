/**
 * tmNode.js
 * Represents a node in the tree graph
 * Equivalent to tmNode class in TreeMaker C++
 */

import { tmPoint } from './tmPoint.js';
import { tmVertex } from './tmVertex.js';

export class tmNode {
  constructor(id = null, location = null) {
    this.id = id || Math.random().toString(36).substr(2, 9);
    this.label = '';
    
    // Location on paper
    this.location = location instanceof tmPoint ? location.clone() : new tmPoint(0, 0);
    
    // Tree topology
    this.depth = 0;           // scaled distance from root node
    this.elevation = 0;       // scaled distance from axis
    
    // Classification flags
    this.isLeafNode = false;       // incident to one edge
    this.isBranchNode = false;     // incident to 2+ edges
    this.isSubNode = false;        // created in interior of poly
    this.isBorderNode = false;     // on convex hull
    this.isPinnedNode = false;     // cannot be moved
    this.isPolygonNode = false;    // corner of polygon
    this.isJunctionNode = false;   // inset node junction
    this.isRootNode = false;       // the root of the tree
    
    // Associated parts
    this.edges = [];    // edges connected to this node
    this.vertices = []; // vertices owned by this node
    this.conditions = []; // conditions on this node
  }

  // Getters
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

  isTreeNode() {
    return !this.isSubNode;
  }

  // Equivalent to tmNode::GetVertex(): a node owns at most one vertex.
  getVertex() {
    return this.vertices[0] || null;
  }

  // Equivalent to tmNode::GetOrMakeVertexSelf(): the vertex representing
  // this node's own location, created on first request. `treeNode` is set
  // only for an actual tree node (leaf or branch) — not for a purely
  // geometric node such as a molecule junction (isSubNode=true), matching
  // tmPoly's crease-building pass reading `vertex.treeNode` to decide
  // UNFOLDED_HINGE vs PSEUDOHINGE.
  getOrMakeVertexSelf() {
    if (this.vertices[0]) return this.vertices[0];
    const vertex = new tmVertex(null, this.location);
    vertex.setOwner(this);
    vertex.elevation = this.elevation;
    vertex.isBorderVertexFlag = this.isBorderNode;
    if (this.isTreeNode()) vertex.treeNode = this;
    this.vertices = [vertex];
    return vertex;
  }

  // Equivalent to tmNode::CalcDiscreteDepth(): the number of tree-graph
  // hops from the root node. Only meaningful for a tree node (leaf or
  // branch); relies on `ownerTree` (set by tmTree when the node is added).
  calcDiscreteDepth() {
    const root = this.ownerTree.getRootNode();
    if (root === this) return 0;
    return this.ownerTree.getPath(root, this).getNumNodes() - 1;
  }

  /**
   * Equivalent to tmNode::CalcIsPinnedNode(): a leaf node is "pinned" —
   * fully geometrically determined, with no direction left to slide in —
   * if the active (taut) leaf paths incident to it, plus any paper edge it
   * sits exactly on, pull in enough different directions that no angular
   * gap between consecutive directions (sorted around the circle, wrapping
   * from the largest back to the smallest) exceeds a half-turn (π): a
   * bigger gap would leave a free half-plane the node could still move
   * into without straining anything. This is a purely local, per-node
   * angular test — not a global rigidity/linear-algebra analysis — and it
   * deliberately does NOT consult any user condition on the node (an
   * explicitly fixed node with fewer than two well-spread active paths
   * still fails this test, matching the original exactly).
   * @param {tmPath[]} activePaths - this node's incident leaf paths that
   *   are currently active (taut); the caller filters these since tmNode
   *   doesn't maintain its own persistent leaf-path list in this port.
   */
  calcIsPinnedNode(activePaths) {
    this.isPinnedNode = false;
    const CONVEXITY_TOL = 1e-4;
    const isTiny = (v) => Math.abs(v) < CONVEXITY_TOL;

    const angles = [];
    for (const path of activePaths) {
      const other = path.getFirstNode() === this ? path.getLastNode() : path.getFirstNode();
      angles.push(Math.atan2(other.getLocY() - this.getLocY(), other.getLocX() - this.getLocX()));
    }

    // Paper edges have the same pinning effect as an active path: a node
    // sitting exactly on one can't move past it either.
    const tree = this.ownerTree;
    if (tree) {
      if (isTiny(this.getLocX())) angles.push(-Math.PI); // left
      if (isTiny(this.getLocX() - tree.paperWidth)) angles.push(0); // right
      if (isTiny(this.getLocY())) angles.push(-Math.PI / 2); // top (y=0 in this app's screen-down convention)
      if (isTiny(this.getLocY() - tree.paperHeight)) angles.push(Math.PI / 2); // bottom
    }

    // Need at least two directions to have any chance of being pinned.
    if (angles.length < 2) return;

    angles.sort((a, b) => a - b);
    for (let i = 0; i < angles.length - 1; i += 1) {
      if (angles[i + 1] - angles[i] > Math.PI + CONVEXITY_TOL) return;
    }
    // Wraparound gap, from the largest angle back to the smallest.
    if (angles[0] - angles[angles.length - 1] + Math.PI > CONVEXITY_TOL) return;

    this.isPinnedNode = true;
  }

  // Setters
  setLabel(label) {
    this.label = label;
  }

  setLocation(point) {
    if (point instanceof tmPoint) {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        throw new TypeError('Node coordinates must be finite');
      }
      this.location = point.clone();
      this.ownerTree?.invalidatePaths?.();
    }
  }

  setLocationXY(x, y) {
    if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) {
      throw new TypeError('Node coordinates must be finite');
    }
    this.location = new tmPoint(x, y);
    this.ownerTree?.invalidatePaths?.();
  }

  setDepth(depth) {
    this.depth = Number(depth);
  }

  setElevation(elevation) {
    this.elevation = Number(elevation);
  }

  // Add adjacent edge
  addEdge(edge) {
    if (!this.edges.includes(edge)) {
      this.edges.push(edge);
    }
  }

  // Remove adjacent edge
  removeEdge(edge) {
    const idx = this.edges.indexOf(edge);
    if (idx >= 0) {
      this.edges.splice(idx, 1);
    }
  }

  // Get edges connected to this node
  getEdges() {
    return this.edges;
  }

  // Get adjacent nodes
  getAdjacentNodes() {
    return this.edges.map(edge => edge.getOtherNode(this)).filter(n => n !== null);
  }

  // Degree (number of connected edges)
  getDegree() {
    return this.edges.length;
  }

  // Equivalent to tmNode::IsRedundant(): exactly two incident edges — a
  // node that can be absorbed, merging the two edges into one.
  isRedundant() {
    return this.edges.length === 2;
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

  // Clone
  clone() {
    const node = new tmNode(this.id, this.location);
    node.label = this.label;
    node.depth = this.depth;
    node.elevation = this.elevation;
    node.isLeafNode = this.isLeafNode;
    node.isBranchNode = this.isBranchNode;
    node.isSubNode = this.isSubNode;
    node.isBorderNode = this.isBorderNode;
    node.isPinnedNode = this.isPinnedNode;
    node.isPolygonNode = this.isPolygonNode;
    node.isJunctionNode = this.isJunctionNode;
    node.isRootNode = this.isRootNode;
    return node;
  }

  // String representation
  toString() {
    return `Node(${this.id}, ${this.label}, ${this.location.toString()})`;
  }
}
