/**
 * ConditionNodeFixed.js
 * Condition for fixing a node's X and/or Y coordinate
 */

import { tmCondition } from '../tmCondition.js';

export class ConditionNodeFixed extends tmCondition {
  /**
   * Create a condition that fixes node position
   * @param {tmTree} tree - The tree
   * @param {tmNode} node - The node to fix
   * @param {boolean} xFixed - Is X coordinate fixed?
   * @param {number} xFixValue - Fixed X value
   * @param {boolean} yFixed - Is Y coordinate fixed?
   * @param {number} yFixValue - Fixed Y value
   */
  constructor(tree, node, xFixed = false, xFixValue = 0, yFixed = false, yFixValue = 0) {
    super(tree);
    this.node = node;
    this.xFixed = xFixed;
    this.xFixValue = xFixValue;
    this.yFixed = yFixed;
    this.yFixValue = yFixValue;
    
    this.calcFeasibility();
  }

  isNodeCondition() { return true; }
  isEdgeCondition() { return false; }
  isPathCondition() { return false; }

  getNode() { return this.node; }
  getXFixed() { return this.xFixed; }
  getYFixed() { return this.yFixed; }
  getXFixValue() { return this.xFixValue; }
  getYFixValue() { return this.yFixValue; }

  setNode(node) { 
    this.node = node; 
    this.calcFeasibility();
  }

  setXFixed(xFixed) { 
    this.xFixed = xFixed; 
    this.calcFeasibility();
  }

  setYFixed(yFixed) { 
    this.yFixed = yFixed; 
    this.calcFeasibility();
  }

  setXFixValue(value) { 
    this.xFixValue = value; 
    this.calcFeasibility();
  }

  setYFixValue(value) { 
    this.yFixValue = value; 
    this.calcFeasibility();
  }

  uses(part) {
    return this.node === part;
  }

  isValidCondition() {
    if (!this.node) return false;
    if (!this.tree.getNodes().includes(this.node)) return false;
    return true;
  }

  calcFeasibility() {
    if (!this.isValidCondition()) {
      this.isFeasible = false;
      return;
    }

    // Check if current position matches fixed values
    const loc = this.node.getLoc();
    
    if (this.xFixed && Math.abs(loc.x - this.xFixValue) > 1e-6) {
      this.isFeasible = false;
      return;
    }
    
    if (this.yFixed && Math.abs(loc.y - this.yFixValue) > 1e-6) {
      this.isFeasible = false;
      return;
    }

    this.isFeasible = true;
  }

  addConstraints(optimizer) {
    if (!this.isValidCondition()) return;
    
    if (this.xFixed) {
      optimizer.addXPositionConstraint(this.node, this.xFixValue);
    }
    if (this.yFixed) {
      optimizer.addYPositionConstraint(this.node, this.yFixValue);
    }
  }

  toString() {
    let desc = `Fix Node ${this.node.label}`;
    const parts = [];
    if (this.xFixed) parts.push(`X=${this.xFixValue.toFixed(3)}`);
    if (this.yFixed) parts.push(`Y=${this.yFixValue.toFixed(3)}`);
    return `${desc}: ${parts.join(', ')}`;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      nodeLabel: this.node?.label,
      xFixed: this.xFixed,
      xFixValue: this.xFixValue,
      yFixed: this.yFixed,
      yFixValue: this.yFixValue
    };
  }
}
