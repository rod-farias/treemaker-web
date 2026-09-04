/**
 * PolygonPartition.js
 * Equivalent to tmPolyOwner::BuildPolysFromPaths() and its helpers
 * (CanStartPolyFwd/Bkd, GetNextPathAndNode). In the original, tmPolyOwner
 * is the shared base class of both tmTree (top-level partition of the
 * paper) and tmPoly (recursive partition of an inset polygon's interior
 * during BuildPolyContents) — this module plays that same shared-base-class
 * role for the JS port, as a plain function both tmTree.js and tmPoly.js
 * call, instead of a class hierarchy.
 */

import { tmPoint } from '../tmPoint.js';

function areCCW(p1, p2, p3) {
  return p1.subtract(p3).cross(p2.subtract(p3)) > 0;
}
function areCW(p1, p2, p3) {
  return p1.subtract(p3).cross(p2.subtract(p3)) < 0;
}

function canStartPolyFwd(path, centroid) {
  if (path.fwdPoly) return false;
  if (!path.isBorderPath) return true;
  return areCCW(path.getFirstNode().getLoc(), path.getLastNode().getLoc(), centroid);
}

function canStartPolyBkd(path, centroid) {
  if (path.bkdPoly) return false;
  if (!path.isBorderPath) return true;
  return areCW(path.getFirstNode().getLoc(), path.getLastNode().getLoc(), centroid);
}

/**
 * Equivalent to tmPolyOwner::GetNextPathAndNode(): standing at `thisNode`,
 * having just arrived via `thisPath`, pick the next polygon-path edge at
 * this vertex by sweeping clockwise from the bearing pointing back the way
 * we came — the standard rule for tracing every bounded face of a planar
 * arrangement in one consistent (here CCW) rotational sense. Returns
 * {nextPath: null, nextNode: null} if no candidate is found (a dead end)
 * instead of the original's unguarded assert, since a release JS build has
 * no compiled-out asserts to fall back on.
 */
function getNextPathAndNode(thisPath, thisNode, nodeToPaths) {
  let thatNode = thisPath.getFirstNode();
  if (thatNode === thisNode) thatNode = thisPath.getLastNode();
  const thisAngle = thatNode.getLoc().subtract(thisNode.getLoc()).angle();

  let delta = 2 * Math.PI;
  let nextPath = null;
  let nextNode = null;
  for (const thatPath of nodeToPaths.get(thisNode) || []) {
    if (thatPath === thisPath || !thatPath.isPolygonPath) continue;
    let candidateNode = thatPath.getFirstNode();
    if (candidateNode === thisNode) candidateNode = thatPath.getLastNode();
    const nextAngle = candidateNode.getLoc().subtract(thisNode.getLoc()).angle();
    let newDelta = thisAngle - nextAngle;
    while (newDelta < 0) newDelta += 2 * Math.PI;
    while (newDelta >= 2 * Math.PI) newDelta -= 2 * Math.PI;
    if (newDelta < delta) {
      delta = newDelta;
      nextPath = thatPath;
      nextNode = candidateNode;
    }
  }
  return { nextPath, nextNode };
}

/**
 * Equivalent to the ring-building loop inside
 * tmPolyOwner::BuildPolysFromPaths(): traces one polygon boundary starting
 * at `seedPath`, in the given direction ('fwd': left of front->back; 'bkd':
 * left of back->front), by repeatedly calling getNextPathAndNode() until
 * the walk returns to its start node. Unlike the original, the fwd/bkdPoly
 * claims are only committed once the ring successfully closes — a dead end
 * simply abandons this polygon instead of leaving a half-claimed,
 * corrupted network. `createPoly()` builds the (empty) poly instance to
 * populate — injected so this module doesn't need to import tmPoly.js
 * (which itself needs to call into this module for BuildPolyContents'
 * recursive case, and a two-way import would be circular).
 */
