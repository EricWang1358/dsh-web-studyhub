import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudyService } from '../lib/service.js';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { seed } from './helpers/coach-library.mjs';
import { loadUi } from './helpers/ui-module.mjs';
import { withStudy } from './helpers/study-services.mjs';
import { until } from './helpers/wait.mjs';

const m = await loadUi(`
  export { WrongBookView } from './ui/WrongBook.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';
  export * as wbModel from './ui/wrongbook-model.js';
`);
const { WrongBookView, setUiLanguage, wbModel } = m;
const { rescueCall, rescueGate, rescueNote } = wbModel;

const noop = () => {};
const han = /\p{Script=Han}/u;
const decks = [{ id: 'd4', course: 'PE', title: 'Platform Engineering｜期末综合卷04｜90题' }];
const row = (cardId, leech = true) => ({
  deckId: 'd4', deckTitle: decks[0].title, cardId, topic: `Topic ${cardId}`, prompt: `Question ${cardId}?`,
  assessment: 'graded', lastGrade: 1, lastAt: '2026-10-01T10:00:00Z', kind: 'quiz', leech,
});
const detail = { c1: { deckId: 'd4', cardId: 'c1', correctAnswer: 'A', explanation: 'Because A.', yourAnswer: 'B', missedAt: '2026-10-01T10:00:00Z' } };
const baseCoach = { enabled: true, consent: true, ready: 0, preparing: false, preparingCards: [], readyCards: [], failedCards: [], tasks: [] };
const countsOf = (items) => ({ total: items.length, graded: items.length, self: 0, oral: 0, rubric: 0 });
const base = {
  data: { root: 'r', decks, focus: { course: 'PE', courses: [{ name: 'PE' }] }, model: { ready: true }, settings: {} },
  course: 'PE', onCourse: noop, loading: false, err: '', page: 0, pageSize: 100, hasMore: false,
  onReload: noop, onPage: noop, recs: null, coach: baseCoach, details: detail, onLoadDetail: noop,
  onPractice: noop, onPracticePrepared: noop, onGenerate: async () => ({}),
  onOpenSettings: noop, onSettings: noop, onRescue: noop,
};
const render = (items, extra = {}) => renderToStaticMarkup(
  withStudy(m.StudyServicesContext, React.createElement(WrongBookView, { ...base, items, counts: countsOf(items), ...extra }), {}),
);
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

