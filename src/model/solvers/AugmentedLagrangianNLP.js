/**
 * Port of TreeMaker's tmNLCO_alm (original/TreeMaker/Source/tmModel/tmNLCO/
 * tmNLCO_alm.cpp): a general nonlinear constrained optimizer that minimizes
 * a scalar objective over a plain vector of variables, subject to equality
 * and inequality constraints and box bounds, via an Augmented Lagrangian
 * outer loop wrapped around a BFGS quasi-Newton inner minimization with a
 * backtracking line search.
 *
 * This exists specifically to replicate ScaleOptimizer's "Scale Everything":
 * the original solves scale and every leaf's position as ONE joint
 * optimization (see tmScaleOptimizer.cpp), not scale-then-leaves like this
 * port used to. Confirmed by building tmNLCO_alm.cpp itself (the only
 * fully-distributable engine in the original source tree — CFSQP, likely
 * what generated the reference .tmd5 fixtures, is proprietary and not
 * included) and running it against test/prueba5_*.tmd5 and
 * test/prueba6_*.tmd5: from the same starting point, it reproduces the
 * reference scale and leaf positions almost exactly, while the previous
 * bisection-over-scale + geometric-heuristic approach in ScaleOptimizer.js
 * did not (see git history for the bisection version and its known
 * multi-branch-node local-optimum problem).
 *
 * `variables` follow the same {get(), set(value)} shape already used by
 * ConstraintSolver.js's solveConstraints() — each entry is normally bound
 * directly to live tree state (a node's x/y, or the tree's scale), and
 * evaluating an objective/constraint's value() or grad() is expected to
 * read that same live state, which setX()/numericGrad() below mutate via
 * those setters before every evaluation. `objective`/each constraint may
 * supply an analytic `grad(out)`; when omitted, a central-difference
 * numeric gradient (same formula as ConstraintSolver.js) is used instead —
 * cheap enough for the occasional tree-condition constraint, but callers
 * with an easy closed form (e.g. leaf-pair distance) should supply one, as
 * it's evaluated far more often than the objective itself.
 *
 * `options.onOuterIteration({ iterOuter, innerIterations, feas, fval, x })`
 * is an optional debug hook fired once per outer ALM round (mirroring
 * tmNLCO_alm.cpp's own TMLOG trace under DEBUG_SHOW_PROGRESS) — useful for
 * diffing this port's convergence path against the real engine's, the way
 * test/prueba7_*.tmd5's divergence was root-caused (see ScaleOptimizer.js's
 * PathFn1 gradient comment): matching every formula exactly still leaves
 * floating-point round-off (this port's operations aren't guaranteed
 * bit-identical to the C++ compiler's) that a large, highly degenerate
 * constraint set can amplify into a genuinely different local optimum,
 * since BFGS's path is chaotic-sensitive near a point where many
 * constraints go tight at once. No effect on the solve when omitted.
 */

const EPS = Number.EPSILON;

function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

