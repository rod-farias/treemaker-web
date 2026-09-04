function angleDifference(first, second) {
  let difference = first - second;
  while (difference > Math.PI) difference -= 2 * Math.PI;
  while (difference < -Math.PI) difference += 2 * Math.PI;
  return difference;
}

function pathAngle(path) {
  const nodes = path?.getNodes?.() || [];
  if (nodes.length < 2) return 0;
  const first = nodes[0].getLoc();
  const last = nodes[nodes.length - 1].getLoc();
  return Math.atan2(last.y - first.y, last.x - first.x);
}

function pathSlack(path, tree) {
  const nodes = path?.getNodes?.() || [];
  if (nodes.length < 2) return 0;
  const scale = Math.max(tree?.getScale?.() || 1, 1e-12);
  let actual = 0;
  let minimum = 0;
  for (let index = 0; index < nodes.length - 1; index += 1) {
    const first = nodes[index];
    const second = nodes[index + 1];
    actual += first.getLoc().distance(second.getLoc()) / scale;
    const edge = tree.getEdge(first, second);
    minimum += edge?.getEffectiveTreeLength?.(scale) ?? first.getLoc().distance(second.getLoc()) / scale;
  }
  return actual - minimum;
}

export function constraintResiduals(condition, tree) {
  if (!condition) return [];

  // ConditionNodeCombo (tmConditionNodeCombo, "CNxn"): the real class
  // behind every "Node(s) Fixed to Symmetry Line / Paper Edge / Corner /
  // Position..." command — up to 5 independent residuals per its active
  // flags. Checked before the generic getXFixed/getCornerLocation branches
  // below (which exist for the legacy per-flag v4 classes) since this class
  // also exposes getXFixed()/getYFixed() but needs its own dispatch to
  // cover toSymmetryLine/toPaperEdge/toPaperCorner too.
  if (condition.constructor.name === 'ConditionNodeCombo') {
    const node = condition.getNode?.();
    if (!node) return [];
    const loc = node.getLoc();
    const w = tree?.getPaperWidth?.() ?? 0;
    const h = tree?.getPaperHeight?.() ?? 0;
    const residuals = [];
    if (tree?.hasSymmetryLine?.() && condition.getToSymmetryLine()) {
      const center = tree.getSymLoc();
      const direction = tree.getSymDir();
      residuals.push((loc.x - center.x) * direction.y - (loc.y - center.y) * direction.x);
    }
    if (condition.getToPaperEdge()) {
      residuals.push(loc.x * (loc.x - w) * loc.y * (loc.y - h));
    }
    if (condition.getToPaperCorner()) {
      residuals.push(loc.x * (loc.x - w));
      residuals.push(loc.y * (loc.y - h));
    }
    if (condition.getXFixed()) residuals.push(loc.x - condition.getXFixValue());
    if (condition.getYFixed()) residuals.push(loc.y - condition.getYFixValue());
    return residuals;
  }

  if (condition.getConditions) {
    return condition.getConditions().flatMap(item => constraintResiduals(item, tree));
  }

  if (condition.getXFixed?.() || condition.getYFixed?.()) {
    const node = condition.getNode?.();
    if (!node) return [];
    const location = node.getLoc();
    return [
      ...(condition.getXFixed() ? [location.x - condition.getXFixValue()] : []),
      ...(condition.getYFixed() ? [location.y - condition.getYFixValue()] : [])
    ];
  }

  if (condition.getCornerLocation || condition.getEdgeLocation) {
    const node = condition.getNode?.();
    const target = condition.getCornerLocation?.() || condition.getEdgeLocation?.();
    if (!node || !target) return [];
    const location = node.getLoc();
    return [location.x - target.x, location.y - target.y];
  }

  if (condition.constructor.name === 'ConditionNodeSymmetric') {
    const node = condition.getNode1?.();
    if (!node || !tree?.hasSymmetryLine?.()) return [];
    const location = node.getLoc();
    const center = tree.getSymLoc();
    const direction = tree.getSymDir();
    return [(location.x - center.x) * direction.y - (location.y - center.y) * direction.x];
  }

  if (condition.getNode1 && condition.getNode2 && condition.isNodeCondition?.()) {
    const first = condition.getNode1();
    const second = condition.getNode2();
    if (!first || !second) return [];
    const a = first.getLoc();
    const b = second.getLoc();

    if (condition.getNode3) {
      const third = condition.getNode3();
      if (!third) return [];
      const c = third.getLoc();
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const scale = Math.max(Math.hypot(dx, dy), 1e-8);
      return [(dx * (c.y - a.y) - dy * (c.x - a.x)) / scale];
    }

    // ConditionNodesPaired (tmConditionNodesPaired, "CNpn"): node1/node2
    // are mirror images of each other about the tree's symmetry line —
    // PairFn1A (segment perpendicular to the line) and PairFn1B (their
    // midpoint lies on the line), see tmConstraintFns.cpp.
    if (condition.constructor.name === 'ConditionNodesPaired') {
      if (!tree?.hasSymmetryLine?.()) return [];
      const center = tree.getSymLoc();
      const direction = tree.getSymDir();
      const perpendicular = (a.x - b.x) * direction.x + (a.y - b.y) * direction.y;
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      const onLine = (midX - center.x) * direction.y - (midY - center.y) * direction.x;
      return [perpendicular, onLine];
    }

    return [b.x - a.x, b.y - a.y];
  }

  if (condition.getEdge1 && condition.getEdge2) {
    const first = condition.getEdge1();
    const second = condition.getEdge2();
    if (!first || !second) return [];
    return [first.getStrain() - second.getStrain()];
  }

  if (condition.isEdgeCondition?.()) {
    const edge = condition.getEdge?.();
    const nodes = edge?.getNodes?.() || [];
    if (nodes.length < 2) return [];
    const length = Math.hypot(
      nodes[1].getLocX() - nodes[0].getLocX(),
      nodes[1].getLocY() - nodes[0].getLocY()
    );
    return [length - (condition.getLength?.() || 0)];
  }

  if (condition.isPathCondition?.()) {
    const path = condition.getPath?.();
    if (!path) return [];
    if (condition.getAngle) return [angleDifference(pathAngle(path), condition.getAngle())];
    if (condition.getQuantValue) {
      const quant = Math.max(1, condition.getQuantValue());
      const offset = condition.getQuantOffset();
      const period = (2 * Math.PI) / quant;
      const current = pathAngle(path);
      const target = offset + Math.round((current - offset) / period) * period;
      return [angleDifference(current, target)];
    }
    return [pathSlack(path, tree)];
  }

  return [0];
}

export { angleDifference, pathAngle, pathSlack };
