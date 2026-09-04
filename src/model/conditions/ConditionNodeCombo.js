/**
 * ConditionNodeCombo.js
 * Ports tmConditionNodeCombo (tag "CNxn"): the real class behind every
 * "Node(s) Fixed to Symmetry Line / Paper Edge / Corner / Position..."
 * command in TreeMaker v5 (tmwxDoc_Condition.cpp). It is NOT a wrapper
 * around the separate v4 classes (ConditionNodeFixed/OnEdge/OnCorner/
 * Symmetric, only reachable in the original under TMDEBUG) — it is a
 * single flat condition on one leaf node with five independent flags that
 * combine freely: toSymmetryLine, toPaperEdge, toPaperCorner, xFixed(+value),
 * yFixed(+value) (tmConditionNodeCombo.h/.cpp).
 *
 * Crucially, "Paper Edge" and "Paper Corner" have no edge/corner picker and
 * no position parameter — the real tooltips say "fixing the node to ANY
 * edge/corner of the paper". The math (tmConstraintFns.cpp) reflects that:
 * StickToEdgeFn is the single equation x(x-w)y(y-h)=0 (true on any of the
 * 4 edges, node free to slide along it), and CornerFn is two independent
 * equations x(x-w)=0 and y(y-h)=0 (each true at either paper boundary,
 * together satisfied at any of the 4 corners).
 */

import { tmCondition } from '../tmCondition.js';

const STICK_TO_EDGE_WEIGHT = 10.0;

export class ConditionNodeCombo extends tmCondition {
  /**
   * @param {tmTree} tree - The tree
   * @param {tmNode} node - The (leaf) node this condition applies to
   * @param {boolean} toSymmetryLine
   * @param {boolean} toPaperEdge
   * @param {boolean} toPaperCorner
   * @param {boolean} xFixed
   * @param {number} xFixValue
   * @param {boolean} yFixed
   * @param {number} yFixValue
   */
  constructor(tree, node = null, toSymmetryLine = false, toPaperEdge = false,
    toPaperCorner = false, xFixed = false, xFixValue = 0, yFixed = false,
    yFixValue = 0) {
    super(tree);
    this.node = node;
    this.toSymmetryLine = toSymmetryLine;
    this.toPaperEdge = toPaperEdge;
    this.toPaperCorner = toPaperCorner;
    this.xFixed = xFixed;
    this.xFixValue = xFixValue;
    this.yFixed = yFixed;
    this.yFixValue = yFixValue;

    this.calcFeasibility();
  }

  isNodeCondition() { return true; }
  isEdgeCondition() { return false; }
  isPathCondition() { return false; }

  getNode() { return this.node; }
  getToSymmetryLine() { return this.toSymmetryLine; }
  getToPaperEdge() { return this.toPaperEdge; }
  getToPaperCorner() { return this.toPaperCorner; }
  getXFixed() { return this.xFixed; }
  getXFixValue() { return this.xFixValue; }
  getYFixed() { return this.yFixed; }
  getYFixValue() { return this.yFixValue; }

  setNode(node) {
    this.node = node;
    this.calcFeasibility();
  }

  setToSymmetryLine(value) {
    this.toSymmetryLine = value;
    this.calcFeasibility();
  }

  setToPaperEdge(value) {
    this.toPaperEdge = value;
    this.calcFeasibility();
  }

  setToPaperCorner(value) {
    this.toPaperCorner = value;
    this.calcFeasibility();
  }

  setXFixed(value) {
    this.xFixed = value;
    this.calcFeasibility();
  }

  setXFixValue(value) {
    this.xFixValue = value;
    this.calcFeasibility();
  }

  setYFixed(value) {
    this.yFixed = value;
    this.calcFeasibility();
  }

  setYFixValue(value) {
    this.yFixValue = value;
    this.calcFeasibility();
  }

  /** Any flag active, i.e. this condition actually constrains something. */
  isEmpty() {
    return !this.toSymmetryLine && !this.toPaperEdge && !this.toPaperCorner &&
      !this.xFixed && !this.yFixed;
  }

  uses(part) {
    return this.node === part;
  }

  // tmConditionNodeCombo::IsValidCondition(): node must exist and be a leaf
  // — reads the maintained `isLeafNode` flag (tree.refreshNodeClassification()),
  // not raw degree, since the original's own IsValidCondition() calls
  // IsLeafNode() the same way. That flag also covers the special case of a
  // brand-new tree's lone, still-edgeless node (degree 0 but still a
  // "leaf" — see tmTree::AddNode()'s `newNode->mIsLeafNode = true`),
  // which a plain `getDegree() === 1` check would wrongly reject.
  isValidCondition() {
    if (!this.node) return false;
    if (!this.tree.getNodes().includes(this.node)) return false;
    return this.node.isLeafNode;
  }

