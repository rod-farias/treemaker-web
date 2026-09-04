/**
 * rfDiagramView.js
 * Renders one folding-diagram group (see rfDiagram.js) as an inline SVG
 * string, and builds the modal that shows every diagram in a fold sequence
 * side by side — the SPA's replacement for the original ReferenceFinder
 * GUI's own small diagram thumbnails (RFCanvas's diagram strip).
 *
 * Coordinate convention: rf-space is Y-up (paper origin at the bottom
 * left — see rfPoint.js's doc comment); SVG is Y-down, so every point drawn
 * here is flipped (`paperHeight - y`), same as every other rf-space/screen
 * boundary in this app (Tmd5Format.js's flipY(), main.js's flipDisplayY()).
 */

import { rfLine } from './model/referenceFinder/rfLine.js';
import { rfPoint } from './model/referenceFinder/rfPoint.js';
import { rfPaper } from './model/referenceFinder/rfPaper.js';
import { buildDiagramGroups, resolveDiagramGroup, getRefPositions } from './model/referenceFinder/rfDiagram.js';
import { stepLabel } from './model/referenceFinder/index.js';
import { describeStep } from './referenceFinderDescriptions.js';

// Colors/weights follow RFCanvas::SetLineStyle()/SetPointStyle() (see
// original/ReferenceFinder/source/gui/RFCanvas.cpp): NORMAL is plain black
// (LINESTYLE_CREASE/POINTSTYLE_NORMAL), HILITE and ACTION are both red-toned
// (POINTSTYLE_HILITE/ACTION are (127,63,63)/(127,0,0); LINESTYLE_HILITE is
// (255,127,127)) — collapsed here to one red, since the distinction that
// actually matters visually is weight/dash, not two barely-different reds.
// `mover` (this port's own addition, not in the original's style enum) gets
// extra stroke weight to stand out from the stationary item it relates to.
const STYLE_COLOR = {
  history: '#000000',
  used: '#dc2626',
  action: '#dc2626'
};
const STYLE_WIDTH = {
  history: 0.75,
  used: 1.25,
  usedMover: 2.5,
  action: 1.5
};

