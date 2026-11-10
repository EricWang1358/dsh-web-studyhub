import { plainReason } from '../lib/plain-reason.js';
import { useApp } from './app/app-context.js';
import { PAGE_IDS, pageOf } from './pages.js';
import { PERFORMANCE_LIMITS, sessionPerformance } from './session-performance.js';

/* The diagnostic text a learner copies into a bug report (#893): the crash notice and Settings › 关于与更新 both offer it.

   It is built from a short whitelist and nothing else: StudyHub's version, the interface language, the page id, the error (its name as a plain token,
   its message only when it is one of the engine's own, the function names of the first stack frames), the kind and status of the last jobs, the
   size of the library as counts, whether the experimental features are shown, and a few numbers about this session's speed (ui/session-performance.js:
   page switches, long tasks, snapshots; in memory only, left out when the app passes none). It never reads a title, a file name, a text, a question or a path;
   the snapshot is only counted. The DSH version is not known here, so one line asks for it. Nothing is stored or sent: the text exists while the
   button is pressed, and the learner can read it before copying (CopyDiagnosticsButton).

   An error message is free text: code that builds a message from a learner's data (a deck title, a file name) puts it in. Nothing can tell such a
   message from the engine's by looking for private parts, so the rule is the other way round: a message is copied only when it has the shape of one
   the engine or React writes; any other is replaced by its length. The raw message stays on the crash notice under 技术详情. */

export const DIAGNOSTIC_LIMITS = Object.freeze({ jobs: 20, stackLines: 12, version: 40 });

const TOKEN = /^[\w.-]{1,40}$/;
const token = (value, fallback = 'unknown') => (typeof value === 'string' && TOKEN.test(value) ? value : fallback);
const count = value => (Number.isSafeInteger(value) && value >= 0 ? value : 0);

/* The messages that are copied whole. The subject of "is not ..." is code-shaped: V8 writes "is not defined" for a bare identifier only, and the
   others for a member-access path, whose last part is not a file extension (a file name is the learner's, not the engine's). */
const FILE_EXTENSION = 'pdf|docx?|pptx?|xlsx?|md|txt|csv|json|html?|epub|png|jpe?g|gif|webp|mp3|m4a|wav|mp4|zip';
const ENGINE_WHOLE = [
  /^Cannot (?:read|set) properties of (?:undefined|null) \((?:reading|setting) '[\w$]{1,60}'\)$/,
  /^[A-Za-z_$][\w$]{0,60} is not defined$/,
  new RegExp(`^(?![\\w$.?[\\]]*\\.(?:${FILE_EXTENSION}) is not )[A-Za-z_$][\\w$]*(?:\\??\\.[A-Za-z_$][\\w$]*|\\[\\d{1,6}\\]){0,8} is not (?:a function|iterable|a constructor)$`),
  /^Cannot destructure property '[\w$]{1,60}' of '[\w$.?[\]]{1,120}' as it is (?:undefined|null)\.$/,
];
/* The messages whose start is the whole point (React appends a URL with the arguments, which can hold anything): only the matched part is copied. */
const ENGINE_START = [
  /^Minified React error #\d{1,4}\b/,
  /^(?:Maximum update depth exceeded|Rendered (?:more|fewer) hooks than|Invalid time value|Invalid array length|Failed to fetch dynamically imported module)/,
];

function messageLine(message) {
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text) return '-';
  if (ENGINE_WHOLE.some(pattern => pattern.test(text))) return text;
  for (const pattern of ENGINE_START) { const found = pattern.exec(text); if (found) return found[0]; }
  return `(not copied: ${text.length} characters; see 技术详情)`;
}

/* A frame is its function name and nothing else: a URL, a path and a position say who the learner is. A line is a frame only when it ends in a
   position (:line:column) and its name is an ASCII identifier; any other name is <anonymous>. A line without a position is no frame, so the lines of a
   multi-line message cannot pass for one. */
const CHROME_FRAME = /^\s*at\s+(?:async\s+)?([A-Za-z_$][\w$.]{0,80})\s+\(.*:\d+:\d+\)$/;
const CHROME_ANONYMOUS = /^\s*at\s.*:\d+:\d+\)?$/;
const FIREFOX_FRAME = /^\s*([A-Za-z_$][\w$.]{0,80})?@.*:\d+:\d+$/;
function frameLine(line) {
  const named = CHROME_FRAME.exec(line) ?? FIREFOX_FRAME.exec(line);
  if (named) return `  at ${named[1] ?? '<anonymous>'}`;
  return CHROME_ANONYMOUS.test(line) ? '  at <anonymous>' : null;
}

