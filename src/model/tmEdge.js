/**
 * tmEdge.js
 * Represents an edge of the tree graph (a flap segment)
 * Equivalent to tmEdge class in TreeMaker C++
 */

// Equivalent to tmEdge::MIN_EDGE_LENGTH: below this (in tree units, strained),
// mountain/valley creases at either end of the edge can't be told apart, so
// the crease pattern build refuses to proceed (see tmTree.getCPStatus()).
export const MIN_EDGE_LENGTH = 0.01;

export class tmEdge {
  constructor(id = null, node1 = null, node2 = null) {
    this.id = id || Math.random().toString(36).substr(2, 9);
    this.label = '';
    
    // Topology
    this.nodes = [node1, node2]; // exactly 2 nodes
    
    // Dimensional properties
    this.length = 0;        // length in tree units
    this.strain = 0;        // strain in edge (0 = unstrained)
    this.stiffness = 1;     // stiffness enhancement factor
    
    // Status flags
    this.isPinnedEdge = false;      // cannot grow longer
    this.isConditionedEdge = false; // has conditions
    
    // Associated parts
    this.conditions = [];
    
    // Register edge with nodes
    if (node1) node1.addEdge(this);
    if (node2) node2.addEdge(this);
  }

  // Getters
  getLabel() {
    return this.label;
  }

  getLength() {
    return this.length;
  }

  getGeometricLength() {
    const [first, second] = this.nodes;
    if (!first || !second) return 0;
    return first.getLoc().distance(second.getLoc());
  }

  getLengthSlack() {
    return this.getGeometricLength() - this.length;
  }

  getComputedStrain() {
    if (Math.abs(this.length) <= 1e-12) return 0;
    return this.getLengthSlack() / this.length;
  }

  getEffectiveTreeLength(scale = 1) {
    if (this.length > 0 || this.strain <= -1) return this.getStrainedLength();
    return this.getGeometricLength() / Math.max(Number(scale) || 1, 1e-12);
  }

  getStrain() {
    return this.strain;
  }

  getStiffness() {
    return this.stiffness;
  }

  getNodes() {
    return this.nodes;
  }

  // Get the node at given index (0 or 1)
  getNode(index) {
    return this.nodes[index];
  }

  // Get the other node given one node
  getOtherNode(node) {
    if (this.nodes[0] === node) return this.nodes[1];
    if (this.nodes[1] === node) return this.nodes[0];
    return null;
  }

  // Get effective length considering strain
  getStrainedLength() {
    return this.length * (1 + this.strain);
  }

  // Get strained length scaled by stiffness
  getStrainedScaledLength(scale = 1) {
    return this.getStrainedLength() * scale;
  }

  // Setters
  setLabel(label) {
    this.label = label;
  }

  setLength(length) {
    const value = Number(length);
    if (!Number.isFinite(value) || value < 0) throw new RangeError('Edge length must be finite and non-negative');
    this.length = value;
    this.ownerTree?.invalidatePaths?.();
  }

  setStrain(strain) {
    const value = Number(strain);
    if (!Number.isFinite(value) || value < -1) throw new RangeError('Edge strain must be finite and at least -1');
    this.strain = value;
  }

  setStiffness(stiffness) {
    const value = Number(stiffness);
    if (!Number.isFinite(value) || value <= 0) throw new RangeError('Edge stiffness must be finite and positive');
    this.stiffness = value;
  }

  // Add condition
  addCondition(condition) {
    if (!this.conditions.includes(condition)) {
      this.conditions.push(condition);
      this.isConditionedEdge = true;
    }
  }

  // Remove condition
  removeCondition(condition) {
    const idx = this.conditions.indexOf(condition);
    if (idx >= 0) {
      this.conditions.splice(idx, 1);
      if (this.conditions.length === 0) {
        this.isConditionedEdge = false;
      }
    }
  }

  // Clone
  clone() {
    const edge = new tmEdge(this.id, this.nodes[0], this.nodes[1]);
    edge.label = this.label;
    edge.length = this.length;
    edge.strain = this.strain;
    edge.stiffness = this.stiffness;
    edge.isPinnedEdge = this.isPinnedEdge;
    edge.isConditionedEdge = this.isConditionedEdge;
    return edge;
  }

  // String representation
  toString() {
    const node1Label = this.nodes[0]?.label || 'N/A';
    const node2Label = this.nodes[1]?.label || 'N/A';
    return `Edge(${this.id}, ${node1Label}-${node2Label}, length=${this.length.toFixed(3)})`;
  }

  // Equivalent to tmEdge::ContainsStrainedEdges(): true if any edge in the
  // list has nonzero strain.
  static containsStrainedEdges(edgeList) {
    return edgeList.some(edge => edge.getStrain() !== 0);
  }
}
