import { Matrix } from './Matrix.js';
import { constraintResiduals, angleDifference } from './ConstraintResiduals.js';
import { constraintJacobians } from './ConstraintJacobians.js';

export class NewtonRaphson {
  constructor(tree, options = {}) {
    this.tree = tree;
    this.maxIterations = options.maxIterations ?? 50;
    this.tolerance = options.tolerance ?? 1e-8;
    this.stepSize = options.stepSize ?? 0.5;
    this.useMatrix = options.useMatrix ?? false;
    this.variableMode = options.variableMode ?? 'all';
    // Restricts variableMode 'strain' to a subset of nodes/edges (used by
    // "Scale Selection", which strains only the selected edges by moving
    // only the selected leaf nodes) instead of the whole tree (used by
    // "Scale Everything"/solveStrain).
    this.selectionNodes = options.selectionNodes ?? null;
    this.selectionEdges = options.selectionEdges ?? null;
  }

  _resolveConstraintValue(constraint) {
    if (!constraint) return 0;

    if (constraint.isNodeCondition && constraint.isNodeCondition()) {
      const node = constraint.getNode ? constraint.getNode() : null;
      if (!node) return 0;
      const loc = node.getLoc ? node.getLoc() : node.location;

      if (typeof constraint.getXFixValue === 'function' && constraint.getXFixed && constraint.getXFixed()) {
        return loc.x - constraint.getXFixValue();
      }
      if (typeof constraint.getYFixValue === 'function' && constraint.getYFixed && constraint.getYFixed()) {
        return loc.y - constraint.getYFixValue();
      }
      if (typeof constraint.getCornerLocation === 'function') {
        const corner = constraint.getCornerLocation();
        return Math.hypot(loc.x - corner.x, loc.y - corner.y);
      }
      if (typeof constraint.getEdgeLocation === 'function') {
        const edge = constraint.getEdgeLocation();
        return Math.hypot(loc.x - edge.x, loc.y - edge.y);
      }
    }

    if (constraint.isEdgeCondition && constraint.isEdgeCondition()) {
      const edge = constraint.getEdge ? constraint.getEdge() : null;
      if (!edge) return 0;
      const nodes = edge.getNodes?.() || edge.nodes || [];
      const length = nodes.length >= 2
        ? Math.hypot(nodes[1].getLocX() - nodes[0].getLocX(), nodes[1].getLocY() - nodes[0].getLocY())
        : (edge.getLength ? edge.getLength() : edge.length);
      const target = constraint.getLength ? constraint.getLength() : 0;
      return length - target;
    }

    if (constraint.isPathCondition && constraint.isPathCondition()) {
      const path = constraint.getPath ? constraint.getPath() : null;
      if (!path) return 0;
      const angle = path.getAngle ? path.getAngle() : path.angle;
      const target = constraint.getAngle ? constraint.getAngle() : 0;
      return angle - target;
    }

    return 0;
  }

  _applyConstraint(constraint) {
    if (!constraint || typeof constraint.addConstraints !== 'function') return false;

    const optimizer = {
      constraints: [],
      addXPositionConstraint: (node, value) => {
        if (node) node.setLocationXY(value, node.getLocY());
      },
      addYPositionConstraint: (node, value) => {
        if (node) node.setLocationXY(node.getLocX(), value);
      },
      addEdgeLengthConstraint: (edge, value) => {
        if (!edge || !edge.nodes || edge.nodes.length < 2) return;
        const [n1, n2] = edge.nodes;
        if (!n1 || !n2) return;
        const dirX = n2.getLocX() - n1.getLocX();
        const dirY = n2.getLocY() - n1.getLocY();
        const len = Math.hypot(dirX, dirY) || 1;
        n2.setLocationXY(n1.getLocX() + (dirX / len) * value, n1.getLocY() + (dirY / len) * value);
      },
      addSameStrainConstraint: (edge1, edge2) => {
        if (edge1 && edge2) edge2.strain = edge1.strain;
      },
      addCollinearityConstraint: (a, b, c) => {
        if (!a || !b || !c) return;
        const ax = a.getLocX();
        const ay = a.getLocY();
        const bx = b.getLocX();
        const by = b.getLocY();
        const dx = bx - ax;
        const dy = by - ay;
        const t = ((c.getLocX() - ax) * dx + (c.getLocY() - ay) * dy) / (dx * dx + dy * dy || 1);
        c.setLocationXY(ax + t * dx, ay + t * dy);
      },
      addPairingConstraint: (a, b) => {
        if (a && b) b.setLocationXY(a.getLocX(), a.getLocY());
      },
      addSymmetryConstraint: (a, b, centerX, centerY) => {
        if (a && b) b.setLocationXY(2 * centerX - a.getLocX(), 2 * centerY - a.getLocY());
      },
      addActivePathConstraint: (path) => {
        if (path) path.isActive = true;
      },
      addPathAngleConstraint: (path, value) => {
        if (path) {
          path.angle = Number(value);
          path.angleFixed = true;
        }
      },
      addPathAngleQuantConstraint: (path, value, offset = 0) => {
        if (path) {
          path.angleQuant = true;
          path.quantValue = value;
          path.quantOffset = offset;
          const steps = Math.max(1, Number(value));
          const period = (Math.PI * 2) / steps;
          path.angle = offset + Math.round((path.angle - offset) / period) * period;
        }
      },
      solve: () => ({ converged: true, iterations: 1, objective: 0 })
    };

    constraint.addConstraints(optimizer);
    return true;
  }

