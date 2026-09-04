import { Matrix } from './Matrix.js';

export class StubInfo {
  constructor(edge = null, length = 0, edgeLocation = 0, location = null, activeNodes = []) {
    this.edge = edge;
    this.length = Number(length);
    this.edgeLocation = Number(edgeLocation);
    this.location = location ? { x: Number(location.x), y: Number(location.y) } : { x: 0, y: 0 };
    this.activeNodes = [...activeNodes];
  }

  isBlank() {
    return !this.edge;
  }

  getActiveNodeIds() {
    return this.activeNodes.map(node => node.id).sort();
  }

  equals(other) {
    if (!other || this.activeNodes.length !== other.activeNodes.length) return false;
    const first = this.getActiveNodeIds();
    const second = other.getActiveNodeIds();
    return first.every((id, index) => id === second[index]);
  }
}

export class StubFinder {
  constructor(tree, options = {}) {
    this.tree = tree;
    this.tolerance = options.tolerance ?? 1e-6;
    this.minStubLength = options.minStubLength ?? 1e-8;
  }

  findCandidateNodes(predicate = () => true) {
    if (!this.tree || !this.tree.getNodes) return [];
    return this.tree.getNodes().filter(node => node && predicate(node));
  }

  findFixedNodes() {
    const fixed = new Set(this.findCandidateNodes(node => node.isPinnedNode));
    for (const condition of this.tree?.getConditions?.() || []) {
      const node = condition?.getNode?.();
      if (node && (condition.getXFixed?.() || condition.getYFixed?.())) fixed.add(node);
    }
    return [...fixed];
  }

  findSymmetryPairs(center = null, angle = null) {
    if (!this.tree || !this.tree.getNodes) return [];
    const nodes = this.tree.getNodes();
    const symmetryCenter = center || this.tree.getSymLoc?.() || { x: 0, y: 0 };
    const symmetryAngle = angle ?? this.tree.getSymAngle?.() ?? 0;
    const radians = symmetryAngle * Math.PI / 180;
    const dirX = Math.cos(radians);
    const dirY = Math.sin(radians);
    const pairs = [];

    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      if (!node) continue;
      const x = node.getLocX() - symmetryCenter.x;
      const y = node.getLocY() - symmetryCenter.y;
      const normal = x * (-dirY) + y * dirX;
      const reflected = {
        x: symmetryCenter.x + x - 2 * normal * (-dirY),
        y: symmetryCenter.y + y - 2 * normal * dirX
      };
      const partner = this.findNearestNode(reflected, this.tolerance, nodes.slice(i + 1));
      if (partner) pairs.push([node, partner]);
    }

