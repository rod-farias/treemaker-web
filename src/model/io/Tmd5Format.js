/**
 * Tmd5Format.js
 *
 * Reader/writer for TreeMaker's native ".tmd5" file format (the plain-text,
 * newline-delimited, tagged/indexed stream format written by tmTree::PutSelf
 * / read by tmTree::GetSelf in the original C++ source, see
 * original/TreeMaker/Source/tmModel/tmTreeClasses/tmTree_IO.cpp and the
 * corresponding Putv5Self/Getv5Self methods on tmNode/tmEdge/tmPath and the
 * PutRestv4/GetRestv4 methods on each tmCondition subclass).
 *
 * Every field is written on its own line (numbers, "true"/"false", 4-char
 * tags, escaped labels); pointers are 1-based indices into the per-type
 * array (0 = null); arrays are a size line followed by that many index
 * lines. Floats are written fixed-point with 10 decimals, matching the
 * original's `os.precision(10)` for version 5 files.
 *
 * Scope: reads/writes the tree topology (paper/scale/symmetry, nodes,
 * edges, paths, conditions) AND, whenever buildPolysAndCreasePattern() has
 * produced one, the derived crease-pattern data itself (polys/vertices/
 * creases/facets — see collectCPGraph() and writePoly()/writeVertex()/
 * writeCrease()/writeFacet() below) in the exact same native shape the real
 * TreeMaker app writes, so a tree built in this app opens already built
 * there too (verified against the real C++ reader — see tools/tmd5parity/).
 * This app's own tree still treats that data as rebuildable, not source-
 * of-truth (a *loaded* file's own poly/vertex/crease/facet records are
 * skipped, not reconstructed into the model — see tmd5ToTree() below): the
 * trailing `bldA` extension (see writeBuildState()/readBuildState())
 * records whether Build Crease Pattern had succeeded when the tree was
 * saved, and if so, or if the loaded file's own numPolys > 0 (a real
 * TreeMaker file, which has no `bldA`), tmd5ToTree() re-runs
 * buildPolysAndCreasePattern() right after loading, deterministically
 * reconstructing the identical crease pattern from the topology alone —
 * simpler and less error-prone than round-tripping the crease pattern's own
 * pointer graph on read. Writing targets version 5.0 only (the current
 * native format); reading accepts both 4.0 and 5.0 files (4.0 is what
 * TreeMaker's own bundled sample files are, and the format is a strict
 * subset of 5.0's).
 */

import { tmPoint, flipAngleDegrees } from '../tmPoint.js';
import { tmNode } from '../tmNode.js';
import { tmEdge } from '../tmEdge.js';
import { tmTree } from '../tmTree.js';
import { CreaseKind, CreaseFold } from '../tmCrease.js';
import { FacetColor } from '../tmFacet.js';
import { ConditionNodeFixed } from '../conditions/ConditionNodeFixed.js';
import { ConditionEdgeLengthFixed } from '../conditions/ConditionEdgeLengthFixed.js';
import { ConditionNodesPaired } from '../conditions/ConditionNodesPaired.js';
import { ConditionNodesCollinear } from '../conditions/ConditionNodesCollinear.js';
import { ConditionNodeSymmetric } from '../conditions/ConditionNodeSymmetric.js';
import { ConditionEdgesSameStrain } from '../conditions/ConditionEdgesSameStrain.js';
import { ConditionNodeOnCorner } from '../conditions/ConditionNodeOnCorner.js';
import { ConditionNodeOnEdge } from '../conditions/ConditionNodeOnEdge.js';
import { ConditionNodeCombo } from '../conditions/ConditionNodeCombo.js';
import { ConditionPathActive } from '../conditions/ConditionPathActive.js';
import { ConditionPathAngleFixed } from '../conditions/ConditionPathAngleFixed.js';
import { ConditionPathAngleQuant } from '../conditions/ConditionPathAngleQuant.js';
import { writeSavedSearches, readSavedSearches } from './SavedSearches.js';

class Tmd5Writer {
  constructor() {
    this.lines = [];
  }

  raw(s) {
    this.lines.push(String(s));
  }

  sizeT(n) {
    this.lines.push(String(Math.max(0, Math.round(Number(n) || 0))));
  }

  bool(b) {
    this.lines.push(b ? 'true' : 'false');
  }

  float(f) {
    const n = Number(f);
    this.lines.push((Number.isFinite(n) ? n : 0).toFixed(10));
  }

  point(p) {
    this.float(p.x);
    this.float(p.y);
  }

  // Escaped C-string field (node/edge labels): '\\','\n','\r' are escaped,
  // matching tmPart::PutPOD(ostream&, const char*).
  label(s) {
    const str = s == null ? '' : String(s);
    let out = '';
    for (const ch of str) {
      if (ch === '\\') out += '\\\\';
      else if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else out += ch;
    }
    this.lines.push(out);
  }

  ptr(index) {
    this.sizeT(index || 0);
  }

  ptrArray(items, indexOf) {
    this.sizeT(items.length);
    for (const item of items) this.ptr(indexOf(item));
  }

  // A tmArray<tmPoint> (e.g. tmPoly::mNodeLocs): a size line followed by
  // that many literal points (not indices).
  pointArray(points) {
    this.sizeT(points.length);
    for (const p of points) this.point(p);
  }

  toString() {
    return `${this.lines.join('\n')}\n`;
  }
}

export class Tmd5Reader {
  constructor(text) {
    this.lines = text.split(/\r\n|\r|\n/);
    this.pos = 0;
  }

  _next() {
    if (this.pos >= this.lines.length) {
      throw new Error('Fin de archivo inesperado: el archivo .tmd5 parece estar truncado o corrupto');
    }
    return this.lines[this.pos++];
  }

  raw() {
    return this._next();
  }

  tag() {
    const s = this._next().trim();
    if (s.length !== 4) {
      throw new Error(`Etiqueta de objeto inválida en el archivo .tmd5: "${s}"`);
    }
    return s;
  }

  sizeT() {
    const s = this._next().trim();
    const n = parseInt(s, 10);
    if (!Number.isFinite(n)) {
      throw new Error(`Se esperaba un entero en el archivo .tmd5, se encontró "${s}"`);
    }
    return n;
  }

  bool() {
    return this._next().trim() === 'true';
  }

  float() {
    const s = this._next().trim();
    // Old TreeMaker files can contain "NAN(017)"-style placeholders for
    // irrelevant values; treat anything non-numeric-looking as 0, matching
    // the original's lenient behavior for this case.
    if (!/^[-+]?[0-9.]/.test(s)) return 0;
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : 0;
  }

  point() {
    return new tmPoint(this.float(), this.float());
  }

