import { bindNumericInput, formatNumeric } from './ui/numericInput.js';
import { PI } from './model/index.js';
import { tmPoint, flipAngleDegrees } from './model/tmPoint.js';
import { tmNode } from './model/tmNode.js';
import { tmEdge } from './model/tmEdge.js';
import { tmTree, CPStatus } from './model/tmTree.js';
import { ConditionEdgeLengthFixed } from './model/conditions/ConditionEdgeLengthFixed.js';
import { ConditionNodesPaired } from './model/conditions/ConditionNodesPaired.js';
import { ConditionNodesCollinear } from './model/conditions/ConditionNodesCollinear.js';
import { ConditionEdgesSameStrain } from './model/conditions/ConditionEdgesSameStrain.js';
import { ConditionNodeCombo } from './model/conditions/ConditionNodeCombo.js';
import { ConditionPathActive } from './model/conditions/ConditionPathActive.js';
import { ConditionPathAngleFixed } from './model/conditions/ConditionPathAngleFixed.js';
import { ConditionPathAngleQuant } from './model/conditions/ConditionPathAngleQuant.js';
import { CanvasRenderer, FoldedFormRenderer } from './renderer/index.js';
import { NodeEditor } from './editor/index.js';
import { treeToTmd5, tmd5ToTree } from './model/io/Tmd5Format.js';
import { t, getLanguage, setLanguage, initI18n } from './i18n/i18n.js';
import { bindPersistedSelect, bindPersistedCheckbox } from './ui/persistedPrefs.js';
import * as rfClient from './referenceFinderClient.js';
import { showFoldDiagrams, resetFoldDiagrams, renderTargetSVG, renderResultSVG } from './rfDiagramView.js';

// Reveals .app-shell/#minWidthAlert/#busyOverlay (see the html:not(.app-ready)
// rule in index.html's inline critical CSS), replacing the "loading"
// screen — has to run before any layout-dependent setup below (notably
// `canvas.parentElement.getBoundingClientRect()` a bit further down, used
// to size the canvas for the very first render): .app-shell is
// `display: none` until this class is added, and every descendant's
// bounding rect — including the canvas's — reads as 0×0 while an ancestor
// is display:none, so sizing the canvas before this point silently leaves
// it at a 0×0 drawing surface forever (CSS can still stretch the ELEMENT
// to fill its box, but nothing painted on a 0×0 bitmap shows — the paper
// square never appeared, even though the canvas visually took up the
// right amount of space). A module script only starts running once the
// stylesheet immediately before it in <head> has already loaded (a
// render-blocking <link rel="stylesheet"> also blocks script execution,
// not just painting), so by the time this line runs the CSS is already
// in effect — no unstyled flash from doing this at the very top instead
// of waiting for the rest of this file's setup to finish.
document.documentElement.classList.add('app-ready');

// Get DOM elements
const canvas = document.getElementById('patternCanvas');
const treemakerLayer = document.getElementById('treemakerLayer');
const referenceFinderLayer = document.getElementById('referenceFinderLayer');
const foldedFormLayer = document.getElementById('foldedFormLayer');
const foldedFormSvg = document.getElementById('foldedFormSvg');
const hScrollTrack = document.getElementById('hScrollTrack');
const hScrollThumb = document.getElementById('hScrollThumb');
const vScrollTrack = document.getElementById('vScrollTrack');
const vScrollThumb = document.getElementById('vScrollThumb');
const paperWidthInput = document.getElementById('paperWidth');
const paperHeightInput = document.getElementById('paperHeight');
const scaleInput = document.getElementById('scale');
const paperSizeInchesInput = document.getElementById('paperSizeInches');
const showAllLabelsCheckbox = document.getElementById('showAllLabelsCheckbox');
// Always starts unchecked (see selectPartType.value = 'none' above for why
// this is set explicitly instead of trusting the unchecked default in the
// HTML — Firefox restores a checkbox's last state on a plain F5 reload too).
showAllLabelsCheckbox.checked = false;
const viewDesignBtn = document.getElementById('viewDesign');
const viewTreeBtn = document.getElementById('viewTree');
const viewCreasesBtn = document.getElementById('viewCreases');
const viewPlanBtn = document.getElementById('viewPlan');
const viewFoldedFormBtn = document.getElementById('viewFoldedForm');
const viewBlueprintBtn = document.getElementById('viewBlueprint');
const buildCpBtn = document.getElementById('buildCpBtn');
const killCpBtn = document.getElementById('killCpBtn');
const solverStatus = document.getElementById('solverStatus');
const scaleEverythingBtn = document.getElementById('scaleEverythingBtn');
const unpinAllBtn = document.getElementById('unpinAllBtn');
const scaleAllowDifferentLayoutCheckbox = document.getElementById('scaleAllowDifferentLayoutCheckbox');
const optimizationAlgorithmSelect = document.getElementById('optimizationAlgorithm');
const colorThemeSelect = document.getElementById('colorThemeSelect');
const scaleSelectionBtn = document.getElementById('scaleSelectionBtn');
const minimizeStrainBtn = document.getElementById('minimizeStrainBtn');
const selectPartType = document.getElementById('selectPartType');
// Firefox restores a <select>'s last value on a plain F5 reload even with
// the "selected" option set in the HTML (its own form-history feature,
// unrelated to any state this app persists) — autocomplete="off" on the
// element (index.html) mostly prevents it, but this forces "none" either
// way so a reload always lands on the documented default.
selectPartType.value = 'none';
const selectPartIndexList = document.getElementById('selectPartIndexList');
const selectPartIndexMultipleCheckbox = document.getElementById('selectPartIndexMultipleCheckbox');
// Always starts unchecked (see selectPartType.value = 'none' above for why
// this is set explicitly instead of trusting the unchecked default in the
// HTML — Firefox restores a checkbox's last state on a plain F5 reload too).
selectPartIndexMultipleCheckbox.checked = false;
// 1-based indexes added to the selection while "Multiple Selection" is
// checked, oldest first — unchecking the box (see its 'change' listener
// below) collapses the selection down to the last entry still selected
// (an index later toggled back OFF is removed from here too, so a click
// that *removes* an item never leaves it as the one kept), or to no
// selection at all if every added index was toggled back off. Cleared
// whenever the part type changes or the box is (re)checked, since a
// leftover index from a different type's list — or a previous
// multi-selection session — wouldn't mean anything here.
let additiveIndexSelectionOrder = [];
const selectAllBtn = document.getElementById('selectAllBtn');
const selectNodesAndEdgesBtn = document.getElementById('selectNodesAndEdgesBtn');
const selectNoneBtn = document.getElementById('selectNoneBtn');
const selectMovablePartsBtn = document.getElementById('selectMovablePartsBtn');
const selectPathFromNodesBtn = document.getElementById('selectPathFromNodesBtn');
const selectCorridorFacetsBtn = document.getElementById('selectCorridorFacetsBtn');
const facetJumpToPolyBtn = document.getElementById('facetJumpToPolyBtn');
const editMakeRootBtn = document.getElementById('editMakeRootBtn');
const editPerturbSelectedBtn = document.getElementById('editPerturbSelectedBtn');
const editPerturbAllBtn = document.getElementById('editPerturbAllBtn');
const editSetLengthBtn = document.getElementById('editSetLengthBtn');
const editScaleLengthBtn = document.getElementById('editScaleLengthBtn');
const editRenormalizeSelectionBtn = document.getElementById('editRenormalizeSelectionBtn');
const editRenormalizeUnitScaleBtn = document.getElementById('editRenormalizeUnitScaleBtn');
const editAbsorbSelectedNodeBtn = document.getElementById('editAbsorbSelectedNodeBtn');
const editAbsorbRedundantNodesBtn = document.getElementById('editAbsorbRedundantNodesBtn');
const editAbsorbSelectedEdgeBtn = document.getElementById('editAbsorbSelectedEdgeBtn');
const editSplitBtn = document.getElementById('editSplitBtn');
const editRemoveSelectionStrainBtn = document.getElementById('editRemoveSelectionStrainBtn');
const editRemoveAllStrainBtn = document.getElementById('editRemoveAllStrainBtn');
const editRelieveSelectionStrainBtn = document.getElementById('editRelieveSelectionStrainBtn');
const editRelieveAllStrainBtn = document.getElementById('editRelieveAllStrainBtn');
const editPickStubNodesBtn = document.getElementById('editPickStubNodesBtn');
const editPickStubPolyBtn = document.getElementById('editPickStubPolyBtn');
const editStubChoices = document.getElementById('editStubChoices');
const editAddPickedStubBtn = document.getElementById('editAddPickedStubBtn');
const editAddLargestStubNodesBtn = document.getElementById('editAddLargestStubNodesBtn');
const editAddLargestStubPolyBtn = document.getElementById('editAddLargestStubPolyBtn');
const saveTmd5Btn = document.getElementById('saveTmd5Btn');
const loadTmd5Btn = document.getElementById('loadTmd5Btn');
const loadTmd5Input = document.getElementById('loadTmd5Input');
const loadedFileNameInput = document.getElementById('loadedFileNameInput');
const fitToWidthBtn = document.getElementById('fitToWidthBtn');
const fitToHeightBtn = document.getElementById('fitToHeightBtn');
const vertexListBtn = document.getElementById('vertexListBtn');
const vertexListOverlay = document.getElementById('vertexListOverlay');
const vertexListRealPaperWidthInput = document.getElementById('vertexListRealPaperWidth');
const vertexListSortOrderSelect = document.getElementById('vertexListSortOrder');
const vertexListApplyBtn = document.getElementById('vertexListApplyBtn');
const vertexListExportBtn = document.getElementById('vertexListExportBtn');
const vertexListCloseBtn = document.getElementById('vertexListCloseBtn');
const vertexListBody = document.getElementById('vertexListBody');
const aboutBtn = document.getElementById('aboutBtn');
const aboutOverlay = document.getElementById('aboutOverlay');
const aboutCloseBtn = document.getElementById('aboutCloseBtn');
const resetBtn = document.getElementById('resetBtn');
const editResetBtn = document.getElementById('editResetBtn');
const busyOverlay = document.getElementById('busyOverlay');
const busyCancelBtn = document.getElementById('busyCancelBtn');
const busyMessage = document.getElementById('busyMessage');
const promptOverlay = document.getElementById('promptOverlay');
const promptTitle = document.getElementById('promptTitle');
const promptFieldsContainer = document.getElementById('promptFields');
const promptOkBtn = document.getElementById('promptOkBtn');
const promptCancelBtn = document.getElementById('promptCancelBtn');
const messageDialogOverlay = document.getElementById('messageDialogOverlay');
const messageDialogBox = messageDialogOverlay.querySelector('.message-box');
const messageDialogTitle = document.getElementById('messageDialogTitle');
const messageDialogText = document.getElementById('messageDialogText');
const messageDialogList = document.getElementById('messageDialogList');
const messageDialogOkBtn = document.getElementById('messageDialogOkBtn');

/**
 * In-app replacement for window.alert(): every error/warning message this
 * app shows now goes through here instead, so it renders as a styled modal
 * (title + message + an optional bullet list) rather than the browser's
 * native alert() — unstyled, blocks the whole tab, and (per user report,
 * about Build Crease Pattern's diagnosis specifically) reads as unclear
 * when the message is more than one short sentence.
 * `severity` only changes the left border/title color (see .message-box.*
 * in style.css): 'error' for failed operations (file I/O exceptions),
 * 'warning' (the default) for validation/diagnostic messages. `items`, when
 * given, renders as a bullet list below `message` — e.g. one line per
 * infeasible condition, or per part type a failed Build Crease Pattern
 * flagged.
 */
// A load that both had to skip conditions the file couldn't reconstruct AND
// leaves the tree infeasible calls showMessageDialog() twice back to back
// (see checkFeasibilityAfterLoad()/applyLoadedTmd5Text() below) — without a
// queue the second call would just overwrite the first before the user ever
// saw it, since both happen in the same synchronous tick. Anything called
// while a dialog is already up waits its turn instead.
let messageDialogQueue = [];

function showMessageDialog(options) {
  if (messageDialogOverlay.style.display === 'flex') {
    messageDialogQueue.push(options);
    return;
  }
  renderMessageDialog(options);
}

function renderMessageDialog({ title, message = '', items = [], severity = 'warning' }) {
  messageDialogBox.classList.remove('error', 'warning');
  messageDialogBox.classList.add(severity);
  messageDialogTitle.classList.remove('error', 'warning');
  messageDialogTitle.classList.add(severity);
  messageDialogTitle.textContent = title;
  messageDialogText.textContent = message;
  messageDialogText.style.display = message ? 'block' : 'none';
  messageDialogList.replaceChildren();
  if (items.length > 0) {
    for (const item of items) {
      const li = document.createElement('li');
      li.textContent = item;
      messageDialogList.appendChild(li);
    }
  }
  messageDialogList.style.display = items.length > 0 ? 'block' : 'none';

  messageDialogOverlay.style.display = 'flex';
  messageDialogOkBtn.focus();

  function close() {
    messageDialogOverlay.style.display = 'none';
    messageDialogOkBtn.removeEventListener('click', handleOk);
    document.removeEventListener('keydown', handleKeydown);
    const next = messageDialogQueue.shift();
    if (next) renderMessageDialog(next);
  }
  function handleOk() {
    close();
  }
  function handleKeydown(e) {
    if (e.key === 'Enter' || e.key === 'Escape') handleOk();
  }
  messageDialogOkBtn.addEventListener('click', handleOk);
  document.addEventListener('keydown', handleKeydown);
}

/**
 * Reusable modal for one or more parameters: a button or toggle that needs
 * a value before it can act (an angle, a count, a length...) calls this
 * instead of building its own dialog. One label+input pair per entry in
 * `fields`, in order; `onConfirm` gets their values back the same way, as
 * an array of strings. Only one prompt is ever open at a time — a second
 * call while one is already showing replaces it, same as a native
 * confirm() would.
 *
 * A field with a `numeric` option gets this app's standard numeric-field
 * behavior (see src/ui/numericInput.js): '.' as the only decimal
 * separator (',' maps to it), capped decimals while typing, and the value
 * clamped to [min, max] once it loses focus — but Enter/OK here can
 * confirm the modal without ever blurring the field, so `onConfirm` still
 * needs its own clamp/validation for anything with a `numeric` option
 * (see the Scale Length handler for an example).
 *
 * @param {{title: string, fields: {label: string, defaultValue?: string, numeric?: {min?: number, max?: number, decimals?: number}}[], onConfirm: (values: string[]) => void, onCancel?: () => void}} options
 */
function promptForFields({ title, fields, onConfirm, onCancel }) {
  promptTitle.textContent = title;
  promptFieldsContainer.replaceChildren();
  const inputs = fields.map((field, i) => {
    const row = document.createElement('div');
    row.className = 'prompt-field';
    const label = document.createElement('label');
    label.textContent = field.label;
    label.setAttribute('for', `promptField${i}`);
    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.id = `promptField${i}`;
    input.className = 'prompt-input';
    input.autocomplete = 'off';
    input.value = field.defaultValue ?? '';
    if (field.numeric) bindNumericInput(input, field.numeric);
    row.append(label, input);
    promptFieldsContainer.appendChild(row);
    return input;
  });
  promptOverlay.style.display = 'flex';
  inputs[0]?.focus();
  inputs[0]?.select();

  function close() {
    promptOverlay.style.display = 'none';
    promptOkBtn.removeEventListener('click', handleOk);
    promptCancelBtn.removeEventListener('click', handleCancel);
    promptFieldsContainer.removeEventListener('keydown', handleKeydown);
  }
  function handleOk() {
    close();
    onConfirm(inputs.map(input => input.value));
  }
  function handleCancel() {
    close();
    onCancel?.();
  }
  function handleKeydown(e) {
    if (e.key === 'Enter') handleOk();
    else if (e.key === 'Escape') handleCancel();
  }
  promptOkBtn.addEventListener('click', handleOk);
  promptCancelBtn.addEventListener('click', handleCancel);
  promptFieldsContainer.addEventListener('keydown', handleKeydown);
}

/** Convenience wrapper over promptForFields() for the common one-value case. */
function promptForNumber({ title, label, defaultValue, onConfirm, onCancel }) {
  promptForFields({
    title,
    fields: [{ label, defaultValue }],
    onConfirm: (values) => onConfirm(values[0]),
    onCancel
  });
}

/**
 * Split Edge dialog — equivalent to tmwxSplitEdgeDialog (see
 * tmwxDoc_Edit.cpp in the original source): two mutually-exclusive ways to
 * say where to split (an absolute distance from the edge's first node, or
 * a ratio of its length), each with its own valid range, only one enabled
 * at a time. That shape doesn't fit promptForFields()'s plain label+input
 * list, so this builds the modal body directly instead, reusing the same
 * overlay/title/buttons.
 */
function openSplitEdgeDialog(edge) {
  const length = edge.getStrainedLength();
  const node1 = edge.getNode(0);
  const node2 = edge.getNode(1);
  const edgeLabel = edge.getLabel() || `${node1.label} - ${node2.label}`;

  promptTitle.textContent = t('edit.splitEdgeDialogTitle');
  promptFieldsContainer.replaceChildren();

  const info1 = document.createElement('p');
  info1.className = 'prompt-info';
  info1.textContent = t('edit.splitInfoLine', { edge: edgeLabel, a: node1.label, b: node2.label, length: length.toFixed(4) });
  const info2 = document.createElement('p');
  info2.className = 'prompt-info';
  info2.textContent = t('edit.splitDistanceFromNode', { node: node1.label });

  const absRadio = document.createElement('input');
  absRadio.type = 'radio';
  absRadio.name = 'splitMode';
  const absLabel = document.createElement('label');
  absLabel.append(absRadio, document.createTextNode(t('edit.splitAbsoluteLabel', { max: length.toFixed(4) })));
  const absInput = document.createElement('input');
  absInput.type = 'text';
  absInput.inputMode = 'decimal';
  absInput.className = 'prompt-input';
  absInput.value = (length / 2).toFixed(4);
  absInput.disabled = true;
  bindNumericInput(absInput, { min: 0, max: length, decimals: 4 });
  const absRow = document.createElement('div');
  absRow.className = 'prompt-radio-row';
  absRow.append(absLabel, absInput);

  const ratioRadio = document.createElement('input');
  ratioRadio.type = 'radio';
  ratioRadio.name = 'splitMode';
  ratioRadio.checked = true;
  const ratioLabel = document.createElement('label');
  ratioLabel.append(ratioRadio, document.createTextNode(t('edit.splitRatio')));
  const ratioInput = document.createElement('input');
  ratioInput.type = 'text';
  ratioInput.inputMode = 'decimal';
  ratioInput.className = 'prompt-input';
  ratioInput.value = '0.5000';
  bindNumericInput(ratioInput, { min: 0, max: 1, decimals: 4 });
  const ratioRow = document.createElement('div');
  ratioRow.className = 'prompt-radio-row';
  ratioRow.append(ratioLabel, ratioInput);

  promptFieldsContainer.append(info1, info2, absRow, ratioRow);

  function syncEnabled(focusInput) {
    absInput.disabled = !absRadio.checked;
    ratioInput.disabled = !ratioRadio.checked;
    focusInput.focus();
    focusInput.select();
  }
  function handleAbsChange() {
    syncEnabled(absInput);
  }
  function handleRatioChange() {
    syncEnabled(ratioInput);
  }
  absRadio.addEventListener('change', handleAbsChange);
  ratioRadio.addEventListener('change', handleRatioChange);

  promptOverlay.style.display = 'flex';
  ratioInput.focus();
  ratioInput.select();

  function close() {
    promptOverlay.style.display = 'none';
    promptOkBtn.removeEventListener('click', handleOk);
    promptCancelBtn.removeEventListener('click', handleCancel);
    promptFieldsContainer.removeEventListener('keydown', handleKeydown);
    absRadio.removeEventListener('change', handleAbsChange);
    ratioRadio.removeEventListener('change', handleRatioChange);
  }
  function handleOk() {
    const isDistance = absRadio.checked;
    const raw = isDistance ? absInput.value : ratioInput.value;
    const value = Number(raw);
    close();
    if (!Number.isFinite(value)) {
      showMessageDialog({ title: t('edit.splitEdgeDialogTitle'), message: t('edit.msgInvalidSplit', { value: raw }) });
      return;
    }
    try {
      editor.splitSelectedEdge(value, isDistance);
      commitAndRender();
    } catch (error) {
      showMessageDialog({ title: t('edit.splitEdgeDialogTitle'), message: t('edit.msgInvalidSplit', { value: raw }) });
    }
  }
  function handleCancel() {
    close();
  }
  function handleKeydown(e) {
    if (e.key === 'Enter') handleOk();
    else if (e.key === 'Escape') handleCancel();
  }
  promptOkBtn.addEventListener('click', handleOk);
  promptCancelBtn.addEventListener('click', handleCancel);
  promptFieldsContainer.addEventListener('keydown', handleKeydown);
}

const scaleLabel = document.getElementById('scaleLabel');
const hoverInfoLabel = document.getElementById('hoverInfoLabel');
// Scale's own cell in the canvas status bar is always visible (unlike the
// pointed-object one next to it). Initialized to tree.getScale() at
// startup and after Reset/Revert (a fresh tree's own scale, not just a
// placeholder), then to whatever a "Maximize Scale" run converges to —
// null (rendered as just the word "Scale", no number) is only a defensive
// fallback for the case neither has happened yet. Kept separate from
// state.lastSolverResult (the generic "Not solved yet" chip's own state)
// since that's shared with Scale Selection/Minimize Strain results, which
// don't carry a comparable .scale value.
let lastConvergedScale = null;
function renderScaleLabel() {
  scaleLabel.textContent = lastConvergedScale === null
    ? t('tree.scale')
    : t('canvas.scaleLabel', { n: lastConvergedScale.toFixed(4) });
}

// Properties panel
const propertiesPanel = document.getElementById('propertiesPanel');
const propertiesPanelTitle = document.getElementById('propertiesPanelTitle');
const propertiesPanelCloseBtn = document.getElementById('propertiesPanelCloseBtn');
const projectProperties = document.getElementById('projectProperties');
const selectionProperties = document.getElementById('selectionProperties');
const selectionSummary = document.getElementById('selectionSummary');
const selectionComboEditor = document.getElementById('selectionComboEditor');
const selComboNotLeaf = document.getElementById('selComboNotLeaf');
const selFixToSymmetryLineCheckbox = document.getElementById('selFixToSymmetryLine');
const selFixToPaperEdgeCheckbox = document.getElementById('selFixToPaperEdge');
const selFixToPaperCornerCheckbox = document.getElementById('selFixToPaperCorner');
const selFixToPositionCheckbox = document.getElementById('selFixToPosition');
const selFixToPositionLabel = document.getElementById('selFixToPositionLabel');
const selPairEditor = document.getElementById('selPairEditor');
const selPairToggle = document.getElementById('selPairToggle');
const selCollinearEditor = document.getElementById('selCollinearEditor');
const selCollinearToggle = document.getElementById('selCollinearToggle');
const selNoStrainEditor = document.getElementById('selNoStrainEditor');
const selNoStrainToggle = document.getElementById('selNoStrainToggle');
const selSameStrainEditor = document.getElementById('selSameStrainEditor');
const selSameStrainToggle = document.getElementById('selSameStrainToggle');
const rfCreaseChainDivider = document.getElementById('rfCreaseChainDivider');
const rfCreaseChainTitle = document.getElementById('rfCreaseChainTitle');
const rfCreaseChainNotSameLine = document.getElementById('rfCreaseChainNotSameLine');
const rfCreaseChainElements = {
  searchBtn: document.getElementById('rfCreaseChainSearchBtn')
};
const symmetryType = document.getElementById('symmetryType');
const symmetryCards = [...symmetryType.querySelectorAll('.symmetry-card')];

