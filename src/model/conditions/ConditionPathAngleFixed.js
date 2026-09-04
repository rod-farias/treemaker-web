/**
 * ConditionPathAngleFixed.js
 * Condition for fixing a path's angle
 */

import { tmCondition } from '../tmCondition.js';

export class ConditionPathAngleFixed extends tmCondition {
  /**
   * Create a condition that fixes a path's angle
   * @param {tmTree} tree - The tree
   * @param {tmPath} path - The path
   * @param {number} angle - Fixed angle in radians
   */
  constructor(tree, path, angle = 0) {
    super(tree);
    this.path = path;
    this.angle = angle;
    if (this.path) this.path.isActive = true;
    
    this.calcFeasibility();
  }

  isNodeCondition() { return false; }
  isEdgeCondition() { return false; }
  isPathCondition() { return true; }

  getPath() { return this.path; }
  getAngle() { return this.angle; }

  setPath(path) { 
    this.path = path; 
    this.calcFeasibility();
  }

  setAngle(angle) { 
    this.angle = angle; 
    this.calcFeasibility();
  }

  uses(part) {
    return this.path === part;
  }

  isValidCondition() {
    if (!this.path) return false;
    if (!this.tree.getPaths().includes(this.path)) return false;
    if (this.path.getNodes().length < 2) return false;
    return true;
  }

  calcFeasibility() {
    if (!this.isValidCondition()) {
      this.isFeasible = false;
      return;
    }

    // Check if path angle matches fixed value
    const tolerance = 1e-6;
    const angleDiff = Math.abs(this.path.getGeometricAngle() - this.angle);
    
    // Handle angle wrapping (2π)
    const normalizedDiff = Math.min(
      angleDiff,
      Math.abs(angleDiff - 2 * Math.PI)
    );

    this.isFeasible = normalizedDiff < tolerance;
  }

  addConstraints(optimizer) {
    if (!this.isValidCondition()) return;
    
    optimizer.addPathAngleConstraint(this.path, this.angle);
  }

  toString() {
    const degrees = (this.angle * 180 / Math.PI).toFixed(1);
    return `Path angle fixed to ${degrees}°`;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      angle: this.angle,
      angleDegrees: (this.angle * 180 / Math.PI)
    };
  }
}
