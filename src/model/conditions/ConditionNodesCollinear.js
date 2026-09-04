/**
 * ConditionNodesCollinear.js
 * Condition for enforcing that three nodes are collinear
 */

import { tmCondition } from '../tmCondition.js';

export class ConditionNodesCollinear extends tmCondition {
  /**
   * Create a condition that enforces collinearity
   * @param {tmTree} tree - The tree
   * @param {tmNode} node1 - First node
   * @param {tmNode} node2 - Second node (middle node)
   * @param {tmNode} node3 - Third node
   */
  constructor(tree, node1, node2, node3) {
    super(tree);
    this.node1 = node1;
    this.node2 = node2;
    this.node3 = node3;
    
    this.calcFeasibility();
  }

  isNodeCondition() { return true; }
  isEdgeCondition() { return false; }
  isPathCondition() { return false; }

  getNode1() { return this.node1; }
  getNode2() { return this.node2; }
  getNode3() { return this.node3; }

  setNode1(node) { this.node1 = node; this.calcFeasibility(); }
  setNode2(node) { this.node2 = node; this.calcFeasibility(); }
  setNode3(node) { this.node3 = node; this.calcFeasibility(); }

  uses(part) {
    return this.node1 === part || this.node2 === part || this.node3 === part;
  }

  isValidCondition() {
    if (!this.node1 || !this.node2 || !this.node3) return false;
    if (!this.tree.getNodes().includes(this.node1)) return false;
    if (!this.tree.getNodes().includes(this.node2)) return false;
    if (!this.tree.getNodes().includes(this.node3)) return false;
    if (this.node1 === this.node2 || this.node2 === this.node3 || this.node1 === this.node3) return false;
    return true;
  }

  /**
   * Check if three points are collinear
   * Uses cross product: (P2-P1) × (P3-P1) = 0
   */
  calcFeasibility() {
    if (!this.isValidCondition()) {
      this.isFeasible = false;
      return;
    }

    const loc1 = this.node1.getLoc();
    const loc2 = this.node2.getLoc();
    const loc3 = this.node3.getLoc();

    // Vectors from node1 to node2 and node1 to node3
    const v12 = { x: loc2.x - loc1.x, y: loc2.y - loc1.y };
    const v13 = { x: loc3.x - loc1.x, y: loc3.y - loc1.y };

    // Cross product (in 2D, this gives the Z component)
    const cross = v12.x * v13.y - v12.y * v13.x;

    const tolerance = 1e-6;
    this.isFeasible = Math.abs(cross) < tolerance;
  }

  addConstraints(optimizer) {
    if (!this.isValidCondition()) return;
    
    optimizer.addCollinearityConstraint(this.node1, this.node2, this.node3);
  }

  toString() {
    return `${this.node1.label}, ${this.node2.label}, ${this.node3.label} collinear`;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      node1Label: this.node1?.label,
      node2Label: this.node2?.label,
      node3Label: this.node3?.label
    };
  }
}
