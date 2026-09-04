export function buildStrainPathConstraint(tree, path, variables = []) {
  const nodes = path?.getNodes?.() || [];
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (!first || !last) return null;

  const scale = Math.max(tree?.getScale?.() || 1, 1e-12);
  const firstMovable = variables.some(variable => variable.node === first && variable.axis);
  const lastMovable = variables.some(variable => variable.node === last && variable.axis);
  const mode = firstMovable && lastMovable ? 'MultiStrainPathFn1' : (firstMovable || lastMovable ? 'MultiStrainPathFn2' : 'MultiStrainPathFn3');
  const variableEdges = [];
  let fixedLength = 0;

  for (let index = 0; index < nodes.length - 1; index += 1) {
    const edge = tree.getEdge(nodes[index], nodes[index + 1]);
    if (!edge) continue;
    const baseLength = edge.getLength() * scale;
    const variable = variables.find(item => item.edge === edge);
    if (variable) variableEdges.push({ edge, baseLength, variable });
    else fixedLength += edge.getStrainedLength() * scale;
  }

  return {
    mode,
    first,
    last,
    firstMovable,
    lastMovable,
    fixedLength,
    variableEdges,
    evaluate() {
      let available = fixedLength;
      for (const item of variableEdges) available += item.baseLength * (1 + item.edge.getStrain());
      const firstLocation = first.getLoc();
      const lastLocation = last.getLoc();
      return available - Math.hypot(lastLocation.x - firstLocation.x, lastLocation.y - firstLocation.y);
    },
    gradient() {
      const row = Array(variables.length).fill(0);
      const firstLocation = first.getLoc();
      const lastLocation = last.getLoc();
      const dx = lastLocation.x - firstLocation.x;
      const dy = lastLocation.y - firstLocation.y;
      const distance = Math.max(Math.hypot(dx, dy), 1e-12);
      const firstX = variables.findIndex(variable => variable.node === first && variable.axis === 'x');
      const firstY = variables.findIndex(variable => variable.node === first && variable.axis === 'y');
      const lastX = variables.findIndex(variable => variable.node === last && variable.axis === 'x');
      const lastY = variables.findIndex(variable => variable.node === last && variable.axis === 'y');
      if (firstX >= 0) row[firstX] = dx / distance;
      if (firstY >= 0) row[firstY] = dy / distance;
      if (lastX >= 0) row[lastX] = -dx / distance;
      if (lastY >= 0) row[lastY] = -dy / distance;
      for (const item of variableEdges) {
        const index = variables.indexOf(item.variable);
        if (index >= 0) row[index] = item.baseLength;
      }
      return row;
    }
  };
}