  label() {
    const raw = this._next();
    let out = '';
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === '\\' && i + 1 < raw.length) {
        const next = raw[i + 1];
        if (next === 'n') { out += '\n'; i++; continue; }
        if (next === 'r') { out += '\r'; i++; continue; }
        if (next === '\\') { out += '\\'; i++; continue; }
      }
      out += raw[i];
    }
    return out;
  }

  ptr() {
    return this.sizeT();
  }

  ptrArray() {
    const n = this.sizeT();
    const indices = [];
    for (let i = 0; i < n; i++) indices.push(this.ptr());
    return indices;
  }

  // Reads a tmNodeOwner*/tmPathOwner* record as written by the original's
  // tmTree::PutOwnerPtr: an "isPoly" flag, followed by a poly ptr ONLY when
  // that flag is true (0 = tree-owned, written as the flag alone). Poly
  // ownership isn't modeled here (nodes/paths always come back tree-owned,
  // same as this app's own writer always produces), so the value is just
  // consumed to keep the cursor correctly positioned for what follows — a
  // file whose Build Crease Pattern was run (which makes some nodes/paths
  // poly-owned) would otherwise desync the rest of the parse.
  skipOwnerPtr() {
    const isPoly = this.sizeT();
    if (isPoly) this.ptr();
  }

  // Skip a condition record we don't know how to parse (numLines POD lines),
  // mirroring tmTree::Makev5Condition's EX_IO_UNRECOGNIZED_TAG fallback.
  skipLines(n) {
    for (let i = 0; i < n; i++) this._next();
  }
}

// The original app's tree/paper coordinate frame has Y=0 at the BOTTOM of
// the paper, increasing upward (see tmwxDesignCanvas.cpp's TreeToDC, which
// converts with `paperHeight - y`); this app's canvas frame has Y=0 at the
// TOP, increasing downward, like plain screen/canvas coordinates. The two
// are mirror images of each other, so every point crossing the file
// boundary needs this conversion, or a loaded/saved tree renders upside
// down. flipAngleDegrees() (imported from tmPoint.js, shared with the
// equivalent UI boundary in main.js) is the same conversion for an angle.
export function flipY(point, paperHeight) {
  return new tmPoint(point.x, paperHeight - point.y);
}

function flipAngleRadians(angle) {
  return -angle;
}

function isLeafPath(path) {
  const nodes = path.getNodes();
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  return Boolean(first) && Boolean(last) && first.getDegree() === 1 && last.getDegree() === 1;
}

function nearestCorner(node, tree) {
  const w = tree.getPaperWidth();
  const h = tree.getPaperHeight();
  const loc = node.getLoc();
  const corners = [
    { key: 'TL', x: 0, y: 0 },
    { key: 'TR', x: w, y: 0 },
    { key: 'BL', x: 0, y: h },
    { key: 'BR', x: w, y: h }
  ];
  return corners.reduce((best, c) => {
    const d = (c.x - loc.x) ** 2 + (c.y - loc.y) ** 2;
    return d < best.d ? { key: c.key, d } : best;
  }, { key: 'TL', d: Infinity }).key;
}

function nearestEdge(node, tree) {
  const w = tree.getPaperWidth();
  const h = tree.getPaperHeight();
  const loc = node.getLoc();
  const candidates = [
    { key: 'TOP', dist: loc.y, position: w > 0 ? loc.x / w : 0 },
    { key: 'BOTTOM', dist: h - loc.y, position: w > 0 ? loc.x / w : 0 },
    { key: 'LEFT', dist: loc.x, position: h > 0 ? loc.y / h : 0 },
    { key: 'RIGHT', dist: w - loc.x, position: h > 0 ? loc.y / h : 0 }
  ];
  const best = candidates.reduce((a, b) => (b.dist < a.dist ? b : a));
  return { edge: best.key, position: Math.min(1, Math.max(0, best.position)) };
}

