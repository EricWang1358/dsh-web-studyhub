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

  assert.match(html, /没有可用的 AI 模型：带学的讲解和现场出题暂停了/);
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

test('GuidedStudyWorkbench mounts QuestionPrepSlot when preparing question or failed', () => {
  const sessionRunning = {
    id: 's1',
    courseId: 'CS101',
    status: 'active',
    focus: { kind: 'preparing-card', jobId: 'j1' },
    goal: { title: 'Master Trees' },
  };

  const htmlRunning = renderToStaticMarkup(h(ui.GuidedStudyWorkbench, {
    session: sessionRunning,
    run: null,
    modelReady: true,
  }));

  assert.match(htmlRunning, /question-prep-slot/);
  assert.match(htmlRunning, /正在出一道新题/);
  assert.doesNotMatch(htmlRunning, /预计耗时/, 'no promised duration (#547)');
  assert.match(htmlRunning, /取消准备/);

  // Failed state via prepState
  const htmlFailed = renderToStaticMarkup(h(ui.GuidedStudyWorkbench, {
    session: { id: 's1', courseId: 'CS101', status: 'active' },
    prepState: { status: 'failed', message: '所选段落未能核对出可作答引文' },
    run: null,
    modelReady: true,
  }));

  assert.match(htmlFailed, /这道题没有加入题组/);
  assert.match(htmlFailed, /所选段落未能核对出可作答引文/);
  assert.match(htmlFailed, /改用已有题练习/);
});

test('GuidedStudyWorkbench mounts StudyProgressPanel and renders AskTutor button', () => {
  const session = {
    id: 's1',
    courseId: 'CS101',
    status: 'active',
    focus: { kind: 'card', id: 'c1', runId: 'r1' },
    goal: {
      title: 'Master Trees',
      checkItems: [
        { id: 'chk-1', title: 'Binary Tree Invariant', status: 'passed' },
        { id: 'chk-2', title: 'Tree Traversal', status: 'pending' },
      ],
    },
  };

  const run = {
    id: 'r1',
    index: 0,
    entries: [
      {
        card: { id: 'c1', prompt: 'What is tree height?', kind: 'quiz' },
        revealed: false,
      },
    ],
  };

  const html = renderToStaticMarkup(h(ui.GuidedStudyWorkbench, {
    session,
    run,
    modelReady: true,
  }));

  // Verifies StudyProgressPanel is mounted in footer
  assert.match(html, /study-progress-panel/);
  assert.match(html, /progress-summary-row/);
  assert.match(html, /展开依据/);

  // Verifies 「请教主会话」 button is present in practice card actions
  assert.match(html, /请教主会话/);

  // When card is revealed and onAnswer is passed, show grade buttons
  const runRevealed = {
    ...run,
    entries: [
      {
        card: { id: 'c1', prompt: 'What is tree height?', kind: 'quiz', explanation: 'Number of edges on longest path' },
        revealed: true,
      },
    ],
  };

  const htmlRevealed = renderToStaticMarkup(h(ui.GuidedStudyWorkbench, {
    session,
    run: runRevealed,
    modelReady: true,
    onAnswer: () => {},
  }));

  assert.match(htmlRevealed, /Number of edges on longest path/);
  assert.match(htmlRevealed, /我掌握了/);
  assert.match(htmlRevealed, /没掌握/);
  assert.match(htmlRevealed, /请教主会话/);
});

test('GuidedStudyWorkbench supports standard projected run (without entries array) and next question transition', () => {
  const session = {
    id: 's1',
    courseId: 'CS101',
    status: 'active',
    goal: { title: 'Master Trees' },
  };

  // 1. Standard projected run from review.get / session.run (card on run root, not in entries)
  const projectedRunUnrevealed = {
    id: 'r1',
    card: { id: 'c1', prompt: 'What is tree height?', kind: 'quiz', explanation: 'Longest path' },
    revealed: false,
    index: 0,
    total: 3,
  };

  const htmlUnrevealed = renderToStaticMarkup(h(ui.GuidedStudyWorkbench, {
    session,
    run: projectedRunUnrevealed,
    modelReady: true,
  }));

  assert.match(htmlUnrevealed, /What is tree height\?/);
  assert.match(htmlUnrevealed, /揭晓答案/);
  assert.doesNotMatch(htmlUnrevealed, /现在没有要做的题/);

  // 2. Projected run revealed, ready for answer
  const projectedRunRevealed = {
    ...projectedRunUnrevealed,
    revealed: true,
  };

  const htmlRevealed = renderToStaticMarkup(h(ui.GuidedStudyWorkbench, {
    session,
    run: projectedRunRevealed,
    modelReady: true,
    onAnswer: () => {},
  }));

  assert.match(htmlRevealed, /Longest path/);
  assert.match(htmlRevealed, /我掌握了/);
  assert.match(htmlRevealed, /没掌握/);

  // 3. Projected run with feedback (answered), showing next button
  const projectedRunAnswered = {
    ...projectedRunRevealed,
    feedback: { grade: 3, correct: true },
  };

  const htmlAnswered = renderToStaticMarkup(h(ui.GuidedStudyWorkbench, {
    session,
    run: projectedRunAnswered,
    modelReady: true,
    onAnswer: () => {},
    onNext: () => {},
  }));

  assert.match(htmlAnswered, /下一题/);
  assert.doesNotMatch(htmlAnswered, /我掌握了/);
});




test('a choice question on the workbench is answered on its options, drawn as Markdown, never by 我掌握了 (#547)', () => {
  const card = { id: 'c1', kind: 'quiz', prompt: 'Which is $a^{2}$?', explanation: 'Because **squares**.',
    options: [{ id: 'a', text: 'The square', correct: true }, { id: 'b', text: 'The cube', correct: false }] };
  const html = renderToStaticMarkup(h(ui.GuidedStudyWorkbench, {
    session: { id: 's1', courseId: 'CS101', status: 'active' }, run: { id: 'r1', card, revealed: false }, modelReady: true, onAnswer: () => {},
  }));
  assert.match(html, /type="radio"/);
  assert.match(html, /The square/);
  assert.match(html, /The cube/);
  assert.match(html, /提交答案/);
  assert.doesNotMatch(html, /我掌握了|揭晓答案/);
  assert.match(html, /<div class="md[ "][^>]*>[\s\S]*Which is/, 'the stem goes through the Markdown renderer (formulas, images)');
  assert.match(html, /<strong>squares<\/strong>|class="md/, 'and so does the explanation once shown');
  const multi = renderToStaticMarkup(h(ui.GuidedStudyWorkbench, {
    session: { id: 's1', status: 'active' }, run: { id: 'r1', card: { ...card, kind: 'multi' } }, modelReady: true, onAnswer: () => {},
  }));
  assert.match(multi, /type="checkbox"/);
  const flash = renderToStaticMarkup(h(ui.GuidedStudyWorkbench, {
    session: { id: 's1', status: 'active' }, run: { id: 'r1', card: { id: 'f', kind: 'flashcard', prompt: 'Recall it' } }, modelReady: true, onAnswer: () => {},
  }));
  assert.match(flash, /揭晓答案/, 'a card without options is still revealed and self-graded');
});
