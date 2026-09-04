/**
 * SavedSearches.js
 *
 * Reader/writer for the `rfSavedQueries` section this app adds to the
 * ".tmd5" format — persisting the Reference Finder's search history as
 * plain coordinates, with NO reference to any tree part (node/path/edge) at
 * all — just the point/line the user searched, which of the search's
 * (up to 5) results was chosen, and that result's own rank/error. See the
 * "Reference Finder" section of the Inspector in main.js, and
 * tree.rfSavedQueries's own doc comment in tmTree.js.
 *
 * `resultIndex` alone is what lets reselecting a saved search jump straight
 * back to the exact same result the user originally picked, rather than
 * whichever one happens to rank best now — sound only because the search
 * itself is a deterministic pure function of the paper size and the target
 * coordinates (same axiom database, same distance-then-rank comparator, no
 * randomness anywhere in rfEngine.js), so the same index reliably means the
 * same result as long as neither of those two inputs changed since saving.
 *
 * This app used to also support a `referenceQueries` concept — a search
 * *anchored* to a specific node/path/edge, with a real reference to that
 * object (see git history / REFERENCEFINDER_PLAN.md's Fase 4-5 for the
 * retired design) — written under its own `rfqA` tag. That anchoring was
 * deliberately removed: every Reference Finder search now persists the same
 * way, as plain coordinates, regardless of whether it was triggered from a
 * part's own "Find reference" button or typed by hand. readSavedSearches()
 * below still recognizes a `rfqA` section on read, purely to migrate an
 * older file's saved queries forward into this coordinate-only shape
 * (keeping the point/line and rank/error, dropping the object reference and
 * the fold-sequence steps) rather than silently losing the user's saved
 * search history — but this app never writes `rfqA` again.
 *
 * This section (both `rfsA` and, for reading, the legacy `rfqA`) has NO
 * counterpart in the original TreeMaker/ReferenceFinder file formats — it's
 * this app's own extension, same "safe to append after everything else"
 * reasoning as Tmd5Format.js's own `bldA` (build-state) section: a real
 * TreeMaker, or a treemaker-spa build from before this feature existed,
 * both simply stop reading at the point where their own format ends,
 * whether or not this section follows. Reading it back is entirely
 * optional-on-absence (see readSavedSearches()): a file with no section, or
 * a genuinely truncated stream at that point, both just mean "no saved
 * searches", not a parse error.
 *
 * Coordinates are written/read as-is, with NO flipY() conversion:
 * rfManualX1/Y1/X2/Y2 in main.js are already in rfEngine's own Y-up target
 * space, the same convention the raw .tmd5 file itself uses (see
 * runRfManualSearch()'s own doc comment in main.js, and rfPoint.js) — so a
 * point/line read straight off the file is already in the right space, no
 * conversion needed either for the current format or the legacy one (the
 * legacy format's own points were written the same way, via the same
 * flipY(node.getLoc(), paperHeight) boundary crossing every other point in
 * the file goes through — see the old ReferenceQueries.js, now removed).
 */

const SAVED_SEARCH_TAG = 'rfsA';
const LEGACY_QUERY_TAG = 'rfqA';

/**
 * Write `tree.rfSavedQueries` (see its doc comment in tmTree.js) to `w`.
 * Must be called after every other section.
 */
export function writeSavedSearches(w, searches) {
  w.raw(SAVED_SEARCH_TAG);
  w.sizeT(searches.length);
  searches.forEach((search) => {
    w.bool(search.mode === 'line');
    w.float(search.x1);
    w.float(search.y1);
    w.float(search.x2);
    w.float(search.y2);
    w.sizeT(search.resultIndex || 0);
    w.sizeT(search.rank);
    w.float(search.error);
  });
}

// Consumes and returns true only if the next non-consumed line is exactly
// `expectedTag` — otherwise leaves the reader's cursor untouched (unlike
// blindly calling r.tag() and comparing after the fact, which would eat a
// mismatched line and desync whatever section actually follows). Treats
// running out of input, or only a trailing blank line remaining, as "not
// present" rather than an error, same convention as every other appended
// section in this file format.
function tryConsumeTag(r, expectedTag) {
  if (r.pos >= r.lines.length) return false;
  const rest = r.lines.slice(r.pos).join('');
  if (rest.trim() === '') return false;
  if (r.lines[r.pos].trim() !== expectedTag) return false;
  r.tag();
  return true;
}