// ===== Condition <-> tmd5 record mapping =====
//
// Each entry describes one tmCondition subclass's PutRestv4/GetRestv4 wire
// format (see tmConditionXxx.cpp in the original source). `write` appends
// the subclass-specific fields (the shared tag/index/isFeasible/numLines
// prefix is handled by the caller); `read` consumes them and returns a new
// condition instance (not yet added to the tree).
//
// ConditionPathCombo ("CNxp") is a UI-only aggregate condition never
// actually created anywhere in this app (no button constructs one) — it's
// skipped on write and, if encountered on read, skipped via its declared
// numLines so the rest of the file still parses.
//
// ConditionNodeCombo ("CNxn") is what the real TreeMaker v5 UI actually
// writes for every "Fix to Position / Paper Edge / Paper Corner / Symmetry
// Line" command (SetNodesFixedTo*() in tmTree.cpp all call
// GetOrMakeOnePartCondition<tmConditionNodeCombo>()) — a single flat
// condition per node with 5 independent flags. The standalone
// ConditionNodeFixed/OnEdge/OnCorner/Symmetric classes below (CNfn/CNkn/
// CNen/CNsn) are only ever produced by the TMDEBUG-only "v4" legacy menu
// items, so they're kept here purely to read old files that carry those
// tags — this app's UI only ever constructs ConditionNodeCombo.
const CONDITION_IO = [
  {
    tag: 'CNfn',
    numLines: 5,
    matches: c => c instanceof ConditionNodeFixed,
    write(w, c, nodeIndex) {
      w.ptr(nodeIndex.get(c.getNode()));
      w.bool(c.getXFixed());
      w.bool(c.getYFixed());
      w.float(c.getXFixValue());
      w.float(c.getYFixValue());
    },
    read(r, ctx) {
      const node = ctx.nodeByIndex(r.ptr());
      const xFixed = r.bool();
      const yFixed = r.bool();
      const xFixValue = r.float();
      const yFixValue = r.float();
      return node ? new ConditionNodeFixed(ctx.tree, node, xFixed, xFixValue, yFixed, yFixValue) : null;
    }
  },
  {
    tag: 'CNkn',
    numLines: 1,
    matches: c => c instanceof ConditionNodeOnCorner,
    write(w, c, nodeIndex) {
      w.ptr(nodeIndex.get(c.getNode()));
    },
    read(r, ctx) {
      const node = ctx.nodeByIndex(r.ptr());
      return node ? new ConditionNodeOnCorner(ctx.tree, node, nearestCorner(node, ctx.tree)) : null;
    }
  },
  {
    tag: 'CNen',
    numLines: 1,
    matches: c => c instanceof ConditionNodeOnEdge,
    write(w, c, nodeIndex) {
      w.ptr(nodeIndex.get(c.getNode()));
    },
    read(r, ctx) {
      const node = ctx.nodeByIndex(r.ptr());
      if (!node) return null;
      const { edge, position } = nearestEdge(node, ctx.tree);
      return new ConditionNodeOnEdge(ctx.tree, node, edge, position);
    }
  },
  {
    tag: 'CNsn',
    numLines: 1,
    matches: c => c instanceof ConditionNodeSymmetric,
    write(w, c, nodeIndex) {
      w.ptr(nodeIndex.get(c.getNode1()));
    },
    read(r, ctx) {
      const node = ctx.nodeByIndex(r.ptr());
      return node ? new ConditionNodeSymmetric(ctx.tree, node) : null;
    }
  },
  {
    tag: 'CNxn',
    numLines: 8,
    matches: c => c instanceof ConditionNodeCombo,
    write(w, c, nodeIndex) {
      w.ptr(nodeIndex.get(c.getNode()));
      w.bool(c.getToSymmetryLine());
      w.bool(c.getToPaperEdge());
      w.bool(c.getToPaperCorner());
      w.bool(c.getXFixed());
      w.float(c.getXFixValue());
      w.bool(c.getYFixed());
      w.float(c.getYFixValue());
    },
    read(r, ctx) {
      const node = ctx.nodeByIndex(r.ptr());
      const toSymmetryLine = r.bool();
      const toPaperEdge = r.bool();
      const toPaperCorner = r.bool();
      const xFixed = r.bool();
      const xFixValue = r.float();
      const yFixed = r.bool();
      const yFixValue = r.float();
      if (!node) return null;
      return new ConditionNodeCombo(ctx.tree, node, toSymmetryLine, toPaperEdge,
        toPaperCorner, xFixed, xFixValue, yFixed, yFixValue);
    }
  },
  {
    tag: 'CNpn',
    numLines: 2,
    matches: c => c instanceof ConditionNodesPaired,
    write(w, c, nodeIndex) {
      w.ptr(nodeIndex.get(c.getNode1()));
      w.ptr(nodeIndex.get(c.getNode2()));
    },
    read(r, ctx) {
      const node1 = ctx.nodeByIndex(r.ptr());
      const node2 = ctx.nodeByIndex(r.ptr());
      return node1 && node2 ? new ConditionNodesPaired(ctx.tree, node1, node2) : null;
    }
  },
  {
    tag: 'CNcn',
    numLines: 3,
    matches: c => c instanceof ConditionNodesCollinear,
    write(w, c, nodeIndex) {
      w.ptr(nodeIndex.get(c.getNode1()));
      w.ptr(nodeIndex.get(c.getNode2()));
      w.ptr(nodeIndex.get(c.getNode3()));
    },
    read(r, ctx) {
      const node1 = ctx.nodeByIndex(r.ptr());
      const node2 = ctx.nodeByIndex(r.ptr());
      const node3 = ctx.nodeByIndex(r.ptr());
      return node1 && node2 && node3 ? new ConditionNodesCollinear(ctx.tree, node1, node2, node3) : null;
    }
  },
  {
    tag: 'CNfe',
    numLines: 1,
    matches: c => c instanceof ConditionEdgeLengthFixed,
    write(w, c, nodeIndex, edgeIndex) {
      w.ptr(edgeIndex.get(c.getEdge()));
    },
    read(r, ctx) {
      const edge = ctx.edgeByIndex(r.ptr());
      return edge ? new ConditionEdgeLengthFixed(ctx.tree, edge, edge.getLength()) : null;
    }
  },
  {
    tag: 'CNes',
    numLines: 2,
    matches: c => c instanceof ConditionEdgesSameStrain,
    write(w, c, nodeIndex, edgeIndex) {
      w.ptr(edgeIndex.get(c.getEdge1()));
      w.ptr(edgeIndex.get(c.getEdge2()));
    },
    read(r, ctx) {
      const edge1 = ctx.edgeByIndex(r.ptr());
      const edge2 = ctx.edgeByIndex(r.ptr());
      return edge1 && edge2 ? new ConditionEdgesSameStrain(ctx.tree, edge1, edge2) : null;
    }
  },
  {
    tag: 'CNap',
    numLines: 2,
    matches: c => c instanceof ConditionPathActive
      && !(c instanceof ConditionPathAngleFixed) && !(c instanceof ConditionPathAngleQuant),
    write(w, c, nodeIndex) {
      const nodes = c.getPath().getNodes();
      w.ptr(nodeIndex.get(nodes[0]));
      w.ptr(nodeIndex.get(nodes[nodes.length - 1]));
    },
    read(r, ctx) {
      const node1 = ctx.nodeByIndex(r.ptr());
      const node2 = ctx.nodeByIndex(r.ptr());
      const path = node1 && node2 ? ctx.tree.getPath(node1, node2) : null;
      return path ? new ConditionPathActive(ctx.tree, path) : null;
    }
  },
  {
    tag: 'CNfp',
    numLines: 3,
    matches: c => c instanceof ConditionPathAngleFixed,
    write(w, c, nodeIndex) {
      const nodes = c.getPath().getNodes();
      w.ptr(nodeIndex.get(nodes[0]));
      w.ptr(nodeIndex.get(nodes[nodes.length - 1]));
      w.float(flipAngleRadians(c.getAngle()));
    },
    read(r, ctx) {
      const node1 = ctx.nodeByIndex(r.ptr());
      const node2 = ctx.nodeByIndex(r.ptr());
      const angle = flipAngleRadians(r.float());
      const path = node1 && node2 ? ctx.tree.getPath(node1, node2) : null;
      return path ? new ConditionPathAngleFixed(ctx.tree, path, angle) : null;
    }
  },
  {
    tag: 'CNqp',
    numLines: 4,
    matches: c => c instanceof ConditionPathAngleQuant,
    write(w, c, nodeIndex) {
      const nodes = c.getPath().getNodes();
      w.ptr(nodeIndex.get(nodes[0]));
      w.ptr(nodeIndex.get(nodes[nodes.length - 1]));
      w.sizeT(c.getQuantValue());
      w.float(flipAngleRadians(c.getQuantOffset()));
    },
    read(r, ctx) {
      const node1 = ctx.nodeByIndex(r.ptr());
      const node2 = ctx.nodeByIndex(r.ptr());
      const quantValue = r.sizeT();
      const quantOffset = flipAngleRadians(r.float());
      const path = node1 && node2 ? ctx.tree.getPath(node1, node2) : null;
      return path ? new ConditionPathAngleQuant(ctx.tree, path, quantValue, quantOffset) : null;
    }
  }
];

function findConditionIO(condition) {
  return CONDITION_IO.find(io => io.matches(condition));
}

// ===== Crease-pattern graph collection (write side) =====
//
// tmNode/tmPath/tmPoly/tmVertex/tmCrease/tmFacet all self-register into
// flat arrays on the original's tmTree (mNodes/mPaths/mPolys/...) at
// construction time, regardless of who owns them — so a real TreeMaker
// file's node/path/poly records include BOTH tree-owned parts and every
// poly-owned one (the inset junction nodes and spoke/cross-path network
// tmPoly::BuildPolyContents() builds). This app's own tree, by contrast,
// only keeps tree-owned nodes/paths in tree.nodes/tree.paths and top-level
// polys in tree.polys — poly-owned nodes/paths live only on
// poly.ownedNodes/poly.ownedPaths/poly.spokePaths, and subPolys only on
// poly.subPolys. These helpers reconstruct the flat, all-owners view the
// native format needs, purely for serialization — nothing here is stored
// back onto the model.

// Visits `poly` and every subPoly reachable from it (depth-first) —
// equivalent to what the original's flat mPolys array gives for free.
function walkPolys(poly, visit) {
  visit(poly);
  for (const sub of poly.subPolys) walkPolys(sub, visit);
}

// Equivalent to tmPoly::CalcCrossPaths(): the paths connecting this poly's
// non-adjacent ring nodes (the ring paths plus these make up every path
// between the poly's own corners). This app's model doesn't keep a
// persistent mCrossPaths field, so it's recomputed at write time — safely:
// by the time a poly's crease pattern is built, buildPolyContents() has
// already looked up (and so created, if needed) every one of these via the
// exact same polyOwner.findAnyPath() chain used here.
function crossPathsOf(poly) {
  const result = [];
  const seen = new Set();
  const ringNodes = poly.ringNodes;
  const n = ringNodes.length;
  for (let i = 2; i < n; i++) {
    for (let j = 0; j < i - 1; j++) {
      if (i === n - 1 && j === 0) continue; // wrap-around: that's a ring path, not a cross path
      const path = poly.polyOwner.findAnyPath(ringNodes[i], ringNodes[j]);
      if (path && !seen.has(path)) {
        seen.add(path);
        result.push(path);
      }
    }
  }
  return result;
}

