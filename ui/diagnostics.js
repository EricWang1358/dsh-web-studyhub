import { plainReason } from '../lib/plain-reason.js';
import { useApp } from './app/app-context.js';

/* The diagnostic text a learner copies into a bug report (#893): the crash page and Settings › 关于与更新 both offer it.

   It is built from a short whitelist and nothing else: StudyHub's version, the interface language, the page id, the error (name, message, the
   first stack lines, each through plainReason and then without prose), the kind and status of the last jobs, the size of the library as counts,
   and whether the experimental features are shown. It never reads a title, a file name, a text, a question or a path; the snapshot is only counted.
   The DSH version is not known here, so one line asks for it. Nothing is stored or sent: the text exists while the button is pressed. */

export const DIAGNOSTIC_LIMITS = Object.freeze({ jobs: 20, stackLines: 12, message: 300, line: 200, version: 40 });

const TOKEN = /^[\w.-]{1,40}$/;
const token = (value, fallback = 'unknown') => (typeof value === 'string' && TOKEN.test(value) ? value : fallback);
const count = value => (Number.isSafeInteger(value) && value >= 0 ? value : 0);

/* An error message is free text: the engine's own ("Cannot read properties of undefined") is short, but code that builds a message from a
   learner's text puts a sentence of it in. What looks like a sentence is replaced: a quoted span of 20 or more characters, 8 or more words in
   a row, 12 or more Chinese characters in a row. The names and the short facts stay, which is what finding the bug needs. */
const QUOTED = /(["`“「『])[^"`”」』\n]{20,}?(["`”」』])/gu;
const WORD_RUN = /(?:[\p{L}\p{N}'’-]+[ \t,;]+){7,}[\p{L}\p{N}'’-]+/gu;
const HAN_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{12,}/gu;
const withoutProse = text => text.replace(QUOTED, '[text]').replace(WORD_RUN, '[text]').replace(HAN_RUN, '[text]');
const plain = (value, limit) => withoutProse(plainReason(typeof value === 'string' ? value : '', { limit }));

function errorLines(error) {
  if (!error) return [];
  const source = typeof error === 'string' ? { message: error } : error;
  const { name, message, stack } = typeof source === 'object' ? source : {};
  const lines = [`Error: ${plain(name, DIAGNOSTIC_LIMITS.line) || 'unknown'}`, `Message: ${plain(message, DIAGNOSTIC_LIMITS.message) || '-'}`];
  // The stack's first line repeats the message; the frames after it say where it broke. A frame keeps its function and loses its path.
  const frames = typeof stack === 'string' ? stack.split('\n').filter(line => /^\s*at\s/.test(line)).slice(0, DIAGNOSTIC_LIMITS.stackLines) : [];
  if (frames.length) lines.push('Stack:', ...frames.map(line => `  ${plain(line.trim(), DIAGNOSTIC_LIMITS.line)}`));
  return lines;
}

const jobLine = job => `${token(job?.type, '?')}/${token(job?.status, '?')}`;

/**
 * The text to copy. `data` is the client snapshot (or nothing): only its counts, the kind and status of its jobs and its experimental switch are read.
 * `error`: an Error (or a string) when a page crashed; left out when the learner copies from Settings.
 */
export function diagnosticText({ version, language, page, error, data } = {}) {
  const jobs = Array.isArray(data?.jobs) ? data.jobs.slice(-DIAGNOSTIC_LIMITS.jobs) : [];
  const decks = Array.isArray(data?.decks) ? data.decks : [];
  return [
    'StudyHub diagnostic info',
    `StudyHub version: ${plainReason(typeof version === 'string' ? version : '', { limit: DIAGNOSTIC_LIMITS.version }) || 'unknown'}`,
    'DSH version: (fill in by hand / 请手动填写)',
    `Interface language: ${language === 'zh' || language === 'en' ? language : 'unknown'}`,
    `Page: ${token(page)}`,
    ...errorLines(error),
    `Library: sources ${Array.isArray(data?.sources) ? data.sources.length : 0}, decks ${decks.length}, questions ${decks.reduce((total, deck) => total + count(deck?.count), 0)}`,
    `Experimental features: ${data?.experimental === true ? 'on' : 'off'}`,
    `Last jobs (kind/status, oldest first): ${jobs.length ? jobs.map(jobLine).join(', ') : 'none'}`,
  ].join('\n');
}

/** `describe(error)` for the page the learner is on: the text of `diagnosticText` with the app's own snapshot, language and page. `version` is StudyHub's (the update store has it). */
export function useDiagnostics(version) {
  const { data, language, nav } = useApp();
  return error => diagnosticText({ version, language, page: nav?.page, error, data });
}
