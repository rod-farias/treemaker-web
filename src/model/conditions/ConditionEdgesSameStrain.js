/**
 * ConditionEdgesSameStrain.js
 * Condition for enforcing that two edges have the same strain
 */

import { tmCondition } from '../tmCondition.js';

export class ConditionEdgesSameStrain extends tmCondition {
  /**
   * Create a condition that enforces equal strain on edges
   * @param {tmTree} tree - The tree
   * @param {tmEdge} edge1 - First edge
   * @param {tmEdge} edge2 - Second edge
   */
  constructor(tree, edge1, edge2) {
    super(tree);
    this.edge1 = edge1;
    this.edge2 = edge2;
    
    this.calcFeasibility();
  }

  isNodeCondition() { return false; }
  isEdgeCondition() { return true; }
  isPathCondition() { return false; }

  getEdge1() { return this.edge1; }
  getEdge2() { return this.edge2; }

  setEdge1(edge) { 
    this.edge1 = edge; 
    this.calcFeasibility();
  }

  setEdge2(edge) { 
    this.edge2 = edge; 
    this.calcFeasibility();
  }

  uses(part) {
    return this.edge1 === part || this.edge2 === part;
  }

  isValidCondition() {
    if (!this.edge1 || !this.edge2) return false;
    if (!this.tree.getEdges().includes(this.edge1)) return false;
    if (!this.tree.getEdges().includes(this.edge2)) return false;
    if (this.edge1 === this.edge2) return false;
    return true;
  }

  calcFeasibility() {
    if (!this.isValidCondition()) {
      this.isFeasible = false;
      return;
    }

    // Strain = (strainedLength - originalLength) / originalLength
    const strain1 = this.edge1.getStrain();
    const strain2 = this.edge2.getStrain();

    const tolerance = 1e-6;
    this.isFeasible = Math.abs(strain1 - strain2) < tolerance;
  }

  addConstraints(optimizer) {
    if (!this.isValidCondition()) return;
    
    optimizer.addSameStrainConstraint(this.edge1, this.edge2);
  }

  toString() {
    const edge1Str = `${this.edge1?.getNodes()[0]?.label}-${this.edge1?.getNodes()[1]?.label}`;
    const edge2Str = `${this.edge2?.getNodes()[0]?.label}-${this.edge2?.getNodes()[1]?.label}`;
    return `${edge1Str} and ${edge2Str} have equal strain`;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      edge1Label: `${this.edge1?.getNodes()[0]?.label}-${this.edge1?.getNodes()[1]?.label}`,
      edge2Label: `${this.edge2?.getNodes()[0]?.label}-${this.edge2?.getNodes()[1]?.label}`
    };
  }
}