// Collects everything the native format needs beyond what the tree already
// tracks directly: every poly at every inset-recursion depth (flat, like
// the original's mPolys), and every poly-owned node/path together with
// which poly owns each (needed for their own "node"/"path" records' owner
// field — see tmTree::PutOwnerPtr).
function collectCPGraph(tree) {
  const polys = [];
  const polyNodes = [];
  const polyPaths = [];
  const nodeOwner = new Map();
  const pathOwner = new Map();
  for (const top of tree.polys) {
    walkPolys(top, poly => {
      polys.push(poly);
      for (const node of poly.ownedNodes) {
        polyNodes.push(node);
        nodeOwner.set(node, poly);
      }
      for (const path of [...poly.ownedPaths, ...poly.spokePaths]) {
        polyPaths.push(path);
        pathOwner.set(path, poly);
      }
    });
  }
  return { polys, polyNodes, polyPaths, nodeOwner, pathOwner };
}

const CREASE_KIND_CODE = {
  [CreaseKind.AXIAL]: 0,
  [CreaseKind.GUSSET]: 1,
  [CreaseKind.RIDGE]: 2,
  [CreaseKind.UNFOLDED_HINGE]: 3,
  [CreaseKind.FOLDED_HINGE]: 4,
  [CreaseKind.PSEUDOHINGE]: 5
};

const CREASE_FOLD_CODE = {
  [CreaseFold.FLAT]: 0,
  [CreaseFold.MOUNTAIN]: 1,
  [CreaseFold.VALLEY]: 2,
  [CreaseFold.BORDER]: 3
};

const FACET_COLOR_CODE = {
  [FacetColor.NOT_ORIENTED]: 0,
  [FacetColor.WHITE_UP]: 1,
  [FacetColor.COLOR_UP]: 2
};

// ===== Writer =====

function writeNode(w, node, index, nodeIndex, edgeIndex, pathIndex, leafPathsByNode, paperHeight, vertexIndex, polyIndex, nodeOwner) {
  w.raw('node');
  w.sizeT(index);
  w.label(node.label);
  w.point(flipY(node.getLoc(), paperHeight));
  w.float(node.depth || 0);
  w.float(node.elevation || 0);
  w.bool(Boolean(node.isLeafNode));
  w.bool(Boolean(node.isSubNode));
  w.bool(Boolean(node.isBorderNode));
  w.bool(Boolean(node.isPinnedNode));
  w.bool(Boolean(node.isPolygonNode));
  w.bool(Boolean(node.isJunctionNode));
  w.bool((node.conditions?.length || 0) > 0);
  w.ptrArray(node.getEdges(), e => edgeIndex.get(e));
  w.ptrArray(leafPathsByNode.get(node) || [], p => pathIndex.get(p));
  w.ptrArray(node.vertices || [], v => vertexIndex.get(v));
  const owningPoly = nodeOwner.get(node);
  if (owningPoly) {
    w.sizeT(1);
    w.ptr(polyIndex.get(owningPoly));
  } else {
    w.sizeT(0); // tree-owned
  }
}

function writeEdge(w, edge, index, nodeIndex) {
  w.raw('edge');
  w.sizeT(index);
  w.label(edge.label);
  w.float(edge.length);
  w.float(edge.strain);
  w.float(edge.stiffness);
  w.bool(Boolean(edge.isPinnedEdge));
  w.bool(Boolean(edge.isConditionedEdge));
  w.ptrArray(edge.getNodes(), n => nodeIndex.get(n));
  // No owner-ptr write here: tmTree::PutOwnerPtr(ostream&, tmEdgeOwner*
  // const) is a no-op in the original — edges can only ever be tree-owned.
}

function writePath(w, path, index, tree, nodeIndex, edgeIndex, vertexIndex, creaseIndex, polyIndex, pathOwner) {
  w.raw('path');
  w.sizeT(index);
  const nodes = path.getNodes();
  const leaf = isLeafPath(path);
  w.float(path.getMinTreeLength());
  w.float(path.getMinPaperLength());
  w.float(path.getTreeLength());
  w.float(path.getActualLength());
  w.bool(leaf);
  w.bool(false); // isSubPath
  w.bool(Boolean(path.isFeasiblePath ? path.isFeasiblePath() : path.isFeasible));
  // mIsActivePath is the original's *geometric* "is this path currently
  // taut" state (tmPath::IsActivePath()) — this app's `isActiveGeometry`,
  // not the same-ish-named `isActive` (a user-set Path Active *constraint*
  // flag, reconstructed separately from the CNap/CNfp/CNqp condition
  // records, not from this field).
  w.bool(Boolean(path.isActiveGeometry));
  w.bool(Boolean(path.isBorderPath));
  w.bool(Boolean(path.isPolygonPath));
  w.bool((path.conditions?.length || 0) > 0);
  w.ptr(0); // fwdPoly
  w.ptr(0); // bkdPoly
  w.ptrArray(nodes, n => nodeIndex.get(n));
  const edges = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    const e = tree.getEdge(nodes[i], nodes[i + 1]);
    if (e) edges.push(e);
  }
  w.ptrArray(edges, e => edgeIndex.get(e));
  w.ptr(0); // outsetPath
  w.float(path.frontReduction || 0);
  w.float(path.backReduction || 0);
  w.float(path.minDepth || 0);
  w.float(path.minDepthDist || 0);
  w.ptrArray(path.vertices || [], v => vertexIndex.get(v));
  w.ptrArray(path.creases || [], c => creaseIndex.get(c));
  const owningPoly = pathOwner.get(path);
  if (owningPoly) {
    w.sizeT(1);
    w.ptr(polyIndex.get(owningPoly));
  } else {
    w.sizeT(0); // tree-owned
  }
}

function writeVertex(w, vertex, index, vertexIndex, nodeIndex, pathIndex, creaseIndex, paperHeight) {
  w.raw('vrtx');
  w.sizeT(index);
  w.point(flipY(vertex.getLoc(), paperHeight));
  w.float(vertex.elevation || 0);
  w.bool(Boolean(vertex.isBorderVertexFlag));
  w.ptr(vertex.treeNode ? nodeIndex.get(vertex.treeNode) : 0);
  w.ptr(vertex.leftPseudohingeMate ? vertexIndex.get(vertex.leftPseudohingeMate) : 0);
  w.ptr(vertex.rightPseudohingeMate ? vertexIndex.get(vertex.rightPseudohingeMate) : 0);
  w.ptrArray(vertex.creases || [], c => creaseIndex.get(c));
  w.float(vertex.depth || 0);
  // mDiscreteDepth is a size_t; the original's "not applicable" sentinel is
  // size_t(-1), which can't survive this app's own float-based line format
  // without risking a misparse on the real reader's side, so an
  // inapplicable depth is written as 0 instead — a deliberate, documented
  // simplification (this field isn't consulted by GetCPStatus()/HasFullCP()).
  w.sizeT(vertex.discreteDepth != null ? vertex.discreteDepth : 0);
  w.sizeT(vertex.ccFlag || 0);
  w.sizeT(vertex.stFlag || 0);
  const isNode = vertex.owner instanceof tmNode;
  w.sizeT(isNode ? 1 : 0);
  if (isNode) {
    w.ptr(nodeIndex.get(vertex.owner));
  } else {
    w.ptr(vertex.owner ? pathIndex.get(vertex.owner) : 0);
  }
}

