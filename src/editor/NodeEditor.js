/**
 * NodeEditor.js
 * Permite editar interactivamente nodos y aristas
 */

import { tmNode, tmEdge, tmPath, tmPoint, StubFinder } from '../model/index.js';

export class NodeEditor {
  constructor(renderer, tree) {
    this.renderer = renderer;
    this.tree = tree;
    
    // Modo de edición
    this.mode = 'select'; // 'select', 'addNode', 'addEdge'
    
    // Estado
    this.selectedNode = null;
    this.selectedEdge = null;
    this.selectedNodes = [];
    this.selectedEdges = [];
    // Array, not a single value, for the same reason as the derived-object
    // key arrays just below: shift+click accumulates a multi-path
    // selection (see _toggleShiftSelection()) same as nodes/edges/vertices/
    // creases/polys — a tmPath is stable across a Build Crease Pattern
    // (unlike vertex/crease/facet/poly), so raw references are kept
    // directly instead of resolving keys against a live list.
    this.selectedPaths = [];
    // Objetos derivados (vértice/crease/facet/poly): se guardan claves, no
    // referencias, porque cada "Build Crease Pattern" (tree.
    // buildPolysAndCreasePattern()) los recrea con ids nuevos (ver tmTree.js).
    // Cada clave se resuelve contra la lista viva del árbol en cada lectura
    // (getters selectedVertices/selectedVertex, etc.) Arrays en vez de un
    // solo valor porque tmwxDoc::OnBuildCreasePattern selecciona TODAS las
    // partes responsables de un build fallido (varios vértices/pliegues/
    // facetas/polígonos a la vez, no solo uno) — ver selectParts().
    this.selectedVertexKeys = [];
    this.selectedCreaseKeys = [];
    this.selectedFacetKeys = [];
    this.selectedPolyKeys = [];
    // Group drag state — a click on a node/edge that's part of the current
    // multi-selection moves every selected node, plus both endpoint nodes
    // of every selected edge, together as one block (see _armGroupDrag()/
    // _dragGroup(), equivalent to tmwxDesignCanvas::OnMouse()'s
    // mMovingNodes). draggingNodes is the set actually moving (already
    // filtered for pinned nodes); dragOrigins remembers each one's location
    // when the drag started, so the whole gesture is a single offset from
    // dragStartWorld rather than an accumulation of per-frame deltas.
    this.draggingNodes = null;
    this._dragOrigins = null;
    this._dragStartWorld = null;
    this.newEdgeStart = null;
    // Nodos que el usuario liberó explícitamente con el botón "Unpin" del
    // inspector — una alternativa de mouse a mantener presionado Alt/Ctrl
    // (ver _handleSelectMode). No es un estado persistente del árbol: en
    // cuanto el nodo se mueve, su geometría deja de ser tirante y
    // isPinnedNode vuelve a false por sí solo en el próximo refresco, así
    // que no hace falta "re-anclarlo" a mano; esto solo evita tener que
    // sostener una tecla mientras se arrastra.
    this.forceMovableNodes = new WeakSet();

    // Tolerancia para click
    this.tolerance = 15;
    this._syncSelection();
  }

  /**
   * Botón "Unpin" del inspector: permite arrastrar el nodo seleccionado en
   * el próximo clic aunque isPinnedNode sea true, sin tener que mantener
   * presionado Alt/Ctrl. Equivalente en efecto al "clickWasModified" del
   * original, pero activado desde el panel en vez de un modificador de
   * teclado.
   */
  unpinSelectedNode() {
    if (this.selectedNode) this.forceMovableNodes.add(this.selectedNode);
  }

  /**
   * Botón "Unpin All" junto a "Maximize Scale": arma el override de todos
   * los nodos actualmente fijos de una sola vez, para no tener que
   * seleccionar y desanclar uno por uno tras cada maximización.
   */
  unpinAllNodes() {
    for (const node of this.tree.getNodes()) {
      if (node.isPinnedNode) this.forceMovableNodes.add(node);
    }
  }

  hasPinnedNodes() {
    return this.tree.getNodes().some(node => node.isPinnedNode);
  }

  /** Clears any in-progress group drag. @private */
  _resetDrag() {
    this.draggingNodes = null;
    this._dragOrigins = null;
    this._dragStartWorld = null;
  }

  /**
   * A vertex's owner-based identity key — see the constructor comment for
   * why keys, not references. A tmNode's getOrMakeVertexSelf() always
   * returns the same one cached vertex, so owner.id alone identifies it.
   * A tmPath is different: it can own several DISTINCT vertices along its
   * length (wherever the path gets subdivided — e.g. another crease
   * crossing it partway, or a bend — see tmPath.js's getOrMakeVertex()),
   * all sharing that one owner.id. Collapsing all of them to just
   * owner.id made every such vertex indistinguishable from its neighbors
   * on the same path — clicking any of them, or the short crease between
   * two of them, resolved back to whichever one happened to come first in
   * tree.getVertices()/getCreases(), not the one actually clicked. Adding
   * the vertex's own index within owner.vertices (kept in stable,
   * geometry-based front-to-back order — see tmPath.js's insertion sort)
   * disambiguates them, and survives a rebuild the same way owner.id does
   * as long as the path's geometry hasn't changed.
   */
  _vertexKey(vertex) {
    const owner = vertex.getOwner();
    if (owner instanceof tmPath) return `${owner.id}#${owner.vertices.indexOf(vertex)}`;
    return owner?.id ?? vertex.id;
  }

  _creaseKey(crease) {
    return [crease.getVertex(0), crease.getVertex(1)]
      .map(v => (v ? this._vertexKey(v) : ''))
      .sort()
      .join(':');
  }

  _facetKey(facet) {
    return facet.getVertices().map(v => this._vertexKey(v)).sort().join(':');
  }

  _polyKey(poly) {
    return poly.getVertices().map(v => this._vertexKey(v)).sort().join(':');
  }

  // Plural getters: every selected item of that type, resolved live against
  // the current tree (never stale references — see the constructor comment).
  get selectedVertices() {
    return this.selectedVertexKeys
      .map(key => this.tree.getVertices().find(v => this._vertexKey(v) === key))
      .filter(Boolean);
  }

  get selectedCreases() {
    return this.selectedCreaseKeys
      .map(key => this.tree.getCreases().find(c => this._creaseKey(c) === key))
      .filter(Boolean);
  }

  get selectedFacets() {
    return this.selectedFacetKeys
      .map(key => this.tree.getFacets().find(f => this._facetKey(f) === key))
      .filter(Boolean);
  }

