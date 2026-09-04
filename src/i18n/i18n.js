import translations from './translations.json';

const STORAGE_KEY = 'treemaker.lang';
const DEFAULT_LANG = 'en';

let currentLang = translations[localStorage.getItem(STORAGE_KEY)]
  ? localStorage.getItem(STORAGE_KEY)
  : DEFAULT_LANG;

export function getLanguage() {
  return currentLang;
}

export function t(key, vars) {
  const table = translations[currentLang] || translations[DEFAULT_LANG];
  let text = table[key] ?? translations[DEFAULT_LANG][key] ?? key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.replaceAll(`{${name}}`, value);
    }
  }
  return text;
}

function applyStaticTranslations() {
  document.documentElement.lang = currentLang;
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
  });
  document.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
    el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria-label')));
  });
}

export function setLanguage(lang) {
  if (!translations[lang] || lang === currentLang) return;
  currentLang = lang;
  localStorage.setItem(STORAGE_KEY, lang);
  applyStaticTranslations();
  document.dispatchEvent(new CustomEvent('languagechange'));
}

export function initI18n() {
  applyStaticTranslations();
}
