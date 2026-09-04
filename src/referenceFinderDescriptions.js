/**
 * referenceFinderDescriptions.js
 * Turns buildFoldSequence()'s plain-data steps (see rfEngine.js) into
 * human-readable instructions, using this app's own i18n strings. Each
 * template is a direct port of the original's own RefXxx::PutHowto() (see
 * original/ReferenceFinder/source/model/ReferenceFinder.cpp) — same clause
 * order, same "making {label}" tail, same choice of which part is named as
 * "moving" per `whoMoves` — so the text reads identically to the real
 * ReferenceFinder's own output for the same fold sequence. The original
 * gates two extra clauses behind user preferences that both default to OFF
 * in its own GUI (RFPrefsDialog's ctor: mClarifyVerbalAmbiguities(false),
 * mAxiomsInVerbalDirections(false)) — the "[0N] " axiom-number prefix, and
 * an "at point (x,y)" / "so the crease goes through {point}" disambiguation
 * clause on O5/O6 — so neither is reproduced here either.
 */

import { t } from './i18n/i18n.js';
import { stepLabel } from './model/referenceFinder/index.js';

// The exact English strings rfEngine.js's makeAllMarksAndLines() hardcodes
// for rank-0/1 originals (the paper's own corners, edges, and diagonals) —
// mapped to this app's i18n keys instead of showing raw English.
const ORIGINAL_NAME_KEYS = {
  'the bottom edge': 'rf.original.bottomEdge',
  'the left edge': 'rf.original.leftEdge',
  'the right edge': 'rf.original.rightEdge',
  'the top edge': 'rf.original.topEdge',
  'the bottom left corner': 'rf.original.bottomLeftCorner',
  'the bottom right corner': 'rf.original.bottomRightCorner',
  'the top left corner': 'rf.original.topLeftCorner',
  'the top right corner': 'rf.original.topRightCorner',
  'the upward diagonal': 'rf.original.upwardDiagonal',
  'the downward diagonal': 'rf.original.downwardDiagonal'
};

function isMarkKind(kind) {
  return kind.startsWith('mark');
}

function isOriginalKind(kind) {
  return kind === 'markOriginal' || kind === 'creaseOriginal';
}

// A short label for one step, for use inside another step's sentence:
// the translated original name ("the top edge"), or "point/line {letter}" —
// matches RefMark::PutName()/RefLine::PutName() (a letter) vs.
// RefMark_Original::PutName()/RefLine_Original::PutName() (the raw name).
function refLabel(step) {
  if (isOriginalKind(step.kind)) return t(ORIGINAL_NAME_KEYS[step.name] ?? step.name);
  const kind = isMarkKind(step.kind) ? 'rf.point' : 'rf.line';
  return t(kind, { letter: stepLabel(step) });
}

// rfCreaseP2lP2l's (O6) prerequisites()/sequencePushSelf() interleave
// mark1/crease1/mark2/crease2 differently per `whoMoves` (see rfCrease.js),
// since that order is a topological push order, not a narration order — so
// each case needs its own map from field name to `step.refs` position to
// recover which ref is which in RefLine_P2L_P2L::PutHowto()'s terms.
const O6_REF_POSITION = {
  p1p2: { mark1: 3, crease1: 1, mark2: 2, crease2: 0 },
  l1l2: { mark1: 1, crease1: 3, mark2: 0, crease2: 2 },
  p1l2: { mark1: 2, crease1: 3, mark2: 1, crease2: 0 },
  p2l1: { mark1: 1, crease1: 0, mark2: 2, crease2: 3 }
};

/**
 * Describe one fold-sequence step. `allSteps` is the full sequence (as
 * returned by buildFoldSequence()/the worker's 'sequence' response) — a
 * step's `refs` are indices into it. Returns `null` for an original
 * (corner/edge/diagonal) step — RefBase::PutHowtoSequence() never lists
 * these as their own line either (PutHowto() returns false for them); they
 * only ever appear by name inside another step's sentence.
 */