  solve(conditions = []) {
    const items = Array.isArray(conditions) ? conditions : (this.tree ? this.tree.getConditions() : []);
    if (this.useMatrix) return this.solveMatrix(items);
    let lastError = Infinity;

    for (let i = 0; i < this.maxIterations; i += 1) {
      let totalError = 0;

      for (const condition of items) {
        if (!condition) continue;
        const error = this._resolveConstraintValue(condition);
        totalError += Math.abs(error);
        this._applyConstraint(condition);
      }

      if (totalError < this.tolerance) {
        return {
          converged: true,
          iterations: i + 1,
          objective: totalError,
          constraintCount: items.length
        };
      }

      lastError = totalError;
    }

    return {
      converged: false,
      iterations: this.maxIterations,
      objective: lastError,
      constraintCount: items.length
    };
  }

  _resolveConstraintValues(constraint) {
    return constraintResiduals(constraint, this.tree);
    /*
    if (!constraint) return [];
    if (constraint.getXFixed?.() || constraint.getYFixed?.()) {
      const node = constraint.getNode?.();
      if (!node) return [];
      const loc = node.getLoc();
      return [
        ...(constraint.getXFixed() ? [loc.x - constraint.getXFixValue()] : []),
        ...(constraint.getYFixed() ? [loc.y - constraint.getYFixValue()] : [])
      ];
    }
    if (constraint.getNode1 && constraint.getNode2) {
      const first = constraint.getNode1();
      const second = constraint.getNode2();
      if (!first || !second) return [];
      const a = first.getLoc();
      const b = second.getLoc();
      if (constraint.isNodeCondition?.() && constraint.getNode3) {
        const third = constraint.getNode3();
        const c = third.getLoc();
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const scale = Math.max(Math.hypot(dx, dy), 1e-8);
        return [(dx * (c.y - a.y) - dy * (c.x - a.x)) / scale];
      }
      if (constraint.isNodeCondition?.()) {
        if (constraint.getNode1 && constraint.getNode2 && constraint.getNode1() !== constraint.getNode2()) {
          if (constraint.constructor.name === 'ConditionNodeSymmetric') {
            const centerX = this.tree.getPaperWidth() / 2;
            const centerY = this.tree.getPaperHeight() / 2;
            return [b.x - (2 * centerX - a.x), b.y - (2 * centerY - a.y)];
          }
          return [b.x - a.x, b.y - a.y];
        }
      }
    }
    if (constraint.getEdge1 && constraint.getEdge2) {
      return [constraint.getEdge1().getStrain() - constraint.getEdge2().getStrain()];
    }
    if (constraint.getCornerLocation?.() || constraint.getEdgeLocation?.()) {
      const node = constraint.getNode?.();
      const target = constraint.getCornerLocation?.() || constraint.getEdgeLocation?.();
      if (node && target) return [node.getLocX() - target.x, node.getLocY() - target.y];
    }
    if (constraint.isPathCondition?.() && constraint.getPath?.()) {
      const path = constraint.getPath();
      const nodes = path.getNodes();
      if (nodes.length < 2) return [];
      const first = nodes[0].getLoc();
      const last = nodes[nodes.length - 1].getLoc();
      const geometricAngle = Math.atan2(last.y - first.y, last.x - first.x);
      if (constraint.getAngle) return [this._angleDifference(geometricAngle, constraint.getAngle())];
      if (constraint.getQuantValue) {
        const quant = constraint.getQuantValue();
        const offset = constraint.getQuantOffset();
        const period = (2 * Math.PI) / Math.max(1, quant);
        const target = offset + Math.round((geometricAngle - offset) / period) * period;
        return [this._angleDifference(geometricAngle, target)];
      }
    }
    return [this._resolveConstraintValue(constraint)];
    */
  }

