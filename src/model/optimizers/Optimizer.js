import {
  distanceBetweenPoints,
  EPSILON,
  pointIsCollinear,
  projectPointToLine,
  quantizeAngle,
  reflectPoint
} from './ConstraintFns.js';

export class Optimizer {
  constructor(tree) {
    this.tree = tree;
    this.constraints = [];
    this.iterations = 0;
    this.lastResult = {
      converged: false,
      iterations: 0,
      constraintCount: 0,
      objective: 0
    };
  }

  clearConstraints() {
    this.constraints = [];
  }

  getConstraints() {
    return this.constraints;
  }

  addConstraint(type, payload) {
    this.constraints.push({ type, ...payload });
    return this;
  }

  addXPositionConstraint(node, xValue) {
    return this.addConstraint('xPosition', { node, value: Number(xValue) });
  }

  addYPositionConstraint(node, yValue) {
    return this.addConstraint('yPosition', { node, value: Number(yValue) });
  }

  addEdgeLengthConstraint(edge, length) {
    return this.addConstraint('edgeLength', { edge, value: Number(length) });
  }

  addSameStrainConstraint(edge1, edge2) {
    return this.addConstraint('sameStrain', { edge1, edge2 });
  }

  addCollinearityConstraint(node1, node2, node3) {
    return this.addConstraint('collinearity', { node1, node2, node3 });
  }

  addPairingConstraint(node1, node2) {
    return this.addConstraint('pairing', { node1, node2 });
  }

  addSymmetryConstraint(node1, node2, centerX, centerY) {
    return this.addConstraint('symmetry', { node1, node2, centerX: Number(centerX), centerY: Number(centerY) });
  }

  addActivePathConstraint(path) {
    return this.addConstraint('activePath', { path });
  }

  addPathAngleConstraint(path, angle) {
    return this.addConstraint('pathAngle', { path, value: Number(angle) });
  }

  addPathAngleQuantConstraint(path, quantValue, quantOffset = 0) {
    return this.addConstraint('pathAngleQuant', { path, quantValue: Number(quantValue), quantOffset: Number(quantOffset) });
  }

  applyConstraint(constraint) {
    const { type } = constraint;
    let changed = false;

    switch (type) {
      case 'xPosition': {
        if (!constraint.node) break;
        const previous = constraint.node.location.x;
        constraint.node.location.x = constraint.value;
        changed = Math.abs(previous - constraint.node.location.x) > EPSILON;
        break;
      }
      case 'yPosition': {
        if (!constraint.node) break;
        const previous = constraint.node.location.y;
        constraint.node.location.y = constraint.value;
        changed = Math.abs(previous - constraint.node.location.y) > EPSILON;
        break;
      }
      case 'edgeLength': {
        if (!constraint.edge || !constraint.edge.nodes || constraint.edge.nodes.length < 2) break;
        const [n1, n2] = constraint.edge.nodes;
        if (!n1 || !n2) break;
        const current = distanceBetweenPoints(n1.location, n2.location);
        if (current <= EPSILON) {
          n2.location.x = n1.location.x + constraint.value;
          n2.location.y = n1.location.y;
          break;
        }
        const dx = n2.location.x - n1.location.x;
        const dy = n2.location.y - n1.location.y;
        const length = Math.hypot(dx, dy);
        const nx = dx / length;
        const ny = dy / length;
        const previous = n2.location.clone ? n2.location.clone() : { x: n2.location.x, y: n2.location.y };
        n2.location.x = n1.location.x + nx * constraint.value;
        n2.location.y = n1.location.y + ny * constraint.value;
        changed = Math.abs(previous.x - n2.location.x) > EPSILON || Math.abs(previous.y - n2.location.y) > EPSILON;
        break;
      }
      case 'sameStrain': {
        if (!constraint.edge1 || !constraint.edge2) break;
        const previous = constraint.edge2.strain;
        constraint.edge2.strain = constraint.edge1.strain;
        changed = Math.abs(previous - constraint.edge2.strain) > EPSILON;
        break;
      }
      case 'collinearity': {
        if (!constraint.node1 || !constraint.node2 || !constraint.node3) break;
        const lineStart = constraint.node1.location;
        const lineEnd = constraint.node2.location;
        const projected = projectPointToLine(constraint.node3.location, lineStart, lineEnd);
        const previous = { x: constraint.node3.location.x, y: constraint.node3.location.y };
        constraint.node3.location.x = projected.x;
        constraint.node3.location.y = projected.y;
        changed = Math.abs(previous.x - projected.x) > EPSILON || Math.abs(previous.y - projected.y) > EPSILON;
        break;
      }
      case 'pairing': {
        if (!constraint.node1 || !constraint.node2) break;
        const previous = { x: constraint.node2.location.x, y: constraint.node2.location.y };
        constraint.node2.location.x = constraint.node1.location.x;
        constraint.node2.location.y = constraint.node1.location.y;
        changed = Math.abs(previous.x - constraint.node2.location.x) > EPSILON || Math.abs(previous.y - constraint.node2.location.y) > EPSILON;
        break;
      }
      case 'symmetry': {
        if (!constraint.node1 || !constraint.node2) break;
        const reflected = reflectPoint(constraint.node1.location, constraint.centerX, constraint.centerY);
        const previous = { x: constraint.node2.location.x, y: constraint.node2.location.y };
        constraint.node2.location.x = reflected.x;
        constraint.node2.location.y = reflected.y;
        changed = Math.abs(previous.x - reflected.x) > EPSILON || Math.abs(previous.y - reflected.y) > EPSILON;
        break;
      }
      case 'activePath': {
        if (!constraint.path) break;
        const previous = constraint.path.isActive;
        constraint.path.isActive = true;
        changed = previous !== constraint.path.isActive;
        break;
      }
      case 'pathAngle': {
        if (!constraint.path) break;
        const previous = constraint.path.angle;
        constraint.path.angle = Number(constraint.value);
        constraint.path.angleFixed = true;
        changed = Math.abs(previous - constraint.path.angle) > EPSILON;
        break;
      }
      case 'pathAngleQuant': {
        if (!constraint.path) break;
        const previous = constraint.path.angle;
        constraint.path.angle = quantizeAngle(constraint.path.angle, constraint.quantValue, constraint.quantOffset);
        constraint.path.angleQuant = true;
        constraint.path.quantValue = constraint.quantValue;
        constraint.path.quantOffset = constraint.quantOffset;
        changed = Math.abs(previous - constraint.path.angle) > EPSILON;
        break;
      }
      default:
        break;
    }

    return changed;
  }

