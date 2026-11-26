/* 「章节准备度」 in the 「你的定制」 card (深度定制 S5): the words and numbers of a chapter's row and of the 补齐 question are pure (ui/custom-readiness-model.js), in zh and in
   English; the card carries the list and nothing else carries it. The picture is tests/custom-readiness-browser.test.mjs. No model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUi } from './helpers/ui-module.mjs';
import { click, loadInteractiveUi, withBrowserGlobals } from './helpers/react-harness.mjs';

const m = await loadUi(`
  export * as model from './ui/custom-readiness-model.js';
  export { setUiLanguage } from './ui/i18n.js';
`);
const said = (language, work) => { m.setUiLanguage(language); try { return work(m.model); } finally { m.setUiLanguage('zh'); } };
const counted = { explained: true, questions: true };
const chapter = (over = {}) => ({ id: 'c1', title: 'Introduction', built: true, points: 4, explained: 4, asked: 3, drafted: 0, practised: 2, solid: 1, weak: 1, readiness: 0.25,
  quality: { sentBack: 0 }, todo: { explain: 0, questions: 1, weak: 1 }, ...over });

test('the bar is the readiness; with no questions in the plan it is how much is explained; 未生成 only when the plan asks for explanations', () => {
  assert.equal(m.model.chapterShare(chapter(), counted), 0.25);
  assert.equal(m.model.shareText(chapter(), counted), '25%');
  assert.equal(m.model.chapterShare(chapter({ readiness: null, explained: 1 }), { explained: true, questions: false }), 0.25);
  assert.equal(m.model.chapterShare(chapter({ readiness: null, points: 0, explained: 0 }), { explained: true, questions: false }), 0, 'no point, no division by zero');
  assert.equal(m.model.isUnbuilt(chapter({ built: false }), counted), true);
  assert.equal(m.model.isUnbuilt(chapter({ built: false }), { explained: false, questions: true }), false, 'the plan did not ask for a book');
  assert.equal(m.model.isUnbuilt(chapter(), counted), false);
});

test('the four counts are said in the words of the app, only the parts the plan ticked', () => {
  assert.equal(said('zh', model => model.countsLine(chapter(), counted)), '讲解 4/4 · 有题 3/4 · 练过 2/4 · 扎实 1/4');
  assert.equal(said('zh', model => model.countsLine(chapter(), { explained: false, questions: true })), '有题 3/4 · 练过 2/4 · 扎实 1/4');
  assert.equal(said('zh', model => model.countsLine(chapter(), { explained: true, questions: false })), '讲解 4/4');
  assert.equal(said('en', model => model.countsLine(chapter(), counted)), 'Explained 4/4 · With questions 3/4 · Practised 2/4 · Solid 1/4');
  assert.equal(said('zh', model => model.qualityLine(chapter({ quality: { sentBack: 2 } }))), '有 2 道题被审核退回，等着修');
  assert.equal(said('zh', model => model.qualityLine(chapter())), '');
  assert.match(said('en', model => model.solidMeaning()), /^Solid: at least half/);
});

test('补齐 is offered only where something is missing, and the question says what it would start and the rough calls, never a price', () => {
  assert.equal(m.model.hasTodo(chapter()), true);
  assert.equal(m.model.hasTodo(chapter({ todo: { explain: 0, questions: 0, weak: 0 } })), false);
  const answer = { status: 'ok', book: { points: 1 }, questions: { points: 3 }, variants: { cards: 1 }, calls: { low: 9, high: 23 } };
  assert.equal(said('zh', model => model.fillParts(answer)), '讲解 1 个知识点、出题 3 个知识点、变式 1 道错题');
  assert.equal(said('zh', model => model.fillCalls(answer)), '粗估约 9–23 次模型调用');
  assert.equal(said('zh', model => model.fillCalls({ calls: { low: 1, high: 1 } })), '粗估约 1 次模型调用');
  assert.equal(said('zh', model => model.fillParts({ questions: { points: 3 } })), '出题 3 个知识点');
  assert.match(said('zh', model => model.fillCalls({ calls: null })), /没法估/);
  assert.equal(said('en', model => model.fillParts(answer)), 'explain 1 points, write questions for 3 points, prepare variants for 1 wrong questions');
  assert.equal(said('en', model => model.fillCalls(answer)), 'Roughly 9–23 model calls');
  assert.doesNotMatch(said('zh', model => `${model.fillParts(answer)} ${model.fillCalls(answer)}`), /价|费|元|\$|¥/);
});

test('what is said after 补齐 started: a refused step first, the consent the coach asks for, that it is already running, else that it started', () => {
  assert.deepEqual(m.model.startedNotice({ started: { book: { jobId: 'b' }, questions: { error: 'No model' } } }), { text: 'No model', tone: 'error' });
  assert.equal(m.model.startedNotice({ started: { variants: { needsConsent: true } } }).tone, 'warning');
  assert.match(m.model.startedNotice({ started: { questions: { jobId: 'q' }, variants: { needsConsent: true } } }).text, /其余的已经开始/);
  assert.match(m.model.startedNotice({ started: { questions: { alreadyRunning: true } } }).text, /已经在补了/);
  assert.match(m.model.startedNotice({ started: { questions: { jobId: 'q' } } }).text, /已开始补齐/);
  assert.equal(said('en', model => model.startedNotice({ started: { questions: { jobId: 'q' } } }).text), 'Started; follow it in Jobs.');
});

test('the list lives in the 「你的定制」 card only, uses Tooltips instead of title attributes, exposes data-tour="custom-readiness", and estimates before starting 补齐', async () => {
  await withBrowserGlobals(async () => {
    const ui = await loadInteractiveUi(`
      export { default as CourseSettings } from './ui/CourseSettings.jsx';
      export { default as CustomPlanCard } from './ui/CustomPlanCard.jsx';
      export { default as CustomReadiness } from './ui/CustomReadiness.jsx';
      export { StudyServicesContext } from './ui/study-context.jsx';
      export { ToastContext, Tooltip, createToastApi } from './ui/components/index.js';
      export { setUiLanguage } from './ui/i18n.js';
    `);
    const { CourseSettings, CustomPlanCard, StudyServicesContext, ToastContext, Tooltip, createToastApi, setUiLanguage } = ui.exports;
    setUiLanguage('zh');
    const h = ui.React.createElement;

    const plainCourse = { id: 'course-plain', name: 'Algorithms' };
    const customCourse = {
      id: 'course-custom',
      name: 'Software Architecture',
      custom: {
        version: 1,
        purpose: 'review',
        scope: { kind: 'all' },
        book: { make: true, coverage: 'standard', parts: ['explain'] },
        questions: { make: true, kinds: ['quiz'], strength: 'standard', variants: false },
        plan: { make: false, by: 'exam' },
        sampleFirst: false,
        updatedAt: '2026-10-09T00:00:00.000Z',
      },
    };
    const readinessReply = {
      status: 'ok',
      basis: 'outline',
      counted,
      chapters: [
        chapter({ id: 'c1', title: 'Introduction', todo: { explain: 0, questions: 1, weak: 0 } }),
        chapter({ id: 'c2', title: 'Architecture', todo: { explain: 1, questions: 0, weak: 0 } }),
      ],
    };
    const fillEstimateReply = { status: 'ok', questions: { points: 1 }, calls: { low: 2, high: 4 } };

    const makeServices = () => {
      const calls = [];
      const acts = [];
      const notices = [];
      const services = {
        call: async (action, args) => {
          calls.push([action, args]);
          if (action === 'course.custom.readiness') return readinessReply;
          if (action === 'course.custom.fill') return fillEstimateReply;
          if (action === 'course.custom.preview') return { estimate: null };
          if (action === 'generate.weakTopics') return { topics: [] };
          return {};
        },
        act: async (action, args, after) => {
          acts.push([action, args]);
          const result = { started: { questions: { jobId: 'job-1' } } };
          after?.(result);
          return result;
        },
        busy: false,
        notify: (notice) => { notices.push(notice); },
        askInChat: async () => 'filled',
        host: { capabilities: { chat: true } },
        openSettings: () => {},
        navigate: () => {},
        openModal: () => {},
      };
      return { services, calls, acts, notices };
    };
    const wrap = (services, child) => h(
      StudyServicesContext.Provider,
      { value: services },
      h(ToastContext.Provider, { value: createToastApi(services.notify) }, child),
    );

    // 1. CourseSettings does NOT render CustomReadiness directly when the course has no custom plan.
    const plainEnv = makeServices();
    const plainMounted = ui.mount(() => wrap(plainEnv.services, h(CourseSettings, {
      data: { courses: [plainCourse], sources: [], focus: {} },
      courseId: plainCourse.id,
      onClose: () => {},
    })));
    try {
      await plainMounted.flush(5);
      assert.equal(plainMounted.find(node => node.props?.['data-tour'] === 'custom-readiness'), null, 'CourseSettings without a custom plan renders no readiness list');
      assert.equal(plainEnv.calls.some(([action]) => action === 'course.custom.readiness'), false, 'no readiness request is made without CustomPlanCard');
    } finally {
      plainMounted.unmount();
    }

    // 2. CourseSettings wires CustomPlanCard, which renders CustomReadiness with data-tour="custom-readiness", Tooltips (zero title attrs), and estimate-first 补齐.
    const customEnv = makeServices();
    const customMounted = ui.mount(() => wrap(customEnv.services, h(CourseSettings, {
      data: { courses: [customCourse], sources: [], focus: {} },
      courseId: customCourse.id,
      onClose: () => {},
    })));
    try {
      await customMounted.flush(6);
      const cardNode = customMounted.find(node => node.type === CustomPlanCard);
      assert.ok(cardNode, 'CourseSettings renders CustomPlanCard for a customized course');
      const readinessNodes = customMounted.findAll(node => node.props?.['data-tour'] === 'custom-readiness');
      assert.equal(readinessNodes.length, 1, 'exactly one data-tour="custom-readiness" container is rendered');
      const readinessRoot = readinessNodes[0];
      assert.ok(customMounted.find(node => node === readinessRoot, cardNode), 'the readiness list lives inside CustomPlanCard');

      const hostWithTitle = customMounted.findAll(node => typeof node.type === 'string' && typeof node.props?.title === 'string' && node.props.title.length > 0, readinessRoot);
      assert.deepEqual(hostWithTitle, [], 'hover words use Tooltips, never native title attributes');
      const tooltips = customMounted.findAll(node => node.type === Tooltip, readinessRoot);
      assert.equal(tooltips.length, 2, 'each chapter meter renders a Tooltip');

      // Clicking a single chapter's 补齐 button requests an estimate without starting a job.
      const chapterFillButtons = customMounted.findAll(
        node => node.type === 'button' && ui.textOf(node).trim() === '补齐',
        readinessRoot,
      );
      assert.equal(chapterFillButtons.length, 2);
      await customMounted.act(() => click(chapterFillButtons[0]));
      await customMounted.flush(4);
      const singleFillCalls = customEnv.calls.filter(([action]) => action === 'course.custom.fill');
      assert.deepEqual(singleFillCalls, [['course.custom.fill', { course: customCourse.name, chapters: ['c1'], estimate: true }]]);
      assert.deepEqual(customEnv.acts, [], 'estimating starts nothing');
      assert.match(ui.textOf(customMounted.tree), /粗估约 2–4 次模型调用/);

      // Cancel single-chapter prompt, then click 全部补齐 and confirm 开始补齐.
      const cancelBtn = customMounted.find(node => node.type === 'button' && ui.textOf(node).trim() === '取消', customMounted.find(node => node.props?.['data-tour'] === 'custom-readiness'));
      assert.ok(cancelBtn, 'InlineConfirm renders a cancel button');
      await customMounted.act(() => click(cancelBtn));

      const fillAllBtn = customMounted.find(
        node => node.type === 'button' && ui.textOf(node).trim() === '全部补齐',
        customMounted.find(node => node.props?.['data-tour'] === 'custom-readiness'),
      );
      assert.ok(fillAllBtn, '全部补齐 button is shown when multiple chapters have todos');
      await customMounted.act(() => click(fillAllBtn));
      await customMounted.flush(4);
      const allFillCalls = customEnv.calls.filter(([action]) => action === 'course.custom.fill');
      assert.deepEqual(allFillCalls.at(-1), ['course.custom.fill', { course: customCourse.name, estimate: true }]);
      assert.deepEqual(customEnv.acts, [], '全部补齐 estimate also starts nothing');

      const confirmBtn = customMounted.find(
        node => node.type === 'button' && ui.textOf(node).trim() === '开始补齐',
        customMounted.find(node => node.props?.['data-tour'] === 'custom-readiness'),
      );
      assert.ok(confirmBtn, 'InlineConfirm renders 开始补齐');
      await customMounted.act(() => click(confirmBtn));
      await customMounted.flush(4);
      assert.deepEqual(customEnv.acts, [['course.custom.fill', { course: customCourse.name }]]);
    } finally {
      customMounted.unmount();
    }
  });
});