function getSymmetryValue() {
  return symmetryCards.find(card => card.classList.contains('active'))?.dataset.value ?? 'none';
}

function setSymmetryValue(value) {
  for (const card of symmetryCards) card.classList.toggle('active', card.dataset.value === value);
}

const symLocXInput = document.getElementById('symLocX');
const symLocYInput = document.getElementById('symLocY');
const symAngleInput = document.getElementById('symAngle');
const languageSelect = document.getElementById('languageSelect');
const nodeProperties = document.getElementById('nodeProperties');
const edgeProperties = document.getElementById('edgeProperties');
const nodeLabelInput = document.getElementById('nodeLabel');
const nodeXInput = document.getElementById('nodeX');
const nodeYInput = document.getElementById('nodeY');
const nodeApplyPositionBtn = document.getElementById('nodeApplyPosition');
const edgeLengthInput = document.getElementById('edgeLength');
const edgeStrainInput = document.getElementById('edgeStrain');
const edgeStiffnessInput = document.getElementById('edgeStiffness');
const edgeApplyPropertiesBtn = document.getElementById('edgeApplyProperties');
const edgeScaleLengthBtn = document.getElementById('edgeScaleLengthBtn');
const edgeRenormalizeSelectionBtn = document.getElementById('edgeRenormalizeSelectionBtn');
const edgeAbsorbBtn = document.getElementById('edgeAbsorbBtn');
const edgeSplitBtn = document.getElementById('edgeSplitBtn');
const edgeRemoveStrainBtn = document.getElementById('edgeRemoveStrainBtn');
const edgeRelieveStrainBtn = document.getElementById('edgeRelieveStrainBtn');
const nodeDeleteBtn = document.getElementById('nodeDelete');
const nodeUnpinBtn = document.getElementById('nodeUnpin');
const nodeMakeRootBtn = document.getElementById('nodeMakeRootBtn');
const nodeAbsorbBtn = document.getElementById('nodeAbsorbBtn');
const nodePerturbBtn = document.getElementById('nodePerturbBtn');
const nodeComboEditor = document.getElementById('nodeComboEditor');
const nodeComboNotLeaf = document.getElementById('nodeComboNotLeaf');
const nodeFixToSymmetryLineCheckbox = document.getElementById('nodeFixToSymmetryLine');
const nodeFixToPaperEdgeCheckbox = document.getElementById('nodeFixToPaperEdge');
const nodeFixToPaperCornerCheckbox = document.getElementById('nodeFixToPaperCorner');
const nodeFixToPositionCheckbox = document.getElementById('nodeFixToPosition');
const nodeFixToPositionLabel = document.getElementById('nodeFixToPositionLabel');
const conditionList = document.getElementById('conditionList');
const conditionListPanel = document.getElementById('conditionListPanel');
const feasibilityChip = document.getElementById('feasibilityChip');
const feasibilityChipText = document.getElementById('feasibilityChipText');
const rfSavedQueriesPanel = document.getElementById('rfSavedQueriesPanel');
const rfSavedQueriesList = document.getElementById('rfSavedQueriesList');
const edgeDeleteBtn = document.getElementById('edgeDelete');
const edgeNoStrainCheckbox = document.getElementById('edgeNoStrain');
const rfEdgeElements = {
  searchBtn: document.getElementById('rfEdgeSearchBtn')
};

// Path panel
const pathProperties = document.getElementById('pathProperties');
const pathMinTreeLength = document.getElementById('pathMinTreeLength');
const pathActTreeLength = document.getElementById('pathActTreeLength');
const pathAngle = document.getElementById('pathAngle');
const pathActiveToggle = document.getElementById('pathActiveToggle');
const pathFixAngleToggle = document.getElementById('pathFixAngleToggle');
const pathFixAngleLabel = document.getElementById('pathFixAngleLabel');
const pathQuantizeToggle = document.getElementById('pathQuantizeToggle');
const pathQuantizeLabel = document.getElementById('pathQuantizeLabel');

// ReferenceFinder sections (node and path panels)
const rfNodeElements = {
  searchBtn: document.getElementById('rfNodeSearchBtn')
};
const rfPathElements = {
  searchBtn: document.getElementById('rfPathSearchBtn')
};

// Reference Finder manual search panel: the single place a search's results
// and fold sequence are shown, whether the search was typed by hand here or
// triggered by a "Find reference" button in a part's own Inspector panel
// (see activateOriginSearch() below). Saving (rfManualSaveBtn) always just
// records the raw coordinates, regardless of which triggered it.
const rfManualDetails = document.getElementById('rfManualDetails');
const rfManualHint = document.getElementById('rfManualHint');
const rfManualProperties = document.getElementById('rfManualProperties');
const rfManualModePoint = document.getElementById('rfManualModePoint');
const rfManualModeLine = document.getElementById('rfManualModeLine');
// Firefox restores a radio group's last-checked state on a plain page
// reload (see the paperSizeInches/paperWidth/symLocX inputs for the same
// pattern elsewhere), which would leave "Line" checked while the X2/Y2
// inputs stay disabled (matching the HTML's static Point-mode markup,
// since syncRfManualModeFields() only runs on a 'change' event, never on
// load) — force the documented default explicitly instead of trusting
// whatever the browser tried to restore.
rfManualModePoint.checked = true;
rfManualModeLine.checked = false;
const rfManualX1 = document.getElementById('rfManualX1');
const rfManualY1 = document.getElementById('rfManualY1');
const rfManualX2 = document.getElementById('rfManualX2');
const rfManualY2 = document.getElementById('rfManualY2');

const rfManualSearchBtn = document.getElementById('rfManualSearchBtn');
const rfManualNoResults = document.getElementById('rfManualNoResults');
const rfManualSaveBtn = document.getElementById('rfManualSaveBtn');
const rfTargetSvg = document.getElementById('rfTargetSvg');
const rfResultCards = document.getElementById('rfResultCards');

// Vertex panel
const vertexProperties = document.getElementById('vertexProperties');
const rfVertexElements = {
  searchBtn: document.getElementById('rfVertexSearchBtn')
};

// Crease panel
const creaseProperties = document.getElementById('creaseProperties');
const rfCreaseElements = {
  searchBtn: document.getElementById('rfCreaseSearchBtn')
};

// Facet panel
const facetProperties = document.getElementById('facetProperties');

// Poly panel
const polyProperties = document.getElementById('polyProperties');

// Group panel
const selectionCounts = document.getElementById('selectionCounts');

// Initialize TreeMaker model
const tree = new tmTree();
tree.setPaperWidth(1.0);
tree.setPaperHeight(1.0);
// Matches tmTree::MakeTreeBlank() in the original: a brand-new document
// starts at scale 0.1, not the tmTree class's own constructor default of
// 0.2 (which is what a bare `new tmTree()` gets, but not what "New" uses).
tree.setScale(0.1);

// This app's standard numeric-field format (see src/ui/numericInput.js) —
// paper-relative coordinates, bounded by the paper's own size (which
// defaults to exactly [0, 1], the common unit-square case, but can be
// resized). Inputs with a different valid range (edge length/strain/
// stiffness, angles, etc.) keep their own handling for now.
for (const input of [symLocXInput, nodeXInput, rfManualX1, rfManualX2]) {
  bindNumericInput(input, { min: 0, max: () => tree.getPaperWidth() });
}
for (const input of [symLocYInput, nodeYInput, rfManualY1, rfManualY2]) {
  bindNumericInput(input, { min: 0, max: () => tree.getPaperHeight() });
}
bindNumericInput(paperWidthInput, { min: 0.1, max: 10 });
bindNumericInput(paperHeightInput, { min: 0.1, max: 10 });
bindNumericInput(scaleInput, { min: 0.1, max: 10 });
// Degrees, not a paper-relative fraction: its own range and precision.
bindNumericInput(symAngleInput, { min: 0, max: 360, decimals: 2 });
// Screen size in inches, not a paper-relative fraction — 2 integer digits
// (max 99) and 2 decimals, same display precision render() already used
// via toFixed(2) before this became a governed field.
bindNumericInput(paperSizeInchesInput, { min: 0.1, max: 99.99, decimals: 2 });
// Vertex List modal's "Real paper width": a physical measurement, not a
// paper-relative fraction — 3 integer digits (max 999) and 2 decimals.
bindNumericInput(vertexListRealPaperWidthInput, { min: 0, max: 999.99, decimals: 2 });
// Any non-negative value, not a paper-relative [0, 1] fraction — a real
// edge's length/strain/stiffness can legitimately exceed 1 (e.g. a
// diagonal edge is already longer than that on a unit-square paper). No
// upper cap either: large values are valid input, just not necessarily
// ones the solver/build pipeline will handle gracefully (see PENDIENTE.md).
for (const input of [edgeLengthInput, edgeStrainInput, edgeStiffnessInput]) {
  bindNumericInput(input, { min: 0, max: Infinity });
}

// Initialize renderer
const renderer = new CanvasRenderer(canvas);
const foldedFormRenderer = new FoldedFormRenderer(foldedFormSvg);
renderer.setTree(tree);
const initialCanvasRect = canvas.parentElement.getBoundingClientRect();
renderer.onResize(initialCanvasRect.width, initialCanvasRect.height);
renderer.fitViewport();

// Initialize editor
const editor = new NodeEditor(renderer, tree);
window.__debugTree = tree;
window.__debugEditor = editor;
window.__debugRenderer = renderer;
// Application state
const state = {
  tree: tree,
  renderer: renderer,
  editor: editor,
  isDirty: true,
  lastSolverResult: undefined,
  lastSolverError: null
};

// ===== UNDO/REDO =====
// Snapshot-based: each undo step is a full JSON clone of the tree (already
// available via tmTree.toJSON()/fromJSON(), used for save/load). This is
// far simpler than a command pattern for a model with this many mutation
// sites, at the cost of only being able to undo/redo whole-tree changes
// (fine here, since there's no other undoable state). Snapshots are only
// taken at the end of discrete, completed actions (button clicks, applied
// conditions, a finished node drag on mouseup, etc.) via commitHistory() —
// never from the continuous per-frame mousemove/hover redraw path — so
// dragging a node across many animation frames becomes a single undo step,
// not one per frame.
const HISTORY_LIMIT = 100;
const undoBtn = document.getElementById('undoBtn');
const redoBtn = document.getElementById('redoBtn');
let undoStack = [];
let redoStack = [];
let historySnapshot = JSON.stringify(tree.toJSON());
let isRestoringHistory = false;

function updateHistoryButtons() {
  undoBtn.disabled = undoStack.length === 0;
  redoBtn.disabled = redoStack.length === 0;
}

/**
 * Records the tree's current state as a new undo step, if (and only if) it
 * actually differs from the last recorded snapshot. Safe to call after any
 * action, mutating or not — a no-op action just finds no difference.
 */
function commitHistory() {
  if (isRestoringHistory) return;
  const current = JSON.stringify(tree.toJSON());
  if (current === historySnapshot) return;
  undoStack.push(historySnapshot);
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack = [];
  historySnapshot = current;
  updateHistoryButtons();
}

// Recomputes every piece of state that's "derived from the tree" rather
// than stored directly on it — refreshPathStates() (border/pinned/active
// path coloring, path-condition feasibility) and refreshFeasibilityChip()
// (the persistent sidebar warning) today, whatever else joins them later.
// Both commitAndRender() (after a normal edit) and restoreHistorySnapshot()
// (after undo/redo) need this, and it lives here — one place — precisely
// because it didn't used to: refreshFeasibilityChip() was first wired into
// commitAndRender() alone, and undo/redo silently kept showing the
// pre-undo/redo feasibility state until that gap was found (toggle an
// unsatisfiable condition, Undo, and the chip still reported it with
// nothing left in Active Conditions to investigate) and patched into
// restoreHistorySnapshot() separately — the same kind of gap a third
// derived-state addition could just as easily reintroduce if it only
// remembered one of the two call sites. Equivalent to
// tmTree::CleanupAfterEdit() running after every edit, for the
// refreshPathStates() half: the yellow/green/red path lines and pinned
// blue/cyan edges are derived from geometry, but nothing recomputes them
// just from adding or dragging a node — only the optimizer commands
// (Maximize Scale, Scale Selection, ...) called refreshPathStates()
// themselves, so none of that ever showed up until the tree had gone
// through one of those at least once.
function refreshDerivedTreeState() {
  tree.refreshPathStates();
  // Recomputed once per call here, never from the per-frame
  // animate()->render() loop — a node mid-drag only sets state.isDirty
  // (see the canvas mousemove handler), it doesn't reach commitAndRender()
  // until mouseup. That's deliberate: being momentarily "infeasible" while
  // a node is mid-drag is normal and shouldn't flash a warning on every
  // animation frame, only the settled state after the gesture (or an
  // undo/redo) ends should.
  refreshFeasibilityChip();
}

function commitAndRender() {
  refreshDerivedTreeState();
  // Order matters: render() (via updatePropertiesPanel()) can have side
  // effects on the tree — e.g. tree.getPath() lazily caches newly-queried
  // paths onto tree.paths the first time a panel asks for one. Snapshotting
  // before render() would let that leak into the very next commit as a
  // spurious extra undo step, since the "settled" state (after those
  // side effects) wouldn't match what was just recorded.
  state.isDirty = true;
  render();
  commitHistory();
}

function restoreHistorySnapshot(json) {
  isRestoringHistory = true;
  const restored = tmTree.fromJSON(JSON.parse(json));
  Object.assign(tree, restored);
  tree.refreshNodeClassification();
  // isPinnedNode/isPinnedEdge (the blue/cyan edge coloring) are derived from
  // geometry, not serialized tree state — refreshDerivedTreeState()'s
  // refreshPathStates() half recomputes them (see _refreshPinnedStatus())
  // from whatever positions/scale this snapshot restored. Without this,
  // undo/redo always came back with every edge blue, even right after a
  // Maximize Scale/Scale Selection that had pinned some of them, since
  // nothing else recomputes it after a restore. See refreshDerivedTreeState()
  // itself for why this and commitAndRender() share the one function.
  refreshDerivedTreeState();
  renderer.setTree(tree);
  editor.tree = tree;
  editor.clearSelection();
  paperWidthInput.value = formatNumeric(tree.getPaperWidth());
  paperHeightInput.value = formatNumeric(tree.getPaperHeight());
  scaleInput.value = tree.getScale().toFixed(4);
  setSymmetryValue(tree.getSymmetryType());
  symLocXInput.value = formatNumeric(tree.getSymLoc().x);
  symLocYInput.value = formatNumeric(tree.getSymLoc().y);
  symAngleInput.value = formatNumeric(flipAngleDegrees(tree.getSymAngle()), 2);
  syncSymmetryFieldsEnabled();
  state.isDirty = true;
  render();
  // Recompute from the tree rather than reusing `json` as-is: render()'s
  // side effects (see commitAndRender()) may have added lazily-cached
  // paths, so the settled state can differ slightly from what was passed
  // in — recording the pre-render snapshot here would make the very next
  // action's commitHistory() see a spurious diff.
  historySnapshot = JSON.stringify(tree.toJSON());
  isRestoringHistory = false;
  updateHistoryButtons();
}

function undo() {
  if (undoStack.length === 0) return;
  const current = JSON.stringify(tree.toJSON());
  redoStack.push(current);
  restoreHistorySnapshot(undoStack.pop());
}

function redo() {
  if (redoStack.length === 0) return;
  const current = JSON.stringify(tree.toJSON());
  undoStack.push(current);
  restoreHistorySnapshot(redoStack.pop());
}

undoBtn.addEventListener('click', undo);
redoBtn.addEventListener('click', redo);
updateHistoryButtons();

// Soft pastel wash shared by Blueprint View's reference circles and river
// strips, so the whole circle/river packing reads as one visual layer
// distinct from the black/gray crease skeleton drawn over it.
const BLUEPRINT_WASH_COLOR = 'rgba(173, 216, 230, 0.35)';

const VIEW_PRESETS = {
  // Equivalent to tmwxViewSettings::sDesignView: both the tree and the
  // crease pattern (once built) are shown together — the default view,
  // useful for both adding/moving nodes and inspecting the base. The
  // leaf-to-leaf "closing" paths (yellow while merely feasible, green once
  // actually taut) are visible from the start, the way they always were in
  // the original.
  // Equivalent to tmwxViewSettings::sDesignView/sTreeView/sCreasesView/
  // sPlanView's mShowNodeConditions/mShowEdgeConditions/mShowConditionDots/
  // mShowConditionLines fields: conditions are visible in Design and Tree,
  // hidden in Creases and Plan.
  // `circles` is mShowNodeCircles: on only in Design, off in Tree/Creases/
  // Plan — the reference circles are a Design-time aid for placing leaf
  // nodes, not part of the other views' purpose.
  // `creases`/`creaseFolds` are mShowMajorCreases+mShowMinorCreases and
  // mShowCreaseFolds: Tree View ("only nodes, edges, and conditions are
  // shown" per help/menus.htm) hides the crease pattern entirely; Design
  // shows it in AGRH (structural-role) coloring, while Creases/Plan show it
  // in MVF (fold-direction) coloring — see help/menus.htm, Action->Build
  // Crease Pattern.
  // `vertexDots`/`vertexCoords` are mShowVertexDots/mShowVertexCoords: Plan
  // View is "the same as Creases View but also shows the coordinates of
  // the major vertices" (help/menus.htm, View->Plan View) — a dot in
  // Creases (were it to show vertices, which it doesn't), coordinate text
  // instead of a dot in Plan. Facets, paths and polys are off in every view
  // here except Design (facet/path/poly groups are all-0 in sTreeView/
  // sCreasesView/sPlanView too).
  // `minorCreases` is mShowMinorCreases (help/windows.htm: "Minor Creases
  // ... are hinge and pseudohinge creases", as opposed to "Major Creases
  // ... axial, gusset, and ridge") — on in every real original view, off
  // only in Blueprint, this SPA's own addition (not in the original
  // TreeMaker), which shows just the structural skeleton.
  design: { nodes: true, edges: true, creases: true, creaseFolds: false, minorCreases: true, vertices: false, vertexDots: true, vertexCoords: false, polys: true, facets: false, paths: true, conditions: true, labels: true, circles: true },
  tree: { nodes: true, edges: true, creases: false, creaseFolds: true, minorCreases: true, vertices: false, vertexDots: true, vertexCoords: false, polys: false, facets: false, paths: false, conditions: true, labels: true, circles: false },
  creases: { nodes: false, edges: false, creases: true, creaseFolds: true, minorCreases: true, vertices: false, vertexDots: true, vertexCoords: false, polys: false, facets: false, paths: false, conditions: false, labels: false, circles: false },
  plan: { nodes: false, edges: false, creases: true, creaseFolds: true, minorCreases: true, vertices: true, vertexDots: false, vertexCoords: true, polys: false, facets: false, paths: false, conditions: false, labels: false, circles: false },
  // Blueprint: this SPA's own view, not a port of anything in the original
  // TreeMaker — Robert J. Lang's tree-theory reference circles and river
  // strips (both filled with BLUEPRINT_WASH_COLOR, see CanvasRenderer.
  // _drawRivers()) plus just the structural skeleton (major creases only,
  // drawn black/gray via monochromeCreases instead of AGRH's red ridge
  // color) and real node names (onlyCustomLabels skips the auto-numbered
  // default), with none of the working-mode clutter (node/edge markers,
  // conditions, polys/facets/paths). `corridorSegments` is this SPA's own
  // addition too: distinctly-colors every piece an internal facet-corridor
  // gets cut into wherever a loose triangle overlaps it — see
  // tmTree.getCorridorSegments() and CanvasRenderer._drawCorridorSegments().
  blueprint: { nodes: false, edges: false, creases: true, creaseFolds: false, minorCreases: false, monochromeCreases: true, vertices: false, vertexDots: false, vertexCoords: false, polys: false, facets: false, paths: false, conditions: false, labels: true, onlyCustomLabels: true, circles: true, nodeCircleFill: BLUEPRINT_WASH_COLOR, riverFill: BLUEPRINT_WASH_COLOR, corridorSegments: true }
};

/**
 * Set the renderer's visualization flags for one of the 4 view modes. Each
 * view type fixes its own internal display parameters (no user-facing
 * checkboxes) — see PENDIENTE.md, "Decisiones sobre el menú View". Doesn't
 * mark the frame dirty or render/commit itself — see applyViewPreset() for
 * that — so render() can also call this to silently fall back to Design
 * when Creases/Plan stop being available, without pushing a spurious undo
 * step for what's just a display-mode change.
 */
function setViewPreset(name) {
  const preset = VIEW_PRESETS[name];
  // Folded Form isn't one of the CanvasRenderer's display presets — it's a
  // whole separate workspace layer (see setWorkspaceLayer()) with its own
  // FoldedFormRenderer — so there's nothing here to set for it beyond the
  // active-button state below.
  if (preset) {
    renderer.showNodes = preset.nodes;
    renderer.showEdges = preset.edges;
    renderer.showCreases = preset.creases;
    renderer.showCreaseFolds = preset.creaseFolds;
    renderer.showMinorCreases = preset.minorCreases;
    renderer.monochromeCreases = !!preset.monochromeCreases;
    renderer.showVertices = preset.vertices;
    renderer.showVertexDots = preset.vertexDots;
    renderer.showVertexCoords = preset.vertexCoords;
    renderer.showPolys = preset.polys;
    renderer.showFacets = preset.facets;
    renderer.showPaths = preset.paths;
    renderer.showConditions = preset.conditions;
    renderer.showLabels = preset.labels;
    renderer.showOnlyCustomLabels = !!preset.onlyCustomLabels;
    renderer.showNodeCircles = preset.circles;
    renderer.nodeCircleFillColor = preset.nodeCircleFill || null;
    renderer.riverFillColor = preset.riverFill || null;
    renderer.showCorridorSegments = !!preset.corridorSegments;
  }
  document.querySelectorAll('.view-preset').forEach(button => {
    button.classList.toggle('active', button.id === `view${name[0].toUpperCase()}${name.slice(1)}`);
  });
}

function applyViewPreset(name) {
  // A View button always means "show me this TreeMaker view" — if Reference
  // Finder currently has the Inspector/workspace taken over (see
  // updatePropertiesPanel()'s early return for rfManualDetails.open), leave
  // it first so the requested view actually shows instead of staying hidden
  // behind it.
  if (rfManualDetails.open) {
    rfManualDetails.open = false;
    rfManualDetails.dispatchEvent(new Event('toggle'));
  }
  setViewPreset(name);
  state.isDirty = true;
  commitAndRender();
}

/**
 * Equivalent to tmwxTreePanel::SetSymEnable(): the X/Y/Angle fields only
 * make sense while a symmetry line is actually turned on.
 */
function syncSymmetryFieldsEnabled() {
  const enabled = tree.hasSymmetryLine();
  symLocXInput.disabled = !enabled;
  symLocYInput.disabled = !enabled;
  symAngleInput.disabled = !enabled;
}

/**
 * Update tree from UI controls
 */
function updateTreeFromUI() {
  const width = Number(paperWidthInput.value);
  const height = Number(paperHeightInput.value);
  const scale = Number(scaleInput.value);

  tree.setPaperWidth(width);
  tree.setPaperHeight(height);
  tree.setScale(scale);

  // Equivalent to tmwxTreePanel::OnApply()'s X/Y/Angle fields: a point on
  // the symmetry line and its angle (degrees CCW from the x-axis, the
  // natural/Y-up sense the field is labeled in) — the two presets in the
  // Symmetry Lines select are just a shortcut for the same two values these
  // fields set (0.5, 0.5, 90 for "book"; 0.5, 0.5, 45 for "diagonal"), so
  // hand-editing them defines a fully custom symmetry line. flipAngleDegrees()
  // converts the field's natural-convention degrees into tree.symAngle's
  // internal Y-down convention — see the comment on it in tmPoint.js.
  tree.setSymLoc({ x: Number(symLocXInput.value), y: Number(symLocYInput.value) });
  tree.setSymAngle(flipAngleDegrees(Number(symAngleInput.value)));

  state.isDirty = true;
}