export function minimizeAugmentedLagrangian(variables, objective, constraints, bounds, options = {}) {
  const n = variables.length;
  const { lower, upper } = bounds;
  const WEIGHT_START = options.weightStart ?? 10;
  const WEIGHT_RATIO = options.weightRatio ?? 10;
  const WEIGHT_MAX = options.weightMax ?? 1e8;
  const TOL_FEAS = options.feasibilityTolerance ?? 1e-5;
  const TOL_F = options.objectiveTolerance ?? 1e-5;
  const ITER_OUTER_MAX = options.maxOuterIterations ?? 50;
  const ITER_INNER_MAX = options.maxInnerIterations ?? 200;

  const setX = (x) => variables.forEach((v, i) => v.set(x[i]));
  const getX = () => variables.map(v => v.get());

  // Central-difference numeric gradient, used whenever a value-only
  // (grad-less) function is evaluated. Assumes the live tree state already
  // equals `x` (the caller must have called setX(x) first) and restores it
  // when done.
  const numericGrad = (fn, x, out) => {
    for (let i = 0; i < n; i += 1) {
      const h = Math.max(1e-7, Math.abs(x[i]) * 1e-6);
      variables[i].set(x[i] + h);
      const plus = fn();
      variables[i].set(x[i] - h);
      const minus = fn();
      variables[i].set(x[i]);
      out[i] = (plus - minus) / (2 * h);
    }
  };

  const objectiveValue = (x) => { setX(x); return objective.value(); };
  const objectiveGrad = (x, out) => {
    setX(x);
    if (objective.grad) objective.grad(out);
    else numericGrad(objective.value, x, out);
  };
  const constraintValue = (c, x) => { setX(x); return c.value(); };
  const constraintGrad = (c, x, out) => {
    setX(x);
    if (c.grad) c.grad(out);
    else numericGrad(c.value, x, out);
  };

  let weight = WEIGHT_START;
  // One Lagrange multiplier per: equality, inequality, lower bound, upper bound.
  let lagMul = new Array(constraints.length + 2 * n).fill(0);
  const eqIndices = [];
  const ineqIndices = [];
  constraints.forEach((c, i) => (c.inequality ? ineqIndices : eqIndices).push(i));
  const ne = eqIndices.length;
  const ni = ineqIndices.length;

  const maxStepSq = upper.reduce((sum, u, i) => sum + (u - lower[i]) ** 2, 0);
  const maxStep = maxStepSq > 0 ? Math.sqrt(maxStepSq) : 1;

  const augLagFn = (x) => {
    let fret = objectiveValue(x);
    eqIndices.forEach((ci, i) => {
      const f = constraintValue(constraints[ci], x);
      fret += (lagMul[i] + f * weight) * f;
    });
    ineqIndices.forEach((ci, i) => {
      const lm = lagMul[ne + i];
      const f = constraintValue(constraints[ci], x);
      const mu = -0.5 * lm / weight;
      fret += f < mu ? mu : (lm + f * weight) * f;
    });
    for (let i = 0; i < n; i += 1) {
      const lm = lagMul[ne + ni + i];
      const f = lower[i] - x[i];
      const mu = -0.5 * lm / weight;
      fret += f < mu ? mu : (lm + f * weight) * f;
    }
    for (let i = 0; i < n; i += 1) {
      const lm = lagMul[ne + ni + n + i];
      const f = x[i] - upper[i];
      const mu = -0.5 * lm / weight;
      fret += f < mu ? mu : (lm + f * weight) * f;
    }
    return fret;
  };

  const tolLm = 4 * EPS;
  const scratch = new Array(n);
  const augLagGrad = (x, g) => {
    objectiveGrad(x, g);
    eqIndices.forEach((ci, i) => {
      const f = constraintValue(constraints[ci], x);
      const gmul = lagMul[i] + 2 * f * weight;
      if (Math.abs(gmul) > tolLm) {
        constraintGrad(constraints[ci], x, scratch);
        for (let j = 0; j < n; j += 1) g[j] += gmul * scratch[j];
      }
    });
    ineqIndices.forEach((ci, i) => {
      const lm = lagMul[ne + i];
      const f = constraintValue(constraints[ci], x);
      const mu = -0.5 * lm / weight;
      if (f >= mu) {
        const gmul = lm + 2 * f * weight;
        if (Math.abs(gmul) > tolLm) {
          constraintGrad(constraints[ci], x, scratch);
          for (let j = 0; j < n; j += 1) g[j] += gmul * scratch[j];
        }
      }
    });
    for (let i = 0; i < n; i += 1) {
      const lm = lagMul[ne + ni + i];
      const f = lower[i] - x[i];
      const mu = -0.5 * lm / weight;
      if (f >= mu) {
        const gmul = lm + 2 * f * weight;
        if (Math.abs(gmul) > tolLm) g[i] -= gmul;
      }
    }
    for (let i = 0; i < n; i += 1) {
      const lm = lagMul[ne + ni + n + i];
      const f = x[i] - upper[i];
      const mu = -0.5 * lm / weight;
      if (f >= mu) {
        const gmul = lm + 2 * f * weight;
        if (Math.abs(gmul) > tolLm) g[i] += gmul;
      }
    }
  };

  const lineSearchAugLag = (xOld, fOld, gOld, srchDir) => {
    const ALF = 1e-4;
    const TOL_X = EPS;
    let dirMag = Math.sqrt(dot(srchDir, srchDir));
    if (dirMag > maxStep) {
      const scale = maxStep / dirMag;
      for (let i = 0; i < n; i += 1) srchDir[i] *= scale;
    }
    const slope = dot(gOld, srchDir);
    const xNew = xOld.slice();
    if (slope >= 0) return { xNew, fNew: fOld };

    let lmtest = 0;
    for (let i = 0; i < n; i += 1) {
      const t = Math.abs(srchDir[i]) / Math.max(Math.abs(xOld[i]), 1);
      if (t > lmtest) lmtest = t;
    }
    const lmMin = TOL_X / lmtest;

    let lm = 1;
    let lm2 = 0;
    let fNew2 = 0;
    let fNew = fOld;
    for (;;) {
      for (let i = 0; i < n; i += 1) xNew[i] = xOld[i] + lm * srchDir[i];
      fNew = augLagFn(xNew);

      if (lm < lmMin) {
        for (let i = 0; i < n; i += 1) xNew[i] = xOld[i];
        return { xNew, fNew: fOld };
      }

      const fToBeat = fOld + ALF * lm * slope;
      if (fNew <= fToBeat) return { xNew, fNew };

      let lmTmp;
      if (lm === 1) {
        lmTmp = -slope / (2 * (fNew - fOld - slope));
      } else {
        const rhs1 = fNew - fOld - lm * slope;
        const rhs2 = fNew2 - fOld - lm2 * slope;
        const lmsqr = lm * lm;
        const lmsqr2 = lm2 * lm2;
        const lmd = lm - lm2;
        const a = (rhs1 / lmsqr - rhs2 / lmsqr2) / lmd;
        const b = (-lm2 * rhs1 / lmsqr + lm * rhs2 / lmsqr2) / lmd;
        if (a === 0) {
          lmTmp = -slope / (2 * b);
        } else {
          const discr = b * b - 3 * a * slope;
          if (discr < 0) lmTmp = 0.5 * lm;
          else if (b <= 0) lmTmp = (-b + Math.sqrt(discr)) / (3 * a);
          else lmTmp = -slope / (b + Math.sqrt(discr));
        }
        if (lmTmp > 0.5 * lm) lmTmp = 0.5 * lm;
      }
      lm2 = lm;
      fNew2 = fNew;
      lm = Math.max(lmTmp, 0.1 * lm);
    }
  };

  const minimizeAugLag = (x0) => {
    const TOL_X = 4 * EPS;
    const TOL_G = 1e-5;
    let x = x0.slice();
    let fMin = augLagFn(x);
    let g = new Array(n);
    augLagGrad(x, g);

    let hessInv = Array.from({ length: n }, (_, i) => (
      Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))
    ));
    let srchDir = g.map(v => -v);

    for (let iter = 1; iter <= ITER_INNER_MAX; iter += 1) {
      const { xNew, fNew } = lineSearchAugLag(x, fMin, g, srchDir);
      fMin = fNew;
      for (let i = 0; i < n; i += 1) {
        srchDir[i] = xNew[i] - x[i];
        x[i] = xNew[i];
      }

      let xtest = 0;
      for (let i = 0; i < n; i += 1) {
        const t = Math.abs(srchDir[i]) / Math.max(Math.abs(x[i]), 1);
        if (t > xtest) xtest = t;
      }
      if (xtest < TOL_X) return { x, fMin, iter };

      const dg = g.slice();
      g = new Array(n);
      augLagGrad(x, g);

      let gtest = 0;
      const den = Math.max(fMin, 1);
      for (let i = 0; i < n; i += 1) {
        const t = Math.abs(g[i]) * Math.max(Math.abs(x[i]), 1) / den;
        if (t > gtest) gtest = t;
      }
      if (gtest < TOL_G) return { x, fMin, iter };

      for (let i = 0; i < n; i += 1) dg[i] = g[i] - dg[i];
      const hdg = new Array(n).fill(0);
      for (let i = 0; i < n; i += 1) {
        for (let j = 0; j < n; j += 1) hdg[i] += hessInv[i][j] * dg[j];
      }

      let fac = 0;
      let fae = 0;
      let sumdg = 0;
      let sumxi = 0;
      for (let i = 0; i < n; i += 1) {
        fac += dg[i] * srchDir[i];
        fae += dg[i] * hdg[i];
        sumdg += dg[i] * dg[i];
        sumxi += srchDir[i] * srchDir[i];
      }

      if (fac > Math.sqrt(EPS * sumdg * sumxi)) {
        fac = 1 / fac;
        const fad = 1 / fae;
        const dgTmp = new Array(n);
        for (let i = 0; i < n; i += 1) dgTmp[i] = fac * srchDir[i] - fad * hdg[i];
        for (let i = 0; i < n; i += 1) {
          for (let j = i; j < n; j += 1) {
            hessInv[i][j] += fac * srchDir[i] * srchDir[j] - fad * hdg[i] * hdg[j] + fae * dgTmp[i] * dgTmp[j];
            hessInv[j][i] = hessInv[i][j];
          }
        }
      }

      for (let i = 0; i < n; i += 1) {
        srchDir[i] = 0;
        for (let j = 0; j < n; j += 1) srchDir[i] -= hessInv[i][j] * g[j];
      }
    }
    return { x, fMin, iter: ITER_INNER_MAX };
  };

  // --- Outer Augmented Lagrangian loop ---
  let x = getX();
  let fvalOld = 1e30;
  let converged = false;
  let outerIterations = 0;
  for (let iterOuter = 1; iterOuter < ITER_OUTER_MAX; iterOuter += 1) {
    outerIterations = iterOuter;
    const result = minimizeAugLag(x);
    x = result.x;
    const innerIterations = result.iter;

    let feas = 0;
    eqIndices.forEach((ci, i) => {
      const f = constraintValue(constraints[ci], x);
      feas = Math.max(feas, Math.abs(f));
      lagMul[i] += 2 * weight * f;
    });
    ineqIndices.forEach((ci, i) => {
      const f = constraintValue(constraints[ci], x);
      if (f > 0) feas = Math.max(feas, f);
      const idx = ne + i;
      const mu = -0.5 * lagMul[idx] / weight;
      if (f < mu) lagMul[idx] = 0;
      else lagMul[idx] += 2 * weight * f;
    });
    for (let i = 0; i < n; i += 1) {
      const f = lower[i] - x[i];
      if (f > 0) feas = Math.max(feas, f);
      const idx = ne + ni + i;
      const mu = -0.5 * lagMul[idx] / weight;
      if (f < mu) lagMul[idx] = 0;
      else lagMul[idx] += 2 * weight * f;
    }
    for (let i = 0; i < n; i += 1) {
      const f = x[i] - upper[i];
      if (f > 0) feas = Math.max(feas, f);
      const idx = ne + ni + n + i;
      const mu = -0.5 * lagMul[idx] / weight;
      if (f < mu) lagMul[idx] = 0;
      else lagMul[idx] += 2 * weight * f;
    }

    const fval = objectiveValue(x);
    options.onOuterIteration?.({ iterOuter, innerIterations, feas, fval, x: x.slice() });
    if (feas < TOL_FEAS) {
      if (Math.abs(fval - fvalOld) < TOL_F) {
        converged = true;
        break;
      }
      fvalOld = fval;
    }

    weight *= WEIGHT_RATIO;
    if (weight > WEIGHT_MAX) weight = WEIGHT_MAX;
  }

  setX(x);
  return { converged, outerIterations, x };
}
