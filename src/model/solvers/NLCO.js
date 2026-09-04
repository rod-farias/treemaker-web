import { NewtonRaphson } from './NewtonRaphson.js';
import { Matrix } from './Matrix.js';
import { pathSlack } from './ConstraintResiduals.js';
import { buildStrainPathConstraint } from './StrainPathConstraints.js';

export class NLCO extends NewtonRaphson {
  constructor(tree, options = {}) {
    super(tree, options);
    this.penalty = options.penalty ?? 10;
    this.learningRate = options.learningRate ?? 0.25;
    this.objectiveMode = options.objectiveMode ?? 'constraints';
    this.objectiveWeight = options.objectiveWeight ?? 1;
    this.feasibilityTolerance = options.feasibilityTolerance ?? this.tolerance;
  }

  _objectiveForCondition(constraint) {
    const residual = this._resolveConstraintValue(constraint);
    return residual * residual;
  }

  solve(conditions = []) {
    const items = Array.isArray(conditions) ? conditions : (this.tree ? this.tree.getConditions() : []);
    this._applyFixedConditions(items);
    const variables = this._collectMatrixVariables(items);
    if (variables.length === 0) {
      items.forEach(condition => this._applyConstraint(condition));
      return { converged: true, iterations: 1, objective: 0, constraintCount: items.length };
    }

    this._optimizationVariables = variables;
    let residuals = this._optimizationResiduals(items);
    let objective = this._objective(residuals, variables);
    let constraintObjective = this._constraintObjective(residuals);
    for (let iteration = 0; iteration < this.maxIterations; iteration += 1) {
      const residualNorm = Math.hypot(...residuals);
      if (residualNorm < this.feasibilityTolerance) {
        return { converged: true, iterations: iteration, objective, strainRMS: this.getStrainRMS(variables), constraintCount: items.length };
      }

      const jacobian = this._buildOptimizationJacobian(items, variables, residuals);
      // Plain least-squares picks the minimum-Euclidean-norm correction,
      // which (when several variables could equally satisfy the same
      // residual) implicitly minimizes Σ correctionᵢ² — completely ignoring
      // that the real objective for strain variables is Σ stiffnessᵢ·strainᵢ²
      // (see _objective()). Rescaling each strain variable's column by
      // 1/√stiffness before solving, then undoing that scale on the result,
      // instead makes the minimum-norm solution the minimum *weighted*-norm
      // one — i.e. the one that actually minimizes Σ stiffnessᵢ·strainᵢ² —
      // so a low-stiffness (flexible) edge properly absorbs more of a
      // shared required correction than a high-stiffness (stiff) one,
      // instead of splitting it evenly regardless of stiffness.
      const weights = variables.map(variable => (
        variable.edge ? 1 / Math.sqrt(Math.max(variable.edge.getStiffness(), 1e-9)) : 1
      ));
      const scaledJacobian = jacobian.map(row => row.map((value, index) => value * weights[index]));
      const scaledCorrection = new Matrix(scaledJacobian.length, variables.length, scaledJacobian)
        .solveLeastSquares(residuals.map(value => -value));
      if (!scaledCorrection) break;
      const correction = scaledCorrection.map((value, index) => value * weights[index]);

      const previousObjective = objective;
      let accepted = false;
      let scale = this.learningRate;
      for (let trial = 0; trial < 14; trial += 1) {
        variables.forEach((variable, index) => {
          this._setVariableValue(variable, this._getVariableValue(variable) + correction[index] * scale);
        });
        const trialResiduals = this._optimizationResiduals(items);
        const trialObjective = this._objective(trialResiduals, variables);
        const trialConstraintObjective = this._constraintObjective(trialResiduals);
        const improvesConstraints = trialConstraintObjective < constraintObjective - this.tolerance * this.tolerance;
        const preservesConstraints = Math.abs(trialConstraintObjective - constraintObjective) <= this.tolerance * this.tolerance;
        if (improvesConstraints || (preservesConstraints && trialObjective < previousObjective)) {
          residuals = trialResiduals;
          objective = trialObjective;
          constraintObjective = trialConstraintObjective;
          accepted = true;
          break;
        }
        variables.forEach((variable, index) => {
          this._setVariableValue(variable, this._getVariableValue(variable) - correction[index] * scale);
        });
        scale *= 0.5;
      }
      if (!accepted) break;
    }

    return { converged: false, iterations: this.maxIterations, objective, strainRMS: this.getStrainRMS(variables), constraintCount: items.length };
  }

