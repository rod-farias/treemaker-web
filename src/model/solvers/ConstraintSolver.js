import { Matrix } from './Matrix.js';

/**
 * Generic augmented-Lagrangian least-squares solver over plain scalar
 * variables/constraints, independent of the tmCondition class hierarchy
 * (unlike NLCO/ALM, which are built around tree conditions). Used by
 * ScaleOptimizer's feasibility check at a candidate scale: a single
 * damped-Newton least-squares correction only ever finds the *nearest*
 * feasible point to the current one, and can get stuck reporting
 * "infeasible" for a scale that is genuinely reachable from a different
 * arrangement of the same leaves. The multiplier updates below let a
 * constraint's pressure accumulate across outer rounds — the same
 * mechanism ALM.js uses for path-strain constraints — which lets the
 * solver escape those local sticking points, closer to how the original's
 * CFSQP solver handles active inequality sets.
 */
export function solveConstraints(variables, constraints, options = {}) {
  const tolerance = options.tolerance ?? 1e-7;
  const maxIterations = options.maxIterations ?? 60;
  const maxOuterIterations = options.maxOuterIterations ?? 10;
  const penaltyGrowth = options.penaltyGrowth ?? 3;
  const learningRate = options.learningRate ?? 0.5;
  let penalty = options.penalty ?? 4;
  let multipliers = new Array(constraints.length).fill(0);

  const evaluate = () => constraints.map(c => c.value());
  // The part of a residual that actually needs correcting: the whole value
  // for an equality constraint, but only the violated (negative) part for
  // an inequality one — an already-satisfied inequality (positive slack)
  // must not pull the solution back toward zero.
  const activePart = (value, inequality) => (inequality ? Math.min(0, value) : value);
  const feasible = (values) => values.every((v, i) => Math.abs(activePart(v, constraints[i].inequality)) <= tolerance);

  if (variables.length === 0 || constraints.length === 0) {
    return { converged: feasible(evaluate()) };
  }

  const augmentedObjective = (values) => values.reduce((total, v, i) => {
    const active = activePart(v, constraints[i].inequality);
    return total - multipliers[i] * active + 0.5 * penalty * active * active;
  }, 0);

  const buildJacobian = (values) => {
    const jacobian = Array.from({ length: values.length }, () => []);
    for (const variable of variables) {
      const original = variable.get();
      const delta = Math.max(1e-7, Math.abs(original) * 1e-6);
      variable.set(original + delta);
      const forward = evaluate();
      variable.set(original - delta);
      const backward = evaluate();
      variable.set(original);
      for (let row = 0; row < values.length; row += 1) {
        jacobian[row].push((forward[row] - backward[row]) / (2 * delta));
      }
    }
    return jacobian;
  };

  let values = evaluate();
  if (feasible(values)) return { converged: true, iterations: 0 };

  for (let outer = 0; outer < maxOuterIterations; outer += 1) {
    let objective = augmentedObjective(values);
    for (let inner = 0; inner < maxIterations; inner += 1) {
      if (feasible(values)) return { converged: true, outer, inner };

      const jacobian = buildJacobian(values);
      const targets = values.map((v, i) => activePart(v, constraints[i].inequality));
      const correction = new Matrix(jacobian.length, variables.length, jacobian)
        .solveLeastSquares(targets.map(v => -v));
      if (!correction) break;

      const before = variables.map(v => v.get());
      const previousObjective = objective;
      let accepted = false;
      let trialScale = learningRate;
      for (let trial = 0; trial < 14; trial += 1) {
        variables.forEach((variable, index) => variable.set(before[index] + correction[index] * trialScale));
        const trialValues = evaluate();
        const trialObjective = augmentedObjective(trialValues);
        if (Number.isFinite(trialObjective) && trialObjective < previousObjective - tolerance * tolerance) {
          values = trialValues;
          objective = trialObjective;
          accepted = true;
          break;
        }
        trialScale *= 0.5;
      }
      if (!accepted) {
        variables.forEach((variable, index) => variable.set(before[index]));
        break;
      }
    }

    if (feasible(values)) return { converged: true, outer };

    multipliers = multipliers.map((m, i) => {
      const active = activePart(values[i], constraints[i].inequality);
      return constraints[i].inequality ? Math.max(0, m - penalty * active) : m + penalty * values[i];
    });
    penalty *= penaltyGrowth;
  }

  return { converged: feasible(evaluate()) };
}