/**
 * Paneles de selección única, en el orden en que se evalúan.
 * El primero cuyo getInfo() devuelva datos se muestra; el resto se ocultan.
 */
const SELECTION_PANELS = [
  { id: 'nodeProperties', getInfo: () => editor.getSelectedNodeInfo(), render: renderNodePanel },
  { id: 'edgeProperties', getInfo: () => editor.getSelectedEdgeInfo(), render: renderEdgePanel },
  { id: 'vertexProperties', getInfo: () => editor.getSelectedVertexInfo(), render: renderVertexPanel },
  { id: 'creaseProperties', getInfo: () => editor.getSelectedCreaseInfo(), render: renderCreasePanel },
  { id: 'facetProperties', getInfo: () => editor.getSelectedFacetInfo(), render: renderFacetPanel },
  { id: 'polyProperties', getInfo: () => editor.getSelectedPolyInfo(), render: renderPolyPanel }
];

/**
 * The central workspace is 3 stacked layers, only one visible at a time:
 * the TreeMaker canvas, the Reference Finder fold diagrams, and the Folded
 * Form view. `layer` is 'treemaker' | 'referenceFinder' | 'foldedForm'.
 */
function setWorkspaceLayer(layer) {
  treemakerLayer.style.display = layer === 'treemaker' ? 'flex' : 'none';
  referenceFinderLayer.style.display = layer === 'referenceFinder' ? 'flex' : 'none';
  foldedFormLayer.style.display = layer === 'foldedForm' ? 'flex' : 'none';
}

/**
 * Update properties panel based on selection
 */
function updatePropertiesPanel() {
  propertiesPanel.style.display = 'flex';

  // The manual Reference Finder search takes over the Inspector entirely
  // while its sidebar entry is open, regardless of the current tree
  // selection — it isn't one more per-selection panel, it's a standalone
  // tool the user explicitly switched to. The workspace follows it: the
  // TreeMaker canvas gives way to the Reference Finder layer for as long as
  // this section stays open.
  if (rfManualDetails.open) {
    for (const panel of SELECTION_PANELS) document.getElementById(panel.id).style.display = 'none';
    pathProperties.style.display = 'none';
    projectProperties.style.display = 'none';
    selectionProperties.style.display = 'none';
    rfManualProperties.style.display = 'block';
    propertiesPanelTitle.setAttribute('data-i18n', 'rf.panel.title');
    propertiesPanelTitle.textContent = t('rf.panel.title');
    propertiesPanelCloseBtn.style.display = '';
    // "Active Conditions" isn't relevant here — this is a search tool, not
    // a tree part's Inspector — so its usual spot at the bottom is taken
    // over by the saved-query history instead (see rfSavedQueries below).
    conditionListPanel.style.display = 'none';
    rfSavedQueriesPanel.style.display = 'block';
    renderRfSavedQueries();
    setWorkspaceLayer('referenceFinder');
    return;
  }
  rfManualProperties.style.display = 'none';
  propertiesPanelTitle.setAttribute('data-i18n', 'section.inspector');
  propertiesPanelTitle.textContent = t('section.inspector');
  propertiesPanelCloseBtn.style.display = 'none';
  rfSavedQueriesPanel.style.display = 'none';
  conditionListPanel.style.display = 'block';
  // Unlike Reference Finder, Folded Form doesn't take over the Inspector —
  // in the original it was a separate floating window, so selection panels
  // below keep working normally against the tree; only the central
  // workspace switches to the Folded Form layer/renderer.
  if (viewFoldedFormBtn.classList.contains('active')) {
    setWorkspaceLayer('foldedForm');
    foldedFormRenderer.setTree(tree);
    foldedFormRenderer.setSelection(renderer.selectedObjects);
    foldedFormRenderer.render();
  } else {
    setWorkspaceLayer('treemaker');
  }

  let matchedId = null;
  for (const panel of SELECTION_PANELS) {
    const el = document.getElementById(panel.id);
    const info = matchedId ? null : panel.getInfo();
    el.style.display = info ? (el.classList.contains('field-grid') ? 'grid' : 'block') : 'none';
    if (info) {
      panel.render(info);
      matchedId = panel.id;
    }
  }

  renderPathPanel();
  if (editor.selectedPath) matchedId = 'pathProperties';

  const selectionCount = editor.getSelectionCount();
  const showGroup = !matchedId && selectionCount > 1;
  projectProperties.style.display = (!matchedId && selectionCount <= 1) ? 'grid' : 'none';
  selectionProperties.style.display = showGroup ? 'grid' : 'none';
  if (!matchedId) {
    setSymmetryValue(tree.getSymmetryType());
    syncSymmetryFieldsEnabled();
  }
  if (showGroup) renderGroupPanel();

  updateConditionList();
}

/**
 * ReferenceFinder integration (REFERENCEFINDER_PLAN.md, Fase 5): a "Find
 * reference" section inside the node and path panels. A node selection
 * searches for the best-matching mark (point); a path selection searches
 * for the best-matching crease (line) — the same distinction rfEngine.js's
 * findBestMarks()/findBestLines() already make.
 *
 * A single Web Worker (referenceFinderClient.js) holds the search database
 * for the session; it's built lazily, once, at whatever paper size the tree
 * currently has (rebuilding on a paper-size change is left for later — the
 * common case is a document whose paper size is fixed for its whole
 * lifetime).
 *
 * Matches the original's own default max rank (6), not a reduced one: a
 * real comparison against the original ReferenceFinder console app
 * (tools/rfparity/) found this matters a lot — for target (0.529, 0.435),
 * rank 5 finds only err=0.0255, while rank 6 finds err=0.0016, exactly
 * matching the original's own best result (0.5274, 0.4349). A shallower
 * default trades away exactly the accuracy this feature exists to provide,
 * for a faster first build — not a trade worth making silently. The build
 * does take noticeably longer (single digits of seconds, more on slower
 * hardware), during which the busy overlay's progress text is the only
 * feedback — except on a repeat visit with the same paper size/settings,
 * where referenceFinderWorker.js's IndexedDB cache (rfDatabaseIndexedDb.js)
 * loads the already-built database instead of rebuilding it — see
 * REFERENCEFINDER_PLAN.md's Fase 6.
 */
const RF_MAX_RANK = 6;

// RFFrame::sSearchNum's own default (original/ReferenceFinder/source/gui/
// RFFrame.cpp) — the original's console mode hardcodes this same value
// (ReferenceFinder_console.cpp), and its GUI only ever lets a user raise or
// lower it via a preferences dialog this app doesn't have, so there's no
// reason to pick anything else as our own fixed default.
const RF_SEARCH_NUM = 5;
let rfBuildPromise = null;
// The paper size `rfBuildPromise` was actually started for. Without this,
// changing the paper size (Tree panel's Apply) after a build had already
// completed would silently keep using a database built for the OLD size —
// rfClient.build() always rebuilds for whatever options it's given, but
// ensureRfBuilt() only calls it once per session unless this key changes.
let rfBuildPaperKey = null;
let rfBuildProgressText = '';

function rfPaperKey() {
  return `${tree.getPaperWidth()}x${tree.getPaperHeight()}`;
}

function rfTreePointToRfSpace(point) {
  // Same Y-flip as Tmd5Format.js's flipY(): this app's tree space has Y
  // increasing downward, rfEngine.js's (matching the original
  // ReferenceFinder/TreeMaker) increases upward — see rfPoint.js.
  return { x: point.x, y: tree.getPaperHeight() - point.y };
}

// (Re)starts the worker's build for the current paper size if one isn't
// already running/done for it, and returns the (possibly already-settled)
// promise for it — without touching the busy overlay. Called both from
// preloadRfDatabase() (silently, right at startup) and from
// ensureRfBuilt() (which layers the overlay on top, whether the build it
// finds here was just started or was already under way in the background).
function startRfBuild() {
  const paperKey = rfPaperKey();
  if (rfBuildPromise && rfBuildPaperKey === paperKey) return rfBuildPromise;
  rfBuildPaperKey = paperKey;
  rfBuildProgressText = t('rf.building');
  rfBuildPromise = rfClient.build(
    { paperWidth: tree.getPaperWidth(), paperHeight: tree.getPaperHeight(), maxRank: RF_MAX_RANK },
    (info) => {
      rfBuildProgressText = `${t('rf.building')} (${info.status}, rank ${info.rank})`;
      if (busyOverlay.style.display !== 'none') busyMessage.textContent = rfBuildProgressText;
    }
  ).catch((err) => {
    rfBuildPromise = null; // allow retrying on a later search
    rfBuildPaperKey = null;
    throw err;
  });
  return rfBuildPromise;
}

/**
 * Kicks off the database build in the worker right at startup, so a build
 * for the document's current paper size — or an IndexedDB cache hit, see
 * REFERENCEFINDER_PLAN.md's Fase 6 — is often already finished (or well
 * under way) by the time the user's first search actually needs it, instead
 * of only starting on that first click. Fire-and-forget and silent (no busy
 * overlay, errors swallowed): this is a pure best-effort warm-up, and
 * ensureRfBuilt() below still runs the real, user-visible build/await if
 * this one hasn't finished yet — or wasn't for the paper size actually in
 * use when the user searches (see rfBuildPaperKey's doc comment).
 */
function preloadRfDatabase() {
  startRfBuild().catch(() => {});
}

async function ensureRfBuilt() {
  const promise = startRfBuild();
  busyOverlay.style.display = 'flex';
  busyCancelBtn.style.display = 'none'; // see referenceFinderClient.js's build() cancellation note
  busyMessage.textContent = rfBuildProgressText;
  try {
    return await promise;
  } finally {
    busyOverlay.style.display = 'none';
    busyCancelBtn.style.display = '';
    busyMessage.textContent = t('overlay.computing');
  }
}

/**
 * Wires one part's ReferenceFinder section (node, path, edge, vertex,
 * crease, or crease chain): its "Find reference" button jumps to the
 * shared Reference Finder section (see activateOriginSearch()) with the
 * part's own current position/line prefilled. `mode` is 'point' or 'line'
 * — it picks findMarks() vs findLines() and how many of X1..Y2 get filled
 * in; `buildTarget(origin)` returns the {x,y} (point) or {p1,p2} (line)
 * target in rfEngine's own space. Saving a result never anchors it back to
 * this part — every saved search is a plain coordinate
 * (tree.rfSavedQueries, see its doc comment in tmTree.js), exactly like a
 * hand-typed search, so there's no "already saved for this part" state to
 * track here.
 */
function createReferenceFinderPanel({ elements, mode, buildTarget }) {
  const state = { origin: null };

  function search() {
    if (!state.origin) return;
    activateOriginSearch({ mode, target: buildTarget(state.origin) });
  }

  elements.searchBtn.addEventListener('click', search);

  return {
    refresh(origin) {
      state.origin = origin;
    }
  };
}

// Detects whether `creases` (2+) form one connected, geometrically straight
// open chain — regardless of whether they share a tmPath (only ever true for
// axial/border creases split by a crossing path) or are poly-owned interior
// creases (ridge/gusset, typically valley-folded — see
// REFERENCEFINDER_PLAN.md's monte/valle investigation) with no path anchor
// at all. A poly's interior molecule structure can equally lay one straight
// fold line across more than one crease segment (split at a junction vertex
// where another interior crease crosses it) — the same phenomenon Fase 7
// solved for paths, just without a stable owner to key off. Returns the
// chain's two open-end vertices, or null if the selection isn't a single
// simple open chain (branches, a cycle, or genuinely bent).
function findCreaseChainEndpoints(creases) {
  const degree = new Map();
  const bump = (v) => degree.set(v, (degree.get(v) || 0) + 1);
  for (const crease of creases) {
    bump(crease.getVertex(0));
    bump(crease.getVertex(1));
  }
  const ends = [...degree.entries()].filter(([, d]) => d === 1).map(([v]) => v);
  const middles = [...degree.entries()].filter(([, d]) => d === 2);
  if (ends.length !== 2 || middles.length !== degree.size - 2) return null;

  const [p1, p2] = [ends[0].getLoc(), ends[1].getLoc()];
  const dir = { x: p2.x - p1.x, y: p2.y - p1.y };
  const len = Math.hypot(dir.x, dir.y);
  if (len < 1e-4) return null;
  const DIST_TOL = 1e-4; // matches tmPoly.js/tmTree.js's own geometric tolerance
  for (const vertex of degree.keys()) {
    const p = vertex.getLoc();
    const cross = (p.x - p1.x) * dir.y - (p.y - p1.y) * dir.x;
    if (Math.abs(cross) / len > DIST_TOL) return null;
  }
  return [ends[0], ends[1]];
}

function lineTargetFromNodes(nodes) {
  return {
    p1: rfTreePointToRfSpace(nodes[0].getLoc()),
    p2: rfTreePointToRfSpace(nodes[nodes.length - 1].getLoc())
  };
}

const rfNodePanel = createReferenceFinderPanel({
  elements: rfNodeElements,
  mode: 'point',
  buildTarget: node => rfTreePointToRfSpace(node.getLoc())
});

const rfPathPanel = createReferenceFinderPanel({
  elements: rfPathElements,
  mode: 'line',
  buildTarget: path => lineTargetFromNodes(path.getNodes())
});

// Edge panel's ReferenceFinder section: unlike a leaf-to-leaf Path, a plain
// tree Edge is just the direct connection between two adjacent nodes (which
// may both be internal branch nodes) — a distinct, and equally valid,
// "line through two points" search target of its own.
const rfEdgePanel = createReferenceFinderPanel({
  elements: rfEdgeElements,
  mode: 'line',
  buildTarget: edge => lineTargetFromNodes(edge.getNodes())
});

// Vertex panel's ReferenceFinder section: an origamist needs to locate the
// vertex's actual position in the crease pattern, not the (pre-Build) tree
// node's — see REFERENCEFINDER_PLAN.md's Fase 5 addendum.
const rfVertexPanel = createReferenceFinderPanel({
  elements: rfVertexElements,
  mode: 'point',
  buildTarget: vertex => rfTreePointToRfSpace(vertex.getLoc())
});

// Crease panel's ReferenceFinder section: the same "search on the real
// crease-pattern geometry, not the pre-Build model" reasoning as the Vertex
// panel above, but for lines.
const rfCreasePanel = createReferenceFinderPanel({
  elements: rfCreaseElements,
  mode: 'line',
  buildTarget: crease => lineTargetFromNodes([crease.getVertex(0), crease.getVertex(1)])
});

/**
 * "A single straight crease line is often several tmCrease segments"
 * (the user's own words) — a border path's creases get realized as one
 * segment per interior vertex Build inserted along its route (see
 * tmPath.js's connectSelfVertices()/getOrMakeVertex()), e.g. where another
 * crease crosses it partway. All of those segments share the same
 * `getOwnerAsPath()` (this exact tmPath), so selecting every segment of one
 * such line and reading them all as ONE line search — the path's own front/
 * back nodes, exactly like the Path and single-Crease panels already do —
 * needs no new geometry, just detecting the "all selected creases share one
 * owning path" condition (see renderGroupPanel()'s rfSharedCreasePath).
 */
// `chain` is `{ path, v1, v2 }`: when every selected crease shares one
// owning tmPath, `path` carries it (reusing rfPathPanel's exact logic,
// keyed by its stable front/back nodes); otherwise (a poly-owned interior
// chain — see findCreaseChainEndpoints() above) `path` is null and `v1`/
// `v2` are the chain's own open-end vertices, which still locate the line
// for a search.
const rfCreaseChainPanel = createReferenceFinderPanel({
  elements: rfCreaseChainElements,
  mode: 'line',
  buildTarget: chain => (chain.path ? lineTargetFromNodes(chain.path.getNodes()) : lineTargetFromNodes([chain.v1, chain.v2]))
});

// Opening/closing the sidebar's "Reference Finder" entry just re-evaluates
// which Inspector panel is visible (see updatePropertiesPanel()'s early
// return for rfManualDetails.open).
rfManualDetails.addEventListener('toggle', updatePropertiesPanel);

// Collapses the sidebar's "Reference Finder" entry — same effect as
// dragging its own <summary> closed — falling back to whatever TreeMaker
// view was last active. Shared by the Inspector's own close (×) button
// (shown only while Reference Finder has taken it over) and the manual
// panel's own placeholder hint, which doubles as a "click here to close"
// affordance since it has nothing else to show.
function closeRfManual() {
  rfManualDetails.open = false;
  rfManualDetails.dispatchEvent(new Event('toggle'));
}
propertiesPanelCloseBtn.addEventListener('click', closeRfManual);
rfManualHint.addEventListener('click', closeRfManual);
rfManualHint.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  closeRfManual();
});

function syncRfManualModeFields() {
  const isLine = rfManualModeLine.checked;
  rfManualX2.disabled = !isLine;
  rfManualY2.disabled = !isLine;
  renderRfTargetDiagram();
  clearRfManualResults();
}
rfManualModePoint.addEventListener('change', syncRfManualModeFields);
rfManualModeLine.addEventListener('change', syncRfManualModeFields);

// Any parameter edit invalidates the results shown for the previous
// parameters — clear the central panel (results cards, fold diagrams, "no
// results" hint) so it never shows stale results next to an already-updated
// Target diagram. The Target diagram itself is untouched: it's redrawn
// separately, live, on every edit (see renderRfTargetDiagram()).
function clearRfManualResults() {
  resetFoldDiagrams();
  rfResultCards.innerHTML = '';
  rfManualNoResults.style.display = 'none';
  rfManualSelectedIndex = -1;
  rfManualSteps = [];
  rfManualSaveBtn.disabled = true;
}

// The Reference Finder section's own always-visible first diagram: the
// paper with whatever X1..Y2 currently describe marked on it — the target a
// search would run against, redrawn on every edit so it stays a live
// preview rather than something that only updates once a search runs.
function renderRfTargetDiagram() {
  const mode = rfManualModeLine.checked ? 'line' : 'point';
  const p1 = { x: Number(rfManualX1.value), y: Number(rfManualY1.value) };
  const p2 = { x: Number(rfManualX2.value), y: Number(rfManualY2.value) };
  rfTargetSvg.innerHTML = renderTargetSVG(mode, p1, p2, tree.getPaperWidth(), tree.getPaperHeight(), 170);
}
[rfManualX1, rfManualY1, rfManualX2, rfManualY2].forEach((input) => {
  input.addEventListener('input', () => {
    renderRfTargetDiagram();
    clearRfManualResults();
  });
});
renderRfTargetDiagram();

let rfManualResults = [];
let rfManualResultSteps = []; // steps[i], fetched once per result up front — see runRfManualSearch()
let rfManualSelectedIndex = -1;
let rfManualSteps = [];

function selectRfManualResult(index) {
  rfManualSelectedIndex = index;
  [...rfResultCards.children].forEach((card, i) => {
    card.classList.toggle('selected', i === index);
  });
  rfManualSteps = rfManualResultSteps[index];
  referenceFinderLayer.scrollTop = 0;
  showFoldDiagrams(rfManualSteps, tree.getPaperWidth(), tree.getPaperHeight());
  // Saving is always available once a result is picked — it saves the raw
  // search coordinates (see rfManualSaveBtn's own listener below), which
  // needs no tree part to attach to, unlike the optional origin-linked save.
  rfManualSaveBtn.disabled = false;
}

// X1/Y1/X2/Y2 are read directly as rfEngine's own Y-up target space: that
// space's Y already increases upward from the paper's bottom edge (see
// rfTreePointToRfSpace() above), the exact same convention the Node panel's
// own Position Y field displays via flipDisplayY() — so, unlike that field,
// no flip is needed here before handing the values to findMarks()/findLines().
async function runRfManualSearch() {
  const p1 = { x: Number(rfManualX1.value), y: Number(rfManualY1.value) };
  referenceFinderLayer.scrollTop = 0;
  resetFoldDiagrams();
  rfResultCards.innerHTML = '';
  document.body.style.cursor = 'wait';
  try {
    await ensureRfBuilt();
    rfManualResults = rfManualModeLine.checked
      ? await rfClient.findLines(p1, { x: Number(rfManualX2.value), y: Number(rfManualY2.value) }, RF_SEARCH_NUM)
      : await rfClient.findMarks(p1, RF_SEARCH_NUM);
    rfManualSelectedIndex = -1;
    rfManualSteps = [];
    rfManualSaveBtn.disabled = true;

    if (rfManualResults.length === 0) {
      rfManualNoResults.style.display = 'block';
      return;
    }
    rfManualNoResults.style.display = 'none';

    // Each result's own finished fold sequence, fetched once here rather than
    // lazily per click — it's what both the mini diagram on its card and (once
    // selected) the Inspector's "Fold sequence" list need. One at a time, not
    // Promise.all: referenceFinderClient.js's requestOnce() matches a response
    // to a request purely by message type, not by request id, so concurrent
    // 'sequence' calls all resolve to whichever response arrives first.
    rfManualResultSteps = [];
    for (const result of rfManualResults) {
      rfManualResultSteps.push(await rfClient.sequence(result.id));
    }

    rfManualResults.forEach((result, i) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'rf-result-card';
      const svgWrap = document.createElement('div');
      svgWrap.className = 'rf-diagram-svg';
      svgWrap.innerHTML = renderResultSVG(rfManualResultSteps[i], tree.getPaperWidth(), tree.getPaperHeight(), 90);
      card.appendChild(svgWrap);
      const caption = document.createElement('p');
      caption.className = 'rf-diagram-caption';
      const rankLine = document.createElement('span');
      rankLine.textContent = t('rf.rankLine', { rank: result.rank });
      const errorLine = document.createElement('span');
      errorLine.textContent = t('rf.errorLine', { error: result.error.toFixed(4) });
      caption.append(rankLine, document.createElement('br'), errorLine);
      card.appendChild(caption);
      card.addEventListener('click', () => selectRfManualResult(i));
      rfResultCards.appendChild(card);
    });
    selectRfManualResult(0);
  } finally {
    document.body.style.cursor = '';
  }
}

// Entry point for a per-part "Find reference" button (see
// createReferenceFinderPanel() above): switches the Inspector over to the
// Reference Finder section, sets its mode and coordinates from that part's
// own search target, and runs the search there instead of inline in the
// part's own panel.
function round4(n) {
  return Math.round(n * 10000) / 10000;
}

function activateOriginSearch({ mode, target }) {
  rfManualModePoint.checked = mode === 'point';
  rfManualModeLine.checked = mode === 'line';
  syncRfManualModeFields();
  if (mode === 'point') {
    rfManualX1.value = formatNumeric(target.x);
    rfManualY1.value = formatNumeric(target.y);
  } else {
    rfManualX1.value = formatNumeric(target.p1.x);
    rfManualY1.value = formatNumeric(target.p1.y);
    rfManualX2.value = formatNumeric(target.p2.x);
    rfManualY2.value = formatNumeric(target.p2.y);
  }
  renderRfTargetDiagram();
  rfManualDetails.open = true;
  updatePropertiesPanel();
  runRfManualSearch();
}

rfManualSearchBtn.addEventListener('click', () => {
  rfManualSaveBtn.disabled = true;
  runRfManualSearch();
});

// The Reference Finder's own saved-query history: raw search coordinates,
// independent of any tree part — shown in place of "Active Conditions"
// while this section is open (see updatePropertiesPanel()). Persisted as
// part of the document (tree.rfSavedQueries — see its doc comment in
// tmTree.js and src/model/io/SavedSearches.js).