  _objective(residuals, variables = []) {
    const constraintObjective = this._constraintObjective(residuals);
    if (this.objectiveMode !== 'strain') return constraintObjective;
    const strainObjective = variables
      .filter(variable => variable.edge)
      .reduce((total, variable) => total + variable.edge.getStiffness() * variable.edge.getStrain() ** 2, 0);
    return constraintObjective + this.objectiveWeight * strainObjective;
  }

  _constraintObjective(residuals) {
    return residuals.reduce((total, residual) => total + this.penalty * residual * residual, 0);
  }

  getStrainRMS(variables = this._optimizationVariables || []) {
    const edges = variables.filter(variable => variable.edge).map(variable => variable.edge);
    if (edges.length === 0) return 0;
    const weightedSquares = edges.reduce((total, edge) => total + edge.getStiffness() * edge.getStrain() ** 2, 0);
    return Math.sqrt(weightedSquares / edges.length);
  }

  getFixVarLengths(path, variables = this._collectMatrixVariables([])) {
    const edges = [];
    const nodes = path?.getNodes?.() || [];
    const scale = Math.max(this.tree?.getScale?.() || 1, 1e-12);
    let fixedLength = 0;
    for (let index = 0; index < nodes.length - 1; index += 1) {
      const edge = this.tree?.getEdge(nodes[index], nodes[index + 1]);
      if (!edge) continue;
      const baseLength = edge.getLength() * scale;
      const variable = variables.find(item => item.edge === edge);
      if (variable) {
        edges.push({ edge, baseLength, variable });
      } else {
        fixedLength += edge.getStrainedLength() * scale;
      }
    }
    return { fixedLength, variableEdges: edges };
  }

  getMultiStrainPathData(path, variables = this._optimizationVariables || this._collectMatrixVariables([])) {
    return buildStrainPathConstraint(this.tree, path, variables);
  }

  _optimizationResiduals(conditions) {
    const expand = condition => condition?.getConditions
      ? condition.getConditions().flatMap(expand)
      : [condition];
    const expanded = conditions.flatMap(expand);
    const residuals = [];
    for (const condition of expanded) {
      if (this.variableMode === 'strain' && condition?.getPath?.()) {
        residuals.push(this._strainPathResidual(condition.getPath(), this._optimizationVariables || []));
        if (condition.getAngle || condition.getQuantValue) {
          residuals.push(...this._matrixResiduals([condition]));
        }
      } else {
        residuals.push(...this._matrixResiduals([condition]));
      }
    }
    if (this.variableMode !== 'strain' || !this.tree) return residuals;
    for (const path of this.getStrainPathConstraints(expanded)) {
      const constraint = buildStrainPathConstraint(this.tree, path, this._optimizationVariables || []);
      residuals.push(Math.min(0, constraint?.evaluate?.() ?? pathSlack(path, this.tree)));
    }
    return residuals;
  }

