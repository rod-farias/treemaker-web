import { NewtonRaphson } from '../solvers/NewtonRaphson.js';
import { minimizeAugmentedLagrangian } from '../solvers/AugmentedLagrangianNLP.js';
import { ConditionPathActive } from '../conditions/ConditionPathActive.js';

/**
 * Replica "Scale Selection" de TreeMaker C++ (tmEdgeOptimizer, en
 * original/TreeMaker/Source/tmModel/tmOptimizers/tmEdgeOptimizer.cpp) —
 * OnScaleSelection() en el original: maximiza una única tensión (strain)
 * compartida aplicada a las aristas seleccionadas, moviendo únicamente las
 * hojas seleccionadas, sin tocar el resto del árbol. Es la herramienta para
 * "estirar" una rama concreta cuando el usuario no quiere (o no puede)
 * volver a maximizar la escala de todo el árbol.
 *
 * Una versión anterior de este archivo no existía: `tmTree.scaleSelection()`
 * llamaba en cambio al solver de condiciones genérico (`solveWithALM` con
 * `variableMode:'strain'`), que es el motor de OTRO comando del original
 * (Minimize Strain / tmStrainOptimizer, sobre TODOS los nodos/aristas
 * movibles). tmEdgeOptimizer es un problema distinto y más simple: igual
 * que tmScaleOptimizer, arma un único vector de variables [tensión,
 * hoja1.x, hoja1.y, ...] — pero solo con las hojas EFECTIVAMENTE
 * seleccionadas (`tmTree::FilterMovableParts`, ya portado como
 * `filterMovableParts()`) — y lo optimiza TODO junto con el mismo
 * Lagrangiano aumentado + BFGS de AugmentedLagrangianNLP.js. La restricción
 * por cada camino hoja-a-hoja del árbol (¡de TODO el árbol, no solo el que
 * toca la selección!) es que la distancia real en el papel no baje de
 * `lfix + tensión·lvar`, donde `lfix`/`lvar` separan, arista por arista del
 * camino, la parte fija (aristas no-seleccionadas, con su tensión actual)
 * de la parte variable (aristas seleccionadas, que comparten la misma
 * tensión candidata) — tmEdgeOptimizer::GetFixVarLengths().
 */
export class EdgeOptimizer {
  constructor(tree, selectedNodes = [], selectedEdges = [], options = {}) {
    this.tree = tree;
    this.selectedNodes = selectedNodes;
    this.selectedEdges = selectedEdges;
    // bl[0]/bu[0] en tmEdgeOptimizer::Initialize().
    this.minStrain = options.minStrain ?? -0.999;
    this.maxStrain = options.maxStrain ?? 10.0;
    this.almOptions = options.almOptions ?? {};
    this._conditionEvaluator = new NewtonRaphson(tree);
  }

  /**
   * Todos los caminos hoja-a-hoja del árbol (no solo los que tocan la
   * selección: un camino entre dos hojas fijas puede igual atravesar una
   * arista estirable en el medio), excluyendo los que ya tienen una
   * condición de camino activo — igual que ScaleOptimizer._leafPairConstraints.
   */
  _allLeafPaths(leaves) {
    const activePaths = new Set(
      this.tree.getConditions()
        .filter(condition => condition instanceof ConditionPathActive)
        .map(condition => condition.getPath())
    );
    const paths = [];
    for (let i = 0; i < leaves.length; i += 1) {
      for (let j = i + 1; j < leaves.length; j += 1) {
        const path = this.tree.getPath(leaves[i], leaves[j]);
        if (!path || activePaths.has(path)) continue;
        paths.push(path);
      }
    }
    return paths;
  }

  /**
   * Equivalent to tmEdgeOptimizer::GetFixVarLengths(): separa, arista por
   * arista del camino, la parte fija (arista no seleccionada, con su
   * tensión actual) de la parte variable (arista seleccionada/estirable,
   * que comparte la tensión candidata u[0]) — ambas ya escaladas al papel.
   */
  _getFixVarLengths(path, stretchyEdges) {
    const scale = this.tree.getScale();
    let lfix = 0;
    let lvar = 0;
    for (let i = 0; i < path.nodes.length - 1; i += 1) {
      const edge = this.tree.getEdge(path.nodes[i], path.nodes[i + 1]);
      if (!edge) continue;
      if (stretchyEdges.includes(edge)) {
        const temp = edge.getLength() * scale;
        lfix += temp;
        lvar += temp;
      } else {
        lfix += edge.getStrainedScaledLength(scale);
      }
    }
    return { lfix, lvar };
  }

