/**
 * ConditionNodeSymmetric.js
 * Ports tmConditionNodeSymmetric (tag "CNsn"): pins a single leaf node
 * directly onto the tree's symmetry line. (The two-node "mirror one node
 * onto another about the symmetry line" relationship is a different real
 * condition, tmConditionNodesPaired — see ConditionNodesPaired.js.)
 */

import { tmCondition } from '../tmCondition.js';

export class ConditionNodeSymmetric extends tmCondition {
  /**
   * Create a condition that pins a node onto the tree's symmetry line
   * @param {tmTree} tree - The tree
   * @param {tmNode} node1 - The node to pin to the symmetry line
   */
  constructor(tree, node1) {
    super(tree);
    this.node1 = node1;

    this.calcFeasibility();
  }

  isNodeCondition() { return true; }
  isEdgeCondition() { return false; }
  isPathCondition() { return false; }

  getNode1() { return this.node1; }

  setNode1(node) {
    this.node1 = node;
    this.calcFeasibility();
  }

  uses(part) {
    return this.node1 === part;
  }

  isValidCondition() {
    if (!this.node1) return false;
    if (!this.tree.getNodes().includes(this.node1)) return false;
    return this.tree.hasSymmetryLine();
  }

  calcFeasibility() {
    if (!this.isValidCondition()) {
      this.isFeasible = false;
      return;
    }

    const tolerance = 1e-6;
    const loc = this.node1.getLoc();
    const center = this.tree.getSymLoc();
    const direction = this.tree.getSymDir();
    const distance = Math.abs((loc.x - center.x) * direction.y - (loc.y - center.y) * direction.x);
    this.isFeasible = distance < tolerance;
  }

  addConstraints() {
    if (!this.isValidCondition()) return;

    // Direct-projection fallback used only by the legacy solve paths (see
    // NewtonRaphson._applyConstraint / tmTree.solveWithConstraints, both
    // otherwise superseded by the residual-based joint solvers): snaps the
    // node onto the symmetry line along the perpendicular direction.
    const center = this.tree.getSymLoc();
    const direction = this.tree.getSymDir();
    const loc = this.node1.getLoc();
    const dx = loc.x - center.x;
    const dy = loc.y - center.y;
    const along = dx * direction.x + dy * direction.y;
    this.node1.setLocationXY(center.x + along * direction.x, center.y + along * direction.y);
  }

  toString() {
    return `${this.node1.label} fixed to symmetry line`;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      node1Label: this.node1?.label
    };
  }
}