function svgEscape(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// RefDgmr::CalcArrow(): geometry for a fold-and-unfold arrow between a point
// and where it folds to — a circular arc (not a straight line) whose bulge
// always curves toward the paper's own center, plus the two direction
// vectors DrawValleyArrowhead()/DrawUnfoldArrowhead() need for their
// arrowheads. Kept in rf-space (matching every rfPoint method it calls) so
// the Y-flip into SVG pixels happens once, at the very end, like every other
// shape this file draws — mixing coordinate systems partway through would
// silently flip the arrowheads' handedness.
function calcArrow(fromPt, toPt, paper) {
  const HALF_ANGLE = 30 * (Math.PI / 180);
  const tana = Math.tan(HALF_ANGLE);

  const mp = fromPt.add(toPt).scale(0.5);
  const mu = toPt.subtract(fromPt);
  const mup = mu.rotate90().scale(0.5 / tana);

  // Of the two possible arc centers, pick whichever is farther from the
  // paper's own center — that's the one whose arc bulges TOWARD the center.
  const sqmp = paper.botLeft.add(paper.topRight).scale(0.5);
  const ctr1 = mp.add(mup);
  const ctr2 = mp.subtract(mup);
  const ctr = ctr1.subtract(sqmp).mag() > ctr2.subtract(sqmp).mag() ? ctr1 : ctr2;
  const rad = toPt.subtract(ctr).mag();

  const fp = fromPt.subtract(ctr);
  const fromAngle = Math.atan2(fp.y, fp.x);
  const tp = toPt.subtract(ctr);
  const toAngle = Math.atan2(tp.y, tp.x);

  const TWO_PI = Math.PI * 2;
  let ra = toAngle - fromAngle;
  while (ra < 0) ra += TWO_PI;
  while (ra > TWO_PI) ra -= TWO_PI;
  const ccw = ra < Math.PI;

  const muN = mu.normalize();
  const toDir = ccw ? muN.rotateCCW(HALF_ANGLE) : muN.rotateCCW(-HALF_ANGLE);
  const muNeg = muN.scale(-1);
  const fromDir = ccw ? muNeg.rotateCCW(-HALF_ANGLE) : muNeg.rotateCCW(HALF_ANGLE);

  // The original's own factor (0.15) reads oversized at this diagram's
  // small on-screen scale — halved here, a deliberate departure from
  // CalcArrow() purely for legibility at our thumbnail size.
  let ahSize = Math.min(paper.width, paper.height) * 0.075;
  const ah1 = 0.4 * mu.mag();
  if (ahSize > ah1) ahSize = ah1;

  return { ctr, rad, fromAngle, toAngle, ahSize, fromDir, toDir };
}

// Shrinks (fromAngle, toAngle) symmetrically by the angle that corresponds
// to `gapRf` (an arc-length, in rf-units) at this arc's own radius — a small
// visual gap between an arrowhead's tip and the point/line it refers to,
// rather than touching it exactly. Not part of the original (which draws
// tips flush); purely this port's own legibility tweak, so it's expressed
// as a pixel-equivalent gap the caller derives from its own SVG scale
// rather than a fixed rf-space distance that would grow or shrink with the
// paper's own size.
function insetArcAngles(fromAngle, toAngle, rad, gapRf) {
  let delta = toAngle - fromAngle;
  while (delta <= -Math.PI) delta += 2 * Math.PI;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  const dir = delta >= 0 ? 1 : -1;
  const angleInset = Math.min(gapRf / rad, (Math.abs(delta) / 2) * 0.9);
  return { fromAngle: fromAngle + dir * angleInset, toAngle: toAngle - dir * angleInset };
}

function pointOnCircle(ctr, rad, angle) {
  return new rfPoint(ctr.x + rad * Math.cos(angle), ctr.y + rad * Math.sin(angle));
}

// Sample the arc as a polyline (always the minor, <=180° arc between the two
// angles — the construction above guarantees it's exactly 60°) rather than
// an SVG elliptical-arc command, so there's no sweep-flag sign convention to
// get backwards after the Y-flip into SVG space.
function arcPoints(ctr, rad, fromAngle, toAngle, steps = 16) {
  let delta = toAngle - fromAngle;
  while (delta <= -Math.PI) delta += 2 * Math.PI;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  const points = [];
  for (let i = 0; i <= steps; i += 1) {
    const a = fromAngle + (delta * i) / steps;
    points.push(new rfPoint(ctr.x + rad * Math.cos(a), ctr.y + rad * Math.sin(a)));
  }
  return points;
}

// RefDgmr::DrawValleyArrowhead(): an OPEN chevron (two strokes, no fill) —
// the "normal" arrowhead at the fold's destination.
function valleyArrowheadLines(loc, dir, len) {
  const HALF_ANGLE = 0.523; // original's own literal, ~30 degrees
  return [
    [loc, loc.subtract(dir.rotateCCW(HALF_ANGLE).scale(len))],
    [loc, loc.subtract(dir.rotateCCW(-HALF_ANGLE).scale(len))]
  ];
}

// RefDgmr::DrawUnfoldArrowhead(): a CLOSED, filled 4-point arrowhead (reads
// as a solid triangle at this size) — at the fold's origin, since that
// point can also unfold back from its destination.
function unfoldArrowheadPolygon(loc, dir, len) {
  const HALF_ANGLE = 0.523;
  const ldir = dir.scale(len);
  return [
    loc,
    loc.subtract(ldir.rotateCCW(HALF_ANGLE)),
    loc.subtract(ldir.scale(0.8)),
    loc.subtract(ldir.rotateCCW(-HALF_ANGLE))
  ];
}

function stepPoint(step) {
  return new rfPoint(step.point.x, step.point.y);
}

function stepLine(step) {
  return new rfLine(step.line.d, new rfPoint(step.line.u.x, step.line.u.y));
}

// RefLine_L2L_C2P/RefLine_L2L_P2L's own "fold a line onto itself" arrow: a
// short span centered where the action's own line crosses `refLine`, along
// refLine's tangent, sized to the shorter distance to either of refLine's
// own paper-clipped endpoints (so it never pokes outside the square).
function selfFoldArrow(refLine, actionLine, paper) {
  const clipped = paper.clipLine(refLine);
  const pi = actionLine.intersectLine(refLine);
  if (!clipped || !pi) return null;
  const u1p = refLine.u.rotate90();
  const t1 = Math.abs(clipped.p1.subtract(pi).dot(u1p));
  const t2 = Math.abs(clipped.p2.subtract(pi).dot(u1p));
  const tmin = Math.min(t1, t2);
  return { from: pi.add(u1p.scale(tmin)), to: pi.subtract(u1p.scale(tmin)) };
}

/**
 * RefLine_Xxx::DrawSelf()'s own PASS_ARROWS case, one per axiom — the
 * fold-and-unfold arrow(s) that show what `action` (a crease step) actually
 * moves, ported literally rather than guessed from `mover` (rfDiagram.js's
 * own flag, used only for line/point stroke weight): several axioms here
 * draw an arrow between two points that AREN'T simply "the mover and its
 * fold image" — O1 connects two points but draws its arrow along the
 * perpendicular bisector instead, O3 draws it between synthetic points on
 * the two lines' shared visible overlap, and O4/O7 draw a short span where
 * the new crease crosses a line being folded onto itself. Returns 0-2
 * `{from, to}` pairs (rfPoint, in rf-space) — never more than 2, and 0 for
 * O1/O3/O4 when the paper doesn't actually clip where expected (silently
 * skipped, matching the original's own unchecked ClipLine() calls).
 */
function computeFoldArrows(action, allSteps, actionLine, paper) {
  const pos = getRefPositions(action);
  const ref = (i) => allSteps[action.refs[i]];
  switch (action.kind) {
    case 'creaseC2pC2p': {
      const p1 = stepPoint(ref(pos.mark1));
      const p2 = stepPoint(ref(pos.mark2));
      const mp = p1.add(p2).scale(0.5);
      const lbU = actionLine.u.rotate90();
      const lb = new rfLine(mp.dot(lbU), lbU);
      const clipped = paper.clipLine(lb);
      if (!clipped) return [];
      const t3 = Math.abs(clipped.p1.subtract(mp).dot(actionLine.u));
      const t4 = Math.abs(clipped.p2.subtract(mp).dot(actionLine.u));
      const dp = actionLine.u.scale(Math.min(t3, t4));
      return [{ from: mp.add(dp), to: mp.subtract(dp) }];
    }
    case 'creaseP2p':
      return [{ from: stepPoint(ref(pos.mark1)), to: stepPoint(ref(pos.mark2)) }];
    case 'creaseL2l': {
      const line1 = stepLine(ref(pos.crease1));
      const line2 = stepLine(ref(pos.crease2));
      const c1 = paper.clipLine(line1);
      const c2 = paper.clipLine(line2);
      if (!c1 || !c2) return [];
      const p2af = actionLine.fold(c2.p1);
      const p2bf = actionLine.fold(c2.p2);
      const du1 = line1.u.scale(line1.d);
      const up1 = line1.u.rotate90();
      const tvals = [c1.p1, c1.p2, p2af, p2bf].map(p => p.subtract(du1).dot(up1)).sort((a, b) => a - b);
      const p1c = du1.add(up1.scale(0.5 * (tvals[1] + tvals[2])));
      return [{ from: p1c, to: actionLine.fold(p1c) }];
    }
    case 'creaseL2lC2p': {
      const arrow = selfFoldArrow(stepLine(ref(pos.crease1)), actionLine, paper);
      return arrow ? [arrow] : [];
    }
    case 'creaseP2lC2p': {
      const point = stepPoint(ref(pos.mark1));
      const folded = actionLine.fold(point);
      return [action.whoMoves === 'p1' ? { from: point, to: folded } : { from: folded, to: point }];
    }
    case 'creaseP2lP2l': {
      const p1 = stepPoint(ref(pos.mark1));
      const p1f = actionLine.fold(p1);
      const p2 = stepPoint(ref(pos.mark2));
      const p2f = actionLine.fold(p2);
      return [
        action.whoMoves.includes('p1') ? { from: p1, to: p1f } : { from: p1f, to: p1 },
        action.whoMoves.includes('p2') ? { from: p2, to: p2f } : { from: p2f, to: p2 }
      ];
    }
    case 'creaseL2lP2l': {
      const arrows = [];
      const selfArrow = selfFoldArrow(stepLine(ref(pos.crease2)), actionLine, paper);
      if (selfArrow) arrows.push(selfArrow);
      const point = stepPoint(ref(pos.mark1));
      const folded = actionLine.fold(point);
      arrows.push(action.whoMoves === 'p1' ? { from: point, to: folded } : { from: folded, to: point });
      return arrows;
    }
    default:
      return [];
  }
}

/**
 * Renders the paper square with the raw search target marked on it — just
 * the point (X1,Y1) in 'point' mode, or both (X1,Y1)/(X2,Y2) plus the line
 * through them (clipped to the paper) in 'line' mode. Unlike
 * renderDiagramSVG() below, this doesn't depend on any search having run:
 * it's a live preview of what the Reference Finder section's own X1..Y2
 * inputs currently describe, redrawn on every edit (see main.js's
 * renderRfTargetDiagram()). `p1`/`p2` are already in rfEngine's own space
 * (Y-up, paper origin at the bottom-left — see rfPoint.js), same as
 * everywhere else in this file.
 */
export function renderTargetSVG(mode, p1, p2, paperWidth, paperHeight, size = 160) {
  const paper = new rfPaper(paperWidth, paperHeight);
  const scale = size / Math.max(paperWidth, paperHeight);
  const w = paperWidth * scale;
  const h = paperHeight * scale;
  const pad = 14;
  const W = w + pad * 2;
  const H = h + pad * 2;
  const toSvg = (p) => ({ x: pad + p.x * scale, y: pad + (paperHeight - p.y) * scale });

  const parts = [];
  parts.push(`<rect x="${pad}" y="${pad}" width="${w}" height="${h}" fill="#eaf6fb" stroke="#1f2937" stroke-width="1.5"/>`);

  const rp1 = new rfPoint(p1.x, p1.y);
  const points = [rp1];
  if (mode === 'line') {
    const rp2 = new rfPoint(p2.x, p2.y);
    points.push(rp2);
    const clipped = paper.clipLine(rfLine.throughPoints(rp1, rp2));
    if (clipped) {
      const a = toSvg(clipped.p1);
      const b = toSvg(clipped.p2);
      parts.push(`<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="#dc2626" stroke-width="1.25" stroke-dasharray="6,4"/>`);
    }
  }
  for (const p of points) {
    const s = toSvg(p);
    parts.push(`<circle cx="${s.x.toFixed(1)}" cy="${s.y.toFixed(1)}" r="3" fill="#dc2626"/>`);
  }

  return `<svg viewBox="0 0 ${W.toFixed(1)} ${H.toFixed(1)}" width="${W.toFixed(0)}" height="${H.toFixed(0)}" xmlns="http://www.w3.org/2000/svg">
    ${parts.join('\n    ')}
  </svg>`;
}

/**
 * Renders a result's finished crease pattern — every crease `steps` folds
 * in, all drawn the same way (thin, solid, gray), with no color coding or
 * arrows. This is the small preview on each result's own card (see
 * main.js's rfResultCards) — unlike renderDiagramSVG(), which draws ONE
 * step of the sequence at a time, in color, for the "View diagrams" strip.
 */
export function renderResultSVG(steps, paperWidth, paperHeight, size = 120) {
  const paper = new rfPaper(paperWidth, paperHeight);
  const scale = size / Math.max(paperWidth, paperHeight);
  const w = paperWidth * scale;
  const h = paperHeight * scale;
  const pad = 10;
  const W = w + pad * 2;
  const H = h + pad * 2;
  const toSvg = (p) => ({ x: pad + p.x * scale, y: pad + (paperHeight - p.y) * scale });

  const parts = [];
  parts.push(`<rect x="${pad}" y="${pad}" width="${w}" height="${h}" fill="#eaf6fb" stroke="#1f2937" stroke-width="1.5"/>`);

  for (const step of steps) {
    if (!step.line) continue;
    const line = new rfLine(step.line.d, new rfPoint(step.line.u.x, step.line.u.y));
    const clipped = paper.clipLine(line);
    if (!clipped) continue;
    const a = toSvg(clipped.p1);
    const b = toSvg(clipped.p2);
    parts.push(`<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="#9ca3af" stroke-width="0.75"/>`);
  }

  return `<svg viewBox="0 0 ${W.toFixed(1)} ${H.toFixed(1)}" width="${W.toFixed(0)}" height="${H.toFixed(0)}" xmlns="http://www.w3.org/2000/svg">
    ${parts.join('\n    ')}
  </svg>`;
}

/**
 * Render one diagram group to an SVG string, `size` pixels on its longer
 * side (the paper's own aspect ratio is preserved for the other side).
 */
export function renderDiagramSVG(steps, group, paperWidth, paperHeight, size = 160) {
  const paper = new rfPaper(paperWidth, paperHeight);
  const scale = size / Math.max(paperWidth, paperHeight);
  const w = paperWidth * scale;
  const h = paperHeight * scale;
  const pad = 14;
  const W = w + pad * 2;
  const H = h + pad * 2;

  // rf-space (Y-up, origin bottom-left) -> SVG pixels (Y-down) within the
  // padded viewBox.
  const toSvg = (p) => ({ x: pad + p.x * scale, y: pad + (paperHeight - p.y) * scale });

  const { items, action } = resolveDiagramGroup(steps, group);
  const parts = [];
  parts.push(`<rect x="${pad}" y="${pad}" width="${w}" height="${h}" fill="#eaf6fb" stroke="#1f2937" stroke-width="1.5"/>`);

  // Fold-motion arrows for the action: one or two {from,to} pairs per
  // axiom, computed exactly like RefLine_Xxx::DrawSelf()'s own PASS_ARROWS
  // case (see computeFoldArrows() above) rather than "every used point
  // folds across the new line" — several axioms relate lines, not points,
  // and O6 in particular has TWO independent moving parts, one per pair.
  // Each arrow is a curved (not straight) arc, per CalcArrow()'s own
  // geometry, with an open chevron at the destination (DrawValleyArrowhead)
  // and a closed, filled arrowhead at the origin (DrawUnfoldArrowhead) —
  // origin and destination both get a head since the point can fold there
  // AND unfold back, unlike a plain directional arrow.
  if (action.line) {
    const actionLine = new rfLine(action.line.d, new rfPoint(action.line.u.x, action.line.u.y));
    for (const { from: p, to: pf } of computeFoldArrows(action, steps, actionLine, paper)) {
      if (p.equals(pf)) continue; // point already on the fold line: no motion to show

      const { ctr, rad, fromAngle, toAngle, ahSize, fromDir, toDir } = calcArrow(p, pf, paper);
      // A few screen pixels of gap between each tip and the point/line it
      // touches, rather than flush — converted to an rf-space arc length via
      // this diagram's own scale, so it looks the same size regardless of
      // paper dimensions.
      const gapRf = 4 / scale;
      const inset = insetArcAngles(fromAngle, toAngle, rad, gapRf);
      const pInset = pointOnCircle(ctr, rad, inset.fromAngle);
      const pfInset = pointOnCircle(ctr, rad, inset.toAngle);

      const arcSvg = arcPoints(ctr, rad, inset.fromAngle, inset.toAngle).map(toSvg);
      const arcPath = arcSvg.map((pt, i) => `${i === 0 ? 'M' : 'L'}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(' ');
      parts.push(`<path d="${arcPath}" fill="none" stroke="#16a34a" stroke-width="1.25"/>`);

      for (const [from, to] of valleyArrowheadLines(pfInset, toDir, ahSize)) {
        const a = toSvg(from);
        const b = toSvg(to);
        parts.push(`<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="#16a34a" stroke-width="1.25"/>`);
      }
      // RFCanvas::SetPolyStyle()'s POLYSTYLE_ARROW: a green outline around a
      // near-white fill (242,255,242), not solid green.
      const kite = unfoldArrowheadPolygon(pInset, fromDir, ahSize).map(toSvg);
      const kitePts = kite.map(pt => `${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(' ');
      parts.push(`<polygon points="${kitePts}" fill="#f2fff2" stroke="#16a34a" stroke-width="1"/>`);
    }
  }

  for (const item of items) {
    const { step, style, mover } = item;
    const color = STYLE_COLOR[style];
    const width = style === 'used' && mover ? STYLE_WIDTH.usedMover : STYLE_WIDTH[style];
    if (step.line) {
      const line = new rfLine(step.line.d, new rfPoint(step.line.u.x, step.line.u.y));
      const clipped = paper.clipLine(line);
      if (!clipped) continue;
      const a = toSvg(clipped.p1);
      const b = toSvg(clipped.p2);
      // RefLine::DrawSelf() draws the action line in LINESTYLE_VALLEY —
      // dashed, matching a crease pattern's own convention for an
      // as-yet-unmade fold — while every other style is solid.
      const dash = style === 'action' ? ' stroke-dasharray="6,4"' : '';
      parts.push(`<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="${color}" stroke-width="${width}"${dash}/>`);
      // RefLine::DrawSelf()'s PASS_LABELS case: "normal lines don't get
      // labels" — only a HILITE ('used') or ACTION line does, so a line's
      // letter stops being drawn once it's no longer new/relevant, instead
      // of accumulating and overlapping other labels in later diagrams.
      const label = style !== 'history' ? stepLabel(step) : null;
      if (label) {
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        parts.push(`<text x="${(mid.x + 4).toFixed(1)}" y="${(mid.y - 4).toFixed(1)}" font-size="11" fill="${color}" font-family="sans-serif">${svgEscape(label)}</text>`);
      }
    } else if (step.point) {
      const p = toSvg(new rfPoint(step.point.x, step.point.y));
      const r = style === 'action' ? 3.5 : 2.5;
      parts.push(`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r}" fill="${color}"/>`);
      // Same rule as lines above — RefMark::DrawSelf()'s PASS_LABELS case.
      const label = style !== 'history' ? stepLabel(step) : null;
      if (label) {
        parts.push(`<text x="${(p.x + 5).toFixed(1)}" y="${(p.y - 5).toFixed(1)}" font-size="11" fill="${color}" font-family="sans-serif">${svgEscape(label)}</text>`);
      }
    }
  }

  return `<svg viewBox="0 0 ${W.toFixed(1)} ${H.toFixed(1)}" width="${W.toFixed(0)}" height="${H.toFixed(0)}" xmlns="http://www.w3.org/2000/svg">
    ${parts.join('\n    ')}
  </svg>`;
}

/**
 * Build the full modal content (one card per diagram group) for a fold
 * sequence. Returns a DOM fragment ready to drop into the modal body.
 */
function buildDiagramCards(steps, paperWidth, paperHeight) {
  const frag = document.createDocumentFragment();
  const groups = buildDiagramGroups(steps);
  groups.forEach((group, i) => {
    const card = document.createElement('div');
    card.className = 'rf-diagram-card';
    const svgWrap = document.createElement('div');
    svgWrap.className = 'rf-diagram-svg';
    svgWrap.innerHTML = renderDiagramSVG(steps, group, paperWidth, paperHeight);
    card.appendChild(svgWrap);
    const caption = document.createElement('p');
    caption.className = 'rf-diagram-caption';
    const text = [];
    for (let idx = group.idef; idx <= group.iact; idx += 1) {
      const line = describeStep(steps[idx], steps);
      if (line) text.push(line);
    }
    caption.textContent = text.join(' ') || `${i + 1}`;
    card.appendChild(caption);
    frag.appendChild(card);
  });
  return frag;
}

/**
 * Show a fold sequence's diagrams in the workspace's Reference Finder layer
 * (main.js's setWorkspaceLayer()) rather than a modal. Reachable from a
 * sequence list in ANY Reference Finder section — the shared manual one, or
 * a per-part panel's own "already saved" box — so this also opens the
 * sidebar's "Reference Finder" entry itself if it isn't already, which is
 * what actually switches the Inspector and the workspace layer over (see
 * main.js's `rfManualDetails` 'toggle' listener): dispatching a real
 * 'toggle' event runs that listener without this module importing main.js
 * back.
 */
export function showFoldDiagrams(steps, paperWidth, paperHeight) {
  const strip = document.getElementById('rfDiagramStrip');
  const placeholder = document.getElementById('rfDiagramPlaceholder');
  strip.innerHTML = '';
  strip.appendChild(buildDiagramCards(steps, paperWidth, paperHeight));
  strip.style.display = 'flex';
  placeholder.style.display = 'none';

  const details = document.getElementById('rfManualDetails');
  if (!details.open) {
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
  }
}

/** Clear any diagrams left over from a previous search's "View diagrams". */
export function resetFoldDiagrams() {
  const strip = document.getElementById('rfDiagramStrip');
  strip.innerHTML = '';
  strip.style.display = 'none';
  document.getElementById('rfDiagramPlaceholder').style.display = 'block';
}
