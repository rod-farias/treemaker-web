/**
 * ConditionPathCombo.js
 * Condition that combines multiple path conditions
 */

import { tmCondition } from '../tmCondition.js';

export class ConditionPathCombo extends tmCondition {
  /**
   * Create a combo condition for paths
   * @param {tmTree} tree - The tree
   * @param {tmPath} path - The path
   * @param {Array<tmCondition>} conditions - Array of path conditions to combine
   */
  constructor(tree, path, conditions = []) {
    super(tree);
    this.path = path;
    this.conditions = conditions.filter(c => c.isPathCondition());
    
    this.calcFeasibility();
  }

  isNodeCondition() { return false; }
  isEdgeCondition() { return false; }
  isPathCondition() { return true; }

  getPath() { return this.path; }
  getConditions() { return [...this.conditions]; }

  setPath(path) { 
    this.path = path; 
    this.calcFeasibility();
  }

  addCondition(condition) {
    if (condition.isPathCondition() && !this.conditions.includes(condition)) {
      this.conditions.push(condition);
      this.calcFeasibility();
    }
  }

  removeCondition(condition) {
    const idx = this.conditions.indexOf(condition);
    if (idx >= 0) {
      this.conditions.splice(idx, 1);
      this.calcFeasibility();
    }
  }

  uses(part) {
    if (this.path === part) return true;
    for (const cond of this.conditions) {
      if (cond.uses(part)) return true;
    }
    return false;
  }

  isValidCondition() {
    if (!this.path) return false;
    if (!this.tree.getPaths().includes(this.path)) return false;
    if (this.conditions.length === 0) return false;
    return this.conditions.every(c => c.isValidCondition());
  }

  calcFeasibility() {
    if (!this.isValidCondition()) {
      this.isFeasible = false;
      return;
    }

    // All sub-conditions must be feasible
    this.isFeasible = this.conditions.every(c => c.isFeasible);
  }

  addConstraints(optimizer) {
    if (!this.isValidCondition()) return;
    
    for (const cond of this.conditions) {
      cond.addConstraints(optimizer);
    }
  }

  toString() {
    const condStrs = this.conditions.map(c => c.toString());
    return `PathCombo [${condStrs.join(' + ')}]`;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      pathNodeCount: this.path?.getNodes().length,
      conditionCount: this.conditions.length,
      conditions: this.conditions.map(c => c.toJSON())
    };
  }
}
