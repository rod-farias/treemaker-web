// Persists a form control's value across sessions via localStorage — the
// same mechanism src/i18n/i18n.js already uses for the Language preference
// (its own dedicated 'treemaker.lang' key, left untouched). These two cover
// the rest of the Preferences section: Optimization and "Allow a
// higher-scoring but very different layout". Every key here lives under one
// prefix so this doesn't collide with i18n.js's key or anything a future
// persisted section adds.
const PREFIX = 'treemaker.pref.';

/**
 * Restores `select`'s value from localStorage on bind (falling back to
 * whatever the element's own current value already is — e.g. its HTML
 * `selected` option — when nothing was stored yet, or the stored value no
 * longer matches any option), then keeps it in sync on every 'change'. The
 * assignment on bind runs unconditionally, so it wins over whatever a
 * browser's own form-restore-on-reload feature (Firefox notably) may have
 * already set — the same fix already applied to every other control in this
 * app that needs a specific value on every load.
 */
export function bindPersistedSelect(select, key) {
  const storageKey = PREFIX + key;
  const stored = localStorage.getItem(storageKey);
  if (stored !== null && [...select.options].some(option => option.value === stored)) {
    select.value = stored;
  }
  select.addEventListener('change', () => {
    localStorage.setItem(storageKey, select.value);
  });
}

/** Same as bindPersistedSelect(), for a checkbox's `checked` state. */
export function bindPersistedCheckbox(checkbox, key) {
  const storageKey = PREFIX + key;
  const stored = localStorage.getItem(storageKey);
  if (stored !== null) checkbox.checked = stored === '1';
  checkbox.addEventListener('change', () => {
    localStorage.setItem(storageKey, checkbox.checked ? '1' : '0');
  });
}
