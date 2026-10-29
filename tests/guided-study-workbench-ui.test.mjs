import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

const ui = await loadUi(`
  export { default as GuidedStudyWorkbench } from './ui/guided-study/GuidedStudyWorkbench.jsx';
  export { TeachingArtifactBlock } from './ui/guided-study/TeachingArtifactBlock.jsx';
`);

const h = React.createElement;

test('GuidedStudyWorkbench renders 4 regions and adapts layout based on focus kind', () => {
  const session = {
    id: 's1',
    courseId: 'CS101',
    status: 'active',
    focus: { kind: 'artifact', id: 'art-1' },
    goal: { title: 'Master Trees' },
    artifactRefs: [
      { id: 'art-1', title: 'Binary Tree Definition', markdown: 'A binary tree has at most two children.' },
    ],
  };

  const htmlArtifact = renderToStaticMarkup(h(ui.GuidedStudyWorkbench, {
    session,
    run: null,
    modelReady: true,
  }));

  assert.match(htmlArtifact, /guided-study-adaptive-artifact/);
  assert.match(htmlArtifact, /CS101/);
  assert.match(htmlArtifact, /Master Trees/);
  assert.match(htmlArtifact, /Binary Tree Definition/);
  assert.match(htmlArtifact, /A binary tree has at most two children/);

  // Switch to card focus
  const sessionCard = {
    ...session,
    focus: { kind: 'card', id: 'c1', runId: 'r1' },
  };
  const run = {
    id: 'r1',
    index: 0,
    entries: [
      {
        card: { id: 'c1', prompt: 'What is root height?', kind: 'quiz' },
        revealed: false,
      },
    ],
  };

  const htmlCard = renderToStaticMarkup(h(ui.GuidedStudyWorkbench, {
    session: sessionCard,
    run,
    modelReady: true,
  }));

  assert.match(htmlCard, /guided-study-adaptive-card/);
  assert.match(htmlCard, /What is root height\?/);
  assert.match(htmlCard, /揭晓答案/);
});

test('GuidedStudyWorkbench shows model-unavailable warning when modelReady is false (UC-10)', () => {
  const session = {
    id: 's1',
    courseId: 'CS101',
    status: 'active',
  };

  const html = renderToStaticMarkup(h(ui.GuidedStudyWorkbench, {
    session,
    run: null,
    modelReady: false,
  }));

  assert.match(html, /当前模型不可用：AI 带学讲解与出题已暂停/);
});

test('TeachingArtifactBlock sanitizes malicious markup (HB-8)', () => {
  const artifact = {
    id: 'art-x',
    title: 'Security Drill',
    markdown: 'Safe intro <script>alert("pwnd")</script> <img src="x" onerror="evil()" /> [click](javascript:hack())',
  };

  const html = renderToStaticMarkup(h(ui.TeachingArtifactBlock, { artifact }));

  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /onerror=/i);
  assert.doesNotMatch(html, /javascript:hack/i);
  assert.match(html, /Safe intro/);
});
