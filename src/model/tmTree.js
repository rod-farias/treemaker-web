/**
 * tmTree.js
 * The core class representing the complete origami tree model
 * Equivalent to tmTree class in TreeMaker C++
 */

import { tmPoint, flipAngleDegrees } from './tmPoint.js';
import { tmNode } from './tmNode.js';
import { tmEdge, MIN_EDGE_LENGTH } from './tmEdge.js';
import { tmPath } from './tmPath.js';
import { tmPoly } from './tmPoly.js';
import { tmFacet, FacetColor } from './tmFacet.js';
import { Optimizer } from './optimizers/Optimizer.js';
import { ScaleOptimizer } from './optimizers/ScaleOptimizer.js';
import { EdgeOptimizer } from './optimizers/EdgeOptimizer.js';
import { StrainOptimizer } from './optimizers/StrainOptimizer.js';
import { NewtonRaphson } from './solvers/NewtonRaphson.js';
import { ALM } from './solvers/ALM.js';
import { StubFinder } from './solvers/StubFinder.js';
import { ConditionNodeFixed } from './conditions/ConditionNodeFixed.js';
import { ConditionEdgeLengthFixed } from './conditions/ConditionEdgeLengthFixed.js';
import { ConditionNodesPaired } from './conditions/ConditionNodesPaired.js';
import { ConditionNodesCollinear } from './conditions/ConditionNodesCollinear.js';
import { ConditionNodeSymmetric } from './conditions/ConditionNodeSymmetric.js';
import { ConditionEdgesSameStrain } from './conditions/ConditionEdgesSameStrain.js';
import { ConditionNodeOnCorner } from './conditions/ConditionNodeOnCorner.js';
import { ConditionNodeOnEdge } from './conditions/ConditionNodeOnEdge.js';
import { ConditionPathActive } from './conditions/ConditionPathActive.js';
import { ConditionPathAngleFixed } from './conditions/ConditionPathAngleFixed.js';
import { ConditionPathAngleQuant } from './conditions/ConditionPathAngleQuant.js';
import { ConditionNodeCombo } from './conditions/ConditionNodeCombo.js';
import { ConditionPathCombo } from './conditions/ConditionPathCombo.js';
import { buildPolysFromPaths } from './solvers/PolygonPartition.js';

// Equivalent to tmTree::CPStatus. Order matches the original enum (and the
// priority order getCPStatus() checks them in) — HAS_FULL_CP is the only
// success value, everything else names the first problem found.
export const CPStatus = {
  HAS_FULL_CP: 'HAS_FULL_CP',
  EDGES_TOO_SHORT: 'EDGES_TOO_SHORT',
  POLYS_NOT_VALID: 'POLYS_NOT_VALID',
  POLYS_NOT_FILLED: 'POLYS_NOT_FILLED',
  POLYS_MULTIPLE_IBPS: 'POLYS_MULTIPLE_IBPS',
  VERTICES_LACK_DEPTH: 'VERTICES_LACK_DEPTH',
  FACETS_NOT_VALID: 'FACETS_NOT_VALID',
  NOT_LOCAL_ROOT_CONNECTABLE: 'NOT_LOCAL_ROOT_CONNECTABLE'
};

// Equivalent to the anonymous tmRootNetwork class in
// tmTree_FacetOrder.cpp: one connected component of the network of
// "local root" hinge vertices/creases within the tree (the hinges closest
// to the tree's root within each individual poly's own molecule — see
// tmPoly.calcBend()), together with its own spanning tree and the
// bookkeeping tmTree.calcFacetOrder() needs to splice every component
// into one single global facet-ordering graph.
class RootNetwork {
  static INELIGIBLE = 0;
  static NOT_YET = 1;
  static ALREADY_ADDED = 2;

  constructor(discreteDepth) {
    this.discreteDepth = discreteDepth;
    this.isConnectable = false;
    this.ccVertices = [];  // vertices in the connected component
    this.ccCreases = [];   // creases in the connected component
    this.ccPolys = [];     // polys that have a crease in the cc
    this.stVertices = [];  // spanning tree vertices
    this.stCreases = [];   // spanning tree creases
    this.cc0 = [];         // vertices of degree 0 in cc
    this.cc1 = [];         // vertices of degree 1 in cc
    this.cc2st1 = [];      // vertices of degree 2 in cc, degree 1 in st
    this.cc2st2 = [];      // vertices of degree 2 in cc, degree 2 in st
  }

  tryAddVertexToConnectedComponent(vertex) {
    if (vertex.ccFlag === RootNetwork.ALREADY_ADDED) return;
    vertex.ccFlag = RootNetwork.ALREADY_ADDED;
    this.ccVertices.push(vertex);
    for (const crease of vertex.creases) this.tryAddCreaseToConnectedComponent(crease);
    if (vertex.leftPseudohingeMate) this.tryAddVertexToConnectedComponent(vertex.leftPseudohingeMate);
    if (vertex.rightPseudohingeMate) this.tryAddVertexToConnectedComponent(vertex.rightPseudohingeMate);

    // A leaf-node vertex has no creases extending INTO its poly (it's a
    // dead end), so its incident polys have to be picked up explicitly via
    // its ridge creases' owners, or CanAbsorb() below would never find it.
    if (vertex.treeNode && vertex.treeNode.isLeafNode) {
      for (const crease of vertex.creases) {
        if (!crease.isRidgeCrease()) continue;
        const poly = crease.getOwnerAsPoly();
        if (poly && !this.ccPolys.includes(poly)) this.ccPolys.push(poly);
      }
    }
  }

  tryAddCreaseToConnectedComponent(crease) {
    if (!crease.isHingeCrease()) return;
    if (crease.ccFlag === RootNetwork.INELIGIBLE) return;
    if (crease.ccFlag === RootNetwork.ALREADY_ADDED) return;
    crease.ccFlag = RootNetwork.ALREADY_ADDED;
    this.ccCreases.push(crease);
    const poly = crease.getOwnerAsPoly();
    if (poly && !this.ccPolys.includes(poly)) this.ccPolys.push(poly);
    this.tryAddVertexToConnectedComponent(crease.getVertex(0));
    this.tryAddVertexToConnectedComponent(crease.getVertex(1));
  }

  tryAddVertexToSpanningTree(vertex) {
    if (vertex.stFlag === RootNetwork.ALREADY_ADDED) return;
    vertex.stFlag = RootNetwork.ALREADY_ADDED;
    this.stVertices.push(vertex);
    for (const crease of vertex.creases) this.tryAddCreaseToSpanningTree(crease);
    if (vertex.leftPseudohingeMate) this.tryAddVertexToSpanningTree(vertex.leftPseudohingeMate);
    if (vertex.rightPseudohingeMate) this.tryAddVertexToSpanningTree(vertex.rightPseudohingeMate);
  }

  tryAddCreaseToSpanningTree(crease) {
    if (!crease.isHingeCrease()) return;
    if (crease.ccFlag === RootNetwork.INELIGIBLE) return;
    if (crease.stFlag === RootNetwork.ALREADY_ADDED) return;
    const v1 = crease.getVertex(0);
    const v2 = crease.getVertex(1);
    const c1 = v1.stFlag === RootNetwork.ALREADY_ADDED;
    const c2 = v2.stFlag === RootNetwork.ALREADY_ADDED;
    if (c1 && c2) return;
    crease.stFlag = RootNetwork.ALREADY_ADDED;
    this.stCreases.push(crease);
    if (!c1) this.tryAddVertexToSpanningTree(v1);
    if (!c2) this.tryAddVertexToSpanningTree(v2);
  }

  buildSpanningTree() {
    this.tryAddVertexToSpanningTree(this.ccVertices[0]);
  }

  classifyVerticesByDegree() {
    for (const vertex of this.ccVertices) {
      if (!vertex.isAxialVertex()) continue;
      const ccDegree = vertex.getDegree(this.ccCreases);
      const stDegree = vertex.getDegree(this.stCreases);
      if (ccDegree === 0) this.cc0.push(vertex);
      else if (ccDegree === 1) this.cc1.push(vertex);
      else if (ccDegree === 2) {
        if (stDegree === 1) this.cc2st1.push(vertex);
        else if (stDegree === 2) this.cc2st2.push(vertex);
        else throw new Error('RootNetwork.classifyVerticesByDegree(): bad stDegree for ccDegree == 2');
      } else throw new Error('RootNetwork.classifyVerticesByDegree(): bad ccDegree');
      const axDegree = vertex.getNumHingeCreases();
      this.isConnectable = this.isConnectable || (axDegree === 2 && ccDegree === 1);
    }
  }

  /**
   * Add connections to the facet ordering graph that splice the pieces
   * surrounding this connected component into a single large loop (for
   * discreteDepth > 0) or a sortable graph (for the discreteDepth-0 piece,
   * where a single splice is deliberately left out — see breakOneLink()).
   */
  connectFacetGraph() {
    if (this.cc0.length === 1) {
      const vertex = this.cc0[0];
      for (const crease of vertex.creases) {
        if (crease.isRidgeCrease()) tmFacet.unlink(crease.fwdFacet, crease.bkdFacet);
      }
      let needsSkip = !vertex.isBorderVertex();
      for (const crease of vertex.creases) {
        if (!crease.isBorderCrease() && crease.isAxialCrease()) {
          if (needsSkip) needsSkip = false;
          else tmFacet.link(crease.fwdFacet, crease.bkdFacet);
        }
      }
      return;
    }
    for (const vertex of this.cc2st2) vertex.swapLinks();
  }

  /**
   * Equivalent to tmRootNetwork::CanAbsorb(): returns the vertex at which
   * `this` (the global, discreteDepth-0 network) can absorb `network` (a
   * lower-depth network), or null if it can't yet.
   */
  canAbsorb(network) {
    for (const poly of this.ccPolys) {
      for (const path of poly.ringPaths) {
        for (const vertex of path.vertices) {
          if (vertex.discreteDepth !== network.discreteDepth) continue;
          if (!network.cc1.includes(vertex)) continue;
          return vertex;
        }
      }
    }
    return null;
  }

  absorb(network, atVertex) {
    atVertex.swapLinks();
    for (const poly of network.ccPolys) {
      if (!this.ccPolys.includes(poly)) this.ccPolys.push(poly);
    }
  }

  /**
   * After the global root network has absorbed every other local root
   * network, break a single link in the resulting cycle to turn it into a
   * proper sortable (single source, single sink) graph.
   */
  breakOneLink() {
    if (this.cc0.length > 0) return; // root node is a leaf node: already sortable
    if (this.cc1.length > 0) {
      const vertex = this.cc1[0];
      const crease = vertex.getHingeCrease();
      tmFacet.unlink(crease.getLeftNonPseudohingeFacet(), crease.getRightNonPseudohingeFacet());
      return;
    }
    const vertex = this.cc2st1[0];
    const [crease1] = vertex.getHingeCreases();
    tmFacet.unlink(crease1.fwdFacet, crease1.bkdFacet);
  }
}

// getWeldedCorridors()'s own polygon-clipping pipeline (_clipConvexInside()/
// _subtractConvex()/_sliceRingByPolyTree()) drops any piece whose area
// falls below this — a facet corner sitting exactly on a poly/subPoly
// boundary line (common in this codebase's geometry) otherwise clips into
// a sliver of near-zero but nonzero area that would still pass a bare
// `length >= 3` check, then multiply into more spurious slivers at each
// further clip down the recursion.
const CORRIDOR_SLICE_AREA_EPS = 1e-7;

export class tmTree {
  constructor() {
    // Paper dimensions
    this.paperWidth = 1.0;
    this.paperHeight = 1.0;
    this.scale = 0.2;  // ratio between paper units and tree units
    
    // Symmetry
    this.hasSymmetry = false;
    this.symmetryType = 'none';
    this.symLoc = new tmPoint(0.5, 0.5);  // point on symmetry line
    this.symAngle = 0;  // angle of symmetry line (degrees)
    
    // State flags
    this.isFeasible = false;           // no path conditions violated
    this.isPolygonValid = false;       // convex hull filled with valid polygons
    this.isPolygonFilled = false;      // all polygons filled with subpolys/creases
    this.isVertexDepthValid = false;   // vertices have valid depth data
    this.isFacetDataValid = false;     // facet structure is valid
    this.isLocalRootConnectable = false; // local root networks can be spliced
    
    // Collections
    this.nodes = [];        // all nodes (tree + sub)
    this.edges = [];        // all edges
    this.paths = [];        // all leaf-to-leaf tree paths (long-lived, reused via getPath())
    // Molecule-construction paths (tmPoly's spoke/ridge/cross paths, built
    // by buildPolyContents() — see tmPoly.js), rebuilt from scratch on every
    // Build/Kill alongside vertices/creases/facets (see _collectInternalPaths()).
    // Kept out of `this.paths` (unlike the original's single mOwnedPaths
    // list) since these reference sub-nodes owned by a poly that Kill
    // Crease Pattern discards, whereas `this.paths` entries are long-lived
    // and reused across builds via getPath() — mixing them in would leave
    // stale entries after a Kill, the same class of bug fixed for
    // isLeafPath in _classifyLeafPaths().
    this.internalPaths = [];
    this.polys = [];        // all polygons (tree + sub)
    this.vertices = [];     // all vertices
    this.creases = [];      // all creases
    this.facets = [];       // all facets
    this.conditions = [];   // all constraints

    // The Reference Finder's own saved-search history: raw search
    // coordinates (hand-typed, or prefilled from a node/path/edge/vertex/
    // crease's current position and searched from that part's own
    // Inspector panel), independent of any tree part — no node/path/edge
    // reference at all, just the searched point/line, which of the (up to
    // 5) results was chosen, and that result's own rank/error, so a saved
    // search is never invalidated by editing the tree afterward.
    // `resultIndex` is what a saved search re-selects on demand instead of
    // always falling back to the best-ranked result — sound because the
    // search itself is deterministic given the same paper size and target
    // coordinates (see rfEngine.js). Not part of the original TreeMaker
    // format — see src/model/io/SavedSearches.js — kept here (rather than
    // only in the .tmd5 reader/writer) so it also survives tree.clone()/
    // toJSON(). Each entry: { id, mode: 'point'|'line', x1, y1, x2, y2,
    // resultIndex, rank, error }.
    this.rfSavedQueries = [];

    // Root node (for depth calculations)
    this.rootNode = null;
    
    // Undo stack for non-destructive operations
    this.undoStack = [];
  }

  // ===== GETTERS =====

  getPaperWidth() {
    return this.paperWidth;
  }

  getPaperHeight() {
    return this.paperHeight;
  }

  getPaperSize() {
    return new tmPoint(this.paperWidth, this.paperHeight);
  }

  getScale() {
    return this.scale;
  }

  hasSymmetryLine() {
    return this.hasSymmetry;
  }

  getSymLoc() {
    return this.symLoc;
  }

  getSymAngle() {
    return this.symAngle;
  }

  getSymmetryType() {
    return this.symmetryType;
  }

  // "Book" and "diagonal" are 90°/45° in the natural (Y-up, counterclockwise
  // from the x-axis) sense the original's Diag/Book buttons and the help
  // doc describe — flipAngleDegrees() converts that into this tree's
  // internal Y-down symAngle convention (see the comment on it in
  // tmPoint.js), same as a value coming from a .tmd5 file. "Book" ends up
  // visually identical either way (90°/270° both give a vertical line), but
  // "diagonal" doesn't: leaving it unconverted drew the anti-diagonal
  // (top-left to bottom-right) instead of the intended one.
  setSymmetryType(type) {
    const value = ['none', 'book', 'diagonal'].includes(type) ? type : 'none';
    this.symmetryType = value;
    this.setHasSymmetry(value !== 'none');
    if (value === 'book') this.setSymmetry(new tmPoint(0.5, 0.5), flipAngleDegrees(90));
    if (value === 'diagonal') this.setSymmetry(new tmPoint(0.5, 0.5), flipAngleDegrees(45));
    this.invalidate();
  }

  getSymDir() {
    const angleRad = this.symAngle * (Math.PI / 180);
    return new tmPoint(Math.cos(angleRad), Math.sin(angleRad));
  }

  isFeasibleTree() {
    return this.isFeasible;
  }

  // Collection getters
  getNodes() {
    return this.nodes;
  }

  // Real tree nodes only — excludes the "sub-nodes" (isSubNode: true) a
  // built crease pattern adds purely as bookkeeping for its own poly/
  // vertex/crease geometry (see getConnectedComponents()'s comment for how
  // these come about). The original TreeMaker never shows these on canvas
  // nor lets them be clicked/selected once a tree is built; every UI-facing
  // consumer of "all nodes" (canvas drawing/hit-testing, Select All/Select
  // Nodes and Edges, Select Part by Index) should use this instead of
  // getNodes() so they match that behavior. Internal consumers that
  // legitimately need every node regardless of isSubNode (serialization,
  // connectivity/feasibility checks, crease-pattern algorithms) should keep
  // using getNodes() directly.
  getSelectableNodes() {
    return this.nodes.filter(node => !node.isSubNode);
  }

  getEdges() {
    return this.edges;
  }

  getPaths() {
    return this.paths;
  }

  getInternalPaths() {
    return this.internalPaths;
  }

  getPolys() {
    return this.polys;
  }

  /**
   * Every poly at every inset-recursion depth (top-level plus, recursively,
   * every subPoly) — equivalent to the original's flat `mPolys` list, vs.
   * `mOwnedPolys`'s top-level-only (see _collectAllPolys()). Used wherever
   * an individual inset polygon (not just the outermost ring) needs to be
   * found or drawn, e.g. click-to-select and the Design View fill.
   */
  getAllPolys() {
    const out = [];
    for (const poly of this.polys) this._collectAllPolys(poly, out);
    return out;
  }

  getVertices() {
    return this.vertices;
  }

  getCreases() {
    return this.creases;
  }

  getFacets() {
    return this.facets;
  }

  getConditions() {
    return this.conditions;
  }

  addCondition(condition) {
    if (!condition || this.conditions.includes(condition)) return condition;
    this.conditions.push(condition);
    if (typeof condition.addConstraints === 'function') {
      condition.tree = this;
    }
    this._refreshPathState(condition.getPath?.());
    this.invalidate();
    this.recalculateFeasibility();
    return condition;
  }

  removeCondition(condition) {
    this.conditions = this.conditions.filter(item => item !== condition);
    this._refreshPathState(condition?.getPath?.());
    this.invalidate();
    this.recalculateFeasibility();
    return this;
  }

  // Equivalent to tmTree::CleanupAfterEdit()'s condition-purge pass: after
  // every structural edit, silently drop any condition whose own
  // IsValidCondition() has gone false (e.g. a node fixed via
  // ConditionNodeCombo that just became a branch node, or one whose part
  // was deleted) — same as the original does on every tmTreeCleaner scope
  // exit. Called from refreshNodeClassification() itself rather than via
  // removeCondition(), since that calls recalculateFeasibility(), which
  // calls refreshNodeClassification() right back — a direct filter here
  // avoids that recursion.
  _pruneInvalidConditions() {
    const kept = [];
    const affectedPaths = new Set();
    let removedAny = false;
    for (const condition of this.conditions) {
      const valid = !condition || typeof condition.isValidCondition !== 'function' || condition.isValidCondition();
      if (valid) {
        kept.push(condition);
      } else {
        removedAny = true;
        const path = condition?.getPath?.();
        if (path) affectedPaths.add(path);
      }
    }
    if (!removedAny) return;
    this.conditions = kept;
    this.invalidate();
    for (const path of affectedPaths) this._refreshPathState(path);
  }

  _refreshPathState(path) {
    if (!path) return;
    this._updatePathMinimum(path);
    const pathConditions = this.conditions.filter(condition => condition?.getPath?.() === path);
    const active = pathConditions.some(condition => condition instanceof ConditionPathActive || condition instanceof ConditionPathAngleFixed || condition instanceof ConditionPathAngleQuant);
    const fixed = pathConditions.find(condition => condition instanceof ConditionPathAngleFixed);
    const quantized = pathConditions.find(condition => condition instanceof ConditionPathAngleQuant);
    path.isActive = active;
    path.angleFixed = Boolean(fixed);
    path.angleQuant = Boolean(quantized);
    if (fixed) path.angle = fixed.getAngle();
    if (quantized) {
      path.quantValue = quantized.getQuantValue();
      path.quantOffset = quantized.getQuantOffset();
    }
    path.isFeasible = path.isFeasible && pathConditions.every(condition => condition.isFeasible !== false);
  }

  validateConditions() {
    return this.conditions.filter(condition => condition && typeof condition.isValidCondition === 'function' && condition.isValidCondition());
  }

  solveWithConstraints(OptimizerClass = Optimizer) {
    const optimizer = new OptimizerClass(this);

    for (const condition of this.conditions) {
      if (condition && typeof condition.addConstraints === 'function') {
        condition.addConstraints(optimizer);
      }
    }

    const result = optimizer.solve();
    this.refreshPathStates();
    return result;
  }

  solveWithSolver(SolverClass = NewtonRaphson, conditions = null) {
    const SolverImpl = SolverClass || NewtonRaphson;
    const solver = new SolverImpl(this);
    const items = conditions || this.conditions;
    const result = solver.solve(items);
    this.refreshPathStates();
    return result;
  }

  solveWithALM(options = {}, conditions = null) {
    const solver = new ALM(this, options);
    const items = conditions || this.conditions;
    const result = solver.solve(items);
    this.refreshPathStates();
    return result;
  }

  solveStrain(options = {}, conditions = null) {
    return this.solveWithALM({
      maxIterations: 200,
      maxOuterIterations: 8,
      learningRate: 0.1,
      penalty: 10,
      variableMode: 'strain',
      objectiveMode: 'strain',
      ...options
    }, conditions);
  }

  /**
   * Replica "Scale Selection" del original (tmEdgeOptimizer, ver
   * EdgeOptimizer.js): maximiza una única tensión compartida por las
   * aristas seleccionadas (filtradas a las no fijadas), moviendo solo los
   * nodos hoja seleccionados (también filtrados a los no fijados), sujeto
   * a que ningún camino hoja-a-hoja del árbol —no solo el que toca la
   * selección— quede más corto que su longitud mínima. Es un problema de
   * optimización conjunta (tensión + posiciones), igual que
   * "Scale Everything" lo es para la escala — NO el mismo solver que
   * "Minimize Strain" (solveWithALM/variableMode:'strain'), que es un
   * comando distinto del original sobre TODO el árbol.
   *
   * Diferencia deliberada con el original: tmwxDoc::OnScaleSelection() solo
   * incluye una arista como "estirable" si el usuario la seleccionó
   * explícitamente además de la hoja — aunque una hoja (grado 1) tiene una
   * única arista posible, sin ambigüedad sobre cuál sería. Exigir los dos
   * clics es simplemente incómodo, así que acá se agrega sola: por cada
   * hoja seleccionada cuya arista incidente no esté ya en la selección, se
   * suma esa arista antes de pasarle todo a EdgeOptimizer.
   */
  scaleSelection(selectedNodes = [], selectedEdges = [], options = {}) {
    const augmentedEdges = new Set(selectedEdges);
    for (const node of selectedNodes) {
      if (node.getDegree() !== 1) continue;
      for (const edge of node.getEdges()) augmentedEdges.add(edge);
    }
    const optimizer = new EdgeOptimizer(this, selectedNodes, [...augmentedEdges], options);
    return optimizer.optimize();
  }

