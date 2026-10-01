import { useSyncExternalStore } from 'react';
import base from './locales/en.json';
// WP2 fragment (plan C2). WP1's fragment loader supersedes this stopgap merge.
import hostCopy from './locales/en.host.json';
const english = { ...base, ...hostCopy };
import { localizeAppMessage } from '../lib/application-messages.js';
const KEY = 'study-ui-language';
const listeners = new Set();
const browserLanguage = () => {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return 'zh';
  const preferred = navigator.languages?.[0] || navigator.language || 'en';
  return /^zh(?:-|$)/i.test(preferred) ? 'zh' : 'en';
};
let language = browserLanguage();
try { const saved = localStorage.getItem(KEY); if (['en', 'zh'].includes(saved)) language = saved; } catch {}
export const getUiLanguage = () => language;
export const uiLocale = () => language === 'en' ? 'en-US' : 'zh-CN';
export function setUiLanguage(next) {
  if (!['en','zh'].includes(next)) return;
  language = next;
  try { localStorage.setItem(KEY, next); } catch {}
  listeners.forEach(fn => fn());
}
if (typeof window !== 'undefined') window.addEventListener('storage', event => {
  if (event.key === KEY) { language = ['en', 'zh'].includes(event.newValue) ? event.newValue : browserLanguage(); listeners.forEach(fn => fn()); }
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
export function uiFormat(template, values) {
  return ui(template).replace(/\{(\d+)\}/g, (match, index) => index < values.length ? String(values[index] ?? '') : match);
}