  _angleDifference(first, second) {
    return angleDifference(first, second);
  }

  _collectMatrixVariables(conditions) {
    const nodes = new Set();
    const fixedAxes = new Map();
    const expand = condition => condition?.getConditions
      ? condition.getConditions().flatMap(expand)
      : [condition];
    const expandedConditions = conditions.flatMap(expand);
    for (const condition of expandedConditions) {
      const fixedNode = condition?.getNode?.();
      if (fixedNode && (condition.getXFixed?.() || condition.getYFixed?.() || condition.getCornerLocation || condition.getEdgeLocation)) {
        const axes = fixedAxes.get(fixedNode) || new Set();
        if (condition.getXFixed?.() || condition.getCornerLocation || condition.getEdgeLocation) axes.add('x');
        if (condition.getYFixed?.() || condition.getCornerLocation || condition.getEdgeLocation) axes.add('y');
        fixedAxes.set(fixedNode, axes);
      }
      const node = condition?.getNode?.();
      if (node) nodes.add(node);
      for (const getter of ['getNode1', 'getNode2', 'getNode3']) {
        const referencedNode = condition?.[getter]?.();
        if (referencedNode) nodes.add(referencedNode);
      }
      const edge = condition?.getEdge?.();
      for (const edgeNode of edge?.getNodes?.() || []) nodes.add(edgeNode);
      for (const getter of ['getEdge1', 'getEdge2']) {
        const referencedEdge = condition?.[getter]?.();
        for (const edgeNode of referencedEdge?.getNodes?.() || []) nodes.add(edgeNode);
      }
      for (const pathNode of condition?.getPath?.()?.getNodes?.() || []) nodes.add(pathNode);
    }
    if (this.variableMode === 'strain' && this.tree) {
      const nodePool = this.selectionNodes ? [...this.selectionNodes] : this.tree.getNodes();
      for (const node of nodePool) {
        if (node.getDegree?.() === 1 || node.isLeafNode) nodes.add(node);
      }
    }
    const variables = [...nodes].flatMap(node => {
      const fixed = fixedAxes.get(node) || new Set();
      return [
        ...(fixed.has('x') ? [] : [{ node, axis: 'x' }]),
        ...(fixed.has('y') ? [] : [{ node, axis: 'y' }])
      ];
    });
    for (const condition of conditions) {
      for (const getter of ['getEdge1', 'getEdge2']) {
        const edge = condition?.[getter]?.();
        if (edge && !variables.some(variable => variable.edge === edge)) {
          variables.push({ edge, property: 'strain' });
        }
      }
    }
    if (this.variableMode === 'strain' && this.tree) {
      const edgePool = this.selectionEdges ? [...this.selectionEdges] : this.tree.getEdges();
      for (const edge of edgePool) {
        if (!edge.isPinnedEdge && !variables.some(variable => variable.edge === edge)) {
          variables.push({ edge, property: 'strain' });
        }
      }
    }
    return variables;
  }

  _getVariableValue(variable) {
    return variable.edge ? variable.edge.getStrain() : variable.node.getLoc()[variable.axis];
  }

  _setVariableValue(variable, value) {
    if (variable.edge) {
      const finiteValue = Number.isFinite(value) ? value : variable.edge.getStrain();
      variable.edge.setStrain(Math.max(-0.999, Math.min(2, finiteValue)));
    }
    else variable.node.getLoc()[variable.axis] = value;
  }

  _matrixResiduals(conditions) {
    return conditions.flatMap(condition => this._resolveConstraintValues(condition));
  }