function writeCrease(w, crease, index, creaseIndex, vertexIndex, facetIndex, polyIndex, pathIndex) {
  w.raw('crse');
  w.sizeT(index);
  w.sizeT(CREASE_KIND_CODE[crease.kind] ?? 0);
  w.ptrArray(crease.vertices || [], v => (v ? vertexIndex.get(v) : 0));
  w.ptr(crease.fwdFacet ? facetIndex.get(crease.fwdFacet) : 0);
  w.ptr(crease.bkdFacet ? facetIndex.get(crease.bkdFacet) : 0);
  w.sizeT(crease.fold != null ? (CREASE_FOLD_CODE[crease.fold] ?? 0) : 0);
  w.sizeT(crease.ccFlag || 0);
  w.sizeT(crease.stFlag || 0);
  const isPoly = crease.ownerKind === 'poly';
  w.sizeT(isPoly ? 1 : 0);
  if (isPoly) {
    w.ptr(polyIndex.get(crease.owner));
  } else {
    w.ptr(crease.owner ? pathIndex.get(crease.owner) : 0);
  }
}

function writeFacet(w, facet, index, facetIndex, vertexIndex, creaseIndex, edgeIndex, polyIndex, paperHeight) {
  w.raw('fact');
  w.sizeT(index);
  w.point(flipY(facet.centroid, paperHeight));
  w.bool(Boolean(facet.isWellFormed));
  w.ptrArray(facet.vertices || [], v => vertexIndex.get(v));
  w.ptrArray(facet.creases || [], c => creaseIndex.get(c));
  w.ptr(facet.corridorEdge ? edgeIndex.get(facet.corridorEdge) : 0);
  w.ptrArray(facet.headFacets || [], f => facetIndex.get(f));
  w.ptrArray(facet.tailFacets || [], f => facetIndex.get(f));
  w.sizeT(facet.order != null ? facet.order : 0);
  w.sizeT(FACET_COLOR_CODE[facet.color] ?? 0);
  w.ptr(facet.poly ? polyIndex.get(facet.poly) : 0); // always exactly one poly ptr, no flag
}

function writePoly(w, poly, index, nodeIndex, pathIndex, vertexIndex, creaseIndex, polyIndex, facetIndex, paperHeight) {
  w.raw('poly');
  w.sizeT(index);
  w.point(flipY(poly.getCentroid(), paperHeight));
  w.bool(!poly.isTreePoly);
  w.ptrArray(poly.ringNodes || [], n => nodeIndex.get(n));
  w.ptrArray(poly.ringPaths || [], p => pathIndex.get(p));
  w.ptrArray(crossPathsOf(poly), p => pathIndex.get(p));
  w.ptrArray(poly.insetNodes || [], n => nodeIndex.get(n));
  w.ptrArray(poly.spokePaths || [], p => pathIndex.get(p));
  w.ptr(poly.ridgePath ? pathIndex.get(poly.ridgePath) : 0);
  w.pointArray((poly.ringNodes || []).map(n => flipY(n.getLoc(), paperHeight)));
  w.ptrArray(poly.localRootVertices || [], v => vertexIndex.get(v));
  w.ptrArray(poly.localRootCreases || [], c => creaseIndex.get(c));
  w.ptrArray(poly.ownedNodes || [], n => nodeIndex.get(n));
  w.ptrArray(poly.ownedPaths || [], p => pathIndex.get(p));
  w.ptrArray(poly.subPolys || [], p => polyIndex.get(p));
  w.ptrArray(poly.ownedCreases || [], c => creaseIndex.get(c));
  w.ptrArray(poly.facets || [], f => facetIndex.get(f));
  const isPoly = !(poly.polyOwner instanceof tmTree);
  w.sizeT(isPoly ? 1 : 0);
  if (isPoly) w.ptr(polyIndex.get(poly.polyOwner));
}

/**
 * Serialize a tmTree to a TreeMaker-native ".tmd5" (version 5.0) file.
 * @param {import('../tmTree.js').tmTree} tree
 * @param {{onSkippedConditions?: (skipped: import('../tmCondition.js').tmCondition[]) => void}} [options]
 *   `onSkippedConditions`, if given, is called (only when at least one
 *   applies) with every condition this tree has that has no equivalent tag
 *   in the native format (findConditionIO() returns null for it) — it's
 *   silently left out of the file otherwise. Previously only a
 *   console.warn; the caller can now tell the user their file won't
 *   round-trip that condition instead of it being silent data loss.
 * @returns {string}
 */
