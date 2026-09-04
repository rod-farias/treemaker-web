/**
 * FoldedFormRenderer.js
 * Equivalent to tmwxFoldedFormFrame (original/TreeMaker/Source/tmwxGUI/
 * tmwxFoldedForm/tmwxFoldedFormFrame.cpp): a small standalone view of the
 * flat-folded base's silhouette.
 *
 * The key insight (not obvious from the name "folded form"): this is NOT a
 * true 3D view. Every point in a flat-folded base collapses onto a single
 * plane, and the universal-molecule construction is specifically built so
 * that a vertex's (elevation, depth) pair — already fully computed by the
 * crease-pattern pipeline (tmTree.calcDepthAndBend()), no new geometry
 * needed — gives exactly its 2D position in that folded silhouette:
 * `elevation` (distance from the paper's own symmetry axis) becomes one
 * screen axis, and `depth` (distance from the root along the folded
 * structure) becomes the other. Facets are drawn in whatever order
 * tree.getFacets() returns them (matching the original, which does not
 * sort by facet order for painter's-algorithm layering either — a known,
 * inherited simplification, not something to "fix" here).
 *
 * Renders to an inline SVG string (same approach as rfDiagramView.js) rather
 * than a canvas: this view never needs frame-by-frame redraws — only a full
 * repaint on tree/selection changes — so there's nothing to gain from a
 * bitmap, and SVG stays crisp at any zoom/DPI instead of blurring like a
 * fixed-resolution canvas stretched by CSS.
 */

// Unlike the original's small standalone frame (grey backdrop, plain white
// facets), this view shares the main canvas's own paper background and its
// Design View polygon fill (colors.polygon / POLY_COLOR in Renderer.js) so
// the two views read as the same document instead of a different palette.
const BACKGROUND_COLOR = '#ffffff';
const FACET_COLOR = '#ffffcf';
const FACET_SELECTED_COLOR = '#ffbfff';
const VERTEX_COLOR = '#000000';
const CREASE_COLORS = {
  AXIAL: '#000000',
  GUSSET: '#7f7f7f',
  RIDGE: '#ff0000',
  UNFOLDED_HINGE: '#bfbfff',
  FOLDED_HINGE: '#0000ff',
  PSEUDOHINGE: '#007f7f'
};

const LEFT_BORDER = 20;
const TOP_BORDER = 20;
const RIGHT_BORDER = 20;
const BOTTOM_BORDER = 20;

const WIDTH = 900;
const HEIGHT = 700;

export class FoldedFormRenderer {
  constructor(container) {
    this.container = container;
    this.tree = null;
    // Shared with the main CanvasRenderer's `selectedObjects`, so a
    // selection made in either view highlights consistently in both —
    // matches the original's single mDoc->mSelection shared by every
    // window onto the same document.
    this.selectedObjects = [];
  }

  setTree(tree) {
    this.tree = tree;
  }

  setSelection(selectedObjects) {
    this.selectedObjects = selectedObjects || [];
  }

  // Equivalent to tmwxFoldedFormFrame::CanDraw().
  canDraw() {
    return !!this.tree && this.tree.isVertexDepthValid;
  }

  render() {
    this.container.innerHTML = this._buildSvg();
  }

  // Equivalent to tmwxFoldedFormFrame::IsFacetDrawnSelected().
  _isFacetSelected(facet) {
    if (this.selectedObjects.includes(facet)) return true;
    const edge = facet.getCorridorEdge();
    return !!edge && this.selectedObjects.includes(edge);
  }

  _emptyStateMessage() {
    if (!this.tree) return 'No Document';
    if (!this.tree.isPolygonValid) return 'Polygons Not Valid';
    if (!this.tree.isPolygonFilled) return 'Polygons Not Filled';
    return 'Vertex Depth Not Valid';
  }

