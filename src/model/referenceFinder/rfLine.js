/**
 * rfLine.js
 * Represents a line by a scalar offset and a unit normal vector: d*u is the
 * point on the line closest to the origin. Equivalent to XYLine in
 * original/ReferenceFinder/source/model/ReferenceFinder.h.
 */

import { rfPoint, RF_EPS } from './rfPoint.js';

export class rfLine {
  constructor(d = 0, u = new rfPoint(1, 0)) {
    this.d = d;
    this.u = u;
  }

  // XYLine(const XYPt& p1, const XYPt& p2): line through two points.
  static throughPoints(p1, p2) {
    const u = p2.subtract(p1).normalize().rotate90();
    return new rfLine(p1.dot(u), u);
  }

  // Fold(p1): fold a point about this line.
  fold(p1) {
    return p1.add(this.u.scale(2 * (this.d - p1.dot(this.u))));
  }

  // IsParallelTo(ll)
  isParallelTo(line) {
    return Math.abs(this.u.dot(line.u.rotate90())) < RF_EPS;
  }

  // operator==(ll): true if lines are the same (same offset/direction, up
  // to the sign flip that comes from u pointing either way).
  equals(line) {
    return (
      Math.abs(this.d - line.d * this.u.dot(line.u)) < RF_EPS &&
      Math.abs(this.u.dot(line.u.rotate90())) < RF_EPS
    );
  }

  // Intersects(pp): true if pt lies on the line.
  containsPoint(point) {
    return Math.abs(this.d - point.dot(this.u)) < RF_EPS;
  }

  // Intersects(ll, pp): true if lines intersect; returns the intersection
  // point, or null if parallel. (The original writes into an out-param and
  // returns bool; this port returns the point directly, matching this
  // project's null-for-degenerate convention — see tmPoint.js's
  // lineIntersection().)
  intersectLine(line) {
    const denom = this.u.x * line.u.y - this.u.y * line.u.x;
    if (Math.abs(denom) < RF_EPS) return null;
    return new rfPoint(
      (this.d * line.u.y - line.d * this.u.y) / denom,
      (line.d * this.u.x - this.d * line.u.x) / denom
    );
  }

  toString() {
    return `[d=${this.d}, u=${this.u}]`;
  }
}

// friend Intersection(l1, l2): the intersection point, with NO parallel-ness
// check (matches the original — use rfLine#intersectLine when in doubt).
export function intersection(l1, l2) {
  const denom = l1.u.x * l2.u.y - l1.u.y * l2.u.x;
  return new rfPoint(
    (l1.d * l2.u.y - l2.d * l1.u.y) / denom,
    (l2.d * l1.u.x - l1.d * l2.u.x) / denom
  );
}