async function makeTempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-wb-rescue-'));
  t.after(async () => { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return root;
}

test('coach.feedback 10-minute dedupe: unconsented too-hard tap followed by consent within 10 minutes schedules prep once, then dedupes', async (t) => {
  const root = await makeTempRoot(t);
  const log = [];
  const model = createFakeModel({ latencyMs: 0, log });
  const service = new StudyService(root, { complete: model, completeLight: model, coach: true });
  t.after(() => service.dispose());
  await seed((action, args) => service.call(action, args));

  const ref = { deckId: 'd', cardId: 'q1' };
  const first = await service.call('coach.feedback', { ...ref, vote: 'down', tags: ['too-hard'] });
  assert.deepEqual([first.tags, first.scheduled], [['too-hard'], []], 'without consent, feedback is recorded but prep is not scheduled');

  await service.call('coach.consent', { prep: true });

  const second = await service.call('coach.feedback', { ...ref, vote: 'down', tags: ['too-hard'] });
  assert.deepEqual(second.scheduled, ['prep'], 'clicking again within 10 minutes after enabling consent schedules prep');
  assert.deepEqual(second.tags, [], 'tag is not duplicated on the feedback entry');

  const third = await service.call('coach.feedback', { ...ref, vote: 'down', tags: ['too-hard'] });
  assert.deepEqual([third.tags, third.scheduled], [[], []], 'a third tap within 10 minutes dedupes once prep was scheduled');

  const prepared = await service.call('coach.prepare');
  assert.equal(prepared.ready, 1, 'exactly one prerequisite card was prepared');
  const exported = await service.call('export');
  assert.equal(exported.feedback.length, 1);
  assert.deepEqual(exported.feedback[0].tags, ['too-hard']);
  assert.equal(exported.learner.signals.down, 1);
  assert.equal(exported.learner.signals.hard, 1);
});

test('coach.feedback 10-minute dedupe: unscheduled tap without a model allows rewrite and inline-consented prep once a model is configured, then dedupes', async (t) => {
  const root = await makeTempRoot(t);
  const withoutModel = new StudyService(root);
  await seed((action, args) => withoutModel.call(action, args));

  const fixFirst = await withoutModel.call('coach.feedback', { deckId: 'd', cardId: 'q1', vote: 'down', tags: ['general-quality'] });
  assert.deepEqual([fixFirst.tags, fixFirst.scheduled], [['general-quality'], []]);
  const prepFirst = await withoutModel.call('coach.feedback', { deckId: 'd', cardId: 'q2', vote: 'down', tags: ['too-hard'] });
  assert.deepEqual([prepFirst.tags, prepFirst.scheduled], [['too-hard'], []]);
  withoutModel.dispose();

  const model = createFakeModel({ latencyMs: 0, log: [] });
  const withModel = new StudyService(root, { complete: model, completeLight: model, coach: true });
  t.after(() => withModel.dispose());

  const fixSecond = await withModel.call('coach.feedback', { deckId: 'd', cardId: 'q1', vote: 'down', tags: ['general-quality'] });
  assert.deepEqual([fixSecond.tags, fixSecond.scheduled], [[], ['rewrite']], 'rewrite schedules immediately once a model is available');
  const fixThird = await withModel.call('coach.feedback', { deckId: 'd', cardId: 'q1', vote: 'down', tags: ['general-quality'] });
  assert.deepEqual([fixThird.tags, fixThird.scheduled], [[], []], 'third tap within 10 minutes dedupes');

  const prepSecond = await withModel.call('coach.feedback', { deckId: 'd', cardId: 'q2', vote: 'down', tags: ['too-hard'], consent: true });
  assert.deepEqual([prepSecond.tags, prepSecond.scheduled], [[], ['prep']], 'inline consent: true enables prep and schedules previously unscheduled too-hard tag');
  assert.equal(prepSecond.status.consent, true);
  const prepThird = await withModel.call('coach.feedback', { deckId: 'd', cardId: 'q2', vote: 'down', tags: ['too-hard'] });
  assert.deepEqual([prepThird.tags, prepThird.scheduled], [[], []], 'subsequent tap dedupes');

  await withModel.call('coach.prepare');
  await until(async () => (await withModel.call('coach.status')).tasks.every((task) => task.status !== 'running'), 'background tasks to finish');
  const exported = await withModel.call('export');
  assert.equal(exported.learner.consent.prep, true);
  assert.equal(exported.prepared.filter((p) => p.originCardId === 'q2' && p.reason === 'too-hard').length, 1);
});

test('rescueGate, rescueCall and rescueNote: inline consent, model-setup gating, and #950/#955 card-first fix wording', () => {
  setUiLanguage('zh');
  assert.equal(rescueGate('easier', { modelReady: false, consent: false }).type, 'no-model');
  assert.equal(rescueGate('fix', { modelReady: false, consent: true }).type, 'no-model');
  assert.equal(rescueGate('easier', { modelReady: true, consent: false }).type, 'consent');
  assert.equal(rescueGate('easier', { modelReady: true, consent: true }).type, 'run');
  assert.equal(rescueGate('fix', { modelReady: true, consent: false }).type, 'run');
  assert.equal(rescueGate('pause', { modelReady: false, consent: false }).type, 'run');

  const ref = { deckId: 'd4', cardId: 'c1' };
  assert.deepEqual(rescueCall('easier', ref), { action: 'coach.feedback', args: { ...ref, vote: 'down', tags: ['too-hard'] } });
  assert.deepEqual(rescueCall('easier', ref, { consent: true, flush: true }),
    { action: 'coach.feedback', args: { ...ref, vote: 'down', tags: ['too-hard'], consent: true, flush: true } });

  const fixNote = rescueNote('fix', { tags: ['general-quality'], scheduled: ['rewrite'] });
  assert.equal(fixNote.tone, 'success');
  assert.ok(fixNote.text.includes('直接改这张卡'), 'states that this card is edited in place');
  assert.ok(fixNote.text.includes('完成时信箱会提醒你'), 'mentions Inbox reminder');
  assert.ok(fixNote.text.includes('在信箱里可以一步撤销'), 'mentions one-step undo in Inbox');
  assert.ok(fixNote.text.indexOf('直接改这张卡') < fixNote.text.indexOf('完成时信箱会提醒你'), 'where the edit lands comes before Inbox');

  // Second attempt within 10 minutes (tags: [] because already recorded, scheduled: ['prep'] or ['rewrite']) still reports success.
  assert.equal(rescueNote('easier', { tags: [], scheduled: ['prep'] }).tone, 'success');
  assert.equal(rescueNote('fix', { tags: [], scheduled: ['rewrite'] }).tone, 'success');
});

test('WrongBookView rescue UI: inline consent for easier, inline 打开模型设置 when unconfigured, and English translations', () => {
  setUiLanguage('zh');
  const defaultOpen = render([row('c1')], { initial: { expanded: ['c1'] } });
  const defaultText = text(defaultOpen);
  assert.ok(defaultText.indexOf('直接改这张卡') < defaultText.indexOf('完成时信箱会提醒你'), 'fix tooltip states 直接改这张卡 before Inbox');

  const consentHtml = render([row('c1')], {
    coach: { ...baseCoach, consent: null },
    initial: { expanded: ['c1'], rescuePrompt: { cardId: 'c1', type: 'consent', kind: 'easier' } },
  });
  const consentText = text(consentHtml);
  assert.match(consentText, /为你定制/, 'states that the prerequisite card goes into 为你定制');
  assert.match(consentText, /设置里开启后台准备/, 'states that background preparation is turned on in settings');
  assert.match(consentText, /同意并生成/);
  assert.match(consentText, /取消/);
  assert.match(consentText, /前往设置/);

  const consentWithoutSettings = text(render([row('c1')], {
    onSettings: undefined,
    coach: { ...baseCoach, consent: null },
    initial: { expanded: ['c1'], rescuePrompt: { cardId: 'c1', type: 'consent', kind: 'easier' } },
  }));
  assert.doesNotMatch(consentWithoutSettings, /前往设置/, 'does not render a dead settings link when onSettings is absent');

  // Auto-clears consent prompt once coach.consent is true
  const clearedConsent = text(render([row('c1')], {
    coach: { ...baseCoach, consent: true },
    initial: { expanded: ['c1'], rescuePrompt: { cardId: 'c1', type: 'consent', kind: 'easier' } },
  }));
  assert.doesNotMatch(clearedConsent, /同意并生成/);

  for (const kind of ['easier', 'fix']) {
    const noModelHtml = render([row('c1')], {
      data: { ...base.data, model: { ready: false } },
      coach: { ...baseCoach, enabled: false, consent: null },
      initial: { expanded: ['c1'], rescuePrompt: { cardId: 'c1', type: 'no-model', kind } },
    });
    const noModelText = text(noModelHtml);
    assert.match(noModelText, /打开模型设置/, `${kind}: offers inline 打开模型设置 button`);
    assert.match(noModelText, /还没有可用的 AI 模型/, `${kind}: states why it cannot run yet`);
  }

  // Auto-clears no-model prompt once model is ready
  const clearedNoModel = render([row('c1')], {
    initial: { expanded: ['c1'], rescuePrompt: { cardId: 'c1', type: 'no-model', kind: 'fix' } },
  });
  assert.doesNotMatch(text(clearedNoModel), /打开模型设置/);

  setUiLanguage('en');
  try {
    const enDecks = [{ id: 'd4', course: 'PE', title: 'Final 04' }];
    const enItems = [{ ...row('c1'), deckTitle: 'Final 04' }];
    const enConsent = render(enItems, {
      data: { ...base.data, decks: enDecks },
      coach: { ...baseCoach, consent: null },
      initial: { expanded: ['c1'], rescuePrompt: { cardId: 'c1', type: 'consent', kind: 'easier' } },
    });
    assert.doesNotMatch(text(enConsent), han, 'English inline consent has no Chinese');
    assert.match(text(enConsent), /Agree and generate/);
    assert.match(text(enConsent), /Cancel/);
    assert.match(text(enConsent), /Personalised/);

    for (const kind of ['easier', 'fix']) {
      const enNoModel = render(enItems, {
        data: { ...base.data, decks: enDecks, model: { ready: false } },
        coach: { ...baseCoach, enabled: false, consent: null },
        initial: { expanded: ['c1'], rescuePrompt: { cardId: 'c1', type: 'no-model', kind } },
      });
      assert.doesNotMatch(text(enNoModel), han, `English no-model (${kind}) has no Chinese`);
      assert.match(text(enNoModel), /Open model settings/);
    }
  } finally {
    setUiLanguage('zh');
  }
});
