/**
 * ConditionEdgeLengthFixed.js
 * Ports tmConditionEdgeLengthFixed (tag "CNfe"). Despite the class name,
 * the original's UI presents this as "Edge(s) No Strain" (tooltip: "Add a
 * condition that forces this edge to have zero strain") — it's not a
 * user-chosen custom length, it's always the edge's own current tree
 * length, which is exactly what keeps its strain at zero going forward.
 */

import { tmCondition } from '../tmCondition.js';

export class ConditionEdgeLengthFixed extends tmCondition {
  /**
   * Create a condition that fixes edge length
   * @param {tmTree} tree - The tree
   * @param {tmEdge} edge - The edge to fix
   * @param {number} length - Fixed length value
   */
  constructor(tree, edge, length = 0) {
    super(tree);
    this.edge = edge;
    this.length = length;
    
    this.calcFeasibility();
  }

  isNodeCondition() { return false; }
  isEdgeCondition() { return true; }
  isPathCondition() { return false; }

  getEdge() { return this.edge; }
  getLength() { return this.length; }

  setEdge(edge) { 
    this.edge = edge; 
    this.calcFeasibility();
  }

  setLength(length) { 
    this.length = length; 
    this.calcFeasibility();
  }

  uses(part) {
    return this.edge === part;
  }

  isValidCondition() {
    if (!this.edge) return false;
    if (!this.tree.getEdges().includes(this.edge)) return false;
    if (this.length <= 0) return false;
    return true;
  }

  calcFeasibility() {
    if (!this.isValidCondition()) {
      this.isFeasible = false;
      return;
    }

    // Check if current length matches fixed value
    const currentLength = this.edge.getLength();
    
    if (Math.abs(currentLength - this.length) > 1e-6) {
      this.isFeasible = false;
      return;
    }

    this.isFeasible = true;
  }

  addConstraints(optimizer) {
    if (!this.isValidCondition()) return;
    
    optimizer.addEdgeLengthConstraint(this.edge, this.length);
  }

  toString() {
    const [a, b] = this.edge?.getNodes() ?? [];
    return `Edge ${a?.label ?? '?'}-${b?.label ?? '?'} no strain`;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      edgeLabel: `${this.edge?.getNodes()[0]?.label}-${this.edge?.getNodes()[1]?.label}`,
      length: this.length
    };
  }
}
