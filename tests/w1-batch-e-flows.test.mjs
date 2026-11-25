import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

const h = React.createElement;
const noop = () => {};

const m = await loadUi(`
  export { setUiLanguage } from './ui/i18n.js';
  export { default as MergeSuggestions, afterMergeConfirmed } from './ui/study-map/MergeSuggestions.jsx';
  export { notificationPermissionState, timerMinutesError } from './ui/board/TodayTimer.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
`);

const withServices = (node, services = {}) => h(m.StudyServicesContext.Provider, {
  value: {
    call: async () => ({}),
    act: async () => undefined,
    busy: false,
    notify: noop,
    askInChat: noop,
    host: {},
    openSettings: noop,
    navigate: noop,
    openModal: noop,
    ...services,
  },
}, node);

/* ---------- W1-02: ImportHub preserves 查看已导入的内容 after dropping failed items ---------- */

test('W1-02: ImportHub keeps summary and 查看已导入的内容 when failed drops to 0 with finished > 0', async () => {
  const src = await readFile(new URL('../ui/ImportHub.jsx', import.meta.url), 'utf8');
  assert.match(src, /!running && \(failed > 0 \|\| finished > 0\)/, 'renders summary bar whenever finished > 0 even after failed hits 0');
  assert.match(src, /tone=\{failed > 0 \? 'warning' : 'success'\}/, 'switches to success tone once all failures are dropped');
  assert.match(src, /查看已导入的内容/, 'retains action button calling onComplete');
});

/* ---------- W1-07: CourseSettings -> CustomPlanCard -> CustomReadiness closes modal, switches course, keeps book target ---------- */

