/**
 * rfDiagram.js
 * Groups a fold sequence (buildFoldSequence()'s plain-data output, see
 * rfEngine.js) into the same "one diagram per new line, plus a closing one
 * for whatever comes after the last line" scheme as the original's
 * RefBase::BuildDiagrams()/DgmInfo (see
 * original/ReferenceFinder/source/model/ReferenceFinder.cpp) — this is the
 * geometry/grouping half; rfDiagramView.js turns a group into actual SVG.
 *
 * A DgmInfo-equivalent group is `{ idef, iact }`: `iact` is the index (into
 * `steps`) of this diagram's own "action" — the line it's actually about,
 * or, for the trailing group, the last step of the sequence even if that's
 * only a mark. `idef` is the index of the first step newly introduced in
 * this diagram (one past the previous group's `iact`) — everything from
 * `idef` to `iact` gets narrated as this diagram's caption, and everything
 * before `idef` is already "on the paper" from an earlier diagram.
 */

function isMarkKind(kind) {
  return kind.startsWith('mark');
}

function isOriginalKind(kind) {
  return kind === 'markOriginal' || kind === 'creaseOriginal';
}

// RefLine::IsActionLine()/RefMark::IsActionLine()/RefLine_Original::
// IsActionLine(): only a derived (non-original) line is ever a diagram's
// own action — a mark never moves anything, and an original was never
// folded, it was already there.
function isActionLine(step) {
  return !isMarkKind(step.kind) && !isOriginalKind(step.kind);
}

/**
 * RefBase::BuildDiagrams(): one group per derived line in `steps`, plus a
 * trailing group if the sequence doesn't already end on one (e.g. the
 * search target itself is a mark, not a line).
 */
export function buildDiagramGroups(steps) {
  const groups = [];
  steps.forEach((step, i) => {
    if (isActionLine(step)) groups.push({ idef: 0, iact: i });
  });
  if (groups.length === 0) groups.push({ idef: 0, iact: 0 });
  if (groups[groups.length - 1].iact < steps.length - 1) {
    groups.push({ idef: 0, iact: steps.length - 1 });
  }
  let idef = 0;
  for (const g of groups) {
    g.idef = idef;
    idef = g.iact + 1;
  }
  return groups;
}

// RefLine_Original's two diagonals aren't implied by the paper's own square
// outline (unlike its 4 edges), so they still need to be drawn explicitly
// whenever a diagram uses one.
function isDiagonal(step) {
  return step.kind === 'creaseOriginal' && step.name != null && step.name.includes('diagonal');
}

// Same per-whoMoves field->ref-position map as referenceFinderDescriptions.js
// (duplicated rather than imported, so this file stays DOM/i18n-free — see
// its own header comment): which ref index is rfCreaseP2lP2l's mark1/
// crease1/mark2/crease2 depends on `whoMoves` (a topological push order, not
// a narration order — see rfCrease.js's own prerequisites() comment).
export const O6_REF_POSITION = {
  p1p2: { mark1: 3, crease1: 1, mark2: 2, crease2: 0 },
  l1l2: { mark1: 1, crease1: 3, mark2: 0, crease2: 2 },
  p1l2: { mark1: 2, crease1: 3, mark2: 1, crease2: 0 },
  p2l1: { mark1: 1, crease1: 0, mark2: 2, crease2: 3 }
};

/**
 * Where each of a step's named fields (mark1/mark2/crease1/crease2, per
 * rfCrease.js) sits in `step.refs`, for every crease kind that has more
 * than one — the single piece of whoMoves-position knowledge every
 * fold-arrow/mover-weight computation in this port needs, gathered in one
 * place instead of re-deriving it from prerequisites() in three files.
 * Returns `{}` for a kind with no such ambiguity (O1, markIntersection).
 */