export function treeToTmd5(tree, { onSkippedConditions } = {}) {
  const w = new Tmd5Writer();
  const nodes = tree.getNodes();
  const edges = tree.getEdges();
  const paths = tree.getPaths();
  const paperHeight = tree.getPaperHeight();

  // A stale isFeasible (e.g. right after loading a file, before any UI
  // interaction recomputes it) would otherwise be written verbatim — make
  // sure what's written reflects the tree's actual current state.
  tree.recalculateFeasibility();

  // Everything buildPolysAndCreasePattern() built, in the native format's
  // own flat, all-owners shape (see collectCPGraph()'s doc comment) — empty
  // arrays/maps when no crease pattern has been built, which naturally
  // reduces every write below to its old always-empty behavior.
  const { polys, polyNodes, polyPaths, nodeOwner, pathOwner } = collectCPGraph(tree);
  const allNodes = [...nodes, ...polyNodes];
  const allPaths = [...paths, ...polyPaths];
  const vertices = tree.getVertices();
  const creases = tree.getCreases();
  const facets = tree.getFacets();

  const skipped = [];
  const conditions = tree.getConditions().filter(condition => {
    const io = findConditionIO(condition);
    if (!io) skipped.push(condition);
    return Boolean(io);
  });
  if (skipped.length > 0) {
    console.warn(`tmd5: ${skipped.length} condición(es) no representable(s) en el formato nativo fueron omitidas al guardar`, skipped);
    onSkippedConditions?.(skipped);
  }

  const nodeIndex = new Map(allNodes.map((n, i) => [n, i + 1]));
  const edgeIndex = new Map(edges.map((e, i) => [e, i + 1]));
  const pathIndex = new Map(allPaths.map((p, i) => [p, i + 1]));
  const vertexIndex = new Map(vertices.map((v, i) => [v, i + 1]));
  const creaseIndex = new Map(creases.map((c, i) => [c, i + 1]));
  const facetIndex = new Map(facets.map((f, i) => [f, i + 1]));
  const polyIndex = new Map(polys.map((p, i) => [p, i + 1]));

  const leafPathsByNode = new Map();
  for (const path of paths) {
    if (!isLeafPath(path)) continue;
    const nodesOf = path.getNodes();
    const first = nodesOf[0];
    const last = nodesOf[nodesOf.length - 1];
    for (const n of [first, last]) {
      if (!leafPathsByNode.has(n)) leafPathsByNode.set(n, []);
      leafPathsByNode.get(n).push(path);
    }
  }

  // Same threshold writeBuildState() already uses for its own `bldA`
  // extension below — "a crease pattern exists" (not necessarily a *full*
  // one: HasFullCP() also requires depth/facet/local-root data).
  const hasCP = creases.length > 0;

  w.raw('tree');
  w.raw('5.0');
  w.float(tree.getPaperWidth());
  w.float(paperHeight);
  w.float(tree.getScale());
  w.bool(Boolean(tree.hasSymmetry));
  w.point(flipY(tree.symLoc, paperHeight));
  w.float(flipAngleDegrees(Number(tree.symAngle) || 0));
  w.bool(Boolean(tree.isFeasible));
  w.bool(Boolean(tree.isPolygonValid));
  w.bool(Boolean(tree.isPolygonFilled));
  w.bool(Boolean(tree.isVertexDepthValid));
  w.bool(Boolean(tree.isFacetDataValid));
  w.bool(Boolean(tree.isLocalRootConnectable));
  w.bool(!hasCP); // needsCleanup

  w.sizeT(allNodes.length);
  w.sizeT(edges.length);
  w.sizeT(allPaths.length);
  w.sizeT(polys.length);
  w.sizeT(vertices.length);
  w.sizeT(creases.length);
  w.sizeT(facets.length);
  w.sizeT(conditions.length);

  allNodes.forEach((node, i) => writeNode(w, node, i + 1, nodeIndex, edgeIndex, pathIndex, leafPathsByNode, paperHeight, vertexIndex, polyIndex, nodeOwner));
  edges.forEach((edge, i) => writeEdge(w, edge, i + 1, nodeIndex));
  allPaths.forEach((path, i) => writePath(w, path, i + 1, tree, nodeIndex, edgeIndex, vertexIndex, creaseIndex, polyIndex, pathOwner));
  polys.forEach((poly, i) => writePoly(w, poly, i + 1, nodeIndex, pathIndex, vertexIndex, creaseIndex, polyIndex, facetIndex, paperHeight));
  vertices.forEach((vertex, i) => writeVertex(w, vertex, i + 1, vertexIndex, nodeIndex, pathIndex, creaseIndex, paperHeight));
  creases.forEach((crease, i) => writeCrease(w, crease, i + 1, creaseIndex, vertexIndex, facetIndex, polyIndex, pathIndex));
  facets.forEach((facet, i) => writeFacet(w, facet, i + 1, facetIndex, vertexIndex, creaseIndex, edgeIndex, polyIndex, paperHeight));

  conditions.forEach((condition, i) => {
    const io = findConditionIO(condition);
    w.raw(io.tag);
    w.sizeT(i + 1);
    w.bool(Boolean(condition.isFeasible));
    w.sizeT(io.numLines);
    io.write(w, condition, nodeIndex, edgeIndex);
  });

  w.ptrArray(nodes, n => nodeIndex.get(n));
  w.ptrArray(edges, e => edgeIndex.get(e));
  w.ptrArray(paths, p => pathIndex.get(p));
  w.ptrArray(tree.polys || [], p => polyIndex.get(p)); // owned polys: top-level only, matching mOwnedPolys

  // This app's own extension, with no counterpart in the original format —
  // see SavedSearches.js's doc comment for why it's safe to append here.
  writeSavedSearches(w, tree.rfSavedQueries || []);
  writeBuildState(w, tree);

  return w.toString();
}

// This app's own extension (no counterpart in the original format, same
// "safe to append after everything else" reasoning as SavedSearches.js):
// whether Build Crease Pattern had fully succeeded when the tree was saved.
// The poly/vertex/crease/facet graph itself IS written (see the header
// comment's own note on this), but only ever reflects a fresh
// buildPolysAndCreasePattern() run's own state — this flag lets
// tmd5ToTree() re-run that build on load too (deterministic given the same
// topology/positions), so a tree that had a fully-built crease pattern when
// saved gets one back immediately, without the user re-clicking Build.
const BUILD_STATE_TAG = 'bldA';

function writeBuildState(w, tree) {
  w.raw(BUILD_STATE_TAG);
  // Same criterion main.js uses to enable Kill Crease Pattern/Creases
  // View/Plan View (`hasCreasePattern`) — a lower bar than hasFullCP()
  // (which also requires depth/facet/local-root data), so a partially-built
  // but still-inspectable crease pattern is preserved across save/load too.
  w.bool(tree.getCreases().length > 0);
}

// Absence (a file from before this feature existed) just means "don't
// auto-rebuild", not an error — same convention as readSavedSearches().
function readBuildState(r) {
  if (r.pos >= r.lines.length) return false;
  const rest = r.lines.slice(r.pos).join('');
  if (rest.trim() === '') return false;
  const tag = r.tag();
  if (tag !== BUILD_STATE_TAG) return false;
  return r.bool();
}

// ===== Reader =====

export function readNode(r, version) {
  const tag = r.tag();
  if (tag !== 'node') throw new Error(`Se esperaba un nodo ("node"), se encontró "${tag}"`);
  const index = r.sizeT();
  const label = r.label();
  const loc = r.point();
  // Depth/elevation and the "junction node" flag were added in version 5;
  // 4.0 files don't carry them at all (see tmNode::Getv4Self vs Getv5Self).
  const depth = version === '5.0' ? r.float() : 0;
  const elevation = version === '5.0' ? r.float() : 0;
  const isLeafNode = r.bool();
  const isSubNode = r.bool();
  const isBorderNode = r.bool();
  const isPinnedNode = r.bool();
  const isPolygonNode = r.bool();
  const isJunctionNode = version === '5.0' ? r.bool() : false;
  if (version === '5.0') {
    r.bool(); // isConditionedNode: recomputed once conditions are re-added
    const edgeRefs = r.ptrArray();
    const leafPathRefs = r.ptrArray();
    r.ptrArray(); // owned vertices (ignored: no crease pattern to restore)
    r.skipOwnerPtr(); // poly-owned nodes aren't reconstructed as such
    return {
      index, label, loc, depth, elevation, isLeafNode, isSubNode,
      isBorderNode, isPinnedNode, isPolygonNode, isJunctionNode, edgeRefs, leafPathRefs
    };
  }
  // v4.0 order differs: isConditionedNode, then owned vertices BEFORE the
  // edges/leafPaths arrays (see tmNode::Getv4Self).
  r.bool(); // isConditionedNode
  r.ptrArray(); // owned vertices
  const edgeRefs = r.ptrArray();
  const leafPathRefs = r.ptrArray();
  r.skipOwnerPtr();
  return {
    index, label, loc, depth, elevation, isLeafNode, isSubNode,
    isBorderNode, isPinnedNode, isPolygonNode, isJunctionNode, edgeRefs, leafPathRefs
  };
}

export function readEdgeV5(r) {
  const tag = r.tag();
  if (tag !== 'edge') throw new Error(`Se esperaba una arista ("edge"), se encontró "${tag}"`);
  const index = r.sizeT();
  const label = r.label();
  const length = r.float();
  const strain = r.float();
  const stiffness = r.float();
  const isPinnedEdge = r.bool();
  const isConditionedEdge = r.bool();
  const nodeRefs = r.ptrArray();
  // No owner-ptr to read: PutOwnerPtr(tmEdgeOwner*) writes nothing.
  return { index, label, length, strain, stiffness, isPinnedEdge, isConditionedEdge, nodeRefs };
}

