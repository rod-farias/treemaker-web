import { tmTree } from '../tmTree.js';
import { tmNode } from '../tmNode.js';
import { tmEdge } from '../tmEdge.js';
import { tmPath } from '../tmPath.js';
import { tmPoint } from '../tmPoint.js';
import { ConditionNodesPaired } from '../conditions/ConditionNodesPaired.js';
import { ConditionEdgesSameStrain } from '../conditions/ConditionEdgesSameStrain.js';
import { ConditionPathActive } from '../conditions/ConditionPathActive.js';
import { ConditionNodeSymmetric } from '../conditions/ConditionNodeSymmetric.js';
import { ConditionNodeOnEdge } from '../conditions/ConditionNodeOnEdge.js';
import { ConditionNodeOnCorner } from '../conditions/ConditionNodeOnCorner.js';

class LineCursor {
  constructor(text) {
    this.lines = text.replace(/\r\n?/g, '\n').split('\n');
    this.index = 0;
  }

  next(label) {
    if (this.index >= this.lines.length) throw new Error(`Unexpected end while reading ${label}`);
    return this.lines[this.index++];
  }

  token(label) {
    return this.next(label).trim();
  }

  number(label) {
    const value = Number(this.token(label));
    if (!Number.isFinite(value)) throw new Error(`Invalid number for ${label}`);
    return value;
  }

  integer(label) {
    return Math.trunc(this.number(label));
  }

  boolean(label) {
    const value = this.token(label).toLowerCase();
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    throw new Error(`Invalid boolean for ${label}`);
  }

  skipList(label) {
    const count = this.integer(`${label} count`);
    for (let index = 0; index < count; index += 1) this.next(`${label} reference`);
  }
}

function readPoint(cursor, label) {
  return new tmPoint(cursor.number(`${label}.x`), cursor.number(`${label}.y`));
}

function readPointerList(cursor, label) {
  const count = cursor.integer(`${label} count`);
  const references = [];
  for (let index = 0; index < count; index += 1) references.push(cursor.integer(`${label} reference`));
  return references;
}