  get selectedPolys() {
    return this.selectedPolyKeys
      .map(key => this.tree.getAllPolys().find(p => this._polyKey(p) === key))
      .filter(Boolean);
  }

  // Singular getters/keys: only meaningful when exactly one item of that
  // type is selected (used to drive the single-item inspector panels —
  // see getSelected*Info() below and SELECTION_PANELS in main.js). With
  // more than one selected, these are null/empty and the "Multiple
  // Selection" group panel takes over instead.
  get selectedPath() {
    return this.selectedPaths.length === 1 ? this.selectedPaths[0] : null;
  }

  get selectedVertexKey() {
    return this.selectedVertexKeys.length === 1 ? this.selectedVertexKeys[0] : null;
  }

  get selectedCreaseKey() {
    return this.selectedCreaseKeys.length === 1 ? this.selectedCreaseKeys[0] : null;
  }

  get selectedFacetKey() {
    return this.selectedFacetKeys.length === 1 ? this.selectedFacetKeys[0] : null;
  }

  get selectedPolyKey() {
    return this.selectedPolyKeys.length === 1 ? this.selectedPolyKeys[0] : null;
  }

  get selectedVertex() {
    return this.selectedVertexKeys.length === 1 ? (this.selectedVertices[0] ?? null) : null;
  }

  get selectedCrease() {
    return this.selectedCreaseKeys.length === 1 ? (this.selectedCreases[0] ?? null) : null;
  }

  get selectedFacet() {
    return this.selectedFacetKeys.length === 1 ? (this.selectedFacets[0] ?? null) : null;
  }

  get selectedPoly() {
    return this.selectedPolyKeys.length === 1 ? (this.selectedPolys[0] ?? null) : null;
  }

  _clearDerivedSelection() {
    this.selectedVertexKeys = [];
    this.selectedCreaseKeys = [];
    this.selectedFacetKeys = [];
    this.selectedPolyKeys = [];
  }

  _selectSingleDerived(kind, key) {
    this.selectedNode = null;
    this.selectedEdge = null;
    this.selectedNodes = [];
    this.selectedEdges = [];
    this.selectedPaths = [];
    this._clearDerivedSelection();
    if (kind === 'vertex') this.selectedVertexKeys = [key];
    else if (kind === 'crease') this.selectedCreaseKeys = [key];
    else if (kind === 'facet') this.selectedFacetKeys = [key];
    this._resetDrag();
    this._syncSelection();
  }

  selectPoly(poly) {
    this.selectedNode = null;
    this.selectedEdge = null;
    this.selectedNodes = [];
    this.selectedEdges = [];
    this.selectedPaths = [];
    this._clearDerivedSelection();
    this.selectedPolyKeys = poly ? [this._polyKey(poly)] : [];
    this._syncSelection();
  }

  /**
   * Generic multi-type "replace the whole selection with exactly these
   * parts" — used both for tmwxDoc::OnBuildCreasePattern()'s "select every
   * part responsible for the failure" and for tmwxDoc::
   * OnSelectCorridorFacets() (see selectCorridorFacets() below).
   */
  selectParts({ edges = [], polys = [], vertices = [], creases = [], facets = [] } = {}) {
    this.selectedNode = null;
    this.selectedEdge = null;
    this.selectedNodes = [];
    this.selectedEdges = [...edges];
    this.selectedPaths = [];
    this.selectedVertexKeys = vertices.map(v => this._vertexKey(v));
    this.selectedCreaseKeys = creases.map(c => this._creaseKey(c));
    this.selectedFacetKeys = facets.map(f => this._facetKey(f));
    this.selectedPolyKeys = polys.map(p => this._polyKey(p));
    this._resetDrag();
    this._syncSelection();
  }

  _syncSelection() {
    this.renderer.selectedObjects = [
      ...this.selectedNodes,
      ...this.selectedEdges,
      ...this.selectedPaths,
      ...this.selectedVertices,
      ...this.selectedCreases,
      ...this.selectedFacets,
      ...this.selectedPolys
    ];
  }

  selectNode(node) {
    this.selectedNode = node;
    this.selectedEdge = null;
    this.selectedNodes = node ? [node] : [];
    this.selectedEdges = [];
    this.selectedPaths = [];
    this._clearDerivedSelection();
    this._syncSelection();
  }

  selectEdge(edge) {
    this.selectedEdge = edge;
    this.selectedNode = null;
    this.selectedEdges = edge ? [edge] : [];
    this.selectedNodes = [];
    this.selectedPaths = [];
    this._clearDerivedSelection();
    this._syncSelection();
  }

  /**
   * Select a path directly — tmSelection::ChangeToPart(aPath)'s equivalent:
   * replaces the whole selection with just this path (not one of its
   * nodes), matching how the original treats a path as its own selectable
   * part. main.js's node+"To:" dropdown flow to build a path condition
   * from any two nodes (not just a currently-drawn/clickable one) is a
   * separate, complementary path into the same path panel — see
   * getSelectedPathInfo().
   */
  selectPath(path) {
    this.selectedNode = null;
    this.selectedEdge = null;
    this.selectedNodes = [];
    this.selectedEdges = [];
    this._clearDerivedSelection();
    this.selectedPaths = path ? [path] : [];
    this._syncSelection();
  }

  /**
   * The tree's list of parts of a given type, in the same order and
   * 1-based indexing that selectPartByIndex()/isPartSelected() and the
   * "Select Part by Index" panel use.
   */
  getPartsByType(partType) {
    const listByType = {
      node: this.tree.getNodes(),
      edge: this.tree.getEdges(),
      path: this.tree.getPaths(),
      poly: this.tree.getAllPolys(),
      vertex: this.tree.getVertices(),
      crease: this.tree.getCreases(),
      facet: this.tree.getFacets()
    };
    const list = listByType[partType];
    if (!list) throw new Error(`Unknown part type: ${partType}`);
    return list;
  }

  /**
   * Whether `part` (an element from getPartsByType(partType)) is currently
   * selected — used to highlight the matching index button in the "Select
   * Part by Index" panel.
   */
  isPartSelected(partType, part) {
    switch (partType) {
      case 'node': return this.selectedNodes.includes(part);
      case 'edge': return this.selectedEdges.includes(part);
      case 'path': return this.selectedPaths.includes(part);
      case 'poly': return this.selectedPolys.includes(part);
      case 'vertex': return this.selectedVertices.includes(part);
      case 'crease': return this.selectedCreases.includes(part);
      case 'facet': return this.selectedFacets.includes(part);
      default: return false;
    }
  }

