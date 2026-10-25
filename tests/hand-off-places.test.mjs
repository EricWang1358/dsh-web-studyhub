/* 「发给主会话」 on the places that handed over before the shared unit existed (the hand-off plan, section 5, S2b), read from the source:
   every id a page hands over is in the registry (ui/agent-prompts/index.js), every entry of the registry is handed over by at least one page, no page names
   askInChat or draws its own control for it (the guard rails hold that, and are asserted here too), and the Chinese UI has one name for the main chat.
   The places themselves, drawn and clicked in Chromium, are tests/hand-off-migrate-browser.test.mjs. Pure; no host. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadUi } from './helpers/ui-module.mjs';
import { ALLOW, scanUi, ROOT } from '../scripts/qa/guardrail-baseline.mjs';

const registry = await loadUi(`export { HAND_OFFS } from './ui/agent-prompts/index.js';`);

/** Every .js and .jsx file under ui/ that draws or wires a page (the unit, the registry and the catalogues are not pages). */
function pageFiles(dir = join(ROOT, 'ui'), found = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name), here = relative(join(ROOT, 'ui'), path).replace(/\\/g, '/');
    if (statSync(path).isDirectory()) { if (!['hand-off', 'agent-prompts', 'locales'].includes(here)) pageFiles(path, found); }
    else if (/\.jsx?$/.test(name)) found.push({ file: `ui/${here}`, text: readFileSync(path, 'utf8') });
  }
  return found;
}

/** The ids a page hands over: <HandOff id="x">, <HandOffForm id="x">, send('x' …) and item('x' …) of useHandOff in a file that uses it. */
function handedOver() {
  const used = new Map();
  const add = (id, file) => used.set(id, [...(used.get(id) || []), file]);
  for (const { file, text } of pageFiles()) {
    for (const match of text.matchAll(/<HandOff(?:Form)?\b[^>]*?\bid="([\w.]+)"/gs)) add(match[1], file);
    if (/useHandOff\b/.test(text)) for (const match of text.matchAll(/\b(?:send|item|action)\(\s*["']([\w.]+)["']/g)) add(match[1], file);
  }
  return used;
}

test('every id a page hands over is in the registry, and every entry of the registry is handed over by a page', () => {
  const used = handedOver(), known = Object.keys(registry.HAND_OFFS);
  assert.deepEqual([...used.keys()].filter(id => !known.includes(id)), [], 'an id the registry does not have');
  assert.deepEqual(known.filter(id => !used.has(id)), [], 'an entry no page hands over (delete it, or the page that should use it)');
});

test('each migrated place hands over with its id (before: a prompt builder and askInChat on the page)', () => {
  const used = handedOver(), at = id => (used.get(id) || []).sort();
  assert.deepEqual(at('ingest.start'), ['ui/Generate.jsx']);
  assert.deepEqual(at('deck.ask'), ['ui/study-map/DeckRow.jsx']);
  assert.deepEqual(at('topic.explain'), ['ui/study-map/DeckRow.jsx']);
  assert.deepEqual(at('topics.group'), ['ui/Skeleton.jsx', 'ui/Skeleton.jsx', 'ui/study-map/TopicGroupReminder.jsx']);
  assert.deepEqual(at('skeleton.design').sort(), ['ui/Skeleton.jsx', 'ui/Skeleton.jsx']);
  assert.deepEqual(at('skeleton.archify'), ['ui/Skeleton.jsx']);
  assert.deepEqual(at('skeleton.extend'), ['ui/Skeleton.jsx', 'ui/SkeletonCanvas.jsx']);
  assert.deepEqual(at('review.weakTopics'), ['ui/Review.jsx']);
  assert.deepEqual(at('workflow.design'), ['ui/Workflows.jsx', 'ui/Workflows.jsx']);
  assert.deepEqual(at('workflow.skeleton'), ['ui/Workflows.jsx']);
  assert.deepEqual(at('workflow.step'), ['ui/WorkflowPortal.jsx']);
  assert.deepEqual(at('path.brief'), ['ui/GenerationPath.jsx']);
  // import.file and job.failed: the dead ends of adding files and of jobs (S3), and the empty home's link (plan item 5); tests/hand-off-deadends.test.mjs has them
  assert.deepEqual(at('import.file'), ['ui/AudioImport.jsx', 'ui/AudioImport.jsx', 'ui/AudioImport.jsx', 'ui/AudioImport.jsx', 'ui/ImportHub.jsx', 'ui/ImportHub.jsx', 'ui/Ingest.jsx',
    'ui/JsonImport.jsx', 'ui/JsonImport.jsx', 'ui/JsonImport.jsx', 'ui/LargeDocumentCard.jsx']);
  assert.deepEqual(at('job.failed'), ['ui/PdfConvertJob.jsx', 'ui/tasks/CompactJobCard.jsx', 'ui/tasks/RunLine.jsx']);
  assert.deepEqual(at('book.edit'), ['ui/book/send-to-chat.js']);
  // the page question of the reader's 原始 PDF (#456): a quiet link under the answers, and the way forward on a page without saved text
  assert.deepEqual(at('reader.page'), ['ui/document-preview/PageAsk.jsx', 'ui/document-preview/PageAsk.jsx']);
});

test('no page names askInChat: the empty home\'s link was the last (plan item 5, S3)', () => {
  const named = pageFiles().filter(({ text }) => /\baskInChat\b/.test(text)).map(({ file }) => file).filter(file => file !== 'ui/App.jsx' && file !== 'ui/study-context.jsx' && file !== 'ui/app/use-app-core.js' && file !== 'ui/host/workspace.jsx');
  assert.deepEqual(named, []);
  assert.deepEqual(ALLOW.chatHandOff, []);
  const scan = scanUi();
  assert.deepEqual(scan.metrics.chatHandOff, {});
  assert.deepEqual(scan.metrics.chatOldWording, {});
});

test('the Chinese catalogue has one name for the main chat: no old wording left in a key', () => {
  const old = /主对话|(?<!新)对话中|在对话里|发到对话|让对话|AI ?归并|对话里(?:的 AI|出题)/;
  const left = [];
  for (const name of readdirSync(join(ROOT, 'ui', 'locales')).filter(file => file.endsWith('.json'))) {
    for (const key of Object.keys(JSON.parse(readFileSync(join(ROOT, 'ui', 'locales', name), 'utf8')))) if (old.test(key)) left.push(key);
  }
  assert.deepEqual(left, []);
});

test('the places keep no title attribute and no toast of their own for the hand-off', () => {
  for (const { file, text } of pageFiles()) {
    if (!/<HandOff|useHandOff/.test(text)) continue;
    assert.doesNotMatch(text, /已交给对话|已交给主会话|请求已准备好/, `${file}: the shared notice says what happened`);
    assert.doesNotMatch(text, /className="map-ask"[^>]*title=|title=\{ui\([^)]*(?:对话|主会话)/, `${file}: a hand-off control has a Tooltip, never a title attribute`);
  }
});
