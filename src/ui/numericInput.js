// Standard behavior for this app's plain numeric fields (paper-relative
// coordinates, fractions): '.' is the only decimal separator — a typed ','
// (the numpad decimal key on many Spanish keyboards) is converted to '.' —
// at most 4 decimal digits are kept while typing, and once the field is
// committed (native 'change', which fires on blur or Enter-triggered blur)
// the value is clamped to [min, max] and formatted to exactly 4 decimals.
//
// This needs the field to be type="text" (with inputmode="decimal" for a
// numeric mobile keyboard), not type="number": a native number input
// rejects ',' outright — the keystroke never reaches .value, so there's
// nothing to convert — and silently blanks out script-assigned in-progress
// values like "0." (its value sanitization algorithm treats a bare trailing
// dot as invalid), which breaks live cursor-preserving edits.
const DEFAULT_DECIMALS = 4;

/** Formats a value the way a governed field always displays it: a fixed number of decimals (4 unless overridden). */
export function formatNumeric(value, decimals = DEFAULT_DECIMALS) {
  return Number(value).toFixed(decimals);
}

function sanitizeLive(raw, allowNegative, maxDecimals) {
  let s = raw.replace(/,/g, '.');
  const negative = allowNegative && s.trim().startsWith('-');
  s = s.replace(/-/g, '').replace(/[^0-9.]/g, '');
  const firstDot = s.indexOf('.');
  if (firstDot !== -1) {
    const decimals = s.slice(firstDot + 1).replace(/\./g, '').slice(0, maxDecimals);
    s = s.slice(0, firstDot) + '.' + decimals;
  }
  return (negative ? '-' : '') + s;
}

const resolveBound = (bound) => (typeof bound === 'function' ? bound() : bound);

/**
 * Binds this app's standard numeric-field format to `input`. `min`/`max`
 * default to this app's most common case, a paper-relative fraction: [0, 1],
 * kept to `decimals` digits (4 by default — pass a different count for a
 * field with its own convention, e.g. 2 for a degrees field). Either bound
 * can instead be a function returning the current bound — coordinate fields
 * (node/symmetry-line/fix-condition positions) are really bounded by the
 * tree's paper size, not a hardcoded 1, so they pass `() =>
 * tree.getPaperWidth()` / `() => tree.getPaperHeight()`, which defaults to
 * exactly [0, 1] for the common unit-square paper but stays correct for a
 * resized one.
 */
export function bindNumericInput(input, { min = 0, max = 1, decimals = DEFAULT_DECIMALS } = {}) {
  input.addEventListener('input', () => {
    const distanceFromEnd = input.value.length - (input.selectionEnd ?? input.value.length);
    const sanitized = sanitizeLive(input.value, resolveBound(min) < 0, decimals);
    if (sanitized !== input.value) {
      input.value = sanitized;
      const pos = Math.max(0, input.value.length - distanceFromEnd);
      input.setSelectionRange(pos, pos);
    }
  });

  // A field whose bounds are exactly [0, 1] (resolved fresh on each focus,
  // since a bound can be a function — a node/vertex coordinate field is
  // effectively [0, 1] only for the common unit-square paper) is always a
  // "0." plus decimals: retyping it almost never means touching that fixed
  // leading "0.", just the digits after it. Selecting only those on focus
  // lets typing immediately replace them, same as focus+select() would for
  // a whole-value field. Deferred a tick because the same click that
  // triggers 'focus' also places the caret afterward (via the browser's
  // own mouseup handling) — selecting synchronously here would just get
  // overwritten a moment later.
  input.addEventListener('focus', () => {
    if (resolveBound(min) !== 0 || resolveBound(max) !== 1) return;
    const dot = input.value.indexOf('.');
    if (dot === -1) return;
    setTimeout(() => input.setSelectionRange(dot + 1, input.value.length), 0);
  });

  // Registered here, at binding time, so it runs before any 'change'
  // listener the app itself adds later on the same element and script
  // (event listeners fire in registration order) — code reading
  // input.value in response to 'change' always sees the clamped value.
  input.addEventListener('change', () => {
    if (input.value === '' || input.value === '-') return;
    const value = Number(input.value);
    if (Number.isNaN(value)) {
      input.value = '';
      return;
    }
    input.value = formatNumeric(Math.min(resolveBound(max), Math.max(resolveBound(min), value)), decimals);
  });
}
