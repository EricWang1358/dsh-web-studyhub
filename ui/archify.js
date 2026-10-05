import { readJSON, writeJSON, removeKey } from './storage.js';

/* Archify: an open-source (MIT) agent skill that draws a description, a plan or a repository as one self-contained, interactive HTML
   diagram. StudyHub neither bundles nor rebuilds it: it recommends it, hands a skeleton to the learner's agent with one button, and
   keeps and shows the file the agent makes (docs/companions.md). Everything the interface says about it comes from this table, so
   the card, the hand-off prompt and the docs cannot drift apart. */

export const ARCHIFY = Object.freeze({
  name: 'Archify',
  author: 'tt-a1i',
  license: 'MIT',
  repo: 'https://github.com/tt-a1i/archify',
  home: 'https://tt-a1i.github.io/archify/',
  gallery: 'https://tt-a1i.github.io/archify/gallery.html',
  // The DeepSeek Harness plugin of its README; the version is the one this page was written against.
  plugin: '@tt-a1i/archify-dsh@1.0.0',
  skill: 'archify',
});

/** The DSH command that installs it. `profile` is the DSH profile in use: `web` in the browser, usually `desktop` in the desktop app. */
export function installCommand(profile = 'web') {
  const name = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(String(profile)) ? profile : 'web';
  return `dsh plugin --profile ${name} add ${ARCHIFY.plugin}`;
}

/* "以后再说": per viewer and per library, in the browser's storage (a convenience: the page works without it, and a blocked storage
   only means the card shows again). */
const key = (root) => `study-archify-card:${root || 'local'}`;
export const archifyPutOff = (root, storage) => (storage === undefined ? readJSON(key(root)) : readJSON(key(root), null, storage)) === 'later';
export function setArchifyPutOff(root, on, storage) {
  if (on) return storage === undefined ? writeJSON(key(root), 'later') : writeJSON(key(root), 'later', storage);
  return storage === undefined ? removeKey(key(root)) : removeKey(key(root), storage);
}