  /**
   * Equivalent to tmwxSelectPartByIndexDialog::TransferDataFromWindow() +
   * tmSelection::ChangeToPart(): by default replaces the entire selection
   * with a single part, found by its 1-based index within the tree's list
   * of that part type. Throws a typed error — `{ reason: 'empty' | 'range',
   * partType, max }` — matching the two failure cases
   * tmwxSelectPartByIndexDialog::Validate() reports; main.js turns that
   * into the same user-facing message the original dialog shows.
   *
   * `additive: true` (the "Select Part by Index" panel's "Multiple
   * Selection" checkbox) toggles the part in/out of the existing
   * same-type selection instead — see togglePartSelection().
   */
  selectPartByIndex(partType, oneBasedIndex, { additive = false } = {}) {
    const list = this.getPartsByType(partType);
    if (list.length === 0) {
      const error = new Error(`No ${partType} to select by index`);
      error.reason = 'empty';
      error.partType = partType;
      throw error;
    }
    const index = Number(oneBasedIndex);
    if (!Number.isInteger(index) || index < 1 || index > list.length) {
      const error = new Error(`${partType} index out of range`);
      error.reason = 'range';
      error.partType = partType;
      error.max = list.length;
      throw error;
    }
    const part = list[index - 1];
    if (additive) {
      this.togglePartSelection(partType, part);
      return { part };
    }
    switch (partType) {
      case 'node': this.selectNode(part); break;
      case 'edge': this.selectEdge(part); break;
      case 'poly': this.selectPoly(part); break;
      case 'vertex': this._selectSingleDerived('vertex', this._vertexKey(part)); break;
      case 'crease': this._selectSingleDerived('crease', this._creaseKey(part)); break;
      case 'facet': this._selectSingleDerived('facet', this._facetKey(part)); break;
      case 'path': this.selectPath(part); break;
      default: throw new Error(`Unknown part type: ${partType}`);
    }
    return { part };
  }

  /**
   * Toggles `part` (an element from getPartsByType(partType)) in/out of
   * the selection, clearing every OTHER type's selection first — the same
   * accumulate/toggle semantics as canvas shift+click (_toggleShiftSelection
   * and the node/edge shift-click branches in _handleSelectMode()), but
   * generalized to all 7 part types the "Select Part by Index" panel
   * offers (shift+click on the canvas doesn't reach facet, and can only
   * ever toggle whichever part type happens to be under the cursor).
   */
  togglePartSelection(partType, part) {
    if (partType !== 'node') { this.selectedNode = null; this.selectedNodes = []; }
    if (partType !== 'edge') { this.selectedEdge = null; this.selectedEdges = []; }
    if (partType !== 'path') this.selectedPaths = [];
    if (partType !== 'vertex') this.selectedVertexKeys = [];
    if (partType !== 'crease') this.selectedCreaseKeys = [];
    if (partType !== 'facet') this.selectedFacetKeys = [];
    if (partType !== 'poly') this.selectedPolyKeys = [];
    this._resetDrag();

    switch (partType) {
      case 'node': {
        const i = this.selectedNodes.indexOf(part);
        if (i >= 0) this.selectedNodes.splice(i, 1);
        else this.selectedNodes.push(part);
        this.selectedNode = this.selectedNodes.length === 1 ? this.selectedNodes[0] : null;
        break;
      }
      case 'edge': {
        const i = this.selectedEdges.indexOf(part);
        if (i >= 0) this.selectedEdges.splice(i, 1);
        else this.selectedEdges.push(part);
        this.selectedEdge = this.selectedEdges.length === 1 ? this.selectedEdges[0] : null;
        break;
      }
      case 'path': {
        const i = this.selectedPaths.indexOf(part);
        if (i >= 0) this.selectedPaths.splice(i, 1);
        else this.selectedPaths.push(part);
        break;
      }
      case 'vertex': case 'crease': case 'facet': case 'poly': {
        const keyFns = { vertex: this._vertexKey, crease: this._creaseKey, facet: this._facetKey, poly: this._polyKey };
        const keyFields = { vertex: 'selectedVertexKeys', crease: 'selectedCreaseKeys', facet: 'selectedFacetKeys', poly: 'selectedPolyKeys' };
        const key = keyFns[partType].call(this, part);
        const arr = this[keyFields[partType]];
        const i = arr.indexOf(key);
        if (i >= 0) arr.splice(i, 1);
        else arr.push(key);
        break;
      }
      default: throw new Error(`Unknown part type: ${partType}`);
    }
    this._syncSelection();
  }

  getSelectionCount() {
    return this.selectedNodes.length + this.selectedEdges.length +
      this.selectedPaths.length +
      this.selectedVertexKeys.length +
      this.selectedCreaseKeys.length +
      this.selectedFacetKeys.length +
      this.selectedPolyKeys.length;
  }

  getSelectionCounts() {
    return {
      nodes: this.selectedNodes.length,
      edges: this.selectedEdges.length,
      paths: this.selectedPaths.length,
      vertices: this.selectedVertexKeys.length,
      creases: this.selectedCreaseKeys.length,
      facets: this.selectedFacetKeys.length,
      polys: this.selectedPolyKeys.length
    };
  }

  clearSelection() {
    this.selectedNode = null;
    this.selectedEdge = null;
    this.selectedNodes = [];
    this.selectedEdges = [];
    this.selectedPaths = [];
    this._clearDerivedSelection();
    this._resetDrag();
    this._syncSelection();
  }

  // tmwxDoc::OnSelectAll() only selects every node and edge in the
  // original — deliberately widened here (2026-08-31) to select every
  // part of every selectable type, now that this SPA's own multi-selection
  // supports all of them (see the shift-click generalization above). The
  // original's own node+edge-only behavior is still available separately
  // as selectNodesAndEdges() below (its own button, and what Ctrl+A calls).
  selectAll() {
    this.selectedNodes = [...this.tree.getNodes()];
    this.selectedEdges = [...this.tree.getEdges()];
    this.selectedPaths = [...this.tree.getPaths()];
    this.selectedVertexKeys = this.tree.getVertices().map(v => this._vertexKey(v));
    this.selectedCreaseKeys = this.tree.getCreases().map(c => this._creaseKey(c));
    this.selectedFacetKeys = this.tree.getFacets().map(f => this._facetKey(f));
    this.selectedPolyKeys = this.tree.getAllPolys().map(p => this._polyKey(p));
    this.selectedNode = null;
    this.selectedEdge = null;
    this._resetDrag();
    this._syncSelection();
  }