function readNewEntry(r) {
  const mode = r.bool() ? 'line' : 'point';
  const x1 = r.float();
  const y1 = r.float();
  const x2 = r.float();
  const y2 = r.float();
  const resultIndex = r.sizeT();
  const rank = r.sizeT();
  const error = r.float();
  return { id: Math.random().toString(36).substr(2, 9), mode, x1, y1, x2, y2, resultIndex, rank, error };
}

// Structural skip for one fold-sequence step in the old `referenceQueries`
// wire format (writeStep() in the now-removed ReferenceQueries.js) — a
// migrated saved search keeps no step data, so this only needs to consume
// exactly the right number of lines to keep the cursor correctly
// positioned for whatever follows.
function skipLegacyStep(r) {
  r.raw(); // kind (not a 4-char tag, so not r.tag())
  r.sizeT(); // rank
  r.sizeT(); // index
  if (r.bool()) r.point();
  if (r.bool()) { r.float(); r.point(); }
  r.label(); // name
  r.label(); // whoMoves
  const numRefs = r.sizeT();
  for (let i = 0; i < numRefs; i += 1) r.sizeT();
}

// Reads one entry of the legacy `referenceQueries` format (writeReferenceQueries()
// in the now-removed ReferenceQueries.js) and migrates it into the new
// coordinate-only shape: keeps the searched point/line (already in file/
// rfEngine space, no flip needed — see this file's own doc comment) and the
// chosen result's rank/error, discards the node/path/edge pointer(s), the
// max-rank-used setting, and the fold-sequence steps.
function readLegacyEntry(r) {
  r.sizeT(); // index (unused; queries were never cross-referenced)
  const originKind = r.raw().trim(); // not r.tag(): not a 4-char tag
  let x1;
  let y1;
  let x2 = 0;
  let y2 = 0;
  const isLine = originKind === 'path' || originKind === 'edge';
  if (isLine) {
    r.ptr(); r.ptr(); // node1, node2 (discarded)
    const p1 = r.point();
    const p2 = r.point();
    x1 = p1.x; y1 = p1.y; x2 = p2.x; y2 = p2.y;
  } else {
    r.ptr(); // node (discarded)
    const p = r.point();
    x1 = p.x; y1 = p.y;
  }
  r.sizeT(); // maxRankUsed (unused)
  const error = r.float(); // achievedError
  const rank = r.sizeT(); // achievedRank
  const numSteps = r.sizeT();
  for (let i = 0; i < numSteps; i += 1) skipLegacyStep(r);
  return {
    id: Math.random().toString(36).substr(2, 9),
    mode: isLine ? 'line' : 'point',
    x1, y1, x2, y2,
    resultIndex: 0, // the legacy format never recorded which result was chosen
    rank, error
  };
}

/**
 * Read whatever saved-search data follows in `r` into an array of plain
 * `{ id, mode, x1, y1, x2, y2, resultIndex, rank, error }` records — the
 * exact shape tree.rfSavedQueries already uses. Recognizes both this app's
 * current
 * `rfsA` section and, for migrating an older file forward, the retired
 * `rfqA` (anchored-query) section — a file saved during the (brief) window
 * both existed has both, one right after the other, and both get merged
 * into the single returned array.
 *
 * Absence is not an error: a file written before either feature existed, a
 * real TreeMaker file, or one that simply ends at this point, all read back
 * as `[]`.
 */
export function readSavedSearches(r) {
  const searches = [];

  if (tryConsumeTag(r, LEGACY_QUERY_TAG)) {
    const count = r.sizeT();
    for (let i = 0; i < count; i += 1) searches.push(readLegacyEntry(r));
  }

  if (tryConsumeTag(r, SAVED_SEARCH_TAG)) {
    const count = r.sizeT();
    for (let i = 0; i < count; i += 1) searches.push(readNewEntry(r));
  }

  return searches;
}
