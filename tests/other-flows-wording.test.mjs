/* #955: Every background flow states where its result actually lands before mentioning the Inbox as a completion reminder
   (and flows that never write an Inbox item point to Library › Drafts to publish / Jobs instead of Inbox / 收件箱).
   Also guards hidden-mode page/chapter translation reveal and generic deleted-source wording on Inbox open. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

const m = await loadUi(`
  export { ui, uiFormat, setUiLanguage } from './ui/i18n.js';
  export { startedNotice } from './ui/document-preview/selection-job.js';
  export { SelectionJobList } from './ui/document-preview/SelectionJobs.jsx';
  export { TranslationMenu } from './ui/document-preview/translation/TranslationMenu.jsx';
  export { initialState, reducer, isShown } from './ui/document-preview/translation/model.js';
  export { jobStageLabel } from './ui/generation-status.js';
  export { default as NoteDraft } from './ui/NoteDraft.jsx';
  export { CaseReport } from './ui/CaseResult.jsx';
  export { AudioHeader } from './ui/app/page-views.jsx';
  export { default as Inbox } from './ui/Inbox.jsx';
`);

const h = React.createElement;
const noop = () => {};
const han = /[\u3400-\u9fff]/;

function withLang(language, fn) {
  m.setUiLanguage(language);
  try {
    return fn();
  } finally {
    m.setUiLanguage('zh');
  }
}

test('live-class question generation points to Library drafts and Jobs, never Inbox or 收件箱', () => {
  const liveClassSrc = readFileSync('ui/LiveClass.jsx', 'utf8');
  assert.doesNotMatch(liveClassSrc, /收件箱|在信箱打开草稿/);
  assert.match(liveClassSrc, /学习库 › 待发布草稿/);
  assert.match(liveClassSrc, /任务/);

  const zhDoc = readFileSync('docs/live-class.zh-CN.md', 'utf8');
  const enDoc = readFileSync('docs/live-class.md', 'utf8');
  assert.doesNotMatch(zhDoc, /从「信箱」打开/);
  assert.match(zhDoc, /学习库 › 待发布草稿/);
  assert.doesNotMatch(enDoc, /open it from the \*\*Inbox\*\*/i);
  assert.match(enDoc, /Library › Drafts to publish/);
});

test('selection supplement copy states approved questions go straight into the deck before mentioning the Inbox reminder', () => {
  for (const lang of ['zh', 'en']) {
    withLang(lang, () => {
      const running = m.startedNotice({ status: 'running' }, 'Architecture basics').text;
      const queued = m.startedNotice({ status: 'queued', queuedBehind: 2 }, 'Architecture basics').text;
      const listHtml = renderToStaticMarkup(h(m.SelectionJobList, {
        jobs: [{
          id: 'j1',
          operationId: 'op-1',
          status: 'running',
          stageCode: 'authoring',
          deckId: 'd1',
          targetTitle: 'Architecture basics',
          startedAt: '2026-11-11T00:00:00.000Z',
          selection: { quote: 'Idempotency prevents duplicate side effects.' },
        }],
        now: Date.parse('2026-11-11T00:00:05.000Z'),
      }));
      if (lang === 'zh') {
        assert.match(running, /直接加入题组.*完成时信箱会提醒你/);
        assert.match(queued, /直接加入题组.*完成时信箱会提醒你/);
        assert.match(listHtml, /直接加入所选题组.*完成时信箱会提醒你/);
      } else {
        assert.doesNotMatch(running, han);
        assert.doesNotMatch(queued, han);
        assert.match(running, /deck.*inbox/i);
        assert.match(listHtml, /deck.*inbox/i);
      }
    });
  }
});

test('reader translation menu states translations appear beside paragraphs first, and hidden mode reveals newly finished job items', () => {
  const zhMenu = withLang('zh', () => renderToStaticMarkup(h(m.TranslationMenu, {
    open: true, onOpenChange: noop, scopes: [{ id: 'page', label: '翻译本页', status: 'ready', counts: { toTranslate: 3, cached: 1 } }],
    target: 'zh', modelAvailable: true, stale: [], busy: false, hasTranslations: true,
    onStart: noop, onExpandAll: noop, onCollapseAll: noop, onGlossary: noop, onTarget: noop,
  })));
  assert.match(zhMenu, /译文会显示在对应段落旁.*完成时信箱会提醒你/);

  const enMenu = withLang('en', () => renderToStaticMarkup(h(m.TranslationMenu, {
    open: true, onOpenChange: noop, scopes: [{ id: 'page', label: 'Translate this page', status: 'ready', counts: { toTranslate: 3, cached: 1 } }],
    target: 'zh', modelAvailable: true, stale: [], busy: false, hasTranslations: true,
    onStart: noop, onExpandAll: noop, onCollapseAll: noop, onGlossary: noop, onTarget: noop,
  })));
  assert.doesNotMatch(enMenu.replace(/简体中文/g, ''), han);
  assert.match(enMenu, /beside each paragraph.*inbox/i);

  // Hidden mode: initial load keeps items folded, while a finished page/chapter job load with revealNew reveals newly arrived items
  // and any keys explicitly requested by that scope.
  const first = m.reducer(m.initialState, {
    type: 'loaded',
    list: { target: 'zh', targetSource: 'default', glossary: [], modelAvailable: true, items: [{ key: 'p1', text: '第一段译文' }] },
  });
  assert.equal(m.isShown(first, 'p1', 'hidden'), false, 'initial load in hidden mode stays hidden');

  const afterJob = m.reducer(first, {
    type: 'loaded',
    revealNew: true,
    revealKeys: ['p1'],
    list: {
      target: 'zh',
      targetSource: 'default',
      glossary: [],
      modelAvailable: true,
      items: [
        { key: 'p1', text: '第一段译文' },
        { key: 'p2', text: '第二段译文' },
      ],
    },
  });
  assert.equal(m.isShown(afterJob, 'p2', 'hidden'), true, 'newly translated paragraph is shown in hidden mode');
  assert.equal(m.isShown(afterJob, 'p1', 'hidden'), true, 'cached paragraph within the translated scope is also shown');
});