  // Equivalent to tmwxDoc::OnSelectAll(): clears the whole selection, then
  // selects every node and every edge, nothing else — see selectAll()'s
  // comment above for why that one is no longer this.
  selectNodesAndEdges() {
    this._clearDerivedSelection();
    this.selectedNodes = [...this.tree.getNodes()];
    this.selectedEdges = [...this.tree.getEdges()];
    this.selectedNode = null;
    this.selectedEdge = null;
    this.selectedPaths = [];
    this._resetDrag();
    this._syncSelection();
  }

  // Equivalent to tmwxDoc::OnSelectMovableParts(): select every node and
  // edge, then narrow that down to just the movable ones (unpinned leaf
  // nodes, unpinned non-length-fixed edges — see tmTree.filterMovableParts()).
  selectMovableParts() {
    this._clearDerivedSelection();
    const { nodes, edges } = this.tree.filterMovableParts(this.tree.getNodes(), this.tree.getEdges());
    this.selectedNodes = nodes;
    this.selectedEdges = edges;
    this.selectedNode = null;
    this.selectedEdge = null;
    this.selectedPaths = [];
    this._resetDrag();
    this._syncSelection();
  }

  /**
   * Equivalent to tmwxDoc::OnSelectPathFromNodes(): only meaningful when
   * exactly two nodes are currently selected — replaces the selection with
   * the path connecting them (via selectPath()). Returns true, or false if
   * the precondition (exactly 2 selected nodes with a path between them)
   * isn't met.
   */
  selectPathFromNodes() {
    if (this.selectedNodes.length !== 2) return false;
    const [nodeA, nodeB] = this.selectedNodes;
    const path = this.tree.getPath(nodeA, nodeB);
    if (!path) return false;
    this.selectPath(path);
    return true;
  }

  // Equivalent to tmwxDoc::OnSelectCorridorFacets(): replaces the
  // selection with every facet belonging to a corridor associated with the
  // CURRENTLY selected edges (so select the edge(s) first, then this).
  selectCorridorFacets() {
    const facets = this.tree.getCorridorFacets(this.selectedEdges);
    this.selectParts({ facets });
  }

  /**
   * Cambiar modo de edición
   */
  setMode(mode) {
    this.mode = mode;
    console.log(`Modo: ${mode}`);

    // Limpiar selecciones
    this.selectedNode = null;
    this.selectedEdge = null;
    this.selectedNodes = [];
    this.selectedEdges = [];
    this.selectedPaths = [];
    this._clearDerivedSelection();
    this.newEdgeStart = null;
    this._syncSelection();
  }

  /**
   * Manejar click del ratón
   */
  onMouseDown(e, screenX, screenY) {
    if (this.mode === 'select') {
      this._handleSelectMode(e, screenX, screenY);
    } else if (this.mode === 'addNode') {
      this._handleAddNodeMode(screenX, screenY);
    } else if (this.mode === 'addEdge') {
      this._handleAddEdgeMode(screenX, screenY);
    }
  }

  /**
   * Manejar movimiento del ratón
   */
  onMouseMove(e, screenX, screenY) {
    if (this.draggingNodes) {
      this._dragGroup(screenX, screenY);
    }
  }

  /**
   * Manejar liberación del ratón
   */
  onMouseUp(e) {
    if (this.draggingNodes) {
      this._resetDrag();
      console.log('Selección movida');
    }
  }

  // ===== MODO SELECT =====

  /**
   * Toggles `part` in/out of its own type's selection array, clearing
   * every OTHER type's selection first — see the shift-click branch in
   * _handleSelectMode() for why this has to run ahead of the blanket
   * single-selection reset. `type` is one of 'path' | 'vertex' | 'crease' |
   * 'poly'; node/edge keep their own inline shift-click handling below
   * since they never needed the key-array indirection the derived types do.
   * @private
   */
  _toggleShiftSelection(type, part) {
    this.selectedNode = null;
    this.selectedEdge = null;
    this.selectedNodes = [];
    this.selectedEdges = [];
    if (type !== 'path') this.selectedPaths = [];
    if (type !== 'vertex') this.selectedVertexKeys = [];
    if (type !== 'crease') this.selectedCreaseKeys = [];
    if (type !== 'poly') this.selectedPolyKeys = [];
    this.selectedFacetKeys = [];

    if (type === 'path') {
      const index = this.selectedPaths.indexOf(part);
      if (index >= 0) this.selectedPaths.splice(index, 1);
      else this.selectedPaths.push(part);
    } else {
      const keyFns = { vertex: this._vertexKey, crease: this._creaseKey, poly: this._polyKey };
      const keyFields = { vertex: 'selectedVertexKeys', crease: 'selectedCreaseKeys', poly: 'selectedPolyKeys' };
      const key = keyFns[type].call(this, part);
      const arr = this[keyFields[type]];
      const index = arr.indexOf(key);
      if (index >= 0) arr.splice(index, 1);
      else arr.push(key);
    }
    this._resetDrag();
    this._syncSelection();
  }

