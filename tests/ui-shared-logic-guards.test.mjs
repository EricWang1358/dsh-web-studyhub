import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// UI wave 1, WP-D: the call sites that moved onto the shared logic layer stay on it. Each list is the files of THIS work package;
// the remaining call sites belong to other branches and are tracked by the ui-consistency issues.
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('migrated pollers use usePolling, not their own timers (#125)', async () => {
  for (const file of ['ui/WorkflowPortal.jsx', 'ui/CoachDebrief.jsx', 'ui/use-index-coverage.js', 'ui/host/workspace.jsx', 'ui/LiveClass.jsx', 'ui/LiveAudioMonitor.jsx', 'ui/AudioDashboard.jsx']) {
    const source = await read(file);
    assert.doesNotMatch(source, /setInterval\(/, file);
    assert.match(source, /usePolling|createPoller/, file);
  }
});

test('the only timers of the polling layer are in use-polling.js, and it never uses setInterval', async () => {
  const source = await read('ui/use-polling.js');
  assert.doesNotMatch(source, /setInterval\(/, 'a chained timeout, so calls never overlap');
  assert.match(source, /setTimeout/);
});

test('migrated files take no localStorage of their own (#115)', async () => {
  for (const file of ['ui/WorkflowPortal.jsx', 'ui/JevSettings.jsx', 'ui/AudioSettings.jsx', 'ui/ExtensionsSettings.jsx', 'ui/workflow-draft.js'])
    assert.doesNotMatch(await read(file), /localStorage|sessionStorage/, file);
});

test('migrated files format dates, clocks and sizes through ui/format.js (#126)', async () => {
  for (const file of ['ui/WorkflowPortal.jsx', 'ui/LiveClass.jsx', 'ui/LiveHistory.jsx', 'ui/LiveAudioMonitor.jsx', 'ui/AudioDashboard.jsx', 'ui/document-preview/OriginalFile.jsx', 'ui/document-preview/original-file.js', 'ui/mineru-flow.js', 'ui/components/FileDrop.jsx']) {
    const source = await read(file);
    assert.doesNotMatch(source, /padStart\(2|toLocale(Date|Time)?String\(|new Intl\.(NumberFormat|DateTimeFormat)/, file);
    assert.doesNotMatch(source, /new FileReader\(/, `${file}: base64 lives in ui/upload.js`);
  }
});

test('the browser-importable registries are what the host reads too (#119 #120 #121 #128)', async () => {
  assert.match(await read('lib/audio-settings.js'), /from "\.\/audio-providers\.js"/);
  assert.match(await read('lib/audio-file.js'), /from "\.\/audio-formats\.js"/);
  assert.match(await read('lib/subtitles.js'), /from "\.\/audio-formats\.js"/);
  for (const file of ['lib/workflows.js', 'lib/study-state.js', 'lib/contexts/study/operations.js']) assert.match(await read(file), /limits\.js/, file);
  for (const file of ['ui/AudioSettings.jsx', 'ui/AudioDashboard.jsx', 'ui/LiveClass.jsx']) assert.match(await read(file), /audio-providers\.js/, file);
  assert.doesNotMatch(await read('ui/AudioSettings.jsx') + await read('ui/AudioDashboard.jsx'), /'siliconflowKey'|"siliconflowKey"/);
  assert.doesNotMatch(await read('ui/AudioSettings.jsx') + await read('ui/AudioDashboard.jsx') + await read('ui/LiveClass.jsx'), /aistudio\.google\.com|console\.groq\.com|cloud\.siliconflow\.cn/);
});