// Inline SVG (no external asset, ~350 bytes, colors via currentColor) for
// the per-row delete button below — a text label doesn't fit next to the
// query's own (already truncated) description.
const ICON_TRASH_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"/></svg>';

function renderRfSavedQueries() {
  rfSavedQueriesList.replaceChildren();
  for (const query of tree.rfSavedQueries) {
    const row = document.createElement('div');
    row.className = 'rf-saved-query-row';
    const info = document.createElement('div');
    info.className = 'rf-saved-query-info';
    const target = document.createElement('span');
    target.className = 'rf-saved-query-target';
    target.textContent = query.mode === 'line'
      ? t('rf.savedQueryLine', { x1: query.x1.toFixed(3), y1: query.y1.toFixed(3), x2: query.x2.toFixed(3), y2: query.y2.toFixed(3) })
      : t('rf.savedQueryPoint', { x1: query.x1.toFixed(3), y1: query.y1.toFixed(3) });
    const meta = document.createElement('span');
    meta.className = 'rf-saved-query-meta';
    meta.textContent = t('rf.savedQueryRankError', { rank: query.rank, error: query.error.toFixed(4) });
    info.append(target, meta);
    row.appendChild(info);
    row.addEventListener('click', async () => {
      rfManualModePoint.checked = query.mode === 'point';
      rfManualModeLine.checked = query.mode === 'line';
      syncRfManualModeFields();
      rfManualX1.value = formatNumeric(query.x1);
      rfManualY1.value = formatNumeric(query.y1);
      rfManualX2.value = formatNumeric(query.x2);
      rfManualY2.value = formatNumeric(query.y2);
      renderRfTargetDiagram();
      await runRfManualSearch();
      // runRfManualSearch() already selected the best-ranked result (index
      // 0) by default — reselect the exact one this search was saved with
      // instead, since the search is deterministic (same paper size, same
      // target) and so the same index means the same result. Falls back to
      // whatever's already selected if the index is out of range (e.g. a
      // paper-size change since saving legitimately changed how many
      // results come back).
      if (query.resultIndex >= 0 && query.resultIndex < rfManualResults.length) {
        selectRfManualResult(query.resultIndex);
      }
    });
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'small delete icon-btn';
    deleteBtn.innerHTML = ICON_TRASH_SVG;
    deleteBtn.setAttribute('aria-label', t('rf.delete'));
    deleteBtn.title = t('rf.delete');
    deleteBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      tree.rfSavedQueries = tree.rfSavedQueries.filter(q => q !== query);
      commitAndRender();
    });
    row.appendChild(deleteBtn);
    rfSavedQueriesList.appendChild(row);
  }
}

rfManualSaveBtn.addEventListener('click', () => {
  if (rfManualSelectedIndex < 0) return;
  const chosen = rfManualResults[rfManualSelectedIndex];

  tree.rfSavedQueries.push({
    id: Math.random().toString(36).substr(2, 9),
    mode: rfManualModeLine.checked ? 'line' : 'point',
    x1: round4(Number(rfManualX1.value)),
    y1: round4(Number(rfManualY1.value)),
    x2: round4(Number(rfManualX2.value)),
    y2: round4(Number(rfManualY2.value)),
    resultIndex: rfManualSelectedIndex,
    rank: chosen.rank,
    error: chosen.error
  });
  commitAndRender();
  rfManualSaveBtn.disabled = true;
});

/**
 * This app's internal tree space has Y increasing downward (screen/canvas
 * convention — see Tmd5Format.js's flipY() and rfPoint.js's doc comment for
 * the same boundary conversion elsewhere). The original TreeMaker's own
 * coordinate readout — and so a user's expectation of "Position Y" — has Y
 * increasing upward from the paper's bottom edge. Self-inverse (same
 * formula converts either direction), like flipY(): apply it once when
 * showing an internal Y to the user, and once more when reading a Y they
 * typed back into internal space.
 */
function flipDisplayY(y) {
  return tree.getPaperHeight() - y;
}

function renderNodePanel(nodeInfo) {
  document.getElementById('nodeName').textContent = t('node.title', { label: nodeInfo.label });
  nodeXInput.value = formatNumeric(nodeInfo.x);
  nodeYInput.value = formatNumeric(flipDisplayY(nodeInfo.y));
  // Only enabled once a node is actually pinned (locked by "Maximize
  // Scale", drawn with cyan edges) — the "Unpin" button is the mouse-only
  // alternative to holding Alt/Ctrl while dragging it (see NodeEditor's
  // forceMovableNodes).
  nodeUnpinBtn.disabled = !nodeInfo.isPinned;

  // editor.deleteSelectedNode() silently no-ops (console.warn only) on a
  // non-leaf node (tmTree::RemoveNode() only ever removes leaves) — disable
  // the button instead of letting the click do nothing with no feedback.
  nodeDeleteBtn.disabled = !nodeInfo.isLeaf;

  nodeLabelInput.value = nodeInfo.label;

  // ConditionNodeCombo (tag "CNxn") is the only condition class the real
  // program's UI creates for "Node(s) Fixed to Symmetry Line / Paper Edge /
  // Corner / Position..." — IsValidCondition() requires a LEAF node, so the
  // editor here (like the original's UpdateUI handlers, which filter the
  // selection to leaf nodes) only offers it for those.
  nodeComboEditor.style.display = nodeInfo.isLeaf ? 'grid' : 'none';
  nodeComboNotLeaf.style.display = nodeInfo.isLeaf ? 'none' : 'block';
  const comboCondition = tree.getConditions().find(condition => (
    condition instanceof ConditionNodeCombo && condition.getNode() === editor.selectedNode
  ));
  nodeFixToSymmetryLineCheckbox.checked = comboCondition?.getToSymmetryLine() || false;
  nodeFixToPaperEdgeCheckbox.checked = comboCondition?.getToPaperEdge() || false;
  nodeFixToPaperCornerCheckbox.checked = comboCondition?.getToPaperCorner() || false;

  const xFixed = comboCondition?.getXFixed() || false;
  const yFixed = comboCondition?.getYFixed() || false;
  nodeFixToPositionCheckbox.checked = xFixed || yFixed;
  if (xFixed && yFixed) {
    nodeFixToPositionLabel.textContent = t('node.fixToPositionBoth', {
      x: formatNumeric(comboCondition.getXFixValue(), 4),
      y: formatNumeric(flipDisplayY(comboCondition.getYFixValue()), 4)
    });
  } else if (xFixed) {
    nodeFixToPositionLabel.textContent = t('node.fixToPositionX', { x: formatNumeric(comboCondition.getXFixValue(), 4) });
  } else if (yFixed) {
    nodeFixToPositionLabel.textContent = t('node.fixToPositionY', { y: formatNumeric(flipDisplayY(comboCondition.getYFixValue()), 4) });
  } else {
    nodeFixToPositionLabel.textContent = t('node.fixToPosition');
  }

  rfNodePanel.refresh(editor.selectedNode);
}

function renderEdgePanel(edgeInfo) {
  document.getElementById('edgeName').textContent = t('edge.title', { n: edgeInfo.index });
  document.getElementById('edgeNodes').value = `${edgeInfo.node1} - ${edgeInfo.node2}`;
  edgeStrainInput.value = formatNumeric(edgeInfo.strain);
  edgeStiffnessInput.value = formatNumeric(edgeInfo.stiffness);

  edgeLengthInput.value = formatNumeric(edgeInfo.length);
  const noStrainCondition = tree.getConditions().find(condition => (
    condition instanceof ConditionEdgeLengthFixed && condition.getEdge() === editor.selectedEdge
  ));
  edgeNoStrainCheckbox.checked = !!noStrainCondition;

  rfEdgePanel.refresh(editor.selectedEdge);
}

function renderVertexPanel(info) {
  document.getElementById('vertexName').textContent = t('vertex.title', { label: info.ownerLabel ?? info.id });
  document.getElementById('vertexX').value = info.x.toFixed(4);
  document.getElementById('vertexY').value = flipDisplayY(info.y).toFixed(4);

  rfVertexPanel.refresh(editor.selectedVertex);
}

// tmCrease::Kind (structural role) and tmCrease::Fold (fold direction) —
// see getSelectedCreaseInfo()'s comment — each map to their own lowercase
// display string, matching tmwxStaticText::SetLabelFormatted(..)'s text
// for these two enums in the original.
const CREASE_KIND_LABELS = {
  AXIAL: 'crease.kind.axial',
  GUSSET: 'crease.kind.gusset',
  RIDGE: 'crease.kind.ridge',
  UNFOLDED_HINGE: 'crease.kind.unfoldedHinge',
  FOLDED_HINGE: 'crease.kind.foldedHinge',
  PSEUDOHINGE: 'crease.kind.pseudohinge'
};
const CREASE_FOLD_LABELS = {
  FLAT: 'crease.fold.flat',
  MOUNTAIN: 'crease.fold.mountain',
  VALLEY: 'crease.fold.valley',
  BORDER: 'crease.fold.border'
};

// Strips getDisplayLabel()'s "V" prefix (only ever present for an
// owner-less/path-owned junction vertex — a node-owned one is already just
// the node's own plain-number label) so a vertex reads as a bare index
// number wherever the Crease/Facet inspectors list one. Shared by
// renderCreasePanel() and renderFacetPanel() below.
function stripVPrefix(label) {
  return label.replace(/^V/, '');
}

function renderCreasePanel(info) {
  document.getElementById('creaseName').textContent = t('crease.title', { n: info.index });
  document.getElementById('creaseVertices').value = `${stripVPrefix(info.v1Label)} - ${stripVPrefix(info.v2Label)}`;
  document.getElementById('creaseLength').value = info.length.toFixed(4);
  document.getElementById('creaseKindValue').value = info.kind ? t(CREASE_KIND_LABELS[info.kind]) : '—';
  document.getElementById('creaseFoldValue').value = info.fold ? t(CREASE_FOLD_LABELS[info.fold]) : '—';
  document.getElementById('creaseAngle').value = `${info.angleDeg.toFixed(2)}°`;

  rfCreasePanel.refresh(editor.selectedCrease);
}

function renderFacetPanel(info) {
  document.getElementById('facetName').textContent = t('facet.title', { n: info.index });
  document.getElementById('facetVertices').value = info.vertexLabels.map(stripVPrefix).join(', ');
  document.getElementById('facetOrder').value = info.order;
  document.getElementById('facetColorSwatch').style.background = info.color;
  document.getElementById('facetArea').value = formatNumeric(info.area, 4);
  document.getElementById('facetCentroid').value = `(${formatNumeric(info.centroid.x, 4)}, ${formatNumeric(info.centroid.y, 4)})`;
  document.getElementById('facetCreases').value = info.creaseLabels.join(', ');
}

function renderPolyPanel(info) {
  document.getElementById('polyName').textContent = t('poly.title', { n: info.index });
  document.getElementById('polyCentroid').value = `(${formatNumeric(info.centroid.x, 4)}, ${formatNumeric(info.centroid.y, 4)})`;
  document.getElementById('polyRingNodes').value = info.ringNodeLabels.join(', ');
  document.getElementById('polyRingPaths').value = info.ringPathLabels.join(', ');
  document.getElementById('polyArea').value = formatNumeric(info.area, 4);
}

/**
 * Panel de camino: solo se muestra para una selección directa de path
 * (clic en la línea, "Select Path From Nodes", "Select by Index" con tipo
 * "path" — editor.selectedPath). Ya no existe el modo acompañante del
 * panel de nodo (nodo seleccionado + desplegable "To:").
 */
function renderPathPanel() {
  const directPath = editor.selectedPath;
  if (!directPath) {
    pathProperties.style.display = 'none';
    return;
  }
  pathProperties.style.display = 'grid';

  const first = directPath.getFirstNode();
  const last = directPath.getLastNode();
  const pathIndex = tree.getPaths().indexOf(directPath) + 1;
  document.getElementById('pathName').textContent = t('path.title', { n: pathIndex });
  document.getElementById('pathNodes').value = `${first?.label ?? '?'} - ${last?.label ?? '?'}`;
  rfPathPanel.refresh(directPath);
  const pathInfo = editor.getSelectedPathInfo();

  if (!pathInfo) {
    pathMinTreeLength.value = '—';
    pathActTreeLength.value = '—';
    pathAngle.value = '—';
    pathActiveToggle.checked = false;
    pathFixAngleToggle.checked = false;
    pathFixAngleLabel.textContent = t('path.fixAngle');
    pathQuantizeToggle.checked = false;
    pathQuantizeLabel.textContent = t('path.quantizeAngle');
    return;
  }

  // Equivalent to tmwxPathPanel::Fill(): "Min Tree Length" (mMinTreeLength,
  // the minimum length the tree structure allows) and "Act Tree Length"
  // (mActTreeLength, the current length from the node positions) are the
  // only two length stats the real panel shows — no "Slack" field exists
  // there (it was an invented derived value in this SPA, now removed).
  pathMinTreeLength.value = pathInfo.minTreeLength.toFixed(3);
  pathActTreeLength.value = pathInfo.treeLength.toFixed(3);
  pathAngle.value = `${pathInfo.angleDeg.toFixed(2)}°`;

  pathActiveToggle.checked = tree.getConditions().some(condition => (
    condition instanceof ConditionPathActive && condition.getPath() === pathInfo.path
  ));
  const fixAngleCondition = tree.getConditions().find(condition => (
    condition instanceof ConditionPathAngleFixed && condition.getPath() === pathInfo.path
  ));
  pathFixAngleToggle.checked = !!fixAngleCondition;
  pathFixAngleLabel.textContent = fixAngleCondition
    ? `${t('path.fixAngle')} (${(fixAngleCondition.getAngle() * 180 / Math.PI).toFixed(2)}°)`
    : t('path.fixAngle');
  const quantCondition = tree.getConditions().find(condition => (
    condition instanceof ConditionPathAngleQuant && condition.getPath() === pathInfo.path
  ));
  pathQuantizeToggle.checked = !!quantCondition;
  pathQuantizeLabel.textContent = quantCondition
    ? `${t('path.quantizeAngle')} (${quantCondition.getQuantValue()} / ${(quantCondition.getQuantOffset() * 180 / Math.PI).toFixed(2)}°)`
    : t('path.quantizeAngle');
}

function renderGroupPanel() {
  const counts = editor.getSelectionCounts();
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  selectionSummary.textContent = t('selection.summary', { n: total });
  renderSelFixToPositionLabel();

  const labels = { nodes: t('label.nodes'), edges: t('label.edges'), paths: t('label.paths'), vertices: t('label.vertices'), creases: t('label.creases'), facets: t('label.facets'), polys: t('label.polys') };
  selectionCounts.replaceChildren();
  for (const [key, value] of Object.entries(counts)) {
    if (value === 0) continue;
    const row = document.createElement('div');
    row.className = 'condition-row';
    row.textContent = `${labels[key]}: ${value}`;
    selectionCounts.appendChild(row);
  }

  // Stricter than tmwxDoc::OnNodeFixedTo*UpdateUI()/OnNodesPaired
  // AboutSymmetryLineUpdateUI()/OnNodesCollinearUpdateUI() — the original
  // only filters the selection down to its leaf nodes and otherwise
  // ignores whatever else is selected alongside them (an edge, a branch
  // node...). This SPA's six node conditions below only show at all when
  // the ENTIRE selection is leaf nodes and nothing else — a mixed
  // selection hides all six rather than silently acting on just the leaf
  // subset of it.
  const leafNodes = getSelectionLeafNodes();
  const isLeafOnlySelection = leafNodes.length > 0 &&
    leafNodes.length === editor.selectedNodes.length &&
    leafNodes.length === editor.getSelectionCount();
  selectionComboEditor.style.display = isLeafOnlySelection ? 'grid' : 'none';
  // Same read-back-from-the-model pattern as selNoStrainToggle/selSameStrainToggle
  // below: checked only when EVERY leaf node in the selection already carries
  // that condition. Without this the three checkboxes kept whatever `checked`
  // state they last had from a previous selection or user click, since nothing
  // else here re-derives them from the actual per-node conditions.
  if (isLeafOnlySelection) {
    const comboConditions = leafNodes.map(node => tree.getConditions().find(condition => (
      condition instanceof ConditionNodeCombo && condition.getNode() === node
    )));
    selFixToSymmetryLineCheckbox.checked = comboConditions.every(condition => condition?.getToSymmetryLine());
    selFixToPaperEdgeCheckbox.checked = comboConditions.every(condition => condition?.getToPaperEdge());
    selFixToPaperCornerCheckbox.checked = comboConditions.every(condition => condition?.getToPaperCorner());
  }
  // Only worth explaining when the selection actually has a node in it —
  // otherwise (e.g. 2+ edges, facets, creases... selected, no nodes at
  // all) "Only leaf nodes can carry this condition" has nothing to do with
  // what's selected and was showing up as unrelated noise.
  selComboNotLeaf.style.display = (!isLeafOnlySelection && editor.selectedNodes.length > 0) ? 'block' : 'none';

  // Same gate, plus the exact-count requirement for pairing (2) and
  // collinearity (3) — not "2 or more"/"3 or more" like the Fix Node
  // block above.
  selPairEditor.style.display = (isLeafOnlySelection && leafNodes.length === 2) ? 'grid' : 'none';
  if (isLeafOnlySelection && leafNodes.length === 2) selPairToggle.checked = !!findPairCondition(leafNodes);
  selCollinearEditor.style.display = (isLeafOnlySelection && leafNodes.length === 3) ? 'grid' : 'none';
  if (isLeafOnlySelection && leafNodes.length === 3) selCollinearToggle.checked = !!findCollinearCondition(leafNodes);

  // Equivalent to tmwxDoc::OnEdgeLengthFixedUpdateUI(): 1+ selected edges
  // (no leaf filtering — same as the single-edge inspector's own "No
  // Strain" toggle, just batched over the whole edge selection).
  const selectedEdges = editor.selectedEdges;
  selNoStrainEditor.style.display = selectedEdges.length >= 1 ? 'grid' : 'none';
  if (selectedEdges.length >= 1) selNoStrainToggle.checked = selectedEdges.every(edge => !!findNoStrainCondition(edge));

  // Stricter than tmwxDoc::OnEdgesSameStrainUpdateUI() (2+ selected edges,
  // pairing every one with the first) — this SPA's toggle only ever pairs
  // exactly two edges with each other, so it only shows for exactly 2
  // selected, not 2+.
  selSameStrainEditor.style.display = selectedEdges.length === 2 ? 'grid' : 'none';
  if (selectedEdges.length === 2) selSameStrainToggle.checked = !!findSameStrainCondition(selectedEdges[0], selectedEdges[1]);

  // ReferenceFinder over a multi-segment crease line (see rfCreaseChainPanel's
  // doc comment above): only meaningful when the ENTIRE selection is 2+
  // creases (not a mix with other part types).
  const selectedCreases = editor.selectedCreases;
  const isPureCreaseSelection = selectedCreases.length >= 2 && selectedCreases.length === total;
  rfCreaseChainDivider.style.display = isPureCreaseSelection ? 'block' : 'none';
  rfCreaseChainTitle.style.display = isPureCreaseSelection ? 'block' : 'none';
  if (isPureCreaseSelection) {
    const firstPath = selectedCreases[0].getOwnerAsPath();
    const sharedPath = firstPath && selectedCreases.every(c => c.getOwnerAsPath() === firstPath) ? firstPath : null;
    const endpoints = sharedPath ? null : findCreaseChainEndpoints(selectedCreases);
    const hasChain = Boolean(sharedPath) || Boolean(endpoints);
    rfCreaseChainNotSameLine.style.display = hasChain ? 'none' : 'block';
    rfCreaseChainElements.searchBtn.style.display = hasChain ? 'block' : 'none';
    if (hasChain) rfCreaseChainPanel.refresh(getChainDescriptor(sharedPath, endpoints));
  } else {
    rfCreaseChainNotSameLine.style.display = 'none';
    rfCreaseChainElements.searchBtn.style.display = 'none';
  }
}

// createReferenceFinderPanel()'s refresh(origin) resets search state
// whenever `origin !== state.origin` — so the wrapper object handed to
// rfCreaseChainPanel must keep the same identity across re-renders as long
// as the underlying chain hasn't actually changed, or every render (not
// just every selection change) would silently drop the user's results.
let lastChainDescriptor = null;
function getChainDescriptor(path, endpoints) {
  const [v1, v2] = endpoints ?? [null, null];
  if (lastChainDescriptor && lastChainDescriptor.path === path
    && lastChainDescriptor.v1 === v1 && lastChainDescriptor.v2 === v2) {
    return lastChainDescriptor;
  }
  lastChainDescriptor = { path, v1, v2 };
  return lastChainDescriptor;
}

/**
 * Nodos hoja de la selección múltiple actual — mismo filtro que
 * tmNode::FilterLeafNodes() en el original.
 */
function getSelectionLeafNodes() {
  return editor.selectedNodes.filter(node => node.getDegree() === 1);
}

for (const card of symmetryCards) card.addEventListener('click', () => {
  tree.setSymmetryType(card.dataset.value);
  setSymmetryValue(card.dataset.value);
  // "Book"/"Diagonal" are shortcuts that set X/Y/Angle to a fixed point and
  // angle (see tmTree.setSymmetryType()) — reflect that in the fields
  // immediately, same as the original's Diag/Book buttons.
  symLocXInput.value = formatNumeric(tree.getSymLoc().x);
  symLocYInput.value = formatNumeric(tree.getSymLoc().y);
  symAngleInput.value = formatNumeric(flipAngleDegrees(tree.getSymAngle()), 2);
  syncSymmetryFieldsEnabled();
  commitAndRender();
});

function updateConditionList() {
  conditionList.replaceChildren();
  for (const condition of tree.getConditions()) {
    const row = document.createElement('div');
    row.className = 'condition-row';
    const label = document.createElement('span');
    label.textContent = condition.toString?.() || t('condition.generic');
    row.appendChild(label);
    const removeButton = document.createElement('button');
    removeButton.className = 'small delete icon-btn';
    removeButton.innerHTML = ICON_TRASH_SVG;
    removeButton.setAttribute('aria-label', t('common.delete'));
    removeButton.title = t('common.delete');
    removeButton.addEventListener('click', () => {
      tree.removeCondition(condition);
      commitAndRender();
    });
    row.appendChild(removeButton);
    conditionList.appendChild(row);
  }
}

/**
 * Render frame
 */
