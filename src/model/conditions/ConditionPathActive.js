/**
 * ConditionPathActive.js
 * Condition for marking a path as active
 */

import { tmCondition } from '../tmCondition.js';

export class ConditionPathActive extends tmCondition {
  /**
   * Create a condition that marks a path as active
   * @param {tmTree} tree - The tree
   * @param {tmPath} path - The path
   */
  constructor(tree, path) {
    super(tree);
    this.path = path;
    if (this.path) this.path.isActive = true;
    
    this.calcFeasibility();
  }

  isNodeCondition() { return false; }
  isEdgeCondition() { return false; }
  isPathCondition() { return true; }

  getPath() { return this.path; }

  setPath(path) { 
    this.path = path; 
    this.calcFeasibility();
  }

  uses(part) {
    return this.path === part;
  }

  isValidCondition() {
    if (!this.path) return false;
    if (!this.tree.getPaths().includes(this.path)) return false;
    return true;
  }

  calcFeasibility() {
    if (!this.isValidCondition()) {
      this.isFeasible = false;
      return;
    }

    // Path is active if marked as such
    this.isFeasible = this.path.isActiveGeometry === true;
  }

  addConstraints(optimizer) {
    if (!this.isValidCondition()) return;
    
    optimizer.addActivePathConstraint(this.path);
  }

  toString() {
    return `Path active (${this.path.getNodes().length} nodes)`;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      pathNodes: this.path?.getNodes().map(n => n.label)
    };
  }
}
