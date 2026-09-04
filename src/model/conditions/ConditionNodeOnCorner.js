/**
 * ConditionNodeOnCorner.js
 * Condition for placing a node at a corner of the paper
 */

import { tmCondition } from '../tmCondition.js';

export class ConditionNodeOnCorner extends tmCondition {
  /**
   * Create a condition that places node on paper corner
   * @param {tmTree} tree - The tree
   * @param {tmNode} node - The node
   * @param {string} corner - 'TL', 'TR', 'BL', 'BR' (Top-Left, Top-Right, Bottom-Left, Bottom-Right)
   */
  constructor(tree, node, corner = 'TL') {
    super(tree);
    this.node = node;
    this.corner = corner; // 'TL', 'TR', 'BL', 'BR'
    
    this.calcFeasibility();
  }

  isNodeCondition() { return true; }
  isEdgeCondition() { return false; }
  isPathCondition() { return false; }

  getNode() { return this.node; }
  getCorner() { return this.corner; }

  setNode(node) { 
    this.node = node; 
    this.calcFeasibility();
  }

  setCorner(corner) { 
    this.corner = corner; 
    this.calcFeasibility();
  }

  /**
   * Get the corner coordinates
   * @returns {tmPoint} corner point
   */
  getCornerLocation() {
    const w = this.tree.getPaperWidth();
    const h = this.tree.getPaperHeight();
    
    switch (this.corner) {
      case 'TL': return { x: 0, y: 0 };
      case 'TR': return { x: w, y: 0 };
      case 'BL': return { x: 0, y: h };
      case 'BR': return { x: w, y: h };
      default: {
        const loc = this.node.getLoc();
        return [[0, 0], [w, 0], [0, h], [w, h]].sort((a, b) => (
          Math.hypot(a[0] - loc.x, a[1] - loc.y) - Math.hypot(b[0] - loc.x, b[1] - loc.y)
        )).map(point => ({ x: point[0], y: point[1] }))[0];
      }
    }
  }

  uses(part) {
    return this.node === part;
  }

  isValidCondition() {
    if (!this.node) return false;
    if (!this.tree.getNodes().includes(this.node)) return false;
    if (this.corner !== null && !['TL', 'TR', 'BL', 'BR'].includes(this.corner)) return false;
    return true;
  }

  calcFeasibility() {
    if (!this.isValidCondition()) {
      this.isFeasible = false;
      return;
    }

    const cornerLoc = this.getCornerLocation();
    const nodeLoc = this.node.getLoc();
    
    const tolerance = 1e-6;
    if (Math.abs(nodeLoc.x - cornerLoc.x) > tolerance || 
        Math.abs(nodeLoc.y - cornerLoc.y) > tolerance) {
      this.isFeasible = false;
      return;
    }

    this.isFeasible = true;
  }

  addConstraints(optimizer) {
    if (!this.isValidCondition()) return;
    
    const cornerLoc = this.getCornerLocation();
    optimizer.addXPositionConstraint(this.node, cornerLoc.x);
    optimizer.addYPositionConstraint(this.node, cornerLoc.y);
  }

  toString() {
    return `Node ${this.node.label} at corner ${this.corner}`;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      nodeLabel: this.node?.label,
      corner: this.corner
    };
  }
}
