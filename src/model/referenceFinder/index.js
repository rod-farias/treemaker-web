/**
 * Public entry point for the ReferenceFinder port, mirroring
 * src/model/index.js's role for TreeMaker. See REFERENCEFINDER_PLAN.md.
 */

export { rfPoint, RF_EPS, subtractFromScalar, divideIntoScalar, midPoint } from './rfPoint.js';
export { rfLine, intersection } from './rfLine.js';
export { rfRect, rfPaper, getBoundingBox } from './rfPaper.js';
export { rfMark, rfMarkOriginal, rfMarkIntersection, calcMarkRank, resetMarkIndexCounter } from './rfMark.js';
export {
  rfCrease, rfCreaseOriginal, rfCreaseC2pC2p, rfCreaseP2p, rfCreaseL2l, rfCreaseL2lC2p,
  rfCreaseP2lC2p, rfCreaseP2lP2l, rfCreaseL2lP2l, calcCreaseRank, solveP2LP2LCubic,
  resetCreaseIndexCounter
} from './rfCrease.js';
export { rfEngine, buildFoldSequence, stepLabel, MARK_LABELS, CREASE_LABELS } from './rfEngine.js';
export { serializeEngine, restoreDatabase } from './rfDatabaseCache.js';
