import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const voiceCompiled = await build({
  stdin: {
    contents: `
      export { voiceReadiness, forgetVoiceReadiness } from './ui/voice/useVoiceInput.js';
      export { setQueryData, resetHostQueries } from './ui/host-query-store.js';
    `,
    resolveDir: ROOT,
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  external: ['react'],
  loader: { '.css': 'text' },
});
const voiceMod = { exports: {} };
new Function('require', 'module', 'exports', voiceCompiled.outputFiles[0].text)(
  createRequire(import.meta.url),
  voiceMod,
  voiceMod.exports,
);
const { voiceReadiness, forgetVoiceReadiness, setQueryData, resetHostQueries } = voiceMod.exports;

test('W3-01: CaseWorkspace onJumpFirstBlank switches narrow view to questions before scrolling', () => {
  const src = read('ui/CaseWorkspace.jsx');
  assert.match(src, /setConfirming\(false\);\s*if \(!firstId\) return;\s*setView\("questions"\);\s*setActiveId\(firstId\);/);
});

test('W3-02: Sources import landing relaxes blocking archive/filter/search states and reopens folded groups', () => {
  const src = read('ui/Sources.jsx');
  assert.match(src, /if \(showArchived && landed\.some\(item => !item\.archived\)\) setShowArchived\(false\);/);
  assert.match(src, /if \(reviewOnly && landed\.some\(item => !reviewUrgencyOf/);
  assert.match(src, /if \(query\.trim\(\) && landed\.some\(item => !filterItems\(\[item\], query, searchMatch\)\.length\)\) setQuery\(''\);/);
  assert.match(src, /if \(typeScope !== ALL_FACET && landed\.some/);
  assert.match(src, /if \(categoryScope !== ALL_FACET && landed\.some/);
  assert.match(src, /const reopenedFor = useRef\(0\);/);
});

test('W3-03: Generate sticky bar hides optimistic summary/estimate and shows explicit warning on invalidQuota or referenceState.reason', () => {
  const src = read('ui/Generate.jsx');
  assert.match(src, /const formBlocked = blocked \|\| \(!pathMode && invalidQuota\) \|\| Boolean\(referenceState\.reason\);/);
  assert.match(src, /const estimating = !pathMode && !formBlocked && validSelectedSources\.length > 0;/);
  assert.match(src, /请到「更多选项 › 额外要求」为至少一种题型分配 1 道题。/);
  assert.match(src, /model\.ready && !blocked && referenceState\.reason/);
});

test('W3-04: useVoiceInput resets cached readiness on audio.settings.get update and rechecks when not ready', async () => {
  resetHostQueries();
  forgetVoiceReadiness();
  let ready = false;
  let calls = 0;
  const call = async (action) => {
    if (action === 'audio.settings.get') return { paidOnlyByDefault: false };
    if (action === 'audio.preflight') {
      calls += 1;
      return { transcription: ready, reason: ready ? '' : 'no-provider' };
    }
    return {};
  };

  const first = await voiceReadiness(call);
  assert.equal(first.ready, false);
  assert.equal(calls, 1);

  ready = true;
  setQueryData('audio.settings.get', {}, { paidOnlyByDefault: false });
  const afterSettings = await voiceReadiness(call);
  assert.equal(afterSettings.ready, true, 'audio.settings.get change invalidates cached voice readiness');
  assert.equal(calls, 2);

  const src = read('ui/voice/useVoiceInput.js');
  assert.match(src, /if \(!status\.ready && !status\.unavailable\) status = await voiceReadiness\(call, true\);/);
  forgetVoiceReadiness();
  resetHostQueries();
});

test('W3-05: liveLocalOf auto-selects newly installed model via spec.after only when current selected model is not installed', () => {
  const installSrc = read('lib/live-local-install.js');
  assert.match(installSrc, /typeof seams\.after === 'function' \? \{ \.\.\.base, after: seams\.after \} : base/);

  const runsSrc = read('lib/contexts/audio/install/live-local-runs.js');
  assert.match(runsSrc, /after: async \(\) => \{\s*const currentSelected = await selectedModel\(\);\s*if \(currentSelected !== modelId && !\(await engine\(currentSelected\)\)\) \{\s*await saveAudioSettings\(\{ liveLocalModel: modelId \}\);/);
});

test('W3-06: ControlRow and AudioFiles use reactive useStudyBusy, rethrow errors, and guard busy-dropped undefined replies', () => {
  const ctrlSrc = read('ui/tasks/ControlRow.jsx');
  assert.match(ctrlSrc, /useStudyBusy\(\)/);
  assert.match(ctrlSrc, /core\.act\(defaults\.action, defaults\.args, undefined, \{ rethrow: true \}\)/);
  assert.match(ctrlSrc, /if \(reply === undefined\)/);
  assert.match(ctrlSrc, /lock=\{appBusy\}/);

  const audioSrc = read('ui/tasks/AudioFiles.jsx');
  assert.match(audioSrc, /useStudyBusy\(\)/);
  assert.match(audioSrc, /core\.act\('audio\.retry', \{ jobId: contract\.attemptId \|\| contract\.jobId, skip: \[file\.index\] \}, undefined, \{ rethrow: true \}\)/);
  assert.match(audioSrc, /if \(reply === undefined\)/);
  assert.match(audioSrc, /lock=\{appBusy\}/);
});

test('W3-07: GuidedStudy supports pause->resume end-to-end, unwraps session intent, locks card buttons, and maps course name', () => {
  const opsSrc = read('lib/contexts/study/operations.js');
  assert.match(opsSrc, /"study\.session\.resume": \(s, a\) => \{\s*const result = resumeStudySession\(s, a\);\s*if \(result\?\.found && result\.session && result\.session\.status === "paused"\) \{\s*result\.session\.status = "active";/);

  const idxSrc = read('lib/index.js');
  assert.match(idxSrc, /const sessionObj = value\?\.session \|\| value;/);

  const wbSrc = read('ui/guided-study/GuidedStudyWorkbench.jsx');
  assert.match(wbSrc, /session\?\.status === 'paused'/);
  assert.match(wbSrc, /onTogglePause = onResume/);
  assert.match(wbSrc, /onTogglePause\?\.\(session\.id\)/);
  assert.match(wbSrc, /busy \|\| event\.repeat/);
  assert.match(wbSrc, /courses\.find\(\(c\) => c\?\.id === session\?\.courseId \|\| c\?\.name === session\?\.courseId\)\?\.name/);

  const pvSrc = read('ui/app/page-views.jsx');
  assert.match(pvSrc, /const handleResume = \(id\) => core\.act\('study\.session\.resume'/);
  assert.match(pvSrc, /onResume=\{handleResume\}/);
});
