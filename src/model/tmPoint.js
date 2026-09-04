/**
 * tmPoint.js
 * Represents a 2D floating-point cartesian point
 * Equivalent to tmPoint class in TreeMaker C++
 */

export class tmPoint {
  constructor(x = 0, y = 0) {
    this.x = Number(x);
    this.y = Number(y);
  }

  // Clone
  clone() {
    return new tmPoint(this.x, this.y);
  }

  // Addition
  add(point) {
    return new tmPoint(this.x + point.x, this.y + point.y);
  }

  addEquals(point) {
    this.x += point.x;
    this.y += point.y;
    return this;
  }

  // Subtraction
  subtract(point) {
    return new tmPoint(this.x - point.x, this.y - point.y);
  }

  subtractEquals(point) {
    this.x -= point.x;
    this.y -= point.y;
    return this;
  }

  // Multiplication by point (element-wise)
  multiply(point) {
    return new tmPoint(this.x * point.x, this.y * point.y);
  }

  multiplyEquals(point) {
    this.x *= point.x;
    this.y *= point.y;
    return this;
  }

  // Multiplication by scalar
  scale(scalar) {
    return new tmPoint(this.x * scalar, this.y * scalar);
  }

  scaleEquals(scalar) {
    this.x *= scalar;
    this.y *= scalar;
    return this;
  }

  // Division by point (element-wise)
  divide(point) {
    return new tmPoint(this.x / point.x, this.y / point.y);
  }

  divideEquals(point) {
    this.x /= point.x;
    this.y /= point.y;
    return this;
  }

  // Division by scalar
  divideScalar(scalar) {
    return new tmPoint(this.x / scalar, this.y / scalar);
  }

  divideScalarEquals(scalar) {
    this.x /= scalar;
    this.y /= scalar;
    return this;
  }

  // Magnitude (length)
  magnitude() {
    return Math.sqrt(this.x * this.x + this.y * this.y);
  }

  // Dot product
  dot(point) {
    return this.x * point.x + this.y * point.y;
  }

  // Cross product (2D - returns scalar)
  cross(point) {
    return this.x * point.y - this.y * point.x;
  }

  // Distance to another point
  distance(point) {
    const dx = this.x - point.x;
    const dy = this.y - point.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // Distance squared (faster, no sqrt)
  distanceSquared(point) {
    const dx = this.x - point.x;
    const dy = this.y - point.y;
    return dx * dx + dy * dy;
  }

  // Normalize to unit vector
  normalize() {
    const mag = this.magnitude();
    if (mag === 0) return new tmPoint(0, 0);
    return new tmPoint(this.x / mag, this.y / mag);
  }

  normalizeEquals() {
    const mag = this.magnitude();
    if (mag > 0) {
      this.x /= mag;
      this.y /= mag;
    }
    return this;
  }

  // Perpendicular (rotate 90 degrees counter-clockwise)
  perpendicular() {
    return new tmPoint(-this.y, this.x);
  }

  // Angle in radians from positive x-axis
  angle() {
    return Math.atan2(this.y, this.x);
  }

  // Angle between this point and another
  angleTo(point) {
    const theta1 = this.angle();
    const theta2 = point.angle();
    return theta2 - theta1;
  }

  // Rotate by angle (in radians)
  rotate(angle) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return new tmPoint(
      this.x * cos - this.y * sin,
      this.x * sin + this.y * cos
    );
  }

  rotateEquals(angle) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const x = this.x * cos - this.y * sin;
    const y = this.x * sin + this.y * cos;
    this.x = x;
    this.y = y;
    return this;
  }

  // Equality
  equals(point, tolerance = 1e-10) {
    return Math.abs(this.x - point.x) < tolerance &&
           Math.abs(this.y - point.y) < tolerance;
  }

  // String representation
  toString() {
    return `(${this.x.toFixed(4)}, ${this.y.toFixed(4)})`;
  }
}

// Equivalent to tmPoint.cpp's Incenter(p1,p2,p3): the triangle's incenter,
// the side-length-weighted average of its corners.
export function incenter(p1, p2, p3) {
  const a = p2.distance(p3); // side opposite p1
  const b = p1.distance(p3); // side opposite p2
  const c = p1.distance(p2); // side opposite p3
  const perimeter = a + b + c;
  return new tmPoint(
    (a * p1.x + b * p2.x + c * p3.x) / perimeter,
    (a * p1.y + b * p2.y + c * p3.y) / perimeter
  );
}

// Equivalent to tmPoint.cpp's Inradius(p1,p2,p3): the triangle's inscribed
// circle radius (area / semiperimeter).
export function inradius(p1, p2, p3) {
  const a = p2.distance(p3);
  const b = p1.distance(p3);
  const c = p1.distance(p2);
  const s = (a + b + c) / 2;
  const area = Math.abs((p2.x - p1.x) * (p3.y - p1.y) - (p3.x - p1.x) * (p2.y - p1.y)) / 2;
  return area / s;
}

