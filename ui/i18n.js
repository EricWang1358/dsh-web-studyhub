import { useSyncExternalStore } from 'react';
import base from './locales/en.json';
// One English fragment per work package (plan §4 C2). esbuild cannot glob, so
// a new fragment must be imported and listed here; tests/wp1-i18n-fragments
// fails when a file in ui/locales is missing from ENGLISH_SOURCES.
import components from './locales/en.components.json';
import importCopy from './locales/en.import.json';
import generate from './locales/en.generate.json';
import generationFill from './locales/en.generation-fill.json';
import audio from './locales/en.audio.json';
import audioPipeline from './locales/en.audio-pipeline.json';
import practice from './locales/en.practice.json';
import agent from './locales/en.agent.json';
import host from './locales/en.host.json';
import shell from './locales/en.shell.json';
import onboarding from './locales/en.onboarding.json';
import copy from './locales/en.copy.json';
import caseCopy from './locales/en.case.json';
import course from './locales/en.course.json';
import stats from './locales/en.stats.json';
import flow from './locales/en.flow.json';
import skeletonCopy from './locales/en.skeleton.json';
import snappy from './locales/en.snappy.json';
import board from './locales/en.board.json';
import update from './locales/en.update.json';
import wrongbook from './locales/en.wrongbook.json';
import usage from './locales/en.usage.json';
import renameCopy from './locales/en.rename.json';
import peekCopy from './locales/en.peek.json';
import largedocs from './locales/en.largedocs.json';
import mineruCopy from './locales/en.mineru.json';
import reader from './locales/en.reader.json';
import wave4 from './locales/en.wave4.json';
import wave5a from './locales/en.wave5a.json';
import wave5b from './locales/en.wave5b.json';
import selectionCopy from './locales/en.selection.json';
import original from './locales/en.original.json';
import links from './locales/en.links.json';
import tiers from './locales/en.tiers.json';
import translationCopy from './locales/en.translation.json';
import jevCopy from './locales/en.jev.json';
import loop from './locales/en.loop.json';
import frequency from './locales/en.frequency.json';
import generationSettings from './locales/en.generation-settings.json';
import calculation from './locales/en.calculation.json';
import science from './locales/en.science.json';
import feedback from './locales/en.feedback.json';
import overlays from './locales/en.overlays.json';
import shared from './locales/en.shared.json';
import appShell from './locales/en.app.json';
import materials from './locales/en.materials.json';
import fields from './locales/en.fields.json';
import canvas from './locales/en.canvas.json';
import examCopy from './locales/en.exam.json';
import feedbackLoop from './locales/en.feedback-loop.json';
import pages from './locales/en.pages.json';
import markerInstall from './locales/en.marker-install.json';
import { localizeAppMessage } from '../lib/application-messages.js';
import { failureText } from './failure.js';

export const ENGLISH_SOURCES = {
  'en.json': base,
  'en.components.json': components,
  'en.import.json': importCopy,
  'en.generate.json': generate,
  'en.generation-fill.json': generationFill,
  'en.audio.json': audio,
  'en.audio-pipeline.json': audioPipeline,
  'en.practice.json': practice,
  'en.agent.json': agent,
  'en.host.json': host,
  'en.shell.json': shell,
  'en.onboarding.json': onboarding,
  'en.copy.json': copy,
  'en.case.json': caseCopy,
  'en.course.json': course,
  'en.stats.json': stats,
  'en.flow.json': flow,
  'en.skeleton.json': skeletonCopy,
  'en.snappy.json': snappy,
  'en.board.json': board,
  'en.update.json': update,
  'en.wrongbook.json': wrongbook,
  'en.usage.json': usage,
  'en.rename.json': renameCopy,
  'en.peek.json': peekCopy,
  'en.largedocs.json': largedocs,
  'en.mineru.json': mineruCopy,
  'en.reader.json': reader,
  'en.wave4.json': wave4,
  'en.wave5a.json': wave5a,
  'en.wave5b.json': wave5b,
  'en.selection.json': selectionCopy,
  'en.original.json': original,
  'en.links.json': links,
  'en.tiers.json': tiers,
  'en.translation.json': translationCopy,
  'en.jev.json': jevCopy,
  'en.loop.json': loop,
  'en.frequency.json': frequency,
  'en.generation-settings.json': generationSettings,
  'en.calculation.json': calculation,
  'en.science.json': science,
  'en.feedback.json': feedback,
  'en.overlays.json': overlays,
  'en.shared.json': shared,
  'en.app.json': appShell,
  'en.materials.json': materials,
  'en.fields.json': fields,
  'en.canvas.json': canvas,
  'en.exam.json': examCopy,
  'en.feedback-loop.json': feedbackLoop,
  'en.pages.json': pages,
  'en.marker-install.json': markerInstall,
};

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

const english = mergeCatalogues(ENGLISH_SOURCES).catalogue;
/** The whole zh → en catalogue, read-only. The usage frequency record (ui/usage/names.js) reverses it to key a control by the app's own copy. */
export const uiCatalogue = () => english;
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
/** For logic that has to pick DATA by language (the language a model answers in, which host text to keep). A sentence of the interface is never chosen with it: that is ui(). */
export const uiIsEnglish = () => language === 'en';
const LANGUAGE_NAMES = { en: 'English', zh: '中文' };
export const uiLanguageName = () => LANGUAGE_NAMES[language];
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
/** What a failure says, for the learner: its message (or the value thrown) through uiMessage, so an English page never shows a Chinese host message. */
export const errorMessage = failure => uiMessage(failureText(failure));
export function uiFormat(template, values) {
  return ui(template).replace(/\{(\d+)\}/g, (match, index) => index < values.length ? String(values[index] ?? '') : match);
}