function errorLines(error) {
  if (!error) return [];
  const source = typeof error === 'string' ? { message: error } : error;
  const { name, message, stack } = typeof source === 'object' ? source : {};
  const lines = [`Error: ${typeof name === 'string' && /^[A-Za-z][\w$]{0,39}$/.test(name) ? name : 'Error'}`, `Message: ${messageLine(message)}`];
  // The stack's first line repeats the message and is dropped; the frames after it say where it broke.
  // The message is taken out of the stack first: in Chrome the stack begins with the whole message, every line of it.
  const frames = typeof stack === 'string' ? (typeof message === 'string' && message ? stack.replace(message, '') : stack).split('\n').map(frameLine).filter(Boolean).slice(0, DIAGNOSTIC_LIMITS.stackLines) : [];
  if (frames.length) lines.push('Stack:', ...frames);
  return lines;
}

const jobLine = job => `${token(job?.type, '?')}/${token(job?.status, '?')}`;

/* The performance section (#893 S4). `session` is the summary of ui/session-performance.js, but whatever it holds is read as untrusted: a number is a
   whole number or 0, a page is printed only when it is one of the app's own page ids. With a Chinese interface each label carries its Chinese words after
   the English ones (the developer reads both); with an English interface the text stays pure English, as the rest of it is. */
const NONE_YET = 'none yet';
const pair = stat => `${count(stat?.median)}/${count(stat?.worst)}`;
function performanceLines(session, chinese) {
  const zh = words => (chinese ? ` ${words}` : '');
  const switches = (Array.isArray(session.switches?.byPage) ? session.switches.byPage : []).filter(entry => pageOf(entry?.page)).slice(0, PAGE_IDS.length);
  const tasks = session.longTasks, { chars, applyMs } = session.snapshots ?? {};
  return [
    `Session performance${zh('本次会话性能')} (in memory only, this session${zh('仅存内存、只含本次')})`,
    `Page switches${zh('页面切换')} (ms, median/worst): ${switches.length ? switches.map(entry => `${entry.page} ${count(entry.count)}x ${pair(entry)}`).join(', ') : NONE_YET}`,
    `Long tasks${zh('长任务')} (over ${PERFORMANCE_LIMITS.longTaskMs} ms): ${tasks && typeof tasks === 'object' ? `${count(tasks.count)}, total ${count(tasks.totalMs)} ms, worst ${count(tasks.worstMs)} ms` : `not reported by this webview${zh('此环境不提供')}`}`,
    `Snapshots${zh('快照')} (changed ones): ${count(chars?.count) ? `${count(chars.count)}, size ${pair(chars)} chars, apply ${pair(applyMs)} ms` : NONE_YET}`,
  ];
}

/**
 * The text to copy. `data` is the client snapshot (or nothing): only its counts, the kind and status of its jobs and its experimental switch are read.
 * `error`: an Error (or a string) when a page crashed; left out when the learner copies from Settings.
 * `session`: the summary of this session's performance (ui/session-performance.js); no section when it is left out.
 */
export function diagnosticText({ version, language, page, error, data, session } = {}) {
  const jobs = Array.isArray(data?.jobs) ? data.jobs.slice(-DIAGNOSTIC_LIMITS.jobs) : [];
  const decks = Array.isArray(data?.decks) ? data.decks : [];
  return [
    'StudyHub diagnostic info',
    `StudyHub version: ${plainReason(typeof version === 'string' ? version : '', { limit: DIAGNOSTIC_LIMITS.version }) || 'unknown'}`,
    'DSH version: (fill in by hand)',
    `Interface language: ${token(language)}`,
    `Page: ${token(page)}`,
    ...errorLines(error),
    `Library: sources ${Array.isArray(data?.sources) ? data.sources.length : 0}, decks ${decks.length}, questions ${decks.reduce((total, deck) => total + count(deck?.count), 0)}`,
    `Experimental features: ${data?.experimental === true ? 'on' : 'off'}`,
    `Last jobs (kind/status, oldest first): ${jobs.length ? jobs.map(jobLine).join(', ') : 'none'}`,
    ...(session && typeof session === 'object' ? performanceLines(session, token(language) === 'zh') : []),
  ].join('\n');
}

/**
 * `describe(error)` for the page the learner is on: the text of `diagnosticText` with the app's own snapshot, language and page.
 * `getVersion()` is StudyHub's version, read when the text is built (not on every render of the page).
 */
export function useDiagnostics(getVersion) {
  const { data, language, nav } = useApp();
  return error => diagnosticText({ version: getVersion?.(), language, page: nav?.page, error, data, session: sessionPerformance.summary() });
}