  /**
   * Replica "Minimize Strain" del original (tmStrainOptimizer, ver
   * StrainOptimizer.js): a diferencia de "Scale Selection" (que fuerza
   * TODAS las aristas seleccionadas a compartir una sola tensión, para
   * maximizarla), acá cada arista seleccionada tiene su propia tensión
   * independiente, y se MINIMIZA la suma de tensión al cuadrado ponderada
   * por rigidez, sujeta a que el árbol siga siendo geométricamente válido.
   * Sirve para reparar una disposición que quedó inválida o innecesariamente
   * tensa (p.ej. tras mover nodos a mano), repartiendo el ajuste mínimo
   * necesario entre las aristas seleccionadas.
   *
   * Misma conveniencia que scaleSelection(): si se seleccionó una hoja sin
   * su arista (que es única, por tener grado 1), se agrega sola.
   */
  minimizeStrain(selectedNodes = [], selectedEdges = [], options = {}) {
    const augmentedEdges = new Set(selectedEdges);
    for (const node of selectedNodes) {
      if (node.getDegree() !== 1) continue;
      for (const edge of node.getEdges()) augmentedEdges.add(edge);
    }
    const optimizer = new StrainOptimizer(this, selectedNodes, [...augmentedEdges], options);
    return optimizer.optimize();
  }

  /**
   * Replica "Scale Everything": maximiza la escala del árbol reubicando las
   * hojas dentro del papel, respetando las condiciones activas.
   */
  scaleEverything(options = {}) {
    const optimizer = new ScaleOptimizer(this, options);
    const result = optimizer.optimize();
    this.refreshPathStates();
    return result;
  }

  /**
   * Igual que scaleEverything(), pero asíncrona y cancelable (ver
   * ScaleOptimizer.optimizeAsync): cede el control entre reinicios para que
   * la interfaz no se congele mientras corre, y admite un AbortSignal.
   */
  async scaleEverythingAsync(options = {}) {
    const optimizer = new ScaleOptimizer(this, options);
    const result = await optimizer.optimizeAsync(options);
    this.refreshPathStates();
    return result;
  }

  diagnoseConstraints(SolverClass = NewtonRaphson, conditions = null, options = {}) {
    const solver = new SolverClass(this, options);
    const items = conditions || this.conditions;
    if (typeof solver.diagnose !== 'function') {
      return { status: 'unsupported', conditions: items };
    }
    const result = solver.diagnose(items);
    this.refreshPathStates();
    return result;
  }

  refreshPathStates() {
    for (const path of this.paths) {
      this._updatePathMinimum(path);
      const pathConditions = this.conditions.filter(condition => condition?.getPath?.() === path);
      for (const condition of pathConditions) {
        condition.calcFeasibility?.();
      }
      this._refreshPathState(path);
    }
    // Equivalent to tmTree::CleanupAfterEdit()'s own condition loop, which
    // recalculates EVERY condition's feasibility unconditionally — not
    // just the ones tied to a path (the loop above only reaches those).
    // A node/edge condition (e.g. "Fix to Symmetry Line") could otherwise
    // stay stuck reporting stale infeasibility after the very edit/solve
    // that actually satisfied it, since nothing else here ever revisits it.
    for (const condition of this.conditions) {
      condition?.calcFeasibility?.();
    }
    this.recalculateFeasibility();
    this._refreshDerivedClassification();
    return this;
  }

  /**
   * Equivalent to the non-Build half of tmTree::CleanupAfterEdit(): the
   * original recomputes border/polygon/pinned path-and-node classification
   * after EVERY edit (not just at Build) as live canvas feedback — this
   * used to only run inside buildTreePolys() (i.e. only once Build was
   * actually clicked), so none of it appeared while just editing:
   *
   * - isPinnedNode/isPinnedEdge: which leaves/edges are already locked in
   *   place (no taut constraint or paper edge leaves a free direction) —
   *   blue vs. cyan edges, in particular right after "Maximize Scale"/
   *   "Scale Selection", so the user can see whether it fully pinned the
   *   tree (safe to proceed to Build) before ever clicking Build.
   * - isBorderPath/isPolygonPath (CalcBorderNodesAndPaths/
   *   CalcPolygonNetwork): the leaf-to-leaf paths that "close the
   *   triangle" between three nodes as they're added/moved — drawn as
   *   yellow lines (PATH_VALID_COLOR) once feasible, turning green
   *   (PATH_ACTIVE_COLOR) once actually taut, e.g. after maximizing scale.
   *   See CanvasRenderer._drawPaths().
   *
   * Deliberately stops short of _buildPolysFromPaths(): tracing those paths
   * into actual tmPoly faces is real work, reserved for an explicit Build.
   * @private
   */
  _refreshDerivedClassification() {
    const leafNodes = this.nodes.filter(node => node.isLeafNode);
    const leafPaths = this._classifyLeafPaths(leafNodes);
    this._calcBorderNodesAndPaths(leafNodes, leafPaths);
    this._calcPinnedNodesAndEdges(leafNodes, leafPaths);
    this._calcPolygonNetwork(leafNodes, leafPaths);
  }

  recalculateFeasibility() {
    for (const node of this.nodes) node.ownerTree = this;
    for (const edge of this.edges) edge.ownerTree = this;
    const invalidPaper = !Number.isFinite(this.paperWidth) || !Number.isFinite(this.paperHeight) || this.paperWidth <= 0 || this.paperHeight <= 0;
    const invalidScale = !Number.isFinite(this.scale) || this.scale <= 0;
    const invalidNodes = this.nodes.filter(node => (
      !Number.isFinite(node.getLocX()) || !Number.isFinite(node.getLocY())
    ));
    // Same tolerance _updatePathMinimum()/tmPoly.js's own DIST_TOL use for
    // "close enough to count" boundary comparisons — without it, a node a
    // condition solved onto a paper edge/corner (e.g. "Fixed to Paper
    // Corner") reads as out of bounds from nothing more than floating-point
    // noise (observed: x = -4.8e-7, y = 1.0000005), flagging a perfectly
    // valid, buildable design as infeasible.
    const DIST_TOL = 1e-4;
    const outOfBoundsNodes = this.nodes.filter(node => (
      node.getLocX() < -DIST_TOL || node.getLocX() > this.paperWidth + DIST_TOL ||
      node.getLocY() < -DIST_TOL || node.getLocY() > this.paperHeight + DIST_TOL
    ));
    this.refreshNodeClassification();
    const components = this.getConnectedComponents();
    const cyclicEdges = this.getCyclicEdges();
    const invalidTopology = this.edges.filter(edge => {
      const [first, second] = edge.getNodes?.() || edge.nodes || [];
      return !first || !second || first === second ||
        !this.nodes.includes(first) || !this.nodes.includes(second) ||
        !first.getEdges().includes(edge) || !second.getEdges().includes(edge);
    });
    const invalidEdges = this.edges.filter(edge => {
      const length = edge.getLength?.() ?? edge.length;
      const strain = edge.getStrain?.() ?? edge.strain;
      const strainedLength = edge.getStrainedLength?.() ?? length * (1 + strain);
      const geometricLength = edge.getGeometricLength?.() ?? 0;
      return !Number.isFinite(length) || length < 0 || !Number.isFinite(strain) || !Number.isFinite(strainedLength) || strainedLength < 0 || geometricLength <= 1e-12;
    });
    const invalidConditions = this.conditions.filter(condition => (
      !condition?.isValidCondition?.() || condition.isFeasible === false
    ));
    // Leaf-to-leaf only: tree.paths also accumulates leaf-to-BRANCH paths
    // that assorted internal lookups (corridor/facet-ordering code calling
    // getPath() on whatever node pair it needed at the time) happened to
    // create along the way — _classifyLeafPaths()'s own doc comment notes
    // the original keeps those too but "nothing in the polygon-partition
    // algorithm ever looks at them". The "positive path condition" that
    // actually determines whether a design is valid is a leaf-to-leaf
    // constraint (Lang's uniaxial-base theory: every pair of flap tips must
    // fit); a leaf-to-branch path's own straight-line distance isn't an
    // independent requirement. Confirmed against a real report: a design
    // that built its full crease pattern with no errors (isBorderPath/
    // isPolygonPath/isActiveGeometry all false on the flagged path, and
    // every one of its own leaf-to-leaf paths already feasible) was still
    // being reported infeasible purely from one such leftover sub-path.
    const infeasiblePaths = this.paths.filter(path => path.isLeafPath && !path.isFeasiblePath());
    this.isFeasible = !invalidPaper && !invalidScale && invalidNodes.length === 0 && outOfBoundsNodes.length === 0 && components.length <= 1 && cyclicEdges.length === 0 && invalidTopology.length === 0 && invalidEdges.length === 0 && invalidConditions.length === 0 && infeasiblePaths.length === 0;
    return {
      feasible: this.isFeasible,
      invalidPaper,
      invalidScale,
      invalidNodes,
      outOfBoundsNodes,
      components,
      cyclicEdges,
      invalidTopology,
      invalidEdges,
      invalidConditions,
      infeasiblePaths,
      pathSlack: this.paths.map(path => ({ path, slack: path.getLengthSlack() })),
      edgeSlack: this.edges.map(edge => ({
        edge,
        slack: edge.getLengthSlack?.() ?? 0,
        computedStrain: edge.getComputedStrain?.() ?? 0
      }))
    };
  }

  refreshNodeClassification() {
    // Equivalent to tmTree::AddNode()'s special case for the very first
    // node (`newNode->mIsLeafNode = true` even before it has any edge):
    // a lone node with no edges yet is still a leaf, not a branch node —
    // otherwise a brand-new tree's only node couldn't carry a Fix-to-*
    // condition, which the original allows.
    const onlyNode = this.nodes.length === 1 ? this.nodes[0] : null;
    for (const node of this.nodes) {
      const degree = node.getDegree();
      node.isLeafNode = degree === 1 || node === onlyNode;
      node.isBranchNode = degree >= 2;
      node.isRootNode = node === this.rootNode;
    }
    this._pruneInvalidConditions();
    return this;
  }