test('deleted-material fallback in use-learning-navigation no longer blames transcript sources', () => {
  const navSrc = readFileSync('ui/app/use-learning-navigation.js', 'utf8');
  assert.doesNotMatch(navSrc, /逐字稿资料已被删除/);
  assert.match(navSrc, /这份资料已被删除。/);
  withLang('en', () => {
    const translated = m.ui('这份资料已被删除。');
    assert.doesNotMatch(translated, han);
    assert.doesNotMatch(translated, /transcript/i);
  });
});

test('notes drafting, case grading, audio header, skeleton tip, and empty/unread Inbox all state destination before reminder', () => {
  const zhDraft = withLang('zh', () => renderToStaticMarkup(h(m.NoteDraft, {
    note: { id: 'n1' }, model: { ready: true }, running: true, onStart: noop,
  })));
  assert.match(zhDraft, /正文会直接写进这篇笔记.*完成时信箱会提醒你/);

  const zhCaseDone = withLang('zh', () => m.jobStageLabel({ kind: 'case', publication: { deckId: 'd1' }, status: 'complete', stageCode: 'done' }));
  assert.match(zhCaseDone, /学习库.*各题下方.*信箱/);

  const zhReport = withLang('zh', () => renderToStaticMarkup(h(m.CaseReport, {
    report: {
      runId: 'r1',
      case: {
        title: 'Case 1', total: 0, max: 10, pending: 1,
        pacing: { readingMs: 60000, writingMs: 120000, rows: [], unanswered: [], overBudget: [] },
        questions: [{ cardId: 'c1', n: 1, prompt: 'Q1', marks: 10, total: null, status: 'pending' }],
        weakest: [],
      },
    },
  })));
  assert.match(zhReport, /批改结果会自动出现在这里，完成时信箱也会提醒你。/);

  const skeletonSrc = readFileSync('ui/Skeleton.jsx', 'utf8');
  assert.doesNotMatch(skeletonSrc, /修过的题会进信箱/);
  assert.match(skeletonSrc, /直接改有问题的题卡.*信箱会提醒你/);

  const zhAudio = withLang('zh', () => renderToStaticMarkup(h(m.AudioHeader, { onSettings: noop, onSources: noop })));
  assert.match(zhAudio, /实时进度.*资料.*完成时信箱会提醒你/);

  const zhEmptyInbox = withLang('zh', () => renderToStaticMarkup(h(m.Inbox, {
    inbox: { unread: 0, items: [] }, onOpen: noop, onReadAll: noop, onOpenTasks: noop, defaultOpen: true,
  })));
  assert.doesNotMatch(zhEmptyInbox, /结果会放在这里/);
  assert.match(zhEmptyInbox, /完成后会在这里提醒你，点一下就能跳回对应的地方。/);

  const zhUnreadInbox = withLang('zh', () => renderToStaticMarkup(h(m.Inbox, {
    inbox: { unread: 3, items: [] }, onOpen: noop, onReadAll: noop,
  })));
  assert.doesNotMatch(zhUnreadInbox, /后台结果待查看/);
  assert.match(zhUnreadInbox, /3 条完成提醒未读/);

  const enEmptyInbox = withLang('en', () => renderToStaticMarkup(h(m.Inbox, {
    inbox: { unread: 2, items: [] }, onOpen: noop, onReadAll: noop, onOpenTasks: noop, defaultOpen: true,
  })));
  assert.doesNotMatch(enEmptyInbox, han);

  const zhFollowupDoc = readFileSync('docs/followup.zh-CN.md', 'utf8');
  const enFollowupDoc = readFileSync('docs/followup.md', 'utf8');
  assert.doesNotMatch(zhFollowupDoc, /答案显示之前看不到问答/);
  assert.doesNotMatch(enFollowupDoc, /Q&A stay hidden until the answer is shown/);
});
