import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// UI wave 5B: the architecture clean-ups (#113 #115 #116 #123 #125 #126 #128 #117) pinned as source scans, so a regression names the file.
// The per-file counts that may only fall (call/busy hand-offs and the like) live in tests/fixtures/ui-guardrail-baseline.json.
const root = new URL('../', import.meta.url);
const read = file => readFileSync(new URL(file, root), 'utf8');
/** The code of a source file: comments blanked, so a sentence that mentions localStorage is not a use of it. */
const code = text => text.replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' ')).replace(/(^|[^:\\'"`])\/\/[^\n]*/g, (match, lead) => lead);

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