  _buildSvg() {
    const svgOpen = `<svg viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">`;

    if (!this.canDraw()) {
      return `${svgOpen}
  <rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="${BACKGROUND_COLOR}" />
  <text x="${WIDTH / 2}" y="${HEIGHT / 2}" fill="#7f7f7f" font-size="14" font-family="sans-serif" text-anchor="middle" dominant-baseline="middle">${this._emptyStateMessage()}</text>
</svg>`;
    }

    const tree = this.tree;

    // Get the bounding box of the base. Zero is always included (matches
    // the original), keeping the paper's own symmetry axis visible even
    // when every vertex happens to land on one side of it.
    let xmin = 0, xmax = 0, ymin = 0, ymax = 0;
    for (const vertex of tree.getVertices()) {
      const elevation = vertex.getElevation();
      const depth = vertex.getDepth();
      if (elevation < xmin) xmin = elevation;
      if (elevation > xmax) xmax = elevation;
      if (depth < ymin) ymin = depth;
      if (depth > ymax) ymax = depth;
    }

    const availableW = WIDTH - LEFT_BORDER - RIGHT_BORDER;
    const availableH = HEIGHT - TOP_BORDER - BOTTOM_BORDER;
    const xSpan = xmax - xmin;
    const ySpan = ymax - ymin;
    const xmag = xSpan > 1e-12 ? availableW / xSpan : 1;
    const ymag = ySpan > 1e-12 ? availableH / ySpan : 1;
    this.mag = Math.min(xmag, ymag);
    // Center the silhouette in the available space on both axes — matching
    // scale (xmag vs ymag) leaves one axis with unused room, and unlike the
    // original's own small frame, this view sits in a much bigger workspace
    // where a plain top-left border would look off-center against the
    // paper's own centered position in the other views.
    this.xoff = LEFT_BORDER + (availableW - this.mag * xSpan) / 2 - this.mag * xmin;
    this.yoff = TOP_BORDER + (availableH - this.mag * ySpan) / 2 - this.mag * ymin;

    const parts = [`<rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="${BACKGROUND_COLOR}" />`];

    // Facets: unselected first, then selected on top (matches original).
    const facets = tree.getFacets();
    for (const facet of facets) {
      if (this._isFacetSelected(facet)) continue;
      parts.push(this._facetMarkup(facet, false));
    }
    for (const facet of facets) {
      if (!this._isFacetSelected(facet)) continue;
      parts.push(this._facetMarkup(facet, true));
    }

    // Creases: unfolded hinges first, then every other kind on top.
    const creases = tree.getCreases();
    for (const crease of creases) {
      if (crease.getKind() !== 'UNFOLDED_HINGE') continue;
      parts.push(this._creaseMarkup(crease));
    }
    for (const crease of creases) {
      if (crease.getKind() === 'UNFOLDED_HINGE') continue;
      parts.push(this._creaseMarkup(crease));
    }

    for (const vertex of tree.getVertices()) parts.push(this._vertexMarkup(vertex));

    return `${svgOpen}\n  ${parts.filter(Boolean).join('\n  ')}\n</svg>`;
  }

  // Equivalent to tmwxFoldedFormFrame::TreeToFrame().
  _project(vertex) {
    return {
      x: this.xoff + this.mag * vertex.getElevation(),
      y: this.yoff + this.mag * vertex.getDepth()
    };
  }

  _facetMarkup(facet, selected) {
    const vertices = facet.getVertices();
    if (vertices.length < 2) return '';
    const points = vertices.map(v => {
      const p = this._project(v);
      return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    }).join(' ');
    const fill = selected ? FACET_SELECTED_COLOR : FACET_COLOR;
    return `<polygon points="${points}" fill="${fill}" />`;
  }

  _creaseMarkup(crease) {
    const [v1, v2] = crease.getVertices();
    if (!v1 || !v2) return '';
    const p1 = this._project(v1);
    const p2 = this._project(v2);
    const stroke = CREASE_COLORS[crease.getKind()] || '#000000';
    const strokeWidth = this.selectedObjects.includes(crease) ? 3 : 1;
    return `<line x1="${p1.x.toFixed(1)}" y1="${p1.y.toFixed(1)}" x2="${p2.x.toFixed(1)}" y2="${p2.y.toFixed(1)}" stroke="${stroke}" stroke-width="${strokeWidth}" />`;
  }

  _vertexMarkup(vertex) {
    const p = this._project(vertex);
    const selected = this.selectedObjects.includes(vertex);
    const radius = selected ? 3 : 1.5;
    return `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${radius}" fill="${VERTEX_COLOR}" />`;
  }
}