  /**
   * Manejo del modo de selección
   * @private
   */
  _handleSelectMode(e, screenX, screenY) {
    const obj = this.renderer.getObjectAtPoint(screenX, screenY, this.tolerance);

    // Shift+click on a path/vertex/crease/poly accumulates a multi-selection
    // of that SAME type instead of replacing it — mirrors node/edge below
    // (also matches tmwxDesignCanvas::OnMouse()'s generic ExtendSelection<P>()
    // in the original, applied there to every clickable part type, not
    // just nodes/edges). Originally added for crease alone — a single
    // straight crease line in the built pattern can be split into several
    // tmCrease segments (an interior vertex inserted wherever another
    // crease crosses it partway — see tmPath.js's connectSelfVertices()),
    // and ReferenceFinder needs every segment of one such line selected at
    // once to search the whole line (see main.js's rfCreaseChainPanel) —
    // then widened to path/vertex/poly for the same reason node/edge
    // already had it: nothing in the original restricts multi-select to
    // just two part types. Has to run before the blanket
    // _clearDerivedSelection() a plain click needs below (to swap between
    // a single vertex/crease/facet/poly/path selection), or a shift-click
    // would immediately wipe whatever was already accumulated.
    if (e.shiftKey && ['path', 'vertex', 'crease', 'poly'].includes(obj?.type)) {
      this._toggleShiftSelection(obj.type, obj.object);
      return;
    }

    // Cualquier click en modo selección reemplaza la selección derivada
    // (vértice/crease/facet/poly) y la selección de camino; las ramas de
    // vértice/crease/facet/path vuelven a fijar su propio estado
    // inmediatamente después (via _selectSingleDerived / selectPath).
    this._clearDerivedSelection();
    this.selectedPaths = [];
    // Every fresh mousedown starts from "nothing is being dragged" — the
    // branches below re-arm it only when this click actually starts a valid
    // drag (a movable node, clicked without shift).
    this._resetDrag();

    if (obj?.type === 'node') {
      if (e.shiftKey) {
        const index = this.selectedNodes.indexOf(obj.object);
        if (index >= 0) this.selectedNodes.splice(index, 1);
        else this.selectedNodes.push(obj.object);
        this.selectedNode = this.selectedNodes.length === 1 && this.selectedEdges.length === 0
          ? this.selectedNodes[0] : null;
        this.selectedEdge = null;
      } else if (!this.selectedNodes.includes(obj.object)) {
        // A plain click on a node outside the current selection replaces
        // the whole selection with just it — same as tmwxDoc::
        // ExtendSelection()'s non-shift "make it the whole selection"
        // branch. Clicking one that's ALREADY selected leaves the whole
        // multi-part selection (nodes + edges) untouched instead, so the
        // group drag armed below moves the entire block — matching the
        // original, where a normal click on an already-selected part is a
        // no-op on the selection itself (ExtendSelection()'s "no change"
        // branch), not a collapse to just that one part.
        this.selectedNode = obj.object;
        this.selectedEdge = null;
        this.selectedNodes = [obj.object];
        this.selectedEdges = [];
      }
      this._syncSelection();
      this._armGroupDrag(e, screenX, screenY);
      console.log(`Nodo seleccionado: ${obj.object.label}`);
    } else if (obj?.type === 'edge') {
      if (e.shiftKey) {
        const index = this.selectedEdges.indexOf(obj.object);
        if (index >= 0) this.selectedEdges.splice(index, 1);
        else this.selectedEdges.push(obj.object);
      } else if (!this.selectedEdges.includes(obj.object)) {
        this.selectedEdges = [obj.object];
        this.selectedNodes = [];
      }
      this.selectedNode = this.selectedNodes.length === 1 && this.selectedEdges.length === 0
        ? this.selectedNodes[0] : null;
      this.selectedEdge = this.selectedEdges.length === 1 && this.selectedNodes.length === 0
        ? this.selectedEdges[0] : null;
      this._syncSelection();
      this._armGroupDrag(e, screenX, screenY);
      console.log(`Arista seleccionada`);
    } else if (obj?.type === 'path') {
      // Clicking a path line (see tmwxDesignCanvas::OnMouse()'s tmPath
      // priority) selects it directly, same as clicking a node or edge.
      this.selectPath(obj.object);
      console.log(`Camino seleccionado: ${obj.object.getLabel()}`);
    } else if (obj?.type === 'vertex') {
      this._selectSingleDerived('vertex', this._vertexKey(obj.object));
    } else if (obj?.type === 'crease') {
      this._selectSingleDerived('crease', this._creaseKey(obj.object));
    } else if (obj?.type === 'facet') {
      this._selectSingleDerived('facet', this._facetKey(obj.object));
    } else if (obj?.type === 'poly') {
      // Equivalent to tmwxDesignCanvas::OnMouse()'s tmPoly branch: clicking
      // inside a built polygon's interior selects it, same as the original
      // (the "Inspect Polygon" dropdown this replaced only ever offered the
      // same tree.getPolys() list).
      this.selectPoly(obj.object);
    } else {
      this.clearSelection();
    }
  }

  // ===== MODO AGREGAR NODO =====

  /**
   * Manejo del modo agregar nodo
   * @private
   */
  _handleAddNodeMode(screenX, screenY) {
    const world = this.renderer.screenToWorld(screenX, screenY);
    const width = this.tree.getPaperWidth();
    const height = this.tree.getPaperHeight();
    if (world.x < 0 || world.x > width || world.y < 0 || world.y > height) {
      return;
    }

    // Crear nodo
    const node = new tmNode(null, new tmPoint(world.x, world.y));
    node.label = this.tree._nextNodeLabel();
    node.isLeafNode = true;
    
    this.tree.nodes.push(node);
    
    console.log(`Nodo agregado: ${node.label} en (${world.x.toFixed(2)}, ${world.y.toFixed(2)})`);
  }

  // ===== MODO AGREGAR ARISTA =====

  /**
   * Manejo del modo agregar arista
   * @private
   */
  _handleAddEdgeMode(screenX, screenY) {
    const obj = this.renderer.getObjectAtPoint(screenX, screenY, this.tolerance);

    if (obj?.type === 'node') {
      if (!this.newEdgeStart) {
        // Primer nodo
        this.newEdgeStart = obj.object;
        console.log(`Inicio de arista: ${this.newEdgeStart.label}`);
      } else if (obj.object !== this.newEdgeStart) {
        // Segundo nodo - crear arista (el patrón de pliegues no se
        // reconstruye automáticamente, igual que en el programa original;
        // hace falta "Build Crease Pattern" explícito)
        const edge = this.tree.addEdge(this.newEdgeStart, obj.object);

        console.log(`Arista agregada: ${this.newEdgeStart.label} - ${obj.object.label}`);

        // Reset
        this.newEdgeStart = null;
      } else {
        // Cancelar
        this.newEdgeStart = null;
      }
    }
  }

  // ===== OPERACIONES =====

  /**
   * Arms a group drag for the current selection — equivalent to
   * tmwxDesignCanvas::OnMouse()'s mMovingNodes construction: the set of
   * nodes that a drag starting now will move is every currently selected
   * node, plus both endpoint nodes of every currently selected edge (a
   * node reachable both ways — directly selected AND as an edge's
   * endpoint — is only moved once). Each candidate is filtered out if
   * pinned, same as a single-node drag always was, unless overridden by
   * Alt/Ctrl (the original's own override) or forceMovableNodes (this
   * port's mouse-only "Unpin" equivalent — see the constructor comment).
   * No-ops (leaves the drag unarmed) if the resulting set is empty, same
   * as the original returning early when mMovingNodes.empty().
   * @private
   */
  _armGroupDrag(e, screenX, screenY) {
    const forceMovable = e.altKey || e.ctrlKey;
    const isMovable = (node) => forceMovable || !node.isPinnedNode || this.forceMovableNodes.has(node);

    const moving = new Set();
    for (const node of this.selectedNodes) {
      if (isMovable(node)) moving.add(node);
    }
    for (const edge of this.selectedEdges) {
      for (const node of edge.getNodes()) {
        if (node && isMovable(node)) moving.add(node);
      }
    }

    if (moving.size === 0) {
      this._resetDrag();
      return;
    }
    this.draggingNodes = [...moving];
    this._dragOrigins = new Map(this.draggingNodes.map(n => [n, new tmPoint(n.getLocX(), n.getLocY())]));
    this._dragStartWorld = this.renderer.screenToWorld(screenX, screenY);
  }

