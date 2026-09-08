/**
 * CanvasRenderer.js
 * 2D Canvas renderer for TreeMaker models
 */

import { Renderer } from './Renderer.js';
import {
  ConditionNodeCombo,
  ConditionEdgeLengthFixed,
  ConditionEdgesSameStrain,
  ConditionNodesPaired,
  ConditionNodesCollinear,
  ConditionPathActive,
  ConditionPathAngleFixed,
  ConditionPathAngleQuant
} from '../model/conditions/index.js';

// tmwxDesignCanvas.cpp constants (CONDITION_FLAG_LENGTH/CONDITION_LAT_OFFSET,
// in screen pixels) and the per-type flag angles (degrees) used to offset a
// single-part condition's icon away from the node/edge/path it marks, so
// several conditions on the same part don't stack on top of each other.
const CONDITION_FLAG_LENGTH_PX = 10;
const CONDITION_LAT_OFFSET_PX = 5;
const CONDITION_NODE_COMBO_ANGLE = 80;
const CONDITION_EDGE_LENGTH_FIXED_ANGLE = -100;
const CONDITION_PATH_ANGLE = -100;

function offsetByAngle(p, angleDeg, dist) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: p.x + dist * Math.cos(rad), y: p.y - dist * Math.sin(rad) };
}

// tmwxDesignCanvas::CalcLocOffset(p1, p2, up): a point past the (asymmetric)
// midpoint of p1-p2, offset perpendicular to the segment — used for every
// 2-part condition's icon (and, in the original, for path conditions' icon
// too, though those still connect back with a single line to the path's own
// midpoint rather than one line per node — see _conditionAnchors below).
function offsetBetween(p1, p2, up, dist, center) {
  const ctr = center ?? { x: 0.55 * p1.x + 0.45 * p2.x, y: 0.55 * p1.y + 0.45 * p2.y };
  let offX = -(p2.y - p1.y);
  let offY = p2.x - p1.x;
  if ((up && offY < 0) || (!up && offY > 0)) {
    offX = -offX;
    offY = -offY;
  }
  const mag = Math.hypot(offX, offY) || 1;
  return { x: ctr.x + (dist * offX) / mag, y: ctr.y + (dist * offY) / mag };
}

export class CanvasRenderer extends Renderer {
  constructor(canvas) {
    super(canvas);
    this.ctx = canvas.getContext('2d');
    
    // Set up canvas
    this.canvas.style.cursor = 'default';
  }

  /**
   * Render the entire scene
   */
  render() {
    if (!this.tree) return;

    // Fill the whole canvas with the "outside the paper" gray, then paint
    // the paper itself white on top — matches BACKGROUND_COLOR in the
    // original tmwxDesignCanvas.cpp.
    this.ctx.fillStyle = '#dfdfdf';
    this.ctx.fillRect(0, 0, this.width, this.height);

    const paperTopLeft = this.worldToScreen(0, 0);
    const paperBottomRight = this.worldToScreen(this.tree.getPaperWidth(), this.tree.getPaperHeight());
    this.ctx.fillStyle = '#ffffff';
    this.ctx.fillRect(
      paperTopLeft.x,
      paperTopLeft.y,
      paperBottomRight.x - paperTopLeft.x,
      paperBottomRight.y - paperTopLeft.y
    );

    // Save context state
    this.ctx.save();

    this._drawSymmetryLines();

    // Draw in order. Always called (not gated by showPolys itself) since
    // the selected poly stays highlighted regardless of view — see
    // _drawPolys(). Drawn before paths/edges/etc. so its fill sits
    // underneath them instead of painting over the lines already there.
    this._drawPolys();

    if (this.showPaths) {
      this._drawPaths();
    }

    // Always called (not gated by showFacets itself), same reasoning as
    // _drawPolys()/_drawVertices() above: the selected facet stays
    // highlighted regardless of view — no current view preset turns
    // showFacets on, so this call used to be skipped entirely and a
    // facet picked via Select Part by Index never showed any highlight.
    this._drawFacets();

    // Rivers view (weldedRivers) draws the crease/fold skeleton AFTER the
    // welded river shapes below instead of here, so the fold lines stay
    // visible on top of the (now opaque, gap-free) river fill rather than
    // being painted over by it — Blueprint keeps this earlier spot, since
    // its own per-slice rainbow is what a reader is meant to inspect first.
    if (this.showCreases && !this.weldedRivers) {
      this._drawCreases();
    }

    if (this.showEdges) {
      this._drawEdges();
    }

    // Blueprint View's own addition: the Robert Lang "river" strips between
    // two branch nodes that don't touch in the circle/river packing — see
    // _drawRivers() for how that region is found with no new geometry.
    this._drawRivers();

    // Always called (not gated by showNodes itself) — the leaf reference
    // circles it also draws are controlled by their own showNodeCircles
    // flag, independent of whether the node markers themselves are shown
    // (Blueprint View wants circles without node dots).
    this._drawNodes();

    // Always called (not gated by showVertices itself), same reasoning as
    // _drawPolys() above: the selected vertex stays highlighted regardless
    // of view (Design/Creases select vertices too — see
    // getSelectedVertexInfo() in NodeEditor.js — but never showed the
    // highlight before, since this call used to be skipped entirely
    // whenever showVertices was off, which is every view except Plan).
    this._drawVertices();

    if (this.showLabels) {
      this._drawLabels();
    }

    if (this.showConditions) {
      this._drawConditions();
    }

    // Keep the paper outline visible above all generated geometry.
    this._drawPaperBoundary();

    // Blueprint View's welded-corridor slices — drawn last so they sit
    // above every other layer, paper outline included. Extensions first,
    // so each slice's own crisp cap edge stays on top of the seam where
    // the two meet.
    this._drawRiverExtensions();
    this._drawWeldedCorridors();

    // See the showCreases skip above: Rivers view draws the fold lines
    // here instead, once the welded rivers are already down, so they read
    // on top of the river fill instead of underneath it.
    if (this.showCreases && this.weldedRivers) {
      this._drawCreases();
    }

    // Restore context state
    this.ctx.restore();
  }

  /**
   * Draws the actual symmetry line — a point (tree.getSymLoc()) plus a
   * direction (tree.getSymDir(), from tree.getSymAngle()), the same two
   * values every symmetry condition solves against (see
   * ConditionNodeSymmetric.calcFeasibility()) — clipped to the paper
   * rectangle. Previously this only special-cased the "book"/"diagonal"
   * presets by their symmetryType label (a fixed vertical line, or always
   * the anti-diagonal corner-to-corner regardless of angle) and ignored
   * symLoc/symAngle entirely, so hand-editing the X/Y/Angle fields to a
   * custom line never changed what was drawn.
   * @private
   */
  _drawSymmetryLines() {
    if (!this.tree.hasSymmetryLine()) return;
    const width = this.tree.getPaperWidth();
    const height = this.tree.getPaperHeight();
    const p = this.tree.getSymLoc();
    const d = this.tree.getSymDir();

    // Ray-vs-box slab test, extended to a full line (t unbounded in both
    // directions): intersect with the x=0/x=width and y=0/y=height slabs,
    // keeping the overlap of both t-ranges.
    let tMin = -Infinity;
    let tMax = Infinity;
    if (Math.abs(d.x) > 1e-12) {
      const t1 = (0 - p.x) / d.x;
      const t2 = (width - p.x) / d.x;
      tMin = Math.max(tMin, Math.min(t1, t2));
      tMax = Math.min(tMax, Math.max(t1, t2));
    } else if (p.x < 0 || p.x > width) {
      return;
    }
    if (Math.abs(d.y) > 1e-12) {
      const t1 = (0 - p.y) / d.y;
      const t2 = (height - p.y) / d.y;
      tMin = Math.max(tMin, Math.min(t1, t2));
      tMax = Math.min(tMax, Math.max(t1, t2));
    } else if (p.y < 0 || p.y > height) {
      return;
    }
    if (tMin > tMax) return;

    const from = this.worldToScreen(p.x + tMin * d.x, p.y + tMin * d.y);
    const to = this.worldToScreen(p.x + tMax * d.x, p.y + tMax * d.y);
    this.ctx.strokeStyle = '#d5dbe3';
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    this.ctx.moveTo(from.x, from.y);
    this.ctx.lineTo(to.x, to.y);
    this.ctx.stroke();
  }