  diagnose(conditions = []) {
    const items = Array.isArray(conditions) ? conditions : (this.tree ? this.tree.getConditions() : []);
    const variables = this._collectMatrixVariables(items);
    const residuals = this._matrixResiduals(items);
    const jacobian = variables.length > 0 && residuals.length > 0
      ? this._buildJacobian(items, variables, residuals)
      : [];
    const report = [];
    const flatten = (condition) => condition?.getConditions
      ? condition.getConditions().flatMap(flatten)
      : [condition];
    for (const condition of items.flatMap(flatten)) {
      const values = this._resolveConstraintValues(condition);
      const norm = Math.hypot(...values);
      report.push({
        condition,
        residuals: values,
        norm,
        feasible: norm <= this.tolerance && condition?.isValidCondition?.() !== false
      });
    }
    const objective = residuals.reduce((sum, value) => sum + value * value, 0);
    const jacobianMatrix = jacobian.length > 0 ? new Matrix(jacobian.length, variables.length, jacobian) : null;
    const jacobianRank = jacobianMatrix ? jacobianMatrix.rank() : 0;
    const augmentedRank = jacobianMatrix
      ? new Matrix(jacobian.length, variables.length + 1, jacobian.map((row, index) => [...row, -residuals[index]])).rank()
      : 0;
    let status = 'consistent';
    if (Math.sqrt(objective) > this.tolerance) {
      status = augmentedRank > jacobianRank
        ? 'infeasible'
        : (jacobianRank < variables.length ? 'singular' : 'infeasible');
    }
    return {
      status,
      converged: status === 'consistent',
      objective,
      residualNorm: Math.sqrt(objective),
      variableCount: variables.length,
      residualCount: residuals.length,
      jacobianRank,
      augmentedRank,
      degreesOfFreedom: Math.max(0, variables.length - jacobianRank),
      conditions: report
    };
  }

  solveMatrix(conditions = []) {
    this._applyFixedConditions(conditions);
    const variables = this._collectMatrixVariables(conditions);
    if (variables.length === 0) {
      conditions.forEach(condition => this._applyConstraint(condition));
      return { converged: true, iterations: 1, objective: 0, constraintCount: conditions.length };
    }

    let residuals = this._matrixResiduals(conditions);
    let objective = residuals.reduce((sum, value) => sum + value * value, 0);
    for (let iteration = 0; iteration < this.maxIterations; iteration += 1) {
      if (Math.sqrt(objective) < this.tolerance) {
        return { converged: true, iterations: iteration, objective, constraintCount: conditions.length };
      }

      const jacobian = this._buildJacobian(conditions, variables, residuals);

      const correction = new Matrix(jacobian.length, variables.length, jacobian)
        .solveLeastSquares(residuals.map(value => -value));
      if (!correction) break;

      const previousObjective = objective;
      let accepted = false;
      let trialScale = this.stepSize;
      for (let trial = 0; trial < 12; trial += 1) {
        variables.forEach((variable, index) => {
          this._setVariableValue(variable, this._getVariableValue(variable) + correction[index] * trialScale);
        });
        const trialResiduals = this._matrixResiduals(conditions);
        const trialObjective = trialResiduals.reduce((sum, value) => sum + value * value, 0);
        if (trialObjective < previousObjective) {
          residuals = trialResiduals;
          objective = trialObjective;
          accepted = true;
          break;
        }
        variables.forEach((variable, index) => {
          this._setVariableValue(variable, this._getVariableValue(variable) - correction[index] * trialScale);
        });
        trialScale *= 0.5;
      }
      if (!accepted) break;
    }

    return { converged: false, iterations: this.maxIterations, objective, constraintCount: conditions.length };
  }

  _buildJacobian(conditions, variables, residuals) {
    const analyticRows = [];
    let analytic = true;
    for (const condition of conditions) {
      const rows = constraintJacobians(condition, variables, this.tree);
      if (!rows) {
        analytic = false;
        break;
      }
      analyticRows.push(...rows);
    }
    if (analytic && analyticRows.length === residuals.length) return analyticRows;

    const jacobian = Array.from({ length: residuals.length }, () => []);
    for (const variable of variables) {
      const original = this._getVariableValue(variable);
      const delta = Math.max(1e-7, Math.abs(original) * 1e-7);
      this._setVariableValue(variable, original + delta);
      const forward = this._matrixResiduals(conditions);
      this._setVariableValue(variable, original - delta);
      const backward = this._matrixResiduals(conditions);
      this._setVariableValue(variable, original);
      for (let row = 0; row < residuals.length; row += 1) {
        jacobian[row].push((forward[row] - backward[row]) / (2 * delta));
      }
    }
    return jacobian;
  }

  _applyFixedConditions(conditions) {
    const expand = condition => condition?.getConditions
      ? condition.getConditions().flatMap(expand)
      : [condition];
    for (const condition of conditions.flatMap(expand)) {
      if (condition?.getXFixed || condition?.getCornerLocation || condition?.getEdgeLocation) {
        this._applyConstraint(condition);
      }
    }
  }
}