  /**
   * Drags the whole armed group (see _armGroupDrag()) by the same
   * screen-space offset — equivalent to the original's CalcLoc(): each
   * node's new position is its own location when the drag started plus the
   * total offset since, not the raw cursor position (only the node
   * actually grabbed sits under the cursor; the rest of the block moves in
   * lockstep alongside it). Each node is clamped to the paper independently,
   * same as a single dragged node already was — a node at the edge of a
   * dragged block can hit the paper boundary before the rest of the block
   * does.
   * @private
   */
  _dragGroup(screenX, screenY) {
    if (!this.draggingNodes || !this._dragStartWorld) return;

    const world = this.renderer.screenToWorld(screenX, screenY);
    const dx = world.x - this._dragStartWorld.x;
    const dy = world.y - this._dragStartWorld.y;
    const width = this.tree.getPaperWidth();
    const height = this.tree.getPaperHeight();
    for (const node of this.draggingNodes) {
      const origin = this._dragOrigins.get(node);
      node.location.x = Math.min(width, Math.max(0, origin.x + dx));
      node.location.y = Math.min(height, Math.max(0, origin.y + dy));
    }
  }

  /**
   * Eliminar nodo seleccionado
   */
  deleteSelectedNode() {
    if (!this.selectedNode) {
      console.warn('No hay nodo seleccionado');
      return;
    }

    if (this.selectedNode.getDegree() !== 1) {
      console.warn('Solo se pueden eliminar nodos punta');
      return;
    }

    this.tree.removeNode(this.selectedNode);

    console.log(`Nodo eliminado: ${this.selectedNode.label}`);

    this.selectedNode = null;
    this._syncSelection();
  }

  /**
   * Eliminar arista seleccionada
   */
  deleteSelectedEdge() {
    if (!this.selectedEdge) {
      console.warn('No hay arista seleccionada');
      return;
    }

    this.tree.removeEdge(this.selectedEdge);

    console.log('Arista eliminada');

    this.selectedEdge = null;
  }

  /**
   * Cambiar etiqueta del nodo seleccionado
   */
  setSelectedNodeLabel(label) {
    if (!this.selectedNode) {
      console.warn('No hay nodo seleccionado');
      return;
    }

    this.selectedNode.label = label;
    console.log(`Etiqueta actualizada: ${label}`);
  }

  /**
   * Mover el nodo seleccionado a una posición absoluta (misma acción que
   * arrastrarlo con el mouse, no una condición). Se recorta a los límites
   * del papel igual que _dragGroup().
   */
  setSelectedNodePosition(x, y) {
    if (!this.selectedNode) {
      console.warn('No hay nodo seleccionado');
      return;
    }

    const width = this.tree.getPaperWidth();
    const height = this.tree.getPaperHeight();
    this.selectedNode.location.x = Math.min(width, Math.max(0, Number(x)));
    this.selectedNode.location.y = Math.min(height, Math.max(0, Number(y)));
  }

  /**
   * Cambiar longitud de arista seleccionada
   */
  setSelectedEdgeLength(length) {
    if (!this.selectedEdge) {
      console.warn('No hay arista seleccionada');
      return;
    }

    length = Number(length);
    this.selectedEdge.length = length;
    this.tree.refreshPathStates();

    console.log(`Longitud actualizada: ${length.toFixed(3)}`);
  }

  /**
   * Cambiar tensión (strain) de la arista seleccionada. A diferencia del
   * largo, la tensión no cambia la topología del patrón de pliegues (solo
   * el largo efectivo usado al calcular restricciones de caminos), así que
   * alcanza con refrescar el estado de los caminos, no reconstruir polys.
   */
  setSelectedEdgeStrain(strain) {
    if (!this.selectedEdge) {
      console.warn('No hay arista seleccionada');
      return;
    }

    const value = Math.max(-0.999, Math.min(2, Number(strain) || 0));
    this.selectedEdge.setStrain(value);
    this.tree.refreshPathStates();

    console.log(`Tensión actualizada: ${value.toFixed(3)}`);
  }

  /**
   * Cambiar rigidez (stiffness) de la arista seleccionada: el peso con que
   * "Escalar selección"/"Escalar todo (strain)" penalizan tensar esta
   * arista en particular (objetivo = Σ stiffness · strain²) — una arista
   * más rígida se resiste más a estirarse, así que el optimizador prefiere
   * tensar las aristas de menor rigidez. Al igual que la tensión, no
   * cambia la topología del patrón, solo alcanza con refrescar caminos.
   */
  setSelectedEdgeStiffness(stiffness) {
    if (!this.selectedEdge) {
      console.warn('No hay arista seleccionada');
      return;
    }

    const value = Math.max(0.001, Number(stiffness) || 1);
    this.selectedEdge.setStiffness(value);
    this.tree.refreshPathStates();

    console.log(`Rigidez actualizada: ${value.toFixed(3)}`);
  }

  /**
   * Equivalent to tmwxDoc::OnMakeNodeRoot(): establecer el nodo
   * seleccionado como raíz. No-op (con aviso) si no hay nodo seleccionado
   * o si tree.canMakeNodeRoot() lo rechaza (ya es la raíz, o es un
   * subnodo geométrico en vez de un nodo real del árbol).
   */
  setSelectedNodeAsRoot() {
    if (!this.selectedNode) {
      console.warn('No hay nodo seleccionado');
      return;
    }
    if (!this.tree.canMakeNodeRoot(this.selectedNode)) {
      console.warn('Este nodo no puede ser la raíz');
      return;
    }

    this.tree.setRootNode(this.selectedNode);
    console.log(`Raíz actualizada: ${this.selectedNode.label}`);
  }