export function parseTM4(text) {
  const cursor = new LineCursor(text);
  if (cursor.token('tree tag') !== 'tree') throw new Error('Unsupported TreeMaker file: missing tree tag');
  if (cursor.token('tree version') !== '4.0') throw new Error('Only TreeMaker 4.0 fixtures are supported');

  const tree = new tmTree();
  tree.setPaperWidth(cursor.number('paper width'));
  tree.setPaperHeight(cursor.number('paper height'));
  tree.setScale(cursor.number('scale'));
  tree.setHasSymmetry(cursor.boolean('symmetry'));
  tree.setSymLoc(readPoint(cursor, 'symmetry location'));
  tree.setSymAngle(cursor.number('symmetry angle'));

  const nodeCount = cursor.integer('node count');
  const edgeCount = cursor.integer('edge count');
  const pathCount = cursor.integer('path count');
  const polyCount = cursor.integer('polygon count');
  const vertexCount = cursor.integer('vertex count');
  const creaseCount = cursor.integer('crease count');
  const conditionCount = cursor.integer('condition count');

  if (polyCount || vertexCount || creaseCount) {
    throw new Error('TM4 parser only supports fixtures without polygon crease data');
  }

  const nodes = [];
  const nodeReferences = [];
  for (let index = 0; index < nodeCount; index += 1) {
    if (cursor.token('node tag') !== 'node') throw new Error('Invalid TM4 node tag');
    const id = cursor.integer('node index');
    const label = cursor.next('node label');
    const node = new tmNode(String(id), readPoint(cursor, 'node location'));
    node.label = label;
    node.isLeafNode = cursor.boolean('node leaf');
    cursor.boolean('node subnode');
    cursor.boolean('node border');
    node.isPinnedNode = cursor.boolean('node pinned');
    cursor.boolean('node polygon');
    node.isConditionedNode = cursor.boolean('node conditioned');
    cursor.skipList('node owned vertices');
    nodeReferences.push(readPointerList(cursor, 'node edges'));
    cursor.skipList('node leaf paths');
    cursor.token('node owner');
    nodes.push(node);
    tree.nodes.push(node);
  }

  const edges = [];
  const edgeReferences = [];
  const importedPaths = [];
  for (let index = 0; index < edgeCount; index += 1) {
    const edgeTag = cursor.token('edge tag');
    if (edgeTag !== 'edge') throw new Error(`Invalid TM4 edge tag at line ${cursor.index}: ${JSON.stringify(edgeTag)}`);
    const id = cursor.integer('edge index');
    const label = cursor.next('edge label');
    const length = cursor.number('edge length');
    const strain = cursor.number('edge strain');
    const stiffness = cursor.number('edge stiffness') || 1;
    const pinned = cursor.boolean('edge pinned');
    const conditioned = cursor.boolean('edge conditioned');
    const references = readPointerList(cursor, 'edge nodes');
    const first = nodes[references[0] - 1];
    const second = nodes[references[1] - 1];
    if (!first || !second) throw new Error('Invalid TM4 edge node reference');
    const edge = new tmEdge(String(id), first, second);
    edge.label = label;
    edge.length = length;
    edge.strain = strain;
    edge.stiffness = stiffness;
    edge.isPinnedEdge = pinned;
    edge.isConditionedEdge = conditioned;
    tree.edges.push(edge);
    edges.push(edge);
    edgeReferences.push(references);
  }

  for (let index = 0; index < pathCount; index += 1) {
    if (cursor.token('path tag') !== 'path') throw new Error('Invalid TM4 path tag');
    const id = cursor.integer('path index');
    const minTreeLength = cursor.number('path minimum tree length');
    cursor.number('path minimum paper length');
    cursor.boolean('path leaf');
    cursor.boolean('path subpath');
    const active = cursor.boolean('path active');
    cursor.boolean('path border');
    cursor.boolean('path polygon');
    cursor.boolean('path conditioned');
    cursor.skipList('path owned vertices');
    cursor.token('path forward polygon');
    cursor.token('path backward polygon');
    const nodeIds = readPointerList(cursor, 'path nodes');
    cursor.skipList('path edges');
    cursor.token('path owner');
    const pathNodes = nodeIds.map(reference => nodes[reference - 1]).filter(Boolean);
    if (pathNodes.length >= 2) {
      const path = tree.getPathByNodeIds(pathNodes.map(node => node.id));
      if (path) {
        path.id = String(id);
        path.minTreeLength = minTreeLength;
        path.isActive = active;
        importedPaths.push({ path, minTreeLength, active });
      }
    }
  }

  let importedConditions = 0;
  let skippedConditions = 0;
  for (let index = 0; index < conditionCount; index += 1) {
    const tag = cursor.token('condition tag');
    const lineCount = cursor.integer('condition data count');
    const references = [];
    for (let line = 0; line < lineCount; line += 1) references.push(cursor.integer('condition reference'));

    if (tag === 'CNpn' && references.length >= 2) {
      const first = nodes[references[0] - 1];
      const second = nodes[references[1] - 1];
      if (first && second) {
        tree.addCondition(new ConditionNodesPaired(tree, first, second));
        importedConditions += 1;
      } else skippedConditions += 1;
    } else if (tag === 'CNes' && references.length >= 2) {
      const first = edges[references[0] - 1];
      const second = edges[references[1] - 1];
      if (first && second) {
        tree.addCondition(new ConditionEdgesSameStrain(tree, first, second));
        importedConditions += 1;
      } else skippedConditions += 1;
    } else if (tag === 'CNap' && references.length >= 2) {
      const path = tree.getPath(nodes[references[0] - 1], nodes[references[1] - 1]);
      if (path) {
        tree.addCondition(new ConditionPathActive(tree, path));
        importedConditions += 1;
      } else skippedConditions += 1;
    } else if (tag === 'CNsn' && references.length >= 1) {
      const node = nodes[references[0] - 1];
      if (node && tree.hasSymmetryLine()) {
        tree.addCondition(new ConditionNodeSymmetric(tree, node));
        importedConditions += 1;
      } else skippedConditions += 1;
    } else if (tag === 'CNen' && references.length >= 1) {
      const node = nodes[references[0] - 1];
      if (node) {
        tree.addCondition(new ConditionNodeOnEdge(tree, node, null));
        importedConditions += 1;
      } else skippedConditions += 1;
    } else if (tag === 'CNkn' && references.length >= 1) {
      const node = nodes[references[0] - 1];
      if (node) {
        tree.addCondition(new ConditionNodeOnCorner(tree, node, null));
        importedConditions += 1;
      } else skippedConditions += 1;
    } else {
      skippedConditions += 1;
    }
  }

  tree.refreshNodeClassification();
  for (const imported of importedPaths) {
    imported.path.minTreeLength = imported.minTreeLength;
    imported.path.isActive = imported.active;
    for (const condition of tree.getConditions().filter(item => item.getPath?.() === imported.path)) {
      condition.calcFeasibility?.();
    }
  }
  tree.recalculateFeasibility();
  return {
    tree,
    imported: { nodes: nodeCount, edges: edgeCount, paths: pathCount },
    importedConditions,
    skipped: { conditions: skippedConditions, polygons: polyCount, vertices: vertexCount, creases: creaseCount }
  };
}
