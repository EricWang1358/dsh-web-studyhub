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
try { const saved = localStorage.getItem(KEY); if (['en', 'zh'].includes(saved)) language = saved; } catch { /* storage is blocked: the default language stays */ }
// The language last asked for: a switch to English waits for the catalogue, and a switch back meanwhile wins.
let wanted = language;
const warnUnloaded = error => { try { console.warn('StudyHub: the English interface could not be loaded; staying in Chinese', error); } catch { /* no console to warn on */ } };
/* An English interface never shows a sentence before its English is here: the language becomes English only once the catalogue is loaded. */
function switchLanguage(next, persist) {
  wanted = next;
  if (next === 'en' && !sources) {
    loadEnglishCatalogue().then(() => { if (wanted === 'en') switchLanguage('en', persist); }, warnUnloaded);
    return;
  }
  language = next;
  if (persist) try { localStorage.setItem(KEY, next); } catch { /* storage is blocked: the choice lasts for this visit */ }
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
// Include catalogue readiness in the store snapshot so React re-renders once the on-demand English catalogue resolves even if language was already 'en'.
const languageSnapshot = () => (language === 'en' ? (sources ? 'en:1' : 'en:0') : 'zh:1');
export function useUiLanguage() {
  const snap = useSyncExternalStore(subscribe, languageSnapshot, languageSnapshot);
  return typeof snap === 'string' ? snap.slice(0, 2) : snap;
}
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
/** The singular of a counted English key: when the first value is 1 and the catalogue has `<key>#one` (the key of "{0} questions" with #one: "{0} question"), that form is used,
    so "1 question" is right wherever the key shows a count, without a `count === 1 ? … : …` at every call. A count elsewhere in the sentence has its own form,
    `<key>#one:N` (when {N} is 1: "Removed {1} unanswered question on p. {0}"), and two counts that are both 1 one more, `<key>#one:0,1`; of the forms the
    catalogue has, the one that names the most of the counts that are 1 is used (#1073 round 8). */
const singularsOf = new WeakMap();
/** The templates of a catalogue that have singular forms: template → [{ counts: [N…], key }]. */
function singulars(catalogue) {
  if (!singularsOf.has(catalogue)) {
    const found = new Map();
    for (const key of Object.keys(catalogue)) {
      const match = /^([\s\S]*)#one(?::(\d+(?:,\d+)*))?$/.exec(key);
      if (!match) continue;
      if (!found.has(match[1])) found.set(match[1], []);
      found.get(match[1]).push({ counts: match[2] ? match[2].split(',').map(Number) : [0], key });
    }
    singularsOf.set(catalogue, found);
  }
  return singularsOf.get(catalogue);
}
function englishOf(template, values) {
  // Looked up as ui() looks it up: as written, else with its spaces collapsed and trimmed, the spaces around it kept (the 资料 page's " 共 {0} 份资料。").
  const exact = singulars(english).get(template), clean = exact ? template : template.replace(/\s+/g,' ').trim();
  const forms = exact || singulars(english).get(clean);
  if (!forms || !values?.length) return ui(template);
  let best = null;
  for (const form of forms) if (form.counts.every((index) => Number(values[index]) === 1) && form.counts.length > (best?.counts.length || 0)) best = form;
  if (!best) return ui(template);
  return exact ? english[best.key] : `${template.match(/^\s*/)[0]}${english[best.key]}${template.match(/\s*$/)[0]}`;
}
/** The translated template for these values: in English the singular form that fits the counts among them (above), else ui(template). */
export const uiTemplate = (template, values) => language === 'en' ? englishOf(template, values) : ui(template);
export function uiFormat(template, values) {
  return uiTemplate(template, values).replace(/\{(\d+)\}/g, (match, index) => index < values.length ? String(values[index] ?? '') : match);
}
