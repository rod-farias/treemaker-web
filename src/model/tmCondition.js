/**
 * tmCondition.js
 * Abstract base class for conditions/constraints on tree parts
 * 
 * Conditions are restrictions that can be applied to:
 * - Nodes (position, symmetry, etc.)
 * - Edges (fixed length, equal strain, etc.)
 * - Paths (active, angle, etc.)
 */

export class tmCondition {
  /**
   * Create a condition
   * @param {tmTree} tree - The tree this condition belongs to
   */
  constructor(tree) {
    if (new.target === tmCondition) {
      throw new TypeError('Cannot instantiate abstract class tmCondition');
    }
    
    this.tree = tree;
    this.isFeasible = true;
  }

  /**
   * Query methods - must be overridden
   */
  isNodeCondition() {
    throw new Error('isNodeCondition() not implemented');
  }

  isEdgeCondition() {
    throw new Error('isEdgeCondition() not implemented');
  }

  isPathCondition() {
    throw new Error('isPathCondition() not implemented');
  }

  /**
   * Check if this condition uses the given part
   * @param {tmPart} part - Part to check
   * @returns {boolean}
   */
  uses(part) {
    throw new Error('uses() not implemented');
  }

  /**
   * Validate this condition
   * @returns {boolean} true if condition is valid
   */
  isValidCondition() {
    throw new Error('isValidCondition() not implemented');
  }

  /**
   * Calculate feasibility of this condition
   * Updates this.isFeasible
   */
  calcFeasibility() {
    throw new Error('calcFeasibility() not implemented');
  }

  /**
   * Add constraints to edge optimizer
   * @param {Optimizer} optimizer - The optimizer
   */
  addConstraints(optimizer) {
    throw new Error('addConstraints() not implemented');
  }

  /**
   * Get string representation
   * @returns {string}
   */
  toString() {
    return `${this.constructor.name}`;
  }

  /**
   * Serialize to JSON
   * @returns {Object}
   */
  toJSON() {
    return {
      type: this.constructor.name,
      isFeasible: this.isFeasible
    };
  }
}
