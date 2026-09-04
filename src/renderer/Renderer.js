/**
 * Renderer.js
 * Base class for rendering TreeMaker models
 */

// Screen resolution assumed by View->Set Paper Size in the original TreeMaker
// (tmwxDesignCanvas.cpp, PIXELS_PER_INCH): it reports/sets zoom as an
// on-screen paper size in inches at a fixed 72 dpi, rather than as a raw
// pixels-per-unit factor.
const PIXELS_PER_INCH = 72;

// getObjectAtPoint()'s own click-radius cap for nodes/vertices — see its
// comment for why points need a narrower radius than lines.
const POINT_TOLERANCE_PX = 8;

// getObjectAtPoint()'s click-radius cap for edges/paths specifically — see
// its comment for why they need a narrower radius than creases, the other
// "line" category. Both still fall back to the full requested tolerance
// when it's already smaller than this (e.g. a caller explicitly asking
// for a tighter click).
const PRIORITY_LINE_TOLERANCE_PX = 10;

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.width = canvas.width;
    this.height = canvas.height;
    this.tree = null;
    
    // Rendering options
    this.showNodes = true;
    // The Robert Lang tree-theory reference circles around leaf nodes.
    // Equivalent to tmwxViewSettings::mShowNodeCircles: true only in the
    // original's Design View (and the internal "show everything" preset),
    // false in Tree/Creases/Plan — see tmwxViewSettings.cpp.
    this.showNodeCircles = true;
    // Fill color for the leaf reference circles, null meaning "outline
    // only" (Design View's own look). Blueprint View sets a soft pastel
    // fill so the circles read as a distinct visual layer from the crease
    // skeleton drawn on top of them.
    this.nodeCircleFillColor = null;
    // Fill color for Robert Lang's tree-theory "river" strips (see
    // CanvasRenderer._drawRivers()), null meaning "don't draw them" — off
    // everywhere except Blueprint View.
    this.riverFillColor = null;
    // Distinct-colored highlight, Blueprint View only: every internal
    // facet-corridor cut into pieces wherever a loose triangle overlaps it
    // — see tmTree.getCorridorSegments() and CanvasRenderer.
    // _drawCorridorSegments().
    this.showCorridorSegments = false;
    this.showEdges = true;
    this.showPaths = false;
    // Equivalent to mShowPolyFills: fills every tmPoly (at every
    // inset-recursion depth) with POLY_COLOR — true only in Design View.
    this.showPolys = false;
    this.showFacets = false;
    this.showCreases = false;
    // Equivalent to tmwxViewSettings::mShowCreaseFolds: true draws MVF
    // (Mountain/Valley/Flat) coloring, which conveys fold direction — used
    // in Creases/Plan View. False draws AGRH (Axial/Gusset/Ridge/Hinge)
    // coloring, which conveys each crease's structural role instead — used
    // in Design View (help/menus.htm, Action->Build Crease Pattern).
    this.showCreaseFolds = true;
    // Equivalent to tmwxViewSettings::mShowMinorCreases (help/windows.htm:
    // "Minor Creases ... are hinge and pseudohinge creases", as opposed to
    // "Major Creases ... axial, gusset, and ridge"). True everywhere except
    // Blueprint View, which shows only the structural skeleton.
    this.showMinorCreases = true;
    // Blueprint View's own addition, with no original equivalent: draws
    // every visible crease in black/gray regardless of AGRH role, instead
    // of AGRH's red ridge-crease color — a technical-drawing look rather
    // than a structural-role legend.
    this.monochromeCreases = false;
    this.showVertices = false;
    // Equivalent to mShowVertexDots/mShowVertexCoords: Plan View is "the
    // same as Creases View but also shows the coordinates of the major
    // vertices" (help/menus.htm) instead of a dot — see
    // CanvasRenderer._drawVertices().
    this.showVertexDots = true;
    this.showVertexCoords = false;
    this.showConditions = false;
    this.showLabels = true;
    // Blueprint View's own addition: a node's label defaults to a plain
    // sequential number (tmTree._nextNodeLabel()) that works as its on-
    // screen ID, not a name someone actually gave it — Blueprint only wants
    // real, user-given names, so it skips any label that is just digits.
    this.showOnlyCustomLabels = false;
    // "Show all labels" checkbox (View section) — independent of the
    // current view preset and of showLabels/showVertices/showConditions:
    // an on-demand overlay that draws an ID next to every vertex, edge,
    // path, and condition (the same 1-based numbering Select Part by
    // Index uses — vertices show their getDisplayLabel() instead, since
    // that's already the app's own readable vertex identifier), on top of
    // whatever the active view already shows. Deliberately excludes polys
    // and facets, which the user only wants via Select Part by Index.
    this.showAllPartLabels = false;

    // Visual properties: ancho fino y fijo (no escala con el zoom), igual
    // que STD_WIDTH=1 en tmwxDesignCanvas.cpp del original.
    this.nodeRadius = 4;
    this.edgeWidth = 1;
    this.creaseWidth = 1;
    // Paleta tomada directamente de las constantes de color de
    // tmwxDesignCanvas.cpp (original/TreeMaker/Source/tmwxGUI/tmwxDocView/
    // tmwxDesignCanvas.cpp), convertidas de RGB a hex.
    this.colors = {
      node: '#3f3f3f',           // NODE_COLOR (63,63,63)
      nodeRoot: '#3f3f3f',
      nodeLeaf: '#3f3f3f',
      edge: '#7fbfff',           // EDGE_COLOR (127,191,255)
      edgePinned: '#7fffff',     // EDGE_PINNED_COLOR (127,255,255)
      pathInternal: '#ffbf7f',   // PATH_INTERNAL_COLOR (255,191,127) - non-leaf path
      pathValid: '#ffbf00',      // PATH_VALID_COLOR (255,191,0) - feasible, not yet taut
      pathActive: '#00ff00',     // PATH_ACTIVE_COLOR (0,255,0) - taut ("closes the triangle")
      pathInfeasible: '#ff0000', // PATH_INFEASIBLE_COLOR (255,0,0)
      polygon: '#ffffcf',        // POLY_COLOR (255,255,63) aclarado, como el "Fill" del original
      polygonBorder: '#7f00bf',  // FACET_LINE_COLOR (127,0,191)
      crease: '#bfbfbf',         // CREASE_FLAT_COLOR (191,191,191)
      creaseValley: '#ff1f7f',   // CREASE_VALLEY_COLOR (255,31,127)
      creaseMountain: '#000000', // CREASE_MOUNTAIN_COLOR (0,0,0)
      creaseBorder: '#000000',   // CREASE_BORDER_COLOR (0,0,0)
      // AGRH (Axial/Gusset/Ridge/Hinge) crease coloring: conveys each
      // crease's structural role instead of its fold direction. Used in
      // Design View; Creases/Plan View use the MVF colors above instead
      // (help/menus.htm, Action->Build Crease Pattern).
      creaseAxial: '#000000',         // CREASE_AXIAL_COLOR (0,0,0)
      creaseGusset: '#7f7f7f',        // CREASE_GUSSET_COLOR (127,127,127)
      creaseRidge: '#ff0000',         // CREASE_RIDGE_COLOR (255,0,0)
      creaseUnfoldedHinge: '#bfbfff', // CREASE_UNFOLDED_HINGE_COLOR (191,191,255)
      creaseFoldedHinge: '#0000ff',   // CREASE_FOLDED_HINGE_COLOR (0,0,255)
      creasePseudohinge: '#007f7f',   // CREASE_PSEUDOHINGE_COLOR (0,127,127)
      vertex: '#7f3f00',         // VERTEX_COLOR (127,63,0)
      condition: '#bf7fff',           // CONDITION_COLOR (191,127,255)
      conditionInfeasible: '#ff7f7f', // CONDITION_INFEASIBLE_COLOR (255,127,127)
      label: '#1f2937',
      // No original equivalent: outline for the Robert Lang tree-theory
      // reference circles and river strips (leaf circles in every view
      // that shows them; river strips in Blueprint View only) — the same
      // color/weight on both so they read as one visual layer.
      referenceLine: 'rgba(63, 63, 63, 0.45)'
    };
    
    // Viewport/camera
    this.zoom = 1.0;
    this.panX = 0;
    this.panY = 0;
    
    // Interaction
    this.hoveredObject = null;
    this.selectedObjects = [];
  }

  /**
   * Set the tree model to render
   */
  setTree(tree) {
    this.tree = tree;
  }

  /**
   * Tamaño de página a usar para encuadrar la vista (incluye cualquier nodo
   * que sobresalga del papel) y los márgenes/área disponible del canvas,
   * compartido por fitViewport()/fitToWidth()/fitToHeight().
   */
  _fitMetrics() {
    if (!this.tree) return null;

    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;

    if (this.tree.getNumNodes() === 0) {
      minX = 0;
      minY = 0;
      maxX = this.tree.getPaperWidth();
      maxY = this.tree.getPaperHeight();
    } else {
      for (const node of this.tree.getNodes()) {
        minX = Math.min(minX, node.getLocX());
        minY = Math.min(minY, node.getLocY());
        maxX = Math.max(maxX, node.getLocX());
        maxY = Math.max(maxY, node.getLocY());
      }
    }

    if (minX === Infinity) return null;

    const paperWidth = Math.max(this.tree.getPaperWidth(), maxX, 1e-9);
    const paperHeight = Math.max(this.tree.getPaperHeight(), maxY, 1e-9);
    const horizontalMargin = Math.min(48, this.width * 0.08);
    const topMargin = Math.min(32, this.height * 0.06);
    const bottomMargin = Math.min(48, this.height * 0.08);
    const availableWidth = Math.max(this.width - horizontalMargin * 2, 1);
    const availableHeight = Math.max(this.height - topMargin - bottomMargin, 1);

    return { paperWidth, paperHeight, horizontalMargin, topMargin, availableWidth, availableHeight };
  }

  /**
   * Fit viewport to show entire tree
   */
  fitViewport() {
    const metrics = this._fitMetrics();
    if (!metrics) return;
    const { paperWidth, paperHeight, horizontalMargin, topMargin, availableWidth, availableHeight } = metrics;

    this.zoom = Math.min(availableWidth / paperWidth, availableHeight / paperHeight);
    this.panX = horizontalMargin;
    this.panY = topMargin;
  }

  /**
   * Ajusta el zoom para que el papel llene el ancho disponible del canvas,
   * sin importar si la altura resultante se sale de la vista (el usuario
   * puede desplazarse verticalmente con el botón central).
   */
  fitToWidth() {
    const metrics = this._fitMetrics();
    if (!metrics) return;
    const { paperWidth, horizontalMargin, topMargin, availableWidth } = metrics;

    this.zoom = availableWidth / paperWidth;
    this.panX = horizontalMargin;
    this.panY = topMargin;
  }

  /**
   * Igual que fitToWidth(), pero ajustando la altura disponible en vez del
   * ancho.
   */
  fitToHeight() {
    const metrics = this._fitMetrics();
    if (!metrics) return;
    const { paperHeight, horizontalMargin, topMargin, availableHeight } = metrics;

    this.zoom = availableHeight / paperHeight;
    this.panX = horizontalMargin;
    this.panY = topMargin;
  }

  /**
   * Cuánto del contenido (papel + márgenes, en píxeles) queda fuera del
   * canvas a cada lado, y cuánto se ha desplazado ya — para alimentar las
   * barras de desplazamiento personalizadas: al hacer zoom (rueda, "Fit to
   * Width/Height") el papel puede terminar siendo más grande que el
   * canvas, y sin esto no hay forma visible/descubrible de llegar a la
   * parte oculta (antes solo existía el paneo oculto con el botón central).
   */
  getScrollExtents() {
    const metrics = this._fitMetrics();
    if (!metrics) return null;
    const { paperWidth, paperHeight, horizontalMargin, topMargin } = metrics;

    const contentWidth = paperWidth * this.zoom + horizontalMargin * 2;
    const contentHeight = paperHeight * this.zoom + topMargin * 2;
    const maxScrollX = Math.max(0, contentWidth - this.width);
    const maxScrollY = Math.max(0, contentHeight - this.height);
    // El mundo (0,0) se dibuja en la pantalla (panX,panY) — ver worldToScreen()
    // — así que el borde del contenido (incluido el margen) empieza en
    // panX-horizontalMargin; lo que se ha "scrolleado" es cuánto de eso
    // quedó a la izquierda del canvas (x=0).
    const scrollX = Math.min(maxScrollX, Math.max(0, horizontalMargin - this.panX));
    const scrollY = Math.min(maxScrollY, Math.max(0, topMargin - this.panY));

    return {
      contentWidth,
      contentHeight,
      viewportWidth: this.width,
      viewportHeight: this.height,
      scrollX,
      scrollY,
      maxScrollX,
      maxScrollY
    };
  }

  /**
   * Mueve el paneo para que el contenido quede desplazado exactamente
   * `scrollX`/`scrollY` píxeles (recortado al rango válido) — usado por las
   * barras de desplazamiento al arrastrar el thumb o hacer clic en el riel.
   */
  scrollTo(scrollX, scrollY) {
    const metrics = this._fitMetrics();
    if (!metrics) return;
    const { paperWidth, paperHeight, horizontalMargin, topMargin } = metrics;

    const contentWidth = paperWidth * this.zoom + horizontalMargin * 2;
    const contentHeight = paperHeight * this.zoom + topMargin * 2;
    const maxScrollX = Math.max(0, contentWidth - this.width);
    const maxScrollY = Math.max(0, contentHeight - this.height);

    this.panX = horizontalMargin - Math.min(maxScrollX, Math.max(0, scrollX));
    this.panY = topMargin - Math.min(maxScrollY, Math.max(0, scrollY));
  }

  /**
   * On-screen paper size in inches, equivalent to View->Set Paper Size in
   * the original TreeMaker (assumes 72 dpi, same as the original).
   */
  getPaperSizeInches() {
    return this.zoom / PIXELS_PER_INCH;
  }

  setPaperSizeInches(inches) {
    this.zoom = inches * PIXELS_PER_INCH;
  }

  /**
   * Transform world coordinates to screen coordinates
   */
  worldToScreen(worldX, worldY) {
    return {
      x: worldX * this.zoom + this.panX,
      y: worldY * this.zoom + this.panY
    };
  }

  /**
   * Transform screen coordinates to world coordinates
   */
  screenToWorld(screenX, screenY) {
    return {
      x: (screenX - this.panX) / this.zoom,
      y: (screenY - this.panY) / this.zoom
    };
  }

  canvasPointFromEvent(event) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * this.width / rect.width,
      y: (event.clientY - rect.top) * this.height / rect.height
    };
  }

  /**
   * A path is only drawn — and, to match, only clickable — under the same
   * rule as tmwxDesignCanvas::IsVisible<tmPath>() with the Design View
   * flags (mShowBorderPaths/mShowPolygonPaths/mShowActivePaths/
   * mShowInfeasiblePaths, the only path-visibility flags Design sets):
   * border/polygon paths, active ("taut") paths, or (so a broken leaf-path
   * constraint stays visible) an infeasible leaf path. Unlike leaf-to-leaf
   * paths, a molecule-construction path (tree.getInternalPaths(), only
   * built after Action->Build Crease Pattern) can be border/polygon
   * without ever being a leaf path — mShowBranchPaths is off in Design, so
   * it's only border/polygon/active status that makes one visible, same as
   * any other path. Shared with CanvasRenderer._drawPaths() so the two
   * never drift apart.
   */
  isVisiblePath(path) {
    return path.isBorderPath || path.isPolygonPath || path.isActivePath() ||
      (path.isLeafPath && !path.isFeasiblePath());
  }

  /**
   * Find object at screen coordinates
   */
  getObjectAtPoint(screenX, screenY, tolerance = 10) {
    const world = this.screenToWorld(screenX, screenY);
    const x = world.x;
    const y = world.y;
    const tol = tolerance / this.zoom;
    // Nodes/vertices get their own, narrower "point" radius instead of the
    // full line tolerance above: a built crease pattern routinely packs
    // several vertices within 20-40 screen px of each other (short creases
    // between nearby junction points), and since a POINT hit always beats
    // a LINE hit in the priority order below, giving points the same
    // generous ~15px radius as lines let a vertex's hit circle blanket its
    // own (very short) incident crease end to end — the crease was never
    // reachable by click no matter where along it you clicked, because
    // every point on it was still "close enough" to one of its own
    // endpoints. Capping the point radius well below the visual gap
    // between such neighbors (their dots are only 2-4px themselves) leaves
    // a real clickable band in the middle of even a 20px-long crease,
    // while still comfortably covering an isolated vertex/node.
    const pointTol = Math.min(tol, POINT_TOLERANCE_PX / this.zoom);
    // Edges/paths get a narrower radius than creases, the other "line"
    // category below them in priority: a tree edge is a straight line
    // spanning a big chunk of the paper (node to node, before folding),
    // so it routinely runs close to — without actually coinciding with —
    // some unrelated crease elsewhere in a dense built pattern. Since an
    // edge/path hit always beats a crease hit regardless of which one the
    // click is actually closer to, giving them the same generous ~15px
    // radius as creases let a distant edge's line "steal" clicks meant
    // for a crease it merely runs near, over a wide stretch of that
    // crease's own length.
    const priorityLineTol = Math.min(tol, PRIORITY_LINE_TOLERANCE_PX / this.zoom);

    // Check nodes (only while visible: a vertex normally sits at the exact
    // same location as its owner node, so hiding nodes — e.g. the "Plano"
    // view preset — must let that click resolve to the vertex instead).
    // Keeps the CLOSEST node within tolerance, not just the first one found
    // in tree.getNodes() order — with several candidates in range (a dense
    // crease pattern easily has two within a few tolerance-radii of each
    // other), returning on the first hit picked whichever happened to sort
    // earliest in the array, regardless of which one the user's click was
    // actually nearest to. Same reasoning applies to every category below.
    if (this.showNodes) {
      let bestNode = null;
      let bestNodeDistSq = pointTol * pointTol;
      for (const node of this.tree.getNodes()) {
        const dx = node.getLocX() - x;
        const dy = node.getLocY() - y;
        const distSq = dx * dx + dy * dy;
        if (distSq < bestNodeDistSq) {
          bestNodeDistSq = distSq;
          bestNode = node;
        }
      }
      if (bestNode) return { type: 'node', object: bestNode };
    }

    // Check vertices after nodes so leaf endpoints remain editable. NOT
    // gated by showVertices, deliberately: unlike a node-owned vertex
    // (masked by the node check above anyway, since they share a location
    // and nodes are checked first), a poly-interior junction vertex has no
    // coincident node and is the Vertex inspector panel's main reason to
    // exist in Design/Tree/Creases View to begin with (see
    // REFERENCEFINDER_PLAN.md's Fase 5 addendum) — gating this the same way
    // as edges/paths below would make those unclickable exactly where
    // they're most useful.
    {
      let bestVertex = null;
      let bestVertexDistSq = pointTol * pointTol;
      for (const vertex of this.tree.getVertices()) {
        const dx = vertex.getLocX() - x;
        const dy = vertex.getLocY() - y;
        const distSq = dx * dx + dy * dy;
        if (distSq < bestVertexDistSq) {
          bestVertexDistSq = distSq;
          bestVertex = vertex;
        }
      }
      if (bestVertex) return { type: 'vertex', object: bestVertex };
    }

    // Check edges (only while shown — see the vertex check above for why
    // this matters: a border crease and its underlying tree edge can share,
    // or nearly share, the same on-screen line, so an ungated check here
    // let an invisible edge silently steal clicks meant for a crease in any
    // view that hides edges, e.g. Creases View).
    if (this.showEdges) {
      let bestEdge = null;
      let bestEdgeDist = priorityLineTol;
      for (const edge of this.tree.getEdges()) {
        const n1 = edge.getNode(0);
        const n2 = edge.getNode(1);
        if (!n1 || !n2) continue;

        const x1 = n1.getLocX(), y1 = n1.getLocY();
        const x2 = n2.getLocX(), y2 = n2.getLocY();

        // Distance to line segment
        const dist = this._distanceToLineSegment(x, y, x1, y1, x2, y2);
        if (dist < bestEdgeDist) {
          bestEdgeDist = dist;
          bestEdge = edge;
        }
      }
      if (bestEdge) return { type: 'edge', object: bestEdge };
    }

    // Check paths (only while shown, and only the ones actually drawn —
    // see isVisiblePath()), between edges and creases to match the
    // original's own hit-test priority (tmEdge, then tmPath, then tmCrease
    // — see tmwxDesignCanvas::OnMouse()).
    if (this.showPaths) {
      let bestPath = null;
      let bestPathDist = priorityLineTol;
      for (const path of this.tree.getPaths()) {
        if (!this.isVisiblePath(path)) continue;
        const nodeA = path.getFirstNode();
        const nodeB = path.getLastNode();
        if (!nodeA || !nodeB) continue;

        const dist = this._distanceToLineSegment(
          x, y, nodeA.getLocX(), nodeA.getLocY(), nodeB.getLocX(), nodeB.getLocY()
        );
        if (dist < bestPathDist) {
          bestPathDist = dist;
          bestPath = path;
        }
      }
      if (bestPath) return { type: 'path', object: bestPath };
    }

    // Check creases (segment test, same approach as edges) — a busy crease
    // pattern often has several crease segments crossing within tolerance
    // of each other, so this keeps the closest one instead of whichever
    // happens to come first in tree.getCreases().
    {
      let bestCrease = null;
      let bestCreaseDist = tol;
      for (const crease of this.tree.getCreases()) {
        const v1 = crease.getVertex(0);
        const v2 = crease.getVertex(1);
        if (!v1 || !v2) continue;

        const dist = this._distanceToLineSegment(x, y, v1.getLocX(), v1.getLocY(), v2.getLocX(), v2.getLocY());
        if (dist < bestCreaseDist) {
          bestCreaseDist = dist;
          bestCrease = crease;
        }
      }
      if (bestCrease) return { type: 'crease', object: bestCrease };
    }

    // Check polys (point-in-polygon), at every inset-recursion depth (not
    // just top-level — tree.getAllPolys() also walks subPolys), keeping the
    // smallest-area match: a click can land inside several nested rings at
    // once (a subPoly sits entirely within its parent's ring), and the
    // smallest one is always the most specific — the individual polygon the
    // user actually clicked, not the outermost one that happens to contain
    // it too. Deliberately checked BEFORE facets — the reverse of
    // tmwxDesignCanvas::OnMouse()'s tmFacet/tmPoly order — because a poly's
    // facets, once built, fully tile its interior (that's what Build Crease
    // Pattern does), so a facet-first check would always win and a poly
    // could never be reached by clicking: this SPA doesn't support clicking
    // to select a facet at all (see the mousedown handler in main.js), so
    // nothing would be lost by checking facets second, and clicking
    // anywhere inside a built polygon reliably selects it instead.
    let bestPoly = null;
    let bestArea = Infinity;
    for (const poly of this.tree.getAllPolys()) {
      if (!this._pointInPolygon(x, y, poly.getVertices())) continue;
      const area = poly.getArea();
      if (area < bestArea) {
        bestArea = area;
        bestPoly = poly;
      }
    }
    if (bestPoly) {
      return { type: 'poly', object: bestPoly };
    }

    // Check facets (point-in-polygon)
    for (const facet of this.tree.getFacets()) {
      if (this._pointInPolygon(x, y, facet.getVertices())) {
        return { type: 'facet', object: facet };
      }
    }

    return null;
  }

  /**
   * Point-in-polygon test (ray casting) against an ordered ring of tmVertex
   * @private
   */
  _pointInPolygon(px, py, vertices) {
    if (vertices.length < 3) return false;

    let inside = false;
    for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
      const xi = vertices[i].getLocX(), yi = vertices[i].getLocY();
      const xj = vertices[j].getLocX(), yj = vertices[j].getLocY();

      const intersect = ((yi > py) !== (yj > py)) &&
        (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }

    return inside;
  }

  /**
   * Calculate distance from point to line segment
   * @private
   */
  _distanceToLineSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    let t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));

    const closestX = x1 + t * dx;
    const closestY = y1 + t * dy;

    const distX = px - closestX;
    const distY = py - closestY;

    return Math.sqrt(distX * distX + distY * distY);
  }

  /**
   * Abstract render method - must be implemented by subclass
   */
  render() {
    throw new Error('Renderer.render() must be implemented by subclass');
  }
}