  /**
   * Draw the leaf-to-leaf path network: a straight dashed line between every
   * pair of leaf nodes, colored by whether the paper distance still respects
   * the tree-topology minimum (same feasibility check used by "Escalar
   * todo" / ScaleOptimizer). This is the visual counterpart of the original
   * TreeMaker's "show leaf paths" view setting.
   * @private
   */
  /**
   * Equivalent to tmwxDesignCanvas's tmPath lines. Two kinds of path get
   * drawn, both filtered through isVisiblePath():
   *
   * - Leaf-to-leaf paths (tree.getPaths()) — the ones that "close the
   *   triangle" between three leaf nodes as they're added/moved
   *   (isBorderPath/isPolygonPath, kept live by
   *   tmTree._refreshDerivedClassification(), not just at Build): yellow
   *   while merely feasible (PATH_VALID_COLOR), green once actually taut
   *   (PATH_ACTIVE_COLOR, e.g. after Maximize Scale/Scale Selection pins
   *   them), red if infeasible.
   * - Molecule-construction paths (tree.getInternalPaths(), only populated
   *   after Action->Build Crease Pattern — see tmTree._collectInternalPaths())
   *   — the cross-path network within an inset polygon. These are never
   *   leaf paths, so GetBasePartColor<tmPath>() in the original always
   *   paints them PATH_INTERNAL_COLOR regardless of feasibility/activity.
   *
   * Not every path of either kind — only the ones that are border/polygon
   * paths, active, or (for visibility, leaf paths only) infeasible,
   * matching tmwxDesignCanvas::IsVisible<tmPath>() under the original's
   * default "Design" view.
   * @private
   */
  _drawPaths() {
    const leafPaths = this.tree.getPaths();
    const allPaths = [...leafPaths, ...this.tree.getInternalPaths()];
    for (const path of allPaths) {
      if (!this.isVisiblePath(path)) continue;
      const feasible = path.isFeasiblePath();

      const nodeA = path.getFirstNode();
      const nodeB = path.getLastNode();
      if (!nodeA || !nodeB) continue;

      this.ctx.strokeStyle = !path.isLeafPath
        ? this.colors.pathInternal
        : !feasible ? this.colors.pathInfeasible
        : path.isActivePath() ? this.colors.pathActive : this.colors.pathValid;

      if (this.selectedObjects.includes(path)) {
        this.ctx.strokeStyle = '#f0f';
        this.ctx.lineWidth = 3;
      } else {
        this.ctx.lineWidth = 1;
      }

      const a = this.worldToScreen(nodeA.getLocX(), nodeA.getLocY());
      const b = this.worldToScreen(nodeB.getLocX(), nodeB.getLocY());
      this.ctx.beginPath();
      this.ctx.moveTo(a.x, a.y);
      this.ctx.lineTo(b.x, b.y);
      this.ctx.stroke();

      // "Show all labels": the path's own 1-based index — the same
      // numbering Select Part by Index uses (leaf-to-leaf paths only,
      // matching that list; the molecule-construction internal paths
      // above have no index of their own to show).
      if (this.showAllPartLabels) {
        const pathIndex = leafPaths.indexOf(path);
        if (pathIndex !== -1) {
          this.ctx.fillStyle = this.colors.label;
          this.ctx.font = '10px monospace';
          this.ctx.textAlign = 'center';
          this.ctx.fillText(`P${pathIndex + 1}`, (a.x + b.x) / 2, (a.y + b.y) / 2 - 5);
        }
      }
    }
  }

  /**
   * Draw paper boundary (canvas edges)
   * @private
   */
  _drawPaperBoundary() {
    if (!this.tree) return;

    // Get screen coordinates of paper corners
    const topLeft = this.worldToScreen(0, 0);
    const bottomRight = this.worldToScreen(this.tree.getPaperWidth(), this.tree.getPaperHeight());

    // Draw boundary rectangle
    this.ctx.strokeStyle = '#1f2937';
    this.ctx.lineWidth = 1;
    this.ctx.strokeRect(
      topLeft.x,
      topLeft.y,
      bottomRight.x - topLeft.x,
      bottomRight.y - topLeft.y
    );
  }

  /**
   * Fills every poly (at every inset-recursion depth — tree.getAllPolys(),
   * not just the top-level ring) with POLY_COLOR when showPolys is on
   * (mShowPolyFills, Design View only — no outline: the original's Design
   * View also has mShowPolyLines off, and the paths/edges/creases drawn on
   * top already mark the subdivisions). Regardless of showPolys, the
   * selected poly — which can be any of those nested polys, not just a
   * top-level one, since a click keeps the smallest/most specific match
   * (see Renderer.getObjectAtPoint()) — is highlighted so clicking one to
   * select it has visible feedback, same as every other selectable part.
   * @private
   */
  _drawPolys() {
    for (const poly of this.tree.getAllPolys()) {
      const vertices = poly.getVertices();
      if (vertices.length < 3) continue;
      const selected = this.selectedObjects.includes(poly);
      if (!selected && !this.showPolys) continue;

      this.ctx.beginPath();
      const first = this.worldToScreen(vertices[0].getLocX(), vertices[0].getLocY());
      this.ctx.moveTo(first.x, first.y);
      for (let i = 1; i < vertices.length; i += 1) {
        const coord = this.worldToScreen(vertices[i].getLocX(), vertices[i].getLocY());
        this.ctx.lineTo(coord.x, coord.y);
      }
      this.ctx.closePath();

      if (selected) {
        this.ctx.fillStyle = 'rgba(255, 0, 255, 0.12)';
        this.ctx.fill();
        this.ctx.strokeStyle = '#f0f';
        this.ctx.lineWidth = 3;
        this.ctx.stroke();
      } else {
        this.ctx.fillStyle = this.colors.polygon;
        this.ctx.fill();
      }
    }
  }

  /**
   * Draw facets (filled faces of the crease pattern)
   * @private
   */
  _drawFacets() {
    this.ctx.strokeStyle = this.colors.polygonBorder;
    this.ctx.lineWidth = 1;

    for (const facet of this.tree.getFacets()) {
      const vertices = facet.getVertices();
      if (vertices.length < 3) continue;
      if (vertices.some(vertex => (
        !Number.isFinite(vertex.getLocX()) || !Number.isFinite(vertex.getLocY())
      ))) continue;

      const selected = this.selectedObjects.includes(facet);
      // Blueprint View selects every corridor facet (see NodeEditor.
      // selectInternalCorridorFacets()) purely so the Inspector can report
      // "N facets selected" — _drawWeldedCorridors() already draws each one
      // as part of its own slice/sector, so the plain magenta selection
      // outline this loop would otherwise give it underneath is only ever
      // a redundant leftover, visible through any gap the slice/sector
      // doesn't happen to cover (e.g. a "<" slice's own sector, which
      // deliberately doesn't reach all the way to its cut-off tip).
      if (selected && this.showWeldedCorridors) continue;
      if (!selected && !this.showFacets) continue;

      this.ctx.beginPath();

      const screenCoord = this.worldToScreen(
        vertices[0].getLocX(),
        vertices[0].getLocY()
      );
      this.ctx.moveTo(screenCoord.x, screenCoord.y);

      for (let i = 1; i < vertices.length; i++) {
        const coord = this.worldToScreen(
          vertices[i].getLocX(),
          vertices[i].getLocY()
        );
        this.ctx.lineTo(coord.x, coord.y);
      }

      this.ctx.closePath();
      this.ctx.fillStyle = facet.isColorUpFacet() ? this.colors.polygon : '#ffffff';
      this.ctx.fill();

      if (selected) {
        this.ctx.strokeStyle = '#f0f';
        this.ctx.lineWidth = 3;
        this.ctx.stroke();
        this.ctx.strokeStyle = this.colors.polygonBorder;
        this.ctx.lineWidth = 1;
      } else {
        this.ctx.stroke();
      }
    }
  }

