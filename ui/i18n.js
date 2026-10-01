import { useSyncExternalStore } from 'react';
import english from './locales/en.json';
const KEY = 'study-ui-language';
const listeners = new Set();
let language = 'zh';
try { language = localStorage.getItem(KEY) === 'en' ? 'en' : 'zh'; } catch {}
export const getUiLanguage = () => language;
export const uiLocale = () => language === 'en' ? 'en-US' : 'zh-CN';
export function setUiLanguage(next) {
  if (!['en','zh'].includes(next)) return;
  language = next;
  try { localStorage.setItem(KEY, next); } catch {}
  listeners.forEach(fn => fn());
}
if (typeof window !== 'undefined') window.addEventListener('storage', event => {
  if (event.key === KEY) { language = event.newValue === 'en' ? 'en' : 'zh'; listeners.forEach(fn => fn()); }
});
const subscribe = fn => { listeners.add(fn); return () => listeners.delete(fn); };
export function useUiLanguage() { return useSyncExternalStore(subscribe, getUiLanguage, () => 'zh'); }
/** Application-owned copy only. Never pass question, source or user content. */
export function ui(value) {
  if (language !== 'en' || typeof value !== 'string') return value;
  if (Object.hasOwn(english, value)) return english[value];
  const clean = value.replace(/\s+/g,' ').trim();
  return Object.hasOwn(english, clean) ? `${value.match(/^\s*/)[0]}${english[clean]}${value.match(/\s*$/)[0]}` : value;
}
export const uiLabels = labels => new Proxy(labels, { get: (target, key) => ui(target[key]) });
export function uiFormat(template, values) {
  return ui(template).replace(/\{(\d+)\}/g, (match, index) => index < values.length ? String(values[index] ?? '') : match);
}
