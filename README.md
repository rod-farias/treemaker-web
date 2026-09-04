# TreeMaker Web

Migración a JavaScript puro, sin frameworks, de [TreeMaker](https://langorigami.com)
—el generador de patrones de plegado de origami creado por Robert J. Lang,
originalmente en C++/wxWidgets— a una aplicación web (SPA) que corre
íntegramente en el navegador.

Incluye el modelo geométrico completo de TreeMaker (nodos, aristas, caminos,
polígonos, vértices, pliegues y facetas), las 13 condiciones de diseño, los
solvers y optimizadores (Newton-Raphson, penalización, Lagrangiano
aumentado; Maximize Scale, Scale Selection y Minimize Strain), lectura y
escritura completa del formato `.tmd5`, y una migración integrada de
[ReferenceFinder](https://langorigami.com) (los 7 axiomas de Huzita-Hatori)
para encontrar referencias de plegado.

## Arranque local

```bash
npm install
npm run dev          # servidor de desarrollo (Vite)
npm run build        # build de producción (multi-archivo, para servir por http/https)
npm run build:single # build en un solo archivo .html, para abrir con file:// sin servidor
```

## Estructura

```
src/
  main.js               — entry point e integración con la UI
  i18n/                  — textos de interfaz (es/en)
  model/                 — lógica pura, sin DOM
    tmPoint.js, tmNode.js, tmEdge.js, tmPath.js, tmPoly.js,
    tmVertex.js, tmCrease.js, tmFacet.js, tmTree.js
    tmCondition.js        — clase base de las 13 condiciones
    conditions/            — las 13 condiciones (ver tmCondition.js)
    optimizers/             — Optimizer, EdgeOptimizer, ScaleOptimizer, StrainOptimizer
    solvers/                 — Matrix, NewtonRaphson, ALM, NLCO, StubFinder,
                                ConstraintSolver, PolygonPartition
    io/                       — TM4Parser.js (formato TreeMaker v4) y Tmd5Format.js
    referenceFinder/          — motor de ReferenceFinder (los 7 axiomas)
  renderer/              — Renderer base + CanvasRenderer (canvas 2D)
  editor/                — NodeEditor (modos seleccionar / agregar nodo / agregar arista)

index.html              — interfaz principal (panel de vista, panel de resolución,
                           Inspector como tercera columna del grid)
```

## Licencia

TreeMaker original está bajo GNU GPL v2, con la única excepción de la
librería de terceros `wnlib`. Este proyecto es una traducción a otro
lenguaje del programa original, y la GPLv2 cubre explícitamente las
traducciones como obra derivada (sección 0 de la licencia). Por lo tanto,
hereda esos mismos términos: puede usarse, copiarse, modificarse y
redistribuirse libremente, pero no puede cerrarse ni distribuirse con una
licencia propietaria. Ver [`LICENSE`](LICENSE) para el texto completo.

## Créditos

TreeMaker y ReferenceFinder originales son obra de
[Robert J. Lang](https://langorigami.com). Este repositorio es una
migración/traducción no oficial a JavaScript, sin afiliación con el autor
original.
