/**
 * ConditionNodeOnEdge.js
 * Condition for placing a node on an edge of the paper
 */

import { tmCondition } from '../tmCondition.js';

export class ConditionNodeOnEdge extends tmCondition {
  /**
   * Create a condition that places node on paper edge
   * @param {tmTree} tree - The tree
   * @param {tmNode} node - The node
   * @param {string} edge - 'TOP', 'BOTTOM', 'LEFT', 'RIGHT'
   * @param {number} position - 0.0 to 1.0 along the edge
   */
  constructor(tree, node, edge = 'TOP', position = 0.5) {
    super(tree);
    this.node = node;
    this.edge = edge; // 'TOP', 'BOTTOM', 'LEFT', 'RIGHT'
    this.position = Math.max(0, Math.min(1, position)); // Clamp to [0,1]
    
    this.calcFeasibility();
  }

  isNodeCondition() { return true; }
  isEdgeCondition() { return false; }
  isPathCondition() { return false; }

  getNode() { return this.node; }
  getEdge() { return this.edge; }
  getPosition() { return this.position; }

  setNode(node) { 
    this.node = node; 
    this.calcFeasibility();
  }

  setEdge(edge) { 
    this.edge = edge; 
    this.calcFeasibility();
  }

  setPosition(position) { 
    this.position = Math.max(0, Math.min(1, position));
    this.calcFeasibility();
  }

  /**
   * Get the point on the edge
   * @returns {Object} {x, y} point
   */
  getEdgeLocation() {
    const w = this.tree.getPaperWidth();
    const h = this.tree.getPaperHeight();
    const p = this.position;
    const nodeLoc = this.node.getLoc();
    
    switch (this.edge) {
      case 'TOP':    return { x: p * w, y: 0 };
      case 'BOTTOM': return { x: p * w, y: h };
      case 'LEFT':   return { x: 0, y: p * h };
      case 'RIGHT':  return { x: w, y: p * h };
      default: {
        const distances = [
          { distance: nodeLoc.x, point: { x: 0, y: nodeLoc.y } },
          { distance: Math.abs(w - nodeLoc.x), point: { x: w, y: nodeLoc.y } },
          { distance: nodeLoc.y, point: { x: nodeLoc.x, y: 0 } },
          { distance: Math.abs(h - nodeLoc.y), point: { x: nodeLoc.x, y: h } }
        ];
        return distances.sort((a, b) => a.distance - b.distance)[0].point;
      }
    }
  }

  uses(part) {
    return this.node === part;
  }

  isValidCondition() {
    if (!this.node) return false;
    if (!this.tree.getNodes().includes(this.node)) return false;
    if (this.edge !== null && !['TOP', 'BOTTOM', 'LEFT', 'RIGHT'].includes(this.edge)) return false;
    return true;
  }

  calcFeasibility() {
    if (!this.isValidCondition()) {
      this.isFeasible = false;
      return;
    }

    const edgeLoc = this.getEdgeLocation();
    const nodeLoc = this.node.getLoc();
    
    const tolerance = 1e-6;
    if (Math.abs(nodeLoc.x - edgeLoc.x) > tolerance || 
        Math.abs(nodeLoc.y - edgeLoc.y) > tolerance) {
      this.isFeasible = false;
      return;
    }

    this.isFeasible = true;
  }

  addConstraints(optimizer) {
    if (!this.isValidCondition()) return;
    
    const edgeLoc = this.getEdgeLocation();
    optimizer.addXPositionConstraint(this.node, edgeLoc.x);
    optimizer.addYPositionConstraint(this.node, edgeLoc.y);
  }

  toString() {
    return `Node ${this.node.label} on ${this.edge} edge at ${(this.position * 100).toFixed(1)}%`;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      nodeLabel: this.node?.label,
      edge: this.edge,
      position: this.position
    };
  }
}
