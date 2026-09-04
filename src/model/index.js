/**
 * model/index.js
 * Main export file for TreeMaker model classes
 */

// Geometry classes
export { tmPoint, PI, TWO_PI, RADIAN, DEGREES, minVal, maxVal } from './tmPoint.js';
export { tmNode } from './tmNode.js';
export { tmEdge } from './tmEdge.js';
export { tmPath } from './tmPath.js';
export { tmPoly } from './tmPoly.js';
export { tmVertex } from './tmVertex.js';
export { tmCrease, CreaseKind, CreaseFold } from './tmCrease.js';
export { tmFacet, FacetColor } from './tmFacet.js';

// Main tree container
export { tmTree, CPStatus } from './tmTree.js';

// Conditions/Constraints (13 total)
export { 
  tmCondition,
  // Node conditions
  ConditionNodeFixed,
  ConditionNodeOnCorner,
  ConditionNodeOnEdge,
  ConditionNodeSymmetric,
  ConditionNodesCollinear,
  ConditionNodesPaired,
  // Edge conditions
  ConditionEdgeLengthFixed,
  ConditionEdgesSameStrain,
  // Path conditions
  ConditionPathActive,
  ConditionPathAngleFixed,
  ConditionPathAngleQuant,
  // Combo conditions
  ConditionNodeCombo,
  ConditionPathCombo
} from './conditions/index.js';

// Optimizers
export {
  Optimizer,
  EdgeOptimizer,
  ScaleOptimizer,
  StrainOptimizer,
  clamp,
  EPSILON,
  isNearlyEqual,
  normalizeAngle,
  quantizeAngle,
  reflectPoint,
  projectPointToLine,
  pointIsCollinear
} from './optimizers/index.js';

// Solvers
export {
  Matrix,
  StubFinder,
  StubInfo,
  constraintResiduals,
  angleDifference,
  pathAngle,
  constraintJacobians,
  buildStrainPathConstraint,
  ALM,
  NewtonRaphson,
  NLCO
} from './solvers/index.js';

// Original TreeMaker fixture import
export { parseTM4 } from './io/TM4Parser.js';