  /**
   * Equivalent to nothing in the original — a Blueprint View-only touch-up.
   * A gusset crease only ever occurs as one segment of a zigzag bounding a
   * river or a similar gusset region; where that zigzag bends at a minor
   * vertex (a vertex with none of the significance of a real fold, just an
   * artifact of how the crease pattern's polygons are built — see
   * tmVertex.isMajorVertex()), Blueprint draws the whole zigzag as one
   * smooth quadratic-Bezier curve through the major endpoints, using each
   * minor vertex in between as a control point, instead of a sharp corner.
   * Design/Creases/Plan keep the literal straight creases, since those
   * views are read as the actual fold pattern, not a schematic.
   * @returns {{skip: Set<object>, chains: Array<object[]>}}
   * @private
   */
  _collectGussetChains() {
    const gussetCreases = this.tree.getCreases().filter(c => c.isGussetCrease());
    // A "pass-through" vertex is just an artifact of how the crease
    // pattern's polygons were built, not an actual endpoint of the gusset
    // region — safe to smooth over as long as it only ever joins exactly 2
    // gusset creases (anything else, a branch or a real major vertex, is a
    // chain boundary).
    const isPassThrough = (vertex) => (
      !vertex.isMajorVertex() && vertex.creases.filter(c => c.isGussetCrease()).length === 2
    );

    const visited = new Set();
    const skip = new Set();
    const chains = [];

    for (const startCrease of gussetCreases) {
      if (visited.has(startCrease)) continue;
      const [a, b] = startCrease.getVertices();
      if (!a || !b) continue;

      // Start walking from whichever endpoint is NOT a pass-through vertex,
      // so the chain is walked exactly once, end to end. If both endpoints
      // happen to be pass-through (a closed loop, not expected in practice)
      // this crease is left for its neighbors to pick up instead.
      const startVertex = !isPassThrough(a) ? a : (!isPassThrough(b) ? b : null);
      if (!startVertex) continue;

      const points = [startVertex];
      const walkedCreases = [];
      let vertex = startVertex;
      let crease = startCrease;
      for (;;) {
        visited.add(crease);
        walkedCreases.push(crease);
        const next = crease.getOtherVertex(vertex);
        points.push(next);
        if (!isPassThrough(next)) break;
        vertex = next;
        crease = next.creases.find(c => c.isGussetCrease() && c !== crease);
      }

      // Only the simplest case — exactly one pass-through vertex between
      // the two major endpoints — maps to a single quadratic Bezier with an
      // unambiguous control point. A longer run of pass-through vertices
      // would need a curve-fitting choice nothing in this project's
      // TreeMaker-derived math actually specifies, so it's left as plain
      // straight creases rather than guessed at.
      if (points.length === 3) {
        chains.push(points);
        for (const c of walkedCreases) skip.add(c);
      }
    }

    return { skip, chains };
  }

  _drawGussetChains(chains) {
    // Rivers view (weldedRivers) wants its fold lines reading as part of
    // the same visual "reference" layer as the circle/river outlines —
    // same color as those (this.colors.referenceLine) — rather than
    // Blueprint's own plain black skeleton.
    this.ctx.strokeStyle = this.weldedRivers ? this.colors.referenceLine : this.colors.creaseAxial;
    this.ctx.lineWidth = this.creaseWidth;
    for (const [major1, minor, major2] of chains) {
      const p1 = this.worldToScreen(major1.getLocX(), major1.getLocY());
      const control = this.worldToScreen(minor.getLocX(), minor.getLocY());
      const p2 = this.worldToScreen(major2.getLocX(), major2.getLocY());
      this.ctx.beginPath();
      this.ctx.moveTo(p1.x, p1.y);
      this.ctx.quadraticCurveTo(control.x, control.y, p2.x, p2.y);
      this.ctx.stroke();
    }
  }

  /**
   * Draw creases
   * @private
   */
  _drawCreases() {
    this.ctx.lineWidth = this.creaseWidth;

    const { skip: smoothedGussets, chains: gussetChains } = this.monochromeCreases
      ? this._collectGussetChains()
      : { skip: null, chains: [] };
    if (gussetChains.length > 0) this._drawGussetChains(gussetChains);

    const creases = this.tree.getCreases();
    for (let creaseIndex = 0; creaseIndex < creases.length; creaseIndex += 1) {
      const crease = creases[creaseIndex];
      const v1 = crease.getVertex(0);
      const v2 = crease.getVertex(1);

      if (!v1 || !v2) continue;
      if (!this.showMinorCreases && crease.isMinorCrease()) continue;
      if (smoothedGussets?.has(crease)) continue;

      this.ctx.lineWidth = this.creaseWidth;
      let dashed = false;

      if (this.showCreaseFolds) {
        // MVF (Mountain/Valley/Flat) coloring: conveys fold direction.
        // Equivalent to tmwxDesignCanvas::GetBasePartColor<tmCrease>() with
        // mShowCreaseFolds true — only the valley pen is dashed
        // (DC_VALLEY_DASHES); mountain, border and flat are solid.
        if (crease.isCreaseBorder()) {
          this.ctx.strokeStyle = this.colors.creaseBorder;
        } else if (crease.isCreaseValley()) {
          this.ctx.strokeStyle = this.colors.creaseValley;
          dashed = true;
        } else if (crease.isCreaseMountain()) {
          this.ctx.strokeStyle = this.colors.creaseMountain;
        } else {
          this.ctx.strokeStyle = this.colors.crease;
        }
      } else if (this.monochromeCreases) {
        // Same reasoning as _drawGussetChains() above.
        this.ctx.strokeStyle = this.weldedRivers ? this.colors.referenceLine : this.colors.creaseAxial;
      } else {
        // AGRH (Axial/Gusset/Ridge/Hinge) coloring: conveys each crease's
        // structural role instead of its fold direction — always solid.
        // Equivalent to the mShowCreaseFolds-false branch of the same
        // original function.
        if (crease.isAxialCrease()) {
          this.ctx.strokeStyle = this.colors.creaseAxial;
        } else if (crease.isGussetCrease()) {
          this.ctx.strokeStyle = this.colors.creaseGusset;
        } else if (crease.isRidgeCrease()) {
          this.ctx.strokeStyle = this.colors.creaseRidge;
        } else if (crease.isUnfoldedHingeCrease()) {
          this.ctx.strokeStyle = this.colors.creaseUnfoldedHinge;
        } else if (crease.isFoldedHingeCrease()) {
          this.ctx.strokeStyle = this.colors.creaseFoldedHinge;
        } else if (crease.isPseudohingeCrease()) {
          this.ctx.strokeStyle = this.colors.creasePseudohinge;
        } else {
          this.ctx.strokeStyle = this.colors.crease;
        }
      }

      if (this.selectedObjects.includes(crease)) {
        this.ctx.strokeStyle = '#f0f';
        this.ctx.lineWidth = 3;
      }

      const coord1 = this.worldToScreen(v1.getLocX(), v1.getLocY());
      const coord2 = this.worldToScreen(v2.getLocX(), v2.getLocY());

      if (dashed) {
        // _drawDashedLine() strokes the dashed path itself — a plain solid
        // stroke afterwards would just paint over the gaps and hide it.
        // Pattern matches VALLEY_DASHES in tmwxDesignCanvas.cpp (5px dash,
        // 3px gap — denser than an even 5/5 split).
        this._drawDashedLine(v1, v2, [5, 3]);
      } else {
        this.ctx.beginPath();
        this.ctx.moveTo(coord1.x, coord1.y);
        this.ctx.lineTo(coord2.x, coord2.y);
        this.ctx.stroke();
      }

      // "Show all labels": the crease's own 1-based index — the same
      // numbering Select Part by Index uses — same look as _drawEdges()'s
      // own index label. Plan/Creases View (where "Show all labels" is
      // most useful, since neither shows vertex labels by default the way
      // Design View's node numbers do) previously only labeled vertices,
      // leaving creases themselves unidentifiable without this.
      if (this.showAllPartLabels) {
        const midX = (coord1.x + coord2.x) / 2;
        const midY = (coord1.y + coord2.y) / 2;
        this.ctx.fillStyle = this.colors.label;
        this.ctx.font = '10px monospace';
        this.ctx.textAlign = 'center';
        this.ctx.fillText(`C${creaseIndex + 1}`, midX, midY + 10);
      }
    }
  }

