function variableIndex(variables, node, axis) {
  return variables.findIndex(variable => variable.node === node && variable.axis === axis);
}

function edgeVariableIndex(variables, edge) {
  return variables.findIndex(variable => variable.edge === edge);
}

function emptyRow(size) {
  return Array(size).fill(0);
}

export function constraintJacobians(condition, variables, tree) {
  const size = variables.length;
  if (!condition) return [];

  // ConditionNodeCombo: rows in the same order as the matching branch in
  // ConstraintResiduals.js — see the comment there for why this dispatch
  // must come before the generic getXFixed/getCornerLocation branches.
  if (condition.constructor.name === 'ConditionNodeCombo') {
    const node = condition.getNode?.();
    if (!node) return null;
    const loc = node.getLoc();
    const w = tree?.getPaperWidth?.() ?? 0;
    const h = tree?.getPaperHeight?.() ?? 0;
    const ix = variableIndex(variables, node, 'x');
    const iy = variableIndex(variables, node, 'y');
    const rows = [];
    if (tree?.hasSymmetryLine?.() && condition.getToSymmetryLine()) {
      const direction = tree.getSymDir();
      const row = emptyRow(size);
      row[ix] = direction.y;
      row[iy] = -direction.x;
      rows.push(row);
    }
    if (condition.getToPaperEdge()) {
      const row = emptyRow(size);
      row[ix] = (2 * loc.x - w) * loc.y * (loc.y - h);
      row[iy] = (2 * loc.y - h) * loc.x * (loc.x - w);
      rows.push(row);
    }
    if (condition.getToPaperCorner()) {
      const xRow = emptyRow(size);
      xRow[ix] = 2 * loc.x - w;
      rows.push(xRow);
      const yRow = emptyRow(size);
      yRow[iy] = 2 * loc.y - h;
      rows.push(yRow);
    }
    if (condition.getXFixed()) {
      const row = emptyRow(size);
      row[ix] = 1;
      rows.push(row);
    }
    if (condition.getYFixed()) {
      const row = emptyRow(size);
      row[iy] = 1;
      rows.push(row);
    }
    return rows;
  }

  if (condition.getConditions) {
    return condition.getConditions().flatMap(item => constraintJacobians(item, variables, tree) || []);
  }

  if (condition.getXFixed?.() || condition.getYFixed?.()) {
    const node = condition.getNode?.();
    if (!node) return null;
    const rows = [];
    if (condition.getXFixed()) {
      const row = emptyRow(size);
      row[variableIndex(variables, node, 'x')] = 1;
      rows.push(row);
    }
    if (condition.getYFixed()) {
      const row = emptyRow(size);
      row[variableIndex(variables, node, 'y')] = 1;
      rows.push(row);
    }
    return rows;
  }

  if (condition.getCornerLocation || condition.getEdgeLocation) {
    const node = condition.getNode?.();
    if (!node) return null;
    const xRow = emptyRow(size);
    const yRow = emptyRow(size);
    xRow[variableIndex(variables, node, 'x')] = 1;
    yRow[variableIndex(variables, node, 'y')] = 1;
    return [xRow, yRow];
  }

  if (condition.getEdge1 && condition.getEdge2) {
    const row = emptyRow(size);
    row[edgeVariableIndex(variables, condition.getEdge1())] = 1;
    row[edgeVariableIndex(variables, condition.getEdge2())] = -1;
    return [row];
  }

  if (condition.constructor.name === 'ConditionNodeSymmetric') {
    const node = condition.getNode1?.();
    if (!node || !tree?.hasSymmetryLine?.()) return null;
    const direction = tree.getSymDir();
    const row = emptyRow(size);
    row[variableIndex(variables, node, 'x')] = direction.y;
    row[variableIndex(variables, node, 'y')] = -direction.x;
    return [row];
  }

  if (condition.getNode1 && condition.getNode2 && condition.isNodeCondition?.()) {
    const first = condition.getNode1();
    const second = condition.getNode2();
    if (!first || !second) return null;

    // ConditionNodesPaired: mirror images about the tree's symmetry line
    // (see the matching branch in ConstraintResiduals.js for the math).
    if (condition.constructor.name === 'ConditionNodesPaired') {
      if (!tree?.hasSymmetryLine?.()) return null;
      const direction = tree.getSymDir();
      const perpRow = emptyRow(size);
      perpRow[variableIndex(variables, first, 'x')] = direction.x;
      perpRow[variableIndex(variables, first, 'y')] = direction.y;
      perpRow[variableIndex(variables, second, 'x')] = -direction.x;
      perpRow[variableIndex(variables, second, 'y')] = -direction.y;

      const onLineRow = emptyRow(size);
      onLineRow[variableIndex(variables, first, 'x')] = direction.y / 2;
      onLineRow[variableIndex(variables, first, 'y')] = -direction.x / 2;
      onLineRow[variableIndex(variables, second, 'x')] = direction.y / 2;
      onLineRow[variableIndex(variables, second, 'y')] = -direction.x / 2;
      return [perpRow, onLineRow];
    }

    if (!condition.getNode3) {
      const xRow = emptyRow(size);
      const yRow = emptyRow(size);
      xRow[variableIndex(variables, first, 'x')] = -1;
      xRow[variableIndex(variables, second, 'x')] = 1;
      yRow[variableIndex(variables, first, 'y')] = -1;
      yRow[variableIndex(variables, second, 'y')] = 1;
      return [xRow, yRow];
    }

    const third = condition.getNode3();
    const a = first.getLoc();
    const b = second.getLoc();
    const c = third.getLoc();
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const offsetX = c.x - a.x;
    const offsetY = c.y - a.y;
    const length = Math.max(Math.hypot(dx, dy), 1e-8);
    const cross = dx * offsetY - dy * offsetX;
    const crossDerivatives = [
      -offsetY + dy,
      -dx + offsetX,
      offsetY,
      -offsetX,
      -dy,
      dx
    ];
    const lengthDerivatives = [-dx / length, -dy / length, dx / length, dy / length, 0, 0];
    const row = emptyRow(size);
    const nodeAxes = [
      [first, 'x'], [first, 'y'], [second, 'x'], [second, 'y'], [third, 'x'], [third, 'y']
    ];
    nodeAxes.forEach(([node, axis], index) => {
      const derivative = crossDerivatives[index] / length - (cross * lengthDerivatives[index]) / (length * length);
      row[variableIndex(variables, node, axis)] = derivative;
    });
    return [row];
  }

  if (condition.isEdgeCondition?.() && condition.getEdge?.() && condition.getLength) {
    const edge = condition.getEdge();
    const [first, second] = edge.getNodes();
    const dx = second.getLocX() - first.getLocX();
    const dy = second.getLocY() - first.getLocY();
    const length = Math.max(Math.hypot(dx, dy), 1e-8);
    const row = emptyRow(size);
    row[variableIndex(variables, first, 'x')] = -dx / length;
    row[variableIndex(variables, first, 'y')] = -dy / length;
    row[variableIndex(variables, second, 'x')] = dx / length;
    row[variableIndex(variables, second, 'y')] = dy / length;
    return [row];
  }

  if (condition.isPathCondition?.() && (condition.getAngle || condition.getQuantValue)) {
    const path = condition.getPath?.();
    const nodes = path?.getNodes?.() || [];
    if (nodes.length < 2) return null;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const dx = last.getLocX() - first.getLocX();
    const dy = last.getLocY() - first.getLocY();
    const lengthSquared = Math.max(dx * dx + dy * dy, 1e-16);
    const row = emptyRow(size);
    row[variableIndex(variables, first, 'x')] = dy / lengthSquared;
    row[variableIndex(variables, first, 'y')] = -dx / lengthSquared;
    row[variableIndex(variables, last, 'x')] = -dy / lengthSquared;
    row[variableIndex(variables, last, 'y')] = dx / lengthSquared;
    return [row];
  }

  return null;
}
