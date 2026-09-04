/**
 * ConditionPathAngleQuant.js
 * Condition for quantizing a path's angle to discrete values
 */

import { tmCondition } from '../tmCondition.js';

export class ConditionPathAngleQuant extends tmCondition {
  /**
   * Create a condition that quantizes a path's angle
   * @param {tmTree} tree - The tree
   * @param {tmPath} path - The path
   * @param {number} quantValue - Number of equal divisions (e.g., 4 for 90° increments)
   * @param {number} quantOffset - Offset angle in radians (default 0)
   */
  constructor(tree, path, quantValue = 4, quantOffset = 0) {
    super(tree);
    this.path = path;
    this.quantValue = Math.max(1, quantValue);
    this.quantOffset = quantOffset;
    if (this.path) this.path.isActive = true;
    
    this.calcFeasibility();
  }

  isNodeCondition() { return false; }
  isEdgeCondition() { return false; }
  isPathCondition() { return true; }

  getPath() { return this.path; }
  getQuantValue() { return this.quantValue; }
  getQuantOffset() { return this.quantOffset; }

  setPath(path) { 
    this.path = path; 
    this.calcFeasibility();
  }

  setQuantValue(value) { 
    this.quantValue = Math.max(1, value);
    this.calcFeasibility();
  }

  setQuantOffset(offset) { 
    this.quantOffset = offset;
    this.calcFeasibility();
  }

  /**
   * Get the closest quantized angle
   * @returns {number} angle in radians
   */
  getClosestQuantAngle() {
    const PI = Math.PI;
    const TWO_PI = 2 * Math.PI;
    const quantum = TWO_PI / this.quantValue;
    const angle = this.path.getGeometricAngle() - this.quantOffset;
    const quantized = Math.round(angle / quantum) * quantum + this.quantOffset;
    return quantized;
  }

  uses(part) {
    return this.path === part;
  }

  isValidCondition() {
    if (!this.path) return false;
    if (!this.tree.getPaths().includes(this.path)) return false;
    if (this.path.getNodes().length < 2) return false;
    if (this.quantValue < 1) return false;
    return true;
  }

  calcFeasibility() {
    if (!this.isValidCondition()) {
      this.isFeasible = false;
      return;
    }

    // Check if path angle is quantized
    const closestQuant = this.getClosestQuantAngle();
    const tolerance = 1e-6;
    
    this.isFeasible = Math.abs(this.path.getGeometricAngle() - closestQuant) < tolerance;
  }

  addConstraints(optimizer) {
    if (!this.isValidCondition()) return;
    
    optimizer.addPathAngleQuantConstraint(this.path, this.quantValue, this.quantOffset);
  }

  toString() {
    const quantum = (2 * Math.PI / this.quantValue) * 180 / Math.PI;
    const offset = (this.quantOffset * 180 / Math.PI).toFixed(1);
    return `Path angle quantized to ${this.quantValue} divisions (${quantum.toFixed(1)}° increments, offset ${offset}°)`;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      quantValue: this.quantValue,
      quantOffset: this.quantOffset,
      quantOffsetDegrees: (this.quantOffset * 180 / Math.PI)
    };
  }
}