  // Equivalent to tmwxDoc::OnPerturbSelectedNodes().
  perturbSelectedNodes() {
    if (this.selectedNodes.length === 0) {
      console.warn('No hay nodos seleccionados');
      return;
    }
    this.tree.perturbNodes(this.selectedNodes);
  }

  // Equivalent to tmwxDoc::OnPerturbAllNodes().
  perturbAllNodes() {
    this.tree.perturbAllNodes();
  }

  // Equivalent to tmwxDoc::OnSetEdgeLength().
  setSelectedEdgeLengths(length) {
    if (this.selectedEdges.length === 0) return;
    this.tree.setEdgeLengths(this.selectedEdges, length);
  }

  // Equivalent to tmwxDoc::OnScaleEdgeLength().
  scaleSelectedEdgeLengths(factor) {
    if (this.selectedEdges.length === 0) return;
    this.tree.scaleEdgeLengths(this.selectedEdges, factor);
  }

  // Equivalent to tmwxDoc::OnRenormalizeToEdge(): only meaningful with
  // exactly one edge selected (and nothing else — see
  // ContainsExclusively<tmEdge>(1) in the original).
  renormalizeToSelectedEdge() {
    if (this.selectedEdges.length !== 1 || this.getSelectionCount() !== 1) return;
    this.tree.renormalizeToUnitEdge(this.selectedEdges[0]);
  }

  // Equivalent to tmwxDoc::OnRenormalizeToUnitScale().
  renormalizeToUnitScale() {
    this.tree.renormalizeToUnitScale();
  }

  // Equivalent to tmwxDoc::OnAbsorbSelectedNodes(): absorbs every
  // currently-selected node (each must be degree-2).
  absorbSelectedNodes() {
    if (this.selectedNodes.length === 0 || !this.tree.canAbsorbNodes(this.selectedNodes)) return;
    this.tree.absorbNodes(this.selectedNodes);
    this.clearSelection();
  }

  // Equivalent to tmwxDoc::OnAbsorbRedundantNodes().
  absorbRedundantNodes() {
    if (!this.tree.canAbsorbRedundantNodes()) return;
    this.tree.absorbRedundantNodes();
    this.clearSelection();
  }

  // Equivalent to tmwxDoc::OnAbsorbSelectedEdges(): absorbs every
  // currently-selected edge.
  absorbSelectedEdges() {
    if (this.selectedEdges.length === 0) return;
    this.tree.absorbEdges(this.selectedEdges);
    this.clearSelection();
  }

  // Equivalent to tmwxDoc::OnSplitSelectedEdge(): only meaningful with
  // exactly one edge selected. Selects the new node afterward, matching
  // how the original leaves the split point as the natural point of
  // interest.
  splitSelectedEdge(splitLoc, isDistance = false) {
    if (this.selectedEdges.length !== 1) return null;
    const newNode = this.tree.splitEdge(this.selectedEdges[0], splitLoc, isDistance);
    this.selectNode(newNode);
    return newNode;
  }

  // Equivalent to tmwxDoc::OnRemoveSelectionStrain()/OnRemoveAllStrain().
  removeSelectionStrain() {
    this.tree.removeStrain(this.selectedEdges);
  }

  removeAllStrain() {
    this.tree.removeAllStrain();
  }

  // Equivalent to tmwxDoc::OnRelieveSelectionStrain()/OnRelieveAllStrain().
  relieveSelectionStrain() {
    this.tree.relieveStrain(this.selectedEdges);
  }

  relieveAllStrain() {
    this.tree.relieveAllStrain();
  }

  // Equivalent to tmwxDoc::DoPickStub()'s stub-finding half: every stub
  // candidate (4+ active paths) for the given node list, sorted largest
  // first (matches tmStubFinder::FindAllStubs() feeding the original's
  // "pick one" dialog).
  findStubsFor(nodeList) {
    return new StubFinder(this.tree).findAllStubs(nodeList);
  }

  // Equivalent to tmwxDoc::OnPickStubNodes()'s stub-finding half: needs at
  // least 4 selected nodes.
  findStubsForSelectedNodes() {
    if (this.selectedNodes.length < 4) return [];
    return this.findStubsFor(this.selectedNodes);
  }

  // Equivalent to tmwxDoc::OnPickStubPoly()'s stub-finding half: needs
  // exactly one selected poly with at least 4 ring nodes.
  findStubsForSelectedPoly() {
    const poly = this.selectedPoly;
    if (!poly || poly.getRingNodes().length < 4) return [];
    return this.findStubsFor(poly.getRingNodes());
  }

  // Equivalent to tmwxDoc::DoPickStub()'s "apply the chosen stub" half /
  // tmStubFinder::AddStubToTree().
  addStub(stubInfo) {
    if (!stubInfo || stubInfo.isBlank()) return null;
    const result = new StubFinder(this.tree).addStubToTree(stubInfo);
    if (result?.node) this.selectNode(result.node);
    return result;
  }

  // Equivalent to tmwxDoc::OnAddLargestStubNodes(): finds and immediately
  // adds the single largest stub for the selected nodes. Returns null if
  // none exists (needs < 4 selected nodes, or no valid stub found).
  addLargestStubForSelectedNodes() {
    if (this.selectedNodes.length < 4) return null;
    const stub = new StubFinder(this.tree).findLargestStub(this.selectedNodes);
    if (stub.isBlank()) return null;
    return this.addStub(stub);
  }

  // Equivalent to tmwxDoc::OnAddLargestStubPoly().
  addLargestStubForSelectedPoly() {
    const poly = this.selectedPoly;
    if (!poly || poly.getRingNodes().length < 4) return null;
    const stub = new StubFinder(this.tree).findLargestStub(poly.getRingNodes());
    if (stub.isBlank()) return null;
    return this.addStub(stub);
  }

  /**
   * Alternar nodo hoja/rama
   */
  toggleLeafNode() {
    if (!this.selectedNode) {
      console.warn('No hay nodo seleccionado');
      return;
    }

    this.selectedNode.isLeafNode = !this.selectedNode.isLeafNode;
    console.log(`${this.selectedNode.label} es ahora ${this.selectedNode.isLeafNode ? 'hoja' : 'rama'}`);
  }

  /**
   * Obtener información del nodo seleccionado
   */
  getSelectedNodeInfo() {
    if (!this.selectedNode) {
      return null;
    }

    return {
      id: this.selectedNode.id,
      label: this.selectedNode.label,
      x: this.selectedNode.getLocX(),
      y: this.selectedNode.getLocY(),
      depth: this.selectedNode.getDepth(),
      elevation: this.selectedNode.getElevation(),
      isRoot: this.selectedNode.isRootNode,
      isLeaf: this.selectedNode.isLeafNode,
      degree: this.selectedNode.getDegree(),
      isPinned: Boolean(this.selectedNode.isPinnedNode)
    };
  }