export function readPath(r, version) {
  const tag = r.tag();
  if (tag !== 'path') throw new Error(`Se esperaba un camino ("path"), se encontró "${tag}"`);
  const index = r.sizeT();
  const minTreeLength = r.float();
  const minPaperLength = r.float();
  let actTreeLength = null;
  let actPaperLength = null;
  if (version === '5.0') {
    actTreeLength = r.float();
    actPaperLength = r.float();
  }
  const isLeafPath = r.bool();
  const isSubPath = r.bool();
  let isFeasiblePath = true;
  if (version === '5.0') isFeasiblePath = r.bool();
  const isActivePath = r.bool();
  const isBorderPath = r.bool();
  const isPolygonPath = r.bool();
  const isConditionedPath = r.bool();
  let ownedVerticesV4 = null;
  if (version !== '5.0') ownedVerticesV4 = r.ptrArray();
  const fwdPolyRef = r.ptr();
  const bkdPolyRef = r.ptr();
  const nodeRefs = r.ptrArray();
  const edgeRefs = r.ptrArray();
  if (version === '5.0') {
    r.ptr(); // outsetPath
    r.float(); // frontReduction
    r.float(); // backReduction
    r.float(); // minDepth
    r.float(); // minDepthDist
    r.ptrArray(); // owned vertices
    r.ptrArray(); // owned creases
  }
  r.skipOwnerPtr(); // poly-owned paths aren't reconstructed as such
  return {
    index, minTreeLength, minPaperLength, actTreeLength, actPaperLength,
    isLeafPath, isSubPath, isFeasiblePath, isActivePath, isBorderPath, isPolygonPath,
    isConditionedPath, nodeRefs, edgeRefs
  };
}

function readCondition(r, version, ctx) {
  const tag = r.tag();
  let index = null;
  let isFeasibleCondition = true;
  if (version === '5.0') {
    index = r.sizeT();
    isFeasibleCondition = r.bool();
  }
  const numLines = r.sizeT();
  const io = CONDITION_IO.find(item => item.tag === tag);
  if (!io) {
    // Recognized shape, unsupported/unknown type (e.g. the PathCombo
    // aggregate condition, or a tag from a newer file version): skip its
    // body so the rest of the file still parses, same fallback the
    // original format itself uses for genuinely unrecognized tags.
    r.skipLines(numLines);
    return { condition: null, index, isFeasibleCondition, tag };
  }
  // Most entries return a single condition; CNxn (ConditionNodeCombo) can
  // decompose into several (e.g. both "fixed to X/Y" and "fixed to
  // symmetry line" on the same node), so it returns an array instead.
  const condition = io.read(r, ctx);
  return { condition, index, isFeasibleCondition, tag };
}

/**
 * Parse a TreeMaker ".tmd5" file (version 4.0 or 5.0) into a new tmTree.
 * @param {string} text
 * @param {{onSkippedConditions?: (skipped: {tag: string, index: number|null}[]) => void}} [options]
 *   `onSkippedConditions`, if given, is called (only when the file actually
 *   had at least one) with every condition entry that couldn't be
 *   reconstructed — an unrecognized/newer tag, or a recognized one whose
 *   read() came back null (e.g. it references a node/edge index the file
 *   didn't actually define). Previously only a console.warn count; the
 *   caller can now surface this instead of it being silent data loss.
 * @returns {import('../tmTree.js').tmTree}
 */
export function tmd5ToTree(text, { onSkippedConditions } = {}) {
  const r = new Tmd5Reader(text);
  const tag = r.tag();
  if (tag !== 'tree') {
    throw new Error(`Este archivo no parece ser un archivo TreeMaker (.tmd5): etiqueta inicial = "${tag}"`);
  }
  const version = r.raw().trim();
  if (version !== '4.0' && version !== '5.0') {
    throw new Error(`Versión de archivo .tmd5 no soportada: "${version}" (se admiten 4.0 y 5.0)`);
  }

  const tree = new tmTree();
  tree.paperWidth = r.float();
  tree.paperHeight = r.float();
  tree.scale = r.float();
  tree.hasSymmetry = r.bool();
  tree.symmetryType = tree.hasSymmetry ? 'diagonal' : 'none';
  tree.symLoc = flipY(r.point(), tree.paperHeight);
  tree.symAngle = flipAngleDegrees(r.float());

  if (version === '5.0') {
    tree.isFeasible = r.bool();
    r.bool(); // isPolygonValid
    r.bool(); // isPolygonFilled
    r.bool(); // isVertexDepthValid
    r.bool(); // isFacetDataValid
    r.bool(); // isLocalRootConnectable
    r.bool(); // needsCleanup
  }

  const numNodes = r.sizeT();
  const numEdges = r.sizeT();
  const numPaths = r.sizeT();
  const numPolys = r.sizeT();
  const numVertices = r.sizeT();
  const numCreases = r.sizeT();
  let numFacets = 0;
  if (version === '5.0') numFacets = r.sizeT();
  const numConditions = r.sizeT();

  const nodeRecords = [];
  for (let i = 0; i < numNodes; i++) nodeRecords.push(readNode(r, version));
  const edgeRecords = [];
  for (let i = 0; i < numEdges; i++) edgeRecords.push(readEdgeV5(r));
  const pathRecords = [];
  for (let i = 0; i < numPaths; i++) pathRecords.push(readPath(r, version));

  // Polys/vertices/creases/facets: this importer doesn't reconstruct the
  // saved crease pattern (our own tree treats it as derived/rebuildable,
  // see buildPolysAndCreasePattern() below) — but a file from real
  // TreeMaker will almost always have one, so we still need to correctly
  // walk past each record (they're variable-length: several index arrays
  // apiece) to keep the reader's cursor in sync for what follows.
  for (let i = 0; i < numPolys; i++) skipPolyRecord(r);
  for (let i = 0; i < numVertices; i++) skipVertexRecord(r);
  for (let i = 0; i < numCreases; i++) skipCreaseRecord(r);
  for (let i = 0; i < numFacets; i++) skipFacetRecord(r);

  // Build the actual model objects now that we know every reference.
  const nodesByIndex = new Map();
  for (const rec of nodeRecords) {
    const node = new tmNode(null, flipY(rec.loc, tree.paperHeight));
    // The original persists no node label at all (nodes are identified by
    // index/pointer, not a name) — see tmTree._nextNodeLabel() — so a file
    // saved from real TreeMaker always hits this fallback. Use the plain
    // index, matching the label a locally-created node gets.
    node.label = rec.label || String(rec.index);
    node.depth = rec.depth;
    node.elevation = rec.elevation;
    node.isLeafNode = rec.isLeafNode;
    node.isSubNode = rec.isSubNode;
    node.isBorderNode = rec.isBorderNode;
    node.isPinnedNode = rec.isPinnedNode;
    node.isPolygonNode = rec.isPolygonNode;
    node.isJunctionNode = rec.isJunctionNode;
    tree.nodes.push(node);
    nodesByIndex.set(rec.index, node);
  }

  const edgesByIndex = new Map();
  for (const rec of edgeRecords) {
    const n1 = nodesByIndex.get(rec.nodeRefs[0]);
    const n2 = nodesByIndex.get(rec.nodeRefs[1]);
    if (!n1 || !n2) continue;
    const edge = new tmEdge(null, n1, n2);
    edge.label = rec.label;
    edge.length = rec.length;
    edge.strain = rec.strain;
    edge.stiffness = rec.stiffness;
    edge.isPinnedEdge = rec.isPinnedEdge;
    edge.isConditionedEdge = rec.isConditionedEdge;
    tree.edges.push(edge);
    edgesByIndex.set(rec.index, edge);
  }

  for (const rec of pathRecords) {
    const nodeList = rec.nodeRefs.map(ref => nodesByIndex.get(ref)).filter(Boolean);
    if (nodeList.length < 2) continue;
    const path = tree.getPath(nodeList[0], nodeList[nodeList.length - 1]);
    if (!path) continue;
    path.isActiveGeometry = rec.isActivePath;
    path.isFeasible = rec.isFeasiblePath;
    path.minTreeLength = rec.minTreeLength || path.minTreeLength;
  }

  tree.rootNode = tree.nodes.find(node => node.isRootNode) || tree.nodes[0] || null;

  const ctx = {
    tree,
    nodeByIndex: idx => nodesByIndex.get(idx) || null,
    edgeByIndex: idx => edgesByIndex.get(idx) || null
  };

  const skippedConditions = [];
  for (let i = 0; i < numConditions; i++) {
    const { condition, index, tag: conditionTag } = readCondition(r, version, ctx);
    if (Array.isArray(condition)) condition.forEach(c => tree.addCondition(c));
    else if (condition) tree.addCondition(condition);
    else skippedConditions.push({ tag: conditionTag, index });
  }
  if (skippedConditions.length > 0) {
    console.warn(`tmd5: ${skippedConditions.length} condición(es) del archivo no se pudieron reconstruir y fueron omitidas`, skippedConditions);
    onSkippedConditions?.(skippedConditions);
  }

  // The tree's own trailing owned-part arrays (mOwnedNodes/mOwnedEdges/
  // mOwnedPaths/mOwnedPolys — see tmTree::Putv5Self in the original):
  // redundant with what was already reconstructed above from the node/edge/
  // path records themselves, so their contents are discarded — but they
  // still have to be consumed to reach whatever this app's own
  // `rfSavedQueries` extension appended after them (see SavedSearches.js).
  // A file that ends here (no extension section) still parses fine:
  // readSavedSearches() treats running out of input as "no saved
  // searches", not an error.
  r.ptrArray(); // owned nodes
  r.ptrArray(); // owned edges
  r.ptrArray(); // owned paths
  r.ptrArray(); // owned polys
  tree.rfSavedQueries = readSavedSearches(r);
  // Either this app's own `bldA` extension says so (see writeBuildState()),
  // or the file itself already came with a built crease pattern (numPolys >
  // 0) — the latter is how every real TreeMaker file with Build Crease
  // Pattern applied signals it, since that app writes the full poly/vertex/
  // crease/facet graph instead of an extension tag.
  const wasBuilt = readBuildState(r) || numPolys > 0;

  // The file's own crease-pattern data (if any) was skipped above, not
  // reconstructed — but if Build Crease Pattern had succeeded when the tree
  // was saved, rebuild it now from the restored topology so the user
  // doesn't have to click "Build Crease Pattern" again after loading. A
  // file with neither signal (a real TreeMaker tree that was never built,
  // or an older treemaker-spa save) leaves the crease pattern empty until
  // an explicit Build, same as before.
  tree.refreshNodeClassification();
  if (wasBuilt) {
    tree.buildPolysAndCreasePattern();
  }

  return tree;
}

