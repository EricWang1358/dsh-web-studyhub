import test from 'node:test';
import assert from 'node:assert/strict';
import { createNavigator } from '../ui/app/navigator.js';

// UI wave 2 · WP-F (#109): navigatePage, switchPage and showPage became one navigate(id, options).

function fixture({ page = 'library', delay = 0 } = {}) {
  const log = [], timers = [];
  const state = { page, trail: ['old'] };
  const leaveTimer = { current: 0 };
  const ctxOf = (id) => ({ id, resetExam: () => log.push('resetExam'), openBoardFresh: () => log.push('openBoardFresh'), clearNote: () => log.push('clearNote'), clearGraphScope: () => log.push('clearGraphScope') });
  const navigator = createNavigator({
    getPage: () => state.page,
    setPage: (id) => { state.page = id; log.push(['page', id]); },
    setPageTarget: (id) => log.push(['target', id]),
    bumpNavigation: () => log.push('bump'),
    leaveTimer,
    clearTimer: () => log.push('clearTimer'),
    setTimer: (work, ms) => { timers.push({ work, ms }); return timers.length; },
    leaveDelay: () => delay,
    clearTrail: () => { state.trail = []; log.push('clearTrail'); },
    setError: (value) => log.push(['error', value]),
    scrollTop: () => log.push('scrollTop'),
    enterContext: ctxOf,
  });
  return { navigator, log, timers, state, leaveTimer };
}

test('a plain navigate takes ownership at once and keeps the context trail', () => {
  const { navigator, log, state } = fixture();
  navigator.navigate('sources');
  assert.deepEqual(log, ['bump', 'clearTimer', ['target', null], ['page', 'sources']]);
  assert.deepEqual(state.trail, ['old'], 'a link keeps the way back');
});

test('the sidebar navigation clears the trail, resets what the page resets, and clears the old error', () => {
  const { navigator, log, state } = fixture();
  navigator.navigate('exam', { animate: true, keepTrail: false, enter: 'user' });
  assert.deepEqual(state.trail, []);
  assert.deepEqual(log, ['bump', 'clearTimer', 'clearTrail', ['error', ''], 'resetExam', ['target', null], ['page', 'exam']]);
});

test('with the leave animation the page lifts away first and the new one settles in after the delay', () => {
  const { navigator, log, timers, leaveTimer } = fixture({ delay: 140 });
  navigator.navigate('board', { animate: true, keepTrail: false, enter: 'user' });
  assert.deepEqual(log, ['bump', 'clearTimer', 'clearTrail', ['target', 'board']], 'nothing is reset before the old page has left');
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 140);
  assert.equal(leaveTimer.current, 1, 'the timer is kept where the library reset can clear it');
  timers[0].work();
  assert.deepEqual(log.slice(4), [['error', ''], 'openBoardFresh', ['target', null], ['page', 'board']]);
});

test('selecting the page you are on does not wait for the animation', () => {
  const { navigator, log, timers } = fixture({ page: 'exam', delay: 140 });
  navigator.navigate('exam', { animate: true, keepTrail: false, enter: 'user' });
  assert.equal(timers.length, 0);
  assert.deepEqual(log.at(-1), ['page', 'exam']);
});

test('the tour switches at once: trail cleared, only the exam reset, back to the top of the page', () => {
  const { navigator, log } = fixture({ delay: 140 });
  navigator.navigate('board', { keepTrail: false, enter: 'tour', scroll: true });
  assert.deepEqual(log, ['bump', 'clearTimer', 'clearTrail', ['target', null], ['page', 'board'], 'scrollTop']);
  const exam = fixture();
  exam.navigator.navigate('exam', { keepTrail: false, enter: 'tour', scroll: true });
  assert.ok(exam.log.includes('resetExam'));
  assert.equal(exam.log.at(-1), 'scrollTop');
});

test('a pending leave animation is cancelled by the next navigation', () => {
  const { navigator, log } = fixture({ delay: 140 });
  navigator.navigate('board', { animate: true });
  navigator.navigate('library');
  assert.equal(log.filter((entry) => entry === 'clearTimer').length, 2);
  assert.deepEqual(log.at(-1), ['page', 'library']);
});

test('an unknown page navigates without trying to reset anything', () => {
  const { navigator, log } = fixture();
  assert.doesNotThrow(() => navigator.navigate('mystery', { enter: 'user' }));
  assert.deepEqual(log.at(-1), ['page', 'mystery']);
});