function render() {
  if (state.isDirty) {
    // Unlike the original (which shows a blank canvas), Creases/Plan aren't
    // reachable here until Build Crease Pattern actually produced one — so
    // if the pattern was just torn down (Kill Crease Pattern, or any edit
    // that invalidates it) while one of those was the active view, fall
    // back to Design instead of leaving an unreachable view selected.
    const hasCreasePattern = tree.getCreases().length > 0;
    if (!hasCreasePattern && (viewCreasesBtn.classList.contains('active') || viewPlanBtn.classList.contains('active') || viewFoldedFormBtn.classList.contains('active') || viewBlueprintBtn.classList.contains('active'))) {
      setViewPreset('design');
    }
    renderer.render();
    updatePropertiesPanel();
    updateScrollbars();
    // Equivalent to tmwxDoc::OnKillCreasePatternUpdateUI().
    killCpBtn.disabled = !hasCreasePattern;
    viewCreasesBtn.disabled = !hasCreasePattern;
    viewPlanBtn.disabled = !hasCreasePattern;
    viewFoldedFormBtn.disabled = !hasCreasePattern;
    viewBlueprintBtn.disabled = !hasCreasePattern;
    vertexListBtn.disabled = !hasCreasePattern;
    // Equivalent to tmwxDoc::OnSelectPartByIndexUpdateUI(), extended to
    // keep the whole index list (not just an enable flag) in sync with the
    // tree and the current selection.
    renderPartIndexList();
    // Equivalent to tmwxDoc::OnSelectAllUpdateUI()/OnSelectNoneUpdateUI() —
    // selectNodesAndEdgesBtn is this SPA's actual port of that command now
    // (see selectAll()'s comment), so it gets the original's exact enable
    // condition; selectAllBtn (this SPA's own "everything" button) reuses it.
    selectNodesAndEdgesBtn.disabled = tree.getNumEditableParts() === 0;
    selectAllBtn.disabled = tree.getNumEditableParts() === 0;
    selectNoneBtn.disabled = editor.getSelectionCount() === 0;
    selectMovablePartsBtn.disabled = tree.getNumMovableParts() === 0;
    unpinAllBtn.disabled = !editor.hasPinnedNodes();
    selectPathFromNodesBtn.disabled = editor.selectedNodes.length !== 2;
    selectCorridorFacetsBtn.disabled = !tree.canGetCorridorFacets() || editor.selectedEdges.length === 0;
    // Moved here from the (now-removed) Facet inspector panel: jumping to
    // the selected facet's containing polygon only makes sense with
    // exactly one facet selected.
    facetJumpToPolyBtn.disabled = !editor.selectedFacet?.poly;
    // Equivalent to tmwxDoc::OnMakeNodeRootUpdateUI()/
    // OnPerturbSelectedNodesUpdateUI()/OnPerturbAllNodesUpdateUI().
    editMakeRootBtn.disabled = !tree.canMakeNodeRoot(editor.selectedNode);
    editPerturbSelectedBtn.disabled = editor.selectedNodes.length === 0;
    editPerturbAllBtn.disabled = !tree.canPerturbAllNodes();
    // Same action, same enable condition, as the Edit panel's "Make Root"
    // above — this is just the node inspector's own copy of it (see
    // OnMakeNodeRoot()'s comment).
    nodeMakeRootBtn.disabled = editMakeRootBtn.disabled;
    // Equivalent to tmwxDoc::OnSetEdgeLengthUpdateUI()/
    // OnScaleEdgeLengthUpdateUI()/OnRenormalizeToEdgeUpdateUI()/
    // OnRenormalizeToUnitScaleUpdateUI().
    editSetLengthBtn.disabled = editor.selectedEdges.length === 0;
    editScaleLengthBtn.disabled = editor.selectedEdges.length === 0;
    editRenormalizeSelectionBtn.disabled = !(editor.selectedEdges.length === 1 && editor.getSelectionCount() === 1);
    // Same action, same enable condition, as the Edit panel's "Renormalize
    // to Selection" above — the edge inspector's own copy of it. Always
    // true in practice here (the edge inspector only shows with exactly
    // one edge selected and nothing else), but kept in sync anyway rather
    // than assumed.
    edgeRenormalizeSelectionBtn.disabled = editRenormalizeSelectionBtn.disabled;
    editRenormalizeUnitScaleBtn.disabled = tree.getEdges().length === 0;
    // Equivalent to tmwxDoc::OnAbsorbSelectedNodesUpdateUI()/
    // OnAbsorbRedundantNodesUpdateUI()/OnAbsorbSelectedEdgesUpdateUI().
    editAbsorbSelectedNodeBtn.disabled = !(editor.selectedNodes.length > 0 && tree.canAbsorbNodes(editor.selectedNodes));
    // Same action, same enable condition, as the Edit panel's "Selected
    // Node" absorb button above — the node inspector's own copy of it.
    nodeAbsorbBtn.disabled = editAbsorbSelectedNodeBtn.disabled;
    editAbsorbRedundantNodesBtn.disabled = !tree.canAbsorbRedundantNodes();
    // DELIBERATE DEVIATION FROM THE ORIGINAL PROGRAM (documented in
    // AVANCE.md) — not a port of tmwxDoc::OnAbsorbSelectedEdgesUpdateUI(),
    // which (matching tmTree::CanAbsorbEdges() always returning true) only
    // requires a non-empty edge selection. Node's own Absorb is restricted
    // to a redundant (degree-2) node — the only case AbsorbNode() is even
    // for, since it just merges that node's two edges into one — so Delete
    // is doing something Absorb structurally can't. Edge's Absorb had no
    // such distinction from Delete (AbsorbEdge() coalesces the edge's two
    // endpoint nodes into one regardless of degree), so here it's
    // restricted the same way: only enabled when the edge is incident to a
    // redundant node, i.e. absorbing it plays the same "merge away a
    // pass-through node" role Node's Absorb does.
    editAbsorbSelectedEdgeBtn.disabled = !(
      editor.selectedEdges.length > 0 &&
      editor.selectedEdges.every(edge => edge.getNode(0).isRedundant() || edge.getNode(1).isRedundant())
    );
    // Same action, same enable condition, as the Edit panel's "Selected
    // Edge" absorb button above — the edge inspector's own copy of it.
    edgeAbsorbBtn.disabled = editAbsorbSelectedEdgeBtn.disabled;
    // Equivalent to tmwxDoc::OnSplitSelectedEdgeUpdateUI().
    editSplitBtn.disabled = editor.selectedEdges.length !== 1;
    // Equivalent to tmwxDoc::OnRemoveSelectionStrainUpdateUI()/
    // OnRemoveAllStrainUpdateUI()/OnRelieveSelectionStrainUpdateUI()/
    // OnRelieveAllStrainUpdateUI().
    const selectionHasStrain = editor.selectedEdges.some(e => e.getStrain() !== 0);
    editRemoveSelectionStrainBtn.disabled = !selectionHasStrain;
    editRelieveSelectionStrainBtn.disabled = !selectionHasStrain;
    editRemoveAllStrainBtn.disabled = !tree.hasStrainedEdges();
    editRelieveAllStrainBtn.disabled = !tree.hasStrainedEdges();
    // Same enable condition, as the edge inspector's own copy of these two.
    edgeRemoveStrainBtn.disabled = !selectionHasStrain;
    edgeRelieveStrainBtn.disabled = !selectionHasStrain;
    // Equivalent to tmwxDoc::OnPickStubNodesUpdateUI()/
    // OnPickStubPolyUpdateUI()/OnAddLargestStubNodesUpdateUI()/
    // OnAddLargestStubPolyUpdateUI().
    const hasEnoughNodes = editor.selectedNodes.length >= 4;
    const hasStubPoly = !!editor.selectedPoly && editor.selectedPoly.getRingNodes().length >= 4;
    editPickStubNodesBtn.disabled = !hasEnoughNodes;
    editAddLargestStubNodesBtn.disabled = !hasEnoughNodes;
    editPickStubPolyBtn.disabled = !hasStubPoly;
    editAddLargestStubPolyBtn.disabled = !hasStubPoly;
    state.isDirty = false;
  }
}

/**
 * Refleja el estado actual de paneo/zoom en las barras de desplazamiento
 * personalizadas del canvas: tamaño y posición del thumb, y si el riel debe
 * mostrarse (solo cuando el contenido excede el canvas en ese eje). Se
 * llama tras cada render, así que cubre tanto los botones "Fit to
 * Width/Height/View" como el arrastre de las barras de desplazamiento.
 */
function updateScrollbars() {
  if (document.activeElement !== paperSizeInchesInput) {
    paperSizeInchesInput.value = renderer.getPaperSizeInches().toFixed(2);
  }

  const extents = renderer.getScrollExtents();
  if (!extents) {
    hScrollTrack.style.display = 'none';
    vScrollTrack.style.display = 'none';
    return;
  }

  const { contentWidth, contentHeight, viewportWidth, viewportHeight, scrollX, scrollY, maxScrollX, maxScrollY } = extents;

  if (maxScrollX <= 0) {
    hScrollTrack.style.display = 'none';
  } else {
    hScrollTrack.style.display = 'block';
    const trackWidth = hScrollTrack.clientWidth;
    const thumbWidth = Math.max(24, (viewportWidth / contentWidth) * trackWidth);
    const thumbLeft = (scrollX / maxScrollX) * (trackWidth - thumbWidth);
    hScrollThumb.style.width = `${thumbWidth}px`;
    hScrollThumb.style.left = `${thumbLeft}px`;
  }

  if (maxScrollY <= 0) {
    vScrollTrack.style.display = 'none';
  } else {
    vScrollTrack.style.display = 'block';
    const trackHeight = vScrollTrack.clientHeight;
    const thumbHeight = Math.max(24, (viewportHeight / contentHeight) * trackHeight);
    const thumbTop = (scrollY / maxScrollY) * (trackHeight - thumbHeight);
    vScrollThumb.style.height = `${thumbHeight}px`;
    vScrollThumb.style.top = `${thumbTop}px`;
  }
}

function startScrollDrag(axis, pointerEvent) {
  pointerEvent.preventDefault();
  const track = axis === 'x' ? hScrollTrack : vScrollTrack;
  const thumb = axis === 'x' ? hScrollThumb : vScrollThumb;
  const trackRect = track.getBoundingClientRect();
  const startPos = axis === 'x' ? pointerEvent.clientX : pointerEvent.clientY;
  const startExtents = renderer.getScrollExtents();
  if (!startExtents) return;
  const startScroll = axis === 'x' ? startExtents.scrollX : startExtents.scrollY;
  const trackLength = axis === 'x' ? trackRect.width : trackRect.height;
  const thumbLength = axis === 'x' ? thumb.offsetWidth : thumb.offsetHeight;
  const maxScroll = axis === 'x' ? startExtents.maxScrollX : startExtents.maxScrollY;
  const draggableLength = Math.max(1, trackLength - thumbLength);

  thumb.classList.add('dragging');

  const onMove = (moveEvent) => {
    const currentPos = axis === 'x' ? moveEvent.clientX : moveEvent.clientY;
    const deltaPx = currentPos - startPos;
    const deltaScroll = (deltaPx / draggableLength) * maxScroll;
    const nextScroll = Math.min(maxScroll, Math.max(0, startScroll + deltaScroll));
    const current = renderer.getScrollExtents();
    if (!current) return;
    if (axis === 'x') {
      renderer.scrollTo(nextScroll, current.scrollY);
    } else {
      renderer.scrollTo(current.scrollX, nextScroll);
    }
    state.isDirty = true;
    render();
  };

  const onUp = () => {
    thumb.classList.remove('dragging');
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };

  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

hScrollThumb.addEventListener('mousedown', (e) => startScrollDrag('x', e));
vScrollThumb.addEventListener('mousedown', (e) => startScrollDrag('y', e));

/**
 * Animation loop
 */
function animate() {
  render();
  requestAnimationFrame(animate);
}

// ===== EVENT LISTENERS =====

// Paper setup inputs
paperWidthInput.addEventListener('change', () => {
  updateTreeFromUI();
  commitAndRender();
});

paperHeightInput.addEventListener('change', () => {
  updateTreeFromUI();
  commitAndRender();
});

scaleInput.addEventListener('change', () => {
  updateTreeFromUI();
  commitAndRender();
});

symLocXInput.addEventListener('change', () => {
  updateTreeFromUI();
  commitAndRender();
});

symLocYInput.addEventListener('change', () => {
  updateTreeFromUI();
  commitAndRender();
});

symAngleInput.addEventListener('change', () => {
  updateTreeFromUI();
  commitAndRender();
});

// Equivalent to tmwxTreePanel's EVT_TEXT_ENTER(wxID_ANY, OnApply): "changes
// are also applied when you hit the Enter key" (help/windows.htm, Tree
// Panel). A plain number input's native 'change' event only fires on blur,
// so without this, pressing Enter after typing a value — the natural way
// to "confirm" a field — visibly does nothing until the user clicks
// elsewhere. Blurring reuses the 'change' listeners above instead of
// duplicating their logic.
for (const input of [paperWidthInput, paperHeightInput, scaleInput, symLocXInput, symLocYInput, symAngleInput]) {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
  });
}

viewDesignBtn.addEventListener('click', () => applyViewPreset('design'));
viewTreeBtn.addEventListener('click', () => applyViewPreset('tree'));
viewCreasesBtn.addEventListener('click', () => applyViewPreset('creases'));
viewPlanBtn.addEventListener('click', () => applyViewPreset('plan'));
viewFoldedFormBtn.addEventListener('click', () => applyViewPreset('foldedForm'));
viewBlueprintBtn.addEventListener('click', () => applyViewPreset('blueprint'));

const BUILD_STATUS_MESSAGE_KEYS = {
  [CPStatus.EDGES_TOO_SHORT]: 'build.msgEdgesTooShort',
  [CPStatus.POLYS_NOT_VALID]: 'build.msgNotPolygonValid',
  [CPStatus.POLYS_NOT_FILLED]: 'build.msgNotPolygonFilled',
  [CPStatus.POLYS_MULTIPLE_IBPS]: 'build.msgMultipleInactiveBorderPaths',
  [CPStatus.VERTICES_LACK_DEPTH]: 'build.msgNotVertexDepthValid',
  [CPStatus.FACETS_NOT_VALID]: 'build.msgNotFacetDataValid',
  [CPStatus.NOT_LOCAL_ROOT_CONNECTABLE]: 'build.msgNotLocalRootConnectable'
};

// Mirrors tmwxDoc::OnBuildCreasePattern: attempt the build, and on anything
// short of a full crease pattern, diagnose why and select every specific
// part responsible (edges/polys/vertices/creases/facets — whichever ones
// getCPStatus() reports for the failure actually hit).
buildCpBtn.addEventListener('click', () => {
  editor.clearSelection();
  tree.buildPolysAndCreasePattern();
  if (!tree.hasFullCP()) {
    const { status, badEdges, badPolys, badVertices, badCreases, badFacets } = tree.getCPStatus();
    const messageKey = BUILD_STATUS_MESSAGE_KEYS[status];
    // The affected parts (also selected on canvas below, same as the
    // original) are named here too — the diagnostic text alone doesn't say
    // HOW MANY or WHICH KIND of part is responsible, only why a build like
    // this generally fails.
    const affected = [
      [badEdges, t('label.edges')], [badPolys, t('label.polys')], [badVertices, t('label.vertices')],
      [badCreases, t('label.creases')], [badFacets, t('label.facets')]
    ].filter(([list]) => list.length > 0).map(([list, label]) => `${label}: ${list.length}`);
    if (messageKey) {
      showMessageDialog({ title: t('build.dialogTitle'), message: t(messageKey), items: affected });
    }
    editor.selectParts({ edges: badEdges, polys: badPolys, vertices: badVertices, creases: badCreases, facets: badFacets });
    console.warn('Build Crease Pattern incomplete:', {
      status,
      badEdges: badEdges.length,
      badPolys: badPolys.length,
      badVertices: badVertices.length,
      badCreases: badCreases.length,
      badFacets: badFacets.length
    });
  }
  commitAndRender();
});

// Equivalent to tmwxDoc::OnKillCreasePattern(): tears down the built crease
// pattern (mTree->KillPolysAndCreasePattern(), the same call the original's
// menu command makes despite the "Kill Crease Pattern" name only mentioning
// creases) without touching node/edge/path topology.
killCpBtn.addEventListener('click', () => {
  editor.clearSelection();
  tree.killPolysAndCreasePattern();
  commitAndRender();
});

// Equivalent to tmwxDoc::OnSelectPartByIndex()/tmwxSelectPartByIndexDialog,
// but as a live list instead of a type-an-index-and-click-Select dialog:
// one button per 1-based index within the chosen part type's list, its
// current selection (if any) highlighted. Clicking an index normally
// replaces the whole selection with that part; with "Multiple Selection"
// checked, clicks accumulate instead (toggling that index in/out of the
// selection) — see editor.selectPartByIndex()'s `additive` option.
function renderPartIndexList() {
  const partType = selectPartType.value;
  selectPartIndexList.replaceChildren();
  // "None" is the default on every page load (see index.html) and just
  // keeps the list empty instead of picking a part type for you.
  if (partType === 'none') return;
  const list = editor.getPartsByType(partType);
  if (list.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'index-list-empty';
    const type = t(`partType.${partType}`).toLowerCase();
    const article = partType === 'edge' ? 'an' : 'a';
    empty.textContent = t('edit.msgNoPartsOfType', { article, type });
    selectPartIndexList.appendChild(empty);
    return;
  }
  list.forEach((part, i) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'small';
    button.textContent = String(i + 1);
    button.classList.toggle('active', editor.isPartSelected(partType, part));
    button.addEventListener('click', () => {
      const additive = selectPartIndexMultipleCheckbox.checked;
      editor.selectPartByIndex(partType, i + 1, { additive });
      if (additive) {
        // Toggled OFF: drop it from the order list too, so it can never be
        // the one an uncheck falls back to. Toggled ON: record it as the
        // most-recently-added surviving index.
        additiveIndexSelectionOrder = additiveIndexSelectionOrder.filter(n => n !== i + 1);
        if (editor.isPartSelected(partType, part)) additiveIndexSelectionOrder.push(i + 1);
      }
      commitAndRender();
    });
    selectPartIndexList.appendChild(button);
  });
}
selectPartType.addEventListener('change', () => {
  additiveIndexSelectionOrder = [];
  renderPartIndexList();
});

// Unchecking "Multiple Selection" collapses the accumulated selection down
// to whichever index was most recently added and is still selected — an
// index that was later clicked again (removing it) is never the one kept,
// even if it was the very last click. If every added index ended up
// removed again, nothing is left to fall back to, so the selection clears
// entirely instead of leaving some earlier, unrelated part selected.
selectPartIndexMultipleCheckbox.addEventListener('change', () => {
  const partType = selectPartType.value;
  if (selectPartIndexMultipleCheckbox.checked) {
    // Seed the order with whatever's already selected (e.g. a single item
    // picked before the box was checked) in ascending index order — the
    // exact order those got selected in isn't tracked, but this still
    // means "uncheck with no list clicks in between" falls back to
    // keeping that pre-existing selection instead of wiping it.
    const list = partType === 'none' ? [] : editor.getPartsByType(partType);
    additiveIndexSelectionOrder = list
      .map((part, i) => (editor.isPartSelected(partType, part) ? i + 1 : -1))
      .filter(i => i >= 0);
    return;
  }
  const lastIndex = additiveIndexSelectionOrder.at(-1);
  additiveIndexSelectionOrder = [];
  if (lastIndex === undefined) editor.clearSelection();
  else editor.selectPartByIndex(partType, lastIndex);
  commitAndRender();
});

// Equivalent to tmwxDoc::OnSelectAll()/OnSelectNone(), except selectAll()
// itself now selects every part type (see its own comment) — this button
// is the "select absolutely everything" one; selectNodesAndEdgesBtn below
// is the original's actual node+edge-only behavior, also reachable via
// Ctrl/Cmd+A (see the keydown handler below). Escape reaches selectNone.
selectAllBtn.addEventListener('click', () => {
  editor.selectAll();
  commitAndRender();
});

selectNodesAndEdgesBtn.addEventListener('click', () => {
  editor.selectNodesAndEdges();
  commitAndRender();
});

selectNoneBtn.addEventListener('click', () => {
  editor.clearSelection();
  commitAndRender();
});

// Equivalent to tmwxDoc::OnSelectMovableParts().
selectMovablePartsBtn.addEventListener('click', () => {
  editor.selectMovableParts();
  commitAndRender();
});

// Equivalent to tmwxDoc::OnSelectPathFromNodes(): select exactly two nodes
// first, then this replaces the selection with the path between them.
selectPathFromNodesBtn.addEventListener('click', () => {
  editor.selectPathFromNodes();
  commitAndRender();
});

// Equivalent to tmwxDoc::OnSelectCorridorFacets(): select the edge(s)
// first, then this replaces the selection with their corridor facets.
selectCorridorFacetsBtn.addEventListener('click', () => {
  editor.selectCorridorFacets();
  commitAndRender();
});

// Equivalent to tmwxDoc::OnMakeNodeRoot() — same action as the node
// inspector's own "Make Root" button, reachable here too like the
// original's Edit->Nodes menu.
editMakeRootBtn.addEventListener('click', () => {
  editor.setSelectedNodeAsRoot();
  commitAndRender();
});

// Equivalent to tmwxDoc::OnPerturbSelectedNodes()/OnPerturbAllNodes().
editPerturbSelectedBtn.addEventListener('click', () => {
  editor.perturbSelectedNodes();
  commitAndRender();
});

editPerturbAllBtn.addEventListener('click', () => {
  editor.perturbAllNodes();
  commitAndRender();
});

// Equivalent to tmwxDoc::OnSetEdgeLength() + tmwxSetEdgeLengthDialog::Validate()
// (edge length must be >= 0.001), collecting the value through the shared
// prompt modal (promptForFields(), same one edgeScaleLengthBtn below already
// uses for the Edge inspector's own "Scale Length") instead of a standing
// sidebar input.
editSetLengthBtn.addEventListener('click', () => {
  promptForFields({
    title: t('edit.setLength'),
    fields: [{
      label: t('edit.lengthLabel'),
      defaultValue: '1.0000',
      numeric: { min: 0.001, max: Infinity, decimals: 4 }
    }],
    onConfirm: ([valueStr]) => {
      const value = Number(valueStr);
      if (!Number.isFinite(value) || value < 0.001) {
        showMessageDialog({ title: t('edit.setLength'), message: t('edit.msgInvalidLength', { value: valueStr }) });
        return;
      }
      editor.setSelectedEdgeLengths(value);
      commitAndRender();
    }
  });
});

// Equivalent to tmwxDoc::OnScaleEdgeLength() + tmwxScaleEdgeLengthDialog::Validate()
// (scaling factor must be > 0), same modal-based pattern as edgeScaleLengthBtn
// below (the Edge inspector's own "Scale Length").
editScaleLengthBtn.addEventListener('click', () => {
  promptForFields({
    title: t('edit.scaleLength'),
    fields: [{
      label: t('edit.scalingFactorLabel'),
      defaultValue: '1.0000',
      numeric: { min: 0, max: Infinity, decimals: 4 }
    }],
    onConfirm: ([valueStr]) => {
      const value = Math.max(0, Number(valueStr));
      if (!Number.isFinite(value) || value <= 0) {
        showMessageDialog({ title: t('edit.scaleLength'), message: t('edit.msgInvalidFactor', { value: valueStr }) });
        return;
      }
      editor.scaleSelectedEdgeLengths(value);
      commitAndRender();
    }
  });
});

// Same action as the Edit panel's "Scale Length" above, same modal.
edgeScaleLengthBtn.addEventListener('click', () => {
  promptForFields({
    title: t('edit.scaleLength'),
    fields: [{
      label: t('edit.scalingFactorLabel'),
      defaultValue: '1.0000',
      // A scaling factor isn't a [0, 1] fraction — 2 doubles the length.
      numeric: { min: 0, max: Infinity, decimals: 4 }
    }],
    onConfirm: ([valueStr]) => {
      const value = Math.max(0, Number(valueStr));
      if (!Number.isFinite(value) || value <= 0) {
        showMessageDialog({ title: t('edit.scaleLength'), message: t('edit.msgInvalidFactor', { value: valueStr }) });
        return;
      }
      editor.scaleSelectedEdgeLengths(value);
      commitAndRender();
    }
  });
});

// Equivalent to tmwxDoc::OnRenormalizeToEdge()/OnRenormalizeToUnitScale().
editRenormalizeSelectionBtn.addEventListener('click', () => {
  editor.renormalizeToSelectedEdge();
  commitAndRender();
});

// Same action as the Edit panel's "Renormalize to Selection" above.
edgeRenormalizeSelectionBtn.addEventListener('click', () => {
  editor.renormalizeToSelectedEdge();
  commitAndRender();
});

editRenormalizeUnitScaleBtn.addEventListener('click', () => {
  editor.renormalizeToUnitScale();
  commitAndRender();
});

