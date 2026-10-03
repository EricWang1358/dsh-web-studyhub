import test from 'node:test';
import assert from 'node:assert/strict';
import { pathBrief, queueSteps, selectedItems } from '../ui/generation-path-flow.js';

/* The flow around a step plan: the brief that opens a conversation (so the learner can shape the chapters with the AI), queuing the steps as generation jobs
   in order, and the documents of the selection the plan is made from. Pure; the call is injected. */

const steps = [
  { id: 'step-1', order: 1, title: '第 1 章 引言', sourceIds: ['p1', 'p2'], pages: 2, chars: 40_000, count: 8, focus: '概念辨析' },
  { id: 'step-2', order: 2, title: '第 2 章 进程', sourceIds: ['p3', 'p4', 'p5'], pages: 3, chars: 90_000, count: 15, focus: '' },
];

test('the brief for the conversation carries the plan, the goal, what the index can do and what the AI should do next', () => {
  const zh = pathBrief({ steps, course: '操作系统', goal: '期末考试', indexed: true, language: 'zh' });
  assert.match(zh, /操作系统/);
  assert.match(zh, /第 1 章 引言/);
  assert.match(zh, /p3,p4,p5|p3, p4, p5/, 'a step lists its page ids so the AI can act on it');
  assert.match(zh, /source\.search/, 'the index is used through the search tool');
  assert.match(zh, /generate/, 'the steps become generation jobs after the learner confirms');
  assert.match(zh, /确认/, 'nothing is generated before the learner agrees');
  const en = pathBrief({ steps, course: 'OS', goal: 'exam', indexed: false, language: 'en' });
  assert.match(en, /Chapter|chapter|Step 1/);
  assert.doesNotMatch(en.replace(/第 [^\n]*/g, ''), /[㐀-鿿]/, 'English brief has no Han outside the step titles');
  assert.doesNotMatch(en, /index is built/i);
});

test('a long plan keeps the brief short: ids are dropped beyond a budget and the AI is told how to fetch them', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `step-${i + 1}`, order: i + 1, title: `第 ${i + 1} 章`, sourceIds: Array.from({ length: 80 }, (_, k) => `src-${i}-${k}`), pages: 80, chars: 100_000, count: 10, focus: '' }));
  const brief = pathBrief({ steps: many, course: 'C', goal: '', indexed: true, language: 'zh' });
  assert.ok(brief.length < 9000, `${brief.length} chars`);
  assert.match(brief, /source\.list/, 'when ids are left out, the AI is told to list the pages');
});

test('queueing sends one generation per included step, in order, with its pages, focus and count; a failure is reported and the rest still go', async () => {
  const calls = [];
  const call = async (action, args) => { calls.push({ action, args }); if (args.sourceIds.includes('p3')) throw new Error('额度不足'); return { jobId: `job-${calls.length}` }; };
  const result = await queueSteps(call, steps, { kind: 'auto', difficulty: 'mixed', language: 'zh', focus: '整体', count: 10 }, { course: '操作系统' });
  assert.deepEqual(calls.map(item => item.action), ['generate', 'generate']);
  assert.deepEqual(calls[0].args.sourceIds, ['p1', 'p2']);
  assert.equal(calls[0].args.count, 8);
  assert.equal(calls[0].args.focus, '概念辨析', "the step's focus wins");
  assert.equal(calls[0].args.course, '操作系统');
  assert.equal(calls[0].args.kind, 'auto', 'the form choices (kind, difficulty, language) carry over');
  assert.equal(calls[1].args.focus, '整体', 'a step without its own focus uses the form focus');
  assert.deepEqual([result.started.length, result.failed.length], [1, 1]);
  assert.match(result.failed[0].message, /额度不足/);
  assert.equal(result.failed[0].step.id, 'step-2');
});

test('the selection the plan is made from: the selected pages of each document, in library order', () => {
  const sources = [{ id: 'a1', title: 'A', text: 'x'.repeat(10), document: { id: 'd1', page: 1, totalPages: 2, bookTitle: 'A' } }, { id: 'a2', title: 'A', text: 'y'.repeat(20), document: { id: 'd1', page: 2, totalPages: 2, bookTitle: 'A' } }, { id: 'n1', title: 'note', text: 'z' }];
  const items = selectedItems(sources, ['a2', 'n1']);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map(item => item.sourceIds), [['a2'], ['n1']]);
});

test('the panel: steps with sizes and a queue button for a big selection, nothing for a small one, in both languages', async () => {
  const { build } = await import('esbuild');
  const { createRequire } = await import('node:module');
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const out = await build({ stdin: { contents: "export { default as GenerationPath } from './ui/GenerationPath.jsx'; export { setUiLanguage } from './ui/i18n.js';", resolveDir: process.cwd() },
    bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
  const { GenerationPath, setUiLanguage } = mod.exports;
  const page = (n, chars) => ({ id: `b${n}`, title: `Book · p.${n}`, text: undefined, chars, document: { id: 'h', page: n, totalPages: 12, bookTitle: 'Book', origin: 'converted', converter: 'mineru' } });
  const big = Array.from({ length: 12 }, (_, i) => page(i + 1, 40_000)); // 480k chars
  const noop = () => {};
  const render = (props = {}) => renderToStaticMarkup(React.createElement(GenerationPath, { sources: big, selectedIds: big.map(source => source.id), gen: {}, course: 'OS', call: noop, askInChat: noop, setNotice: noop, onUseStep: noop, ...props }));
  const zh = render();
  assert.match(zh, /分步生成路径/);
  assert.match(zh, /第 1 步/);
  assert.match(zh, /让 AI 优化路径/);
  assert.match(zh, /和 AI 聊聊怎么学/);
  assert.match(zh, /按路径逐步出题 · \d+ 步依次排队/);
  assert.match(zh, /data-usage="generate\.path-queue"/);
  assert.equal(render({ sources: big.slice(0, 2), selectedIds: ['b1', 'b2'] }), '', 'a small selection needs no path');
  assert.doesNotMatch(render({ askInChat: undefined }), /和 AI 聊聊怎么学/, 'no chat to open: no button');
  const indexed = render({ indexCoverage: { indexed: big.map(source => source.id), stale: [], missing: [] } });
  assert.match(indexed, /检索索引已建好/);
  setUiLanguage('en');
  try {
    const en = render();
    assert.match(en, /Step-by-step path/);
    assert.match(en, /Generate step by step · queue \d+ steps in order/);
    assert.match(en, /Pages 1–\d+/, 'step names are in English');
    assert.doesNotMatch(en, /[㐀-鿿]/);
  } finally { setUiLanguage('zh'); }
});