  optimize() {
    const { nodes: movingNodes, edges: stretchyEdges } = this.tree.filterMovableParts(this.selectedNodes, this.selectedEdges);
    if (movingNodes.length === 0) {
      return { converged: false, reason: 'no-moving-nodes' };
    }
    if (stretchyEdges.length === 0) {
      return { converged: false, reason: 'no-moving-edges' };
    }

    const width = this.tree.getPaperWidth();
    const height = this.tree.getPaperHeight();
    // La tensión candidata no vive en ningún nodo/arista del árbol durante
    // la búsqueda (tmEdgeOptimizerObjective la deja en mCurrentStateVec[0]
    // hasta el DataToTree() final) — un simple objeto propio alcanza.
    const strainState = { value: 0 };

    const variables = [
      { get: () => strainState.value, set: (value) => { strainState.value = value; } },
      ...movingNodes.flatMap(node => ([
        { get: () => node.getLocX(), set: (value) => { node.location.x = value; } },
        { get: () => node.getLocY(), set: (value) => { node.location.y = value; } }
      ]))
    ];

    const lower = [this.minStrain, ...movingNodes.flatMap(() => [0, 0])];
    const upper = [this.maxStrain, ...movingNodes.flatMap(() => [width, height])];

    const objective = {
      value: () => -strainState.value,
      grad: (out) => {
        out.fill(0);
        out[0] = -1;
      }
    };

    const constraints = [];
    const leaves = this.tree.getNodes().filter(node => node.getDegree() === 1);
    for (const path of this._allLeafPaths(leaves)) {
      const { lfix, lvar } = this._getFixVarLengths(path, stretchyEdges);
      const front = path.getFirstNode();
      const back = path.getLastNode();
      const ixFront = 1 + 2 * movingNodes.indexOf(front);
      const ixBack = 1 + 2 * movingNodes.indexOf(back);
      const frontMovable = movingNodes.includes(front);
      const backMovable = movingNodes.includes(back);

      // Neither endpoint moving and no stretchy edge on this path at all:
      // the constraint can never become active (no term depends on any
      // variable), so it's pure dead weight — tmEdgeOptimizer skips it too.
      if (!frontMovable && !backMovable && lvar === 0) continue;

      constraints.push({
        inequality: true,
        value: () => strainState.value * lvar + lfix - front.getLoc().distance(back.getLoc()),
        grad: (out) => {
          out.fill(0);
          out[0] = lvar;
          if (!frontMovable && !backMovable) return;
          const dx = front.getLocX() - back.getLocX();
          const dy = front.getLocY() - back.getLocY();
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          if (frontMovable) {
            out[ixFront] = -dx / dist;
            out[ixFront + 1] = -dy / dist;
          }
          if (backMovable) {
            out[ixBack] = dx / dist;
            out[ixBack + 1] = dy / dist;
          }
        }
      });
    }

    this.tree.getConditions().forEach(condition => {
      const count = this._conditionEvaluator._matrixResiduals([condition]).length;
      for (let index = 0; index < count; index += 1) {
        constraints.push({
          inequality: false,
          value: () => this._conditionEvaluator._matrixResiduals([condition])[index]
        });
      }
    });

    const result = minimizeAugmentedLagrangian(variables, objective, constraints, { lower, upper }, this.almOptions);

    if (!result.converged) {
      return { converged: false, reason: 'did-not-converge' };
    }

    for (const edge of stretchyEdges) edge.setStrain(strainState.value);
    this.tree.refreshPathStates();

    return {
      converged: true,
      strain: strainState.value,
      movingNodeCount: movingNodes.length,
      stretchyEdgeCount: stretchyEdges.length
    };
  }
}
