/**
 * rfPaper.js
 * A rectangle (rfRect, equivalent to XYRect) and the paper itself (rfPaper,
 * equivalent to Paper : public XYRect) from
 * original/ReferenceFinder/source/model/ReferenceFinder.h.
 */

import { rfPoint, midPoint } from './rfPoint.js';
import { rfLine } from './rfLine.js';

const RF_EPS = 1.0e-8;

// XYRect: a rectangle by its bottom-left and top-right corners.
export class rfRect {
  constructor(bl, tr) {
    this.bl = bl.clone();
    this.tr = (tr ?? bl).clone();
  }

  clone() {
    return new rfRect(this.bl, this.tr);
  }

  // GetWidth()
  getWidth() {
    return this.tr.x - this.bl.x;
  }

  // GetHeight()
  getHeight() {
    return this.tr.y - this.bl.y;
  }

  // GetAspectRatio(): negative if the rectangle is improperly defined.
  getAspectRatio() {
    const wd = this.getWidth();
    const ht = this.getHeight();
    if (Math.abs(wd) < RF_EPS && Math.abs(ht) < RF_EPS) return 0;
    if (Math.abs(wd) <= Math.abs(ht)) return wd / ht;
    return ht / wd;
  }

  // IsValid(): true if bl is below and to the left of tr.
  isValid() {
    return this.bl.x <= this.tr.x && this.bl.y <= this.tr.y;
  }

  // IsEmpty(): true if the rectangle is a line or a point.
  isEmpty() {
    return Math.abs(this.bl.x - this.tr.x) < RF_EPS || Math.abs(this.bl.y - this.tr.y) < RF_EPS;
  }

  // Encloses(ap): true if pt falls within this rectangle, padded by RF_EPS.
  encloses(point) {
    return (
      point.x >= this.bl.x - RF_EPS && point.x <= this.tr.x + RF_EPS &&
      point.y >= this.bl.y - RF_EPS && point.y <= this.tr.y + RF_EPS
    );
  }

  // Encloses(ap1, ap2): true if both points fall within the rectangle.
  enclosesBoth(p1, p2) {
    return this.encloses(p1) && this.encloses(p2);
  }

  // Include(p): returns a new rect stretched to enclose p (the original
  // mutates in place and returns *this for chaining; this port follows
  // rfPoint.js's immutable-return convention instead).
  include(point) {
    return new rfRect(
      new rfPoint(Math.min(this.bl.x, point.x), Math.min(this.bl.y, point.y)),
      new rfPoint(Math.max(this.tr.x, point.x), Math.max(this.tr.y, point.y))
    );
  }
}

// GetBoundingBox(p1, p2[, p3])
export function getBoundingBox(p1, p2, p3) {
  let rect = new rfRect(p1, p1).include(p2);
  if (p3) rect = rect.include(p3);
  return rect;
}

// Paper : public XYRect.
export class rfPaper extends rfRect {
  constructor(width, height) {
    super(new rfPoint(0, 0), new rfPoint(width, height));
    this.setSize(width, height);
  }

  // SetSize(aWidth, aHeight): recomputes the paper's corners, edges, and
  // diagonals, same as the original's Paper::SetSize().
  setSize(width, height) {
    this.bl = new rfPoint(0, 0);
    this.tr = new rfPoint(width, height);
    this.width = width;
    this.height = height;
    this.botLeft = new rfPoint(0, 0);
    this.botRight = new rfPoint(width, 0);
    this.topLeft = new rfPoint(0, height);
    this.topRight = new rfPoint(width, height);
    this.topEdge = rfLine.throughPoints(this.topLeft, this.topRight);
    this.leftEdge = rfLine.throughPoints(this.botLeft, this.topLeft);
    this.rightEdge = rfLine.throughPoints(this.botRight, this.topRight);
    this.bottomEdge = rfLine.throughPoints(this.botLeft, this.botRight);
    this.upwardDiagonal = rfLine.throughPoints(this.botLeft, this.topRight);
    this.downwardDiagonal = rfLine.throughPoints(this.topLeft, this.botRight);
  }

