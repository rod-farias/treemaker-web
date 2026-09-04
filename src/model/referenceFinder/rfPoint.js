/**
 * rfPoint.js
 * Represents a 2D point or direction vector, used by ReferenceFinder's
 * geometry (marks, lines, paper). Equivalent to XYPt in
 * original/ReferenceFinder/source/model/ReferenceFinder.h.
 *
 * Deliberately separate from tmPoint.js (TreeMaker's own 2D point): the two
 * are similar in shape but serve different algebra — XYPt models fold
 * geometry (Fold(), Rotate90(), Chop()), tmPoint models tree-node state.
 * Fusing them would couple two independent original programs that never
 * shared this type. See REFERENCEFINDER_PLAN.md section 2.
 *
 * Like tmPoint.js, every method returns a new instance rather than mutating
 * (`operator+=` etc. from the original aren't ported — nothing in
 * ReferenceFinder.cpp actually needs the in-place forms).
 *
 * Coordinate convention: Y increases UPWARD (paper origin at the bottom
 * left), same as the original ReferenceFinder/TreeMaker C++ and the raw
 * ".tmd5" file format — unlike this app's own tree-space (tmPoint.js,
 * Y increasing downward like screen/canvas coordinates). Anything crossing
 * that boundary (e.g. handing a tree node's location to rfEngine.js as a
 * search target) needs the same flipY() conversion Tmd5Format.js already
 * uses at the tree/file boundary.
 */

// XYPt's EPS (used for point/line equality and parallel-ness tests).
export const RF_EPS = 1.0e-8;

export class rfPoint {
  constructor(x = 0, y = 0) {
    this.x = Number(x);
    this.y = Number(y);
  }

  clone() {
    return new rfPoint(this.x, this.y);
  }

  // operator+(const XYPt&)
  add(point) {
    return new rfPoint(this.x + point.x, this.y + point.y);
  }

  // operator-(const XYPt&)
  subtract(point) {
    return new rfPoint(this.x - point.x, this.y - point.y);
  }

  // operator*(const XYPt&): element-wise
  multiply(point) {
    return new rfPoint(this.x * point.x, this.y * point.y);
  }

  // operator/(const XYPt&): element-wise
  divide(point) {
    return new rfPoint(this.x / point.x, this.y / point.y);
  }

  // operator+(double) / friend operator+(double, const XYPt&) (commutative)
  addScalar(z) {
    return new rfPoint(this.x + z, this.y + z);
  }

  // operator-(double): p - z, NOT the friend d - p (see subtractFromScalar)
  subtractScalar(z) {
    return new rfPoint(this.x - z, this.y - z);
  }

  // operator*(double) / friend operator*(double, const XYPt&) (commutative)
  scale(z) {
    return new rfPoint(this.x * z, this.y * z);
  }

  // operator/(double): p / z, NOT the friend d / p (see divideIntoScalar)
  divideScalar(z) {
    return new rfPoint(this.x / z, this.y / z);
  }

  // Rotate90(): counterclockwise quarter turn.
  rotate90() {
    return new rfPoint(-this.y, this.x);
  }

  // RotateCCW(a): a is in radians.
  rotateCCW(angle) {
    const sa = Math.sin(angle);
    const ca = Math.cos(angle);
    return new rfPoint(ca * this.x - sa * this.y, sa * this.x + ca * this.y);
  }

  // Dot(const XYPt&)
  dot(point) {
    return this.x * point.x + this.y * point.y;
  }

  // Mag2(): squared magnitude.
  mag2() {
    return this.x * this.x + this.y * this.y;
  }

  // Mag()
  mag() {
    return Math.sqrt(this.x * this.x + this.y * this.y);
  }

  // Normalize()
  normalize() {
    const m = this.mag();
    return new rfPoint(this.x / m, this.y / m);
  }

  // Chop(): numbers closer to zero than RF_EPS become exactly zero.
  chop() {
    return new rfPoint(Math.abs(this.x) < RF_EPS ? 0 : this.x, Math.abs(this.y) < RF_EPS ? 0 : this.y);
  }

  // operator==(const XYPt&): true if within RF_EPS.
  equals(point) {
    return this.subtract(point).mag() < RF_EPS;
  }

  toString() {
    return `(${this.x}, ${this.y})`;
  }
}

// friend operator-(double d, const XYPt& pp): d - p, component-wise.
// Not the same as p.subtractScalar(d) (which is p - d).
export function subtractFromScalar(d, point) {
  return new rfPoint(d - point.x, d - point.y);
}

// friend operator/(double d, const XYPt& pp): d / p, component-wise.
export function divideIntoScalar(d, point) {
  return new rfPoint(d / point.x, d / point.y);
}

// friend MidPoint(const XYPt&, const XYPt&)
export function midPoint(p1, p2) {
  return new rfPoint(0.5 * (p1.x + p2.x), 0.5 * (p1.y + p2.y));
}
