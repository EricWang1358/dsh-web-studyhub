import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RollingCorrection } from '../lib/live-correction.js';

const compiled = await build({
  stdin: { contents: `export { Sentence, SentenceMark } from './ui/LiveClass.jsx'; export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], loader: { '.json': 'json', '.css': 'text' },
});
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { Sentence, SentenceMark, setUiLanguage } = module.exports;

const plain = { id: 1, t: 1000, en: 'Checked but fine.', zh: '检查过，没问题。', zhState: 'done' };
const polished = { id: 3, t: 6000, en: 'Split it into partitions by date.', zh: '按日期切分成分区。', zhState: 'done',
  originalEn: 'Split it into a patient by date.', correctedAt: '2026-09-29T05:00:00.000Z', correctionReason: 'patient 应为 partition' };
const row = (segment, checked, extra = {}) => renderToStaticMarkup(React.createElement(Sentence, { segment, selected: false, generated: false, checked, onToggle() {}, language: 'zh', ...extra }));

test('an AI-polished sentence gets a solid green dot at the far right, with the reason on hover', () => {
  const html = row(polished, false);
  assert.match(html, /data-mark="polished"/);
  assert.match(html, /class="live-dot polished"/);
  assert.match(html, /title="已由 AI 润色（上下文校正） · patient 应为 partition"/);
  assert.ok(html.indexOf('live-marks') > html.indexOf('live-words'), 'the marker column comes after the words: far right');
  assert.match(html, /查看识别原稿/);
  assert.match(html, /Split it into a patient by date\./, 'the original recognition stays available');
});

test('a sentence the polish pass checked and left alone gets a ring; one it has not reached gets nothing', () => {
  assert.match(row(plain, true), /data-mark="checked"/);
  assert.doesNotMatch(row(plain, true), /data-mark="polished"/);
  assert.doesNotMatch(row(plain, false), /data-mark/);
  assert.equal(renderToStaticMarkup(React.createElement(SentenceMark, { segment: plain, checked: false })), '<span class="live-marks" aria-hidden="true"></span>');
  assert.doesNotMatch(row({ ...polished, correctedAt: undefined }, false), /data-mark|live-correction-original/);
});

test('the marker labels follow the interface language', () => {
  try {
    setUiLanguage('en');
    assert.match(row(polished, false), /title="Polished by AI \(context correction\) · patient 应为 partition"/);
    assert.match(row(plain, true), /title="Checked, no change needed"/);
    assert.match(row(polished, false), /View original recognition/);
  } finally { setUiLanguage('zh'); }
});

test('the correction snapshot says how far the check has got, so the panel can mark checked sentences', async () => {
  const segments = Array.from({ length: 12 }, (_, index) => ({ id: index + 1, t: index * 1000, en: `Sentence ${index + 1}.`, zh: '句子。', zhState: 'done' }));
  const session = { segments, rev: 0, now: () => Date.now(), scheduleSave() {}, saveNow: async () => {} };
  const correct = async (items) => ({ changes: [], note: null, memory: { text: '摘要', refs: [items[0].n] }, followups: [] });
  correct.policy = 'test';
  const correction = new RollingCorrection(session, correct, { intervalMs: 1_000_000 });
  assert.equal(correction.snapshot().coveredThrough, 0);
  await correction.run();
  const snapshot = correction.snapshot();
  assert.equal(snapshot.coveredThrough, 12);
  assert.equal(snapshot.covered, 12);
});