// Equivalent to tmwxDoc::OnAbsorbSelectedNodes()/OnAbsorbRedundantNodes()/
// OnAbsorbSelectedEdges().
editAbsorbSelectedNodeBtn.addEventListener('click', () => {
  editor.absorbSelectedNodes();
  commitAndRender();
});

nodeAbsorbBtn.addEventListener('click', () => {
  editor.absorbSelectedNodes();
  commitAndRender();
});

editAbsorbRedundantNodesBtn.addEventListener('click', () => {
  editor.absorbRedundantNodes();
  commitAndRender();
});

editAbsorbSelectedEdgeBtn.addEventListener('click', () => {
  editor.absorbSelectedEdges();
  commitAndRender();
});

edgeAbsorbBtn.addEventListener('click', () => {
  editor.absorbSelectedEdges();
  commitAndRender();
});

// Same action as the Edit panel's "Split Selected Edge" below, collecting
// the split point through openSplitEdgeDialog() — the original's Split
// Edge dialog, its own modal (see the function's own comment).
edgeSplitBtn.addEventListener('click', () => {
  if (!editor.selectedEdge) return;
  openSplitEdgeDialog(editor.selectedEdge);
});

// Same as the left panel's Strain section (editor.selectedEdges is just
// [this edge] whenever the inspector has it selected, so reusing these
// selection-scoped methods applies to this edge alone).
edgeRemoveStrainBtn.addEventListener('click', () => {
  editor.removeSelectionStrain();
  commitAndRender();
});

edgeRelieveStrainBtn.addEventListener('click', () => {
  editor.relieveSelectionStrain();
  commitAndRender();
});

// Same action as the Edge inspector's "Split" above (edgeSplitBtn), same
// openSplitEdgeDialog() modal — replaced the sidebar's own standing
// mode/value inputs, which duplicated it with a slightly different UI.
editSplitBtn.addEventListener('click', () => {
  if (!editor.selectedEdge) return;
  openSplitEdgeDialog(editor.selectedEdge);
});

// Equivalent to tmwxDoc::OnRemoveSelectionStrain()/OnRemoveAllStrain()/
// OnRelieveSelectionStrain()/OnRelieveAllStrain().
editRemoveSelectionStrainBtn.addEventListener('click', () => {
  editor.removeSelectionStrain();
  commitAndRender();
});

editRemoveAllStrainBtn.addEventListener('click', () => {
  editor.removeAllStrain();
  commitAndRender();
});

editRelieveSelectionStrainBtn.addEventListener('click', () => {
  editor.relieveSelectionStrain();
  commitAndRender();
});

editRelieveAllStrainBtn.addEventListener('click', () => {
  editor.relieveAllStrain();
  commitAndRender();
});

// Equivalent to tmwxDoc::DoPickStub()/OnPickStubNodes()/OnPickStubPoly()/
// OnAddLargestStubNodes()/OnAddLargestStubPoly(): a two-step "find, then
// pick one" flow for Pick, and a direct one-step flow for Add Largest.
let currentStubChoices = [];

function describeStub(stub) {
  const edgeLabel = stub.edge?.label || stub.edge?.id || 'N/A';
  const remaining = (stub.edge?.getStrainedLength?.() ?? 0) - stub.edgeLocation;
  const nodeLabels = stub.activeNodes.map(node => node.label || node.id).join(', ');
  return `Edge ${edgeLabel} (${stub.edgeLocation.toFixed(4)}/${remaining.toFixed(4)}), nodes ${nodeLabels}, stub len = ${stub.length.toFixed(4)}`;
}

function showStubChoices(stubs) {
  currentStubChoices = stubs;
  editStubChoices.replaceChildren();
  stubs.forEach((stub, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = describeStub(stub);
    editStubChoices.appendChild(option);
  });
  editStubChoices.style.display = 'inline-block';
  editAddPickedStubBtn.style.display = 'inline-block';
}

function hideStubChoices() {
  currentStubChoices = [];
  editStubChoices.style.display = 'none';
  editAddPickedStubBtn.style.display = 'none';
}

editPickStubNodesBtn.addEventListener('click', () => {
  const stubs = editor.findStubsForSelectedNodes();
  if (stubs.length === 0) {
    hideStubChoices();
    showMessageDialog({ title: t('edit.pickStubNodes'), message: t('edit.msgNoStubsForSet') });
    return;
  }
  showStubChoices(stubs);
});

editPickStubPolyBtn.addEventListener('click', () => {
  const stubs = editor.findStubsForSelectedPoly();
  if (stubs.length === 0) {
    hideStubChoices();
    showMessageDialog({ title: t('edit.pickStubPoly'), message: t('edit.msgNoStubsForSet') });
    return;
  }
  showStubChoices(stubs);
});

editAddPickedStubBtn.addEventListener('click', () => {
  const stub = currentStubChoices[Number(editStubChoices.value)];
  if (!stub) return;
  editor.addStub(stub);
  hideStubChoices();
  commitAndRender();
});

editAddLargestStubNodesBtn.addEventListener('click', () => {
  hideStubChoices();
  const result = editor.addLargestStubForSelectedNodes();
  if (!result) {
    showMessageDialog({ title: t('edit.addLargestStubNodes'), message: t('edit.msgNoStubForNodes') });
    return;
  }
  commitAndRender();
});

editAddLargestStubPolyBtn.addEventListener('click', () => {
  hideStubChoices();
  const result = editor.addLargestStubForSelectedPoly();
  if (!result) {
    showMessageDialog({ title: t('edit.addLargestStubPoly'), message: t('edit.msgNoStubForPoly') });
    return;
  }
  commitAndRender();
});

// Equivalent to tmwxDoc::OnNodeFixedTo{SymmetryLine,PaperEdge,Corner,
// Position}(): all four real commands operate on the same
// tmConditionNodeCombo per node, just toggling a different subset of its 5
// independent flags, which the original lets combine freely. This SPA's UI
// deliberately makes the four "Fixed to..." toggles mutually exclusive
// instead (simpler mental model: a node is fixed one way at a time) — so
// turning one on here always clears X/Y fixing too.
function applyNodeFixCombo(sourceCheckbox) {
  const node = editor.selectedNode;
  if (!node || !node.isLeafNode) return;

  if (sourceCheckbox?.checked) {
    for (const checkbox of [nodeFixToSymmetryLineCheckbox, nodeFixToPaperEdgeCheckbox, nodeFixToPaperCornerCheckbox]) {
      if (checkbox !== sourceCheckbox) checkbox.checked = false;
    }
    nodeFixToPositionCheckbox.checked = false;
  }

  let condition = tree.getConditions().find(item => (
    item instanceof ConditionNodeCombo && item.getNode() === node
  ));
  if (!condition) {
    condition = new ConditionNodeCombo(tree, node);
    tree.addCondition(condition);
  }

  condition.setToSymmetryLine(nodeFixToSymmetryLineCheckbox.checked);
  condition.setToPaperEdge(nodeFixToPaperEdgeCheckbox.checked);
  condition.setToPaperCorner(nodeFixToPaperCornerCheckbox.checked);
  condition.setXFixed(false);
  condition.setYFixed(false);

  if (condition.isEmpty()) tree.removeCondition(condition);
  commitAndRender();
}
for (const checkbox of [nodeFixToSymmetryLineCheckbox, nodeFixToPaperEdgeCheckbox, nodeFixToPaperCornerCheckbox]) {
  checkbox.addEventListener('change', () => applyNodeFixCombo(checkbox));
}

// "Fixed to Position" is the fourth mutually-exclusive toggle, but unlike the
// other three it needs a value before it means anything, so a plain click
// opens the same X/Y-with-checkbox editor this panel used to show inline
// (see the CNxn audit) as a modal instead — the native checkbox toggle is
// suppressed (preventDefault) so its `checked` state stays fully driven by
// what the dialog actually confirms, via the next renderNodePanel().
nodeFixToPositionCheckbox.addEventListener('click', (e) => {
  e.preventDefault();
  openFixToPositionDialog();
});

function openFixToPositionDialog() {
  const node = editor.selectedNode;
  if (!node || !node.isLeafNode) return;

  const condition = tree.getConditions().find(item => (
    item instanceof ConditionNodeCombo && item.getNode() === node
  ));

  promptTitle.textContent = t('node.fixToPositionDialogTitle');
  promptFieldsContainer.replaceChildren();

  const xCheckbox = document.createElement('input');
  xCheckbox.type = 'checkbox';
  xCheckbox.checked = condition?.getXFixed() || false;
  const xLabel = document.createElement('label');
  xLabel.append(xCheckbox, document.createTextNode(' X'));
  const xInput = document.createElement('input');
  xInput.type = 'text';
  xInput.inputMode = 'decimal';
  xInput.className = 'prompt-input';
  xInput.value = formatNumeric(condition?.getXFixValue() ?? node.location.x);
  xInput.disabled = !xCheckbox.checked;
  bindNumericInput(xInput, { min: 0, max: () => tree.getPaperWidth() });
  const xRow = document.createElement('div');
  xRow.className = 'prompt-radio-row';
  xRow.append(xLabel, xInput);

  const yCheckbox = document.createElement('input');
  yCheckbox.type = 'checkbox';
  yCheckbox.checked = condition?.getYFixed() || false;
  const yLabel = document.createElement('label');
  yLabel.append(yCheckbox, document.createTextNode(' Y'));
  const yInput = document.createElement('input');
  yInput.type = 'text';
  yInput.inputMode = 'decimal';
  yInput.className = 'prompt-input';
  yInput.value = formatNumeric(flipDisplayY(condition?.getYFixValue() ?? node.location.y));
  yInput.disabled = !yCheckbox.checked;
  bindNumericInput(yInput, { min: 0, max: () => tree.getPaperHeight() });
  const yRow = document.createElement('div');
  yRow.className = 'prompt-radio-row';
  yRow.append(yLabel, yInput);

  function handleXToggle() {
    xInput.disabled = !xCheckbox.checked;
  }
  function handleYToggle() {
    yInput.disabled = !yCheckbox.checked;
  }
  xCheckbox.addEventListener('change', handleXToggle);
  yCheckbox.addEventListener('change', handleYToggle);

  promptFieldsContainer.append(xRow, yRow);
  promptOverlay.style.display = 'flex';
  xInput.focus();

  function close() {
    promptOverlay.style.display = 'none';
    promptOkBtn.removeEventListener('click', handleOk);
    promptCancelBtn.removeEventListener('click', handleCancel);
    promptFieldsContainer.removeEventListener('keydown', handleKeydown);
    xCheckbox.removeEventListener('change', handleXToggle);
    yCheckbox.removeEventListener('change', handleYToggle);
  }
  function handleOk() {
    const xFixed = xCheckbox.checked;
    const yFixed = yCheckbox.checked;
    const xValue = Number(xInput.value);
    const yValue = flipDisplayY(Number(yInput.value));
    close();

    let cond = tree.getConditions().find(item => (
      item instanceof ConditionNodeCombo && item.getNode() === node
    ));
    if (!xFixed && !yFixed) {
      if (cond) {
        cond.setXFixed(false);
        cond.setYFixed(false);
        if (cond.isEmpty()) tree.removeCondition(cond);
      }
      commitAndRender();
      return;
    }
    if (!cond) {
      cond = new ConditionNodeCombo(tree, node);
      tree.addCondition(cond);
    }
    cond.setToSymmetryLine(false);
    cond.setToPaperEdge(false);
    cond.setToPaperCorner(false);
    cond.setXFixed(xFixed);
    if (xFixed) cond.setXFixValue(xValue);
    cond.setYFixed(yFixed);
    if (yFixed) cond.setYFixValue(yValue);
    commitAndRender();
  }
  function handleCancel() {
    close();
  }
  function handleKeydown(e) {
    if (e.key === 'Enter') handleOk();
    else if (e.key === 'Escape') handleCancel();
  }
  promptOkBtn.addEventListener('click', handleOk);
  promptCancelBtn.addEventListener('click', handleCancel);
  promptFieldsContainer.addEventListener('keydown', handleKeydown);
}

// Last X/Y values applied through the Fixed to Position modal below —
// purely so the toggle's own label can redisplay in the current language
// on every render (see renderSelFixToPositionLabel()/renderGroupPanel()).
// Not "current state" in any stronger sense: unlike the single-node
// inspector, the leaf nodes this batch editor applies to can each already
// have a different (or no) fixed position, so there's nothing truthful to
// read back and reflect here beyond "what was last applied from here".
let selFixToPositionLast = { xFixed: false, xValue: 0, yFixed: false, yValue: 0 };

function renderSelFixToPositionLabel() {
  const { xFixed, xValue, yFixed, yValue } = selFixToPositionLast;
  selFixToPositionCheckbox.checked = xFixed || yFixed;
  if (xFixed && yFixed) {
    selFixToPositionLabel.textContent = t('node.fixToPositionBoth', { x: formatNumeric(xValue, 4), y: formatNumeric(flipDisplayY(yValue), 4) });
  } else if (xFixed) {
    selFixToPositionLabel.textContent = t('node.fixToPositionX', { x: formatNumeric(xValue, 4) });
  } else if (yFixed) {
    selFixToPositionLabel.textContent = t('node.fixToPositionY', { y: formatNumeric(flipDisplayY(yValue), 4) });
  } else {
    selFixToPositionLabel.textContent = t('node.fixToPosition');
  }
}
renderSelFixToPositionLabel();

// Equivalent to tmwxDoc::OnNodeFixedTo{SymmetryLine,PaperEdge,Corner}():
// applies immediately on toggle, to every selected leaf node at once
// (tmTree::SetNodesFixedTo*() loops over the whole leaf list the same
// way) — same live-apply, mutually-exclusive-with-the-other-three
// behavior as the single-node inspector's own four toggles, just batched.
function applySelectionFixCombo(sourceCheckbox) {
  const leafNodes = getSelectionLeafNodes();
  if (leafNodes.length === 0) return;

  if (sourceCheckbox?.checked) {
    for (const checkbox of [selFixToSymmetryLineCheckbox, selFixToPaperEdgeCheckbox, selFixToPaperCornerCheckbox]) {
      if (checkbox !== sourceCheckbox) checkbox.checked = false;
    }
    selFixToPositionLast = { xFixed: false, xValue: 0, yFixed: false, yValue: 0 };
    renderSelFixToPositionLabel();
  }

  for (const node of leafNodes) {
    let condition = tree.getConditions().find(item => (
      item instanceof ConditionNodeCombo && item.getNode() === node
    ));
    if (!condition) {
      condition = new ConditionNodeCombo(tree, node);
      tree.addCondition(condition);
    }

    condition.setToSymmetryLine(selFixToSymmetryLineCheckbox.checked);
    condition.setToPaperEdge(selFixToPaperEdgeCheckbox.checked);
    condition.setToPaperCorner(selFixToPaperCornerCheckbox.checked);
    condition.setXFixed(false);
    condition.setYFixed(false);

    if (condition.isEmpty()) tree.removeCondition(condition);
  }
  commitAndRender();
}
for (const checkbox of [selFixToSymmetryLineCheckbox, selFixToPaperEdgeCheckbox, selFixToPaperCornerCheckbox]) {
  checkbox.addEventListener('change', () => applySelectionFixCombo(checkbox));
}

// Fixed to Position is itself a toggle, but — like the single-node
// inspector's own version — needs a value before it means anything, so a
// plain click opens the same X/Y-with-checkbox modal instead of toggling
// live. The native checkbox toggle is suppressed (preventDefault) so its
// `checked` state stays fully driven by what the dialog actually applies.
selFixToPositionCheckbox.addEventListener('click', (e) => {
  e.preventDefault();
  openSelectionFixToPositionDialog();
});

function openSelectionFixToPositionDialog() {
  promptTitle.textContent = t('node.fixToPositionDialogTitle');
  promptFieldsContainer.replaceChildren();

  // No single existing value to prefill from, unlike the single-node
  // dialog — this applies the same literal value to every selected leaf
  // node at once, and those nodes can each already have a different
  // fixed position (or none). Always starts unchecked/blank.
  const xCheckbox = document.createElement('input');
  xCheckbox.type = 'checkbox';
  const xLabel = document.createElement('label');
  xLabel.append(xCheckbox, document.createTextNode(' X'));
  const xInput = document.createElement('input');
  xInput.type = 'text';
  xInput.inputMode = 'decimal';
  xInput.className = 'prompt-input';
  xInput.value = formatNumeric(0);
  xInput.disabled = true;
  bindNumericInput(xInput, { min: 0, max: () => tree.getPaperWidth() });
  const xRow = document.createElement('div');
  xRow.className = 'prompt-radio-row';
  xRow.append(xLabel, xInput);

  const yCheckbox = document.createElement('input');
  yCheckbox.type = 'checkbox';
  const yLabel = document.createElement('label');
  yLabel.append(yCheckbox, document.createTextNode(' Y'));
  const yInput = document.createElement('input');
  yInput.type = 'text';
  yInput.inputMode = 'decimal';
  yInput.className = 'prompt-input';
  yInput.value = formatNumeric(0);
  yInput.disabled = true;
  bindNumericInput(yInput, { min: 0, max: () => tree.getPaperHeight() });
  const yRow = document.createElement('div');
  yRow.className = 'prompt-radio-row';
  yRow.append(yLabel, yInput);

  // The requested addition over the single-node dialog: X and Y are
  // mutually exclusive here (this modal fixes every selected leaf node to
  // the SAME literal value — fixing both coordinates of 2+ different
  // nodes to one shared point would collapse them on top of each other).
  function handleXToggle() {
    if (xCheckbox.checked) yCheckbox.checked = false;
    xInput.disabled = !xCheckbox.checked;
    yInput.disabled = !yCheckbox.checked;
  }
  function handleYToggle() {
    if (yCheckbox.checked) xCheckbox.checked = false;
    xInput.disabled = !xCheckbox.checked;
    yInput.disabled = !yCheckbox.checked;
  }
  xCheckbox.addEventListener('change', handleXToggle);
  yCheckbox.addEventListener('change', handleYToggle);

  promptFieldsContainer.append(xRow, yRow);
  promptOverlay.style.display = 'flex';
  xInput.focus();

  function close() {
    promptOverlay.style.display = 'none';
    promptOkBtn.removeEventListener('click', handleOk);
    promptCancelBtn.removeEventListener('click', handleCancel);
    promptFieldsContainer.removeEventListener('keydown', handleKeydown);
    xCheckbox.removeEventListener('change', handleXToggle);
    yCheckbox.removeEventListener('change', handleYToggle);
  }
  function handleOk() {
    const xFixed = xCheckbox.checked;
    const yFixed = yCheckbox.checked;
    const xValue = Number(xInput.value);
    const yValue = flipDisplayY(Number(yInput.value));
    close();

    const leafNodes = getSelectionLeafNodes();
    if (leafNodes.length === 0) return;

    if (xFixed || yFixed) {
      selFixToSymmetryLineCheckbox.checked = false;
      selFixToPaperEdgeCheckbox.checked = false;
      selFixToPaperCornerCheckbox.checked = false;
    }

    for (const node of leafNodes) {
      let condition = tree.getConditions().find(item => (
        item instanceof ConditionNodeCombo && item.getNode() === node
      ));
      if (!xFixed && !yFixed) {
        if (condition) {
          condition.setXFixed(false);
          condition.setYFixed(false);
          if (condition.isEmpty()) tree.removeCondition(condition);
        }
        continue;
      }
      if (!condition) {
        condition = new ConditionNodeCombo(tree, node);
        tree.addCondition(condition);
      }
      condition.setToSymmetryLine(false);
      condition.setToPaperEdge(false);
      condition.setToPaperCorner(false);
      condition.setXFixed(xFixed);
      if (xFixed) condition.setXFixValue(xValue);
      condition.setYFixed(yFixed);
      if (yFixed) condition.setYFixValue(yValue);
    }

    selFixToPositionLast = { xFixed, xValue, yFixed, yValue };
    renderSelFixToPositionLabel();
    commitAndRender();
  }
  function handleCancel() {
    close();
  }
  function handleKeydown(e) {
    if (e.key === 'Enter') handleOk();
    else if (e.key === 'Escape') handleCancel();
  }
  promptOkBtn.addEventListener('click', handleOk);
  promptCancelBtn.addEventListener('click', handleCancel);
  promptFieldsContainer.addEventListener('keydown', handleKeydown);
}

function findPairCondition([first, second]) {
  return tree.getConditions().find(condition => (
    condition instanceof ConditionNodesPaired &&
    ((condition.getNode1() === first && condition.getNode2() === second) ||
      (condition.getNode1() === second && condition.getNode2() === first))
  ));
}

// Equivalent to tmwxDoc::OnNodesPairedAboutSymmetryLine(): mirrors the two
// selected leaf nodes about the tree's symmetry line (ConditionNodesPaired,
// tag "CNpn"). Applies immediately on toggle — checked adds the condition,
// unchecked removes it (the original command only ever adds; this SPA's
// toggle covers both directions, same as it does for the Fix Node block).
// A leaf node can only be paired with ONE other node at a time — checking
// this removes any prior pairing either of the two already had with some
// OTHER node before creating the new one, rather than leaving both in
// place (the original never has to handle this: OnNodesPairedAbout
// SymmetryLineUpdateUI() doesn't check for a pre-existing different pair
// before enabling the command).
selPairToggle.addEventListener('change', () => {
  const leafNodes = getSelectionLeafNodes();
  if (leafNodes.length !== 2) return;
  const [first, second] = leafNodes;

  if (selPairToggle.checked) {
    for (const condition of tree.getConditions()) {
      if (!(condition instanceof ConditionNodesPaired)) continue;
      const isThisPair = (condition.getNode1() === first && condition.getNode2() === second) ||
        (condition.getNode1() === second && condition.getNode2() === first);
      if (isThisPair) continue;
      if (condition.getNode1() === first || condition.getNode2() === first ||
        condition.getNode1() === second || condition.getNode2() === second) {
        tree.removeCondition(condition);
      }
    }
    if (!findPairCondition(leafNodes)) tree.addCondition(new ConditionNodesPaired(tree, first, second));
  } else {
    const existing = findPairCondition(leafNodes);
    if (existing) tree.removeCondition(existing);
  }
  commitAndRender();
});

function findCollinearCondition(leafNodes) {
  const ids = new Set(leafNodes.map(node => node.id));
  return tree.getConditions().find(condition => (
    condition instanceof ConditionNodesCollinear &&
    new Set([condition.getNode1().id, condition.getNode2().id, condition.getNode3().id]).size === ids.size &&
    [...ids].every(id => [condition.getNode1().id, condition.getNode2().id, condition.getNode3().id].includes(id))
  ));
}

// Equivalent to tmwxDoc::OnNodesCollinear(): forces the three selected leaf
// nodes onto a single line (ConditionNodesCollinear, tag "CNcn"). Applies
// immediately on toggle — checked adds the condition, unchecked removes it
// (the original command, GetOrMakeThreePartCondition(), only ever adds;
// this SPA's toggle covers both directions, same as the Pair toggle above).
// Same "one condition of this kind per node at a time" rule as Pair: checking
// this removes any prior collinearity condition any of the three nodes
// already had with a DIFFERENT pair of nodes.
selCollinearToggle.addEventListener('change', () => {
  const leafNodes = getSelectionLeafNodes();
  if (leafNodes.length !== 3) return;
  const [first, second, third] = leafNodes;

  if (selCollinearToggle.checked) {
    for (const condition of tree.getConditions()) {
      if (!(condition instanceof ConditionNodesCollinear)) continue;
      const nodes = [condition.getNode1(), condition.getNode2(), condition.getNode3()];
      const isThisTriplet = [first, second, third].every(node => nodes.includes(node));
      if (isThisTriplet) continue;
      if (nodes.includes(first) || nodes.includes(second) || nodes.includes(third)) {
        tree.removeCondition(condition);
      }
    }
    if (!findCollinearCondition(leafNodes)) tree.addCondition(new ConditionNodesCollinear(tree, first, second, third));
  } else {
    const existing = findCollinearCondition(leafNodes);
    if (existing) tree.removeCondition(existing);
  }
  commitAndRender();
});

