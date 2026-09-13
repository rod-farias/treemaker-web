# Changelog

All notable changes to this project are documented in this file.

## [1.1.0] - 2026-09-13

### Added
- **PDF export**: a new "Export PDF" action (next to Save `.tmd5`) opens a
  dialog to pick which views (Tree, Design, Creases, Plan, Folded Form) go
  into the PDF, one page per view, each sized to match that view's own
  aspect ratio.
- **PDF export of saved ReferenceFinder queries**: the same dialog can also
  export your saved ReferenceFinder queries, one page per query, each with
  the target diagram and the full fold sequence that solves it.
- **Paired-node symmetric editing**: nodes linked by "Nodes Paired" can now
  optionally have their position and adjacent-edge edits mirrored onto each
  other automatically, for symmetric designs.
- Several usability improvements for phones and tablets: correct initial
  zoom/scroll on small phone screens, a resized "About" dialog on narrow
  windows, a phone-specific startup notice, and a canvas "Multi-select"
  toggle for touch-only multi-selection.

### Fixed
- A handful of polish fixes to the PDF export of saved ReferenceFinder
  queries: correct rendering of non-ASCII characters, and more consistent
  thumbnail sizing across queries with different numbers of steps.

## [1.0.0] - 2026-09-08

First fully functional release. The feature set is the same one introduced in
the 0.1.0 beta, now hardened through several days of dedicated testing and
bug-fixing across every major area of the app — conditions, the solvers,
Build Crease Pattern, and file I/O.

### Added
- **Live feasibility indicator**: a persistent sidebar warning appears the
  moment the current design stops satisfying its own conditions (e.g. a node
  fixed to a paper corner it isn't actually at, or a leaf-to-leaf path
  shorter than its required minimum), with a detailed, clickable breakdown of
  exactly what's wrong and where.
- **In-app error and warning dialogs**: every action that can fail (Build
  Crease Pattern, Maximize Scale, Scale Selection, Minimize Strain, opening
  or saving a `.tmd5` file) now reports success or failure through the app's
  own styled dialogs instead of the browser's native, unstyled `alert()`.
- Refreshed About dialog: links to this repository and to the original
  TreeMaker article on langorigami.com, alongside the version number and
  project description.
- Two build outputs are now first-class: a standard multi-file production
  build (`npm run build`) and a single, self-contained `.html` file (`npm
  run build:single`) that runs entirely offline via `file://`, with no
  server at all.

### Fixed
- "Fixed to Symmetry Line" and "Fixed to Paper Edge" can now be applied to
  the same node at once, matching the original TreeMaker — needed for
  book-symmetry designs, where a node commonly sits at the exact midpoint of
  the paper edge the symmetry line crosses.
- Several multi-selection Inspector bugs where a toggle (e.g. a node
  condition checkbox) kept reflecting a previous selection's state instead
  of the one currently selected.
- A false "node outside the paper" / "path shorter than its minimum" report
  could appear on perfectly valid, buildable designs, from floating-point
  rounding noise and from internal (non-leaf) bookkeeping paths that don't
  actually constrain the design.
- Undo/redo now correctly refreshes every piece of derived UI state (the
  feasibility indicator included), instead of only edits committed through
  the normal editing flow.

## [0.1.0] - 2026-09-04 (Beta)

Initial public release: a from-scratch reimplementation of TreeMaker in
vanilla JavaScript, feature-complete but only lightly tested end to end.

### Added
- TreeMaker's full geometric model (nodes, edges, paths, polygons, vertices,
  creases and facets).
- All 13 design conditions, the Newton-Raphson / penalty / augmented-
  Lagrangian solvers, and the Maximize Scale, Scale Selection and Minimize
  Strain optimizers.
- Complete reading and writing of the `.tmd5` format.
- ReferenceFinder (the 7 Huzita-Hatori axioms) integrated directly into the
  interface.
