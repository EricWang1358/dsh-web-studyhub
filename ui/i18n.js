import { useSyncExternalStore } from 'react';
// The English catalogue (every ui/locales/en*.json and the English of the app's messages). Here it is an ordinary import; the DSH host build
// replaces this one import with an empty module (scripts/build.mjs englishOnDemand) and the catalogue arrives through loadEnglishCatalogue.
import { ENGLISH_SOURCES as BUNDLED_SOURCES } from './english-catalogue.js';
import { installEnglishAppMessages, localizeAppMessage } from '../lib/application-messages.js';
import { failureText } from './failure.js';

/** Merge catalogues in order. The first translation of a key wins; a second,
 * different translation of the same source text is reported as a conflict. */
export function mergeCatalogues(sources) {
  const catalogue = {}, origin = {}, conflicts = [];
  for (const [file, entries] of Object.entries(sources)) {
    for (const [key, value] of Object.entries(entries || {})) {
      if (!Object.hasOwn(catalogue, key)) { catalogue[key] = value; origin[key] = file; }
      else if (catalogue[key] !== value) conflicts.push({ key, files: [origin[key], file], values: [catalogue[key], value] });
    }
  }
  return { catalogue, conflicts };
}

let sources = BUNDLED_SOURCES || null, english = sources ? mergeCatalogues(sources).catalogue : {}, loading = null;
/** The catalogue's fragments by file name (null in the host build until the English catalogue has been loaded). */
export { sources as ENGLISH_SOURCES };
/** The whole zh → en catalogue, read-only (empty until it is loaded in the host build). The usage frequency record (ui/usage/names.js) reverses it to key a control by the app's own copy. */
export const uiCatalogue = () => english;
/** Whether the English catalogue is here: always in Node, the tests and the preview; in the DSH host only once loadEnglishCatalogue has resolved. */
export const englishCatalogueLoaded = () => sources !== null;
/** Fetch the English catalogue (a chunk of its own in the host build) once; resolves at once when it is already here. */
export function loadEnglishCatalogue() {
  if (sources) return Promise.resolve();
  loading ||= import('./english-catalogue.js').then(module => {
    installEnglishAppMessages(module.APP_MESSAGES);
    english = mergeCatalogues(module.ENGLISH_SOURCES).catalogue;
    sources = module.ENGLISH_SOURCES;
  }, error => { loading = null; throw error; });
  return loading;
}
const KEY = 'study-ui-language';
const listeners = new Set();
const browserLanguage = () => {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return 'zh';
  const preferred = navigator.languages?.[0] || navigator.language || 'en';
  return /^zh(?:-|$)/i.test(preferred) ? 'zh' : 'en';
};
let language = browserLanguage();
try { const saved = localStorage.getItem(KEY); if (['en', 'zh'].includes(saved)) language = saved; } catch {}
// The language last asked for: a switch to English waits for the catalogue, and a switch back meanwhile wins.
let wanted = language;
const warnUnloaded = error => { try { console.warn('StudyHub: the English interface could not be loaded; staying in Chinese', error); } catch {} };
/* An English interface never shows a sentence before its English is here: the language becomes English only once the catalogue is loaded. */
function switchLanguage(next, persist) {
  wanted = next;
  if (next === 'en' && !sources) {
    loadEnglishCatalogue().then(() => { if (wanted === 'en') switchLanguage('en', persist); }, warnUnloaded);
    return;
  }
  language = next;
  if (persist) try { localStorage.setItem(KEY, next); } catch {}
  listeners.forEach(fn => fn());
}
// At boot an English interface fetches its catalogue at once; the host awaits uiLanguageReady() before StudyHub's first render.
const ready = language === 'en' && !sources
  ? loadEnglishCatalogue().then(() => listeners.forEach(fn => fn()), error => { warnUnloaded(error); if (wanted === 'en') switchLanguage('zh', false); })
  : Promise.resolve();
/** Resolves when the interface language can render: at once in Chinese, once the English catalogue is loaded in English (never rejects). */
export const uiLanguageReady = () => ready;
export const getUiLanguage = () => language;
/** For logic that has to pick DATA by language (the language a model answers in, which host text to keep). A sentence of the interface is never chosen with it: that is ui(). */
export const uiIsEnglish = () => language === 'en';
const LANGUAGE_NAMES = { en: 'English', zh: '中文' };
export const uiLanguageName = () => LANGUAGE_NAMES[language];
export const uiLocale = () => language === 'en' ? 'en-US' : 'zh-CN';
/** Synchronous whenever the catalogue is here (always outside the DSH host); in the host a first switch to English loads it, then switches. */
export function setUiLanguage(next) {
  if (!['en','zh'].includes(next)) return;
  switchLanguage(next, true);
}
if (typeof window !== 'undefined') window.addEventListener('storage', event => {
  if (event.key === KEY) switchLanguage(['en', 'zh'].includes(event.newValue) ? event.newValue : browserLanguage(), false);
});
const subscribe = fn => { listeners.add(fn); return () => listeners.delete(fn); };
export function useUiLanguage() { return useSyncExternalStore(subscribe, getUiLanguage, getUiLanguage); }
/** Application-owned copy only. Never pass question, source or user content. */
export function ui(value) {
  if (language !== 'en' || typeof value !== 'string') return value;
  if (Object.hasOwn(english, value)) return english[value];
  const clean = value.replace(/\s+/g,' ').trim();
  return Object.hasOwn(english, clean) ? `${value.match(/^\s*/)[0]}${english[clean]}${value.match(/\s*$/)[0]}` : value;
}
export const uiLabels = labels => new Proxy(labels, { get: (target, key) => ui(target[key]) });
/** Application diagnostics only; unknown provider details are kept verbatim. */
export const uiMessage = value => localizeAppMessage(ui(value), language);
/** What a failure says, for the learner: its message (or the value thrown) through uiMessage, so an English page never shows a Chinese host message. */
export const errorMessage = failure => uiMessage(failureText(failure));
export function uiFormat(template, values) {
  return ui(template).replace(/\{(\d+)\}/g, (match, index) => index < values.length ? String(values[index] ?? '') : match);
}