  // tmConditionNodeCombo::CalcFeasibility(): same formulas as
  // AddConstraints below, each checked to be (numerically) zero.
  calcFeasibility() {
    if (!this.isValidCondition()) {
      this.isFeasible = false;
      return;
    }

    const tolerance = 1e-6;
    const loc = this.node.getLoc();
    const w = this.tree.getPaperWidth();
    const h = this.tree.getPaperHeight();

    if (this.tree.hasSymmetryLine?.() && this.toSymmetryLine) {
      const center = this.tree.getSymLoc();
      const direction = this.tree.getSymDir();
      const distance = (loc.x - center.x) * direction.y - (loc.y - center.y) * direction.x;
      if (Math.abs(distance) > tolerance) {
        this.isFeasible = false;
        return;
      }
    }

    if (this.toPaperEdge) {
      const value = loc.x * (loc.x - w) * loc.y * (loc.y - h);
      if (Math.abs(value) > tolerance) {
        this.isFeasible = false;
        return;
      }
    }

    if (this.toPaperCorner) {
      if (Math.abs(loc.x * (loc.x - w)) > tolerance ||
        Math.abs(loc.y * (loc.y - h)) > tolerance) {
        this.isFeasible = false;
        return;
      }
    }

    if (this.xFixed && Math.abs(loc.x - this.xFixValue) > tolerance) {
      this.isFeasible = false;
      return;
    }

    if (this.yFixed && Math.abs(loc.y - this.yFixValue) > tolerance) {
      this.isFeasible = false;
      return;
    }

    this.isFeasible = true;
  }

  /**
   * Direct-projection fallback for the legacy iterative solve path (see
   * NewtonRaphson._applyConstraint / tmTree.solveWithConstraints, both
   * otherwise superseded by the residual-based joint solvers driven by
   * ConstraintResiduals.js/ConstraintJacobians.js). Snaps the node onto
   * whichever edge/corner is nearest, then applies fixed X/Y on top.
   */
  addConstraints(optimizer) {
    if (!this.isValidCondition()) return;

    if (this.tree.hasSymmetryLine?.() && this.toSymmetryLine) {
      const center = this.tree.getSymLoc();
      const direction = this.tree.getSymDir();
      const loc = this.node.getLoc();
      const along = (loc.x - center.x) * direction.x + (loc.y - center.y) * direction.y;
      optimizer.addXPositionConstraint(this.node, center.x + along * direction.x);
      optimizer.addYPositionConstraint(this.node, center.y + along * direction.y);
    }

    if (this.toPaperEdge) {
      const target = this._nearestEdgePoint();
      optimizer.addXPositionConstraint(this.node, target.x);
      optimizer.addYPositionConstraint(this.node, target.y);
    }

    if (this.toPaperCorner) {
      const target = this._nearestCornerPoint();
      optimizer.addXPositionConstraint(this.node, target.x);
      optimizer.addYPositionConstraint(this.node, target.y);
    }

    if (this.xFixed) {
      optimizer.addXPositionConstraint(this.node, this.xFixValue);
    }

    if (this.yFixed) {
      optimizer.addYPositionConstraint(this.node, this.yFixValue);
    }
  }

  /** Nearest point on any of the 4 paper edges, used by the projection fallback. */
  _nearestEdgePoint() {
    const w = this.tree.getPaperWidth();
    const h = this.tree.getPaperHeight();
    const loc = this.node.getLoc();
    const candidates = [
      { x: 0, y: loc.y, distance: loc.x },
      { x: w, y: loc.y, distance: Math.abs(w - loc.x) },
      { x: loc.x, y: 0, distance: loc.y },
      { x: loc.x, y: h, distance: Math.abs(h - loc.y) }
    ];
    return candidates.sort((a, b) => a.distance - b.distance)[0];
  }

  /** Nearest of the 4 paper corners, used by the projection fallback. */
  _nearestCornerPoint() {
    const w = this.tree.getPaperWidth();
    const h = this.tree.getPaperHeight();
    const loc = this.node.getLoc();
    const corners = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: 0, y: h }, { x: w, y: h }];
    return corners.sort((a, b) => (
      Math.hypot(a.x - loc.x, a.y - loc.y) - Math.hypot(b.x - loc.x, b.y - loc.y)
    ))[0];
  }

  toString() {
    const parts = [];
    if (this.toSymmetryLine) parts.push('symmetry line');
    if (this.toPaperEdge) parts.push('paper edge');
    if (this.toPaperCorner) parts.push('paper corner');
    if (this.xFixed) parts.push(`X=${this.xFixValue.toFixed(3)}`);
    if (this.yFixed) parts.push(`Y=${this.yFixValue.toFixed(3)}`);
    return `Fix Node ${this.node?.label}: ${parts.join(', ')}`;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      nodeLabel: this.node?.label,
      toSymmetryLine: this.toSymmetryLine,
      toPaperEdge: this.toPaperEdge,
      toPaperCorner: this.toPaperCorner,
      xFixed: this.xFixed,
      xFixValue: this.xFixValue,
      yFixed: this.yFixed,
      yFixValue: this.yFixValue
    };
  }
}
