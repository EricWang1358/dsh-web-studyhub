import { useState } from 'react';
import { browserStorage, readJSON, writeJSON } from '../../storage.js';

/*
 * The learner's own presets for 按页提问 in 原始 PDF (issue #485): a name and the prompt it sends, on top of the four built-in presets of
 * QuickIntents.jsx (PAGE_INTENTS). The built-ins keep their exact wording and can only be hidden; the learner's own can be added, edited,
 * hidden and deleted. Kept in this browser only, the way the reader remembers a closed hint (reader/hints.js; storage.js readJSON /
 * writeJSON): a browser without storage keeps them for this visit, so a preset added there still works until the page is closed.
 * Pure helpers plus one hook.
 */
const PRESETS_KEY = 'study-reader-page-presets';

/** The four built-ins by their `intent` (QuickIntents.jsx PAGE_INTENTS): hiding one is remembered by that id, never by a copy of its text. */
export const BUILTIN_PRESETS = Object.freeze(['explain', 'translate', 'points', 'extract']);

/** A name fits a chip; a prompt is one question. */
export const PRESET_NAME_MAX = 24;
export const PRESET_PROMPT_MAX = 300;

/** The presets as kept: the hidden ones by id, and the learner's own in the order they were added. */
export const emptyPagePresets = () => ({ hidden: [], custom: [] });

const trimmed = value => (typeof value === 'string' ? value.trim() : '');
const newId = () => {
  try { return `preset-${globalThis.crypto.randomUUID()}`; } catch { /* an older browser, or no secure context */ }
  return `preset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
};

/** One stored preset of the learner's own, or null when it cannot be shown (an older shape, a hand-edited value). */
const customOf = (value, at) => {
  const name = trimmed(value?.name), prompt = trimmed(value?.prompt);
  if (!name || !prompt) return null;
  return { id: trimmed(value?.id) || `preset-${at}`, name, prompt };
};

/** What is stored, made safe: unknown keys ignored, presets without a name or a prompt dropped, a hidden id listed once. */
export function normalisePagePresets(value) {
  const stored = value && typeof value === 'object' ? value : {};
  const hidden = Array.isArray(stored.hidden) ? [...new Set(stored.hidden.filter(id => typeof id === 'string' && id))] : [];
  const custom = Array.isArray(stored.custom) ? stored.custom.map((item, at) => customOf(item, at)).filter(Boolean) : [];
  return { hidden, custom };
}

/** Presets changed during this visit: kept even when the browser cannot store them, so a panel closed and opened again finds them. */
let visit = null;

/** The presets of this browser (or of this visit, when it cannot store them). */
export function readPagePresets(storage = browserStorage()) {
  return visit || normalisePagePresets(readJSON(PRESETS_KEY, null, storage));
}

/** Keep `value` as the presets: always for this visit, in the browser too when it accepts it. Answers what is now shown. */
export function savePagePresets(value, storage = browserStorage()) {
  visit = normalisePagePresets(value);
  writeJSON(PRESETS_KEY, visit, storage);
  return visit;
}

/** Start a new visit (tests call it between renders): what this visit kept is forgotten, the stored presets stay. */
export const forgetPagePresets = () => { visit = null; };

/** Is the preset `id` shown? (A built-in by its intent, one of the learner's own by its id.) */
export const presetShown = (presets, id) => !presets.hidden.includes(id);

/** Show or hide the preset `id`; a built-in's wording is never touched, only whether it appears. */
export const setPresetShown = (presets, id, shown) => ({
  ...presets,
  hidden: shown ? presets.hidden.filter(item => item !== id) : [...new Set([...presets.hidden, id])],
});

/** Add a preset of the learner's own; `id` is for tests, a new one is made otherwise. */
export const addCustomPreset = (presets, { id = newId(), name, prompt }) => ({
  ...presets, custom: [...presets.custom, { id, name: trimmed(name), prompt: trimmed(prompt) }],
});

/** Change the name and the prompt of the preset `id`; nothing else about it changes. */
export const updateCustomPreset = (presets, id, { name, prompt }) => ({
  ...presets, custom: presets.custom.map(item => (item.id === id ? { ...item, name: trimmed(name), prompt: trimmed(prompt) } : item)),
});

/** Delete the preset `id` (and any hiding remembered for it). */
export const removeCustomPreset = (presets, id) => ({
  ...presets, hidden: presets.hidden.filter(item => item !== id), custom: presets.custom.filter(item => item.id !== id),
});

/**
 * What is wrong with a preset about to be saved, as codes for the dialog to say: name-required, name-long, name-duplicate,
 * prompt-required, prompt-long. `others` are the presets it is compared with (the learner's own: a built-in's name is a catalogue key,
 * not a preset of theirs) and `ignoreId` the one being edited, which is not its own duplicate. A name matches another whatever its
 * case and spacing.
 */
export function validatePreset({ name, prompt } = {}, others = [], ignoreId = '') {
  const found = {}, presetName = trimmed(name), presetPrompt = trimmed(prompt);
  if (!presetName) found.name = 'name-required';
  else if (presetName.length > PRESET_NAME_MAX) found.name = 'name-long';
  else {
    const same = others.find(item => item.id !== ignoreId && trimmed(item.name).toLowerCase() === presetName.toLowerCase());
    if (same) { found.name = 'name-duplicate'; found.duplicate = same.name; }
  }
  if (!presetPrompt) found.prompt = 'prompt-required';
  else if (presetPrompt.length > PRESET_PROMPT_MAX) found.prompt = 'prompt-long';
  return found;
}

/**
 * The chips the panel shows, in order: the built-ins not hidden, then the learner's own not hidden. A chip of one's own carries
 * `own`: its label and prompt are sent exactly as written, never through the translation catalogue (see QuickIntents.jsx).
 */
export const visiblePagePresets = (presets, builtins) => [
  ...builtins.filter(chip => presetShown(presets, chip.intent)),
  ...presets.custom.filter(item => presetShown(presets, item.id))
    .map(item => ({ key: item.id, label: item.name, question: item.prompt, own: true })),
];

/** [presets, update] of this browser: read once, kept whenever they change. */
export function usePagePresets() {
  const [value, setValue] = useState(() => readPagePresets());
  return [value, next => setValue(savePagePresets(next))];
}