// Structural skippers for the derived crease-pattern records (poly/vertex/
// crease/facet). We don't reconstruct these into the model — the tree
// rebuilds its own crease pattern from topology after loading — but still
// have to consume exactly the right sequence of fields (mostly variable-
// length index arrays) to keep the reader's cursor correctly positioned
// for whatever record follows. Field order mirrors each class's
// Putv5Self/Getv5Self in the original C++ source exactly.

function skipPolyRecord(r) {
  const tag = r.tag();
  if (tag !== 'poly') throw new Error(`Se esperaba un polígono ("poly"), se encontró "${tag}"`);
  r.sizeT(); // index
  r.point(); // centroid
  r.bool(); // isSubPoly
  r.ptrArray(); // ringNodes
  r.ptrArray(); // ringPaths
  r.ptrArray(); // crossPaths
  r.ptrArray(); // insetNodes
  r.ptrArray(); // spokePaths
  r.ptr(); // ridgePath
  const numNodeLocs = r.sizeT(); // mNodeLocs: tmArray<tmPoint>
  for (let i = 0; i < numNodeLocs; i++) r.point();
  r.ptrArray(); // localRootVertices
  r.ptrArray(); // localRootCreases
  r.ptrArray(); // ownedNodes
  r.ptrArray(); // ownedPaths
  r.ptrArray(); // ownedPolys
  r.ptrArray(); // ownedCreases
  r.ptrArray(); // ownedFacets
  const isPoly = r.sizeT(); // owner: tmPolyOwner (ptr only present if poly-owned)
  if (isPoly) r.ptr();
}

function skipVertexRecord(r) {
  const tag = r.tag();
  if (tag !== 'vrtx') throw new Error(`Se esperaba un vértice ("vrtx"), se encontró "${tag}"`);
  r.sizeT(); // index
  r.point(); // loc
  r.float(); // elevation
  r.bool(); // isBorderVertex
  r.ptr(); // treeNode
  r.ptr(); // leftPseudohingeMate
  r.ptr(); // rightPseudohingeMate
  r.ptrArray(); // creases
  r.float(); // depth
  r.float(); // discreteDepth (int, but numeric-line-compatible to skip)
  r.float(); // ccFlag (int)
  r.float(); // stFlag (int)
  r.sizeT(); // owner: tmVertexOwner isNode flag
  r.ptr(); // owner: tmVertexOwner ptr (always present, node or path)
}

function skipCreaseRecord(r) {
  const tag = r.tag();
  if (tag !== 'crse') throw new Error(`Se esperaba un pliegue ("crse"), se encontró "${tag}"`);
  r.sizeT(); // index
  r.float(); // kind (int)
  r.ptrArray(); // vertices
  r.ptr(); // fwdFacet
  r.ptr(); // bkdFacet
  r.float(); // fold (int)
  r.float(); // ccFlag (int)
  r.float(); // stFlag (int)
  r.sizeT(); // owner: tmCreaseOwner isPoly flag
  r.ptr(); // owner: tmCreaseOwner ptr (always present, path or poly)
}

function skipFacetRecord(r) {
  const tag = r.tag();
  if (tag !== 'fact') throw new Error(`Se esperaba una faceta ("fact"), se encontró "${tag}"`);
  r.sizeT(); // index
  r.point(); // centroid
  r.bool(); // isWellFormed
  r.ptrArray(); // vertices
  r.ptrArray(); // creases
  r.ptr(); // corridorEdge
  r.ptrArray(); // headFacets
  r.ptrArray(); // tailFacets
  r.sizeT(); // order
  r.float(); // color (int)
  r.ptr(); // owner: tmFacetOwner is always exactly one poly ptr, no flag
}
