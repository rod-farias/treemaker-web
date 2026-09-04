import { NLCO } from './NLCO.js';

export class ALM extends NLCO {
  constructor(tree, options = {}) {
    super(tree, options);
    this.maxOuterIterations = options.maxOuterIterations ?? 8;
    this.penaltyGrowth = options.penaltyGrowth ?? 2;
    this.augmentedPenalty = options.augmentedPenalty ?? 1;
    this.multipliers = [];
  }

  _objective(residuals, variables = []) {
    const constraintObjective = residuals.reduce((total, residual, index) => {
      const multiplier = this.multipliers[index] || 0;
      return total + multiplier * residual + 0.5 * this.augmentedPenalty * residual * residual;
    }, 0);
    if (this.objectiveMode !== 'strain') return constraintObjective;
    const strainObjective = variables
      .filter(variable => variable.edge)
      .reduce((total, variable) => total + variable.edge.getStiffness() * variable.edge.getStrain() ** 2, 0);
    return constraintObjective + this.objectiveWeight * strainObjective;
  }

  solve(conditions = []) {
    const items = Array.isArray(conditions) ? conditions : (this.tree ? this.tree.getConditions() : []);
    // Precompute the variable set so getStrainPathConstraints() (used by
    // both the mask below and every residual/jacobian call inside the
    // solve loop) sees the same variables throughout — otherwise the mask
    // could be built against a stale (or empty, on a fresh instance)
    // variable set while residuals use the real one, desyncing their
    // indices. The set itself doesn't depend on node positions, only on
    // tree structure/selection, so precomputing it here changes nothing
    // once the loop actually runs.
    this._optimizationVariables = this._collectMatrixVariables(items);
    this.inequalityMask = this._getInequalityMask(items);
    let result = null;
    let residuals = [];
    for (let outer = 0; outer < this.maxOuterIterations; outer += 1) {
      result = super.solve(items);
      residuals = this._optimizationResiduals(items);
      if (this.multipliers.length !== residuals.length) this.multipliers = Array(residuals.length).fill(0);
      const norm = Math.hypot(...residuals);
      if (norm < this.feasibilityTolerance) {
        return {
          ...result,
          converged: true,
          outerIterations: outer + 1,
          objective: this._objective(residuals, this._optimizationVariables || []),
          strainRMS: this.getStrainRMS(this._optimizationVariables || []),
          residualNorm: norm,
          penalty: this.augmentedPenalty,
          multipliers: [...this.multipliers]
        };
      }
      this.multipliers = this.multipliers.map((value, index) => (
        this.inequalityMask[index]
          ? Math.max(0, value - this.augmentedPenalty * residuals[index])
          : value + this.augmentedPenalty * residuals[index]
      ));
      this.augmentedPenalty *= this.penaltyGrowth;
    }
    return {
      ...(result || { converged: false, iterations: 0, constraintCount: items.length }),
      converged: false,
      outerIterations: this.maxOuterIterations,
      objective: this._objective(residuals, this._optimizationVariables || []),
      strainRMS: this.getStrainRMS(this._optimizationVariables || []),
      residualNorm: Math.hypot(...residuals),
      penalty: this.augmentedPenalty,
      multipliers: [...this.multipliers]
    };
  }

  _objective(residuals, variables = []) {
    const constraintObjective = residuals.reduce((total, residual, index) => {
      const multiplier = this.multipliers[index] || 0;
      if (this.inequalityMask?.[index]) {
        const violation = Math.min(0, residual);
        return total - multiplier * violation + 0.5 * this.augmentedPenalty * violation * violation;
      }
      return total + multiplier * residual + 0.5 * this.augmentedPenalty * residual * residual;
    }, 0);
    if (this.objectiveMode !== 'strain') return constraintObjective;
    const strainObjective = variables
      .filter(variable => variable.edge)
      .reduce((total, variable) => total + variable.edge.getStiffness() * variable.edge.getStrain() ** 2, 0);
    return constraintObjective + this.objectiveWeight * strainObjective;
  }

  _getInequalityMask(conditions) {
    const expand = condition => condition?.getConditions
      ? condition.getConditions().flatMap(expand)
      : [condition];
    const expanded = conditions.flatMap(expand);
    const mask = [];
    for (const condition of expanded) {
      if (this.variableMode === 'strain' && condition?.getPath?.()) {
        mask.push(false);
        if (condition.getAngle || condition.getQuantValue) mask.push(false);
      } else {
        mask.push(...Array(this._matrixResiduals([condition]).length).fill(false));
      }
    }
    // Must mirror _optimizationResiduals()'s guard exactly: that method
    // only emits one residual per strain-path constraint when
    // variableMode === 'strain', so appending mask entries for them
    // unconditionally would desync the mask from the residuals array for
    // any non-strain solve, misaligning every constraint mask index after
    // this point.
    if (this.variableMode === 'strain') {
      for (const path of this.getStrainPathConstraints(expanded)) mask.push(true);
    }
    return mask;
  }
}
