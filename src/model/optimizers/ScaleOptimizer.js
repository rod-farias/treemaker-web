import { NewtonRaphson } from '../solvers/NewtonRaphson.js';
import { minimizeAugmentedLagrangian } from '../solvers/AugmentedLagrangianNLP.js';
import { ConditionPathActive } from '../conditions/ConditionPathActive.js';
import { ConditionNodeFixed } from '../conditions/ConditionNodeFixed.js';

/**
 * Test de cruce de segmentos (intersección propia, sin contar el simple
 * "tocarse en un extremo"). Se usa para descartar disposiciones de hojas
 * que satisfacen las distancias mínimas par-a-par pero no corresponden a
 * ninguna base de origami real: dos aristas del árbol que se cruzan
 * implicarían dos ramas atravesándose entre sí, algo geométricamente
 * imposible en un papel doblado.
 */
function segmentsIntersect(p1, p2, p3, p4) {
  const ccw = (a, b, c) => (c.y - a.y) * (b.x - a.x) - (b.y - a.y) * (c.x - a.x);
  const d1 = ccw(p3, p4, p1);
  const d2 = ccw(p3, p4, p2);
  const d3 = ccw(p1, p2, p3);
  const d4 = ccw(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/**
 * Replica "Scale Everything" de TreeMaker C++ (tmScaleOptimizer, en
 * original/TreeMaker/Source/tmModel/tmOptimizers/tmScaleOptimizer.cpp):
 * busca el mayor factor de escala del árbol, reubicando los nodos hoja
 * dentro del papel, tal que la distancia en papel entre cualquier par de
 * hojas siga siendo al menos su distancia mínima en unidades de árbol
 * multiplicada por la escala candidata.
 *
 * El original resuelve esto como UN solo problema de optimización conjunta:
 * arma un vector de variables [escala, hoja1.x, hoja1.y, hoja2.x, hoja2.y,
 * ...] y lo optimiza TODO junto (con CFSQP, o con su alternativa 100%
 * distribuible ALM+BFGS — ver tmModel/tmNLCO/tmNLCO_alm.cpp) sujeto a: cada
 * variable dentro de sus cotas [0, ancho/alto/escalaMáxima], la escala no
 * caer bajo `minScaleFactor` de la escala inicial, y para cada par de hojas
 * sin condición de camino activo, escala·distanciaMínima − distancia ≤ 0
 * (`tmConstraintFns.cpp::PathFn1`).
 *
 * Una versión anterior de este archivo NO hacía eso: trataba la escala como
 * un parámetro fijo de una búsqueda binaria externa, y en cada escala
 * candidata solo reubicaba las hojas con heurísticas geométricas (dilatación
 * uniforme + empuje hacia el borde del papel). Esto coincidía con el
 * original en árboles con un solo nodo de ramificación, pero quedaba
 * atascado en óptimos locales peores en árboles con varias ramificaciones
 * (test/prueba6_*.tmd5: 0.2003 en vez de 0.2044) — el problema que
 * documentaba el comentario de `optimize()` más abajo. Se confirmó
 * compilando y corriendo tmNLCO_alm.cpp real contra los mismos árboles de
 * prueba: reproduce la escala Y la disposición de hojas de referencia casi
 * exactamente (7 decimales en prueba5, <0.005% en prueba6), mientras que el
 * enfoque de bisección no. `AugmentedLagrangianNLP.js` es el puerto de ese
 * mismo algoritmo (Lagrangiano aumentado + BFGS), y este archivo arma
 * exactamente el mismo problema que `tmScaleOptimizer::Initialize()`.
 */
export class ScaleOptimizer {
  constructor(tree, options = {}) {
    this.tree = tree;
    // bu[0] en tmScaleOptimizer::Initialize().
    this.maxScale = options.maxScale ?? 2.0;
    // 0.1 * escala inicial: la restricción lineal que agrega Initialize()
    // vía AddLinearInequality(new OneVarFn(0, -1.0, 0.1*escala)).
    this.minScaleFactor = options.minScaleFactor ?? 0.1;
    this.almOptions = options.almOptions ?? {};
    // Entre varios reinicios aleatorios válidos, 'similar' se queda con la
    // disposición que arranca de la posición actual de las hojas salvo que
    // otra ofrezca una mejora de escala sustancial (ver `_selectBest`);
    // 'max' siempre toma la escala más alta encontrada, sin importar cuán
    // distinta se vea de la disposición original. El original en sí NUNCA
    // reinicia al azar (una sola resolución determinista desde la posición
    // actual): los reinicios son una extensión propia de este puerto para
    // no depender de qué tan afortunada sea la disposición inicial del
    // usuario en árboles con varios óptimos locales.
    this.selectionMode = options.selectionMode ?? 'similar';
    this.similarityImprovementFactor = options.similarityImprovementFactor ?? 0.05;
    // Se reutiliza el evaluador de condiciones de NewtonRaphson (fijar
    // posición, emparejamiento, simetría, etc.) para que "Escalar todo"
    // respete las mismas condiciones que el resto de los solvers — el
    // equivalente de que Initialize() llame a `aCondition->AddConstraints`
    // por cada condición del árbol.
    this._conditionEvaluator = new NewtonRaphson(tree);
  }

  _leafNodes() {
    return this.tree.getNodes().filter(node => node.getDegree() === 1);
  }

  _isFullyFixed(node) {
    return this.tree.getConditions().some(condition => (
      condition instanceof ConditionNodeFixed &&
      condition.getNode() === node &&
      condition.getXFixed() && condition.getYFixed()
    ));
  }

  /**
   * Restricciones par-a-par entre hojas: la distancia directa en papel debe
   * ser al menos minTreeLength * escala. Se excluyen los pares con un camino
   * activo por condición explícita (esos ya se resuelven como igualdad en
   * otro lado, igual que en el original).
   */
  _leafPairConstraints(leaves) {
    const activePaths = new Set(
      this.tree.getConditions()
        .filter(condition => condition instanceof ConditionPathActive)
        .map(condition => condition.getPath())
    );
    const constraints = [];
    for (let i = 0; i < leaves.length; i += 1) {
      for (let j = i + 1; j < leaves.length; j += 1) {
        const path = this.tree.getPath(leaves[i], leaves[j]);
        if (!path || activePaths.has(path)) continue;
        constraints.push({ nodeA: leaves[i], nodeB: leaves[j], minTreeLength: path.getMinTreeLength() });
      }
    }
    return constraints;
  }

  /**
   * Arma y resuelve el problema conjunto de tmScaleOptimizer::Initialize()
   * a partir de las posiciones ACTUALES de `leaves` y la escala actual del
   * árbol. Deja el árbol en el resultado final del solver (converja o no,
   * igual que el AugLag original: solo el llamador decide si restaurar el
   * estado previo ante una no-convergencia). Devuelve {converged, scale,
   * positions}.
   */
  _solveJointly(leaves, pairConstraints) {
    const width = this.tree.getPaperWidth();
    const height = this.tree.getPaperHeight();
    const startScale = this.tree.getScale();

    // Vector de variables: [escala, hoja0.x, hoja0.y, hoja1.x, hoja1.y, ...]
    // — el mismo layout que tmScaleOptimizer::GetBaseOffset() (offset 0
    // para la escala, 1+2*i para la hoja i).
    const variables = [
      // The line search's trial steps can transiently probe a non-positive
      // scale (bounds are a soft Augmented-Lagrangian penalty here, not a
      // hard clamp, matching the original's raw-double-vector state — it
      // never validates); tree.setScale() itself throws on that, so floor
      // it to a tiny positive value instead of letting the search crash.
      { get: () => this.tree.getScale(), set: (value) => this.tree.setScale(Math.max(1e-9, value)) },
      ...leaves.flatMap(node => ([
        { get: () => node.getLocX(), set: (value) => { node.location.x = value; } },
        { get: () => node.getLocY(), set: (value) => { node.location.y = value; } }
      ]))
    ];

    const lower = new Array(variables.length).fill(0);
    const upper = [this.maxScale, ...leaves.flatMap(() => [width, height])];

    const objective = {
      value: () => -this.tree.getScale(),
      grad: (out) => {
        out.fill(0);
        out[0] = -1;
      }
    };

    const constraints = [];

    // OneVarFn(0, -1.0, minScaleFactor*startScale): -escala + minScaleFactor*startScale <= 0.
    constraints.push({
      inequality: true,
      value: () => -this.tree.getScale() + this.minScaleFactor * startScale,
      grad: (out) => {
        out.fill(0);
        out[0] = -1;
      }
    });

    // PathFn1 por cada par de hojas: escala*minTreeLength - distancia <= 0.
    pairConstraints.forEach(({ nodeA, nodeB, minTreeLength }) => {
      const ixA = 1 + 2 * leaves.indexOf(nodeA);
      const ixB = 1 + 2 * leaves.indexOf(nodeB);
      constraints.push({
        inequality: true,
        value: () => this.tree.getScale() * minTreeLength - nodeA.getLoc().distance(nodeB.getLoc()),
        grad: (out) => {
          out.fill(0);
          out[0] = minTreeLength;
          const dx = nodeA.getLocX() - nodeB.getLocX();
          const dy = nodeA.getLocY() - nodeB.getLocY();
          // sqrt(dx*dx+dy*dy), NOT Math.hypot: must match tmPoint.distance()'s
          // exact formula (also plain sqrt(dx*dx+dy*dy), mirroring PathFn1::Grad
          // in the original) bit-for-bit, or the gradient and the value it's
          // the derivative of go a few ULPs out of sync — harmless on paper,
          // but on a large/stiff tree (many leaves, many active constraints)
          // that's enough for BFGS's line search to walk a measurably
          // different path over hundreds of iterations and land in a
          // different local optimum (found via test/prueba7_*.tmd5: matched
          // the reference to 1e-4 on smaller trees, but landed 5% off scale
          // on this bigger one, until this was fixed).
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          out[ixA] = -dx / dist;
          out[ixA + 1] = -dy / dist;
          out[ixB] = dx / dist;
          out[ixB + 1] = dy / dist;
        }
      });
    });

    // Una restricción de igualdad por cada residuo escalar de cada
    // condición activa del árbol (fijar posición, simetría, colinealidad,
    // etc.) — el equivalente de `aCondition->AddConstraints(this)`. Sin
    // gradiente analítico (se usa la diferencia numérica genérica de
    // AugmentedLagrangianNLP): el número de condiciones suele ser pequeño,
    // así que el costo extra es despreciable.
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

    return {
      converged: result.converged,
      scale: this.tree.getScale(),
      positions: leaves.map(node => ({ x: node.getLocX(), y: node.getLocY() }))
    };
  }

  /**
   * ¿Alguna arista del árbol se cruza con otra bajo esta disposición de
   * hojas? Las restricciones de la búsqueda solo exigen que la distancia
   * directa entre cada par de hojas alcance su mínimo — nada les impide a
   * dos ramas cruzarse por el camino, lo cual no corresponde a ninguna base
   * de origami real (dos ramas no pueden atravesarse en un papel doblado).
   * Los nodos no-hoja no se mueven durante la búsqueda, así que se usa su
   * posición actual en el árbol; solo las hojas toman la posición candidata.
   */
  _hasCrossingEdges(leaves, positions) {
    const positionOf = new Map(leaves.map((leaf, index) => [leaf, positions[index]]));
    const locOf = (node) => positionOf.get(node) || node.getLoc();
    const edges = this.tree.getEdges();
    for (let i = 0; i < edges.length; i += 1) {
      const [a1, a2] = edges[i].getNodes();
      for (let j = i + 1; j < edges.length; j += 1) {
        const [b1, b2] = edges[j].getNodes();
        if (a1 === b1 || a1 === b2 || a2 === b1 || a2 === b2) continue;
        if (segmentsIntersect(locOf(a1), locOf(a2), locOf(b1), locOf(b2))) return true;
      }
    }
    return false;
  }

  /**
   * Varios candidatos pueden llegar a esencialmente la misma escala óptima
   * mediante disposiciones estructuralmente distintas (pero igual de
   * válidas) — p.ej. en un árbol con dos nodos de ramificación, "cada rama
   * estirada hacia un borde del papel" tiene una solución equivalente por
   * cada borde, todas con la misma escala. Entre los candidatos casi-óptimos
   * propios, el que se mantiene más cerca de las posiciones iniciales de las
   * hojas es la mejor aproximación a lo que habría producido una resolución
   * determinista única desde esa misma posición inicial.
   *
   * Antes de comparar escalas, se descartan los candidatos con aristas
   * cruzadas (ver `_hasCrossingEdges`): un reinicio aleatorio puede
   * teletransportar una hoja "al otro lado" del árbol y encontrar una
   * escala numéricamente mayor a costa de una disposición físicamente
   * imposible. Si TODOS los candidatos cruzan (no debería pasar partiendo
   * de una disposición válida), se conserva el conjunto completo como
   * respaldo en vez de fallar.
   *
   * El modo 'similar' además prefiere, entre los candidatos, quedarse con
   * el primero (el que arranca de la posición actual/original de las
   * hojas, sin ningún reinicio aleatorio) salvo que algún reinicio ofrezca
   * una mejora de escala sustancial (`similarityImprovementFactor`, 5% por
   * defecto). El modo 'max' toma siempre la escala más alta encontrada.
   */
  _selectBest(candidates, originalPositions, leaves) {
    const displacementFrom = (positions) => positions.reduce((sum, position, index) => (
      sum + Math.hypot(position.x - originalPositions[index].x, position.y - originalPositions[index].y)
    ), 0);
    const pickLeastDisplacement = (pool) => {
      let best = pool[0];
      let bestDisplacement = displacementFrom(best.positions);
      for (const candidate of pool.slice(1)) {
        const displacement = displacementFrom(candidate.positions);
        if (displacement < bestDisplacement) {
          best = candidate;
          bestDisplacement = displacement;
        }
      }
      return best;
    };

    const nonCrossing = candidates.filter(candidate => !this._hasCrossingEdges(leaves, candidate.positions));
    const pool = nonCrossing.length > 0 ? nonCrossing : candidates;

    if (this.selectionMode === 'max') {
      const bestScale = pool.reduce((max, candidate) => Math.max(max, candidate.scale), -Infinity);
      return pickLeastDisplacement(pool.filter(candidate => candidate.scale >= bestScale - 1e-9));
    }

    const base = pool.includes(candidates[0]) ? candidates[0] : pool[0];
    const meaningfullyBetter = pool.filter(candidate => (
      candidate.scale >= base.scale * (1 + this.similarityImprovementFactor)
    ));
    if (meaningfullyBetter.length === 0) return base;
    const bestScale = meaningfullyBetter.reduce((max, candidate) => Math.max(max, candidate.scale), -Infinity);
    return pickLeastDisplacement(meaningfullyBetter.filter(candidate => candidate.scale >= bestScale - 1e-9));
  }

  /**
   * Cuántos reinicios aleatorios probar (solo en modo 'max'). El costo por
   * reinicio crece con el número de restricciones par-a-par (cada
   * evaluación de gradiente recorre todas las restricciones activas), así
   * que un árbol con pocas hojas puede permitirse un presupuesto mayor sin
   * costo apreciable.
   */
  _restartCount(constraintCount) {
    return constraintCount <= 20
      ? Math.min(40, Math.round(200 / Math.max(constraintCount, 1)))
      : Math.max(2, Math.round(40 / constraintCount));
  }

  /**
   * Ejecuta la optimización. Devuelve un resumen compatible con el patrón
   * de resultado usado por los demás solvers ({converged, ...}).
   *
   * Igual que el original: si el solver no converge, el árbol se restaura a
   * su escala y posiciones de hojas previas (tmOptimizer::Optimize() nunca
   * llama a DataToTree() cuando Minimize() falla).
   */
  optimize() {
    const leaves = this._leafNodes();
    if (leaves.length < 3) {
      return {
        converged: false,
        reason: 'not-enough-leaves',
        scale: this.tree.getScale(),
        previousScale: this.tree.getScale()
      };
    }

    const constraints = this._leafPairConstraints(leaves);
    const startScale = this.tree.getScale();
    const fixedLeaves = new Set(leaves.filter(leaf => this._isFullyFixed(leaf)));
    const originalPositions = leaves.map(node => ({ x: node.getLocX(), y: node.getLocY() }));
    const restoreOriginal = () => {
      this.tree.setScale(startScale);
      leaves.forEach((node, index) => {
        node.location.x = originalPositions[index].x;
        node.location.y = originalPositions[index].y;
      });
    };

    const candidates = [this._solveJointly(leaves, constraints)];
    // Los reinicios aleatorios solo se exploran en modo 'max': el original
    // hace una única resolución determinista desde la posición actual, así
    // que en modo 'similar' (por defecto) nos quedamos con esa misma única
    // búsqueda en vez de arriesgarnos a encontrar una disposición distinta,
    // aunque tenga más escala.
    const restartCount = this.selectionMode === 'max' ? this._restartCount(constraints.length) : 0;
    for (let attempt = 0; attempt < restartCount; attempt += 1) {
      restoreOriginal();
      for (const leaf of leaves) {
        if (fixedLeaves.has(leaf)) continue;
        leaf.location.x = Math.random() * this.tree.getPaperWidth();
        leaf.location.y = Math.random() * this.tree.getPaperHeight();
      }
      candidates.push(this._solveJointly(leaves, constraints));
    }

    const feasibleCandidates = candidates.filter(candidate => candidate.converged);
    if (feasibleCandidates.length === 0) {
      restoreOriginal();
      return {
        converged: false,
        scale: this.tree.getScale(),
        previousScale: startScale,
        leafCount: leaves.length,
        constraintCount: constraints.length
      };
    }

    const best = this._selectBest(feasibleCandidates, originalPositions, leaves);
    leaves.forEach((node, index) => {
      node.location.x = best.positions[index].x;
      node.location.y = best.positions[index].y;
    });
    this.tree.setScale(best.scale);

    return {
      converged: true,
      improved: best.scale > startScale + 1e-9,
      scale: best.scale,
      previousScale: startScale,
      leafCount: leaves.length,
      constraintCount: constraints.length
    };
  }

  /**
   * Misma búsqueda que optimize(), pero asíncrona y cancelable: cede el
   * control al hilo principal entre cada reinicio (un `setTimeout(0)`) para
   * que la interfaz siga respondiendo mientras corre, y revisa `signal` (un
   * AbortSignal) después de cada reinicio para poder cancelar a mitad de
   * camino. Al cancelar, deja el árbol exactamente como estaba antes de
   * llamar (misma escala y posiciones), en vez de a medio mover.
   */
  async optimizeAsync({ signal, onProgress } = {}) {
    const leaves = this._leafNodes();
    if (leaves.length < 3) {
      return {
        converged: false,
        reason: 'not-enough-leaves',
        scale: this.tree.getScale(),
        previousScale: this.tree.getScale()
      };
    }

    const constraints = this._leafPairConstraints(leaves);
    const startScale = this.tree.getScale();
    const fixedLeaves = new Set(leaves.filter(leaf => this._isFullyFixed(leaf)));
    const originalPositions = leaves.map(node => ({ x: node.getLocX(), y: node.getLocY() }));
    const restoreOriginal = () => {
      this.tree.setScale(startScale);
      leaves.forEach((node, index) => {
        node.location.x = originalPositions[index].x;
        node.location.y = originalPositions[index].y;
      });
    };
    const cancelled = () => {
      restoreOriginal();
      return { converged: false, cancelled: true, scale: startScale, previousScale: startScale };
    };
    const yieldToUI = () => new Promise(resolve => setTimeout(resolve, 0));

    const restartCount = this.selectionMode === 'max' ? this._restartCount(constraints.length) : 0;
    const candidates = [this._solveJointly(leaves, constraints)];
    onProgress?.({ attempt: 0, total: restartCount + 1 });
    await yieldToUI();
    if (signal?.aborted) return cancelled();

    for (let attempt = 0; attempt < restartCount; attempt += 1) {
      restoreOriginal();
      for (const leaf of leaves) {
        if (fixedLeaves.has(leaf)) continue;
        leaf.location.x = Math.random() * this.tree.getPaperWidth();
        leaf.location.y = Math.random() * this.tree.getPaperHeight();
      }
      candidates.push(this._solveJointly(leaves, constraints));
      onProgress?.({ attempt: attempt + 1, total: restartCount + 1 });
      await yieldToUI();
      if (signal?.aborted) return cancelled();
    }

    const feasibleCandidates = candidates.filter(candidate => candidate.converged);
    if (feasibleCandidates.length === 0) {
      restoreOriginal();
      return {
        converged: false,
        scale: this.tree.getScale(),
        previousScale: startScale,
        leafCount: leaves.length,
        constraintCount: constraints.length
      };
    }

    const best = this._selectBest(feasibleCandidates, originalPositions, leaves);
    leaves.forEach((node, index) => {
      node.location.x = best.positions[index].x;
      node.location.y = best.positions[index].y;
    });
    this.tree.setScale(best.scale);

    return {
      converged: true,
      improved: best.scale > startScale + 1e-9,
      scale: best.scale,
      previousScale: startScale,
      leafCount: leaves.length,
      constraintCount: constraints.length
    };
  }
}