  evaluateConstraint(constraint) {
    const { type } = constraint;

    switch (type) {
      case 'xPosition':
        return !constraint.node ? 1 : Math.abs(constraint.node.location.x - constraint.value);
      case 'yPosition':
        return !constraint.node ? 1 : Math.abs(constraint.node.location.y - constraint.value);
      case 'edgeLength':
        if (!constraint.edge || !constraint.edge.nodes || constraint.edge.nodes.length < 2) return 1;
        return Math.abs(distanceBetweenPoints(constraint.edge.nodes[0].location, constraint.edge.nodes[1].location) - constraint.value);
      case 'sameStrain':
        if (!constraint.edge1 || !constraint.edge2) return 1;
        return Math.abs(constraint.edge1.strain - constraint.edge2.strain);
      case 'collinearity':
        if (!constraint.node1 || !constraint.node2 || !constraint.node3) return 1;
        return pointIsCollinear(constraint.node1.location, constraint.node2.location, constraint.node3.location) ? 0 : 1;
      case 'pairing':
        if (!constraint.node1 || !constraint.node2) return 1;
        return distanceBetweenPoints(constraint.node1.location, constraint.node2.location);
      case 'symmetry':
        if (!constraint.node1 || !constraint.node2) return 1;
        const reflected = reflectPoint(constraint.node1.location, constraint.centerX, constraint.centerY);
        return distanceBetweenPoints(reflected, constraint.node2.location);
      case 'activePath':
        return constraint.path && constraint.path.isActive ? 0 : 1;
      case 'pathAngle':
        return constraint.path ? Math.abs(constraint.path.angle - constraint.value) : 1;
      case 'pathAngleQuant':
        if (!constraint.path) return 1;
        const quantized = quantizeAngle(constraint.path.angle, constraint.quantValue, constraint.quantOffset);
        return Math.abs(constraint.path.angle - quantized);
      default:
        return 0;
    }
  }

  computeObjective() {
    return this.constraints.reduce((sum, constraint) => sum + this.evaluateConstraint(constraint), 0);
  }

  solve() {
    const maxIterations = 25;
    let changed = true;

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      this.iterations = iteration + 1;
      changed = false;

      for (const constraint of this.constraints) {
        if (this.applyConstraint(constraint)) {
          changed = true;
        }
      }

      if (!changed) {
        this.lastResult = {
          converged: true,
          iterations: this.iterations,
          constraintCount: this.constraints.length,
          objective: this.computeObjective()
        };
        return this.lastResult;
      }
    }

    this.lastResult = {
      converged: false,
      iterations: this.iterations,
      constraintCount: this.constraints.length,
      objective: this.computeObjective()
    };

    return this.lastResult;
  }
}