function traceRing(seedPath, direction, nodeToPaths, createPoly) {
  const poly = createPoly();
  const firstNode = direction === 'fwd' ? seedPath.getFirstNode() : seedPath.getLastNode();
  let thisNode = direction === 'fwd' ? seedPath.getLastNode() : seedPath.getFirstNode();
  poly.ringNodes.push(firstNode);
  poly.ringPaths.push(seedPath);

  const claims = [[seedPath, direction]];
  let thisPath = seedPath;
  const guard = nodeToPaths.size * 4 + 8; // generous bound on a real ring's length
  let steps = 0;
  for (;;) {
    const { nextPath, nextNode } = getNextPathAndNode(thisPath, thisNode, nodeToPaths);
    if (!nextPath || !nextNode) {
      console.warn('buildPolysFromPaths: dead end tracing a polygon ring, skipping');
      return null;
    }
    poly.ringNodes.push(thisNode);
    poly.ringPaths.push(nextPath);
    claims.push([nextPath, nextPath.getFirstNode() === thisNode ? 'fwd' : 'bkd']);
    thisPath = nextPath;
    thisNode = nextNode;
    steps += 1;
    if (thisNode === firstNode) break;
    if (steps > guard) {
      console.warn('buildPolysFromPaths: ring trace exceeded safety bound, skipping');
      return null;
    }
  }

  for (const [path, dir] of claims) {
    if (dir === 'fwd') path.fwdPoly = poly; else path.bkdPoly = poly;
  }
  poly.calcCentroid();
  return poly;
}

/**
 * Equivalent to tmPolyOwner::BuildPolysFromPaths(): traces every bounded
 * face of the planar arrangement formed by the polygon-flagged paths in
 * `paths`, producing one poly (via `createPoly()`) per face. Returns the
 * array of newly built polys — this function has no notion of an "owner"
 * collection, the caller decides where the results belong (tree.polys for
 * the top-level partition, or a poly's own subPolys when recursing inside
 * BuildPolyContents).
 *
 * @param {object} options
 * @param {import('../tmPath.js').tmPath[]} options.paths - candidate paths (only ones with isPolygonPath=true are used)
 * @param {import('../tmNode.js').tmNode[]} options.borderNodes - used only to orient border-path seeding (their centroid)
 * @param {Map} options.nodeToPaths - node -> all paths incident to it (not just polygon ones; filtered internally)
 * @param {() => import('../tmPoly.js').tmPoly} options.createPoly - builds an empty poly instance to populate
 */
export function buildPolysFromPaths({ paths, borderNodes, nodeToPaths, createPoly }) {
  // Candidate polygon-path set, culling sliver self-intersections
  // (first-accepted-wins order = `paths`' order; a later path that crosses
  // an earlier accepted one's interior is rejected and its isPolygonPath
  // flag cleared for real, matching the original's deliberately crude but
  // consistent tie-break for near-degenerate cases like a sliver rectangle
  // with both diagonals nearly active).
  const polygonPaths = [];
  for (const path of paths) {
    if (!path.isPolygonPath) continue;
    if (polygonPaths.some(accepted => path.intersectsInterior(accepted))) {
      path.isPolygonPath = false;
      continue;
    }
    polygonPaths.push(path);
  }

  if (borderNodes.length === 0) return []; // no border to orient border-path seeding against
  let cx = 0;
  let cy = 0;
  for (const node of borderNodes) {
    cx += node.getLocX();
    cy += node.getLocY();
  }
  const centroid = new tmPoint(cx / borderNodes.length, cy / borderNodes.length);

  // Tracing a ring claims the fwd/bkdPoly slot of every path it walks, so
  // later iterations here naturally skip directions already claimed by an
  // earlier ring (canStartPolyFwd/Bkd's first check).
  const built = [];
  for (const path of polygonPaths) {
    if (canStartPolyFwd(path, centroid)) {
      const poly = traceRing(path, 'fwd', nodeToPaths, createPoly);
      if (poly) built.push(poly);
    }
    if (canStartPolyBkd(path, centroid)) {
      const poly = traceRing(path, 'bkd', nodeToPaths, createPoly);
      if (poly) built.push(poly);
    }
  }
  return built;
}