export function describeStep(step, allSteps) {
  if (isOriginalKind(step.kind)) return null;

  const label = refLabel(step);
  const ref = (i) => refLabel(allSteps[step.refs[i]]);

  switch (step.kind) {
    // RefMark_Intersection::PutHowto(): "The intersection of A with B is C."
    case 'markIntersection':
      return t('rf.step.intersection', { ref1: ref(0), ref2: ref(1), label });

    // RefLine_C2P_C2P::PutHowto() — O1: "Form a crease connecting A with B,
    // making C." prerequisites() = [mark1, mark2], a fixed order (no
    // whoMoves — this axiom has no "which one moves" choice).
    case 'creaseC2pC2p':
      return t('rf.step.connect', { ref1: ref(0), ref2: ref(1), label });

    // RefLine_P2P::PutHowto() — O2: "Bring A to B, making C." prerequisites()
    // always returns [target, mover] regardless of whoMoves (see rfCrease.js).
    case 'creaseP2p':
      return t('rf.step.bring', { mover: ref(1), target: ref(0), label });

    // RefLine_L2L::PutHowto() — O3: "Fold A to B, making C." Same
    // [target, mover] prerequisites() order as O2, different original verb.
    case 'creaseL2l':
      return t('rf.step.fold', { mover: ref(1), target: ref(0), label });

    // RefLine_L2L_C2P::PutHowto() — O4: "Fold A onto itself, making B
    // through C." prerequisites() = [mark1, crease1] (point, then line).
    case 'creaseL2lC2p':
      return t('rf.step.foldOntoItselfThrough', { line: ref(1), point: ref(0), label });

    // RefLine_P2L_C2P::PutHowto() — O5: "Bring A to B, making C." Same
    // sentence shape as O2; prerequisites() = [throughPoint, ...moving], so
    // ref(1)/ref(2) already land on the right side of "to" for either
    // whoMoves case (see rfCrease.js's own prerequisites() comment).
    case 'creaseP2lC2p':
      return t('rf.step.bring', { mover: ref(2), target: ref(1), label });

    // RefLine_P2L_P2L::PutHowto() — O6: "Bring A to B and C to D, making E."
    // mark1<->crease1 and mark2<->crease2 always pair up (see rfCrease.js's
    // constructor), but within EACH pair, which one is named first ("mover
    // to target") depends independently on whether that pair's own half of
    // `whoMoves` is the point ('p1'/'p2') or the line ('l1'/'l2') — e.g.
    // 'p1l2' names pair 1 point-first but pair 2 line-first.
    case 'creaseP2lP2l': {
      const pos = O6_REF_POSITION[step.whoMoves];
      const pair1 = step.whoMoves.includes('p1') ? [ref(pos.mark1), ref(pos.crease1)] : [ref(pos.crease1), ref(pos.mark1)];
      const pair2 = step.whoMoves.includes('p2') ? [ref(pos.mark2), ref(pos.crease2)] : [ref(pos.crease2), ref(pos.mark2)];
      return t('rf.step.bringAndBring', { a: pair1[0], b: pair1[1], c: pair2[0], d: pair2[1], label });
    }

    // RefLine_L2L_P2L::PutHowto() — O7 (Hatori's axiom): "Bring A onto
    // itself so that B touches C, making D." prerequisites() =
    // whoMoves==='p1' ? [crease1, mark1, crease2] : [mark1, crease1, crease2]
    // — crease2 (the line folded onto itself) is always last.
    case 'creaseL2lP2l': {
      const [a, b] = step.whoMoves === 'p1' ? [ref(1), ref(0)] : [ref(0), ref(1)];
      return t('rf.step.bringOntoItselfTouch', { line: ref(2), a, b, label });
    }

    default:
      return label ? t('rf.step.unknown', { label }) : null;
  }
}

/**
 * Describe every non-original step in a fold sequence, in order — matching
 * RefBase::PutHowtoSequence(), which only emits a line for a step whose
 * PutHowto() returns true (every original returns false).
 */
export function describeFoldSequence(steps) {
  return steps.map(step => describeStep(step, steps)).filter(text => text != null);
}