  /**
   * Obtener información de la arista seleccionada
   */
  getSelectedEdgeInfo() {
    if (!this.selectedEdge) {
      return null;
    }

    const n1 = this.selectedEdge.nodes[0];
    const n2 = this.selectedEdge.nodes[1];

    return {
      id: this.selectedEdge.id,
      index: this.tree.getEdges().indexOf(this.selectedEdge) + 1,
      label: this.selectedEdge.label,
      node1: n1 ? n1.label : 'N/A',
      node2: n2 ? n2.label : 'N/A',
      length: this.selectedEdge.getLength(),
      strain: this.selectedEdge.getStrain(),
      stiffness: this.selectedEdge.getStiffness()
    };
  }

  /**
   * Obtener información del vértice seleccionado
   */
  getSelectedVertexInfo() {
    const vertex = this.selectedVertex;
    if (!vertex) return null;

    return {
      id: vertex.id,
      ownerLabel: vertex.getDisplayLabel(),
      x: vertex.getLocX(),
      y: vertex.getLocY()
    };
  }

  /**
   * Obtener información del pliegue (crease) seleccionado. Equivalent to
   * tmwxCreasePanel::Fill(): Kind (structural role — AXIAL/GUSSET/RIDGE/
   * UNFOLDED_HINGE/FOLDED_HINGE/PSEUDOHINGE) and Fold (fold direction once
   * calcFoldDirections() has run — FLAT/MOUNTAIN/VALLEY/BORDER) are two
   * separate properties, not one (this port's own "kind" field used to
   * conflate them, actually always reporting Fold). `index` (1-based,
   * matching Select Part by Index's own tree.getCreases() list) isn't part
   * of the original's Fill() but is what its title's own "Crease %s" is.
   */
  getSelectedCreaseInfo() {
    const crease = this.selectedCrease;
    if (!crease) return null;

    const v1 = crease.getVertex(0);
    const v2 = crease.getVertex(1);

    return {
      id: crease.id,
      index: this.tree.getCreases().indexOf(crease) + 1,
      v1Label: v1?.getDisplayLabel() ?? 'N/A',
      v2Label: v2?.getDisplayLabel() ?? 'N/A',
      length: crease.getLength(),
      kind: crease.getKind(),
      fold: crease.getFold(),
      angleDeg: crease.getPositiveAngle()
    };
  }

  /**
   * Obtener información de la faceta seleccionada
   */
  getSelectedFacetInfo() {
    const facet = this.selectedFacet;
    if (!facet) return null;

    return {
      id: facet.id,
      index: this.tree.getFacets().indexOf(facet) + 1,
      vertexLabels: facet.getVertices().map(v => v.getDisplayLabel()),
      numVertices: facet.getNumVertices(),
      order: facet.getOrder(),
      color: facet.getColor(),
      area: facet.getArea(),
      centroid: facet.getCentroid(),
      creaseLabels: facet.getCreases().map(c => (
        `${c.getVertex(0)?.getDisplayLabel() ?? '?'}-${c.getVertex(1)?.getDisplayLabel() ?? '?'}`
      )),
      poly: facet.poly ?? null
    };
  }

  /**
   * Obtener información del polígono seleccionado. Equivalent to
   * tmwxPolyPanel::Fill(): Centroid, Ring Nodes and Ring Paths are the
   * standard panel's three fields — this port's own "Vertices"/"Shape"
   * fields didn't match anything there (Vertices listed the flat-pattern
   * tmVertex corners, a finer-grained thing than the tree nodes Ring Nodes
   * actually means; Shape was an invented triangle/quad check). `index`
   * (1-based, matching Select Part by Index's own tree.getAllPolys() list)
   * isn't part of Fill() but is what its title's own "Poly %s" is. Area
   * isn't part of the original panel either, but is a real, correctly
   * computed value (shoelace formula over the flat-pattern vertices) and
   * useful enough to keep, same call as Crease's own extra Length field.
   */
  getSelectedPolyInfo() {
    const poly = this.selectedPoly;
    if (!poly) return null;

    // A sub-poly's ring can include purely geometric inset/junction nodes
    // (tmPoly._getOrMakeInsetNode(), isSubNode=true) that never get a
    // `.label` — only real tree nodes do. Fall back to the node's own
    // vertex's display label (same buildIndex-based stand-in tmVertex.
    // getDisplayLabel() already gives facets/creases/paths for the same
    // situation) rather than showing an empty string.
    const nodeLabel = (node) => node.label || node.getVertex()?.getDisplayLabel() || node.id;

    return {
      id: poly.id,
      index: this.tree.getAllPolys().indexOf(poly) + 1,
      centroid: poly.getCentroid(),
      ringNodeLabels: poly.getRingNodes().map(nodeLabel),
      ringPathLabels: poly.getRingPaths().map(p => `${nodeLabel(p.getFirstNode())}-${nodeLabel(p.getLastNode())}`),
      area: poly.getArea()
    };
  }

  /**
   * Information for the currently selected path — either a direct
   * selection (canvas click, selectPathFromNodes(), selectPartByIndex()),
   * or, when a single node is selected instead, the path from that node
   * to `endNode` (main.js's "To:" dropdown, for building a path condition
   * out of any two nodes, not just an already-visible/clickable one).
   */
  getSelectedPathInfo(endNode) {
    const path = this.selectedPath
      ?? (this.selectedNode && endNode && endNode !== this.selectedNode
        ? this.tree.getPath(this.selectedNode, endNode)
        : null);
    if (!path) return null;

    return {
      path,
      label: path.getLabel(),
      numNodes: path.getNumNodes(),
      isActive: path.isPathActive(),
      isFeasible: path.isFeasiblePath(),
      isInfeasible: path.isInfeasiblePath(),
      isGeometricallyActive: path.isGeometricallyActive(),
      actualLength: path.getActualLength(),
      treeLength: path.getTreeLength(),
      lengthSlack: path.getLengthSlack(),
      minTreeLength: path.getMinTreeLength(),
      angleDeg: path.getAngle() * 180 / Math.PI,
      geometricAngleDeg: path.getGeometricAngle() * 180 / Math.PI,
      positiveGeometricAngleDeg: path.getPositiveGeometricAngle() * 180 / Math.PI
    };
  }
}
