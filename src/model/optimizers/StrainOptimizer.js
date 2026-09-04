import { NewtonRaphson } from '../solvers/NewtonRaphson.js';
import { minimizeAugmentedLagrangian } from '../solvers/AugmentedLagrangianNLP.js';
import { ConditionPathActive } from '../conditions/ConditionPathActive.js';

/**
 * Replica "Minimize Strain" de TreeMaker C++ (tmStrainOptimizer, en
 * original/TreeMaker/Source/tmModel/tmOptimizers/tmStrainOptimizer.cpp) —
 * OnMinimizeStrain() en el original. Es un comando distinto de "Scale
 * Selection" (EdgeOptimizer.js) aunque a primera vista se parecen: los dos
 * mueven solo hojas seleccionadas y estiran solo aristas seleccionadas, y
 * los dos resuelven un único problema conjunto de posiciones + tensión con
 * el mismo Lagrangiano aumentado + BFGS. La diferencia es qué se optimiza:
 *
 * - EdgeOptimizer/"Scale Selection": TODAS las aristas seleccionadas
 *   comparten UNA sola tensión candidata, y se MAXIMIZA esa tensión — sirve
 *   para estirar deliberadamente una rama tanto como el papel lo permita.
 * - StrainOptimizer/"Minimize Strain": cada arista seleccionada tiene su
 *   PROPIA tensión independiente, y se MINIMIZA la suma de tensión al
 *   cuadrado (ponderada por la rigidez de cada arista) sujeta a que el
 *   árbol siga siendo geométricamente válido — sirve para, dada una
 *   disposición ya inválida o ya tensada (p.ej. después de mover nodos a
 *   mano hasta romper alguna distancia mínima), repartir el "arreglo"
 *   mínimo necesario entre las aristas seleccionadas en vez de concentrarlo
 *   en una sola. Cuanto más rígida (stiffness) una arista, menos tensión le
 *   toca proporcionalmente: el reparto es análogo al de una red de resortes.
 *
 * Otra diferencia real con EdgeOptimizer: aquí los nodos/aristas de la
 * selección NO se filtran por "no fijado" (`tmTree::FilterMovableParts`) —
 * tmStrainOptimizer::Initialize() solo aplica `FilterLeafNodes` (que
 * hoja sí, hoja no) a los nodos, y usa las aristas seleccionadas tal cual.
 * Tiene sentido: el propósito es justamente poder destrabar una
 * configuración que quedó fija/tensa, así que no tendría sentido excluir
 * de entrada lo que ya está fijado o tenso.
 */
export class StrainOptimizer {
  constructor(tree, selectedNodes = [], selectedEdges = [], options = {}) {
    this.tree = tree;
    this.selectedNodes = selectedNodes;
    this.selectedEdges = selectedEdges;
    // bl/bu de las variables de tensión en tmStrainOptimizer::Initialize().
    this.minStrain = options.minStrain ?? -0.999;
    this.maxStrain = options.maxStrain ?? 2.0;
    this.almOptions = options.almOptions ?? {};
    this._conditionEvaluator = new NewtonRaphson(tree);
  }

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
   * Equivalent to tmStrainOptimizer::GetFixVarLengths(): recorre las
   * aristas del camino y separa la parte fija (aristas no seleccionadas,
   * con su tensión actual) de una lista de (posición en stretchyEdges,
   * coeficiente) por cada arista seleccionada del camino — a diferencia de
   * EdgeOptimizer, puede haber más de una, cada una con su propia variable.
   */
  _getFixVarLengths(path, stretchyEdgePosition) {
    const scale = this.tree.getScale();
    let lfix = 0;
    const terms = [];
    for (let i = 0; i < path.nodes.length - 1; i += 1) {
      const edge = this.tree.getEdge(path.nodes[i], path.nodes[i + 1]);
      if (!edge) continue;
      const position = stretchyEdgePosition.get(edge);
      if (position !== undefined) {
        const coefficient = edge.getLength() * scale;
        terms.push({ position, coefficient });
        lfix += coefficient;
      } else {
        lfix += edge.getStrainedScaledLength(scale);
      }
    }
    return { lfix, terms };
  }

  optimize() {
    // Equivalent to tmTree::FilterLeafNodes(): keep only leaves, no pinned
    // check (unlike EdgeOptimizer/ScaleOptimizer).
    const movingNodes = this.selectedNodes.filter(node => node.getDegree() === 1);
    const stretchyEdges = this.selectedEdges;
    if (movingNodes.length === 0 && stretchyEdges.length === 0) {
      return { converged: false, reason: 'no-moving-nodes-or-edges' };
    }

    const width = this.tree.getPaperWidth();
    const height = this.tree.getPaperHeight();
    const edgeOffset = 2 * movingNodes.length;
    const strainState = stretchyEdges.map(() => ({ value: 0 }));
    const stretchyEdgePosition = new Map(stretchyEdges.map((edge, i) => [edge, i]));
    const stiffness = stretchyEdges.map(edge => {
      const value = edge.getStiffness();
      return value > 0 ? value : 1;
    });

    const variables = [
      ...movingNodes.flatMap(node => ([
        { get: () => node.getLocX(), set: (value) => { node.location.x = value; } },
        { get: () => node.getLocY(), set: (value) => { node.location.y = value; } }
      ])),
      ...strainState.map(state => ({ get: () => state.value, set: (value) => { state.value = value; } }))
    ];

    const lower = [
      ...movingNodes.flatMap(() => [0, 0]),
      ...stretchyEdges.map(() => this.minStrain)
    ];
    const upper = [
      ...movingNodes.flatMap(() => [width, height]),
      ...stretchyEdges.map(() => this.maxStrain)
    ];

    const objective = {
      // Tensión cuadrática media ponderada por rigidez, igual que
      // tmStrainOptimizerObjective::Func() (Σ stiffness_i · strain_i²).
      value: () => strainState.reduce((sum, state, i) => sum + stiffness[i] * state.value * state.value, 0),
      grad: (out) => {
        out.fill(0);
        strainState.forEach((state, i) => { out[edgeOffset + i] = 2 * stiffness[i] * state.value; });
      }
    };

    const constraints = [];
    const leaves = this.tree.getNodes().filter(node => node.getDegree() === 1);
    for (const path of this._allLeafPaths(leaves)) {
      const { lfix, terms } = this._getFixVarLengths(path, stretchyEdgePosition);
      const front = path.getFirstNode();
      const back = path.getLastNode();
      const ixFront = 2 * movingNodes.indexOf(front);
      const ixBack = 2 * movingNodes.indexOf(back);
      const frontMovable = movingNodes.includes(front);
      const backMovable = movingNodes.includes(back);

      if (!frontMovable && !backMovable && terms.length === 0) continue;

      constraints.push({
        inequality: true,
        value: () => (
          lfix + terms.reduce((sum, term) => sum + strainState[term.position].value * term.coefficient, 0)
          - front.getLoc().distance(back.getLoc())
        ),
        grad: (out) => {
          out.fill(0);
          for (const term of terms) out[edgeOffset + term.position] = term.coefficient;
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

    stretchyEdges.forEach((edge, i) => edge.setStrain(strainState[i].value));
    this.tree.refreshPathStates();

    const rmsStrain = Math.sqrt(
      stretchyEdges.reduce((sum, edge, i) => sum + stiffness[i] * strainState[i].value ** 2, 0) / Math.max(stretchyEdges.length, 1)
    );

    return {
      converged: true,
      rmsStrain,
      movingNodeCount: movingNodes.length,
      stretchyEdgeCount: stretchyEdges.length
    };
  }
}