test('W1-07: CustomReadiness receives data & onClose, reads snapshotData ?? app?.data, switches course and closes dialog', async () => {
  const csSrc = await readFile(new URL('../ui/CourseSettings.jsx', import.meta.url), 'utf8');
  assert.match(csSrc, /<CustomPlanCard course=\{course\} data=\{data\} onClose=\{onClose\} \/>/, 'CourseSettings passes data and onClose to CustomPlanCard');
  const cardSrc = await readFile(new URL('../ui/CustomPlanCard.jsx', import.meta.url), 'utf8');
  assert.match(cardSrc, /<CustomReadiness course=\{course\} data=\{data\} onClose=\{onClose\} \/>/, 'CustomPlanCard forwards data and onClose to CustomReadiness');
  const readSrc = await readFile(new URL('../ui/CustomReadiness.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(readSrc, /app\?\.core\?\.data/, 'must not read nonexistent app.core.data');
  assert.match(readSrc, /snapshotData \?\? app\?\.data/, 'reads real app data snapshot');
  assert.match(readSrc, /onClose\?\.\('custom-readiness'\)/, 'closes CourseSettings dialog when jumping to gap target');
  assert.match(readSrc, /lock=\{locked\}/, 'locks gap jump button against double clicks');
});

/* ---------- W1-18: CourseCompanionsBar clears hidden filter on course switch or <= 6 companions ---------- */

test('W1-18: CourseCompanionsBar resets filter on course change and disables/clears filters when companions <= 6', async () => {
  const src = await readFile(new URL('../ui/companions/CourseCompanionsBar.jsx', import.meta.url), 'utf8');
  assert.match(src, /prevCourseRef\.current === course/, 'resets filter and expand state when course changes in place');
  assert.match(src, /toolbarShown = companions\.length > 6/, 'ties filter visibility to threshold');
  assert.match(src, /effectiveQuery = toolbarShown \? query : ''/, 'never hides companions behind an invisible filter');
  assert.match(src, /effectiveStatus = toolbarShown \? statusFilter : 'all'/, 'never applies invisible status filter');
});

/* ---------- W1-25: Sources organize error close does not destroy proposals; stop button shows busy/cancelling ---------- */

test('W1-25: Sources decouples organize error close from dismissOrganizeProposals and locks/shows busy on stop', async () => {
  const src = await readFile(new URL('../ui/Sources.jsx', import.meta.url), 'utf8');
  assert.match(src, /onClick=\{\(\) => setOrganizeError\(''\)\}>\{ui\('关闭'\)\}/, 'error banner close button only clears organizeError');
  assert.match(src, /data-discard-organize onClick=\{dismissOrganizeProposals\}/, 'discard proposals remains explicit');
  assert.match(src, /organizeStopping \|\| organizeCancelling/, 'stop button reflects stopping and cancelling states');
  assert.match(src, /busyLabel=\{ui\('正在停止…'\)\}/, 'stop button shows stopping label');
});

/* ---------- W1-30: MergeSuggestions handles last-proposal close, mid-flight close, dismissable error, and course switch ---------- */

test('W1-30: afterMergeConfirmed closes cleanly on last item and null mid-flight; MergeSuggestions has dismissable error and uncategorized fallback', async () => {
  m.setUiLanguage('zh');
  assert.equal(m.afterMergeConfirmed(null, 'd1'), null, 'does not throw when panel was closed mid-flight');
  assert.equal(
    m.afterMergeConfirmed({ course: 'OS', proposals: [{ targetId: 'd1' }] }, 'd1'),
    null,
    'closes panel cleanly after merging the last proposal instead of showing no-suggestions message',
  );
  const kept = m.afterMergeConfirmed({ course: 'OS', proposals: [{ targetId: 'd1' }, { targetId: 'd2' }] }, 'd1');
  assert.deepEqual(kept.proposals.map((p) => p.targetId), ['d2']);

  const html = renderToStaticMarkup(withServices(h(m.MergeSuggestions, {
    merge: {
      suggestions: { course: '', proposals: [] },
      error: '合并失败',
      busy: false,
      clearError: noop,
      close: noop,
      confirm: noop,
    },
  })));
  assert.match(html, /未分类课程 · 合并建议/, 'falls back to 未分类课程 when course is empty');
  assert.match(html, /合并失败/, 'renders error message');
  assert.match(html, /sh-msg__close|关闭/, 'renders dismiss button on error banner');

  const mapSrc = await readFile(new URL('../ui/StudyMap.jsx', import.meta.url), 'utf8');
  assert.match(mapSrc, /已合并 \{0\} 道题，全部保留/, 'shows success toast after deck.merge');
  assert.match(mapSrc, /useMergeSuggestions\(\{ suggestMerges, mergeDecks, course: data\.focus\?\.course, root: data\.root \}\)/, 'passes root and course for reset');
});

/* ---------- W1-05: TodayTimer guards denied/unsupported Notification and reports numeric validation errors ---------- */

test('W1-05: TodayTimer detects notification permission state and reports integer range errors', async () => {
  m.setUiLanguage('zh');
  assert.equal(m.timerMinutesError('25', 180), '');
  assert.equal(m.timerMinutesError('', 240), '');
  assert.match(m.timerMinutesError('300', 240), /1–240/);
  assert.match(m.timerMinutesError('12.5', 240), /1–240/);
  assert.match(m.timerMinutesError('0', 60), /1–60/);

  const prevNotification = globalThis.Notification;
  try {
    delete globalThis.Notification;
    assert.equal(m.notificationPermissionState(), 'unsupported');
    globalThis.Notification = Object.assign(function Notification() {}, { permission: 'denied' });
    assert.equal(m.notificationPermissionState(), 'denied');
  } finally {
    if (prevNotification === undefined) delete globalThis.Notification;
    else globalThis.Notification = prevNotification;
  }

  const timerSrc = await readFile(new URL('../ui/board/TodayTimer.jsx', import.meta.url), 'utf8');
  assert.match(timerSrc, /disabled=\{notifyBlocked && !notifyDraft\}/, 'prevents enabling system notifications when denied or unsupported');
  assert.match(timerSrc, /inputMode="numeric"/, 'sets numeric inputMode on duration fields');
});