  // Real tree nodes only — a built crease pattern adds "sub-nodes"
  // (isSubNode: true) purely as bookkeeping for the poly/vertex/crease
  // geometry (e.g. one per subdivided path), and those never get an edge
  // of their own in this.edges: they aren't part of the base tree's
  // node/edge graph at all. Counting them here would flag every one as
  // its own disconnected "component" (observed: a 13-node/12-edge tree —
  // one single connected component — plus 32 edge-less sub-nodes was
  // reported as "split into 33 disconnected parts", something the
  // original TreeMaker never flags for the exact same file).
  getConnectedComponents() {
    const components = [];
    const visited = new Set();
    for (const start of this.nodes) {
      if (start.isSubNode || visited.has(start)) continue;
      const component = [];
      const queue = [start];
      visited.add(start);
      while (queue.length > 0) {
        const node = queue.shift();
        component.push(node);
        for (const neighbor of node.getAdjacentNodes?.() || []) {
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            queue.push(neighbor);
          }
        }
      }
      components.push(component);
    }
    return components;
  }

  getCyclicEdges() {
    const parent = new Map(this.nodes.map(node => [node, node]));
    const find = node => {
      let root = node;
      while (parent.get(root) !== root) root = parent.get(root);
      while (parent.get(node) !== node) {
        const next = parent.get(node);
        parent.set(node, root);
        node = next;
      }
      return root;
    };
    const union = (first, second) => {
      const firstRoot = find(first);
      const secondRoot = find(second);
      if (firstRoot === secondRoot) return false;
      parent.set(firstRoot, secondRoot);
      return true;
    };
    const cyclic = [];
    for (const edge of this.edges) {
      const [first, second] = edge.getNodes?.() || edge.nodes || [];
      if (!first || !second || !parent.has(first) || !parent.has(second)) continue;
      if (!union(first, second)) cyclic.push(edge);
    }
    return cyclic;
  }

  // Count methods
  getNumNodes() {
    return this.nodes.length;
  }

  /**
   * The original has no persisted node label (nodes are identified by
   * pointer/array position); this port adds a human-readable `label` for
   * the UI, numbered as the highest existing numeric label + 1 so it stays
   * unique even after nodes have been removed. Shared by every model-layer
   * method that creates a node (addNode(), splitEdge()) so newly-created
   * nodes never end up with a blank label.
   */
  _nextNodeLabel() {
    const highest = this.nodes.reduce((max, node) => {
      const value = Number(node.label);
      return Number.isInteger(value) && value > max ? value : max;
    }, 0);
    return String(highest + 1);
  }

  getNumEdges() {
    return this.edges.length;
  }

  getNumPaths() {
    return this.paths.length;
  }

  getNumPolys() {
    return this.polys.length;
  }

  getNumVertices() {
    return this.vertices.length;
  }

  getNumCreases() {
    return this.creases.length;
  }

  getNumFacets() {
    return this.facets.length;
  }

  getNumConditions() {
    return this.conditions.length;
  }

  // Equivalent to tmCluster::GetNumEditableParts(): every part type EXCEPT
  // paths (paths aren't independently selectable/deletable — they're
  // derived from nodes/edges). Used to gate Edit->Select->All.
  getNumEditableParts() {
    return this.nodes.length + this.edges.length + this.polys.length +
      this.vertices.length + this.creases.length + this.facets.length +
      this.conditions.length;
  }

  // Equivalent to tmTree::GetNumMovableParts(): unpinned leaf nodes plus
  // unpinned edges that don't carry a ConditionEdgeLengthFixed. Used to
  // gate Edit->Select->Movable Parts.
  getNumMovableParts() {
    const { nodes, edges } = this.filterMovableParts(this.nodes, this.edges);
    return nodes.length + edges.length;
  }

  // Equivalent to tmTree::FilterMovableParts(): the subset of `nodeList`/
  // `edgeList` that's allowed to move — unpinned leaf nodes, and unpinned
  // edges lacking a ConditionEdgeLengthFixed. Returns new arrays rather
  // than filtering in place (the original's out-param style).
  filterMovableParts(nodeList, edgeList) {
    const nodes = nodeList.filter(node => node.isLeafNode && !node.isPinnedNode);
    const edges = edgeList.filter(edge => (
      !edge.isPinnedEdge &&
      !this.conditions.some(c => c instanceof ConditionEdgeLengthFixed && c.getEdge() === edge)
    ));
    return { nodes, edges };
  }

  // Equivalent to tmTree::CanGetCorridorFacets(): corridor-edge assignment
  // (part of the crease-pattern pipeline — see tmPoly.calcFacetCorridorEdges())
  // needs to have run for GetCorridorFacets() to mean anything.
  canGetCorridorFacets() {
    return this.isFacetDataValid;
  }

  // Equivalent to tmTree::GetCorridorFacets(): every facet whose corridor
  // edge is one of the given edges.
  getCorridorFacets(edgeList) {
    return this.facets.filter(facet => edgeList.includes(facet.getCorridorEdge()));
  }

  // Every "internal" edge — both endpoints non-leaf nodes — the same
  // criterion _internalCorridorFacetGroups()/_drawRivers() use to tell a
  // river (a strip between two branch nodes) apart from a leaf's own
  // reference-circle strip. Blueprint View's own query: it wants exactly
  // these edges' corridor facets, not a leaf edge's.
  getInternalEdges() {
    return this.edges.filter(edge => {
      const n1 = edge.getNode(0);
      const n2 = edge.getNode(1);
      return n1 && n2 && !n1.isLeafNode && !n2.isLeafNode;
    });
  }

  // Internal helper for getWeldedCorridors(): every facet grouped by
  // corridor edge, restricted to internal edges (both endpoints non-leaf —
  // the same "river" CanvasRenderer._drawRivers() draws; a leaf-node edge
  // also gets a corridorEdge from tmPoly.calcFacetCorridorEdges(), but that
  // strip is the leaf's own reference circle, not a river).
  _internalCorridorFacetGroups() {
    const groups = new Map();
    for (const facet of this.facets) {
      const corridorEdge = facet.getCorridorEdge();
      if (!corridorEdge) continue;
      const n1 = corridorEdge.getNode(0);
      const n2 = corridorEdge.getNode(1);
      if (!n1 || !n2 || n1.isLeafNode || n2.isLeafNode) continue;
      if (!groups.has(corridorEdge)) groups.set(corridorEdge, []);
      groups.get(corridorEdge).push(facet);
    }
    return groups;
  }

  // Internal helper for getWeldedCorridors(): `poly`'s true boundary as a
  // flat, ordered {x,y} ring — unlike poly.vertices (only the ring NODES'
  // own corner vertices, connected corner-to-corner by an implied straight
  // line), this walks each ringPaths[i] (the real path from ringNodes[i] to
  // ringNodes[(i+1) % n] — see the constructor's own comment on those two
  // fields) and splices in every interior vertex that path picked up during
  // buildPolyContents() (e.g. where some other element's own boundary
  // crosses it). A ring edge with no such interior vertices reduces to the
  // same single corner-to-corner segment as before; one that does bends
  // through real crease geometry a straight corner-to-corner chord would
  // cut across.
  _polyBoundaryRing(poly) {
    const ring = [];
    const n = poly.ringNodes.length;
    for (let i = 0; i < n; i += 1) {
      const fromNode = poly.ringNodes[i];
      ring.push(fromNode.getOrMakeVertexSelf());
      const path = poly.ringPaths[i];
      if (!path) continue;
      const forward = path.getFirstNode() === fromNode;
      const interior = forward ? path.vertices : [...path.vertices].reverse();
      ring.push(...interior);
    }
    return ring.map(v => ({ x: v.getLocX(), y: v.getLocY() }));
  }

  // Winds `points` (plain {x,y}) counterclockwise-by-shoelage-sign if it
  // isn't already — _clipConvexInside()/_clipConvexOutsideOne() below both
  // assume "left of a directed edge, walking the ring forward" means
  // inside, which only holds for a consistent winding.
  _ensureCCW(points) {
    let area = 0;
    for (let i = 0; i < points.length; i += 1) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      area += a.x * b.y - b.x * a.y;
    }
    return area < 0 ? [...points].reverse() : points;
  }

  // Shoelace area of a ring of either plain {x,y} points or _clipHalfPlane's
  // own `{ p: {x,y}, cut }` records. Used to drop degenerate slivers a clip
  // can produce when the shape being clipped already touches the clip
  // boundary exactly (a facet corner sitting precisely on a poly boundary
  // line, common in this codebase's geometry) — without this filter, such
  // a sliver's near-zero but nonzero extent still passes a bare
  // `length >= 3` check and gets recursed into just like a real piece,
  // multiplying into more spurious slivers at each further clip.
  _ringArea(points) {
    let area = 0;
    for (let i = 0; i < points.length; i += 1) {
      const a = points[i].p || points[i];
      const b = points[(i + 1) % points.length].p || points[(i + 1) % points.length];
      area += a.x * b.y - b.x * a.y;
    }
    return Math.abs(area) / 2;
  }

  // Sutherland-Hodgman clip of `points` (an array of `{ p: {x,y}, cut }` —
  // `cut` flags whether the edge arriving AT this point, from the previous
  // one, lies on some earlier clip's cutting line rather than being part of
  // the shape being clipped) against the single directed half-plane through
  // `a` -> `b`, keeping whatever is on `keepLeft`'s side (the left side,
  // i.e. counterclockwise-inside, when true; the right/outside when
  // false — same edge, opposite half-plane, which is exactly "outside this
  // one edge of a CCW convex clip polygon"). A vertex the clip drops or
  // admits right at the boundary keeps its own `cut` flag when the edge
  // feeding it survives partly (still real shape boundary, just
  // shortened); a vertex freshly created where the shape crosses INTO the
  // kept half-plane instead gets `cut: true`, since the segment leading to
  // it — from wherever the shape last touched this same boundary — is the
  // clip line itself, not anything that was ever part of the original
  // shape.
  _clipHalfPlane(points, a, b, keepLeft) {
    const side = (p) => {
      const c = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
      return keepLeft ? c : -c;
    };
    const intersect = (p1, p2) => {
      const c1 = side(p1);
      const c2 = side(p2);
      const t = c1 / (c1 - c2);
      return { x: p1.x + t * (p2.x - p1.x), y: p1.y + t * (p2.y - p1.y) };
    };
    const out = [];
    const n = points.length;
    for (let i = 0; i < n; i += 1) {
      const cur = points[i];
      const prev = points[(i - 1 + n) % n];
      const curIn = side(cur.p) >= -1e-9;
      const prevIn = side(prev.p) >= -1e-9;
      if (curIn) {
        if (!prevIn) out.push({ p: intersect(prev.p, cur.p), cut: true });
        out.push({ p: cur.p, cut: cur.cut });
      } else if (prevIn) {
        out.push({ p: intersect(prev.p, cur.p), cut: cur.cut });
      }
    }
    return out;
  }

  // Intersection of `points` with the convex polygon `clipRing` (a plain
  // {x,y} ring — see _polyBoundaryRing()) — sequential Sutherland-Hodgman
  // clipping against each of the clip polygon's own edges.
  _clipConvexInside(points, clipRing) {
    const ring = this._ensureCCW(clipRing);
    let result = points;
    for (let i = 0; i < ring.length && result.length > 0; i += 1) {
      result = this._clipHalfPlane(result, ring[i], ring[(i + 1) % ring.length], true);
    }
    return result.length >= 3 && this._ringArea(result) > CORRIDOR_SLICE_AREA_EPS ? result : [];
  }

  // `points` minus the convex polygon `clipRing`, as an array of disjoint
  // convex pieces — one per edge of `clipRing`, each the part of `points`
  // outside that specific edge but still inside every edge before it (in
  // ring order). That per-edge decomposition is the standard trick for
  // subtracting one convex region from anything: instead of one possibly-
  // concave leftover polygon (which plain half-plane clipping can't
  // produce directly), it's split into these convex wedges, each of which
  // half-plane clipping already handles exactly.
  _subtractConvex(points, clipRing) {
    const ring = this._ensureCCW(clipRing);
    const pieces = [];
    for (let i = 0; i < ring.length; i += 1) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      // "Outside edge i" = inside the same edge reversed (b -> a) — for a
      // CCW ring, reversing a directed edge flips which side counts as
      // "left".
      let piece = this._clipHalfPlane(points, b, a, true);
      for (let k = 0; k < i && piece.length > 0; k += 1) {
        piece = this._clipHalfPlane(piece, ring[k], ring[(k + 1) % ring.length], true);
      }
      if (piece.length >= 3 && this._ringArea(piece) > CORRIDOR_SLICE_AREA_EPS) pieces.push(piece);
    }
    return pieces;
  }

  // Collapses consecutive near-duplicate points (within RING_POINT_MERGE_EPS)
  // a clip can leave behind when a freshly-cut intersection point lands
  // right on top of a vertex the shape already had there (common — see
  // CORRIDOR_SLICE_AREA_EPS's own comment on boundary-touching geometry),
  // including the closing wrap from the last point back to the first. The
  // tolerance is well above float noise (a single algebraic intersection
  // lands within ~1e-9 of an exact repeat) because the same near-duplicate
  // also shows up already a short distance apart — two DIFFERENT clips
  // (e.g. adjacent sibling polys sharing an edge) intersecting the ring
  // independently within a few ten-thousandths of the same real corner —
  // and both cases need collapsing the same way for a clean cut count.
  // Kept separate from the area-based filtering above, which drops whole
  // degenerate PIECES — this only tidies a real piece's own point list, so
  // _sliceRingByPolyTree()'s cut-edge bookkeeping never double-counts one
  // real crossing as an extra, near-zero-length "cut" segment alongside it.
  // Whichever of a merged pair is the genuine crossing (`cut: true`) always
  // wins the surviving point's own position — the other was only ever a
  // natural vertex that happened to land beside it, not a separate corner
  // worth keeping.
  _dedupeRingPoints(points) {
    const tol = 1e-3;
    const same = (p, q) => Math.abs(p.x - q.x) < tol && Math.abs(p.y - q.y) < tol;
    const out = [];
    for (const pt of points) {
      const last = out[out.length - 1];
      if (last && same(last.p, pt.p)) {
        if (pt.cut && !last.cut) out[out.length - 1] = pt;
        continue;
      }
      out.push(pt);
    }
    if (out.length > 1 && same(out[0].p, out[out.length - 1].p)) {
      const wrapped = out.pop();
      if (wrapped.cut && !out[0].cut) out[0] = wrapped;
    }
    return out;
  }

  // Internal helper for _isNotchOnly(): the perpendicular distance from `p`
  // to the finite segment a->b (not the infinite line — a point past
  // either endpoint measures to that endpoint instead).
  _pointSegmentDistance(p, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-18) return Math.hypot(p.x - a.x, p.y - a.y);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  // Internal helper for getWeldedCorridors(): tags every edge of a facet
  // group's welded `ring` (an array of tmVertex, as _weldFacetGroup()
  // returns it) with which of the corridor's two long sides it belongs to
  // — 'A' or 'B' — using the facet chain's own adjacency, not geometry, so
  // it doesn't care how many small facet-to-facet edges make up a side or
  // how sharply the river bends partway along it. A facet in the middle of
  // a linear corridor chain shares one edge with the facet before it and
  // one with the facet after it (dropped from the ring as internal seams —
  // see _weldFacetGroup()); its own two remaining (lone) edges are exactly
  // one per side, always on OPPOSITE sides of the strip. Walking the chain
  // from one end assigns each facet a position 0..N-1; walking the welded
  // ring itself then traces that position value up from 0 to its peak (one
  // side, in whichever direction the ring happens to run) and back down to
  // 0 (the other side) — a single up-then-down "tent" over the ring's own
  // cyclic order — so splitting the ring at its one peak and one trough
  // gives exactly the two long sides.
  //
  // Also returns `endAnchors`: every ring vertex that borders the chain's
  // lowest- or highest-index facet(s) — i.e. sits right at one of the
  // corridor's own two ends (a leaf, a hub, or wherever else the chain
  // simply stops). Right at an end, the strip's own width closes down to
  // that end's own cap, so the two ring vertices flanking it end up on
  // OPPOSITE sides by the walk above even when they're only ever a single
  // small end facet apart — see _isNotchOnly()'s own use of these.
  _ringEdgeSides(facetGroup, ring) {
    const edgeFacets = new Map();
    for (const facet of facetGroup) {
      const verts = facet.getVertices();
      for (let i = 0; i < verts.length; i += 1) {
        const a = verts[i];
        const b = verts[(i + 1) % verts.length];
        const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
        if (!edgeFacets.has(key)) edgeFacets.set(key, []);
        edgeFacets.get(key).push(facet);
      }
    }
    const adjacency = new Map(facetGroup.map(f => [f, new Set()]));
    for (const facets of edgeFacets.values()) {
      if (facets.length === 2) {
        adjacency.get(facets[0]).add(facets[1]);
        adjacency.get(facets[1]).add(facets[0]);
      }
    }
    const chainIndex = new Map();
    let cur = facetGroup.find(f => adjacency.get(f).size <= 1) || facetGroup[0];
    let prev = null;
    let idx = 0;
    while (cur && !chainIndex.has(cur)) {
      chainIndex.set(cur, idx);
      idx += 1;
      const next = [...adjacency.get(cur)].find(f => f !== prev && !chainIndex.has(f));
      prev = cur;
      cur = next;
    }

    const n = ring.length;
    const vals = new Array(n);
    for (let i = 0; i < n; i += 1) {
      const a = ring[i];
      const b = ring[(i + 1) % n];
      const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
      const facet = (edgeFacets.get(key) || [])[0];
      vals[i] = chainIndex.get(facet) ?? 0;
    }
    let peakIdx = 0;
    let troughIdx = 0;
    for (let i = 1; i < n; i += 1) {
      if (vals[i] > vals[peakIdx]) peakIdx = i;
      if (vals[i] < vals[troughIdx]) troughIdx = i;
    }
    // The facet chain can genuinely branch (a facet bordering 3+ others
    // within its own group — observed at a symmetric multi-river junction,
    // where one internal edge's own corridor facets meet more than one
    // neighbor apiece): the walk above then only ever follows ONE branch,
    // silently skipping the rest, and the resulting `vals` sequence isn't
    // the clean single "tent" the peak/trough logic assumes. `endAnchors`
    // relies on that assumption (see _isNotchOnly()); rather than let a
    // corrupted peak/trough manufacture false "this is a corridor end"
    // matches, leave it empty whenever the walk didn't reach every facet —
    // the plain side split below still degrades reasonably even then.
    const endAnchors = [];
    if (chainIndex.size === facetGroup.length) {
      for (let i = 0; i < n; i += 1) {
        if (vals[i] === vals[peakIdx] || vals[i] === vals[troughIdx]) {
          endAnchors.push({ x: ring[i].getLocX(), y: ring[i].getLocY() });
          endAnchors.push({ x: ring[(i + 1) % n].getLocX(), y: ring[(i + 1) % n].getLocY() });
        }
      }
    }
    const sides = new Array(n).fill('B');
    if (vals[peakIdx] === vals[troughIdx]) return { sides: sides.fill('A'), endAnchors };
    for (let i = troughIdx; ; i = (i + 1) % n) {
      sides[i] = 'A';
      if (i === peakIdx) break;
    }
    return { sides, endAnchors };
  }

  // Internal helper for _sliceRingByPolyTree(): true when a poly/subPoly's
  // own territory (`inside`, already clipped out of the corridor's current
  // material) only notches the material rather than cutting all the way
  // through it, dividing it into two separate parts — the geometric test
  // the user asked for directly: does the candidate's own cut cross both of
  // the corridor's long sides, or just nibble into one of them?
  //
  // `inside`'s own two crossing points — where the material's boundary
  // passes into and back out of the poly — can't just be read off
  // `_clipHalfPlane()`'s `cut: true` flag: that flag only marks a point
  // freshly CREATED by an intersection, but a crossing can just as well
  // land exactly on an existing corridor-ring vertex (common right at a
  // branch hub, where several creases meet at one point), keeping its old
  // `cut: false` despite being just as real a crossing. Nor is "lies
  // somewhere on clipRing's own boundary" enough either: a poly can have an
  // edge that runs right along the corridor's own outline for a whole
  // stretch (e.g. both following the same paper edge), which any number of
  // `inside` points can sit on without a fresh cut happening there at all.
  // What actually marks a crossing is a change in EDGE KIND while walking
  // `inside`'s own boundary: each of its edges is either a piece of the
  // corridor's original outline (`originalEdges`) or a piece of `clipRing`
  // (introduced by this clip) — classified by testing each edge's OWN
  // midpoint, which (unlike an endpoint) can't be mistaken for the other
  // kind by sitting exactly on a shared vertex. A vertex where the edge
  // before it and the edge after it differ in kind is a crossing.
  //
  // The two crossings found this way are matched against `originalEdges`
  // (`{ a, b, side }`, from _ringEdgeSides() — the corridor's OWN welded
  // outline, captured once before any slicing):
  //   - Both crossings land on the SAME side ('A'/'A' or 'B'/'B'), however
  //     many small facet-to-facet edges apart along it: the candidate's cut
  //     leaves and re-enters through that one physical side — a notch.
  //   - Landing on different sides normally means a genuine full division —
  //     EXCEPT when BOTH crossings themselves sit at one of `endAnchors`
  //     (from _ringEdgeSides() — the vertices flanking the corridor's own
  //     two ends). Right at an end the strip's width closes down to that
  //     end's own cap, so the two flanking vertices land on opposite sides
  //     by construction even when the material between them is just that
  //     end's own tip, not a real cross-section — trimming a tip doesn't
  //     divide the corridor into two continuing parts, so it's a notch too.
  //     `inside` can legitimately CONTAIN end-anchor points elsewhere in
  //     its own boundary too (a poly big enough to also swallow a whole end
  //     while genuinely cutting across to a distant, unrelated part of the
  //     ring) without either of that being a tip trim — only the crossings
  //     THEMSELVES landing there marks this specific cut as one.
  //   - Either crossing landing on no original edge at all — it lands
  //     instead on a boundary some earlier, already-accepted division left
  //     behind — can't be confirmed as spanning the strip's own two sides
  //     at all: the SAME leftover division-boundary vertex commonly borders
  //     more than one residual piece at once (observed: two different
  //     leftover fragments, on either side of an earlier real cut, each
  //     still touching that cut's own endpoint), so a small poly nibbling
  //     one such fragment from its one remaining original side can share
  //     that vertex with a twin nibble on the OTHER fragment without either
  //     one actually crossing the corridor at all — treated as a notch,
  //     the same as two same-side crossings, rather than assumed to be a
  //     genuine division without evidence either way.
  // Anything other than exactly two crossings (0 — the poly swallows this
  // material whole; 4+ — a shape too irregular for this simple test) is let
  // through unfiltered rather than guessed at.
  _isNotchOnly(inside, originalEdges, clipRing, endAnchors) {
    const tol = 1e-6;
    const onOriginal = (p) => originalEdges.some(e => this._pointSegmentDistance(p, e.a, e.b) < tol);
    const onClip = (p) => clipRing.some((a, i) => this._pointSegmentDistance(p, a, clipRing[(i + 1) % clipRing.length]) < tol);

    const n = inside.length;
    const edgeIsClip = new Array(n);
    for (let i = 0; i < n; i += 1) {
      const a = inside[i].p;
      const b = inside[(i + 1) % n].p;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      edgeIsClip[i] = onClip(mid) && !onOriginal(mid);
    }
    const crossPoints = [];
    for (let i = 0; i < n; i += 1) {
      if (edgeIsClip[(i - 1 + n) % n] !== edgeIsClip[i]) crossPoints.push(inside[i].p);
    }
    if (crossPoints.length !== 2) return false;

    // The vertex exactly AT one of the corridor's own ends (an endAnchor) is
    // the seam between its 'A' run and its 'B' run — genuinely part of
    // both, not whichever one a plain edge scan happens to hit first (the
    // first-listed originalEdge touching it, always the same one, would
    // otherwise silently win every time). A crossing landing exactly there
    // can't be pinned to a side at all, so it's treated the same as landing
    // on no original edge — unknown, hence a notch (see the null case
    // below): right at the corridor's own tip, only a SEPARATE, unambiguous
    // crossing elsewhere is good evidence of a genuine cross-strip division.
    const nearAnchor = (p) => !!endAnchors && endAnchors.some(a => Math.hypot(p.x - a.x, p.y - a.y) < tol);
    const sideFor = (p) => {
      if (nearAnchor(p)) return null;
      for (const e of originalEdges) {
        if (this._pointSegmentDistance(p, e.a, e.b) < tol) return e.side;
      }
      return null;
    };
    const s1 = sideFor(crossPoints[0]);
    const s2 = sideFor(crossPoints[1]);
    if (s1 === null || s2 === null) return true;
    if (s1 === s2) return true;
    return false;
  }

  // Recursion step for getWeldedCorridors(): distributes one corridor
  // ring/piece (`points`, in the same `{ p, cut }` shape _clipHalfPlane()
  // uses) across `siblings` (one "generation" of sibling polys/subPolys —
  // initially this.polys, then, going inward, some poly's own subPolys),
  // clipping it against each sibling in turn. A sibling that only notches
  // the material (see _isNotchOnly() — `originalEdges` is the corridor's
  // own whole welded outline, captured once before any slicing and
  // threaded through unchanged all the way down the recursion) isn't used
  // as a cutting boundary at all: skip it and move on to the next sibling
  // with `points` untouched, as if it had never been tested. Otherwise,
  // whatever ends up inside a sibling recurses into THAT sibling's own
  // subPolys (or, once there are none left, is reported as a finished leaf
  // slice); whatever never lands inside any sibling belongs to
  // `parentPoly` itself (the region those siblings carve their own
  // territory out of, minus all of it — null only at the very top, for a
  // piece outside every top-level poly). A sibling that actually divides
  // the material can leave more than one disjoint leftover piece behind
  // (see _subtractConvex()) — each is tested against the remaining
  // siblings independently rather than merged back into one, since a non-
  // convex leftover can't always be represented as a single ring.
  //
  // A sibling with NO overlap at all (`inside` empty) is skipped the same
  // way, WITHOUT ever calling _subtractConvex(): subtracting nothing from
  // `points` can only ever be a no-op in exact arithmetic, but its own per-
  // edge decomposition (see _subtractConvex()'s comment) is really only
  // exercised meaningfully when the two shapes truly overlap — right at
  // this degenerate zero-overlap case it can still hand back more than one
  // piece purely from floating-point noise in nearly-symmetric geometry
  // (observed: a design's own two mirror-image halves, computed indepen-
  // dently by the solver to within a few millionths of a unit rather than
  // bit-for-bit, take a poly that plainly doesn't touch the material on
  // ONE side and spuriously "split" it there while leaving it alone on the
  // other). That spurious split then cascades into every poly tested
  // beneath it, since the two mirror halves are now recursing over
  // genuinely different `points` shapes rather than merely reaching the
  // same result by different paths — no downstream fix (welding leaves
  // back together, tie-breaking a single notch decision) can undo a
  // divergence this early. Skipping the call entirely whenever there is no
  // real material to subtract removes the chance for it.
  _sliceRingByPolyTree(points, siblings, parentPoly, pushLeaf, originalEdges, endAnchors) {
    for (let s = 0; s < siblings.length; s += 1) {
      if (points.length < 3) return;
      const poly = siblings[s];
      const clipRing = this._polyBoundaryRing(poly);
      const inside = this._clipConvexInside(points, clipRing);

      if (this._isNotchOnly(inside, originalEdges, clipRing, endAnchors)) continue;
      if (inside.length < 3) continue;

      if (poly.subPolys.length > 0) {
        this._sliceRingByPolyTree(inside, poly.subPolys, poly, pushLeaf, originalEdges, endAnchors);
      } else {
        pushLeaf(poly, inside);
      }

      const outsidePieces = this._subtractConvex(points, clipRing);
      if (outsidePieces.length <= 1) {
        points = outsidePieces[0] || [];
      } else {
        const restSiblings = siblings.slice(s + 1);
        for (const piece of outsidePieces) this._sliceRingByPolyTree(piece, restSiblings, parentPoly, pushLeaf, originalEdges, endAnchors);
        return;
      }
    }
    if (points.length >= 3) pushLeaf(parentPoly, points);
  }

  // Equivalent to nothing in the original — this SPA's own query: every
  // internal facet-corridor (see _internalCorridorFacetGroups()), welded
  // into its own outline ("welding" needs no new geometry or boolean
  // library: an edge two of the group's own facets share — an internal
  // seam — is dropped, and only the edges that appear exactly once survive,
  // chained tip-to-tail), then cut into slices wherever that outline
  // crosses a poly/subPoly boundary that cuts all the way through it (see
  // _sliceRingByPolyTree() and its own _isNotchOnly() check) — a
  // poly/subPoly that only notches the corridor from one side, without
  // separating it into two, isn't used as a cutting boundary at all. That
  // cut DOES need real polygon clipping, unlike the welding step — a
  // poly/subPoly boundary is built from real creases in the same planar
  // crease network the facets come from, but nothing guarantees it only
  // ever crosses the welded outline at an existing facet-to-facet seam;
  // it can run straight through a single facet's own interior (observed:
  // a facet quad with two corners inside a subPoly and two outside it,
  // with no facet edge anywhere near the subPoly's own boundary line),
  // which plain facet-by-facet classification can't represent at all.
  //
  // Each resulting slice's own boundary edges split into two kinds: a
  // "natural" edge was already part of the whole welded outline before any
  // slicing (the river's own long side); a "cut" edge is one
  // _sliceRingByPolyTree()'s clipping introduced, lying exactly on some
  // poly/subPoly's boundary line. A slice bounded by exactly two cut edges
  // is the "<"-shaped middle piece of a river cut on both ends (its two
  // cut edges are necessarily the same length, both being cross-cuts of
  // the same constant-width strip) — `crossing` is the point (possibly off
  // the paper) where those two cut edges' carrier lines, extended, would
  // meet; null when there aren't exactly two, or when they happen to run
  // parallel.
  //
  // Returns a flat list of `{ edge, poly, rings, cutSegments, crossing }`
  // — one entry per (corridor, region) slice. `poly` is the region
  // (possibly null, for a piece outside every top-level poly) that slice
  // came from. `rings` is a single-entry array of plain {x,y} points (not
  // tmVertex — real clipping can introduce points that aren't any existing
  // vertex), kept as an array only for shape-parity with other rendering
  // data this SPA produces.
  getWeldedCorridors() {
    const groups = this._internalCorridorFacetGroups();
    const result = [];
    for (const [edge, facetGroup] of groups) {
      for (const ring of this._weldFacetGroup(facetGroup)) {
        if (ring.length < 3) continue;
        const points = ring.map(v => ({ p: { x: v.getLocX(), y: v.getLocY() }, cut: false }));
        const { sides: ringSides, endAnchors } = this._ringEdgeSides(facetGroup, ring);
        const originalEdges = points.map((pt, i) => ({
          a: pt.p,
          b: points[(i + 1) % points.length].p,
          side: ringSides[i]
        }));

        // _sliceRingByPolyTree() can (see its own comment on
        // _subtractConvex()'s multi-piece leftovers) hand the SAME poly
        // more than one separate leaf piece for what is, geometrically,
        // one single convex region's worth of material — an artifact of
        // which edge of which sibling poly the recursion happened to
        // clip against first, not a real seam in the design (observably:
        // a mirror-symmetric design's two mirrored halves can come out
        // needing a different number of leaves for what's the same
        // shape, reflected). Collecting every leaf for this whole ring
        // first, then re-welding whichever ones share the same `poly`
        // back into one another wherever they still share an edge (same
        // technique as _weldFacetGroup(), just matching by coordinate
        // instead of shared tmVertex identity, since these pieces don't
        // share actual vertex objects), removes that seam again before
        // it can affect cut/bend detection below.
        const leaves = [];
        this._sliceRingByPolyTree(points, this.polys, null, (poly, rawSlicePoints) => {
          const slicePoints = this._dedupeRingPoints(rawSlicePoints);
          if (slicePoints.length >= 3) leaves.push({ poly, slicePoints });
        }, originalEdges, endAnchors);
        const byPoly = new Map();
        for (const { poly, slicePoints } of leaves) {
          if (!byPoly.has(poly)) byPoly.set(poly, []);
          byPoly.get(poly).push(slicePoints);
        }

        for (const [poly, pieces] of byPoly) {
          const mergedRings = pieces.length === 1 ? pieces : this._weldPointRings(pieces);
          for (const slicePoints of mergedRings) {
            if (slicePoints.length < 3) continue;
            // `ringCuts[i]` mirrors slicePoints[i].cut: true when the ring
            // edge ARRIVING at ring point i (from i-1) lies on some poly's
            // cutting boundary rather than the corridor's own natural
            // outline — i.e. it's the seam where this slice touches its
            // neighbor on the other side of that cut. Rivers view (see
            // CanvasRenderer._drawWeldedCorridors()'s `weldedRivers` mode)
            // uses this to weld same-edge slices into one river visually:
            // stroke only the natural edges, never a cut/seam edge.
            //
            // cutSegments/crossing/bends aren't computed yet here — they're
            // filled in below, in a second pass over the whole `result`
            // array, AFTER the cross-ring confirmation pass just below
            // finishes downgrading whichever of these raw cut flags turn
            // out to be unconfirmed (see that pass's own comment). Building
            // cutSegments from the raw, still-unconfirmed flags would count
            // an unconfirmed cut as a real, independent side of the sector
            // right alongside the genuine ones — inflating a ring with 2
            // real cuts (which _drawCutSector() could round into a proper
            // sector) into one that looks like it has 3+, none of which
            // ever gets rounded at all (seen on a real design: an unconfirmed
            // stray cut sitting between two confirmed ones on the SAME side
            // split what should have been one matching-radius pair into two
            // separate single-edge runs, neither able to pair with the
            // other — test/prueba24.tmd5 edge 7's corridor).
            const ringPoints = slicePoints.map(x => x.p);
            const ringCuts = slicePoints.map(x => !!x.cut);
            // `rawCuts` is a snapshot taken before the confirmation pass
            // below can downgrade `ringCuts` in place — _buildCutSegments-
            // AndCrossing() needs both: raw for a ring with a single cut
            // (see its own comment on why that one must NEVER go through
            // confirmation — a paper-boundary partner never gets a
            // matching sibling to confirm against, by construction) and
            // confirmed for a ring with 3+ raw cuts, where confirmation is
            // what tells an unconfirmed, spurious extra cut apart from the
            // two genuine ones.
            result.push({ edge, poly, rings: [ringPoints], ringCuts: [ringCuts], rawCuts: ringCuts.slice() });
          }
        }
      }
    }
    // A genuine cut (the seam between two slices of the same river, split
    // apart by some poly's own boundary) always tags BOTH slices' own copy
    // of that shared edge — one on either side of it — since each side's
    // classification comes from the SAME clip line. An edge `cut` on only
    // one side is instead the occasional case where a ring vertex lands
    // exactly on an unrelated poly's own boundary (see _clipHalfPlane()'s
    // own near-miss handling) and gets mistaken for a fresh crossing there,
    // rather than a real division — downgrading this ring's OWN copy of
    // that edge back to natural here, BEFORE cutSegments/crossing are ever
    // built from it below, keeps an unconfirmed one-sided "crossing" from
    // ever reaching _buildCutSegmentsAndCrossing() as if it were as real as
    // a confirmed one.
    const keyOf = (p) => `${p.x.toFixed(6)},${p.y.toFixed(6)}`;
    const byEdge = new Map();
    for (const r of result) {
      if (!byEdge.has(r.edge)) byEdge.set(r.edge, []);
      byEdge.get(r.edge).push(r);
    }
    for (const group of byEdge.values()) {
      const counts = new Map();
      for (const r of group) {
        const ring = r.rings[0];
        const cuts = r.ringCuts[0];
        const n = ring.length;
        for (let i = 0; i < n; i += 1) {
          if (!cuts[i]) continue;
          const ka = keyOf(ring[(i - 1 + n) % n]);
          const kb = keyOf(ring[i]);
          const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
          counts.set(key, (counts.get(key) || 0) + 1);
        }
      }
      for (const r of group) {
        const ring = r.rings[0];
        const cuts = r.ringCuts[0];
        const n = ring.length;
        for (let i = 0; i < n; i += 1) {
          if (!cuts[i]) continue;
          const ka = keyOf(ring[(i - 1 + n) % n]);
          const kb = keyOf(ring[i]);
          const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
          if ((counts.get(key) || 0) < 2) cuts[i] = false;
        }
      }
    }
    // Only now, with every ring's own `ringCuts` confirmed (unconfirmed
    // one-sided "crossings" already downgraded to false above), is it safe
    // to build each ring's cutSegments/crossing/bends from the confirmed
    // set — see _buildCutSegmentsAndCrossing()'s own comment for why it
    // still needs `rawCuts` alongside this confirmed `ringCuts`, rather
    // than confirmed alone.
    for (const r of result) {
      const { cutSegments, crossing } = this._buildCutSegmentsAndCrossing(r.rings[0], r.rawCuts, r.ringCuts[0]);
      r.cutSegments = cutSegments;
      r.crossing = crossing;
      r.bends = this._findBendVertices(r.rings[0]);
      delete r.rawCuts;
    }
    return result;
  }

  // Internal helper for _buildCutSegmentsAndCrossing(): from `ringPoints`
  // (plain {x,y}, in ring order) and `cuts` (a bool per point, true when
  // the edge ARRIVING at that same index is a cut), builds `cutSegments` —
  // one entry per contiguous run of cut edges, each the ordered polyline of
  // every point it actually passes through, not just its own two outer
  // ends. A cutting poly with more than one edge crossing the ring (a
  // quadrilateral or bigger, rather than the usual triangle) can make the
  // boundary cross two of ITS OWN edges in a row, meeting at one of the
  // poly's own corners instead of at a natural ring vertex: two separate
  // `cut`-tagged points back to back, still one side of the eventual
  // sector, not two, but with a real corner partway along it that
  // _drawCutSector() has to actually draw — collapsing it away into a
  // straight chord between the two outer ends would cut across real
  // material on one side of that corner and leave a gap on the other,
  // mismatching whatever this same cut's other side already draws there.
  //
  // The point immediately BEFORE a run starts is only sometimes part of
  // that same side: when the run is a single crossing, the point before it
  // is the only other point available to anchor the cut's own carrier
  // line, and in practice it sits exactly on that line too (this whole
  // side is a single straight cut edge, and every point of it, including
  // where it starts, lies on the cutting poly's own boundary). But when a
  // run has TWO OR MORE crossings already (a real corner of the cutting
  // poly, as above), those crossings alone already fix the line for each
  // of the run's own segments — the point before the run is then typically
  // just some OTHER, unrelated natural vertex of the corridor's own
  // material that merely happens to sit inside the cutting poly (not on
  // its boundary) before the boundary ever reaches it, since a run this
  // long only starts once the material has already been travelling
  // through the cutting poly's own interior for a stretch — including it
  // would draw a stray extra edge with no matching counterpart on the
  // neighboring slice. Collinearity with the run's own first segment tells
  // them apart.
  _buildCutRuns(ringPoints, cuts) {
    const cutSegments = [];
    const n = ringPoints.length;
    const lineTol = 1e-3;
    const onLine = (p, a, b) => {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) return false;
      return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len < lineTol;
    };
    for (let i = 0; i < n; i += 1) {
      const prevIdx = (i - 1 + n) % n;
      if (cuts[i] && !cuts[prevIdx]) {
        const prevPoint = ringPoints[prevIdx];
        const run = [];
        let j = i;
        while (true) {
          run.push(ringPoints[j]);
          const nextIdx = (j + 1) % n;
          if (!cuts[nextIdx]) break;
          j = nextIdx;
        }
        const includePrev = run.length === 1 || onLine(prevPoint, run[0], run[1]);
        cutSegments.push(includePrev ? [prevPoint, ...run] : run);
      }
    }
    return cutSegments;
  }

  // Internal helper for getWeldedCorridors(): from `ringPoints` (plain
  // {x,y}, in ring order), `rawCuts` (true when the edge ARRIVING at that
  // same index was ever flagged as a cut during slicing) and `confirmedCuts`
  // (the same, narrowed by getWeldedCorridors()'s own cross-ring-matching
  // pass to just the cuts some sibling ring also flags at the identical
  // edge), builds `cutSegments` and, if there end up being exactly two,
  // `crossing` — the point their carrier lines converge at, but only when
  // that convergence is a genuine "constant width on both sides" apex (see
  // _isMatchingRadiusPair()), never just wherever two non-parallel lines
  // happen to meet.
  //
  // `rawCuts` drives everything by default — a single raw cut (see the
  // partner-search below) is exactly the case confirmation can NEVER
  // validate, since its other side is the paper's own edge, which is never
  // itself flagged `cut` and so never gives a matching sibling to confirm
  // against; trusting confirmed-only there would silently drop the one
  // real cut a legitimate river end-cap has, losing its whole sector. Only
  // when raw building already finds 3 or more separate runs — a shape no
  // existing rule here handles — is `confirmedCuts` tried instead, on the
  // chance the spurious extra run(s) are exactly what confirmation catches
  // and dropping them reveals the real 2-cut pair underneath (seen on a
  // real design: test/prueba24.tmd5 edge 7's corridor, where one of three
  // raw runs was a stray, one-sided crossing with no matching sibling
  // anywhere, splitting what should have been one matching-radius pair
  // into two separate single-edge runs, neither able to pair with the
  // other). If confirmation doesn't resolve to exactly 2, the raw build is
  // kept — better an unrounded polygon than silently discarding real cuts
  // on a shape this rule was never designed for.
  _buildCutSegmentsAndCrossing(ringPoints, rawCuts, confirmedCuts) {
    let cutSegments = this._buildCutRuns(ringPoints, rawCuts);
    if (cutSegments.length >= 3) {
      const confirmedSegments = this._buildCutRuns(ringPoints, confirmedCuts);
      if (confirmedSegments.length === 2) cutSegments = confirmedSegments;
    }
    const slicePoints = ringPoints.map((p, i) => ({ p, cut: rawCuts[i] }));
    const outerEnds = (side) => [side[0], side[side.length - 1]];
    // A slice cut on only one side by a real poly/subPoly boundary can
    // still be the "<"-shaped middle of a river, when its OTHER side
    // already runs along the paper's own edge (a leaf pinned to a paper
    // corner, say) rather than another poly: the paper edge itself never
    // gets a `cut` tag (nothing "cuts" it — it's the outermost boundary
    // there is), but it plays exactly the same role. Pairing the lone real
    // cut with a same-side run of paper-boundary edges — if the two
    // carrier lines cross with matching near/far radii from that crossing,
    // the same "constant width" signature every real cut/bend shares —
    // completes the pair.
    if (cutSegments.length === 1) {
      const cutEnds = outerEnds(cutSegments[0]);
      const candidates = [
        ...this._boundaryEdgeCandidates(slicePoints),
        ...this._adjacentEdgeCandidates(slicePoints, cutEnds),
      ];
      const partner = candidates.find(candidate => this._isMatchingRadiusPair(cutEnds, candidate));
      if (partner) cutSegments = [cutSegments[0], partner];
    }
    // Two independent real cuts (as opposed to the single-cut+partner-
    // search case above) never had their own "constant width" checked
    // against each other before computing `crossing` — _isMatchingRadiusPair()
    // (already used just above, for the partner search) is exactly that
    // check: near/far distances from the crossing point matching within 5%
    // on both sides is the same "real corridor wall, not a coincidental
    // line crossing" signature either way, whether the second cut came
    // from a partner search or was always there. Skipping it here let two
    // cuts whose carrier lines happen to cross SOMEWHERE (any two non-
    // parallel lines do) stand in as a bend's apex even when neither cut's
    // own actual extent comes anywhere near that point and the two "radii"
    // pairs don't match at all — seen on real designs as a wildly wrong
    // sector (test/prueba23.tmd5 edge 3's corridor in poly 1;
    // test/prueba22.tmd5 edge 5's corridor in poly 2) instead of the plain
    // quadrangular slice the two cuts actually bound. Requiring the match
    // uses the exact same test a legitimate zero-inner-radius apex already
    // passes (both sides' near distance is 0, and 0 always matches 0), so
    // no separate carve-out is needed for that case.
    const crossing = cutSegments.length === 2 && this._isMatchingRadiusPair(outerEnds(cutSegments[0]), outerEnds(cutSegments[1]))
      ? this._lineIntersection(outerEnds(cutSegments[0]), outerEnds(cutSegments[1]))
      : null;
    return { cutSegments, crossing };
  }

  // Internal helper for getWeldedCorridors(): re-welds `pieces` (each a
  // closed ring of `{ p: {x,y}, cut }`, all belonging to the SAME poly)
  // into as few rings as the material actually needs, on the chance
  // _sliceRingByPolyTree() hung more than one leaf off that poly for what
  // is really just one contiguous region — see getWeldedCorridors()'s own
  // comment on why that can happen. Same tip-to-tail edge-welding as
  // _weldFacetGroup() (an edge two pieces share — one appearing once in
  // each piece's own boundary — is an artifact seam between them and gets
  // dropped; whatever's left, appearing in only one piece, is the merged
  // region's real outer boundary), just matching edges by rounded
  // coordinate instead of shared tmVertex identity, since two different
  // clipped pieces never actually share a point OBJECT even where they
  // share a location.
  _weldPointRings(pieces) {
    const keyOf = (p) => `${p.x.toFixed(6)},${p.y.toFixed(6)}`;
    // A point right where two pieces join can carry a genuine `cut: true`
    // in ONE piece's own boundary (that piece's clip produced it as a
    // fresh crossing) while the OTHER piece only ever saw it as an
    // inherited, unremarkable point along its own edge (`cut: false`) —
    // both describe the exact same real corner, just from each piece's own
    // partial view of it. Picking whichever piece's edge the final chain
    // happens to arrive from (as this used to) silently drops the other
    // piece's `true`, and which piece "wins" isn't even the same between a
    // design's own mirror-symmetric halves — the true flag survives on one
    // side and gets lost on the other purely from which piece's remaining
    // edges the weld happened to consume first, fragmenting one side's
    // cutSegments differently from its mirror's. Recording every point's
    // own flag by coordinate first, OR-combined across every piece that
    // mentions it, keeps a real crossing real no matter which piece's edge
    // the final ring ends up reaching it through — except right on the
    // paper's own boundary, which no poly/subPoly clip ever produces (the
    // paper rectangle isn't among the polys _sliceRingByPolyTree() clips
    // against at all): a `cut: true` landing exactly there in even one
    // piece is itself the same kind of stray artifact _dedupeRingPoints()
    // already guards against elsewhere, not a real crossing to preserve,
    // and OR-combining it in would draw a spurious extra corner into what
    // should be one plain straight run along the paper's edge.
    const onPaperEdge = (p) => (
      Math.abs(p.x) < 1e-6 || Math.abs(p.x - this.paperWidth) < 1e-6 ||
      Math.abs(p.y) < 1e-6 || Math.abs(p.y - this.paperHeight) < 1e-6
    );
    const pointCut = new Map();
    for (const piece of pieces) {
      for (const pt of piece) {
        const k = keyOf(pt.p);
        const cut = pt.cut && !onPaperEdge(pt.p);
        pointCut.set(k, (pointCut.get(k) || false) || cut);
      }
    }
    const segCount = new Map();
    const segInfo = new Map();
    for (const piece of pieces) {
      const n = piece.length;
      for (let i = 0; i < n; i += 1) {
        const a = piece[i].p;
        const bRec = piece[(i + 1) % n];
        const ka = keyOf(a);
        const kb = keyOf(bRec.p);
        const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
        segCount.set(key, (segCount.get(key) || 0) + 1);
        segInfo.set(key, { a, b: bRec.p });
      }
    }

    const remaining = [...segCount.entries()]
      .filter(([, count]) => count === 1)
      .map(([key]) => segInfo.get(key));

    // A clean weld needs every surviving boundary point to touch exactly
    // 2 of these edges — same as any simple polygon. More than 2 means
    // several pieces (or the SAME piece more than once) merely touch at a
    // single point without sharing a full edge there — a multi-way hub
    // several corridors/wedges converge on, common in a more complex
    // design — where tip-to-tail chaining can't tell which continuation
    // is correct and risks stitching an invalid, self-crossing ring.
    // Bailing out to the untouched pieces is always safe: it just leaves
    // this poly's material as the separate leaves _sliceRingByPolyTree()
    // already produced, same as before this method ever ran.
    const degree = new Map();
    for (const seg of remaining) {
      const ka = keyOf(seg.a);
      const kb = keyOf(seg.b);
      degree.set(ka, (degree.get(ka) || 0) + 1);
      degree.set(kb, (degree.get(kb) || 0) + 1);
    }
    if ([...degree.values()].some(d => d > 2)) return pieces;

    const rings = [];
    while (remaining.length > 0) {
      const seg0 = remaining.shift();
      const startKey = keyOf(seg0.a);
      const ring = [{ p: seg0.a, cut: pointCut.get(startKey) || false }];
      let curPoint = seg0.b;
      while (keyOf(curPoint) !== startKey) {
        ring.push({ p: curPoint, cut: pointCut.get(keyOf(curPoint)) || false });
        const curKey = keyOf(curPoint);
        const idx = remaining.findIndex(s => keyOf(s.a) === curKey || keyOf(s.b) === curKey);
        if (idx === -1) break; // open chain — shouldn't happen for a valid weld
        const seg = remaining.splice(idx, 1)[0];
        curPoint = keyOf(seg.a) === curKey ? seg.b : seg.a;
      }
      rings.push(ring);
    }
    return rings;
  }

  // Internal helper for getWeldedCorridors(): every stretch of
  // `slicePoints` lying along the SAME edge of the paper (consecutive
  // points all sharing x=0, all sharing x=paperWidth, etc.), as a candidate
  // `[a, b]` segment between any two of that run's own points — not just
  // its outer two endpoints — the same shape a real cut comes in. Multiple
  // points along one paper edge happen whenever the slice's own facets meet
  // that edge at more than one spot (a facet corner touching it partway
  // along, say); the run's own FULL span is one such facet-corner-to-facet-
  // corner stretch, but a facet corner partway along it can just as well be
  // where THIS slice's own true paper contact actually ends and a
  // DIFFERENT neighboring slice's own contact continues, collinear but not
  // really the same edge for constant-width-matching purposes — trying
  // every sub-span, not just the outer one, lets _isMatchingRadiusPair()
  // find whichever one actually shares this slice's own cut's width instead
  // of only ever seeing the longest, possibly-too-long, candidate.
  _boundaryEdgeCandidates(slicePoints) {
    const width = this.paperWidth;
    const height = this.paperHeight;
    const side = (p) => {
      if (Math.abs(p.x) < 1e-4) return 'L';
      if (Math.abs(p.x - width) < 1e-4) return 'R';
      if (Math.abs(p.y) < 1e-4) return 'T';
      if (Math.abs(p.y - height) < 1e-4) return 'B';
      return null;
    };
    const n = slicePoints.length;
    const sides = slicePoints.map(sp => side(sp.p));
    const candidates = [];
    for (let i = 0; i < n; i += 1) {
      if (!sides[i]) continue;
      const prevIdx = (i - 1 + n) % n;
      if (sides[prevIdx] === sides[i]) continue; // mid-run, not a run start
      const runIdx = [i];
      let j = i;
      while (sides[(j + 1) % n] === sides[i] && (j + 1) % n !== i) {
        j = (j + 1) % n;
        runIdx.push(j);
      }
      for (let a = 0; a < runIdx.length; a += 1) {
        for (let b = a + 1; b < runIdx.length; b += 1) {
          candidates.push([slicePoints[runIdx[a]].p, slicePoints[runIdx[b]].p]);
        }
      }
    }
    return candidates;
  }

  // Internal helper for getWeldedCorridors(): every natural (non-cut) edge
  // of `slicePoints` that touches one of `cutEnds`' own two endpoints — a
  // second candidate a lone real cut can pair with to complete a sector,
  // alongside _boundaryEdgeCandidates()'s paper-edge runs. A poly/subPoly
  // boundary that happens to cross the corridor exactly AT an existing
  // natural vertex, rather than out in the middle of some facet edge,
  // leaves that vertex as the shared apex of a genuine CIRCULAR sector —
  // inner radius zero, since the cut and this natural edge both start
  // there — with the natural edge's own far end anchoring the sector's
  // other straight side and an outward-bulging arc (through whatever
  // convex natural corners lie between the two far ends) replacing what
  // would otherwise stay a plain angular corner. _isMatchingRadiusPair()'s
  // own length check, not mere ring adjacency, is what actually confirms a
  // real match, so offering every edge touching either end costs nothing
  // when it isn't one.
  _adjacentEdgeCandidates(slicePoints, cutEnds) {
    const tol = 1e-6;
    const same = (p, q) => Math.hypot(p.x - q.x, p.y - q.y) < tol;
    const n = slicePoints.length;
    const candidates = [];
    for (let i = 0; i < n; i += 1) {
      const a = slicePoints[i].p;
      const b = slicePoints[(i + 1) % n].p;
      const isCutEdge = (same(a, cutEnds[0]) && same(b, cutEnds[1])) || (same(a, cutEnds[1]) && same(b, cutEnds[0]));
      if (isCutEdge) continue;
      if (same(a, cutEnds[0]) || same(b, cutEnds[0]) || same(a, cutEnds[1]) || same(b, cutEnds[1])) {
        candidates.push([a, b]);
      }
    }
    return candidates;
  }

  // Internal helper for getWeldedCorridors(): true when segments `seg1`
  // and `seg2`'s carrier lines cross at a point equally far (within 5%)
  // from each segment's own near end, and again from each one's own far
  // end — the "constant width along its whole run" signature that ties a
  // real cut to whatever its matching partner is (another real cut for
  // the ordinary case, or a paper-boundary run — see
  // _boundaryEdgeCandidates() — when a river runs off the paper before a
  // second poly/subPoly boundary ever cuts it).
  _isMatchingRadiusPair(seg1, seg2) {
    const crossing = this._lineIntersection(seg1, seg2);
    if (!crossing) return false;
    const dist = (p) => Math.hypot(p.x - crossing.x, p.y - crossing.y);
    const [n1, f1] = [dist(seg1[0]), dist(seg1[1])].sort((a, b) => a - b);
    const [n2, f2] = [dist(seg2[0]), dist(seg2[1])].sort((a, b) => a - b);
    const close = (a, b) => Math.abs(a - b) < 0.05 * Math.max(a, b, 1e-6);
    return close(n1, n2) && close(f1, f2);
  }

  // A river doesn't always run straight — the tree edge's own zigzag path
  // through the crease pattern can bend, and where it does, one side of
  // the welded outline (this method looks at one ring at a time) gets a
  // convex corner (fine as a plain corner) while the OTHER gets a
  // concave, inward-pointing notch: the same "<" wedge shape
  // getWeldedCorridors()'s two-cuts-converging-outside case already
  // rounds into a sector, just formed differently here — instead of two
  // SEPARATE cut edges whose carrier lines meet somewhere outside the
  // ring, it's two edges that already meet each other, directly, at one
  // shared ring vertex. Equal length (the same "constant width along its
  // whole run" signature every cut/bend in a corridor shares) is what
  // tells a genuine bend apart from an ordinary concave corner that just
  // happens to exist in the design elsewhere. Returns
  // `{ index, radius }` per bend found — `index` into `points`, `radius`
  // the (averaged) length of its two matching edges, i.e. the corner's
  // own rounding radius when CanvasRenderer draws it as an arc centered
  // on that vertex.
  _findBendVertices(points) {
    const n = points.length;
    if (n < 3) return [];
    let area = 0;
    for (let i = 0; i < n; i += 1) {
      const a = points[i];
      const b = points[(i + 1) % n];
      area += a.x * b.y - b.x * a.y;
    }
    const ccw = area > 0;
    const bends = [];
    for (let i = 0; i < n; i += 1) {
      const prev = points[(i - 1 + n) % n];
      const cur = points[i];
      const next = points[(i + 1) % n];
      const v1 = { x: cur.x - prev.x, y: cur.y - prev.y };
      const v2 = { x: next.x - cur.x, y: next.y - cur.y };
      const cross = v1.x * v2.y - v1.y * v2.x;
      const isConcave = ccw ? cross < -1e-9 : cross > 1e-9;
      if (!isConcave) continue;
      const len1 = Math.hypot(v1.x, v1.y);
      const len2 = Math.hypot(v2.x, v2.y);
      if (Math.abs(len1 - len2) > 0.02 * Math.max(len1, len2)) continue;
      bends.push({ index: i, radius: (len1 + len2) / 2 });
    }
    return bends;
  }

  // Welds a group of facets into one or more closed outline rings of
  // tmVertex, by dropping any edge shared by two of the group's own facets
  // (an internal seam) and chaining what's left (each appearing exactly
  // once) tip-to-tail.
  _weldFacetGroup(facetGroup) {
    const segCount = new Map();
    const segEndpoints = new Map();
    for (const facet of facetGroup) {
      const verts = facet.getVertices();
      for (let i = 0; i < verts.length; i += 1) {
        const a = verts[i];
        const b = verts[(i + 1) % verts.length];
        const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
        segCount.set(key, (segCount.get(key) || 0) + 1);
        segEndpoints.set(key, [a, b]);
      }
    }

    const remaining = [...segCount.entries()]
      .filter(([, count]) => count === 1)
      .map(([key]) => segEndpoints.get(key));

    const rings = [];
    while (remaining.length > 0) {
      const [start, firstNext] = remaining.shift();
      const ring = [start];
      let cur = firstNext;
      while (cur !== start) {
        ring.push(cur);
        const idx = remaining.findIndex(([a, b]) => a === cur || b === cur);
        if (idx === -1) break; // open chain — shouldn't happen for a valid weld
        const [a, b] = remaining.splice(idx, 1)[0];
        cur = a === cur ? b : a;
      }
      rings.push(ring);
    }
    return rings;
  }

  // Intersection of the infinite lines through segments `[a, b]` and
  // `[c, d]` (plain {x,y} points), or null if they're parallel (or nearly
  // so). The parallel test is on the cross product of the two segments'
  // NORMALIZED direction vectors (i.e. sin of the angle between them), not
  // the raw, unnormalized cross product `denom` used for the actual
  // intersection below — `denom` scales with both segments' lengths, so a
  // fixed absolute epsilon on it only catches near-parallel pairs when the
  // segments happen to be long; two short cut segments that are merely a
  // fraction of a degree off parallel (a common, legitimate case for a
  // corridor's two constant-width cut sides) sail through with a tiny but
  // nonzero `denom`, producing an "intersection" thousands of units away —
  // a wrong crossing point that then makes a wildly out-of-bounds sector,
  // one whose canvas rendering has been observed to vary by browser engine
  // rather than simply drawing something visibly wrong everywhere. The
  // normalized test is invariant to segment length, so it correctly reads
  // this as "no real crossing" and falls back to the plain ring outline.
  _lineIntersection([a, b], [c, d]) {
    const d1x = b.x - a.x, d1y = b.y - a.y;
    const d2x = d.x - c.x, d2y = d.y - c.y;
    const len1 = Math.hypot(d1x, d1y), len2 = Math.hypot(d2x, d2y);
    if (len1 < 1e-12 || len2 < 1e-12) return null;
    const sinAngle = (d1x * d2y - d1y * d2x) / (len1 * len2);
    if (Math.abs(sinAngle) < 1e-4) return null;
    const denom = (a.x - b.x) * (c.y - d.y) - (a.y - b.y) * (c.x - d.x);
    const t = ((a.x - c.x) * (c.y - d.y) - (a.y - c.y) * (c.x - d.x)) / denom;
    return new tmPoint(a.x + t * (b.x - a.x), a.y + t * (b.y - a.y));
  }

  // Every edge (each as its two tmVertex) `facet` shares with `other` — both
  // edges are the same two points, in either order. Usually at most one,
  // but two facets can legitimately share TWO consecutive edges at once
  // (observed: a facet whose own middle vertex, between those two edges, is
  // a degree-2 point that carries no crease of its own — nothing along the
  // whole real crease pattern actually separates the two edges there, so
  // both read as shared) — getRiverEndCaps() needs every one of them, not
  // just whichever this scan happens to reach first, or it mistakes that
  // middle vertex for a free tip of the facet rather than the fully-shared,
  // consumed vertex it actually is. Internal helper for getRiverEndCaps().
  _facetSharedEdgesWith(facet, other) {
    const verts = facet.getVertices();
    const overts = other.getVertices();
    const shared = [];
    for (let i = 0; i < verts.length; i += 1) {
      const a = verts[i];
      const b = verts[(i + 1) % verts.length];
      for (let j = 0; j < overts.length; j += 1) {
        const c = overts[j];
        const d = overts[(j + 1) % overts.length];
        if ((a === c && b === d) || (a === d && b === c)) { shared.push([a, b]); break; }
      }
    }
    return shared;
  }

  // The first edge (as its two tmVertex) `facet` shares with `other`, or
  // null if they don't share one — see _facetSharedEdgesWith() when more
  // than one might matter. Internal helper for getRiverEndCaps().
  _facetSharedEdgeWith(facet, other) {
    return this._facetSharedEdgesWith(facet, other)[0] || null;
  }

  // Equivalent to nothing in the original — Blueprint View's own query: the
  // "end caps" of each internal river (see _internalCorridorFacetGroups())
  // — the true loose ends of its facet chain, as opposed to the long
  // zigzag sides running its length or the internal seams between
  // consecutive facets (which getWeldedCorridors() may or may not cut,
  // depending on whether a poly/subPoly boundary happens to cross there).
  //
  // A facet's edges split into those it shares with another facet in the
  // same group (an internal seam) and those it doesn't. For an ordinary
  // facet in the middle of the chain, the unshared edges are its own two
  // long sides — never adjacent to each other, so marking every vertex that
  // touches ANY shared edge leaves no vertex untouched at all (each corner
  // sits on one shared edge or the other). A facet at a real dead end is
  // different: however many neighbors it has, their shared edges leave a
  // single contiguous run of untouched vertices — the free tip sticking out
  // past the rest of the river. This is deliberately NOT restricted to
  // facets with exactly one neighbor: a facet can sit on a genuine loose
  // end while still bordering two others, when the branch that meets it
  // there loops back on itself (observed: a tiny gusset-bounded facet right
  // at a branch node, whose two neighbors' shared edges happen to be
  // adjacent to each other rather than opposite, leaving the facet's other,
  // unrelated edges as a real tip the degree-1 test alone would miss). A
  // facet fully consumed by its neighbors (every vertex touched, as at an
  // ordinary pass-through facet, or at a branch facet with 3+ neighbors
  // meeting with no free edge of its own left over) or one whose untouched
  // vertices split into more than one separate run (ambiguous — which run
  // is the real cap?) isn't a cap at all. Returns a flat list of
  // `{ edge, a, b, outward }` — `a`/`b` the two tmVertex flanking the run
  // (its own interior vertices, if any, aren't needed: getRiverExtensions()
  // only extrudes a straight cap between them), `outward` the unit vector
  // away from the rest of the river, along which getRiverExtensions()
  // continues it.
  getRiverEndCaps() {
    const groups = this._internalCorridorFacetGroups();
    const caps = [];
    for (const [edge, facetGroup] of groups) {
      const neighborsOf = new Map(facetGroup.map(f => [f, []]));
      for (let i = 0; i < facetGroup.length; i += 1) {
        for (let j = i + 1; j < facetGroup.length; j += 1) {
          if (this._facetSharedEdgeWith(facetGroup[i], facetGroup[j])) {
            neighborsOf.get(facetGroup[i]).push(facetGroup[j]);
            neighborsOf.get(facetGroup[j]).push(facetGroup[i]);
          }
        }
      }
      for (const facet of facetGroup) {
        const neighbors = neighborsOf.get(facet);
        if (neighbors.length === 0) continue; // whole river is one facet — genuinely ambiguous, skip
        const verts = facet.getVertices();
        const n = verts.length;
        const touched = new Array(n).fill(false);
        for (const other of neighbors) {
          for (const [a, b] of this._facetSharedEdgesWith(facet, other)) {
            const idxA = verts.indexOf(a);
            const idxB = verts.indexOf(b);
            if (idxA !== -1) touched[idxA] = true;
            if (idxB !== -1) touched[idxB] = true;
          }
        }
        const startIdx = touched.indexOf(true);
        if (startIdx === -1 || touched.every(t => t)) continue;
        const runs = [];
        let cur = null;
        for (let k = 0; k < n; k += 1) {
          const idx = (startIdx + k) % n;
          if (!touched[idx]) {
            if (!cur) { cur = []; runs.push(cur); }
            cur.push(idx);
          } else {
            cur = null;
          }
        }
        if (runs.length !== 1 || runs[0].length < 2) continue;
        const run = runs[0];
        const a = verts[run[0]];
        const b = verts[run[run.length - 1]];
        const centroidOf = (pts) => ({
          x: pts.reduce((sum, v) => sum + v.getLocX(), 0) / pts.length,
          y: pts.reduce((sum, v) => sum + v.getLocY(), 0) / pts.length
        });
        const touchedMid = centroidOf(verts.filter((_, i) => touched[i]));
        const capMid = centroidOf(run.map(i => verts[i]));
        const outward = this._normalize2D({ x: capMid.x - touchedMid.x, y: capMid.y - touchedMid.y });
        caps.push({ edge, a, b, outward });
      }
    }
    return caps;
  }

  _normalize2D(v) {
    const len = Math.hypot(v.x, v.y);
    return len > 1e-9 ? { x: v.x / len, y: v.y / len } : { x: 0, y: 0 };
  }

  // How far (as a multiple of `dir`, a unit vector) `origin` travels before
  // leaving the [0, width] x [0, height] rectangle — the paper — or
  // Infinity if `dir` never carries it out (a zero component parallel to a
  // pair of edges it's already between). Internal helper for
  // getRiverExtensions(): the same ray-vs-axis-aligned-box exit distance
  // _drawSymmetryLines() computes in CanvasRenderer, reused here in model
  // space instead of screen space.
  _rayExitDistance(origin, dir, width, height) {
    let t = Infinity;
    if (dir.x > 1e-9) t = Math.min(t, (width - origin.x) / dir.x);
    else if (dir.x < -1e-9) t = Math.min(t, (0 - origin.x) / dir.x);
    if (dir.y > 1e-9) t = Math.min(t, (height - origin.y) / dir.y);
    else if (dir.y < -1e-9) t = Math.min(t, (0 - origin.y) / dir.y);
    return t;
  }

  // Equivalent to nothing in the original — Blueprint View's own query:
  // Robert Lang's tree-theory rivers run the full length of the tree edge
  // they represent, but this SPA's own crease-pattern-derived rendering
  // (getWeldedCorridors()) only ever covers however much of that a real
  // facet happens to fill — which can end well short of the paper, deep in
  // open territory the crease pattern never needed to touch. This extends
  // each of getRiverEndCaps()'s two loose ends, straight out along its own
  // `outward` direction at the SAME width as the cap itself (the same
  // "constant width along its whole run" rule every welded/sliced piece
  // already follows).
  //
  // The cap's own two corners are, in general, different distances from
  // the paper's edge along that shared direction (only a cap running
  // exactly parallel to the edge it's headed for would tie) — so extending
  // by the SHORTER of the two distances would stop one corner short of the
  // edge, while the other has already reached it. Extending by the LONGER
  // one instead guarantees the whole strip is at least "completely
  // inscribed in the paper" along BOTH of its own long sides — but not
  // necessarily enough to cover a paper CORNER the strip runs past at an
  // angle: the corner can sit well within the strip's own width (between
  // its two long sides, extended) while still being farther from the cap
  // than either individual corner's own exit distance, since those two
  // exit distances are measured along parallel rays through DIFFERENT
  // points (pa and pb), not through the corner itself. Padding the longer
  // distance by a full paper diagonal guarantees the strip reaches well
  // past any point in the paper regardless of angle, so the corner is
  // never missed; clipping the resulting (now generously oversized) quad
  // against the paper rectangle — _clipConvexInside() again, the paper
  // being just another convex polygon — trims away all of that overshoot,
  // leaving a strip flush with the paper's edge (corners included)
  // everywhere along it.
  //
  // Returns a flat list of `{ edge, rings }`, one entry per end cap that
  // still needed extending, in the same shape getWeldedCorridors() uses
  // for rendering.
  getRiverExtensions() {
    const width = this.paperWidth;
    const height = this.paperHeight;
    const paperRing = [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }];
    const overshoot = Math.hypot(width, height);
    const result = [];
    for (const { edge, a, b, outward } of this.getRiverEndCaps()) {
      const pa = { x: a.getLocX(), y: a.getLocY() };
      const pb = { x: b.getLocX(), y: b.getLocY() };
      const t = overshoot + Math.max(
        this._rayExitDistance(pa, outward, width, height),
        this._rayExitDistance(pb, outward, width, height)
      );
      if (!Number.isFinite(t) || t <= 1e-6) continue;
      const qa = { x: pa.x + outward.x * t, y: pa.y + outward.y * t };
      const qb = { x: pb.x + outward.x * t, y: pb.y + outward.y * t };
      // The pa->pb edge is the cap itself — the corridor's own end, where
      // this extension is welded on. Marking pb's own `cut` (the same
      // "edge arriving at this point is a seam" convention getWeldedCor-
      // ridors() uses) lets Rivers view (see CanvasRenderer._drawWelded-
      // Corridors()'s `weldedRivers` mode) skip stroking exactly that
      // edge, same as any other seam between two pieces of one river.
      const clipped = this._dedupeRingPoints(this._clipConvexInside(
        [{ p: pa, cut: false }, { p: pb, cut: true }, { p: qb, cut: false }, { p: qa, cut: false }],
        paperRing
      ));
      if (clipped.length < 3) continue;
      result.push({ edge, rings: [clipped.map(c => c.p)], ringCuts: [clipped.map(c => !!c.cut)] });
    }
    return result;
  }

  // ===== SETTERS =====

  setPaperWidth(width) {
    const value = Number(width);
    if (!Number.isFinite(value) || value <= 0) throw new RangeError('Paper width must be finite and positive');
    this.paperWidth = value;
    this.invalidate();
  }

  setPaperHeight(height) {
    const value = Number(height);
    if (!Number.isFinite(value) || value <= 0) throw new RangeError('Paper height must be finite and positive');
    this.paperHeight = value;
    this.invalidate();
  }

  setScale(scale) {
    const value = Number(scale);
    if (!Number.isFinite(value) || value <= 0) throw new RangeError('Scale must be finite and positive');
    this.scale = value;
    this.invalidate();
  }

  setHasSymmetry(hasSymmetry) {
    this.hasSymmetry = Boolean(hasSymmetry);
    this.invalidate();
  }

  setSymLoc(point) {
    this.symLoc = point instanceof tmPoint ? point.clone() : new tmPoint(point.x, point.y);
    this.invalidate();
  }

  setSymAngle(angle) {
    this.symAngle = Number(angle);
    this.invalidate();
  }

  setSymmetry(point, angle) {
    this.setSymLoc(point);
    this.setSymAngle(angle);
  }

  // ===== TREE EDITING =====

  /**
   * Add a new node connected to an existing node by an edge
   * @param {tmNode} fromNode - existing node
   * @param {tmPoint} wherePoint - location for new node
   * @returns {{node: tmNode, edge: tmEdge}}
   */
  addNode(fromNode, wherePoint) {
    if (!fromNode || !this.nodes.includes(fromNode)) {
      throw new Error('fromNode must belong to the tree');
    }
    if (!wherePoint || !Number.isFinite(Number(wherePoint.x)) || !Number.isFinite(Number(wherePoint.y))) {
      throw new TypeError('wherePoint must contain finite coordinates');
    }
    const newNode = new tmNode(null, wherePoint);
    newNode.label = this._nextNodeLabel();
    const newEdge = new tmEdge(null, fromNode, newNode);
    newEdge.length = fromNode.location.distance(wherePoint);
    
    this.nodes.push(newNode);
    newNode.ownerTree = this;
    this.edges.push(newEdge);
    this.invalidatePaths();
    
    // Set root if this is first node
    if (this.nodes.length === 1) {
      this.rootNode = newNode;
      newNode.isRootNode = true;
    }

    this.invalidate();
    this.refreshNodeClassification();
    return { node: newNode, edge: newEdge };
  }

  addEdge(node1, node2, length = null) {
    if (!node1 || !node2 || node1 === node2 || !this.nodes.includes(node1) || !this.nodes.includes(node2)) {
      throw new Error('Both edge endpoints must be distinct nodes in the tree');
    }
    if (this.getEdge(node1, node2)) throw new Error('An edge already connects these nodes');
    const geometricLength = node1.location.distance(node2.location);
    if (!Number.isFinite(geometricLength) || geometricLength <= 0) throw new RangeError('Edge endpoints must not coincide');
    const edge = new tmEdge(null, node1, node2);
    edge.ownerTree = this;
    edge.length = length === null ? geometricLength : Number(length);
    if (!Number.isFinite(edge.length) || edge.length < 0) throw new RangeError('Edge length must be finite and non-negative');
    this.edges.push(edge);
    this.invalidatePaths();
    this.invalidate();
    this.refreshNodeClassification();
    return edge;
  }

  /**
   * Raw topology disconnect shared by removeEdge()/removeNode(): detaches
   * `edge` from both its nodes and the tree's own edge/condition lists,
   * with no cascade logic of its own. Returns the edge's two (former)
   * nodes so the caller can check whether either was just orphaned.
   * @private
   */
  _disconnectEdge(edge) {
    const [first, second] = edge.getNodes();
    first?.removeEdge(edge);
    second?.removeEdge(edge);
    this.edges = this.edges.filter(item => item !== edge);
    this.conditions = this.conditions.filter(condition => !condition?.uses?.(edge));
    return [first, second];
  }

  removeEdge(edge) {
    if (!this.edges.includes(edge)) return false;
    const [first, second] = this._disconnectEdge(edge);
    this.invalidatePaths();
    this.invalidate();
    // Equivalent to tmTree::KillSomeNodesAndEdges()'s "if a node has every
    // edge killed, the node is killed too": deleting an edge can leave one
    // of its endpoints (or, for a 2-node tree, both) with zero remaining
    // edges. Such a node isn't part of the tree anymore — left behind
    // as-is, it becomes an orphaned point nothing else references, with
    // no obvious way for the user to select or remove it afterward.
    for (const candidate of [first, second]) {
      if (candidate && this.nodes.includes(candidate) && candidate.getEdges().length === 0) {
        this.removeNode(candidate);
      }
    }
    this.recalculateFeasibility();
    return true;
  }

  removeNode(node) {
    if (!this.nodes.includes(node)) return false;
    const neighbors = new Set();
    for (const edge of [...node.getEdges()]) {
      const [first, second] = this._disconnectEdge(edge);
      for (const other of [first, second]) {
        if (other && other !== node) neighbors.add(other);
      }
    }
    this.conditions = this.conditions.filter(condition => !condition?.uses?.(node));
    this.nodes = this.nodes.filter(item => item !== node);
    if (this.rootNode === node) this.rootNode = null;
    this.invalidatePaths();
    this.invalidate();
    this.refreshNodeClassification();
    // A neighbor that was ONLY connected to this node is now orphaned too
    // — same cascade as removeEdge() above (e.g. deleting a branch node
    // strips its stub leaves along with it).
    for (const neighbor of neighbors) {
      if (this.nodes.includes(neighbor) && neighbor.getEdges().length === 0) {
        this.removeNode(neighbor);
      }
    }
    this.recalculateFeasibility();
    return true;
  }

  // Equivalent to tmTree::HasRedundantNodes().
  hasRedundantNodes() {
    return this.nodes.some(node => node.isRedundant());
  }

  // Equivalent to tmTree::CanAbsorbNode(): only a degree-2 node can be
  // absorbed (its two edges merge into one).
  canAbsorbNode(node) {
    return !!node && node.isRedundant();
  }

  /**
   * Equivalent to tmTree::AbsorbNode() (the inverse of splitEdge()):
   * merges a degree-2 node's two edges into a single new edge, and
   * removes the node. The new edge is unstrained, with length equal to
   * the sum of the two original edges' strained lengths. Absorbing
   * changes edge/path topology enough that any existing crease pattern
   * would be corrupted, so it's torn down first (matches the original's
   * own comment on why AbsorbNode() calls KillPolysAndCreasePattern()).
   * Returns the new edge.
   */
  absorbNode(node) {
    if (!this.canAbsorbNode(node)) throw new Error('Node cannot be absorbed: must have exactly 2 incident edges');
    const [edge1, edge2] = node.getEdges();
    const node1 = edge1.getOtherNode(node);
    const node2 = edge2.getOtherNode(node);

    this.killPolysAndCreasePattern();

    const newEdge = new tmEdge(null, node1, node2);
    newEdge.ownerTree = this;
    newEdge.length = edge1.getStrainedLength() + edge2.getStrainedLength();

    node1.removeEdge(edge1);
    node2.removeEdge(edge2);
    this.edges = this.edges.filter(e => e !== edge1 && e !== edge2);
    this.edges.push(newEdge);
    this.nodes = this.nodes.filter(n => n !== node);
    // No natural successor for a plain removal (unlike absorbEdge(), where
    // the merge has an obvious survivor) — matches removeNode()'s own
    // convention in this port.
    if (this.rootNode === node) this.rootNode = null;

    this.conditions = this.conditions.filter(condition => (
      !condition?.uses?.(node) && !condition?.uses?.(edge1) && !condition?.uses?.(edge2)
    ));

    this.invalidatePaths();
    this.invalidate();
    this.refreshNodeClassification();
    return newEdge;
  }

  // Equivalent to tmTree::CanAbsorbNodes().
  canAbsorbNodes(nodeList) {
    return nodeList.every(node => this.canAbsorbNode(node));
  }

  // Equivalent to tmTree::AbsorbNodes(): absorbs every node in the list
  // (a local copy, since absorbing shrinks this.nodes as it goes).
  absorbNodes(nodeList) {
    const list = [...nodeList];
    if (!this.canAbsorbNodes(list)) throw new Error('Not every node in the list can be absorbed');
    for (const node of list) this.absorbNode(node);
  }

  // Equivalent to tmTree::CanAbsorbRedundantNodes().
  canAbsorbRedundantNodes() {
    return this.hasRedundantNodes();
  }

  // Equivalent to tmTree::AbsorbRedundantNodes(): absorbs every degree-2
  // node in the tree. Iterates backwards since absorbing shrinks
  // this.nodes as it goes.
  absorbRedundantNodes() {
    for (let i = this.nodes.length - 1; i >= 0; i -= 1) {
      const node = this.nodes[i];
      if (node.isRedundant()) this.absorbNode(node);
    }
  }

  // Equivalent to tmTree::CanAbsorbEdge(): any edge can always be absorbed.
  canAbsorbEdge() {
    return true;
  }

  /**
   * Equivalent to tmTree::AbsorbEdge(): coalesces the edge's two nodes
   * into one (arbitrarily keeping the first, discarding the second),
   * transferring the discarded node's other edges onto the survivor.
   * Also tears down any existing crease pattern first, for the same
   * reason as absorbNode().
   */
  absorbEdge(edge) {
    const keepNode = edge.getNode(0);
    const killNode = edge.getNode(1);

    this.killPolysAndCreasePattern();

    for (const e of killNode.getEdges().filter(item => item !== edge)) {
      e.nodes = e.nodes.map(n => (n === killNode ? keepNode : n));
      keepNode.addEdge(e);
    }
    keepNode.removeEdge(edge);

    this.edges = this.edges.filter(e => e !== edge);
    this.nodes = this.nodes.filter(n => n !== killNode);
    // Unlike absorbNode(), a merge has an obvious survivor to hand the
    // root off to instead of just losing it.
    if (this.rootNode === killNode) this.rootNode = keepNode;

    this.conditions = this.conditions.filter(condition => (
      !condition?.uses?.(edge) && !condition?.uses?.(killNode)
    ));

    this.invalidatePaths();
    this.invalidate();
    this.refreshNodeClassification();
  }

  // Equivalent to tmTree::CanAbsorbEdges(): any list of edges can always
  // be absorbed.
  canAbsorbEdges() {
    return true;
  }

  // Equivalent to tmTree::AbsorbEdges(): absorbs every edge in the list (a
  // local copy, since absorbing shrinks this.edges as it goes).
  absorbEdges(edgeList) {
    const list = [...edgeList];
    for (const edge of list) this.absorbEdge(edge);
  }

  /**
   * Equivalent to tmTree::SplitEdge() (the inverse of absorbNode()):
   * inserts a new node along `edge`, replacing it with two new edges that
   * inherit the original's strain and stiffness — chosen so the two new
   * edges' combined STRAINED length equals the original edge's, and the
   * new node lands exactly at the split point along the strained
   * (visually accurate) edge. `splitLoc` is a ratio (0–1) of the edge's
   * strained length by default, or an absolute distance from the edge's
   * first node when `isDistance` is true; either way it must fall
   * strictly inside the edge.
   *
   * Unlike absorbNode()/absorbEdge(), the original only tears down the
   * specific top-level polys whose subtree contains the split edge
   * (tmPoly::SubTreeContains()) rather than the whole crease pattern; this
   * port doesn't track that per-poly, so it kills everything instead — a
   * strictly safe simplification (an untouched poly just gets rebuilt for
   * free on the next explicit Build).
   * @returns {tmNode} the newly-created node
   */
  splitEdge(edge, splitLoc, isDistance = false) {
    if (!edge || !Number.isFinite(Number(splitLoc))) {
      throw new TypeError('splitLoc must be a finite number');
    }
    const node1 = edge.getNode(0);
    const node2 = edge.getNode(1);
    const strainedLength = edge.getStrainedLength();
    const distance = isDistance ? Number(splitLoc) : Number(splitLoc) * strainedLength;
    if (!(distance > 0) || !(distance < strainedLength)) {
      throw new RangeError('splitLoc must lie strictly inside the edge');
    }

    const t = distance / strainedLength;
    const where = new tmPoint(
      node1.getLocX() + (node2.getLocX() - node1.getLocX()) * t,
      node1.getLocY() + (node2.getLocY() - node1.getLocY()) * t
    );

    this.killPolysAndCreasePattern();

    const newNode = new tmNode(null, where);
    newNode.label = this._nextNodeLabel();
    newNode.ownerTree = this;

    const edge1 = new tmEdge(null, node1, newNode);
    edge1.ownerTree = this;
    edge1.length = distance / (1 + edge.strain);
    edge1.strain = edge.strain;
    edge1.stiffness = edge.stiffness;

    const edge2 = new tmEdge(null, newNode, node2);
    edge2.ownerTree = this;
    edge2.length = (strainedLength - distance) / (1 + edge.strain);
    edge2.strain = edge.strain;
    edge2.stiffness = edge.stiffness;

    node1.removeEdge(edge);
    node2.removeEdge(edge);
    this.edges = this.edges.filter(e => e !== edge);
    this.edges.push(edge1, edge2);
    this.nodes.push(newNode);

    this.conditions = this.conditions.filter(condition => !condition?.uses?.(edge));

    this.invalidatePaths();
    this.invalidate();
    this.refreshNodeClassification();
    return newNode;
  }

  invalidatePaths() {
    this.paths = [];
    return this;
  }

  /**
   * Get an edge between two nodes (if exists)
   * @param {tmNode} node1
   * @param {tmNode} node2
   * @returns {tmEdge|null}
   */
  getEdge(node1, node2) {
    return this.edges.find(e => 
      (e.nodes[0] === node1 && e.nodes[1] === node2) ||
      (e.nodes[0] === node2 && e.nodes[1] === node1)
    ) || null;
  }

  /**
   * Get or create a path between two nodes
   * @param {tmNode} node1
   * @param {tmNode} node2
   * @returns {tmPath}
   */
  getPath(node1, node2) {
    for (const node of this.nodes) node.ownerTree = this;
    for (const edge of this.edges) edge.ownerTree = this;
    // Find existing path
    let path = this.paths.find(p => 
      (p.nodes[0] === node1 && p.nodes[p.nodes.length - 1] === node2) ||
      (p.nodes[0] === node2 && p.nodes[p.nodes.length - 1] === node1)
    );
    
    if (path) {
      this._updatePathMinimum(path);
      return path;
    }
    
    // Create new path using breadth-first search
    path = this._findPathBFS(node1, node2);
    if (path) {
      this._updatePathMinimum(path);
      this.paths.push(path);
    }
    
    return path;
  }

  /**
   * Equivalent to tmTree::FindAnyPath() as seen through the shared
   * tmPolyOwner interface: for a top-level tmPoly, `poly.polyOwner` is the
   * tree itself, and its buildPolyContents() looks up cross-paths between
   * ring nodes via `this.polyOwner.findAnyPath(...)` — which for the tree
   * is just getPath().
   */
  findAnyPath(node1, node2) {
    return this.getPath(node1, node2);
  }

  getPathDistance(node1, node2) {
    const path = this.getPath(node1, node2);
    return path ? path.getMinTreeLength() : Infinity;
  }

  getPathByNodeIds(nodeIds = []) {
    const nodes = nodeIds.map(id => this.nodes.find(node => node.id === id));
    if (nodes.length < 2 || nodes.some(node => !node)) return null;
    if (new Set(nodes).size !== nodes.length) return null;
    for (let index = 0; index < nodes.length - 1; index += 1) {
      if (!this.getEdge(nodes[index], nodes[index + 1])) return null;
    }
    const existing = this.paths.find(path => (
      path.nodes.length === nodes.length && path.nodes.every((node, index) => node === nodes[index])
    ));
    if (existing) return existing;
    const path = new tmPath();
    path.nodes = nodes;
    this._updatePathMinimum(path);
    this.paths.push(path);
    return path;
  }

  getSpanningEdges(nodes = []) {
    const selected = nodes.filter(node => this.nodes.includes(node));
    if (selected.length < 2) return [];
    const edges = new Set();
    const anchor = selected[0];
    for (const target of selected.slice(1)) {
      const path = this.getPath(anchor, target);
      if (!path) continue;
      for (let index = 0; index < path.nodes.length - 1; index += 1) {
        const edge = this.getEdge(path.nodes[index], path.nodes[index + 1]);
        if (edge) edges.add(edge);
      }
    }
    return [...edges];
  }

  getPathSlack(node1, node2) {
    const path = this.getPath(node1, node2);
    return path ? path.getLengthSlack() : -Infinity;
  }

  _updatePathMinimum(path) {
    if (!path || path.nodes.length < 2) return 0;
    path.scale = this.scale;
    let minimum = 0;
    for (let index = 0; index < path.nodes.length - 1; index += 1) {
      const edge = this.getEdge(path.nodes[index], path.nodes[index + 1]);
      if (!edge) continue;
      const geometricLength = path.nodes[index].location.distance(path.nodes[index + 1].location);
      const edgeMinimum = edge.getEffectiveTreeLength?.(this.scale)
        ?? (edge.getLength?.() || geometricLength / Math.max(this.scale, 1e-12));
      minimum += edgeMinimum;
    }
    // The "actual" length a leaf path is judged against is the straight
    // paper distance between its two endpoints — NOT path.getLength()'s sum
    // through whatever intermediate tree nodes the route passes through.
    // Paper distance is a straight Euclidean fact between two points; only
    // the *minimum* (tree-required) length is inherently route-based. Using
    // the routed polyline here (as an earlier version of this method did)
    // systematically overstates "actual", which could hide real
    // infeasibility and, worse, corrupts the exact-equality "active"
    // comparison the polygon-partition and universal-molecule algorithms
    // depend on.
    const front = path.nodes[0];
    const back = path.nodes[path.nodes.length - 1];
    const actualPaper = front.location.distance(back.location);
    const minPaperLength = minimum * this.scale;
    path.minTreeLength = minimum;
    path.minPaperLength = minPaperLength;
    path.actPaperLength = actualPaper;
    // Equivalent to tmPath::TestIsFeasible()/TestIsActive(): both compare
    // PAPER-unit lengths (not tree units) against tmPart::DistTol()
    // (1e-4) — a fixed paper-space tolerance, deliberately scale-
    // independent. Comparing tree-unit lengths against a fixed tolerance
    // instead (an earlier version of this method did) makes the effective
    // paper-space tolerance shrink or grow with the tree's scale factor,
    // which can spuriously flag a genuinely-active path (one only off by
    // sub-DistTol() numerical noise) as inactive.
    const DIST_TOL = 1e-4;
    path.isFeasible = actualPaper >= minPaperLength - DIST_TOL;
    path.isActiveGeometry = Math.abs(actualPaper - minPaperLength) < DIST_TOL;
    return minimum;
  }

  /**
   * Find the minimum-length path between nodes using Dijkstra's algorithm.
   * @private
   */
  _findPathBFS(start, end) {
    if (start === end) return null;

    const distances = new Map([[start, 0]]);
    const previous = new Map();
    const queue = [{ node: start, distance: 0 }];

    while (queue.length > 0) {
      queue.sort((first, second) => first.distance - second.distance);
      const current = queue.shift();
      if (current.distance > (distances.get(current.node) ?? Infinity)) continue;
      if (current.node === end) break;

      for (const edge of current.node.edges) {
        const neighbor = edge.getOtherNode(current.node);
        if (!neighbor) continue;
        const geometricLength = current.node.location.distance(neighbor.location);
        const weight = edge.getEffectiveTreeLength?.(this.scale)
          ?? (edge.getLength?.() || geometricLength);
        if (!Number.isFinite(weight) || weight < 0) continue;
        const candidateDistance = current.distance + weight;
        if (candidateDistance < (distances.get(neighbor) ?? Infinity)) {
          distances.set(neighbor, candidateDistance);
          previous.set(neighbor, current.node);
          queue.push({ node: neighbor, distance: candidateDistance });
        }
      }
    }

    if (!distances.has(end)) return null;
    const nodes = [];
    let current = end;
    while (current) {
      nodes.unshift(current);
      current = previous.get(current);
    }
    const path = new tmPath();
    path.nodes = nodes;
    return path;
  }

  /**
   * Set root node (for depth calculations)
   * @param {tmNode} node
   */
  // Equivalent to tmTree::GetRootNode().
  getRootNode() {
    return this.rootNode;
  }

  // Equivalent to tmTree::CanMakeNodeRoot(): the original defines "root" as
  // whichever node has index 1, so this is "not already index 1, and is a
  // real tree node rather than a poly-construction subnode" — adapted here
  // to this port's own rootNode reference/isRootNode flag instead of a
  // literal index swap, since nothing else in this port is index-based.
  canMakeNodeRoot(node) {
    return !!node && !node.isSubNode && node !== this.rootNode;
  }

  // Equivalent to tmTree::MakeNodeRoot() (SetPartIndex(node, 1) in the
  // original — see canMakeNodeRoot()'s comment on why this port uses
  // setRootNode()'s reference-based equivalent instead).
  setRootNode(node) {
    // Clear old root
    if (this.rootNode) {
      this.rootNode.isRootNode = false;
    }

    this.rootNode = node;
    if (node) {
      node.isRootNode = true;
      this.calculateNodeDepths(node);
    }

    this.invalidate();
  }

  /**
   * Equivalent to tmTree::PerturbNodes(): nudges each given node's
   * location by a small pseudo-random offset, then clamps back within the
   * paper (matching CleanupAfterEdit's position clamp, which the original
   * triggers automatically via its tmTreeCleaner RAII guard on every
   * edit — this port has no such automatic cascade, so it's done
   * explicitly here). Uses a small deterministic PRNG seeded fresh on
   * every call, mirroring the original's own `srand(0)` — so repeated
   * perturbations are reproducible on purpose, not actually random.
   */
  perturbNodes(nodeList) {
    if (nodeList.length === 0) return;
    const PERTURBATION_SIZE = 1e-2;
    let seed = 0;
    const nextRandom = () => {
      // A simple deterministic PRNG (mulberry32) standing in for the C
      // library's rand() (whose exact sequence is implementation-defined
      // anyway) — reseeded every call, in the same spirit as srand(0).
      seed = (seed + 0x6d2b79f5) | 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (const node of nodeList) {
      // Equivalent to the original's `2 * (rand()/RAND_MAX) - 0.5`: despite
      // that code's own comment claiming a symmetric (-1,1) range, the
      // formula is actually asymmetric ([-0.5, 1.5)) — reproduced
      // literally here, not "fixed", to match the real program's behavior.
      const dx = PERTURBATION_SIZE * (2 * nextRandom() - 0.5);
      const dy = PERTURBATION_SIZE * (2 * nextRandom() - 0.5);
      const x = Math.min(this.paperWidth, Math.max(0, node.getLocX() + dx));
      const y = Math.min(this.paperHeight, Math.max(0, node.getLocY() + dy));
      node.setLocationXY(x, y);
    }
    this.invalidate();
  }

  // Equivalent to tmTree::CanPerturbAllNodes().
  canPerturbAllNodes() {
    return this.nodes.length > 0;
  }

  // Equivalent to tmTree::PerturbAllNodes().
  perturbAllNodes() {
    this.perturbNodes(this.nodes);
  }

  // Equivalent to tmTree::SetEdgeLengths(): every edge in the list gets
  // the same tree-unit length, with any strain cleared (matches the
  // original's direct mLength/mStrain=0 assignment).
  setEdgeLengths(edgeList, length) {
    for (const edge of edgeList) {
      edge.setLength(length);
      edge.setStrain(0);
    }
  }

  // Equivalent to tmTree::ScaleEdgeLengths(): multiplies every edge in the
  // list by a common (positive) factor.
  scaleEdgeLengths(edgeList, factor) {
    for (const edge of edgeList) edge.setLength(edge.getLength() * factor);
  }

  /**
   * Equivalent to tmTree::ScaleTree(): divides the tree's own scale by
   * `scaleFactor` and multiplies every edge's tree-unit length by that
   * same factor. The paper geometry (edge length × scale) is unchanged —
   * only how it's split between "tree units" and "scale" shifts. Shared
   * utility behind RenormalizeToUnitEdge/UnitPath/UnitScale.
   */
  scaleTree(scaleFactor) {
    this.setScale(this.scale / scaleFactor);
    for (const edge of this.edges) edge.setLength(edge.getLength() * scaleFactor);
  }

  // Equivalent to tmTree::RenormalizeToUnitEdge(): rescales the whole tree
  // so this edge ends up with unit (tree-unit) length.
  renormalizeToUnitEdge(edge) {
    this.scaleTree(1 / edge.getLength());
  }

  // Equivalent to tmTree::RenormalizeToUnitPath(): rescales the whole tree
  // so this path's minimum tree length becomes 1.
  renormalizeToUnitPath(path) {
    this.scaleTree(1 / path.getMinTreeLength());
  }

  // Equivalent to tmTree::RenormalizeToUnitScale(): rescales the whole
  // tree so the tree's own scale becomes 1.0.
  renormalizeToUnitScale() {
    this.scaleTree(this.scale);
  }

  // Equivalent to tmTree::HasStrainedEdges().
  hasStrainedEdges() {
    return tmEdge.containsStrainedEdges(this.edges);
  }

  // Equivalent to tmTree::RemoveStrain(): resets every edge in the list to
  // zero strain, without changing its (unstrained) length.
  removeStrain(edgeList) {
    for (const edge of edgeList) edge.setStrain(0);
  }

  // Equivalent to tmTree::RemoveAllStrain().
  removeAllStrain() {
    this.removeStrain(this.edges);
  }

  /**
   * Equivalent to tmTree::RelieveStrain(): absorbs each edge's strain into
   * its own (unstrained) length — the edge's strained length (its visual/
   * effective length) stays exactly the same, but its strain becomes 0.
   */
  relieveStrain(edgeList) {
    for (const edge of edgeList) {
      const strainedLength = edge.getStrainedLength();
      edge.setLength(strainedLength);
      edge.setStrain(0);
    }
  }

  // Equivalent to tmTree::RelieveAllStrain().
  relieveAllStrain() {
    this.relieveStrain(this.edges);
  }

  /**
   * Calculate depths from root node using BFS
   * @private
   */
  calculateNodeDepths(root) {
    const visited = new Set();
    const queue = [[root, 0]];
    visited.add(root);
    root.depth = 0;
    
    while (queue.length > 0) {
      const [node, depth] = queue.shift();
      node.depth = depth;
      
      for (const edge of node.edges) {
        const neighbor = edge.getOtherNode(node);
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push([neighbor, depth + edge.length]);
        }
      }
    }
  }

  // ===== CREASE PATTERN BUILDING =====

  /**
   * Build tree polygons from the tree structure
   */
  /**
   * Equivalent to tmTree::BuildTreePolys(): partitions the paper into
   * top-level polygons using the network of leaf-to-leaf paths (taut ones,
   * plus feasible paper-edge ones), rather than just taking the leaves'
   * convex hull as a single polygon. See _buildPolysFromPaths() for the
   * actual face-tracing algorithm.
   *
   * Known limitation (matches the original — its own POLYS_NOT_VALID error
   * text already suggests the same remedy below), not a distinct bug:
   * `isPolygonValid` can come out false after "Maximize Scale" on a more
   * complex tree — one leaf ends up with a microscopic negative slack
   * (~1e-6, inside the solver's own feasibility tolerance) that's enough to
   * make a polygon nonconvex or enclose another leaf. Confirmed this is the
   * same ScaleOptimizer local-optimum sensitivity already documented in
   * AugmentedLagrangianNLP.js (test/prueba7_*.tmd5), not a bug in this
   * method or in calcPolyIsConvex()'s tolerance (checked: it already
   * matches the original's ConvexityTol() exactly) — re-running Maximize
   * Scale with random restarts ("Allow a higher-scoring but very different
   * layout") from the same starting point found a strictly better, valid
   * scale for a case that failed here. "Scale Selection" on the specific
   * offending edges (which is exactly what the original's error message
   * suggests) is the manual workaround for now.
   */
  buildTreePolys() {
    this.polys = [];
    this.vertices = [];
    this.refreshNodeClassification();

    const leafNodes = this.nodes.filter(n => n.isLeafNode);

    if (leafNodes.length < 3) {
      console.warn('Tree needs at least 3 leaf nodes to form polygons');
      this.invalidate();
      this.isPolygonValid = false;
      return;
    }

    const leafPaths = this._classifyLeafPaths(leafNodes);
    const borderNodes = this._calcBorderNodesAndPaths(leafNodes, leafPaths);
    this._calcPinnedNodesAndEdges(leafNodes, leafPaths);
    const leafPathsByNode = this._calcPolygonNetwork(leafNodes, leafPaths);

    this._buildPolysFromPaths(leafPaths, borderNodes, leafPathsByNode);

    // Delete any resulting polygon that's nonconvex or encloses another
    // leaf node — a problem unique to top-level poly construction. No
    // automatic dangle-proofing here (unlike C++'s tmDpptr), so explicitly
    // clear any ring path's fwd/bkdPoly slot that pointed at a deleted poly.
    for (let i = this.polys.length - 1; i >= 0; i -= 1) {
      const poly = this.polys[i];
      if (poly.calcPolyIsConvex() && !poly.calcPolyEnclosesNode(leafNodes)) continue;
      for (const path of poly.ringPaths) {
        if (path.fwdPoly === poly) path.fwdPoly = null;
        if (path.bkdPoly === poly) path.bkdPoly = null;
      }
      this.polys.splice(i, 1);
    }

    this.invalidate();
    this.isPolygonValid = this.polys.length > 0;
  }

  /**
   * Populates `poly.vertices` (in ring order, for facet construction) and
   * collects every vertex reachable from `poly` — its own ring nodes' and
   * recursively every subPoly's, plus any interior vertex built along a
   * spoke/ridge/owned/ring path during buildPolyContents()'s crease pass —
   * into `this.vertices`, deduplicated via `seen` (the same node or path
   * can be reachable from more than one poly, e.g. a shared ring edge).
   * Reuses whatever vertex a node/path already built (getOrMakeVertexSelf/
   * that path's own `vertices`) rather than creating new ones, so this
   * stays consistent with the vertex objects the real AXIAL/GUSSET/RIDGE/
   * HINGE creases already reference.
   * @private
   */
  _collectVertices(poly, seen) {
    const addVertex = (vertex) => {
      if (vertex && !seen.has(vertex)) {
        seen.add(vertex);
        this.vertices.push(vertex);
        // Display-only fallback identifier for vertices with no node owner
        // (a path-owned or ownerless junction vertex) — see
        // tmVertex.getDisplayLabel(). Not persisted or stable across
        // Builds, just a readable stand-in for the raw random `id`.
        vertex.buildIndex = this.vertices.length;
      }
    };
    poly.vertices = poly.ringNodes.map(node => {
      const vertex = node.getOrMakeVertexSelf();
      addVertex(vertex);
      return vertex;
    });
    const pathLists = [poly.spokePaths, poly.ownedPaths, poly.ringPaths, poly.ridgePath ? [poly.ridgePath] : []];
    for (const paths of pathLists) {
      for (const path of paths) {
        addVertex(path.getFirstNode().getVertex());
        addVertex(path.getLastNode().getVertex());
        path.vertices.forEach(addVertex);
      }
    }
    for (const sub of poly.subPolys) this._collectVertices(sub, seen);
  }

  /**
   * Collects every molecule-construction path built by buildPolyContents()
   * — the spoke paths (ring node to its inset node) and, once a poly's ring
   * has 4+ distinct corners, the cross-path network among the inset nodes
   * (`ownedPaths`/`ridgePath`) — so they can be drawn like the original's
   * PATH_INTERNAL_COLOR paths (see CanvasRenderer._drawPaths()). Not the
   * same paths as `this.paths`: see the field comment on `internalPaths`.
   * `poly.ringPaths` is deliberately skipped — for any poly (top-level or
   * sub), those are always the SAME path objects some poly's `ownedPaths`
   * (or the tree's own leaf `paths`) already owns, never new ones, so
   * collecting them here would only produce duplicates.
   * @private
   */
  _collectInternalPaths(poly, seen) {
    const addPath = (path) => {
      if (path && !seen.has(path)) {
        seen.add(path);
        this.internalPaths.push(path);
      }
    };
    poly.spokePaths.forEach(addPath);
    poly.ownedPaths.forEach(addPath);
    if (poly.ridgePath) addPath(poly.ridgePath);
    for (const sub of poly.subPolys) this._collectInternalPaths(sub, seen);
  }

  /**
   * Collects every real crease built by buildPolyContents()'s crease-
   * classification pass: RIDGE/most HINGE creases live on `poly.
   * ownedCreases` (routed there via getOutermostPoly(), so in practice
   * only ever non-empty on a top-level poly — see tmPoly.js), AXIAL/GUSSET
   * (and, in principle, any subPoly-owned HINGE) creases live on the
   * individual ring paths' own `.creases`. Recurses into subPolys so every
   * depth of the inset recursion is covered.
   * @private
   */
  _collectCreases(poly, seen) {
    const addCrease = (crease) => {
      if (crease && !seen.has(crease)) {
        seen.add(crease);
        this.creases.push(crease);
      }
    };
    poly.ownedCreases.forEach(addCrease);
    poly.ringPaths.forEach(path => path.creases.forEach(addCrease));
    for (const sub of poly.subPolys) this._collectCreases(sub, seen);
  }

  /**
   * Collects every poly reachable from `poly` — itself plus, recursively,
   * every subPoly at every inset-recursion depth. Equivalent to what the
   * original's flat `mPolys` list (all polys, vs. `mOwnedPolys`'s
   * top-level-only) gives tmTree::CalcDepthAndBend() for free.
   * @private
   */
  _collectAllPolys(poly, out) {
    out.push(poly);
    for (const sub of poly.subPolys) this._collectAllPolys(sub, out);
  }

  /**
   * Equivalent to tmTree::CalcDepthAndBend(): assigns every tree node and
   * every vertex a 3D-fold "depth" (distance along the folded paper from
   * the root), then refines each hinge crease's kind into FOLDED_HINGE vs
   * UNFOLDED_HINGE from those depths (tmPoly.calcBend()). This is the
   * foundation the rest of the mountain/valley pipeline builds on: facet
   * ordering, color, and fold direction all ultimately trace back to which
   * side of a crease sits "higher".
   */
  calcDepthAndBend() {
    if (!this.isPolygonValid) return;
    if (this.nodes.length === 0) return;

    const rootNode = this.getRootNode();
    if (!rootNode) return;
    rootNode.depth = 0;
    for (const node of this.nodes) {
      if (node === rootNode) continue;
      const path = this.getPath(rootNode, node);
      if (path) node.depth = path.minPaperLength;
    }

    // Every leaf path gets its own local 1D depth coordinate system
    // (minDepth/minDepthDist): the smallest node-depth found walking its
    // route, and how far along the route that minimum sits.
    for (const path of this.paths) {
      if (!path.isLeafPath) continue;
      path.minDepth = path.getFirstNode().depth;
      path.minDepthDist = 0;
      for (let j = 1; j < path.nodes.length; j += 1) {
        const nodeDepth = path.nodes[j].depth;
        if (path.minDepth > nodeDepth) {
          path.minDepth = nodeDepth;
          const edge = this.getEdge(path.nodes[j - 1], path.nodes[j]);
          path.minDepthDist += edge.getStrainedScaledLength(this.scale);
        }
      }
    }

    // Every poly at every inset-recursion depth (not just top-level).
    const allPolys = [];
    for (const poly of this.polys) this._collectAllPolys(poly, allPolys);

    // Every gusset path (an active cross path within some poly, at any
    // depth) inherits its local depth coordinate system from the original,
    // un-inset leaf path it was inset from — getMaxOutsetPath() walks the
    // whole outsetPath chain in one step, so processing order here doesn't
    // matter and a gusset path that's also directly a leaf path (an active
    // non-border leaf diagonal) is a harmless no-op (its own outsetPath is
    // null, so it just re-reads the value the loop above already set).
    const seenGusset = new Set();
    for (const poly of allPolys) {
      for (const path of poly.ringPaths) {
        if (!path.isGussetPath() || seenGusset.has(path)) continue;
        seenGusset.add(path);
        const { maxOutsetPath, maxFrontReduction } = path.getMaxOutsetPath();
        path.minDepth = maxOutsetPath.minDepth;
        path.minDepthDist = maxOutsetPath.minDepthDist - maxFrontReduction;
      }
    }

    for (const vertex of this.vertices) {
      vertex.depth = 0;
      vertex.depthValid = false;
    }

    // Assign depth to every ridgeline vertex and every path-owned vertex
    // of every active-axial or gusset ring path, in every poly at every
    // depth (this also covers each poly's own ring-corner vertices, since
    // getRidgelineVertices() includes the front/back endpoints).
    for (const poly of allPolys) {
      const n = poly.ringNodes.length;
      for (let j = 0; j < n; j += 1) {
        const frontNode = poly.ringNodes[j];
        const backNode = poly.ringNodes[(j + 1) % n];
        const thePath = poly.ringPaths[j];
        if (!(thePath.isActiveAxialPath() || thePath.isGussetPath())) continue;
        const ridgeVertices = poly.getRidgelineVertices(frontNode, backNode);
        for (const vertex of ridgeVertices) thePath.setVertexDepth(vertex);
        for (const vertex of thePath.vertices) thePath.setVertexDepth(vertex);
      }
    }

    // An inactive border (leaf) path's own owned vertices (built by the
    // downward hinge/pseudohinge propagation pass in
    // tmPoly._buildCreases()) never sit on an active path themselves, so
    // they borrow the depth of whichever ridgeline vertex their hinge
    // crease connects up to.
    for (const path of this.paths) {
      if (!path.isBorderPath || path.isActivePath()) continue;
      for (const vertex of path.vertices) {
        for (const crease of vertex.creases) {
          if (crease.isHingeCrease()) {
            vertex.setDepth(crease.getOtherVertex(vertex).depth);
            break;
          }
        }
      }
    }

    // Discrete (graph-hop) depth, only meaningful for a vertex that
    // projects to a real tree node — used to compute bend and, later, to
    // find each poly's local root vertices/creases.
    for (const vertex of this.vertices) {
      vertex.discreteDepth = vertex.treeNode ? vertex.treeNode.calcDiscreteDepth() : null;
    }

    // If two consecutive inactive border paths left some vertex
    // undepthed, we can't go any farther — bail before touching bend or
    // the rest of the crease pattern.
    for (const vertex of this.vertices) {
      if (!vertex.depthValid) return;
    }

    for (const poly of this.polys) poly.calcBend();
  }

  /**
   * Equivalent to tmTree::CalcVertexDepthValidity().
   */
  calcVertexDepthValidity() {
    this.isVertexDepthValid = false;
    if (this.vertices.length === 0) return;
    for (const vertex of this.vertices) {
      if (!vertex.depthValid) return;
    }
    this.isVertexDepthValid = true;
  }

  /**
   * Equivalent to tmTree::CalcFacetDataValidity(): every facet must be
   * well-formed, and every non-border vertex must have an even number of
   * incident creases (a necessary condition for the crease pattern to be
   * two-colorable / flat-foldable at that vertex).
   */
  calcFacetDataValidity() {
    this.isFacetDataValid = false;
    if (this.facets.length === 0) return;
    for (const facet of this.facets) {
      if (!facet.isWellFormed) return;
    }
    for (const vertex of this.vertices) {
      if (vertex.isBorderVertex()) continue;
      if (vertex.creases.length % 2 !== 0) return;
    }
    this.isFacetDataValid = true;
  }

  /**
   * Equivalent to tmTree::CalcFacetCorridorEdges(): dispatches to every
   * top-level poly.
   */
  calcFacetCorridorEdges() {
    for (const poly of this.polys) poly.calcFacetCorridorEdges();
  }

  /**
   * Equivalent to tmTree::CalcRootNetworks(): builds each poly's own local
   * facet-ordering graph, collects every poly's local-root vertices/
   * creases, and groups them into connected components (one RootNetwork
   * per component), each with its own spanning tree and degree
   * classification — the raw material tmTree.calcFacetOrder() splices into
   * one global ordering graph.
   */
  calcRootNetworks() {
    for (const poly of this.polys) poly.calcLocalFacetOrder();

    const localRootVertices = [];
    const localRootCreases = [];
    for (const poly of this.polys) {
      for (const vertex of poly.localRootVertices) {
        if (!localRootVertices.includes(vertex)) localRootVertices.push(vertex);
      }
      for (const crease of poly.localRootCreases) {
        if (!localRootCreases.includes(crease)) localRootCreases.push(crease);
      }
    }

    for (const vertex of this.vertices) {
      vertex.ccFlag = RootNetwork.INELIGIBLE;
      vertex.stFlag = RootNetwork.INELIGIBLE;
    }
    for (const crease of this.creases) {
      crease.ccFlag = RootNetwork.INELIGIBLE;
      crease.stFlag = RootNetwork.INELIGIBLE;
    }
    for (const vertex of localRootVertices) {
      vertex.ccFlag = RootNetwork.NOT_YET;
      vertex.stFlag = RootNetwork.NOT_YET;
    }
    for (const crease of localRootCreases) {
      crease.ccFlag = RootNetwork.NOT_YET;
      crease.stFlag = RootNetwork.NOT_YET;
    }

    const rootNetworks = [];
    for (const vertex of localRootVertices) {
      if (rootNetworks.some(net => net.ccVertices.includes(vertex))) continue;
      const net = new RootNetwork(vertex.getDiscreteDepth());
      net.tryAddVertexToConnectedComponent(vertex);
      rootNetworks.push(net);
    }

    for (const net of rootNetworks) net.buildSpanningTree();
    for (const net of rootNetworks) net.classifyVerticesByDegree();

    return rootNetworks;
  }

  /**
   * Equivalent to tmTree::CalcWhyNotLocalRootConnectable(): identifies the
   * specific vertices/creases responsible for facet ordering failing —
   * either two root networks both claiming discrete depth 0, or some
   * depth > 0 network that isn't connectable to the rest.
   */
  calcWhyNotLocalRootConnectable() {
    const badVertices = [];
    const badCreases = [];
    const addAll = (list, arr) => { for (const item of arr) if (!list.includes(item)) list.push(item); };

    const rootNetworks = this.calcRootNetworks();
    let zeroDepthNetwork = null;
    for (const net of rootNetworks) {
      if (net.discreteDepth === 0) {
        if (!zeroDepthNetwork) {
          zeroDepthNetwork = net;
        } else {
          addAll(badVertices, net.ccVertices);
          addAll(badCreases, net.ccCreases);
          addAll(badVertices, zeroDepthNetwork.ccVertices);
          addAll(badCreases, zeroDepthNetwork.ccCreases);
        }
      } else if (!net.isConnectable) {
        addAll(badVertices, net.ccVertices);
        addAll(badCreases, net.ccCreases);
      }
    }
    return { badVertices, badCreases };
  }

  /**
   * Equivalent to tmTree::CalcFacetOrder(): builds the complete global
   * facet-ordering graph (one local loop per molecule, spliced together
   * at local-root vertices into a single sortable graph with one source
   * and one sink), then assigns every facet an order number consistent
   * with that graph — comparing two facets' order values tells you which
   * one is "on top" in the folded form.
   */
  calcFacetOrder() {
    let rootNetworks = this.calcRootNetworks();

    let numDepthZero = 0;
    this.isLocalRootConnectable = true;
    for (const net of rootNetworks) {
      if (net.discreteDepth === 0) numDepthZero += 1;
      else if (!net.isConnectable) this.isLocalRootConnectable = false;
    }
    this.isLocalRootConnectable = this.isLocalRootConnectable && numDepthZero === 1;
    if (!this.isLocalRootConnectable) return;

    for (const net of rootNetworks) net.connectFacetGraph();

    let globalRootNetwork = null;
    const rest = [];
    for (const net of rootNetworks) {
      if (!globalRootNetwork && net.discreteDepth === 0) globalRootNetwork = net;
      else rest.push(net);
    }
    rootNetworks = rest;

    while (rootNetworks.length > 0) {
      let absorbedOne = false;
      for (let i = 0; i < rootNetworks.length; i += 1) {
        const net = rootNetworks[i];
        const atVertex = globalRootNetwork.canAbsorb(net);
        if (atVertex) {
          globalRootNetwork.absorb(net, atVertex);
          rootNetworks.splice(i, 1);
          absorbedOne = true;
          break;
        }
      }
      if (!absorbedOne) throw new Error('tmTree.calcFacetOrder(): could not absorb every local root network');
    }

    globalRootNetwork.breakOneLink();

    let sourceFacet = null;
    for (const facet of this.facets) {
      facet.order = null;
      if (facet.isSourceFacet()) sourceFacet = facet;
    }
    sourceFacet.calcOrder({ next: 0 });
  }

  /**
   * Equivalent to tmTree::CalcFacetColor(): two-colors the crease pattern
   * (which side of the paper faces up), starting from the tree's single
   * source facet and propagating via tmFacet.calcColor().
   */
  calcFacetColor() {
    let sourceFacet = null;
    for (const facet of this.facets) {
      facet.color = FacetColor.NOT_ORIENTED;
      if (facet.isSourceFacet()) sourceFacet = facet;
    }
    sourceFacet.calcColor(FacetColor.COLOR_UP);
  }

  /**
   * Equivalent to tmTree::CalcFoldDirections(): the final step — assigns
   * every crease its actual mountain/valley/flat/border fold direction
   * from the color and order of the facets on either side.
   */
  calcFoldDirections() {
    for (const crease of this.creases) crease.calcFold();
  }

  /**
   * Ensures every pair of leaf nodes has a materialized, freshly-updated
   * tmPath, flagged as a leaf path. Equivalent to the leaf-path half of
   * tmTree::GetLeafPaths() — the original also maintains paths between
   * non-leaf node pairs, but nothing in the polygon-partition algorithm
   * ever looks at those, so this JS port only ever materializes the leaf
   * pairs it actually needs.
   * @private
   */
  _classifyLeafPaths(leafNodes) {
    // A path only ever gets created (via getPath()) the first time both its
    // endpoints happen to be leaves — e.g. while incrementally adding nodes
    // by hand, a branch node is briefly a leaf before further edges attach
    // to it. Once that node stops being a leaf, nothing else revisits this
    // path object, so without resetting it here it would stay flagged
    // isLeafPath (and keep rendering/counting as one, see
    // Renderer.isVisiblePath()) forever, even though it's no longer a real
    // leaf-to-leaf relationship. Loading a tree straight from a file never
    // hits this, since classification only ever runs once, on the final
    // topology.
    // isBorderPath/isPolygonPath need the same treatment: isVisiblePath()
    // no longer requires isLeafPath on its own (a genuine, never-leaf
    // molecule-construction path — see tree.getInternalPaths() — can be a
    // border/polygon path too), so a stale former-leaf path with a frozen
    // isBorderPath=true would otherwise pass isVisiblePath() again even
    // with isLeafPath correctly reset to false right above.
    for (const path of this.paths) {
      path.isLeafPath = false;
      path.isBorderPath = false;
      path.isPolygonPath = false;
    }
    const leafPaths = [];
    for (let i = 0; i < leafNodes.length; i += 1) {
      for (let j = i + 1; j < leafNodes.length; j += 1) {
        const path = this.getPath(leafNodes[i], leafNodes[j]);
        if (!path) continue;
        path.isLeafPath = true;
        path.isBorderPath = false;
        path.isPolygonPath = false;
        path.fwdPoly = null;
        path.bkdPoly = null;
        leafPaths.push(path);
      }
    }
    return leafPaths;
  }

  /**
   * Equivalent to tmTree::CalcBorderNodesAndPaths(): the leaf nodes lying
   * on the convex hull of all leaf nodes are "border nodes", and the leaf
   * paths directly connecting consecutive border nodes are "border paths".
   * @private
   */
  _calcBorderNodesAndPaths(leafNodes, leafPaths) {
    for (const node of leafNodes) node.isBorderNode = false;
    const borderNodes = [];
    if (leafNodes.length < 3) return borderNodes;

    const hull = this._computeConvexHull(leafNodes); // CCW order
    for (const node of hull) {
      node.isBorderNode = true;
      borderNodes.push(node);
    }
    for (let i = 0; i < hull.length; i += 1) {
      const a = hull[i];
      const b = hull[(i + 1) % hull.length];
      const path = leafPaths.find(p => (
        (p.getFirstNode() === a && p.getLastNode() === b) ||
        (p.getFirstNode() === b && p.getLastNode() === a)
      ));
      if (path) path.isBorderPath = true;
    }
    return borderNodes;
  }

  /**
   * Equivalent to tmTree::CalcPinnedNodesAndEdges(): a leaf node is pinned
   * if the angular arrangement of its active (taut) incident leaf paths,
   * plus any paper edge it sits exactly on, geometrically locks it in
   * place (tmNode.calcIsPinnedNode() — a local test, not a global
   * rigidity/linear-algebra analysis, and one that deliberately ignores
   * user conditions, matching the original). Once every leaf node's pinned
   * status is settled, an edge is pinned if it lies along some active leaf
   * path whose two endpoints are BOTH pinned nodes — such an edge can't
   * meaningfully change length without violating that path's tautness.
   * @private
   */
  _calcPinnedNodesAndEdges(leafNodes, leafPaths) {
    for (const node of leafNodes) node.isPinnedNode = false;
    for (const edge of this.edges) edge.isPinnedEdge = false;

    const activePathsByNode = new Map(leafNodes.map(node => [node, []]));
    for (const path of leafPaths) {
      if (!path.isActivePath()) continue;
      activePathsByNode.get(path.getFirstNode())?.push(path);
      activePathsByNode.get(path.getLastNode())?.push(path);
    }
    for (const node of leafNodes) {
      node.calcIsPinnedNode(activePathsByNode.get(node) || []);
    }

    for (const path of leafPaths) {
      if (!path.isActivePath()) continue;
      if (!path.getFirstNode().isPinnedNode || !path.getLastNode().isPinnedNode) continue;
      for (let i = 0; i < path.nodes.length - 1; i += 1) {
        const edge = this.getEdge(path.nodes[i], path.nodes[i + 1]);
        if (edge) edge.isPinnedEdge = true;
      }
    }
  }

  /**
   * Equivalent to tmTree::CalcPolygonNetwork(): decides which leaf paths
   * are candidate edges of the polygon arrangement (taut, or a feasible
   * border path) and which leaf nodes are candidate vertices (pinned or
   * border), then repeatedly prunes both sets — dropping a polygon path
   * once either endpoint stops being a polygon node, and dropping a
   * polygon node once it has fewer than 2 incident polygon paths — until
   * nothing more changes. Returns a node -> incident-leaf-paths index,
   * reused by _buildPolysFromPaths()'s face-tracing step.
   * @private
   */
  _calcPolygonNetwork(leafNodes, leafPaths) {
    for (const path of leafPaths) {
      path.isPolygonPath = path.isActiveGeometry || (path.isBorderPath && path.isFeasible);
    }
    for (const node of leafNodes) {
      node.isPolygonNode = node.isPinnedNode || node.isBorderNode;
    }
    // A leaf node touched by any infeasible leaf path can't be trusted as
    // fully determined; exclude it (and un-pin it) as a candidate vertex.
    for (const path of leafPaths) {
      if (path.isFeasible) continue;
      for (const node of [path.getFirstNode(), path.getLastNode()]) {
        node.isPolygonNode = false;
        node.isPinnedNode = false;
      }
    }

    const leafPathsByNode = new Map(leafNodes.map(node => [node, []]));
    for (const path of leafPaths) {
      leafPathsByNode.get(path.getFirstNode())?.push(path);
      leafPathsByNode.get(path.getLastNode())?.push(path);
    }

    let changed = true;
    while (changed) {
      changed = false;
      for (const path of leafPaths) {
        if (!path.isPolygonPath) continue;
        if (!path.getFirstNode().isPolygonNode || !path.getLastNode().isPolygonNode) {
          path.isPolygonPath = false;
          changed = true;
        }
      }
      for (const node of leafNodes) {
        if (!node.isPolygonNode) continue;
        const count = leafPathsByNode.get(node).filter(p => p.isPolygonPath).length;
        if (count < 2) {
          node.isPolygonNode = false;
          changed = true;
        }
      }
    }

    return leafPathsByNode;
  }

  /**
   * Equivalent to tmPolyOwner::BuildPolysFromPaths() called on the tree
   * itself: traces every bounded face of the planar arrangement formed by
   * the tree's polygon paths, producing one top-level tmPoly per face. The
   * actual face-tracing lives in PolygonPartition.js, shared with
   * tmPoly.buildPolyContents()'s recursive partition of an inset polygon's
   * interior (mirroring how tmPolyOwner is the shared base class of both
   * tmTree and tmPoly in the original).
   * @private
   */
  _buildPolysFromPaths(leafPaths, borderNodes, leafPathsByNode) {
    const built = buildPolysFromPaths({
      paths: leafPaths,
      borderNodes,
      nodeToPaths: leafPathsByNode,
      createPoly: () => {
        const poly = new tmPoly();
        poly.isTreePoly = true;
        poly.polyOwner = this;
        return poly;
      }
    });
    this.polys.push(...built);
  }

  /**
   * Build complete crease pattern from polygons
   */
  buildPolysAndCreasePattern() {
    if (!this.polys.some(poly => poly.hasPolyContents())) {
      this.buildTreePolys();
    }

    // Matches tmTree::BuildPolysAndCreasePattern(): don't attempt the inset
    // math (buildPolyContents()) over underlength edges — getCPStatus()
    // will report EDGES_TOO_SHORT for this same condition.
    if (this.edges.some(edge => edge.getStrainedLength() < MIN_EDGE_LENGTH)) return;

    // Builds subpolys, vertices, creases (AXIAL/GUSSET/RIDGE/HINGE/
    // PSEUDOHINGE) and, for each top-level poly, its facets — a no-op for
    // any poly that already has contents from a previous call (matches
    // hasPolyContents()'s short-circuit).
    for (const poly of this.polys) poly.buildPolyContents();

    this.vertices = [];
    const seenVertices = new Set();
    for (const poly of this.polys) this._collectVertices(poly, seenVertices);

    this.creases = [];
    const seenCreases = new Set();
    for (const poly of this.polys) this._collectCreases(poly, seenCreases);

    this.internalPaths = [];
    const seenInternalPaths = new Set();
    for (const poly of this.polys) this._collectInternalPaths(poly, seenInternalPaths);

    // Facets are only ever built for a top-level (isTreePoly) poly, so no
    // recursion into subPolys is needed here (unlike vertices/creases).
    this.facets = [];
    for (const poly of this.polys) this.facets.push(...poly.facets);

    // Matches tmTree::CleanupAfterEdit()'s tail: recompute depth, bend,
    // facet ordering, color, and fold direction fresh every time, even
    // when the structural rebuild above was a no-op — node positions (and
    // therefore depths/fold directions) can change without the topology
    // changing. Bails out at the same points and for the same reasons as
    // the original, leaving isPolygonFilled as the last flag actually set.
    for (const vertex of this.vertices) vertex.clearCleanupData();
    for (const crease of this.creases) crease.clearCleanupData();
    for (const facet of this.facets) facet.clearCleanupData();

    this.isVertexDepthValid = false;
    this.isFacetDataValid = false;
    this.isLocalRootConnectable = false;
    this.isPolygonFilled = this.polys.every(poly => poly.hasPolyContents());
    if (!this.isPolygonFilled) return;

    this.calcDepthAndBend();
    this.calcVertexDepthValidity();
    if (!this.isVertexDepthValid) return;

    this.calcFacetDataValidity();
    if (!this.isFacetDataValid) return;

    this.calcFacetCorridorEdges();
    this.calcFacetOrder();
    if (!this.isLocalRootConnectable) return;

    this.calcFacetColor();
    this.calcFoldDirections();
  }

  /**
   * Equivalent to tmTree::KillPolysAndCreasePattern() — what the "Kill
   * Crease Pattern" menu command in the original actually calls, despite
   * its narrower name. Tears down everything buildPolysAndCreasePattern()
   * built: every poly (top-level and, transitively, every subPoly), every
   * vertex, crease, and facet — leaving the underlying tree topology
   * (nodes, edges, tree-level paths) and their own feasibility/activity
   * flags untouched, since those belong to a separate, earlier stage
   * (CleanupAfterEdit/refreshPathStates(), not Build). A leaf-to-leaf
   * tmPath object in `this.paths` is long-lived — reused across many
   * builds via getPath() — so its own cached `vertices`/`creases` from the
   * killed pattern must be cleared explicitly too, along with each real
   * tree node's cached self-vertex, or a subsequent
   * buildPolysAndCreasePattern() would find stale contents and skip
   * rebuilding them (buildSelfVertices()/getOrMakeVertexSelf() are both
   * idempotent, matching the original).
   */
  killPolysAndCreasePattern() {
    for (const node of this.nodes) node.vertices = [];
    for (const path of this.paths) {
      path.vertices = [];
      path.creases = [];
    }
    this.polys = [];
    this.vertices = [];
    this.creases = [];
    this.facets = [];
    this.internalPaths = [];
    this.isPolygonValid = false;
    this.isPolygonFilled = false;
    this.isVertexDepthValid = false;
    this.isFacetDataValid = false;
    this.isLocalRootConnectable = false;
  }

  /**
   * Add the largest available stub to each polygon until no candidate remains.
   * The current tree representation does not yet persist polygon subdivisions,
   * so the method reports inserted stubs and stops when a candidate repeats.
   */
  triangulateTree(options = {}) {
    const maxIterations = options.maxIterations ?? 100;
    const finder = options.stubFinder || new StubFinder(this, options);
    const inserted = [];
    const seen = new Set();

    this.buildTreePolys();
    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      const polygon = this.polys.find(poly => poly.isTreePoly && poly.getRingNodes().length >= 4);
      if (!polygon) break;

      const nodes = polygon.getRingNodes();
      const stub = finder.findLargestStub(nodes);
      if (stub.isBlank()) break;

      const signature = [
        stub.location.x.toFixed(9),
        stub.location.y.toFixed(9),
        stub.activeNodes.map(node => node.id).sort().join(',')
      ].join(':');
      if (seen.has(signature)) break;
      seen.add(signature);

      const result = finder.addStubToTree(stub);
      if (!result) break;
      inserted.push({ stub, result });
      this.buildTreePolys();
    }

    const triangulated = [];
    for (const polygon of this.polys.filter(poly => poly.isTreePoly && poly.getRingNodes().length >= 4)) {
      triangulated.push(...this._triangulatePoly(polygon));
    }

    return {
      inserted,
      iterations: inserted.length,
      triangulated,
      polygonOrders: this.polys.map(poly => poly.getRingNodes().length),
      complete: this.polys.every(poly => poly.getRingNodes().length === 3)
    };
  }

  /**
   * Splits a >=4-sided tree poly into a fan of triangle sub-polys by ring
   * node (not `poly.vertices`, which `buildTreePolys()` never populates —
   * only the full `buildPolysAndCreasePattern()` build's `_collectVertices()`
   * does). Ring-node based, so this only records the topological split;
   * the actual crease/vertex contents for these sub-polys are built the
   * next time the full crease pattern is built.
   */
  _triangulatePoly(polygon) {
    const ringNodes = polygon.getRingNodes();
    if (ringNodes.length < 4 || polygon.subPolys.length > 0) return [];

    const triangles = [];
    for (let index = 1; index < ringNodes.length - 1; index += 1) {
      const triangle = new tmPoly();
      triangle.isTreePoly = false;
      triangle.ringNodes = [ringNodes[0], ringNodes[index], ringNodes[index + 1]];
      polygon.addSubPoly(triangle);
      triangles.push(triangle);
    }
    polygon.hasInnerBoundary = true;
    return triangles;
  }

  /**
   * Equivalent to tmTree::HasFullCP(): cheap gate to check before calling
   * getCPStatus() for the detailed diagnosis.
   */
  hasFullCP() {
    return this.isPolygonValid && this.isPolygonFilled && this.isVertexDepthValid &&
      this.isFacetDataValid && this.isLocalRootConnectable;
  }

  /**
   * Equivalent to tmTree::GetCPStatus(): diagnoses why the crease pattern
   * build (buildPolysAndCreasePattern()) isn't complete, in the same
   * priority order as the original — the first problem found is returned,
   * along with the specific model objects responsible (so the UI can select/
   * highlight them, mirroring tmwxDoc::OnBuildCreasePattern's mSelection
   * calls). Note mIsFeasible (path-condition feasibility) is deliberately
   * NOT consulted here, matching the original: it's a separate concept from
   * crease-pattern buildability.
   * @returns {{status: string, badEdges: tmEdge[], badPolys: tmPoly[], badVertices: tmVertex[], badCreases: tmCrease[], badFacets: tmFacet[]}}
   */
  getCPStatus() {
    const badEdges = [];
    const badPolys = [];
    const badVertices = [];
    const badCreases = [];
    const badFacets = [];
    const result = (status) => ({ status, badEdges, badPolys, badVertices, badCreases, badFacets });

    // Edge lengths are re-checked fresh every time (not a cached flag).
    badEdges.push(...this.edges.filter(edge => edge.getStrainedLength() < MIN_EDGE_LENGTH));
    if (badEdges.length > 0) return result(CPStatus.EDGES_TOO_SHORT);

    if (!this.isPolygonValid) {
      return result(CPStatus.POLYS_NOT_VALID);
    }

    if (!this.isPolygonFilled) {
      badPolys.push(...this.polys.filter(poly => !poly.hasPolyContents()));
      return result(CPStatus.POLYS_NOT_FILLED);
    }

    // Runs unconditionally once the pattern is filled, regardless of the
    // flags below (matches the original's ordering).
    badPolys.push(...this.polys.filter(poly => poly.getNumInactiveBorderPaths() > 1));
    if (badPolys.length > 0) {
      return result(CPStatus.POLYS_MULTIPLE_IBPS);
    }

    if (!this.isVertexDepthValid) {
      badVertices.push(...this.vertices.filter(v => !v.depthValid));
      return result(CPStatus.VERTICES_LACK_DEPTH);
    }

    if (!this.isFacetDataValid) {
      badVertices.push(...this.vertices.filter(v => (
        !v.isBorderVertex() && v.creases.length % 2 !== 0
      )));
      badFacets.push(...this.facets.filter(facet => !facet.isWellFormed));
      return result(CPStatus.FACETS_NOT_VALID);
    }

    if (!this.isLocalRootConnectable) {
      // Equivalent to CalcWhyNotLocalRootConnectable(): identifies the
      // specific vertices/creases blocking facet ordering.
      const why = this.calcWhyNotLocalRootConnectable();
      badVertices.push(...why.badVertices);
      badCreases.push(...why.badCreases);
      return result(CPStatus.NOT_LOCAL_ROOT_CONNECTABLE);
    }

    return result(CPStatus.HAS_FULL_CP);
  }

  // ===== UTILITY METHODS =====

  /**
   * Compute convex hull using the monotone chain algorithm. Returns hull
   * points in CCW order. Unlike the textbook version, points that lie
   * exactly ON a hull edge (collinear with their two neighbors) are kept
   * rather than dropped (pop threshold is `< 0`, not `<= 0`) — several leaf
   * nodes pinned along the same paper edge is a common, not degenerate,
   * case here (see _calcBorderNodesAndPaths()), and the original C++
   * convex-hull walk explicitly keeps every one of them too.
   * @private
   */
  _computeConvexHull(points) {
    if (points.length <= 2) return points;

    // Sort points by x-coordinate (and y if x is same)
    const sorted = [...points].sort((a, b) => {
      if (Math.abs(a.location.x - b.location.x) < 1e-10) {
        return a.location.y - b.location.y;
      }
      return a.location.x - b.location.x;
    });

    // Build lower hull
    const lower = [];
    for (const p of sorted) {
      while (lower.length >= 2) {
        const o = lower[lower.length - 2];
        const a = lower[lower.length - 1];
        if (this._crossProduct(o.location, a.location, p.location) < 0) {
          lower.pop();
        } else {
          break;
        }
      }
      lower.push(p);
    }

    // Build upper hull
    const upper = [];
    for (let i = sorted.length - 1; i >= 0; i--) {
      const p = sorted[i];
      while (upper.length >= 2) {
        const o = upper[upper.length - 2];
        const a = upper[upper.length - 1];
        if (this._crossProduct(o.location, a.location, p.location) < 0) {
          upper.pop();
        } else {
          break;
        }
      }
      upper.push(p);
    }

    // Remove last point of each half because it's repeated
    lower.pop();
    upper.pop();

    return lower.concat(upper);
  }

  /**
   * Cross product to determine turn direction
   * @private
   */
  _crossProduct(o, a, b) {
    return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  }

  /**
   * Invalidate cached state
   * @private
   */
  invalidate() {
    this.isFeasible = false;
    this.isPolygonValid = false;
    this.isPolygonFilled = false;
    this.isVertexDepthValid = false;
    this.isFacetDataValid = false;
    this.isLocalRootConnectable = false;
  }

  /**
   * Clear all parts
   */
  clear() {
    this.nodes = [];
    this.edges = [];
    this.paths = [];
    this.polys = [];
    this.vertices = [];
    this.creases = [];
    this.facets = [];
    this.internalPaths = [];
    this.conditions = [];
    this.rootNode = null;
    this.invalidate();
  }

  /**
   * Clone the entire tree
   */
  clone() {
    return tmTree.fromJSON(this.toJSON());
  }

  /**
   * Export as JSON
   */
  toJSON() {
    return {
      paperWidth: this.paperWidth,
      paperHeight: this.paperHeight,
      scale: this.scale,
      hasSymmetry: this.hasSymmetry,
      symmetryType: this.symmetryType,
      symLoc: { x: this.symLoc.x, y: this.symLoc.y },
      symAngle: this.symAngle,
      nodes: this.nodes.map(n => ({
        id: n.id,
        label: n.label,
        location: { x: n.location.x, y: n.location.y },
        depth: n.depth,
        elevation: n.elevation,
        isLeafNode: n.isLeafNode,
        isPinnedNode: n.isPinnedNode,
        isRootNode: n.isRootNode
      })),
      edges: this.edges.map(e => ({
        id: e.id,
        label: e.label,
        nodeIds: [e.nodes[0]?.id, e.nodes[1]?.id],
        length: e.length,
        strain: e.strain,
        stiffness: e.stiffness
      })),
      paths: this.paths.map(path => ({
        id: path.id,
        label: path.label,
        nodeIds: path.nodes.map(node => node.id),
        isActive: path.isActive,
        isActiveGeometry: path.isActiveGeometry,
        angleFixed: path.angleFixed,
        angle: path.angle,
        angleQuant: path.angleQuant,
        quantValue: path.quantValue,
        quantOffset: path.quantOffset,
        minTreeLength: path.minTreeLength
      })),
      polygons: this.polys.map(poly => ({
        nodeIds: poly.vertices.map(vertex => vertex.getOwner?.()?.id).filter(Boolean),
        triangles: poly.subPolys.map(subPoly => subPoly.vertices
          .map(vertex => vertex.getOwner?.()?.id)
          .filter(Boolean))
      })),
      conditions: this.conditions.map(condition => this._serializeCondition(condition)).filter(Boolean),
      rfSavedQueries: this.rfSavedQueries.map(q => ({ ...q }))
    };
  }

  _serializeCondition(condition) {
    if (condition instanceof ConditionNodeCombo) {
      return {
        type: 'nodeCombo',
        nodeId: condition.getNode()?.id,
        toSymmetryLine: condition.getToSymmetryLine(),
        toPaperEdge: condition.getToPaperEdge(),
        toPaperCorner: condition.getToPaperCorner(),
        xFixed: condition.getXFixed(),
        xFixValue: condition.getXFixValue(),
        yFixed: condition.getYFixed(),
        yFixValue: condition.getYFixValue()
      };
    }
    if (condition instanceof ConditionPathCombo) {
      const nodes = condition.getPath()?.getNodes?.() || [];
      return {
        type: 'pathCombo',
        nodeIds: nodes.map(node => node.id),
        conditions: condition.getConditions().map(item => this._serializeCondition(item)).filter(Boolean)
      };
    }
    if (condition instanceof ConditionNodeFixed) {
      return {
        type: 'nodeFixed',
        nodeId: condition.getNode()?.id,
        xFixed: condition.getXFixed(),
        xFixValue: condition.getXFixValue(),
        yFixed: condition.getYFixed(),
        yFixValue: condition.getYFixValue()
      };
    }
    if (condition instanceof ConditionEdgeLengthFixed) {
      return { type: 'edgeLengthFixed', edgeId: condition.getEdge()?.id, length: condition.getLength() };
    }
    if (condition instanceof ConditionNodesPaired) {
      return { type: 'nodesPaired', node1Id: condition.getNode1()?.id, node2Id: condition.getNode2()?.id };
    }
    if (condition instanceof ConditionNodesCollinear) {
      return {
        type: 'nodesCollinear',
        node1Id: condition.getNode1()?.id,
        node2Id: condition.getNode2()?.id,
        node3Id: condition.getNode3()?.id
      };
    }
    if (condition instanceof ConditionNodeSymmetric) {
      return { type: 'nodeSymmetric', node1Id: condition.getNode1()?.id };
    }
    if (condition instanceof ConditionEdgesSameStrain) {
      return { type: 'edgesSameStrain', edge1Id: condition.getEdge1()?.id, edge2Id: condition.getEdge2()?.id };
    }
    if (condition instanceof ConditionNodeOnCorner) {
      return { type: 'nodeOnCorner', nodeId: condition.getNode()?.id, corner: condition.getCorner() };
    }
    if (condition instanceof ConditionNodeOnEdge) {
      return { type: 'nodeOnEdge', nodeId: condition.getNode()?.id, edge: condition.getEdge(), position: condition.getPosition() };
    }
    if (condition instanceof ConditionPathActive) {
      return { type: 'pathActive', nodeIds: condition.getPath()?.getNodes?.().map(node => node.id) || [] };
    }
    if (condition instanceof ConditionPathAngleFixed) {
      return { type: 'pathAngleFixed', nodeIds: condition.getPath()?.getNodes?.().map(node => node.id) || [], angle: condition.getAngle() };
    }
    if (condition instanceof ConditionPathAngleQuant) {
      return {
        type: 'pathAngleQuant',
        nodeIds: condition.getPath()?.getNodes?.().map(node => node.id) || [],
        quantValue: condition.getQuantValue(),
        quantOffset: condition.getQuantOffset()
      };
    }
    return null;
  }

  /**
   * Import from JSON
   */
  static fromJSON(data) {
    const tree = new tmTree();
    tree.paperWidth = data.paperWidth || 1;
    tree.paperHeight = data.paperHeight || 1;
    tree.scale = data.scale || 0.2;
    tree.hasSymmetry = data.hasSymmetry || false;
    tree.symmetryType = data.symmetryType || (tree.hasSymmetry ? 'diagonal' : 'none');
    tree.symLoc = new tmPoint(data.symLoc?.x || 0.5, data.symLoc?.y || 0.5);
    tree.symAngle = data.symAngle || 0;
    
    // Import nodes
    const nodeMap = new Map();
    for (const nodeData of data.nodes || []) {
      const node = new tmNode(nodeData.id, new tmPoint(nodeData.location.x, nodeData.location.y));
      node.label = nodeData.label;
      node.depth = nodeData.depth;
      node.elevation = nodeData.elevation;
      node.isLeafNode = Boolean(nodeData.isLeafNode);
      node.isPinnedNode = Boolean(nodeData.isPinnedNode);
      node.isRootNode = Boolean(nodeData.isRootNode);
      tree.nodes.push(node);
      nodeMap.set(nodeData.id, node);
    }
    
    // Import edges
    for (const edgeData of data.edges || []) {
      const node1 = nodeMap.get(edgeData.nodeIds[0]);
      const node2 = nodeMap.get(edgeData.nodeIds[1]);
      if (node1 && node2) {
        const edge = new tmEdge(edgeData.id, node1, node2);
        edge.label = edgeData.label;
        edge.length = edgeData.length;
        edge.strain = edgeData.strain || 0;
        edge.stiffness = edgeData.stiffness || 1;
        tree.edges.push(edge);
      }
    }

    for (const pathData of data.paths || []) {
      const pathNodes = (pathData.nodeIds || []).map(id => nodeMap.get(id)).filter(Boolean);
      if (pathNodes.length < 2) continue;
      const path = tree.getPathByNodeIds(pathData.nodeIds);
      if (!path) continue;
      path.id = pathData.id || path.id;
      path.label = pathData.label || '';
      path.isActive = Boolean(pathData.isActive);
      path.isActiveGeometry = Boolean(pathData.isActiveGeometry);
      path.angleFixed = Boolean(pathData.angleFixed);
      path.angle = Number(pathData.angle) || 0;
      path.angleQuant = Boolean(pathData.angleQuant);
      path.quantValue = Number(pathData.quantValue) || 4;
      path.quantOffset = Number(pathData.quantOffset) || 0;
      path.minTreeLength = Number(pathData.minTreeLength) || path.minTreeLength;
    }

    for (const conditionData of data.conditions || []) {
      let condition = null;
      if (conditionData.type === 'nodeCombo') {
        const node = nodeMap.get(conditionData.nodeId);
        if (node) condition = new ConditionNodeCombo(
          tree,
          node,
          Boolean(conditionData.toSymmetryLine),
          Boolean(conditionData.toPaperEdge),
          Boolean(conditionData.toPaperCorner),
          Boolean(conditionData.xFixed),
          Number(conditionData.xFixValue),
          Boolean(conditionData.yFixed),
          Number(conditionData.yFixValue)
        );
      } else if (conditionData.type === 'pathCombo') {
        const pathNodes = (conditionData.nodeIds || []).map(id => nodeMap.get(id)).filter(Boolean);
        const path = pathNodes.length >= 2 ? tree.getPathByNodeIds(conditionData.nodeIds) : null;
        const children = (conditionData.conditions || [])
          .map(item => tmTree._deserializeCondition(tree, item, nodeMap))
          .filter(Boolean);
        if (path) condition = new ConditionPathCombo(tree, path, children);
      } else if (conditionData.type === 'nodeFixed') {
        const node = nodeMap.get(conditionData.nodeId);
        if (node) condition = new ConditionNodeFixed(
          tree,
          node,
          Boolean(conditionData.xFixed),
          Number(conditionData.xFixValue),
          Boolean(conditionData.yFixed),
          Number(conditionData.yFixValue)
        );
      } else if (conditionData.type === 'edgeLengthFixed') {
        const edge = tree.edges.find(item => item.id === conditionData.edgeId);
        if (edge) condition = new ConditionEdgeLengthFixed(tree, edge, Number(conditionData.length));
      } else if (conditionData.type === 'nodesPaired') {
        const node1 = nodeMap.get(conditionData.node1Id);
        const node2 = nodeMap.get(conditionData.node2Id);
        if (node1 && node2) condition = new ConditionNodesPaired(tree, node1, node2);
      } else if (conditionData.type === 'nodesCollinear') {
        const node1 = nodeMap.get(conditionData.node1Id);
        const node2 = nodeMap.get(conditionData.node2Id);
        const node3 = nodeMap.get(conditionData.node3Id);
        if (node1 && node2 && node3) condition = new ConditionNodesCollinear(tree, node1, node2, node3);
      } else if (conditionData.type === 'nodeSymmetric') {
        const node1 = nodeMap.get(conditionData.node1Id);
        if (node1) condition = new ConditionNodeSymmetric(tree, node1);
      } else if (conditionData.type === 'edgesSameStrain') {
        const edge1 = tree.edges.find(edge => edge.id === conditionData.edge1Id);
        const edge2 = tree.edges.find(edge => edge.id === conditionData.edge2Id);
        if (edge1 && edge2) condition = new ConditionEdgesSameStrain(tree, edge1, edge2);
      } else if (conditionData.type === 'nodeOnCorner') {
        const node = nodeMap.get(conditionData.nodeId);
        if (node) condition = new ConditionNodeOnCorner(tree, node, conditionData.corner ?? null);
      } else if (conditionData.type === 'nodeOnEdge') {
        const node = nodeMap.get(conditionData.nodeId);
        if (node) condition = new ConditionNodeOnEdge(tree, node, conditionData.edge ?? null, Number(conditionData.position));
      } else if (conditionData.type === 'pathActive') {
        const pathNodes = (conditionData.nodeIds || []).map(id => nodeMap.get(id)).filter(Boolean);
        if (pathNodes.length >= 2) {
          const path = tree.getPathByNodeIds(conditionData.nodeIds);
          if (path) condition = new ConditionPathActive(tree, path);
        }
      } else if (conditionData.type === 'pathAngleFixed') {
        const pathNodes = (conditionData.nodeIds || []).map(id => nodeMap.get(id)).filter(Boolean);
        if (pathNodes.length >= 2) {
          const path = tree.getPathByNodeIds(conditionData.nodeIds);
          if (path) condition = new ConditionPathAngleFixed(tree, path, Number(conditionData.angle));
        }
      } else if (conditionData.type === 'pathAngleQuant') {
        const pathNodes = (conditionData.nodeIds || []).map(id => nodeMap.get(id)).filter(Boolean);
        if (pathNodes.length >= 2) {
          const path = tree.getPathByNodeIds(conditionData.nodeIds);
          if (path) condition = new ConditionPathAngleQuant(tree, path, Number(conditionData.quantValue), Number(conditionData.quantOffset));
        }
      }
      if (condition) tree.addCondition(condition);
    }

    // Falls back to the first node the same way tmd5ToTree() does: a tree
    // saved before every node correctly carried isRootNode (see the canvas
    // "add node" handler's own fix for that) would otherwise round-trip
    // through undo/redo with rootNode permanently null, and
    // calcDepthAndBend() silently gives up on every vertex the instant it
    // can't find a root — regardless of how well-optimized the tree is.
    tree.rootNode = tree.nodes.find(node => node.isRootNode) || tree.nodes[0] || null;
    if (data.polygons?.length) {
      tree.buildTreePolys();
      const verticesByNodeId = new Map(tree.vertices.map(vertex => [vertex.getOwner()?.id, vertex]));
      for (const polygonData of data.polygons) {
        const polygon = tree.polys.find(poly => polygonData.nodeIds?.every(id => (
          poly.vertices.some(vertex => vertex.getOwner()?.id === id)
        )));
        if (!polygon || !polygonData.triangles?.length) continue;
        for (const triangleIds of polygonData.triangles) {
          const triangleVertices = triangleIds.map(id => verticesByNodeId.get(id)).filter(Boolean);
          if (triangleVertices.length !== 3) continue;
          const triangle = new tmPoly();
          triangle.isTreePoly = false;
          triangleVertices.forEach(vertex => triangle.addVertex(vertex));
          polygon.addSubPoly(triangle);
        }
      }
    }

    tree.rfSavedQueries = (data.rfSavedQueries || []).map(q => ({
      ...q,
      id: q.id || Math.random().toString(36).substr(2, 9)
    }));

    return tree;
  }

  static _deserializeCondition(tree, data, nodeMap) {
    const nodes = ids => (ids || []).map(id => nodeMap.get(id)).filter(Boolean);
    const pathFromData = data.nodeIds?.length >= 2 ? tree.getPathByNodeIds(data.nodeIds) : null;
    if (data.type === 'nodeFixed') {
      const node = nodeMap.get(data.nodeId);
      return node ? new ConditionNodeFixed(tree, node, data.xFixed, data.xFixValue, data.yFixed, data.yFixValue) : null;
    }
    if (data.type === 'nodesPaired') {
      const [first, second] = nodes([data.node1Id, data.node2Id]);
      return first && second ? new ConditionNodesPaired(tree, first, second) : null;
    }
    if (data.type === 'nodesCollinear') {
      const [first, second, third] = nodes([data.node1Id, data.node2Id, data.node3Id]);
      return first && second && third ? new ConditionNodesCollinear(tree, first, second, third) : null;
    }
    if (data.type === 'nodeSymmetric') {
      const [first] = nodes([data.node1Id]);
      return first ? new ConditionNodeSymmetric(tree, first) : null;
    }
    if (data.type === 'nodeOnCorner') {
      const node = nodeMap.get(data.nodeId);
      return node ? new ConditionNodeOnCorner(tree, node, data.corner) : null;
    }
    if (data.type === 'nodeOnEdge') {
      const node = nodeMap.get(data.nodeId);
      return node ? new ConditionNodeOnEdge(tree, node, data.edge, data.position) : null;
    }
    if (data.type === 'edgeLengthFixed') {
      const edge = tree.edges.find(item => item.id === data.edgeId);
      return edge ? new ConditionEdgeLengthFixed(tree, edge, data.length) : null;
    }
    if (data.type === 'edgesSameStrain') {
      const edge1 = tree.edges.find(item => item.id === data.edge1Id);
      const edge2 = tree.edges.find(item => item.id === data.edge2Id);
      return edge1 && edge2 ? new ConditionEdgesSameStrain(tree, edge1, edge2) : null;
    }
    if (data.type === 'nodeCombo') {
      const node = nodeMap.get(data.nodeId);
      return node ? new ConditionNodeCombo(
        tree,
        node,
        Boolean(data.toSymmetryLine),
        Boolean(data.toPaperEdge),
        Boolean(data.toPaperCorner),
        Boolean(data.xFixed),
        Number(data.xFixValue),
        Boolean(data.yFixed),
        Number(data.yFixValue)
      ) : null;
    }
    if (data.type === 'pathActive') return pathFromData ? new ConditionPathActive(tree, pathFromData) : null;
    if (data.type === 'pathAngleFixed') return pathFromData ? new ConditionPathAngleFixed(tree, pathFromData, data.angle) : null;
    if (data.type === 'pathAngleQuant') return pathFromData ? new ConditionPathAngleQuant(tree, pathFromData, data.quantValue, data.quantOffset) : null;
    return null;
  }
}
