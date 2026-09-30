import test from 'node:test';
import assert from 'node:assert/strict';
import { runTitle, runTitleInfo } from '../lib/run-title.js';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const compiled = await build({ stdin: { contents: `export * from './ui/run-titles.js'; export * from './ui/i18n.js';`, resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'] });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { localizeRunResponse, localizedRun, setUiLanguage, uiFormat } = module.exports;

test('system review titles translate without rewriting course or question names', () => {
  const s = { decks: [{ id: 'd', title: '信箱 · 1 道' }], workflowSessions: [{ id: 'w', topic: '设计模式' }] };
  const titles = [
    [{ mode: 'path', scope: [{ deckId: 'd', cardId: 'c' }], purpose: 'inbox' }, '信箱 · 1 道', 'Inbox · 1'],
    [{ mode: 'path', scope: [{ deckId: 'd', cardId: 'c' }], returnTo: 'r' }, '前置题 · 1 道', 'Prerequisites · 1'],
    [{ mode: 'path', scope: [{ deckId: 'd' }] }, '信箱 · 1 道', '信箱 · 1 道'],
    [{ mode: 'path', purpose: 'course', course: '设计模式' }, '课程 · 设计模式', 'Course · 设计模式'],
    [{ mode: 'path', workflowSessionId: 'w' }, '学习流 · 设计模式', 'Learning flow · 设计模式'],
  ];
  try {
    for (const [run, zh, en] of titles) {
      const dto = { title: runTitle(s, run), titleInfo: runTitleInfo(s, run) };
      assert.equal(dto.title, zh);
      setUiLanguage('en'); assert.equal(localizedRun(dto).title, en);
      setUiLanguage('zh'); assert.equal(localizedRun(dto).title, zh);
    }
    setUiLanguage('en');
    assert.equal(uiFormat('← 回到之前的第 {0} 题', [1]), '← Return to previous question (1)');
    const card = { title: '今日学习', prompt: '题目原文' };
    const dto = { title: '信箱 · 1 道', titleInfo: runTitleInfo(s, titles[0][0]) };
    const result = localizeRunResponse({ runs: [dto], lastRun: dto, card });
    assert.equal(result.lastRun.title, 'Inbox · 1');
    assert.equal(result.runs[0].title, 'Inbox · 1');
    assert.equal(result.card, card);
    assert.equal(dto.title, '信箱 · 1 道');
  } finally { setUiLanguage('zh'); }
});
