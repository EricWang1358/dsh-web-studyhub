/* #955: Every background flow states where its result actually lands before mentioning the Inbox as a completion reminder
   (and flows that never write an Inbox item point to Library › Drafts to publish / Jobs instead of Inbox / 收件箱).
   Also guards hidden-mode page/chapter translation reveal and generic deleted-source wording on Inbox open. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { loadInteractiveUi, withBrowserGlobals, click } from './helpers/react-harness.mjs';

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
  export { default as Skeleton } from './ui/Skeleton.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
`);

const interactive = await loadInteractiveUi(`
  export { default as LiveClass } from './ui/LiveClass.jsx';
  export { useLearningNavigation } from './ui/app/use-learning-navigation.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { ToastContext } from './ui/components/index.js';
  export { setUiLanguage } from './ui/i18n.js';
`);

const h = React.createElement;
const hi = interactive.React.createElement;
const noop = () => {};
const han = /[\u3400-\u9fff]/;
const studyServices = {
  call: async () => ({}),
  act: async () => undefined,
  busy: false,
  notify: noop,
  askInChat: noop,
  host: {},
  openSettings: noop,
  navigate: noop,
  openModal: noop,
};

function withLang(language, fn) {
  m.setUiLanguage(language);
  try {
    return fn();
  } finally {
    m.setUiLanguage('zh');
  }
}

test('live-class question generation points to Library drafts and Jobs, never Inbox or 收件箱', async () => {
  await withBrowserGlobals(async () => {
    const initialSession = {
      id: 'ls-1',
      status: 'live',
      title: 'Lecture 1',
      course: 'DB',
      elapsedMs: 1000,
      revision: 1,
      segments: [{
        id: 1,
        t: 0,
        en: 'Distributed consensus algorithms like Raft guarantee safety and liveness across replicated state machines even when network partitions happen.',
      }],
    };
    for (const lang of ['zh', 'en']) {
      interactive.exports.setUiLanguage(lang);
      const toasts = [];
      const genCalls = [];
      const services = {
        ...studyServices,
        call: async (action, args) => {
          if (action === 'live.list') return { sessions: [] };
          if (action === 'live.generate') { genCalls.push(args); return { jobId: 'j-live-1' }; }
          if (action === 'live.poll') return { id: 'ls-1', status: 'live', revision: 1 };
          return {};
        },
      };
      const toastApi = { success: (msg) => toasts.push(msg), info: noop, warning: noop, error: noop, show: noop, dismiss: noop };
      const mounted = interactive.mount(() => hi(
        interactive.exports.StudyServicesContext.Provider,
        { value: services },
        hi(
          interactive.exports.ToastContext.Provider,
          { value: toastApi },
          hi(interactive.exports.LiveClass, {
            data: { root: '/tmp/live-wording', focus: { course: 'DB', courses: [] } },
            visible: true,
            onQueued: noop,
            onSettings: noop,
            onSources: noop,
            initialReadiness: { live: true, providers: { free: true } },
            initialSession,
          }),
        ),
      ));
      try {
        await mounted.flush();
        const selectionButtons = mounted.findAll((node) => node.type === 'button' && String(node.props?.className || '').includes('live-selection-btn'));
        const recentBtn = selectionButtons.find((btn) => !btn.props.disabled && !String(btn.props.className).includes('sh-btn--primary'));
        assert.ok(recentBtn, `${lang}: recent-window selection button is enabled`);
        await mounted.act(() => click(recentBtn));
        const genBtn = mounted.find((node) => node.type === 'button' && String(node.props?.className || '').includes('live-selection-btn') && String(node.props?.className || '').includes('sh-btn--primary'));
        assert.ok(genBtn && !genBtn.props.disabled, `${lang}: generate button enables once >=120 chars selected`);
        await mounted.act(() => click(genBtn));
        await mounted.flush();
        assert.deepEqual(genCalls, [{ id: 'ls-1', segmentIds: [1], count: 5 }]);
        assert.equal(toasts.length, 1);
        if (lang === 'zh') {
          assert.doesNotMatch(toasts[0], /收件箱|在信箱打开草稿/);
          assert.match(toasts[0], /学习库 › 待发布草稿/);
          assert.match(toasts[0], /任务/);
        } else {
          assert.doesNotMatch(toasts[0], han);
          assert.doesNotMatch(toasts[0], /inbox/i);
          assert.match(toasts[0], /Library › Drafts to publish/i);
          assert.match(toasts[0], /Jobs/i);
        }
      } finally {
        mounted.unmount();
        interactive.exports.setUiLanguage('zh');
      }
    }
  });

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

test('deleted-material fallback in use-learning-navigation no longer blames transcript sources', async () => {
  await withBrowserGlobals(async () => {
    const notices = [];
    const modals = [];
    const refs = {
      dataRef: { current: { root: '/tmp/nav-deleted', sources: [], focus: { course: null } } },
      epoch: { current: 1 },
      navigation: { current: 0 },
      examLocation: { current: null },
    };
    const hook = interactive.mountHook(interactive.exports.useLearningNavigation, {
      core: { call: async () => ({}), setError: noop, notify: (msg) => notices.push(msg), refresh: async () => {}, refs },
      lib: {
        state: { modal: null, contextTrail: [], practiceStack: [], practiceEnded: null, focusRequest: null, detour: null },
        set: {
          setModal: (v) => modals.push(v),
          setContextTrail: noop,
          setPracticeStack: noop,
          setPracticeEnded: noop,
          setFocusRequest: noop,
          setDetour: noop,
          setBoardStudyRef: noop,
          setBoardCompose: noop,
        },
      },
      nav: { page: 'library', show: {}, navigate: noop, leaving: (fn) => fn(), referenceRef: { current: null }, leaveReviewRef: { current: null } },
      session: { run: null, entry: null, enterRun: noop, enterMovedRun: noop },
      rootRef: { current: null },
    });
    try {
      interactive.exports.setUiLanguage('zh');
      hook.current.openAudioSources(['missing-source-1']);
      hook.current.openSourceAt('missing-source-2', 42);
      assert.deepEqual(notices, ['这份资料已被删除。', '这份资料已被删除。']);
      for (const msg of notices) assert.doesNotMatch(msg, /逐字稿资料已被删除/);
      assert.equal(modals.length, 0);

      notices.length = 0;
      interactive.exports.setUiLanguage('en');
      hook.current.openAudioSources(['missing-source-1']);
      hook.current.openSourceAt('missing-source-2', 42);
      assert.equal(notices.length, 2);
      for (const msg of notices) {
        assert.ok(msg.length > 0);
        assert.doesNotMatch(msg, han);
        assert.doesNotMatch(msg, /transcript/i);
      }
      assert.equal(modals.length, 0);
    } finally {
      hook.unmount();
      interactive.exports.setUiLanguage('zh');
    }
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

  const skeletonProps = { data: { root: '/tmp/sk', focus: { course: 'DB', courses: [] }, skeletons: [] }, onPractice: noop, focusId: null, onFocus: noop };
  const zhSkeleton = withLang('zh', () => renderToStaticMarkup(h(
    m.StudyServicesContext.Provider,
    { value: studyServices },
    h(m.Skeleton, skeletonProps),
  )));
  assert.doesNotMatch(zhSkeleton, /修过的题会进信箱/);
  assert.match(zhSkeleton, /直接改有问题的题卡.*信箱会提醒你/);

  const enSkeleton = withLang('en', () => renderToStaticMarkup(h(
    m.StudyServicesContext.Provider,
    { value: studyServices },
    h(m.Skeleton, skeletonProps),
  )));
  assert.doesNotMatch(enSkeleton, han);
  assert.match(enSkeleton, /inbox/i);

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