  /**
   * Solo tiene sentido tensar un camino hoja-a-hoja si al menos un nodo o
   * arista de esa cadena es una variable de la optimización actual — de lo
   * contrario el camino es completamente fijo y su holgura no puede
   * cambiar, así que incluirlo como restricción solo puede volver el
   * problema infactible sin ganar nada (esto importa sobre todo para
   * "Scale Selection", donde la mayoría del árbol queda fija; para
   * "Scale Everything"/solveStrain, donde todas las hojas y aristas son
   * variables, este filtro no excluye nada).
   */
  getStrainPathConstraints(conditions = this.tree?.getConditions?.() || []) {
    const expand = condition => condition?.getConditions
      ? condition.getConditions().flatMap(expand)
      : [condition];
    const conditionedPaths = new Set(conditions.flatMap(expand).map(condition => condition?.getPath?.()).filter(Boolean));
    const variables = this._optimizationVariables || [];
    const movingNodes = new Set(variables.filter(variable => variable.node).map(variable => variable.node));
    const stretchyEdges = new Set(variables.filter(variable => variable.edge).map(variable => variable.edge));
    // tree.paths only holds whatever leaf-to-leaf paths have already been
    // looked up at least once via getPath() (e.g. by a prior "Scale
    // Everything" run, or a file that shipped with them) — it is NOT
    // proactively kept in sync with every leaf pair. Discovering every pair
    // here (getPath() caches as it goes) is what makes "Scale Selection"
    // and the strain solver work correctly on a tree nobody has queried yet.
    const leaves = (this.tree?.getNodes?.() || []).filter(node => node.getDegree?.() === 1);
    for (let i = 0; i < leaves.length; i += 1) {
      for (let j = i + 1; j < leaves.length; j += 1) {
        this.tree.getPath(leaves[i], leaves[j]);
      }
    }
    return (this.tree?.getPaths?.() || []).filter(path => {
      const nodes = path.getNodes?.() || [];
      if (nodes.length < 2 || nodes[0].getDegree?.() !== 1 || nodes[nodes.length - 1].getDegree?.() !== 1) return false;
      if (conditionedPaths.has(path)) return false;
      if (variables.length === 0) return true;
      const touchesNode = movingNodes.has(nodes[0]) || movingNodes.has(nodes[nodes.length - 1]);
      // tmPath has no getEdges() — it only stores its node chain — so the
      // edges along it have to be looked up pairwise from the tree.
      let touchesEdge = false;
      for (let i = 0; i < nodes.length - 1 && !touchesEdge; i += 1) {
        const edge = this.tree?.getEdge?.(nodes[i], nodes[i + 1]);
        if (edge && stretchyEdges.has(edge)) touchesEdge = true;
      }
      return touchesNode || touchesEdge;
    });
  }

  _strainPathResidual(path, variables) {
    const parts = this.getMultiStrainPathData(path, variables);
    return parts.evaluate();
  }

  _buildOptimizationJacobian(conditions, variables, residuals) {
    const jacobian = Array.from({ length: residuals.length }, () => []);
    for (const variable of variables) {
      const original = this._getVariableValue(variable);
      const delta = Math.max(1e-7, Math.abs(original) * 1e-7);
      this._setVariableValue(variable, original + delta);
      const forward = this._optimizationResiduals(conditions);
      this._setVariableValue(variable, original - delta);
      const backward = this._optimizationResiduals(conditions);
      this._setVariableValue(variable, original);
      for (let row = 0; row < residuals.length; row += 1) {
        jacobian[row].push((forward[row] - backward[row]) / (2 * delta));
      }
    }

    const expand = condition => condition?.getConditions
      ? condition.getConditions().flatMap(expand)
      : [condition];
    let rowIndex = 0;
    for (const condition of conditions.flatMap(expand)) {
      if (this.variableMode === 'strain' && condition?.getPath?.()) {
        const constraint = buildStrainPathConstraint(this.tree, condition.getPath(), variables);
        if (constraint) jacobian[rowIndex] = constraint.gradient();
        rowIndex += 1;
        if (condition.getAngle || condition.getQuantValue) rowIndex += 1;
      } else {
        rowIndex += this._matrixResiduals([condition]).length;
      }
    }
    if (this.variableMode === 'strain' && this.tree) {
      for (const path of this.getStrainPathConstraints(conditions.flatMap(expand))) {
        const constraint = buildStrainPathConstraint(this.tree, path, variables);
        if (constraint && constraint.evaluate() < 0) jacobian[rowIndex] = constraint.gradient();
        rowIndex += 1;
      }
    }
    return jacobian;
  }

}
