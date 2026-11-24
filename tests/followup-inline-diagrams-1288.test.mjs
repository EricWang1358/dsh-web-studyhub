import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { basename } from 'node:path';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildHostClient } from '../scripts/build.mjs';
import { answerFollowup, suggestFollowups } from '../lib/followup.js';
import { assistInstruction } from '../lib/assist-content.js';
import { exportBook } from '../lib/course-book-export.js';
import { exportBook as fixtureBook } from './helpers/course-book-export-book.mjs';

const compiledUi = await build({
  stdin: {
    contents: `export { default as Markdown } from './ui/Markdown.jsx'; export { warmStudyDiagramRenderer, resetStudyDiagramCacheForTests } from './ui/StudyDiagram.jsx';`,
    resolveDir: process.cwd(),
    loader: 'jsx',
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  external: ['react', 'react-dom'],
  loader: { '.css': 'text' },
  logLevel: 'silent',
});
const uiModule = { exports: {} };
new Function('require', 'module', 'exports', compiledUi.outputFiles[0].text)(
  createRequire(import.meta.url),
  uiModule,
  uiModule.exports,
);
const { Markdown, warmStudyDiagramRenderer, resetStudyDiagramCacheForTests } = uiModule.exports;

test('#1288-1: study-diagram-render parses and renders flowchart, sequence, and state diagrams with safe SVG and graceful fallback', async () => {
  const mod = await import('../ui/study-diagram-render.js');
  assert.equal(mod.isDiagramFenceLang('mermaid'), true);
  assert.equal(mod.isDiagramFenceLang('MERMAID'), true);
  assert.equal(mod.isDiagramFenceLang('diagram'), true);
  assert.equal(mod.isDiagramFenceLang('javascript'), false);
  assert.equal(mod.isDiagramFenceLang(''), false);

  // Flowchart TD with shapes, chains, edge labels, subgraph, CJK, and a back-edge cycle
  const flow = mod.renderStudyDiagram([
    'flowchart TD',
    '  subgraph 事务处理',
    '    A([开始]) --> B{隔离级别?}',
    '    B -->|RC| C[每条语句新建 ReadView]',
    '    B -.->|RR| D[事务首个快照复用]',
    '  end',
    '  C ==> E((结束))',
    '  D --> E',
    '  D -. 重试 .-> B',
  ].join('\n'));
  assert.ok(flow && typeof flow.svg === 'string', 'flowchart should render');
  assert.equal(flow.kind, 'flowchart');
  assert.ok(flow.width > 100 && flow.height > 100);
  assert.match(flow.svg, /<svg\b[^>]*class="md-diagram-svg"/);
  assert.match(flow.svg, /每条语句新建 ReadView/);
  assert.match(flow.svg, /事务处理/);
  assert.match(flow.svg, /var\(--/);

  // Flowchart LR with chained edges
  const flowLr = mod.renderStudyDiagram('graph LR\n  A[请求] --> B[网关] --> C[服务]');
  assert.ok(flowLr && flowLr.kind === 'flowchart');
  assert.ok(flowLr.width > flowLr.height, 'LR layout should be wider than tall for a 3-step chain');

  // Sequence diagram with aliases, self-message, reply, and note
  const seq = mod.renderStudyDiagram([
    'sequenceDiagram',
    '  participant C as 客户端',
    '  participant S as 服务端',
    '  C->>S: SYN (seq=x)',
    '  S-->>C: SYN-ACK (seq=y, ack=x+1)',
    '  C->>C: 进入 ESTABLISHED',
    '  Note over C,S: 三次握手完成',
  ].join('\n'));
  assert.ok(seq && seq.kind === 'sequence');
  assert.match(seq.svg, /客户端/);
  assert.match(seq.svg, /SYN-ACK/);
  assert.match(seq.svg, /三次握手完成/);

  // State diagram
  const state = mod.renderStudyDiagram([
    'stateDiagram-v2',
    '  [*] --> Ready',
    '  Ready --> Running : dispatch',
    '  Running --> Blocked : I/O wait',
    '  Blocked --> Ready : I/O done',
    '  Running --> [*]',
  ].join('\n'));
  assert.ok(state && state.kind === 'state');
  assert.match(state.svg, /dispatch/);
  assert.match(state.svg, /Blocked/);

  // XSS safety: dangerous markup must be escaped, never injected
  const xss = mod.renderStudyDiagram('flowchart LR\n  A["<script>alert(1)</script>"] --> B["<img onerror=x>"]');
  assert.ok(xss);
  assert.doesNotMatch(xss.svg, /<script\b/i);
  assert.doesNotMatch(xss.svg, /<foreignObject\b/i);
  assert.match(xss.svg, /&lt;script&gt;alert\(1\)/);
  assert.match(xss.svg, /&lt;img onerror=x&gt;/);

  // Malformed / unsupported / empty syntax falls back cleanly (returns null, never throws)
  assert.equal(mod.renderStudyDiagram(''), null);
  assert.equal(mod.renderStudyDiagram('gantt\n  title Unsupported'), null);
  assert.equal(mod.renderStudyDiagram('flowchart TD\n  this is not valid syntax @@@ ###'), null);
  assert.equal(mod.renderStudyDiagram('sequenceDiagram\n  broken line without arrow'), null);
});

test('#1288-2: Markdown renders inline diagrams via lazy StudyDiagram and falls back to code block on invalid syntax', async () => {
  // Before warming, plain code blocks stay code blocks without loading diagrams
  resetStudyDiagramCacheForTests();
  const plainHtml = renderToStaticMarkup(React.createElement(Markdown, {
    text: '先看代码：\n\n```js\nconst x = 1;\n```',
  }));
  assert.match(plainHtml, /md-code-block/);
  assert.doesNotMatch(plainHtml, /md-diagram/);

  // Warm the lazy renderer (same pattern as StudyMath tests)
  await warmStudyDiagramRenderer();

  const mdWithDiagram = [
    '结论：隔离级别决定 ReadView 的创建时机。',
    '',
    '```mermaid',
    'flowchart LR',
    '  A[SQL 查询] --> B[生成 ReadView]',
    '```',
    '',
    '因此不可重复读只在 RC 下出现。',
  ].join('\n');
  const rendered = renderToStaticMarkup(React.createElement(Markdown, { text: mdWithDiagram }));
  assert.match(rendered, /结论：隔离级别决定 ReadView/);
  assert.match(rendered, /class="md-diagram"/);
  assert.match(rendered, /data-diagram-kind="flowchart"/);
  assert.match(rendered, /<svg\b[^>]*class="md-diagram-svg"/);
  assert.match(rendered, /因此不可重复读只在 RC 下出现/);

  // Non-interactive mode (links={false}) still draws the SVG cleanly without toolbar buttons
  const staticRendered = renderToStaticMarkup(React.createElement(Markdown, { text: mdWithDiagram, links: false }));
  assert.match(staticRendered, /<svg\b[^>]*class="md-diagram-svg"/);
  assert.doesNotMatch(staticRendered, /<button\b/);

  // Malformed diagram syntax falls back gracefully to normal code block (no blank, no crash)
  const badMd = '说明：\n\n```mermaid\nnot a valid diagram\n???\n```';
  const badRendered = renderToStaticMarkup(React.createElement(Markdown, { text: badMd }));
  assert.match(badRendered, /md-code-block/);
  assert.match(badRendered, /not a valid diagram/);
  assert.doesNotMatch(badRendered, /class="md-diagram"/);
});

test('#1288-3: diagram renderer stays in its own lazy chunk and is excluded from static workspace closure', async () => {
  const { metafile } = await buildHostClient({ write: false });
  const outputs = new Map(Object.entries(metafile.outputs).map(([path, output]) => [basename(path), output]));
  const workspace = [...outputs.keys()].filter(name => /^client\.workspace-[A-Za-z0-9]+\.js$/.test(name));
  assert.equal(workspace.length, 1);

  const closure = new Set();
  const pending = [...workspace];
  while (pending.length) {
    const name = pending.pop();
    if (closure.has(name)) continue;
    closure.add(name);
    for (const edge of outputs.get(name).imports) {
      if (!edge.external && edge.kind === 'import-statement') pending.push(basename(edge.path));
    }
  }
  const inputs = [...closure].flatMap(name => Object.keys(outputs.get(name).inputs).map(input => input.replaceAll('\\', '/')));
  assert.ok(!inputs.includes('ui/study-diagram-render.js'), 'diagram renderer must stay behind a dynamic import so non-diagram views never load it');

  const diagramChunk = [...outputs].find(([, output]) => output.entryPoint === 'ui/study-diagram-render.js');
  assert.ok(diagramChunk, 'ui/study-diagram-render.js must have its own lazy chunk');
  assert.ok([...outputs.values()].some(output => output.imports.some(edge => edge.kind === 'dynamic-import' && basename(edge.path) === diagramChunk[0])));
});

test('#1288-4: Notes markdown, static book HTML, and Markdown book export handle inline diagrams cleanly', async () => {
  const { renderNoteMarkdown } = await import('../ui/note-markdown.js');
  const { bookHtml } = await import('../ui/book/book-html.js');

  const sample = '前文\n\n```mermaid\nflowchart LR\n  A[输入] --> B[输出]\n```\n\n```mermaid\nbad syntax ???\n```';
  const noteHtml = renderNoteMarkdown(sample);
  assert.match(noteHtml, /class="md-diagram-static"/);
  assert.match(noteHtml, /<svg\b[^>]*class="md-diagram-svg"/);
  assert.match(noteHtml, /bad syntax \?\?\?/);

  const html = bookHtml(`# 课程复习\n\n## 第一章 {#h1}\n\n${sample}`, { language: 'zh' });
  assert.match(html, /class="md-diagram-static"/);
  assert.match(html, /<svg\b[^>]*class="md-diagram-svg"/);
  assert.match(html, /bad syntax \?\?\?/);

  const book = fixtureBook();
  book.nodes[0].children[0].gen = `# 事务\n\n${sample}`;
  const exported = exportBook(book, { cardOf: () => null, form: 'single', questions: 'none', answerKey: false });
  assert.match(exported.text, /```mermaid\nflowchart LR\n {2}A\[输入\] --> B\[输出\]\n```/);
});

test('#1288-5: follow-up and assist ask prompts include optional concise mermaid diagram guidance without affecting suggest or non-ask modes', async () => {
  const seen = [];
  const card = {
    id: 'c1',
    kind: 'flashcard',
    topic: 'TCP',
    objective: 'Understand handshake',
    prompt: 'Why does TCP use a three-way handshake?',
    answer: 'To synchronize sequence numbers in both directions.',
    explanation: 'Both sides confirm send and receive.',
    misconception: 'Two steps are enough.',
    citations: [],
  };
  await answerFollowup(async (system) => {
    seen.push({ kind: 'zh', system });
    return JSON.stringify({ question: '三次握手的过程是什么？', answer: '见图。' });
  }, card, '三次握手的过程是什么？', { language: 'zh' });
  await answerFollowup(async (system) => {
    seen.push({ kind: 'en', system });
    return JSON.stringify({ question: 'How does the handshake work?', answer: 'See diagram.' });
  }, card, 'How does the handshake work?', { language: 'en' });
  await suggestFollowups(async (system) => {
    seen.push({ kind: 'suggest', system });
    return JSON.stringify({ questions: ['Q1?', 'Q2?', 'Q3?'] });
  }, card, { language: 'zh' });

  assert.match(seen[0].system, /mermaid/i);
  assert.match(seen[1].system, /mermaid/i);
  assert.doesNotMatch(seen[2].system, /mermaid/i);

  assert.match(assistInstruction('ask', false), /mermaid/i);
  assert.match(assistInstruction('ask', true), /mermaid/i);
  assert.doesNotMatch(assistInstruction('improve', false), /mermaid/i);
  assert.doesNotMatch(assistInstruction('derive', false), /mermaid/i);
  assert.doesNotMatch(assistInstruction('grade', false), /mermaid/i);
});