export function getRefPositions(step) {
  switch (step.kind) {
    case 'creaseC2pC2p':
      return { mark1: 0, mark2: 1 };
    case 'creaseP2p':
      return step.whoMoves === 'p1' ? { mark1: 1, mark2: 0 } : { mark1: 0, mark2: 1 };
    case 'creaseL2l':
      return step.whoMoves === 'l1' ? { crease1: 1, crease2: 0 } : { crease1: 0, crease2: 1 };
    case 'creaseL2lC2p':
      return { mark1: 0, crease1: 1 };
    case 'creaseP2lC2p':
      return step.whoMoves === 'p1'
        ? { mark2: 0, crease1: 1, mark1: 2 }
        : { mark2: 0, mark1: 1, crease1: 2 };
    case 'creaseP2lP2l':
      return O6_REF_POSITION[step.whoMoves] ?? {};
    case 'creaseL2lP2l':
      return step.whoMoves === 'p1'
        ? { crease1: 0, mark1: 1, crease2: 2 }
        : { mark1: 0, crease1: 1, crease2: 2 };
    default:
      return {};
  }
}

/**
 * Which of `step.refs` are the "moving" part of a fold, for diagrams to
 * draw with extra visual weight — e.g. RefLine_L2L::PutHowto()'s mover in
 * "Fold {mover} to {target}" (rfCrease.js's prerequisites() always orders
 * these two kinds as [target, mover]). Only covers the kinds where "which
 * one moves" is a simple, well-defined notion; the self-fold axioms (O1, O4,
 * O7) return no movers rather than guessing, since none of their refs is a
 * "this part relocates" element the way O2/O3/O5/O6's are.
 */
function getMoverRefIndices(step) {
  switch (step.kind) {
    case 'creaseP2p':
    case 'creaseL2l':
      return [1];
    case 'creaseP2lC2p':
      return [2];
    case 'creaseP2lP2l': {
      const pos = O6_REF_POSITION[step.whoMoves];
      if (!pos) return [];
      const first = step.whoMoves.includes('p1') ? pos.mark1 : pos.crease1;
      const second = step.whoMoves.includes('p2') ? pos.mark2 : pos.crease2;
      return [first, second];
    }
    default:
      return [];
  }
}

/**
 * Resolve one diagram group into the concrete items to draw: every prior
 * mark/line "on the paper" plus this group's own action, each tagged with
 * a draw style — mirrors RefBase::DrawDiagram()'s per-item REFSTYLE choice
 * (NORMAL for old history, HILITE for anything new this frame or a direct
 * dependency of the action, ACTION for the action itself) — plus `mover`,
 * an extra flag (not part of the original's own style enum, purely this
 * port's own visual emphasis) marking which HILITE item is the one that
 * actually relocates, for a thicker stroke than the stationary one it
 * relates to.
 */
export function resolveDiagramGroup(steps, group) {
  const action = steps[group.iact];
  const immediate = new Set(action.refs ?? []);
  const movers = new Set(getMoverRefIndices(action).map(i => action.refs[i]));
  const items = [];
  for (let i = 0; i <= group.iact; i += 1) {
    const step = steps[i];
    // RefBase::DrawDiagram()'s own condition, exactly: HILITE if this item
    // is both new to this frame (i >= idef) AND actually derived (not an
    // original — those were "always there", never freshly made), OR if the
    // action uses it directly regardless of when it was made; NORMAL
    // otherwise. An original edge only reaches HILITE via the second half
    // (e.g. the two edges an O3 fold brings together) — an untouched one
    // stays NORMAL and is skipped, already implied by the paper square
    // outline (an original diagonal isn't, so it still needs drawing).
    const isUsed = (i >= group.idef && !isOriginalKind(step.kind)) || immediate.has(i);
    if (isOriginalKind(step.kind) && !isDiagonal(step) && !isUsed) continue;
    if (i === group.iact) {
      items.push({ index: i, step, style: 'action' });
    } else if (isUsed) {
      items.push({ index: i, step, style: 'used', mover: movers.has(i) });
    } else {
      items.push({ index: i, step, style: 'history' });
    }
  }
  return { items, action };
}