  /**
   * ClipLine(al, ap1, ap2): clips line `line` to the paper. Returns
   * `{ p1, p2 }`, or null if the line misses the paper entirely (the
   * original returns bool and writes into out-params; this port returns
   * null instead, matching this project's convention elsewhere).
   *
   * Faithfully preserves the original's tmin/tmax naming, even though the
   * names are swapped from what they compute: the "if (tmin < tt) tmin = tt"
   * update actually grows tmin to the running MAXIMUM parameter seen (and
   * tmax shrinks to the running MINIMUM) — a naming quirk in the original,
   * not a bug, since ap1/ap2 just become the two clipped endpoints in
   * whichever order this produces (irrelevant to every caller).
   */
  clipLine(line) {
    const candidates = [this.topEdge, this.leftEdge, this.rightEdge, this.bottomEdge];
    const ipts = [];
    for (const edge of candidates) {
      const p = edge.intersectLine(line);
      if (p && this.encloses(p)) ipts.push(p);
    }
    if (ipts.length === 0) return null;

    const pt = line.u.scale(line.d);
    const up = line.u.rotate90();
    let tmin = ipts[0].subtract(pt).dot(up);
    let tmax = tmin;
    for (let i = 1; i < ipts.length; i += 1) {
      const tt = ipts[i].subtract(pt).dot(up);
      if (tmin < tt) tmin = tt;
      if (tmax > tt) tmax = tt;
    }

    return {
      p1: pt.add(up.scale(tmin)),
      p2: pt.add(up.scale(tmax))
    };
  }

  // InteriorOverlaps(al): true if line al overlaps the paper's interior
  // (false if it misses entirely, only hits a corner, or runs along an edge).
  interiorOverlaps(line) {
    const clipped = this.clipLine(line);
    if (!clipped) return false;
    const { p1, p2 } = clipped;
    if (p1.subtract(p2).mag() < RF_EPS) return false;
    if (!getBoundingBox(p1, p2).isEmpty()) return true;

    const mp = midPoint(p1, p2);
    if (
      this.topEdge.containsPoint(mp) || this.bottomEdge.containsPoint(mp) ||
      this.leftEdge.containsPoint(mp) || this.rightEdge.containsPoint(mp)
    ) return false;
    return true;
  }

  /**
   * MakesSkinnyFlap(al): true if folding along `line` creates a triangular
   * (or quad) flap whose aspect ratio falls below `minAspectRatio`.
   *
   * The original reads this threshold from `ReferenceFinder::sMinAspectRatio`
   * (a static engine setting); this port takes it as a parameter instead, so
   * rfPaper.js has no dependency on rfEngine.js (see
   * REFERENCEFINDER_PLAN.md section 2 — the same kind of decoupling used
   * throughout this project to keep the module graph acyclic).
   *
   * Faithfully preserves an original quirk: despite the comment "we'll
   * return true for any failures along the way", the C++ never actually
   * checks ClipLine()'s bool return here — it just keeps using p1/p2 (or
   * bp1/bp2), which stay at their default-constructed XYPt(0,0) when
   * clipping fails. Ported literally (null clip → (0,0),(0,0)) rather than
   * "fixed" to the behavior the comment describes, since MakesSkinnyFlap is
   * only ever called on lines already known to cross the paper.
   */
  makesSkinnyFlap(line, minAspectRatio) {
    const zero = () => new rfPoint(0, 0);
    const clipped = this.clipLine(line);
    const { p1, p2 } = clipped ?? { p1: zero(), p2: zero() };

    const bisector = new rfLine(0, line.u.rotate90());
    bisector.d = midPoint(p1, p2).dot(bisector.u);
    const clippedBisector = this.clipLine(bisector);
    const { p1: bp1, p2: bp2 } = clippedBisector ?? { p1: zero(), p2: zero() };

    if (Math.abs(getBoundingBox(p1, p2, bp1).getAspectRatio()) < minAspectRatio) return true;
    if (Math.abs(getBoundingBox(p1, p2, bp2).getAspectRatio()) < minAspectRatio) return true;
    return false;
  }
}
