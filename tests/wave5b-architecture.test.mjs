import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// UI wave 5B: the architecture clean-ups (#113 #115 #116 #123 #125 #126 #128 #117) pinned as source scans, so a regression names the file.
// The per-file counts that may only fall (call/busy hand-offs and the like) live in tests/fixtures/ui-guardrail-baseline.json.
const root = new URL('../', import.meta.url);
const read = file => readFileSync(new URL(file, root), 'utf8');
const walk = (dir, extensions) => readdirSync(new URL(`${dir}/`, root), { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(`${dir}/${entry.name}`, extensions) : extensions.some(ext => entry.name.endsWith(ext)) ? [`${dir}/${entry.name}`] : []);
/** The code of a source file: comments blanked, so a sentence that mentions localStorage is not a use of it. */
const code = text => text.replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' ')).replace(/(^|[^:\\'"`])\/\/[^\n]*/g, (match, lead) => lead);
const uiSources = () => walk('ui', ['.js', '.jsx']).map(file => ({ file, text: code(read(file)) }));

/* ---------- #113: the services come from useStudy() ---------- */

// component -> the services it no longer takes as props and reads from the context instead
const FROM_CONTEXT = [
  ['ui/TokenUsage.jsx', 'TokenEstimate', ['call']],
  ['ui/Sources.jsx', 'RowMenuItems', ['call']], ['ui/Sources.jsx', 'DocumentRow', ['busy', 'call']],
  ['ui/Sources.jsx', 'CourseDialog', ['busy', 'act']], ['ui/Sources.jsx', 'RemoveDialog', ['busy', 'act']],
  ['ui/document-preview/OriginalFile.jsx', 'OriginalMenuEntry', ['call', 'busy']],
  ['ui/document-preview/reader/OutlineDialog.jsx', 'OutlineDialog', ['call', 'act']],
  ['ui/JsonImport.jsx', 'JsonImport', ['busy', 'act', 'call']], ['ui/RetrievalPanel.jsx', 'RetrievalPanel', ['call']],
  ['ui/GenerationPath.jsx', 'GenerationPath', ['call', 'askInChat']],
  ['ui/CaseWorkspace.jsx', 'RubricAnswer', ['busy', 'call']], ['ui/ExplanationFollowup.jsx', 'ExplanationFollowup', ['call']],
  ['ui/SetupChecklist.jsx', 'SetupChecklist', ['call', 'busy']], ['ui/study-map/HomeActivity.jsx', 'HomeActivity', ['busy', 'call']],
];

test('the components that ask the host read call / act / busy / askInChat from useStudy(), not from props (#113)', () => {
  for (const [file, name, services] of FROM_CONTEXT) {
    const source = read(file);
    const header = new RegExp(`function ${name}\\(\\{([^)]*?)\\}\\)\\s*\\{`).exec(source)?.[1];
    assert.notEqual(header, undefined, `${file}: no function ${name}({ ... })`);
    for (const service of services) {
      assert.doesNotMatch(header, new RegExp(`(^|[\\s,])${service}\\s*(=|,|$)`), `${file}: ${name} still takes ${service} as a prop`);
      assert.match(source, new RegExp(`const \\{[^}]*\\b${service}\\b[^}]*\\} = useStudy\\(\\)`), `${file}: ${service} is not read from useStudy()`);
    }
  }
});

test('the pages stop handing those services to them (#113)', () => {
  const noHandoff = (file, tags, props = 'call|act|busy|askInChat') => {
    const text = code(read(file)).replace(/\s+/g, ' ');
    for (const tag of tags) assert.doesNotMatch(text, new RegExp(`<${tag}\\b[^<>]*?\\b(?:${props})=\\{`), `${file}: <${tag}> still gets a service as a prop`);
  };
  noHandoff('ui/Sources.jsx', ['CourseDialog', 'RemoveDialog', 'OutlineDialog', 'RowMenuItems', 'DocumentRow'], 'call|act|askInChat');
  noHandoff('ui/Generate.jsx', ['JsonImport', 'RetrievalPanel', 'GenerationPath', 'TokenEstimate']);
  noHandoff('ui/Review.jsx', ['RubricAnswer', 'ExplanationFollowup']);
  noHandoff('ui/StudyMap.jsx', ['HomeActivity', 'SetupChecklist']);
});

test('StudyMap takes the snapshot and a few app verbs, not the services (#113)', () => {
  const header = /export default function StudyMap\(\{([^)]*?)\}\)/.exec(read('ui/StudyMap.jsx'))[1];
  assert.ok(header.split(',').length <= 20, header);
  assert.doesNotMatch(header, /\b(call|act|busy|askInChat|host)\b/);
});

test('Settings is not handed JSX to lay out (#113)', () => {
  assert.doesNotMatch(code(read('ui/Settings.jsx')), /\b(workspacePanel|coursePanel|onboardingPanel)\b/);
  assert.doesNotMatch(code(read('ui/app/page-views.jsx')), /\b(workspacePanel|coursePanel|onboardingPanel)\b/);
});

/* ---------- #123: words go through ui() and the locale files, not through a language test ---------- */

test('no code outside ui/i18n.js asks which language the interface is in to choose a sentence (#123)', () => {
  const asks = /getUiLanguage\(\)\s*[!=]==?\s*['"](?:en|zh)['"]|\b(?:language|lang)\s*[!=]==?\s*['"](?:en|zh)['"]\s*\?/;
  // Whole documents that exist in two languages by design (an agent prompt, a language switch labelling its own two states), not interface text.
  const own = new Set(['ui/LanguageSwitch.jsx', 'ui/topic-group-prompt.js', 'ui/json-prompts.js']);
  assert.deepEqual(uiSources().filter(({ file, text }) => file !== 'ui/i18n.js' && !own.has(file) && asks.test(text)).map(({ file }) => file), []);
});

test('no inline (zh, en) helper and no { zh, en } pair of sentences: the Chinese is the key, the English is in a locale file (#123)', () => {
  const pair = /\bzh\s*:\s*['"`][^'"`]*['"`]\s*,\s*en\s*:\s*['"`]/;
  const helper = /const\s+\w+\s*=\s*\(\s*zh\b/;
  // The language switch names its own two states; generation-path-flow.js writes the agent brief in either language (pure, tested without the catalogue).
  const own = new Set(['ui/LanguageSwitch.jsx', 'ui/generation-path-flow.js']);
  assert.deepEqual(uiSources().filter(({ file, text }) => !own.has(file) && (pair.test(text) || helper.test(text))).map(({ file }) => file), []);
});

/* ---------- #117: what the host reports is read through useHostQuery ---------- */

test('audio.settings.get and coach.status are read through the host-query store, and a write refreshes every reader (#117)', () => {
  const direct = /\bcall\??\.?\(\s*['"](?:audio\.settings\.get|coach\.status|retrieval\.status)['"]/;
  assert.deepEqual(uiSources().filter(({ text }) => direct.test(text)).map(({ file }) => file), []);
  for (const file of ['ui/AudioSettings.jsx', 'ui/AudioDashboard.jsx', 'ui/Settings.jsx']) assert.match(code(read(file)), /useHostQuery\(\s*['"]audio\.settings\.get['"]/, `${file} reads the audio settings through useHostQuery`);
  for (const file of ['ui/CoachDebrief.jsx', 'ui/WrongBook.jsx']) assert.match(code(read(file)), /useHostQuery\(\s*['"]coach\.status['"]/, `${file} reads the coach status through useHostQuery`);
  for (const file of ['ui/AudioSettings.jsx', 'ui/AudioDashboard.jsx']) assert.match(code(read(file)), /setQueryData\(\s*['"]audio\.settings\.get['"]/, `${file}: a saved audio setting reaches every reader`);
});

/* ---------- #128: job statuses and types come from lib/job-status.js ---------- */

test("the status 'cancelling' and the job types are written only in lib/job-status.js (#128)", () => {
  const status = /['"]cancelling['"]/;
  const type = /\btype\s*[!=]==?\s*['"](?:audio-import|pdf-convert|translation|supplement|draft-repair|draft-publish)['"]/;
  assert.deepEqual(uiSources().filter(({ text }) => status.test(text)).map(({ file }) => file), []);
  assert.deepEqual(uiSources().filter(({ text }) => type.test(text)).map(({ file }) => file), []);
});

/* ---------- #126: dates, clocks, sizes and numbers are written by ui/format.js ---------- */

test('padStart(2 (a clock or a two-digit number) is written only in ui/format.js and its clock (#126)', () => {
  const offenders = uiSources().filter(({ file, text }) => !['ui/format.js', 'ui/clock.js'].includes(file) && /\.padStart\(\s*2\b/.test(text)).map(({ file }) => file);
  assert.deepEqual(offenders, []);
});

test('no page formats a date, a number or a size itself: toLocale*String and Intl formatters live in ui/format.js (#126)', () => {
  // Identifiers and names, not text for the learner to read: a file name, a daily-recap key and time-zone name.
  const identifiers = new Set(['ui/format.js', 'ui/settings/backup-name.js', 'ui/BlogNotes.jsx', 'ui/useDailyRecap.js', 'ui/DailyRecapSettings.jsx']);
  const offenders = uiSources().filter(({ file, text }) => !identifiers.has(file) && /\.toLocale(?:Date|Time)?String\(|\bIntl\.(?:NumberFormat|DateTimeFormat)\b/.test(text)).map(({ file }) => file);
  assert.deepEqual(offenders, []);
});

test('there is one file-size formatter: nothing else walks B / KB / MB / GB (#126)', () => {
  const offenders = uiSources().filter(({ file, text }) => file !== 'ui/format.js' && /['"]KB['"]/.test(text)).map(({ file }) => file);
  assert.deepEqual(offenders, []);
});

/* ---------- #125: every repeating timer is usePolling or useNow ---------- */

test('setInterval( appears only in the clock hook: every other timer is usePolling (paused while the page is hidden) or useNow (#125)', () => {
  const offenders = uiSources().filter(({ file, text }) => file !== 'ui/components/use-now.js' && /\bsetInterval\s*\(/.test(text)).map(({ file }) => file);
  assert.deepEqual(offenders, []);
});

/* ---------- #107: a meta line is a list of parts, not a sentence with a dot in its key ---------- */

test('no uiFormat template starts with a separator dot: the parts are joined by joinMeta (#107)', () => {
  const offenders = uiSources().filter(({ text }) => /\buiFormat\(\s*(?:[^'"`(),]*\?\s*)?['"`]\s+·/.test(text)).map(({ file }) => file);
  assert.deepEqual(offenders, []);
});

/* ---------- #116: unmount guards and failure text come from ui/use-async.js ---------- */

test('"let live = true" unmount flags are few: effects use useLiveEffect (#116)', () => {
  const flags = uiSources().flatMap(({ file, text }) => [...text.matchAll(/\blet\s+(?:live|alive)\s*=\s*true\b/g)].map(() => file));
  assert.ok(flags.length <= 10, `${flags.length} hand-written flags: ${[...new Set(flags)].join(', ')}`);
});

test('a failure is turned into text by errorMessage (uiMessage), not by message || String(failure) (#116)', () => {
  const offenders = uiSources().filter(({ text }) => /\bmessage\s*\|\|\s*String\(/.test(text)).map(({ file }) => file);
  assert.deepEqual(offenders, []);
});

/* ---------- #115: the browser's storage is touched in one place ---------- */

test('localStorage and sessionStorage appear only in ui/storage.js and ui/i18n.js (#115)', () => {
  const offenders = uiSources().filter(({ file, text }) => !['ui/storage.js', 'ui/i18n.js'].includes(file) && /\b(?:localStorage|sessionStorage)\b/.test(text)).map(({ file }) => file);
  assert.deepEqual(offenders, []);
});