    return pairs;
  }

  findCollinearTriplets() {
    if (!this.tree || !this.tree.getNodes) return [];
    const nodes = this.tree.getNodes();
    const triplets = [];

    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        for (let k = j + 1; k < nodes.length; k += 1) {
          const a = nodes[i];
          const b = nodes[j];
          const c = nodes[k];
          if (!a || !b || !c) continue;
          const cross = (b.getLocX() - a.getLocX()) * (c.getLocY() - a.getLocY()) -
            (b.getLocY() - a.getLocY()) * (c.getLocX() - a.getLocX());
          if (Math.abs(cross) < 1e-6) {
            triplets.push([a, b, c]);
          }
        }
      }
    }

    return triplets;
  }

  findNearestNode(point, limit = Infinity, candidates = null) {
    if (!this.tree || !this.tree.getNodes) return null;
    let nearest = null;
    let bestDistance = limit;

    for (const node of candidates || this.tree.getNodes()) {
      if (!node) continue;
      const dx = node.getLocX() - point.x;
      const dy = node.getLocY() - point.y;
      const d = Math.hypot(dx, dy);
      if (d < bestDistance) {
        bestDistance = d;
        nearest = node;
      }
    }

    return nearest;
  }

  findAdjacencyCandidates(node) {
    return node?.getAdjacentNodes ? node.getAdjacentNodes() : [];
  }

  findLeafNodes(nodes = null) {
    const candidates = nodes || this.tree?.getNodes?.() || [];
    return candidates.filter(node => node && (node.getDegree?.() === 1 || node.isLeafNode));
  }

  findAllStubs(nodes = null) {
    const leaves = this.findLeafNodes(nodes);
    if (leaves.length < 4) return [];

    const stubs = [];
    const edges = this.tree?.getSpanningEdges?.(leaves) || this.tree?.getEdges?.() || [];
    const allLeafNodes = this.findLeafNodes();
    for (let i = 0; i < leaves.length; i += 1) {
      for (let j = i + 1; j < leaves.length; j += 1) {
        for (let k = j + 1; k < leaves.length; k += 1) {
          for (let l = k + 1; l < leaves.length; l += 1) {
            const group = [leaves[i], leaves[j], leaves[k], leaves[l]];
            for (const edge of edges) {
              const solved = this._solveStubEquations(group, edge);
              if (!solved) continue;
              const { location, length, edgeLocation } = solved;
              const activeNodes = this._collectActiveNodes(location, length, allLeafNodes, edge, edgeLocation);
              if (!this._isValidStub(edge, edgeLocation, length, location, activeNodes)) continue;
              const candidate = new StubInfo(edge, length, edgeLocation, location, activeNodes);
              if (!stubs.some(stub => stub.equals(candidate))) stubs.push(candidate);
            }
          }
        }
      }
    }

    return stubs.sort((a, b) => b.length - a.length);
  }

  findLargestStub(nodes = null) {
    return this.findAllStubs(nodes)[0] || new StubInfo();
  }

  addStubToTree(stub) {
    if (!stub || stub.isBlank() || !this.tree?.splitEdge) return null;
    const scale = Math.max(this.tree.getScale?.() || 1, 1e-12);
    const splitLocation = stub.edge.getLength?.() > 0 ? stub.edgeLocation : stub.edgeLocation * scale;
    const splitNode = this.tree.splitEdge(stub.edge, splitLocation, true);
    const location = { x: stub.location.x, y: stub.location.y };
    const stubResult = this.tree.addNode(splitNode, location);
    stubResult.edge.setLength(stub.length);
    return { ...stubResult, splitNode };
  }

  /**
   * Equivalent to tmStubFinder::TestOneCombo()'s Newton-Raphson solve: find
   * a stub (length, split location along `edge`, paper location) such that
   * the paper distance from the stub to each of the 4 `nodes` equals the
   * tree-distance from the stub through the (possibly split) edge, scaled
   * to paper units. Initial guess matches the original exactly — a short
   * (0.1 tree-unit) stub at the edge's midpoint, located at the mean of the
   * four nodes — since that guess (not a circle fit) is what the original's
   * equations are actually posed around. Uses a damped/backtracking Newton
   * step (the original takes plain, undamped steps) for robustness; this
   * only changes how a root is found, not which candidates ultimately pass
   * the unchanged validity/feasibility checks below.
   */
  _solveStubEquations(nodes, edge) {
    if (!Array.isArray(nodes) || nodes.length !== 4 || !edge) return null;
    const scale = Math.max(this.tree.getScale?.() || 1, 1e-12);
    const equationData = this.getStubEquationData(nodes, edge);
    if (!equationData) return null;
    const { edgeLength, rows } = equationData;
    if (edgeLength <= this.minStubLength) return null;

    // If all four nodes lie on the same side of the split edge, the
    // problem is ill-posed (tmStubFinder::TestOneCombo).
    const signs = new Set(rows.map(row => row.sign));
    if (signs.size < 2) return null;

    const parameters = [
      0.1,
      edgeLength / 2,
      rows.reduce((sum, row) => sum + row.x, 0) / rows.length,
      rows.reduce((sum, row) => sum + row.y, 0) / rows.length
    ];

    const residuals = values => rows.map(row => {
      const distance = Math.hypot(values[2] - row.x, values[3] - row.y);
      return distance - scale * (values[0] + row.sign * values[1] + row.distance);
    });
    const tolf = 1e-8;
    for (let iteration = 0; iteration < 20; iteration += 1) {
      const current = residuals(parameters);
      if (current.reduce((sum, value) => sum + Math.abs(value), 0) <= tolf) break;
      const jacobian = Array.from({ length: 4 }, () => []);
      for (let variable = 0; variable < 4; variable += 1) {
        const delta = 1e-7;
        const forwardValues = [...parameters];
        const backwardValues = [...parameters];
        forwardValues[variable] += delta;
        backwardValues[variable] -= delta;
        const forward = residuals(forwardValues);
        const backward = residuals(backwardValues);
        for (let row = 0; row < 4; row += 1) jacobian[row].push((forward[row] - backward[row]) / (2 * delta));
      }
      const matrix = new Matrix(4, 4, jacobian);
      const correction = matrix.solveLinearSystem(current.map(value => -value)) || matrix.solveLeastSquares(current.map(value => -value));
      if (!correction) return null;
      const previousNorm = Math.hypot(...current);
      let accepted = false;
      let step = 1;
      for (let trial = 0; trial < 12; trial += 1) {
        const candidate = parameters.map((value, index) => value + correction[index] * step);
        const candidateNorm = Math.hypot(...residuals(candidate));
        if (candidateNorm < previousNorm) {
          parameters.splice(0, parameters.length, ...candidate);
          accepted = true;
          break;
        }
        step *= 0.5;
      }
      if (!accepted) return null;
    }
    const [length, edgeLocation] = parameters;
    if (!Number.isFinite(length) || !Number.isFinite(edgeLocation) || length <= this.minStubLength || edgeLocation <= 0 || edgeLocation >= edgeLength) return null;
    return { length, edgeLocation, location: { x: parameters[2], y: parameters[3] } };
  }

  getStubEquationData(nodes, edge) {
    if (!Array.isArray(nodes) || nodes.length !== 4 || !edge) return null;
    const [first] = edge.getNodes?.() || [];
    if (!first) return null;
    const scale = Math.max(this.tree.getScale?.() || 1, 1e-12);
    const rows = nodes.map(node => {
      if (node === first) return { x: node.getLocX(), y: node.getLocY(), distance: 0, sign: 1 };
      const path = this.tree.getPath(first, node);
      if (!path) return null;
      const containsEdge = path.nodes.some((pathNode, index) => index < path.nodes.length - 1 && this.tree.getEdge(pathNode, path.nodes[index + 1]) === edge);
      return {
        x: node.getLocX(),
        y: node.getLocY(),
        distance: path.getMinTreeLength(),
        sign: containsEdge ? -1 : 1
      };
    });
    if (rows.some(row => !row)) return null;
    const edgeLength = edge.getEffectiveTreeLength?.(scale)
      ?? (edge.getLength?.() || (edge.getGeometricLength?.() || 0) / scale);
    return { scale, edgeLength, rows };
  }

  _collectActiveNodes(location, length, candidates, edge, edgeLocation) {
    const scale = Math.max(this.tree.getScale?.() || 1, 1e-12);
    return candidates.filter(node => {
      const actual = Math.hypot(node.getLocX() - location.x, node.getLocY() - location.y) / scale;
      const minimum = this._minimumPathDistance(edge, edgeLocation, node, length);
      return minimum !== null && Math.abs(actual - minimum) <= this.tolerance;
    }).sort((first, second) => String(first.id).localeCompare(String(second.id)));
  }

  _isValidStub(edge, edgeLocation, length, location, activeNodes) {
    if (!edge || !Number.isFinite(edgeLocation) || !Number.isFinite(length)) return false;
    if (length <= this.minStubLength || activeNodes.length < 4) return false;
    if (location.x < -this.tolerance || location.x > this.tree.getPaperWidth() + this.tolerance) return false;
    if (location.y < -this.tolerance || location.y > this.tree.getPaperHeight() + this.tolerance) return false;

    const [first, second] = edge.getNodes?.() || [];
    if (!first || !second) return false;
    const geometricLength = Math.hypot(second.getLocX() - first.getLocX(), second.getLocY() - first.getLocY());
    const scale = Math.max(this.tree.getScale?.() || 1, 1e-12);
    const strained = edge.getStrainedLength?.();
    const permittedLength = Number.isFinite(strained) && strained >= 0
      ? strained
      : (edge.getLength?.() > 0 ? edge.getLength() : geometricLength / scale);
    if (geometricLength <= this.tolerance || edgeLocation <= this.tolerance || edgeLocation >= permittedLength - this.tolerance) return false;

    for (const leaf of this.findLeafNodes()) {
      const minimum = this._minimumPathDistance(edge, edgeLocation, leaf, length);
      if (minimum === null) continue;
      const actual = Math.hypot(leaf.getLocX() - location.x, leaf.getLocY() - location.y) / Math.max(this.tree.getScale?.() || 1, 1e-12);
      if (actual + this.tolerance < minimum) return false;
    }
    return true;
  }

  _minimumPathDistance(edge, edgeLocation, target, stubLength) {
    const [first, second] = edge.getNodes?.() || [];
    if (!first || !second || !target) return null;
    if (target === first) return stubLength + edgeLocation;
    const path = this.tree.getPath?.(first, target);
    const minimum = this._pathMinimum(path);
    if (minimum === null) return null;
    const containsEdge = path.nodes.some((pathNode, index) => (
      index < path.nodes.length - 1 && this.tree.getEdge(pathNode, path.nodes[index + 1]) === edge
    ));
    return stubLength + minimum + (containsEdge ? -edgeLocation : edgeLocation);
  }

  _pathMinimum(path) {
    if (!path) return null;
    const value = path.minLength ?? path.minTreeLength ?? path.getMinTreeLength?.();
    return Number.isFinite(Number(value)) ? Number(value) : null;
  }
}
