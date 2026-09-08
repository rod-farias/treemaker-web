# TreeMaker Web

A pure JavaScript, framework-free migration of [TreeMaker](https://langorigami.com) — the origami crease pattern design tool created by Robert J. Lang, originally written in C++/wxWidgets — into a web app (SPA) that runs entirely in the browser.

To start designing, just open [TreemakerWeb.App](https://treemakerweb.app) in your browser.

## Complete, faithful migration of the original

Includes:
- TreeMaker's full geometric model (nodes, edges, paths, polygons, vertices, creases and facets).
- The 13 design conditions, plus the solvers and optimizers (Newton-Raphson, penalty, augmented Lagrangian; Maximize Scale, Scale Selection and Minimize Strain).
- Full reading and writing of the `.tmd5` format.
- Built-in migration of [ReferenceFinder](https://langorigami.com) (the 7 Huzita-Hatori axioms) for finding folding references.

## Improvements and special features

- Comfortable horizontal interface, with several color themes.
- ReferenceFinder is included as a module integrated into the interface. This means you can select any point or line in the design (especially vertices and creases) and send it to ReferenceFinder.
- Ability to save ReferenceFinder queries. They can even be saved inside the design's tmd5 file.
- We added a list of the crease vertices scaled to the real size of the paper, in case you're one of those who work with a ruler and a calculator.
- English and Spanish languages.

## Limitations

- A window of at least 1300px x 550px is preferable.
- JavaScript is not C. There are numerical precision differences that make the original program get better results on designs with many nodes and conditions.

## Usage

TreeMaker Web is available for direct use at [TreemakerWeb.App](https://treemakerweb.app), no installation or setup required.

You can also download the project and run it locally with:

```bash
npm install
npm run dev          # development server (Vite)
npm run build        # production build (multi-file, to serve over http/https)
npm run build:single # single-file .html build, to open with file:// without a server
```

## Structure

```
src/
  main.js               — entry point and UI integration
  i18n/                  — interface text (es/en)
  model/                 — pure logic, no DOM
    tmPoint.js, tmNode.js, tmEdge.js, tmPath.js, tmPoly.js,
    tmVertex.js, tmCrease.js, tmFacet.js, tmTree.js
    tmCondition.js        — base class for the 13 conditions
    conditions/            — the 13 conditions (see tmCondition.js)
    optimizers/             — Optimizer, EdgeOptimizer, ScaleOptimizer, StrainOptimizer
    solvers/                 — Matrix, NewtonRaphson, ALM, NLCO, StubFinder,
                                ConstraintSolver, PolygonPartition
    io/                       — TM4Parser.js (TreeMaker v4 format) and Tmd5Format.js
    referenceFinder/          — ReferenceFinder engine (the 7 axioms)
  renderer/              — base Renderer + CanvasRenderer (2D canvas)
  editor/                — NodeEditor (select / add node / add edge modes)

index.html              — main interface (view panel, solve panel,
                           Inspector as the grid's third column)
```

## Changelog

See [`CHANGELOG.md`](CHANGELOG.md) for the version history, including what changed between the 0.1.0 beta and the current 1.0.0 release.

## License

The original TreeMaker is licensed under the GNU GPL v2, with the sole exception of the third-party library `wnlib`. This project is a translation of the original program into another language, and the GPLv2 explicitly covers translations as a derivative work (section 0 of the license). It therefore inherits those same terms: it may be used, copied, modified and redistributed freely, but it may not be closed off or distributed under a proprietary license. See [`LICENSE`](LICENSE) for the full text.

## Credits

The original TreeMaker and ReferenceFinder are the work of [Robert J. Lang](https://langorigami.com). This repository is an unofficial migration/translation to JavaScript, with no affiliation with the original author.