function findNoStrainCondition(edge) {
  return tree.getConditions().find(item => (
    item instanceof ConditionEdgeLengthFixed && item.getEdge() === edge
  ));
}

// "No Strain" fixes an edge's length outright; "Same Strain" forces it to
// match another edge's (possibly nonzero) strain — the two are
// contradictory intents on the same edge, so applying either one now
// clears the other from whatever edge it touches (this SPA's own rule,
// not in the original — see the two toggles below).
function removeSameStrainConditionsForEdge(edge) {
  for (const condition of tree.getConditions()) {
    if (condition instanceof ConditionEdgesSameStrain &&
      (condition.getEdge1() === edge || condition.getEdge2() === edge)) {
      tree.removeCondition(condition);
    }
  }
}

// Equivalent to tmwxDoc::OnEdgeLengthFixed() — labeled "Edge(s) No Strain"
// in the original (tmwxID_EDGE_LENGTH_FIXED's real menu text/tooltip:
// "Add a condition that forces this edge to have zero strain"), not a
// user-chosen custom length: it fixes the edge at its CURRENT tree length,
// so the edge simply stops being allowed to stretch away from unstrained.
// The checkbox IS the condition's state — no separate Apply button:
// checking it adds the condition, unchecking removes it.
edgeNoStrainCheckbox.addEventListener('change', () => {
  const edge = editor.selectedEdge;
  if (!edge) return;

  const existing = findNoStrainCondition(edge);
  if (edgeNoStrainCheckbox.checked) {
    if (!existing) {
      removeSameStrainConditionsForEdge(edge);
      tree.addCondition(new ConditionEdgeLengthFixed(tree, edge, edge.getLength()));
    }
  } else if (existing) {
    tree.removeCondition(existing);
  }
  commitAndRender();
});

// Same as edgeNoStrainCheckbox above (tmwxDoc::OnEdgeLengthFixed(), enabled
// for 1+ selected edges — GetOrMakeOnePartCondition() over the whole
// selection), just batched over every currently selected edge at once
// instead of a single one. Checked reflects whether ALL selected edges
// already carry the condition; toggling applies/removes it on every one.
selNoStrainToggle.addEventListener('change', () => {
  const edges = editor.selectedEdges;
  if (edges.length === 0) return;

  for (const edge of edges) {
    const existing = findNoStrainCondition(edge);
    if (selNoStrainToggle.checked) {
      if (!existing) {
        removeSameStrainConditionsForEdge(edge);
        tree.addCondition(new ConditionEdgeLengthFixed(tree, edge, edge.getLength()));
      }
    } else if (existing) {
      tree.removeCondition(existing);
    }
  }
  commitAndRender();
});

function findSameStrainCondition(first, second) {
  return tree.getConditions().find(condition => (
    condition instanceof ConditionEdgesSameStrain &&
    ((condition.getEdge1() === first && condition.getEdge2() === second) ||
      (condition.getEdge1() === second && condition.getEdge2() === first))
  ));
}

// Equivalent to tmwxDoc::OnEdgesSameStrain() / tmTree::SetEdgesSameStrain(),
// narrowed to exactly the two selected edges (the original pairs every
// selected edge with the first one, for 2+ — this SPA's toggle only ever
// shows for exactly 2, see renderGroupPanel()). Applies immediately on
// toggle — checked adds the condition (clearing "No Strain" from either
// edge first, see removeSameStrainConditionsForEdge()'s doc comment above),
// unchecked removes it (the original command only ever adds).
selSameStrainToggle.addEventListener('change', () => {
  const edges = editor.selectedEdges;
  if (edges.length !== 2) return;
  const [first, second] = edges;

  const existing = findSameStrainCondition(first, second);
  if (selSameStrainToggle.checked) {
    if (!existing) {
      for (const edge of [first, second]) {
        const noStrain = findNoStrainCondition(edge);
        if (noStrain) tree.removeCondition(noStrain);
      }
      tree.addCondition(new ConditionEdgesSameStrain(tree, first, second));
    }
  } else if (existing) {
    tree.removeCondition(existing);
  }
  commitAndRender();
});

/**
 * El path sobre el que actúan los tres botones de condición de camino: el
 * seleccionado directamente (clic en la línea, Select Path From Nodes,
 * Select by Index).
 */
function getActivePath() {
  return editor.selectedPath;
}

// The checkbox IS each condition's state — no separate Apply button.
// Activate Path needs nothing else and applies immediately; Fix Angle
// prompts for the angle first (see promptForNumber() below). Quantize
// Angle still has no way to type a custom value (see PENDIENTE.md) — for
// now turning it on just applies step 4 / offset 0, the same defaults the
// removed inputs used to start at.
pathActiveToggle.addEventListener('change', () => {
  const path = getActivePath();
  if (!path) return;
  const existing = tree.getConditions().find(condition => (
    condition instanceof ConditionPathActive && condition.getPath() === path
  ));
  if (pathActiveToggle.checked) {
    if (!existing) tree.addCondition(new ConditionPathActive(tree, path));
  } else if (existing) {
    tree.removeCondition(existing);
  }
  commitAndRender();
});

// Checking this needs one more thing than the other two toggles: the angle
// itself. promptForNumber() collects it — defaulting to the path's current
// angle — before the condition actually gets added; Cancel puts the toggle
// back off instead of leaving it checked with nothing behind it.
pathFixAngleToggle.addEventListener('change', () => {
  const path = getActivePath();
  if (!path) return;
  if (pathFixAngleToggle.checked) {
    const pathInfo = editor.getSelectedPathInfo();
    promptForNumber({
      title: t('path.fixAngle'),
      label: t('path.angleDegreesLabel'),
      defaultValue: (pathInfo?.angleDeg ?? 0).toFixed(3),
      onConfirm: (value) => {
        const angleDeg = Number(value);
        if (!Number.isFinite(angleDeg)) {
          pathFixAngleToggle.checked = false;
          return;
        }
        tree.addCondition(new ConditionPathAngleFixed(tree, path, angleDeg * PI / 180));
        commitAndRender();
      },
      onCancel: () => {
        pathFixAngleToggle.checked = false;
      }
    });
  } else {
    const existing = tree.getConditions().find(condition => (
      condition instanceof ConditionPathAngleFixed && condition.getPath() === path
    ));
    if (existing) tree.removeCondition(existing);
    commitAndRender();
  }
});

// Same pattern as Fix Angle above, just with two fields instead of one —
// promptForFields() (rather than the promptForNumber() wrapper) collects
// both before the condition gets added.
pathQuantizeToggle.addEventListener('change', () => {
  const path = getActivePath();
  if (!path) return;
  if (pathQuantizeToggle.checked) {
    promptForFields({
      title: t('path.quantizeAngle'),
      fields: [
        { label: t('path.quantizeStepsLabel'), defaultValue: '4' },
        { label: t('path.quantizeOffsetDegreesLabel'), defaultValue: '0' }
      ],
      onConfirm: ([stepsStr, offsetStr]) => {
        const quantValue = Math.max(1, Math.round(Number(stepsStr)));
        const offsetDeg = Number(offsetStr);
        if (!Number.isFinite(quantValue) || !Number.isFinite(offsetDeg)) {
          pathQuantizeToggle.checked = false;
          return;
        }
        tree.addCondition(new ConditionPathAngleQuant(tree, path, quantValue, offsetDeg * PI / 180));
        commitAndRender();
      },
      onCancel: () => {
        pathQuantizeToggle.checked = false;
      }
    });
  } else {
    const existing = tree.getConditions().find(condition => (
      condition instanceof ConditionPathAngleQuant && condition.getPath() === path
    ));
    if (existing) tree.removeCondition(existing);
    commitAndRender();
  }
});


facetJumpToPolyBtn.addEventListener('click', () => {
  const poly = editor.selectedFacet?.poly;
  if (!poly) return;
  editor.selectPoly(poly);
  commitAndRender();
});

/**
 * Muestra el resultado de un solve/diagnose en el panel de estado
 */
function renderSolverStatus(result, error = null) {
  state.lastSolverResult = result;
  state.lastSolverError = error;
  // #solverStatus was briefly removed from the sidebar during a visual
  // cleanup pass and reinstated (see PENDIENTE.md/AVANCE.md) — without it,
  // every Maximize Scale/Scale Selection/Minimize Strain outcome, including
  // outright failures (this function's own `error` branch below), was
  // invisible to the user, logged only to the console. `if (!solverStatus)`
  // stays as a guard rather than an assumption the element exists, same
  // spirit as the rest of this file's DOM lookups.
  if (!solverStatus) return;
  if (error) {
    solverStatus.className = 'solver-status fail';
    solverStatus.textContent = t('status.error', { msg: error.message });
    return;
  }
  if (!result) {
    solverStatus.className = 'solver-status';
    solverStatus.textContent = t('status.noResult');
    return;
  }
  if (result.reason === 'not-enough-leaves') {
    solverStatus.className = 'solver-status fail';
    solverStatus.textContent = t('status.needLeaves');
    return;
  }
  // 'no-moving-nodes'/'no-moving-edges': EdgeOptimizer's equivalent of the
  // original's two distinct EX_NO_MOVING_NODES/EX_NO_MOVING_EDGES
  // exceptions ("no movable nodes" vs "no strainable edges" in
  // tmwxDoc::OnScaleSelection) — both surface as the same "need a
  // selection" message here, same as the old single combined reason code.
  if (['no-moving-nodes-or-edges', 'no-moving-nodes', 'no-moving-edges'].includes(result.reason)) {
    solverStatus.className = 'solver-status fail';
    solverStatus.textContent = t('status.needSelection');
    return;
  }
  if (result.cancelled) {
    solverStatus.className = 'solver-status';
    solverStatus.textContent = t('status.cancelled');
    return;
  }
  solverStatus.className = `solver-status ${result.converged ? 'ok' : 'fail'}`;
  const parts = [result.converged ? t('status.converged') : t('status.notConverged')];
  if (result.iterations !== undefined) parts.push(t('status.iterations', { n: result.iterations }));
  if (result.residualNorm !== undefined) parts.push(t('status.residual', { n: result.residualNorm.toFixed(6) }));
  else if (result.objective !== undefined) parts.push(t('status.objective', { n: result.objective.toFixed(6) }));
  if (result.degreesOfFreedom !== undefined) parts.push(t('status.dof', { n: result.degreesOfFreedom }));
  if (result.status) parts.push(t('status.status', { s: t(`status.value.${result.status}`) }));
  if (result.scale !== undefined && result.previousScale !== undefined) {
    parts.push(t('status.scale', { a: result.previousScale.toFixed(4), b: result.scale.toFixed(4) }));
    if (!result.improved) parts.push(t('status.noImprovement'));
  }
  if (result.strain !== undefined) parts.push(t('status.strain', { n: result.strain.toFixed(4) }));
  if (result.rmsStrain !== undefined) parts.push(t('status.rmsStrain', { n: (result.rmsStrain * 100).toFixed(2) }));
  solverStatus.textContent = parts.join(' · ');
}

// EdgeOptimizer/StrainOptimizer/ScaleOptimizer only ever report THAT a solve
// didn't converge (`reason: 'did-not-converge'`, or ScaleOptimizer's own
// bare `{converged: false}` once every restart is exhausted) — never WHY.
// NewtonRaphson.diagnose() (wired to tree.diagnoseConstraints(), otherwise
// unreachable from the UI — see the earlier error-handling audit) inspects
// the same underlying node/edge conditions independently of which action
// triggered the failed solve, and tells 'infeasible' (the conditions
// contradict each other — no scale/strain/position ever satisfies all of
// them at once, this app's closest equivalent to the original's "Bad
// Convergence") apart from 'singular' (the tree just isn't pinned down
// enough yet — more of a "keep going" than a dead end). renderSolverStatus()
// already knows how to render `status`/`degreesOfFreedom` on a result, it
// just never had anyone put them there for these three actions specifically
// — reason-coded early failures (cancelled, not-enough-leaves, no moving
// nodes/edges) already have a clear, sufficient message and skip this.
const REASONS_WORTH_DIAGNOSING = new Set([undefined, 'did-not-converge']);
function enrichWithDiagnosis(result) {
  if (result.converged || result.cancelled || !REASONS_WORTH_DIAGNOSING.has(result.reason)) return result;
  const diagnosis = tree.diagnoseConstraints();
  return { ...result, status: diagnosis.status, degreesOfFreedom: diagnosis.degreesOfFreedom };
}

let scaleEverythingController = null;

busyCancelBtn.addEventListener('click', () => {
  scaleEverythingController?.abort();
});

scaleEverythingBtn.addEventListener('click', async () => {
  scaleEverythingController = new AbortController();
  busyOverlay.style.display = 'flex';
  scaleEverythingBtn.disabled = true;
  try {
    const selectionMode = scaleAllowDifferentLayoutCheckbox.checked ? 'max' : 'similar';
    const result = await tree.scaleEverythingAsync({ signal: scaleEverythingController.signal, selectionMode });
    scaleInput.value = tree.getScale().toFixed(4);
    renderSolverStatus(enrichWithDiagnosis(result));
    console.log('Scale Everything:', result);
    if (result.converged && !result.cancelled) {
      lastConvergedScale = result.scale;
      renderScaleLabel();
    }
  } catch (error) {
    console.error('Error al escalar todo:', error);
    renderSolverStatus(null, error);
  } finally {
    busyOverlay.style.display = 'none';
    scaleEverythingBtn.disabled = false;
    scaleEverythingController = null;
  }
  commitAndRender();
});

// Bulk version of the inspector's per-node "Unpin" (arms every currently
// pinned node's drag override at once) — doesn't itself change the tree,
// so no history commit either.
unpinAllBtn.addEventListener('click', () => {
  editor.unpinAllNodes();
  state.isDirty = true;
  render();
});

scaleSelectionBtn.addEventListener('click', () => {
  try {
    const result = tree.scaleSelection(editor.selectedNodes, editor.selectedEdges);
    renderSolverStatus(enrichWithDiagnosis(result));
    console.log('Scale Selection:', result);
  } catch (error) {
    console.error('Error al escalar la selección:', error);
    renderSolverStatus(null, error);
  }
  commitAndRender();
});

// Equivalent to tmwxDoc::OnMinimizeStrain(): unlike Scale Selection (which
// forces all selected edges to share one maximized strain), this gives
// each selected edge its own independent strain and minimizes the
// stiffness-weighted sum of squares, to repair a selection that's gone
// infeasible or unnecessarily strained.
minimizeStrainBtn.addEventListener('click', () => {
  try {
    const result = tree.minimizeStrain(editor.selectedNodes, editor.selectedEdges);
    renderSolverStatus(enrichWithDiagnosis(result));
    console.log('Minimize Strain:', result);
  } catch (error) {
    console.error('Error al minimizar la tensión:', error);
    renderSolverStatus(null, error);
  }
  commitAndRender();
});

// Tracks the file last opened via "Open .tmd5" (name + raw text) — shown
// in #loadedFileNameInput and reapplied by "Revert" (resetBtn, see below)
// without re-prompting a file picker. Cleared by resetToInitialState():
// after a full Reset there's no "current file" left to revert to.
let loadedTmd5FileName = null;
let loadedTmd5Text = null;

function updateLoadedFileUI() {
  const hasFile = loadedTmd5FileName !== null;
  loadedFileNameInput.style.display = hasFile ? '' : 'none';
  loadedFileNameInput.value = hasFile ? loadedTmd5FileName : '';
  resetBtn.disabled = !hasFile;
}
// Firefox restores a plain F5 reload's DOM/form state (see the
// firefox-form-restore-on-reload note) — resetBtn's disabled attribute is
// static in index.html, but this forces it (and the hidden filename
// input) back to "no file loaded" on every fresh script run regardless.
updateLoadedFileUI();

// tmTree.recalculateFeasibility()'s detailed report, turned into one
// translated line per issue for showMessageDialog()'s bullet list. Covers
// every field that report can carry: a node condition whose current
// position doesn't actually satisfy it (e.g. "Fixed to Paper Corner" on a
// node that isn't at one), a leaf-to-leaf path shorter than its required
// minimum, a node dragged/typed outside the paper, a tree split into
// disconnected pieces, and the handful of fields that should only ever
// come from a corrupt file or an internal bug (cyclic/invalid edges,
// invalid topology, invalid paper size or scale) — included anyway so
// nothing recalculateFeasibility() can report is ever silently dropped.
function describeFeasibilityIssues(report) {
  const items = [];
  for (const condition of report.invalidConditions) {
    items.push(t('feasibility.itemCondition', { desc: condition?.toString?.() || t('condition.generic') }));
  }
  for (const path of report.infeasiblePaths) {
    // tree.paths holds every leaf-to-leaf AND leaf-to-branch path (used
    // internally for corridor/facet feasibility, not just the ones the
    // canvas actually draws a line for) — describing one by just its first
    // and last node ("Path 3–4") reads as a direct edge or a leaf-to-leaf
    // connection that doesn't exist, which is exactly what a real report
    // showed: a "3–4" path that goes 3 → 2 → 4, findable on canvas nowhere,
    // because the 2 in the middle was silently dropped. Naming it the same
    // way the Path Inspector itself does ("Path {n}", tree.getPaths()'s own
    // 1-based index) plus the full node route fixes both: the user can jump
    // straight to it via Select Part by Index, and immediately sees it
    // isn't a direct connection.
    const nodes = path.getNodes?.() || [];
    const index = tree.getPaths().indexOf(path) + 1;
    items.push(t('feasibility.itemPath', { n: index, route: nodes.map(node => node.label).join('–') }));
  }
  for (const node of report.outOfBoundsNodes) {
    items.push(t('feasibility.itemOutOfBounds', { label: node.label }));
  }
  if (report.components.length > 1) {
    items.push(t('feasibility.itemDisconnected', { n: report.components.length }));
  }
  if (report.cyclicEdges.length > 0) {
    items.push(t('feasibility.itemCycles', { n: report.cyclicEdges.length }));
  }
  for (const edge of report.invalidEdges) {
    items.push(t('feasibility.itemInvalidEdge', { label: edge.getLabel?.() ?? edge.label ?? '?' }));
  }
  for (const node of report.invalidNodes) {
    items.push(t('feasibility.itemInvalidNode', { label: node.label }));
  }
  if (report.invalidTopology.length > 0) {
    items.push(t('feasibility.itemInvalidTopology', { n: report.invalidTopology.length }));
  }
  if (report.invalidPaper) items.push(t('feasibility.itemInvalidPaper'));
  if (report.invalidScale) items.push(t('feasibility.itemInvalidScale'));
  return items;
}

// Shared by the auto-popup on file load and the persistent chip's click
// handler below — same report, same breakdown, just a different trigger.
function openFeasibilityDialog(report) {
  const items = describeFeasibilityIssues(report);
  showMessageDialog({
    title: t('feasibility.title'),
    message: t('feasibility.intro', { n: items.length }),
    items,
    severity: 'warning'
  });
}

// The original's closest equivalent is opening a file whose stored node
// positions don't actually solve its own conditions and getting a "Bad
// Convergence" dialog after TreeMaker's own solver gives up trying to fix
// them — this SPA never runs that solver on load (see conversation), it
// just checks whether the position ALREADY stored in the file satisfies
// each condition. Same user-facing moment either way: a file was just
// opened and something about it doesn't add up. Reuses lastFeasibilityReport
// rather than recomputing: applyLoadedTmd5Text() already ran
// commitAndRender() (and so refreshFeasibilityChip()) just before this runs.
function checkFeasibilityAfterLoad() {
  if (lastFeasibilityReport.feasible) return;
  openFeasibilityDialog(lastFeasibilityReport);
}

// Live feasibility indicator (#feasibilityChip in index.html): unlike the
// load-time popup above (a one-off event), this reflects whatever the tree
// looks like right now, always — dragging a node onto a fixed condition it
// doesn't satisfy, toggling "Fixed to Paper Corner" on a node that isn't at
// one, typing an edge length that makes a path infeasible... none of those
// go through file load, so without this the only feedback was the faint
// violet/salmon dot CanvasRenderer already draws on each condition (easy to
// miss, and it doesn't explain WHY). Recomputed once per commitAndRender()
// call (see its own comment) — never per animation frame.
let lastFeasibilityReport = null;
function refreshFeasibilityChip() {
  lastFeasibilityReport = tree.recalculateFeasibility();
  const n = describeFeasibilityIssues(lastFeasibilityReport).length;
  feasibilityChip.style.display = lastFeasibilityReport.feasible ? 'none' : 'block';
  if (!lastFeasibilityReport.feasible) {
    feasibilityChipText.textContent = t('feasibility.chip', { n });
  }
}
feasibilityChip.addEventListener('click', () => {
  if (lastFeasibilityReport && !lastFeasibilityReport.feasible) openFeasibilityDialog(lastFeasibilityReport);
});

// Shared by the file picker's change handler and "Revert": parses a
// .tmd5 document's text and applies it as the current tree.
function applyLoadedTmd5Text(text) {
  let skippedConditions = [];
  const restoredTree = tmd5ToTree(text, { onSkippedConditions: (skipped) => { skippedConditions = skipped; } });
  Object.assign(tree, restoredTree);
  renderer.setTree(tree);
  editor.tree = tree;
  renderer.fitViewport();
  paperWidthInput.value = formatNumeric(tree.getPaperWidth());
  paperHeightInput.value = formatNumeric(tree.getPaperHeight());
  scaleInput.value = tree.getScale().toFixed(4);
  setSymmetryValue(tree.getSymmetryType());
  symLocXInput.value = formatNumeric(tree.getSymLoc().x);
  symLocYInput.value = formatNumeric(tree.getSymLoc().y);
  symAngleInput.value = formatNumeric(flipAngleDegrees(tree.getSymAngle()), 2);
  syncSymmetryFieldsEnabled();
  // commitAndRender() itself now calls tree.refreshPathStates(), which
  // recomputes isPinnedNode/isPinnedEdge/isBorderPath/isPolygonPath from
  // geometry — needed here since this app's own writer doesn't round-trip
  // them, so the file's own flags can't be trusted either.
  commitAndRender();
  // Both dialogs can fire from the same load — showMessageDialog() queues
  // the second behind the first instead of one silently overwriting the
  // other (see its own comment). Skipped-conditions goes first: it explains
  // why the tree may already look lighter than the file, before the
  // feasibility summary judges whatever's left.
  if (skippedConditions.length > 0) {
    showMessageDialog({
      title: t('controls.load'),
      message: t('error.conditionsSkippedOnLoad', { n: skippedConditions.length }),
      items: skippedConditions.map(({ tag, index }) => t('error.skippedConditionEntry', { tag, index: index ?? '?' })),
      severity: 'warning'
    });
  }
  checkFeasibilityAfterLoad();
}