  /**
   * Draw dashed line
   * @private
   */
  _drawDashedLine(v1, v2, pattern = [5, 3]) {
    const coord1 = this.worldToScreen(v1.getLocX(), v1.getLocY());
    const coord2 = this.worldToScreen(v2.getLocX(), v2.getLocY());

    const dx = coord2.x - coord1.x;
    const dy = coord2.y - coord1.y;
    const length = Math.sqrt(dx * dx + dy * dy);
    const steps = length / 2;

    this.ctx.beginPath();
    let distance = 0;
    let patternIndex = 0;

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = coord1.x + dx * t;
      const y = coord1.y + dy * t;

      if (patternIndex % 2 === 0) {
        if (distance === 0) {
          this.ctx.moveTo(x, y);
        } else {
          this.ctx.lineTo(x, y);
        }
      } else {
        this.ctx.moveTo(x, y);
      }

      distance += 2;
      if (distance >= pattern[patternIndex % pattern.length]) {
        distance = 0;
        patternIndex++;
      }
    }

    this.ctx.stroke();
  }

  /**
   * Draw edges
   * @private
   */
  _drawEdges() {
    const edges = this.tree.getEdges();
    for (let edgeIndex = 0; edgeIndex < edges.length; edgeIndex += 1) {
      const edge = edges[edgeIndex];
      const n1 = edge.getNode(0);
      const n2 = edge.getNode(1);

      if (!n1 || !n2) continue;

      const coord1 = this.worldToScreen(n1.getLocX(), n1.getLocY());
      const coord2 = this.worldToScreen(n2.getLocX(), n2.getLocY());

      // Color based on state
      if (edge.isPinnedEdge) {
        this.ctx.strokeStyle = this.colors.edgePinned;
      } else {
        this.ctx.strokeStyle = this.colors.edge;
      }

      if (this.selectedObjects.includes(edge)) {
        this.ctx.strokeStyle = '#f0f';
        this.ctx.lineWidth = this.edgeWidth + 2;
      } else {
        this.ctx.lineWidth = this.edgeWidth;
      }

      this.ctx.beginPath();
      this.ctx.moveTo(coord1.x, coord1.y);
      this.ctx.lineTo(coord2.x, coord2.y);
      this.ctx.stroke();

      // Draw length label if requested. Matches the original's
      // DrawPart<Text, tmEdge>: once an edge carries strain (set by
      // "Scale Selection"/the strain solver, or edited by hand), its label
      // grows a signed percentage suffix — e.g. "1.0000+25%" — so the
      // amount of stretch is visible directly on the canvas, not just in
      // the inspector.
      if (this.showLabels) {
        const midX = (coord1.x + coord2.x) / 2;
        const midY = (coord1.y + coord2.y) / 2;
        this.ctx.fillStyle = this.colors.label;
        this.ctx.font = '10px monospace';
        this.ctx.textAlign = 'center';
        const strain = edge.getStrain();
        const text = strain === 0
          ? edge.getLength().toFixed(4)
          : `${edge.getLength().toFixed(4)}${strain >= 0 ? '+' : ''}${(strain * 100).toFixed(0)}%`;
        this.ctx.fillText(text, midX, midY - 5);
      }

      // "Show all labels": the edge's own 1-based index — the same
      // numbering Select Part by Index uses — offset below the midpoint
      // so it doesn't collide with the length label above.
      if (this.showAllPartLabels) {
        const midX = (coord1.x + coord2.x) / 2;
        const midY = (coord1.y + coord2.y) / 2;
        this.ctx.fillStyle = this.colors.label;
        this.ctx.font = '10px monospace';
        this.ctx.textAlign = 'center';
        this.ctx.fillText(`E${edgeIndex + 1}`, midX, midY + 10);
      }
    }
  }

  /**
   * Draw Robert Lang's tree-theory "rivers": the paper strips of fixed
   * width (the tree-edge length) connecting two branch nodes that don't
   * touch directly in the circle/river packing. A river edge is simply a
   * tmEdge whose two nodes are both non-leaf; there's no new geometry to
   * compute for its 2D shape in the crease pattern, because that shape is
   * exactly the union of the facets tmPoly.calcFacetCorridorEdges() already
   * assigns to that edge (facet.getCorridorEdge() === edge) while building
   * the crease pattern — the same grouping the original exposes as "Select
   * Corridor from Edge" for the folded 3D form, reused here on the flat
   * pattern instead.
   * @private
   */
  _drawRivers() {
    if (!this.riverFillColor) return;
    // Blueprint View's own welded-corridor slices (_drawWeldedCorridors())
    // cover exactly this same set of facets — every internal edge's own
    // corridor — with their own coloring, drawn later. Without this guard,
    // this method's plain wash fill + _drawRiverOutline()'s gray outline
    // sit underneath them as a redundant leftover, visible through any gap
    // a slice/sector doesn't happen to cover (e.g. a "<" slice's own
    // sector, which deliberately doesn't reach all the way to its cut-off
    // tip).
    if (this.showWeldedCorridors) return;

    const riverEdges = this.tree.getEdges().filter(edge => {
      const n1 = edge.getNode(0);
      const n2 = edge.getNode(1);
      return n1 && n2 && !n1.isLeafNode && !n2.isLeafNode;
    });
    if (riverEdges.length === 0) return;

    const allFacets = this.tree.getFacets();
    this.ctx.fillStyle = this.riverFillColor;
    for (const riverEdge of riverEdges) {
      const facets = allFacets.filter(f => f.getCorridorEdge() === riverEdge);

      for (const facet of facets) {
        const vertices = facet.getVertices();
        if (vertices.length < 3) continue;

        this.ctx.beginPath();
        const first = this.worldToScreen(vertices[0].getLocX(), vertices[0].getLocY());
        this.ctx.moveTo(first.x, first.y);
        for (let i = 1; i < vertices.length; i += 1) {
          const coord = this.worldToScreen(vertices[i].getLocX(), vertices[i].getLocY());
          this.ctx.lineTo(coord.x, coord.y);
        }
        this.ctx.closePath();
        this.ctx.fill();
      }

      this._drawRiverOutline(facets);
    }
  }

  /**
   * Outline just the outer boundary of one river's facet group, in the same
   * style as the leaf reference circles, so both read as the same "packing"
   * layer. An edge shared between two of the river's own facets (e.g. the
   * ridge crease along its spine) is interior, not boundary, and is already
   * drawn as a regular crease — so it's skipped here by counting how many
   * of the group's facets each vertex-pair edge borders: exactly one means
   * boundary, two means interior.
   * @private
   */
  _drawRiverOutline(facets) {
    const segments = [];
    for (const facet of facets) {
      const vertices = facet.getVertices();
      for (let i = 0; i < vertices.length; i += 1) {
        const a = vertices[i];
        const b = vertices[(i + 1) % vertices.length];
        const existing = segments.find(s => (s.a === a && s.b === b) || (s.a === b && s.b === a));
        if (existing) existing.count += 1;
        else segments.push({ a, b, count: 1 });
      }
    }

    this.ctx.strokeStyle = this.colors.referenceLine;
    this.ctx.lineWidth = 1;
    for (const { a, b, count } of segments) {
      if (count > 1) continue;
      // Skip segments whose crease is already drawn as a visible major
      // crease (or smoothed into a gusset curve) — this outline exists for
      // the boundary segments Blueprint hides otherwise (minor creases,
      // filtered out by showMinorCreases), not to double up on lines
      // that are already there.
      const crease = a.creases.find(c => c.getOtherVertex(a) === b);
      const alreadyVisible = crease && (this.showMinorCreases || crease.isMajorCrease());
      if (alreadyVisible) continue;
      const p1 = this.worldToScreen(a.getLocX(), a.getLocY());
      const p2 = this.worldToScreen(b.getLocX(), b.getLocY());
      this.ctx.beginPath();
      this.ctx.moveTo(p1.x, p1.y);
      this.ctx.lineTo(p2.x, p2.y);
      this.ctx.stroke();
    }
  }

  // A palette of visually distinct fills, cycled across whatever list of
  // slices/pieces needs telling apart — _drawWeldedCorridors() below is the
  // only current caller, but nothing here ties it to that one case.
  static SEGMENT_COLOR_PALETTE = [
    '#f87171', '#fb923c', '#facc15', '#a3e635', '#4ade80', '#34d399',
    '#2dd4bf', '#22d3ee', '#60a5fa', '#818cf8', '#a78bfa', '#e879f9', '#fb7185'
  ];

  /**
   * Blueprint View's own addition, with no original equivalent: extends
   * each internal river past however far its own crease-pattern facets
   * happen to reach (tree.getRiverExtensions() — the true Robert Lang
   * river runs the tree edge's whole length, out to the paper's own edge,
   * regardless of how much of that the crease pattern actually needed).
   * Styled the same as _drawRivers()'s own wash + outline — riverFillColor
   * fill, referenceLine stroke — since this is exactly the same river,
   * merely continuing past where real facet geometry stops.
   * @private
   */
  _drawRiverExtensions() {
    if (!this.showWeldedCorridors || !this.riverFillColor) return;
    const extensions = this.tree.getRiverExtensions();
    if (extensions.length === 0) return;

    this.ctx.fillStyle = this.riverFillColor;
    this.ctx.strokeStyle = this.colors.referenceLine;
    this.ctx.lineWidth = 1;
    for (const { rings, ringCuts } of extensions) {
      rings.forEach((ring, ringIdx) => {
        if (ring.length < 3) return;
        this.ctx.beginPath();
        const first = this.worldToScreen(ring[0].x, ring[0].y);
        this.ctx.moveTo(first.x, first.y);
        for (let j = 1; j < ring.length; j += 1) {
          const coord = this.worldToScreen(ring[j].x, ring[j].y);
          this.ctx.lineTo(coord.x, coord.y);
        }
        this.ctx.closePath();
        this.ctx.fill();
        // Rivers view (weldedRivers) welds this extension onto the main
        // corridor slice it continues — see _drawWeldedCorridors()'s own
        // comment — by never stroking the cap edge the two share
        // (ringCuts, from getRiverExtensions() marking it the same way
        // getWeldedCorridors() marks a cut/seam). Blueprint keeps its own
        // plain full-outline stroke, unchanged.
        if (this.weldedRivers) {
          this._strokeNaturalRingEdges(ring, [], (ringCuts && ringCuts[ringIdx]) || []);
        } else {
          this.ctx.stroke();
        }
      });
    }
  }

  /**
   * Rivers view's own addition (see VIEW_PRESETS.rivers / `weldedRivers`):
   * strokes only `ring`'s NATURAL edges — the ones getWeldedCorridors()/
   * getRiverExtensions() didn't mark as a `cut` (the seam where this piece
   * touches the next piece of the same river) — leaving every seam
   * unstroked so adjacent same-color pieces read as one welded river
   * instead of a set of visibly separate tiles. `cuts[i]` mirrors the
   * model's own convention: true when the edge ARRIVING at ring point i
   * (from i-1) is a seam. `bends` (as in _drawRingWithBends()) rounds a
   * natural corner into an arc; a bend is always between two natural edges
   * (see getWeldedCorridors()'s own comment on _findBendVertices()), so it
   * never needs to split across a stroke-run boundary.
   * @private
   */
  _strokeNaturalRingEdges(ring, bends, cuts) {
    const n = ring.length;
    if (n < 2) return;
    const screen = ring.map(p => this.worldToScreen(p.x, p.y));
    const bendByIndex = new Map(bends.map(b => [b.index, b.radius]));
    const arcTo = (i, next) => {
      const afterNext = (next + 1) % n;
      const center = screen[next];
      const radius = bendByIndex.get(next) * this.zoom;
      const angleFrom = Math.atan2(screen[i].y - center.y, screen[i].x - center.x);
      const angleTo = Math.atan2(screen[afterNext].y - center.y, screen[afterNext].x - center.x);
      let delta = angleTo - angleFrom;
      while (delta <= -Math.PI) delta += 2 * Math.PI;
      while (delta > Math.PI) delta -= 2 * Math.PI;
      this.ctx.arc(center.x, center.y, radius, angleFrom, angleTo, delta < 0);
      return afterNext;
    };
    if (!cuts.some(Boolean)) {
      // No seam anywhere on this ring (an untouched slice, or an extension
      // whose own cap got clipped away) — stroke it as one closed loop
      // exactly like the plain (non-weldedRivers) path, rather than an
      // open one that would otherwise leave a stray gap at the seam this
      // ring doesn't actually have.
      this.ctx.beginPath();
      this.ctx.moveTo(screen[0].x, screen[0].y);
      let i = 0;
      do {
        const next = (i + 1) % n;
        i = bendByIndex.has(next) ? arcTo(i, next) : (this.ctx.lineTo(screen[next].x, screen[next].y), next);
      } while (i !== 0);
      this.ctx.closePath();
      this.ctx.stroke();
      return;
    }
    const offset = cuts.findIndex(Boolean);
    let i = offset;
    let started = false;
    do {
      const next = (i + 1) % n;
      if (cuts[next]) {
        if (started) { this.ctx.stroke(); started = false; }
        i = next;
        continue;
      }
      if (!started) {
        this.ctx.beginPath();
        this.ctx.moveTo(screen[i].x, screen[i].y);
        started = true;
      }
      i = bendByIndex.has(next) ? arcTo(i, next) : (this.ctx.lineTo(screen[next].x, screen[next].y), next);
    } while (i !== offset);
    if (started) this.ctx.stroke();
  }

  /**
   * Blueprint View's own addition, with no original equivalent: outlines
   * each internal facet-corridor (tree.getWeldedCorridors() — grouped by
   * tmPoly.calcFacetCorridorEdges(), same as _drawRivers()'s river strips)
   * as one welded polygon PER slice, cut wherever the corridor crosses a
   * poly/subPoly boundary of the design (see getWeldedCorridors()'s own
   * comment for why that cut needs no clipping library). Each slice gets
   * its own color from SEGMENT_COLOR_PALETTE so the cuts read clearly,
   * distinct from the plain facet-selection highlight _drawFacets() already
   * gives each individual triangle. Drawn last (see render()) so it sits
   * above every other layer.
   * @private
   */
  _drawWeldedCorridors() {
    if (!this.showWeldedCorridors) return;
    const slices = this.tree.getWeldedCorridors();
    if (slices.length === 0) return;

    const palette = CanvasRenderer.SEGMENT_COLOR_PALETTE;
    this.ctx.lineWidth = 2.5;
    slices.forEach((slice, i) => {
      // Rivers view (weldedRivers — see VIEW_PRESETS.rivers) drops
      // Blueprint's own per-slice rainbow: every slice/sector/extension
      // belonging to the same internal edge is the same river, so they all
      // get riverFillColor instead of their own SEGMENT_COLOR_PALETTE
      // entry, and only each one's NATURAL edges get stroked (see
      // _strokeNaturalRingEdges()) — never the cut edges where two pieces
      // of that river touch — so the whole thing reads as one welded
      // shape instead of Blueprint's clearly-separate colored tiles.
      const color = this.weldedRivers ? this.riverFillColor : palette[i % palette.length];
      this.ctx.fillStyle = color;
      this.ctx.strokeStyle = this.weldedRivers ? this.colors.referenceLine : '#1f2937';
      // A "<"-shaped slice (two cut edges — see getWeldedCorridors()'s own
      // comment) is drawn as its annular sector instead of its own literal
      // outline — see _drawCutSector(). Anything else (0 or 1 cut edge, no
      // `crossing`) draws its plain welded outline instead — rounded at any
      // of its own vertices getWeldedCorridors() flagged as a "bend" (see
      // its _findBendVertices()), the same "<" wedge shape as a sector but
      // formed by two of the ring's OWN edges meeting each other directly,
      // not by two separate cuts whose carrier lines meet outside it.
      if (slice.crossing) {
        this._drawCutSector(slice.crossing, slice.cutSegments, color);
        return;
      }
      slice.rings.forEach((ring, ringIdx) => {
        if (ring.length < 3) return;
        this._drawRingWithBends(ring, slice.bends || []);
        this.ctx.fill();
        if (this.weldedRivers) {
          const cuts = (slice.ringCuts && slice.ringCuts[ringIdx]) || [];
          this._strokeNaturalRingEdges(ring, slice.bends || [], cuts);
        } else {
          this.ctx.stroke();
        }
      });
    });
  }

  /**
   * Blueprint View's own addition: traces `ring` (world-space points) as
   * the current canvas path, replacing the corner at each of `bends`
   * (getWeldedCorridors()' _findBendVertices() — `{ index, radius }` pairs)
   * with an arc of that radius centered on the vertex itself, instead of
   * the plain straight-line corner _drawWeldedCorridors() would otherwise
   * draw there. Starts tracing from a non-bend vertex when the ring has
   * one (simpler than special-casing the path's own start/close points
   * landing exactly on a bend). Caller fills/strokes the path afterward.
   * @private
   */
  _drawRingWithBends(ring, bends) {
    const n = ring.length;
    const bendByIndex = new Map(bends.map(b => [b.index, b.radius]));
    let offset = 0;
    for (let i = 0; i < n; i += 1) {
      if (!bendByIndex.has(i)) { offset = i; break; }
    }
    const screen = ring.map(p => this.worldToScreen(p.x, p.y));

    this.ctx.beginPath();
    this.ctx.moveTo(screen[offset].x, screen[offset].y);
    let i = offset;
    for (let steps = 0; steps < n; steps += 1) {
      const next = (i + 1) % n;
      if (bendByIndex.has(next)) {
        const afterNext = (next + 1) % n;
        const center = screen[next];
        const radius = bendByIndex.get(next) * this.zoom;
        const angleFrom = Math.atan2(screen[i].y - center.y, screen[i].x - center.x);
        const angleTo = Math.atan2(screen[afterNext].y - center.y, screen[afterNext].x - center.x);
        let delta = angleTo - angleFrom;
        while (delta <= -Math.PI) delta += 2 * Math.PI;
        while (delta > Math.PI) delta -= 2 * Math.PI;
        this.ctx.arc(center.x, center.y, radius, angleFrom, angleTo, delta < 0);
        i = afterNext;
      } else {
        this.ctx.lineTo(screen[next].x, screen[next].y);
        i = next;
      }
      if (i === offset) break;
    }
    this.ctx.closePath();
  }

  /**
   * Blueprint View's own addition: renders a "<"-shaped corridor slice —
   * one cut off on both ends, its two cut sides (tree.getWeldedCorridors()'s
   * own comment explains why they're always the same length) not parallel
   * — as the annular sector their two carrier lines outline, IN PLACE OF
   * that slice's own literal (straight-edged) outline. The two STRAIGHT
   * sides of that sector are each cut side exactly as given — every point
   * along it, not just its own two outer ends, since a cutting poly with
   * more than one edge crossing the ring can put a real corner partway
   * along one side — the same points the neighboring slice on the other
   * side of that cut shares, so drawing them unchanged (rather than
   * re-deriving the side from an angle and a radius) is what keeps this
   * sector's own edge sitting exactly on top of that neighbor's — only the
   * two "ends" connecting the sides (where the original outline zigzagged
   * through its own natural, unweldable-into-one-straight-line corridor
   * edges) are replaced with arcs, centered on `crossing` (where the two
   * cut sides' own carrier lines — through each side's two OUTER ends —
   * meet, extended if need be — often outside the slice itself, sometimes
   * off the paper entirely) and radius the average of the two cut sides'
   * own matching outer ends (their near ends for the inner arc, their far
   * ends for the outer — "near"/"far" meaning relative to `crossing`; a
   * real molecule's own construction keeps these two distances close
   * enough for that average to read as one clean radius, not two visibly
   * different ones).
   * @private
   */
  _drawCutSector(crossing, cutSegments, color) {
    const dist = (p) => Math.hypot(p.x - crossing.x, p.y - crossing.y);
    // Orient each side's own point list to run near-to-far, so it can be
    // traced in that order regardless of which end getWeldedCorridors()
    // happened to list first.
    const orient = (side) => (dist(side[0]) <= dist(side[side.length - 1]) ? side : [...side].reverse());
    const side1 = orient(cutSegments[0]);
    const side2 = orient(cutSegments[1]);
    const near1 = side1[0];
    const far1 = side1[side1.length - 1];
    const near2 = side2[0];
    const far2 = side2[side2.length - 1];

    const innerRadius = ((dist(near1) + dist(near2)) / 2) * this.zoom;
    const outerRadius = ((dist(far1) + dist(far2)) / 2) * this.zoom;
    const angle1 = Math.atan2(far1.y - crossing.y, far1.x - crossing.x);
    const angle2 = Math.atan2(far2.y - crossing.y, far2.x - crossing.x);
    // Sweep whichever way covers the smaller (non-reflex) angle between the
    // two lines — the real corner angle this sector traces, never the
    // "long way around" complement of it.
    let delta = angle2 - angle1;
    while (delta <= -Math.PI) delta += 2 * Math.PI;
    while (delta > Math.PI) delta -= 2 * Math.PI;
    const anticlockwise = delta < 0;

    const target = this.worldToScreen(crossing.x, crossing.y);
    const toScreen = (p) => this.worldToScreen(p.x, p.y);

    this.ctx.beginPath();
    const start1 = toScreen(side1[0]);
    this.ctx.moveTo(start1.x, start1.y);
    for (let i = 1; i < side1.length; i += 1) {
      const pt = toScreen(side1[i]);
      this.ctx.lineTo(pt.x, pt.y); // straight side 1 — cut side 1, unchanged, corner(s) and all
    }
    this.ctx.arc(target.x, target.y, outerRadius, angle1, angle2, anticlockwise); // outer arc
    for (let i = side2.length - 1; i >= 0; i -= 1) {
      const pt = toScreen(side2[i]);
      this.ctx.lineTo(pt.x, pt.y); // snaps to cut side 2's own far end exactly, then traces it back to its near end
    }
    this.ctx.arc(target.x, target.y, innerRadius, angle2, angle1, !anticlockwise); // inner arc
    this.ctx.closePath(); // snaps back to near1 exactly
    this.ctx.fillStyle = color;
    this.ctx.lineWidth = 1.5;
    this.ctx.fill();
    if (this.weldedRivers) {
      // Rivers view welds this sector to its neighbors across side1/side2
      // (both cut edges — the seams where the adjacent slices on either
      // side of this "<" sit) by never stroking them, only the two arcs —
      // always natural (see getWeldedCorridors()'s own comment: they
      // replace the ring's own zigzag between its two cuts, not a cut
      // itself), each traced as its own open path so the straight sides
      // in between stay bare.
      this.ctx.strokeStyle = this.colors.referenceLine;
      this.ctx.beginPath();
      this.ctx.arc(target.x, target.y, outerRadius, angle1, angle2, anticlockwise);
      this.ctx.stroke();
      this.ctx.beginPath();
      this.ctx.arc(target.x, target.y, innerRadius, angle2, angle1, !anticlockwise);
      this.ctx.stroke();
    } else {
      this.ctx.strokeStyle = '#1f2937';
      this.ctx.stroke();
    }
  }

  /**
   * Draw nodes
   * @private
   */
  _drawNodes() {
    for (const node of this.tree.getSelectableNodes()) {
      const coord = this.worldToScreen(node.getLocX(), node.getLocY());
      const radius = this.nodeRadius;

      if (this.showNodeCircles && node.isLeafNode) {
        const edge = this.tree.getEdges().find(item => (
          item.getNode(0) === node || item.getNode(1) === node
        ));
        const treeScale = this.tree.getScale?.() || 1;
        const leafRadius = edge
          ? Math.abs(edge.getStrainedLength()) * treeScale * this.zoom
          : 0;
        if (leafRadius > 0) {
          // Reference circles can extend past the paper; only the portion
          // that actually lies on the paper is physically meaningful.
          const paperTopLeft = this.worldToScreen(0, 0);
          const paperBottomRight = this.worldToScreen(this.tree.getPaperWidth(), this.tree.getPaperHeight());
          this.ctx.save();
          this.ctx.beginPath();
          this.ctx.rect(
            paperTopLeft.x,
            paperTopLeft.y,
            paperBottomRight.x - paperTopLeft.x,
            paperBottomRight.y - paperTopLeft.y
          );
          this.ctx.clip();
          this.ctx.beginPath();
          this.ctx.arc(coord.x, coord.y, leafRadius, 0, Math.PI * 2);
          if (this.nodeCircleFillColor) {
            this.ctx.fillStyle = this.nodeCircleFillColor;
            this.ctx.fill();
          }
          this.ctx.strokeStyle = this.colors.referenceLine;
          this.ctx.lineWidth = this.selectedObjects.includes(node) ? 2 : 1;
          this.ctx.stroke();
          this.ctx.restore();
        }
      }

      if (!this.showNodes) continue;

      this.ctx.fillStyle = this.colors.node;

      // Highlight if hovered
      if (this.hoveredObject?.object === node) {
        this.ctx.strokeStyle = '#ff0';
        this.ctx.lineWidth = 3;
      } else if (this.selectedObjects.includes(node)) {
        this.ctx.strokeStyle = '#f0f';
        this.ctx.lineWidth = 2;
      } else {
        this.ctx.strokeStyle = this.colors.node;
        this.ctx.lineWidth = 1;
      }

      // Draw circle
      this.ctx.beginPath();
      this.ctx.arc(coord.x, coord.y, radius, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.stroke();

    }
  }

  /**
   * Draw vertices. Equivalent to tmwxDesignCanvas::IsVisible<tmVertex>():
   * every currently-implemented view that shows vertices at all (only Plan)
   * wants majors only (mShowMajorVertices/mShowMinorVertices), plus
   * whichever vertex is selected regardless of that.
   * @private
   */
  _drawVertices() {
    for (const vertex of this.tree.getVertices()) {
      const selected = this.selectedObjects.includes(vertex);
      // "Show all labels" wants an ID next to every vertex (minor ones
      // included — they otherwise never get a dot or any identifier at
      // all), so it bypasses the normal majors-only/showVertices gate.
      if (!selected && !this.showAllPartLabels && (!this.showVertices || !vertex.isMajorVertex())) continue;

      const coord = this.worldToScreen(vertex.getLocX(), vertex.getLocY());

      this.ctx.fillStyle = this.colors.vertex;
      this.ctx.strokeStyle = selected ? '#f0f' : this.colors.vertex;
      this.ctx.lineWidth = selected ? 2 : 1;

      if (this.showVertexDots || selected) {
        this.ctx.beginPath();
        this.ctx.arc(coord.x, coord.y, selected ? 4 : 2, 0, Math.PI * 2);
        this.ctx.fill();
        this.ctx.stroke();
      }

      // Equivalent to mShowVertexCoords: Plan View's distinguishing feature
      // over Creases View (help/menus.htm, View->Plan View). Y is flipped
      // for display, same as the Inspector's node/vertex Position fields
      // (see main.js's flipDisplayY()): this app's tree space has Y
      // increasing downward, but the original TreeMaker's own coordinate
      // readout — and so a user's expectation here — has Y increasing
      // upward from the paper's bottom edge.
      if (this.showVertexCoords) {
        this.ctx.font = '10px monospace';
        this.ctx.textAlign = 'left';
        this.ctx.fillStyle = '#000000';
        this.ctx.fillText(
          `(${vertex.getLocX().toFixed(4)}, ${(this.tree.getPaperHeight() - vertex.getLocY()).toFixed(4)})`,
          coord.x + 5, coord.y - 5
        );
      }

      // "Show all labels": the vertex's own readable ID — its owning
      // node/path's label when it has one, otherwise "V<buildIndex>" (see
      // tmVertex.getDisplayLabel()), offset below-right so it doesn't
      // collide with the coords text above.
      if (this.showAllPartLabels) {
        this.ctx.font = '10px monospace';
        this.ctx.textAlign = 'left';
        this.ctx.fillStyle = this.colors.label;
        this.ctx.fillText(vertex.getDisplayLabel(), coord.x + 5, coord.y + 12);
      }
    }
  }

  /**
   * Draw labels
   * @private
   */
  _drawLabels() {
    this.ctx.fillStyle = this.colors.label;
    this.ctx.font = '11px sans-serif';
    this.ctx.textAlign = 'left';

    // Node labels
    for (const node of this.tree.getSelectableNodes()) {
      if (!node.label) continue;
      // A node's label defaults to a plain sequential number and works as
      // its on-screen ID unless someone actually renamed it — see
      // tmTree._nextNodeLabel(). Blueprint View only wants real names.
      if (this.showOnlyCustomLabels && /^\d+$/.test(node.label)) continue;

      const coord = this.worldToScreen(node.getLocX(), node.getLocY());
      this.ctx.fillText(node.label, coord.x + 12, coord.y + 4);
    }
  }

  /**
   * Equivalent to tmwxDesignCanvas::DrawPart<Text/Lines, tmCondition>(): a
   * small dot ("pin") near the part(s) a condition affects, connected to
   * each of them by a thin line. A condition on a SINGLE part (ConditionNode
   * Combo, ConditionEdgeLengthFixed, the path conditions) draws exactly one
   * connector line, which reads as a pin planted at an angled offset from
   * that part. A condition spanning MULTIPLE parts (ConditionNodesPaired: 2
   * nodes, ConditionNodesCollinear: 3 nodes, ConditionEdgesSameStrain: 2
   * edges) draws one line to EACH of them, fanning out from a shared dot
   * between the parts — which is what reads visually as "a line" (or a
   * star of lines) rather than a pin. Color follows the original's
   * CONDITION_COLOR/CONDITION_INFEASIBLE_COLOR (violet/salmon).
   * @private
   */
  _drawConditions() {
    const conditions = this.tree.getConditions();
    for (let conditionIndex = 0; conditionIndex < conditions.length; conditionIndex += 1) {
      const condition = conditions[conditionIndex];
      const anchors = this._conditionAnchors(condition);
      if (!anchors) continue;

      const color = condition.isFeasible ? this.colors.condition : this.colors.conditionInfeasible;
      const iconScreen = this.worldToScreen(anchors.icon.x, anchors.icon.y);
      const targetsScreen = anchors.targets.map(p => this.worldToScreen(p.x, p.y));

      this.ctx.strokeStyle = color;
      this.ctx.lineWidth = 1;
      for (const targetScreen of targetsScreen) {
        this.ctx.beginPath();
        this.ctx.moveTo(iconScreen.x, iconScreen.y);
        this.ctx.lineTo(targetScreen.x, targetScreen.y);
        this.ctx.stroke();
      }

      this.ctx.fillStyle = color;
      this.ctx.beginPath();
      this.ctx.arc(iconScreen.x, iconScreen.y, 2.5, 0, Math.PI * 2);
      this.ctx.fill();

      // "Show all labels": the condition's own 1-based index — the same
      // numbering tree.getConditions() (and the Conditions panel list)
      // uses.
      if (this.showAllPartLabels) {
        this.ctx.font = '10px monospace';
        this.ctx.textAlign = 'left';
        this.ctx.fillText(`#${conditionIndex + 1}`, iconScreen.x + 5, iconScreen.y - 5);
      }
    }
  }

  /**
   * Where to draw a condition's icon ("icon", in world units) and which
   * part location(s) to connect it to with a line ("targets") — see
   * _drawConditions() above. Returns null for a condition type this app
   * doesn't create from the UI (the legacy v4 node classes, still only
   * readable from old .tmd5 files) or one with a missing/stale part
   * reference.
   * @private
   */
  _conditionAnchors(condition) {
    const worldDist = (px) => px / Math.max(this.zoom, 1e-6);
    const nodeLoc = (n) => ({ x: n.getLocX(), y: n.getLocY() });
    const edgeLoc = (e) => {
      const [a, b] = [e.getNode(0), e.getNode(1)];
      if (!a || !b) return null;
      // Same 0.55/0.45 split as tmwxDesignCanvas::CalcLoc<tmEdge>().
      return { x: 0.55 * a.getLocX() + 0.45 * b.getLocX(), y: 0.55 * a.getLocY() + 0.45 * b.getLocY() };
    };
    const pathLoc = (p) => {
      const first = p.getFirstNode();
      const last = p.getLastNode();
      if (!first || !last) return null;
      return { x: (first.getLocX() + last.getLocX()) / 2, y: (first.getLocY() + last.getLocY()) / 2 };
    };

    if (condition instanceof ConditionNodeCombo) {
      const node = condition.getNode();
      if (!node) return null;
      const p = nodeLoc(node);
      return { icon: offsetByAngle(p, CONDITION_NODE_COMBO_ANGLE, worldDist(CONDITION_FLAG_LENGTH_PX)), targets: [p] };
    }

    if (condition instanceof ConditionEdgeLengthFixed) {
      const edge = condition.getEdge();
      const p = edge && edgeLoc(edge);
      if (!p) return null;
      return { icon: offsetByAngle(p, CONDITION_EDGE_LENGTH_FIXED_ANGLE, worldDist(CONDITION_FLAG_LENGTH_PX)), targets: [p] };
    }

    if (condition instanceof ConditionEdgesSameStrain) {
      const p1 = condition.getEdge1() && edgeLoc(condition.getEdge1());
      const p2 = condition.getEdge2() && edgeLoc(condition.getEdge2());
      if (!p1 || !p2) return null;
      return { icon: offsetBetween(p1, p2, true, worldDist(CONDITION_LAT_OFFSET_PX)), targets: [p1, p2] };
    }

    if (condition instanceof ConditionNodesPaired) {
      const n1 = condition.getNode1();
      const n2 = condition.getNode2();
      if (!n1 || !n2) return null;
      const p1 = nodeLoc(n1);
      const p2 = nodeLoc(n2);
      return { icon: offsetBetween(p1, p2, true, worldDist(CONDITION_LAT_OFFSET_PX)), targets: [p1, p2] };
    }

    if (condition instanceof ConditionNodesCollinear) {
      const n1 = condition.getNode1();
      const n2 = condition.getNode2();
      const n3 = condition.getNode3();
      if (!n1 || !n2 || !n3) return null;
      const p1 = nodeLoc(n1);
      const p2 = nodeLoc(n2);
      const p3 = nodeLoc(n3);
      const centroid = { x: (p1.x + p2.x + p3.x) / 3, y: (p1.y + p2.y + p3.y) / 3 };
      // Nudged off the centroid perpendicular to the first two points, same
      // spirit as CalcLocOffset(p1,p2,p3)'s "perpendicular to the longest
      // axis" without needing the incenter/longest-axis computation — this
      // is a cosmetic anti-overlap detail, not a feasibility-affecting one.
      return { icon: offsetBetween(p1, p2, true, worldDist(CONDITION_LAT_OFFSET_PX) / 2, centroid), targets: [p1, p2, p3] };
    }

    if (condition instanceof ConditionPathActive || condition instanceof ConditionPathAngleFixed || condition instanceof ConditionPathAngleQuant) {
      const path = condition.getPath();
      const p = path && pathLoc(path);
      if (!p) return null;
      return { icon: offsetByAngle(p, CONDITION_PATH_ANGLE, worldDist(CONDITION_FLAG_LENGTH_PX)), targets: [p] };
    }

    return null;
  }

  /**
   * Text describing the currently hovered object (see Renderer.
   * hoveredObject, set by onMouseMove()), or '' if nothing hovered / the
   * hovered type has no describable info. Used by main.js to fill the
   * persistent "pointed object" label below the canvas (see
   * .canvas-status-bar in index.html) — this used to be drawn directly
   * onto the canvas at the bottom-left corner instead, but that only ever
   * showed while the mouse was actively over the canvas issuing
   * mousemove events, and disappeared into the same repaint as everything
   * else; a real DOM element can stay in a fixed spot and be cleared
   * explicitly on mouseleave.
   */
  getHoveredInfoText() {
    if (!this.hoveredObject) return '';
    const obj = this.hoveredObject.object;
    const type = this.hoveredObject.type;

    if (type === 'node') {
      return `Node: ${obj.label} at (${obj.getLocX().toFixed(2)}, ${obj.getLocY().toFixed(2)})`;
    } else if (type === 'edge') {
      return `Edge: ${obj.getLength().toFixed(3)} units`;
    } else if (type === 'path') {
      const first = obj.getFirstNode()?.label ?? '?';
      const last = obj.getLastNode()?.label ?? '?';
      return `Path: ${first} - ${last} (${obj.getActualLength().toFixed(3)} units)`;
    } else if (type === 'vertex') {
      return `Vertex at (${obj.getLocX().toFixed(2)}, ${obj.getLocY().toFixed(2)}), depth ${obj.getDepth?.() ?? 'N/A'}`;
    } else if (type === 'crease') {
      const kind = obj.isCreaseMountain() ? 'mountain' : obj.isCreaseValley() ? 'valley' : obj.isCreaseBorder() ? 'border' : 'flat';
      return `Crease (${kind}): ${obj.getLength?.().toFixed?.(3) ?? 'N/A'} units`;
    } else if (type === 'facet') {
      return `Facet: ${obj.getVertices().length} vertices`;
    } else if (type === 'poly') {
      return `Polygon: ${obj.getVertices().length} vertices`;
    }
    return '';
  }

  /**
   * Handle mouse move
   */
  onMouseMove(e) {
    const { x, y } = this.canvasPointFromEvent(e);

    // Update hovered object
    this.hoveredObject = this.getObjectAtPoint(x, y);
    this.canvas.style.cursor = this.hoveredObject ? 'pointer' : 'default';

    this.render();
  }

  /**
   * Handle mouse down
   */
  onMouseDown(e) {
    if (e.button === 0) {
      // Left-click: select
      const { x, y } = this.canvasPointFromEvent(e);

      const obj = this.getObjectAtPoint(x, y);
      if (obj) {
        if (e.shiftKey) {
          if (!this.selectedObjects.includes(obj.object)) {
            this.selectedObjects.push(obj.object);
          }
        } else {
          this.selectedObjects = [obj.object];
        }
      }

      this.render();
    }
  }

  /**
   * Handle window resize. `width`/`height` are CSS pixels (the caller reads
   * them off `getBoundingClientRect()`) — every other method on this class
   * draws in that same CSS-pixel space via `this.width`/`this.height` and
   * worldToScreen(), so that logical size is what they keep meaning.
   *
   * The canvas's own BITMAP needs more actual pixels than that on any
   * HiDPI display (devicePixelRatio > 1: a laptop's Retina-style screen, or
   * a desktop monitor with OS-level scaling turned on, are both common, not
   * exotic): sizing the bitmap to exactly the CSS pixel count, as this used
   * to, leaves the canvas with only one real sample per CSS pixel, well
   * under what the display can actually show — and unlike a blanket
   * "everything looks a little soft" loss, that shortfall shows up as
   * visible, browser-specific pixel geometry once a shape's own edge
   * doesn't land on a whole bitmap pixel (a thin, precisely-angled
   * quadrilateral among them: only a few bitmap pixels wide, so each one's
   * own antialiased coverage fraction dominates its look, and Chromium and
   * Firefox don't rasterize that coverage identically) — reported as the
   * SAME weld producing a differently-warped-looking quad in each browser,
   * despite getWeldedCorridors() itself returning byte-identical geometry
   * in both (confirmed directly: this shape's own ring and cutSegments,
   * logged from the live page, matched this codebase's own computed values
   * exactly). Scaling the bitmap up to the display's real pixel density —
   * and scaling the drawing context to match, so every existing CSS-pixel
   * coordinate in the rest of this class keeps landing in the same visual
   * place — gives the browser's own rasterizer enough real samples that
   * there's no longer a thin coverage fraction for it to disagree about.
   */
  onResize(width, height) {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.width = width;
    this.height = height;
    this.render();
  }

}
