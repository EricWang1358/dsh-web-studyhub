import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

// #779: workflow draft and workflow prompt builders are retired and deleted; WorkflowLesson is strictly a read-only archive view.
const m = await loadUi(`
  export { default as WorkflowLesson } from './ui/WorkflowLesson.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);

test('retired workflow-draft and workflow agent-prompt modules are removed (#779)', () => {
  assert.equal(existsSync(new URL('../ui/workflow-draft.js', import.meta.url)), false);
  assert.equal(existsSync(new URL('../ui/agent-prompts/workflow.js', import.meta.url)), false);
});

test('WorkflowLesson renders archived explanations, citations, remedy notes, and help items strictly read-only (#779)', () => {
  m.setUiLanguage('zh');
  const html = renderToStaticMarkup(
    React.createElement(m.WorkflowLesson, {
      content: '## 核心直觉\n\n多数派交集保证安全性。',
      record: {
        citations: [{ sourceId: 's-1', quote: 'At most one leader can be elected in a given term.' }],
        teaching: { status: 'done', tokenUsage: { promptTokens: 100, completionTokens: 80, totalTokens: 180 } },
        help: [
          { id: 'h-remedy', kind: 'remedy', request: '为什么需要任期号？；选举超时作用', content: '任期号充当逻辑时钟。', citations: [] },
          { id: 'h-example', kind: 'example', content: '以 3 节点集群为例。', citations: [] },
        ],
      },
      resources: { sources: [{ id: 's-1', title: 'Raft Paper' }] },
    }),
  );
  assert.match(html, /本步讲解/);
  assert.match(html, /多数派交集保证安全性/);
  assert.match(html, /Raft Paper/);
  assert.match(html, /针对你复述里漏掉的地方/);
  assert.match(html, /想一想：为什么需要任期号？/);
  assert.match(html, /换个例子/);
  assert.doesNotMatch(html, /生成完整讲解|重新生成|帮我弄懂|提升讲解质量|撤销上次改写|补充我的具体疑问|<textarea/i);

  const emptyHtml = renderToStaticMarkup(
    React.createElement(m.WorkflowLesson, { content: '', record: {}, resources: { sources: [] } }),
  );
  assert.match(emptyHtml, /本步未保存讲解/);
  assert.match(emptyHtml, /该历史步骤没有已保存的讲解正文/);
  assert.doesNotMatch(emptyHtml, /生成完整讲解|<button.*生成/i);

  m.setUiLanguage('en');
  try {
    const enHtml = renderToStaticMarkup(
      React.createElement(m.WorkflowLesson, {
        content: 'Quorum intersection guarantees safety.',
        record: {
          help: [{ id: 'h-ex', kind: 'example', content: 'Consider a 3-node cluster.', citations: [] }],
        },
        resources: { sources: [] },
      }),
    );
    assert.doesNotMatch(enHtml, /[\u3400-\u9fff]/, 'English read-only WorkflowLesson has zero Chinese residue');
  } finally {
    m.setUiLanguage('zh');
  }
});