saveTmd5Btn.addEventListener('click', async () => {
  let skippedConditions = [];
  const text = treeToTmd5(tree, { onSkippedConditions: (skipped) => { skippedConditions = skipped; } });
  // Reuse the loaded file's own name when there is one, instead of always
  // suggesting the same fixed name.
  const suggestedName = loadedTmd5FileName ?? 'treemaker-tree.tmd5';

  // Only worth telling the user about once the file has actually been
  // written — a save the user themselves cancelled (AbortError below)
  // didn't lose anything, so it stays silent same as before.
  function reportSkippedConditions() {
    if (skippedConditions.length === 0) return;
    showMessageDialog({
      title: t('controls.save'),
      message: t('error.conditionsSkippedOnSave', { n: skippedConditions.length }),
      items: skippedConditions.map(condition => condition?.toString?.() || t('condition.generic')),
      severity: 'warning'
    });
  }

  // Chromium-based browsers implement the File System Access API and get
  // a real "Save As" dialog (choose folder + name) through it. Firefox
  // doesn't (see PENDIENTE.md) — no web API lets a page choose or change
  // where a plain download lands, so that case falls through to the
  // <a download> below, which only gets to suggest a name.
  if ('showSaveFilePicker' in window) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: [{
          description: 'TreeMaker file',
          accept: { 'text/plain': ['.tmd5'] }
        }]
      });
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
      reportSkippedConditions();
    } catch (error) {
      if (error.name === 'AbortError') return; // user cancelled the dialog
      console.error('No se pudo guardar el archivo .tmd5:', error);
      showMessageDialog({ title: t('dialog.errorTitle'), message: t('error.saveFile', { msg: error.message }), severity: 'error' });
    }
    return;
  }

  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = suggestedName;
  link.click();
  URL.revokeObjectURL(url);
  reportSkippedConditions();
});

loadTmd5Btn.addEventListener('click', () => {
  loadTmd5Input.click();
});

loadTmd5Input.addEventListener('change', async () => {
  const file = loadTmd5Input.files?.[0];
  if (!file) return;

  try {
    const text = await file.text();
    applyLoadedTmd5Text(text);
    loadedTmd5FileName = file.name;
    loadedTmd5Text = text;
    updateLoadedFileUI();
  } catch (error) {
    console.error('No se pudo abrir el archivo .tmd5:', error);
    showMessageDialog({ title: t('dialog.errorTitle'), message: t('error.loadFile', { msg: error.message }), severity: 'error' });
  } finally {
    loadTmd5Input.value = '';
  }
});

// "Revert": reapplies the last opened file's own content, discarding
// whatever's changed in the tree since — only enabled while a file is
// loaded (see updateLoadedFileUI()).
resetBtn.addEventListener('click', () => {
  if (!loadedTmd5Text) return;
  try {
    applyLoadedTmd5Text(loadedTmd5Text);
  } catch (error) {
    console.error('No se pudo revertir al archivo cargado:', error);
    showMessageDialog({ title: t('dialog.errorTitle'), message: t('error.loadFile', { msg: error.message }), severity: 'error' });
  }
});

fitToWidthBtn.addEventListener('click', () => {
  renderer.fitToWidth();
  state.isDirty = true;
  render();
});

fitToHeightBtn.addEventListener('click', () => {
  renderer.fitToHeight();
  state.isDirty = true;
  render();
});

// toFixed() with the sign dropped when the rounded result is "negative
// zero" (e.g. -0.00001.toFixed(4) === "-0.0000"): true bit-for-bit, but
// reads as a formatting bug in a coordinate table where nothing is
// actually negative there.
function formatSigned(value, decimals) {
  const formatted = value.toFixed(decimals);
  return formatted.startsWith('-') && Number(formatted) === 0 ? formatted.slice(1) : formatted;
}

// A vertex sitting exactly on one of the paper's own 4 corners — every
// rectangular paper has one there regardless of size, so it never says
// anything about this particular design. Compared in design space (favors
// exact 0/paperWidth/paperHeight over the flipped display value, though
// the corner set is the same either way). The tolerance reuses this app's
// standard paper-space feasibility tolerance (tmTree's own DIST_TOL,
// equivalent to the original's tmPart::DistTol()) instead of a tighter
// one: a corner vertex coming out of buildPolysAndCreasePattern()'s solve
// routinely lands a few 1e-5 off exact 0/1, well past float noise, so a
// stricter epsilon left real corners in the list.
const PAPER_CORNER_EPS = 1e-4;
function isPaperCorner(vertex, paperWidth, paperHeight) {
  const x = vertex.getLocX();
  const y = vertex.getLocY();
  const atXEdge = Math.abs(x) < PAPER_CORNER_EPS || Math.abs(x - paperWidth) < PAPER_CORNER_EPS;
  const atYEdge = Math.abs(y) < PAPER_CORNER_EPS || Math.abs(y - paperHeight) < PAPER_CORNER_EPS;
  return atXEdge && atYEdge;
}

/**
 * The Vertex List modal's data: one entry per "major" vertex — the ones
 * Plan View itself labels with coordinates even without "Show all labels"
 * (see CanvasRenderer's _drawVertices(), `vertex.isMajorVertex()`) —
 * excluding the paper's own 4 corners, sorted per the "Bottom to Top" /
 * "Left to Right" select, each as raw [designX, designY, realX, realY]
 * numbers. Y is flipped for display, same as Plan View's own coordinate
 * readout (this app's tree space has Y increasing downward; the
 * user-facing convention has it increasing upward from the paper's bottom
 * edge) — so is "Bottom to Top", which sorts ascending on that same
 * flipped value. Real X/Y scale the design coordinates so the paper's
 * design width maps to the "Real paper width" field. Shared by
 * buildVertexListTable() and exportVertexList() so both always agree.
 */
function getVertexListRows() {
  const paperHeight = tree.getPaperHeight();
  const designPaperWidth = tree.getPaperWidth();
  const majors = tree.getVertices()
    .filter(v => v.isMajorVertex() && !isPaperCorner(v, designPaperWidth, paperHeight));

  const sortByX = vertexListSortOrderSelect.value === 'x';
  majors.sort((a, b) => sortByX
    ? a.getLocX() - b.getLocX()
    : (paperHeight - a.getLocY()) - (paperHeight - b.getLocY()));

  const realPaperWidth = Number(vertexListRealPaperWidthInput.value) || 0;
  const scale = designPaperWidth > 0 ? realPaperWidth / designPaperWidth : 0;

  return majors.map(vertex => {
    const designX = vertex.getLocX();
    const designY = paperHeight - vertex.getLocY();
    return [designX, designY, designX * scale, designY * scale];
  });
}

function buildVertexListTable() {
  vertexListBody.replaceChildren();
  const rows = getVertexListRows();
  if (rows.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'vertex-list-empty';
    empty.textContent = t('vertexList.empty');
    vertexListBody.appendChild(empty);
    return;
  }

  const table = document.createElement('table');
  table.className = 'vertex-list-table';
  const thead = document.createElement('thead');
  thead.innerHTML = `
    <tr>
      <th colspan="2">${t('vertexList.designScale')}</th>
      <th colspan="2">${t('vertexList.realSize')}</th>
    </tr>
    <tr>
      <th>${t('vertexList.colX')}</th><th>${t('vertexList.colY')}</th>
      <th>${t('vertexList.colX')}</th><th>${t('vertexList.colY')}</th>
    </tr>
  `;
  const tbody = document.createElement('tbody');
  for (const [designX, designY, realX, realY] of rows) {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${formatSigned(designX, 4)}</td>
      <td>${formatSigned(designY, 4)}</td>
      <td>${formatSigned(realX, 2)}</td>
      <td>${formatSigned(realY, 2)}</td>
    `;
    tbody.appendChild(row);
  }
  table.append(thead, tbody);
  vertexListBody.appendChild(table);
}

// Fixed-width column for the plain-text export below: right-aligned in an
// 8-character field, same as a column of a monospaced table. Widening
// past 8 (a value that just doesn't fit) is left alone rather than
// truncated — still readable, just no longer column-aligned with the rest
// of that one field.
const EXPORT_COLUMN_WIDTH = 8;
function padColumn(value) {
  return String(value).padStart(EXPORT_COLUMN_WIDTH, ' ');
}

// Export (View section's Vertex List modal): a plain-text report — the
// real paper width on its own line, a blank line, then the table (header
// + one row per vertex), each column a fixed 8-character right-aligned
// field separated by a single space. Same showSaveFilePicker-with-<a
// download>-fallback pattern as Save .tmd5 above, since no web API lets a
// page choose/change the download folder on its own (see that button's
// own comment and PENDIENTE.md).
async function exportVertexList() {
  const rows = getVertexListRows();
  const lines = [
    `${t('vertexList.realPaperWidth')}: ${vertexListRealPaperWidthInput.value}`,
    '',
    ['DesignX', 'DesignY', 'RealX', 'RealY'].map(padColumn).join(' '),
    ...rows.map(([designX, designY, realX, realY]) => [
      formatSigned(designX, 4), formatSigned(designY, 4),
      formatSigned(realX, 2), formatSigned(realY, 2)
    ].map(padColumn).join(' '))
  ];
  const text = lines.join('\n');

  const baseName = (loadedTmd5FileName ?? 'vertex-list').replace(/\.tmd5$/i, '');
  const suggestedName = `${baseName}-vertices.txt`;

  if ('showSaveFilePicker' in window) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: [{ description: 'Text file', accept: { 'text/plain': ['.txt'] } }]
      });
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
    } catch (error) {
      if (error.name === 'AbortError') return;
      console.error('No se pudo exportar la lista de vértices:', error);
      showMessageDialog({ title: t('dialog.errorTitle'), message: t('error.saveFile', { msg: error.message }), severity: 'error' });
    }
    return;
  }

  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = suggestedName;
  link.click();
  URL.revokeObjectURL(url);
}

// Vertex List modal (View section): Apply (and Enter in the "Real paper
// width" field) recomputes the table's "Real Size" columns from the
// field's current value; opening the modal builds it fresh from the
// tree's current major vertices.
function openVertexListModal() {
  buildVertexListTable();
  vertexListOverlay.style.display = 'flex';
  vertexListCloseBtn.focus();
}
function applyVertexListRealSize() {
  // Forces the field's own change handler (min/max clamp + fixed decimals,
  // see bindNumericInput()) to run before buildVertexListTable() reads its
  // value, same as a real blur would — Enter here never blurs the field.
  vertexListRealPaperWidthInput.dispatchEvent(new Event('change'));
  buildVertexListTable();
}
function closeVertexListModal() {
  vertexListOverlay.style.display = 'none';
}
vertexListBtn.addEventListener('click', openVertexListModal);
vertexListCloseBtn.addEventListener('click', closeVertexListModal);
vertexListApplyBtn.addEventListener('click', applyVertexListRealSize);
vertexListExportBtn.addEventListener('click', exportVertexList);
// Sort order (Bottom to Top / Left to Right) takes effect right away,
// same as any other select in this app — unlike the paper-width field, it
// isn't something a user "types into" mid-edit, so there's no reason to
// gate it behind Apply/Enter.
vertexListSortOrderSelect.addEventListener('change', buildVertexListTable);
vertexListOverlay.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeVertexListModal();
  else if (e.key === 'Enter' && e.target === vertexListRealPaperWidthInput) applyVertexListRealSize();
});

// About modal (sidebar's own "About" button, pinned to its bottom edge —
// see .sidebar-footer in style.css): same open/close pattern as Vertex
// List above, just without any content to build first.
function openAboutModal() {
  aboutOverlay.style.display = 'flex';
  aboutCloseBtn.focus();
}
function closeAboutModal() {
  aboutOverlay.style.display = 'none';
}
aboutBtn.addEventListener('click', openAboutModal);
aboutCloseBtn.addEventListener('click', closeAboutModal);
aboutOverlay.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeAboutModal();
});

// "Show all labels" (View section): a pure display overlay, independent of
// the active view preset — see Renderer.js's showAllPartLabels comment —
// so this just flips the flag and redraws, without touching undo history.
showAllLabelsCheckbox.addEventListener('change', () => {
  renderer.showAllPartLabels = showAllLabelsCheckbox.checked;
  state.isDirty = true;
  render();
});

paperSizeInchesInput.addEventListener('change', () => {
  const inches = Number(paperSizeInchesInput.value);
  if (!(inches > 0)) return;
  renderer.setPaperSizeInches(inches);
  state.isDirty = true;
  render();
});

function resetToInitialState() {
  tree.clear();
  paperWidthInput.value = formatNumeric(1);
  paperHeightInput.value = formatNumeric(1);
  scaleInput.value = '0.1';
  setSymmetryValue('none');
  tree.setSymmetryType('none');
  symLocXInput.value = formatNumeric(0.5);
  symLocYInput.value = formatNumeric(0.5);
  symAngleInput.value = formatNumeric(0, 2);
  syncSymmetryFieldsEnabled();
  updateTreeFromUI();
  lastConvergedScale = tree.getScale();
  renderScaleLabel();
  renderer.fitViewport();
  // A fresh blank tree has no "loaded file" to revert to anymore.
  loadedTmd5FileName = null;
  loadedTmd5Text = null;
  updateLoadedFileUI();
  commitAndRender();
  console.log('Reset to initial state');
}
editResetBtn.addEventListener('click', resetToInitialState);

// Node properties
nodeLabelInput.addEventListener('change', (e) => {
  editor.setSelectedNodeLabel(e.target.value);
  commitAndRender();
});

// Direct move, not a condition: typing a value and pressing Enter (native
// 'change' on a number input) or clicking "Apply" moves the node there —
// same effect as dragging it with the mouse, clamped to the paper bounds.
function applyNodePosition() {
  editor.setSelectedNodePosition(nodeXInput.value, flipDisplayY(Number(nodeYInput.value)));
  commitAndRender();
}
nodeXInput.addEventListener('change', applyNodePosition);
nodeYInput.addEventListener('change', applyNodePosition);
nodeApplyPositionBtn.addEventListener('click', applyNodePosition);

// Arms the mouse-only override for the next drag (see NodeEditor.
// unpinSelectedNode()) — doesn't itself change the tree, so no history
// commit, just enough of a re-render for the panel/cursor to reflect it.
nodeUnpinBtn.addEventListener('click', () => {
  editor.unpinSelectedNode();
  state.isDirty = true;
  render();
});

// Same actions as the Edit panel's "Make Root"/"Perturb Selected" (see
// editMakeRootBtn/editPerturbSelectedBtn above) — this node inspector copy
// always acts on just this node, the current selection.
nodeMakeRootBtn.addEventListener('click', () => {
  editor.setSelectedNodeAsRoot();
  commitAndRender();
});

nodePerturbBtn.addEventListener('click', () => {
  editor.perturbSelectedNodes();
  commitAndRender();
});

nodeDeleteBtn.addEventListener('click', () => {
  editor.deleteSelectedNode();
  commitAndRender();
});

// Edge properties. A plain text input's native 'change' only fires on
// blur, same gap Tree's paperWidth/etc. fields have (see the Enter->blur
// list below) — the explicit "Apply" button is this panel's equivalent,
// and applies all three fields at once rather than just the one the user
// happened to leave last.
function applyEdgeProperties() {
  editor.setSelectedEdgeLength(edgeLengthInput.value);
  editor.setSelectedEdgeStrain(edgeStrainInput.value);
  editor.setSelectedEdgeStiffness(edgeStiffnessInput.value);
  commitAndRender();
}
edgeLengthInput.addEventListener('change', applyEdgeProperties);
edgeStrainInput.addEventListener('change', applyEdgeProperties);
edgeStiffnessInput.addEventListener('change', applyEdgeProperties);
edgeApplyPropertiesBtn.addEventListener('click', applyEdgeProperties);

edgeDeleteBtn.addEventListener('click', () => {
  editor.deleteSelectedEdge();
  commitAndRender();
});

// Canvas events with editor integration
canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  const { x: screenX, y: screenY } = renderer.canvasPointFromEvent(e);
  const hit = renderer.getObjectAtPoint(screenX, screenY, 15);
  // Facets are deliberately excluded here: they cover the entire interior of
  // their polygon, so treating a facet hit as "select" instead of falling
  // through would make it impossible to click inside a polygon to add a new
  // node there. Facets are only inspectable via hover info, not by click.
  // Polys ARE included — clicking inside a built tmPoly's interior selects
  // it (matching tmwxDesignCanvas::OnMouse()), replacing the old "Inspect
  // Polygon" dropdown as the only way to reach the Poly inspector panel.
  if (['node', 'edge', 'path', 'vertex', 'crease', 'poly'].includes(hit?.type)) {
    editor.onMouseDown(e, screenX, screenY);
    commitAndRender();
    return;
  }

  if (e.shiftKey) return;

  const world = renderer.screenToWorld(screenX, screenY);
  const paperWidth = tree.getPaperWidth();
  const paperHeight = tree.getPaperHeight();
  if (world.x < 0 || world.x > paperWidth || world.y < 0 || world.y > paperHeight) {
    editor.clearSelection();
    commitAndRender();
    return;
  }
  const existingNodes = tree.getNodes().slice();
  const node = new tmNode(null, new tmPoint(world.x, world.y));
  node.label = tree._nextNodeLabel();
  node.isLeafNode = true;
  tree.nodes.push(node);
  if (existingNodes.length === 0) {
    // Matches tree.addNode()'s own "first node becomes root" rule — this
    // handler builds the node/edge inline instead of calling addNode()
    // (it needs its own "nearest node"/selected-node source logic), so it
    // has to set this itself. Without it, a tree drawn entirely by
    // clicking never gets a root at all: calcDepthAndBend() bails out on
    // every single vertex the instant it can't find one (see
    // getRootNode()), and Build Crease Pattern always fails with
    // "wasn't able to compute the depth for all vertices" — regardless of
    // how well the tree is optimized, which is what the message actually
    // (misleadingly) blames.
    tree.rootNode = node;
    node.isRootNode = true;
  }
  if (existingNodes.length > 0) {
    const selectedNode = editor.selectedNode && existingNodes.includes(editor.selectedNode)
      ? editor.selectedNode
      : null;
    const sourceNode = selectedNode || existingNodes.reduce((nearest, candidate) => {
      if (!nearest) return candidate;
      return candidate.location.distance(new tmPoint(world.x, world.y)) <
        nearest.location.distance(new tmPoint(world.x, world.y)) ? candidate : nearest;
    }, null);
    const edge = new tmEdge(null, sourceNode, node);
    edge.setLength(1);
    tree.edges.push(edge);
  }
  tree.invalidate();
  tree.refreshNodeClassification();
  editor.selectNode(node);
  commitAndRender();
});

// Keeps the persistent "pointed object" row (below the canvas — see
// .canvas-status-bar) in sync with renderer.hoveredObject. Used both from
// the mousemove handler below (after renderer.onMouseMove() has just
// updated hoveredObject) and from mouseleave (to clear it once the cursor
// actually exits the canvas — hoveredObject itself only ever changes on a
// mousemove, so without this the label would keep showing whatever was
// last hovered even after the mouse left the canvas entirely).
function updateHoverInfoLabel() {
  const text = renderer.getHoveredInfoText();
  hoverInfoLabel.textContent = text;
  hoverInfoLabel.style.display = text ? 'block' : 'none';
}

canvas.addEventListener('mousemove', (e) => {
  const { x: screenX, y: screenY } = renderer.canvasPointFromEvent(e);

  editor.onMouseMove(e, screenX, screenY);
  // Deliberately isDirty-only, no commitAndRender(): this fires on every
  // frame while dragging a node (and even just hovering, for the highlight
  // redraw), so it must not touch undo history — mouseup commits the whole
  // gesture as a single step once the drag actually ends.
  state.isDirty = true;

  // Call renderer's mousemove too
  renderer.onMouseMove(e);
  updateHoverInfoLabel();
});

canvas.addEventListener('mouseleave', () => {
  renderer.hoveredObject = null;
  canvas.style.cursor = 'default';
  state.isDirty = true;
  updateHoverInfoLabel();
});

canvas.addEventListener('mouseup', (e) => {
  editor.onMouseUp(e);
  // This is where a node drag (if any) just ended, so it's the right place
  // to commit history: mousemove keeps isDirty=true on every frame while
  // dragging (see below), but never commits — otherwise dragging across
  // many animation frames would create one undo step per frame instead of
  // one for the whole gesture.
  commitAndRender();
});

// Handle window resize
window.addEventListener('resize', () => {
  const rect = canvas.parentElement.getBoundingClientRect();
  renderer.onResize(rect.width, rect.height);
});

window.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
    event.preventDefault();
    editor.selectNodesAndEdges();
    commitAndRender();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    undo();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && (
    (event.shiftKey && event.key.toLowerCase() === 'z') || event.key.toLowerCase() === 'y'
  )) {
    event.preventDefault();
    redo();
    return;
  }
  if (event.key !== 'Escape') return;
  editor.clearSelection();
  commitAndRender();
});

// Language selector
initI18n();
languageSelect.value = getLanguage();
languageSelect.addEventListener('change', () => {
  setLanguage(languageSelect.value);
});
document.addEventListener('languagechange', () => {
  if (state.lastSolverResult !== undefined) renderSolverStatus(state.lastSolverResult, state.lastSolverError);
  renderScaleLabel();
  commitAndRender();
});

// The other two Preferences-section controls persist the same way (see
// src/ui/persistedPrefs.js) — Language itself is handled above via its own
// dedicated i18n.js storage key. optimizationAlgorithmSelect is disabled
// today (only one algorithm is implemented), so this has no visible effect
// yet, but keeps its stored value ready for when a second option exists.
bindPersistedSelect(optimizationAlgorithmSelect, 'optimizationAlgorithm');
bindPersistedCheckbox(scaleAllowDifferentLayoutCheckbox, 'allowDifferentLayout');

// Color theme (Preferences): swaps the CSS custom properties the sidebar,
// Inspector and modal windows are all built from (see :root/[data-theme]
// in style.css) between the default grey-black palette and the "Sky Blue"/
// "Light Gray" alternatives — the central workspace/canvas is deliberately
// untouched by any of them. bindPersistedSelect() only restores/persists
// the <select>'s own value; applying it to the page is this app's own
// job, same as language. Falls back to 'gray' for anything else (an
// unrecognized/stale stored value), matching :root's own un-attributed
// default.
const COLOR_THEMES = new Set(['gray', 'blue', 'light']);
function applyColorTheme(theme) {
  document.documentElement.dataset.theme = COLOR_THEMES.has(theme) ? theme : 'gray';
}
bindPersistedSelect(colorThemeSelect, 'colorTheme');
applyColorTheme(colorThemeSelect.value);
colorThemeSelect.addEventListener('change', () => applyColorTheme(colorThemeSelect.value));

// The Tree panel's inputs are never otherwise synced from the tree until
// some later action does it (undo/redo, load, reset, Apply/Enter) — until
// then they just show whatever static `value=` their HTML tag happens to
// have, which the browser's own form-autofill can silently overwrite with
// values left over from a previous session (a stale paper size, symmetry
// angle, etc., that don't match the actual freshly-created tree). Force
// them to the real tree state once, right at startup.
paperWidthInput.value = formatNumeric(tree.getPaperWidth());
paperHeightInput.value = formatNumeric(tree.getPaperHeight());
scaleInput.value = tree.getScale().toFixed(4);
setSymmetryValue(tree.getSymmetryType());
symLocXInput.value = formatNumeric(tree.getSymLoc().x);
symLocYInput.value = formatNumeric(tree.getSymLoc().y);
symAngleInput.value = formatNumeric(flipAngleDegrees(tree.getSymAngle()), 2);
syncSymmetryFieldsEnabled();
lastConvergedScale = tree.getScale();
renderScaleLabel();

// Equivalent to launching with tmwxViewSettings::sDesignView active — the
// renderer's own constructor defaults are independent of this preset.
applyViewPreset('design');

// Initial setup
console.log('TreeMaker SPA initialized');
console.log('TreeMaker SPA initialized');

// Establishes lastFeasibilityReport before anything can read it — the
// default tree is trivially feasible, but without this the chip/dialog
// would otherwise see `null` until the first commitAndRender().
refreshFeasibilityChip();

// Warm up the ReferenceFinder database in the background (Web Worker) right
// away, instead of waiting for the user's first "Find Reference" click —
// see preloadRfDatabase()'s doc comment.
preloadRfDatabase();

// Start animation loop
animate();