// Equivalent to tmPoint.cpp's GetLineIntersection(p,rp,q,rq): the
// intersection of two parametric lines p+t*rp and q+u*rq (rp/rq are
// direction vectors, not necessarily unit or segment-bounded). Returns null
// for parallel lines rather than the original's undefined/infinite result.
export function lineIntersection(p, rp, q, rq) {
  const denom = rp.cross(rq);
  if (Math.abs(denom) < 1e-15) return null;
  const t = q.subtract(p).cross(rq) / denom;
  return p.add(rp.scale(t));
}

// Equivalent to tmPoint.cpp's AreParallel(p,q): exact-equality parallel
// test (not tolerance-based, matching the original — see tmPoly.cpp's
// inset-distance search, the only caller that needs this exactness).
export function areParallel(p, q) {
  return p.dot(q.perpendicular()) === 0;
}

// Equivalent to tmPoint.cpp's ProjectPtoQ(p1,p2,p,q1,q2,q): `p` lies on
// segment p1-p2; project it perpendicular to p1-p2, then intersect that
// perpendicular line with the (infinite) line through q1-q2. Returns the
// intersection point, or null if it falls outside segment q1-q2 (by more
// than a 0.9*DistTol() tolerance on either end).
export function projectPtoQ(p1, p2, p, q1, q2) {
  const rq = q2.subtract(q1);
  const dq = rq.magnitude();
  const up = p2.subtract(p1).normalize();
  const denom = up.dot(rq);
  if (Math.abs(denom) < 1e-15) return null;
  const d = (dq * up.dot(p.subtract(q1))) / denom;
  const tol = 0.9e-4;
  if (!(d > -tol && d < dq + tol)) return null;
  return q1.add(rq.normalize().scale(d));
}

// Equivalent to tmPoint.cpp's ProjectQtoP(q,p1,p2,p): the perpendicular
// foot of `q` onto line p1-p2. Returns null if the foot falls outside
// segment p1-p2 (same 0.9*DistTol() tolerance as above).
export function projectQtoP(q, p1, p2) {
  const rp = p2.subtract(p1);
  const up = rp.normalize();
  const d = up.dot(q.subtract(p1));
  const dp = up.dot(rp);
  const tol = 0.9e-4;
  if (!(d > -tol && d < dp + tol)) return null;
  return p1.add(up.scale(d));
}

// Equivalent to tmPoint.cpp's GetLineIntersectionParms(p,rp,q,rq,tp,tq):
// the parametric positions tp/tq at which the infinite lines p+tp*rp and
// q+tq*rq meet. Returns null for parallel lines (in place of the
// original's bool return value).
export function lineIntersectionParams(p, rp, q, rq) {
  const denom = rp.cross(rq);
  if (Math.abs(denom) < 1e-15) return null;
  const diff = q.subtract(p);
  return { tp: diff.cross(rq) / denom, tq: diff.cross(rp) / denom };
}

// Equivalent to tmPoint.cpp's Orientation2D(p1,p2,p3): positive if p1, p2,
// p3 are ordered counterclockwise, negative if clockwise, zero if
// collinear.
export function orientation2D(p1, p2, p3) {
  return p1.subtract(p3).cross(p2.subtract(p3));
}

// Equivalent to tmPoint.cpp's AreCCW()/AreCW(): both false for collinear
// points.
export function areCCW(p1, p2, p3) {
  return orientation2D(p1, p2, p3) > 0;
}

export function areCW(p1, p2, p3) {
  return orientation2D(p1, p2, p3) < 0;
}

// Constants
export const PI = Math.PI;
export const TWO_PI = 2 * Math.PI;
export const RADIAN = 180 / Math.PI;
export const DEGREES = Math.PI / 180;

// Utility functions
export function minVal(a, b) {
  return a < b ? a : b;
}

export function maxVal(a, b) {
  return a > b ? a : b;
}

// This app's canvas/tree coordinate frame has Y=0 at the TOP increasing
// downward (plain screen/canvas coordinates), a mirror image of the
// original TreeMaker's (Y=0 at the BOTTOM increasing upward — see
// tmwxDesignCanvas.cpp's TreeToDC, and Tmd5Format.js's matching flipY() for
// point coordinates). An angle measured the "natural" way (counterclockwise
// from the x-axis, as help/windows.htm's Tree Panel describes the Symmetry
// X/Y/Angle fields) flips sign under that Y mirror, same as a direction
// vector's Y component would. Used wherever an angle crosses that boundary:
// reading/writing the symmetry angle from a .tmd5 file (Tmd5Format.js), and
// the equivalent boundary for a human typing degrees into the UI — the
// Symmetry Lines presets and the Angle field (main.js) — versus
// tree.symAngle/getSymDir()'s internal Y-down convention, which every
// symmetry condition (e.g. ConditionNodeSymmetric) already solves against
// directly and must stay untouched.
export function flipAngleDegrees(angle) {
  return ((-angle % 360) + 360) % 360;
}
