/**
 * ConditionNodesPaired.js
 * Ports tmConditionNodesPaired (tag "CNpn"): forces two leaf nodes to be
 * mirror-symmetric about the tree's symmetry line — the model behind the
 * original's "Nodes Paired About Symmetry Line" command. It is NOT "both
 * nodes at the same position", and the line it mirrors about is the tree's
 * symmetry line (getSymLoc()/getSymDir()), not the center of the paper.
 *
 * The real constraint is two linear equalities (see PairFn1A/PairFn1B in
 * tmConstraintFns.cpp), which together fully determine a mirror image:
 *  - the segment node1-node2 is perpendicular to the symmetry line
 *    (PairFn1A: (x1-x2)*dir.x + (y1-y2)*dir.y == 0)
 *  - the midpoint of node1/node2 lies on the symmetry line (PairFn1B,
 *    equivalent to StickToLineFn applied to that midpoint)
 */

import { tmCondition } from '../tmCondition.js';

export class ConditionNodesPaired extends tmCondition {
  /**
   * Create a condition that mirrors two nodes about the tree's symmetry line
   * @param {tmTree} tree - The tree
   * @param {tmNode} node1 - First node
   * @param {tmNode} node2 - Second node
   */
  constructor(tree, node1, node2) {
    super(tree);
    this.node1 = node1;
    this.node2 = node2;
    // SPA-only editing convenience (not part of the original TreeMaker file
    // format/CNpn tag): when on, editing either node's position, or either
    // node's own adjacent edge's length/strain/stiffness, mirrors that
    // change onto the other side of the pair — see "Synchronize Paired Node
    // Editing" in main.js.
    this.syncEditing = false;

    this.calcFeasibility();
  }

  isNodeCondition() { return true; }
  isEdgeCondition() { return false; }
  isPathCondition() { return false; }

  getNode1() { return this.node1; }
  getNode2() { return this.node2; }
  getSyncEditing() { return this.syncEditing; }
  setSyncEditing(value) { this.syncEditing = Boolean(value); }

  setNode1(node) {
    this.node1 = node;
    this.calcFeasibility();
  }

  setNode2(node) {
    this.node2 = node;
    this.calcFeasibility();
  }

  uses(part) {
    return this.node1 === part || this.node2 === part;
  }

  isValidCondition() {
    if (!this.node1 || !this.node2) return false;
    if (!this.tree.getNodes().includes(this.node1)) return false;
    if (!this.tree.getNodes().includes(this.node2)) return false;
    if (this.node1 === this.node2) return false;
    // Matches tmConditionNodesPaired::IsValidCondition(): both parts must
    // be leaf nodes.
    if (this.node1.getDegree() !== 1 || this.node2.getDegree() !== 1) return false;
    return true;
  }

  calcFeasibility() {
    if (!this.isValidCondition() || !this.tree.hasSymmetryLine()) {
      this.isFeasible = false;
      return;
    }

    const tolerance = 1e-6;
    const center = this.tree.getSymLoc();
    const direction = this.tree.getSymDir();
    const a = this.node1.getLoc();
    const b = this.node2.getLoc();

    const perpendicular = (a.x - b.x) * direction.x + (a.y - b.y) * direction.y;
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    const onLine = (midX - center.x) * direction.y - (midY - center.y) * direction.x;

    this.isFeasible = Math.abs(perpendicular) < tolerance && Math.abs(onLine) < tolerance;
  }

  addConstraints(optimizer) {
    if (!this.isValidCondition() || !this.tree.hasSymmetryLine()) return;

    // Direct-projection fallback used only by the legacy solve paths (see
    // NewtonRaphson._applyConstraint / tmTree.solveWithConstraints, both
    // otherwise superseded by the residual-based joint solvers): reflects
    // node2 across the tree's symmetry line so it mirrors node1.
    const center = this.tree.getSymLoc();
    const direction = this.tree.getSymDir();
    const loc1 = this.node1.getLoc();
    const dx = loc1.x - center.x;
    const dy = loc1.y - center.y;
    const dot = dx * direction.x + dy * direction.y;
    this.node2.setLocationXY(
      2 * center.x + 2 * dot * direction.x - loc1.x,
      2 * center.y + 2 * dot * direction.y - loc1.y
    );
  }

  toString() {
    return `${this.node1.label} paired with ${this.node2.label} about symmetry line`;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      node1Label: this.node1?.label,
      node2Label: this.node2?.label
    };
  }
}
