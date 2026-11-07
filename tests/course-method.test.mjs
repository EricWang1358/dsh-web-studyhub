import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';
import { CLASSROOM_METHOD, METHOD_VERSION, courseMethod, checkedMethod } from '../lib/course-method.js';

/* 学法 (#775, 4.5 S1): every course has one, the default package 「课堂跟学」 until it is changed — and that package is today's behaviour said in stages, so a
   course nobody customised learns exactly as before. The record lives on the course (course.save {method}), copied there when it is attached. */

const stage = (over = {}) => ({ name: '按批练', activity: 'practice', alternatives: ['explain'], level: 'medium', ...over });

async function library(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-method-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root, { coverage: { roundLimit: 8 } });
  t.after(() => service.dispose());
  return service;
}

test('the default package is today\'s flow in three stages, and a course without one gets it', () => {
  assert.equal(CLASSROOM_METHOD.version, METHOD_VERSION);
  assert.equal(CLASSROOM_METHOD.stages.length, 3);
  assert.deepEqual(CLASSROOM_METHOD.stages.map(entry => entry.activity), ['publish', 'practice', 'review']);
  assert.equal(courseMethod({ name: 'Net' }).name, '课堂跟学');
  assert.deepEqual(courseMethod(null).stages.map(entry => entry.activity), ['publish', 'practice', 'review']);
  const mine = { ...CLASSROOM_METHOD, name: '我的学法' };
  assert.equal(courseMethod({ method: mine }).name, '我的学法', 'a course that has one gets its own');
  const copy = courseMethod({ method: mine });
  copy.stages[0].name = '改了';
  assert.equal(mine.stages[0].name, '课前：导入资料', 'the copy is not the record');
  // The names are what the card and the home line show: short, and no batch sizes that the practice settings own.
  for (const entry of CLASSROOM_METHOD.stages) assert.ok(entry.name.length <= 12 && !/\d/.test(entry.name), entry.name);
});

test('a method is checked before it is stored: the sentences the chat reads out, and what null and undefined mean', () => {
  assert.equal(checkedMethod(undefined), undefined, 'not given: leave what is there');
  assert.equal(checkedMethod(null), null, 'null detaches it');
  const one = checkedMethod({ name: '期末冲刺', targetDate: '2027-01-20', stages: [stage()] });
  assert.equal(one.version, METHOD_VERSION);
  assert.equal(one.targetDate, '2027-01-20');
  assert.deepEqual(one.stages[0].alternatives, ['explain']);
  const why = fn => { try { fn(); return ''; } catch (error) { return String(error.message); } };
  assert.match(why(() => checkedMethod({ stages: [] })), /1–12 个阶段/);
  assert.match(why(() => checkedMethod({ stages: [stage({ activity: 'nap' })] })), /主活动需为/);
  assert.match(why(() => checkedMethod({ stages: [stage({ level: 'hard' })] })), /过关宽严需为/);
  assert.match(why(() => checkedMethod({ stages: [stage({ alternatives: ['explain', 'check', 'review'] })] })), /最多 2 个/);
  assert.match(why(() => checkedMethod({ stages: [stage({ alternatives: ['practice'] })] })), /不能与主活动相同/);
  assert.match(why(() => checkedMethod({ stages: [stage({ name: '  ' })] })), /名称需为/);
  assert.match(why(() => checkedMethod({ targetDate: '20-01-2027', stages: [stage()] })), /目标日期/);
  assert.equal(checkedMethod({ stages: [stage()] }).name, '课堂跟学', 'a method without a name is the default one named');
});

test('course.save keeps the method on that course alone and course.save {null} detaches it', async t => {
  const service = await library(t);
  const mine = { name: '期末冲刺', targetDate: '2027-01-20', stages: [stage({ name: '只练错题', activity: 'review' })] };
  await service.call('course.save', { name: 'Net', method: mine });
  const read = async name => { const got = await service.call('course.get', { name }); return got?.course ?? got; };
  const one = await read('Net');
  assert.equal(one.method.name, '期末冲刺');
  assert.deepEqual(one.method.stages.map(entry => entry.name), ['只练错题']);
  assert.ok(one.method.updatedAt, 'a stored method is stamped');
  await service.call('course.save', { name: 'Other' });
  const other = await read('Other');
  assert.equal(other.method, undefined, 'another course is untouched, and has no method of its own');
  assert.equal(courseMethod(other).name, '课堂跟学', 'which means the default package');
  await service.call('course.save', { name: 'Net', method: null });
  assert.equal((await read('Net')).method, undefined, 'null detaches it');
  await assert.rejects(service.call('course.save', { name: 'Net', method: { stages: [stage({ activity: 'nap' })] } }), /主活动需为/);
});


/* The card on the course settings (#775 S1): the default package is drawn as it is, a course's own method with its stages, and the English carries no Han. */
const m = await loadUi(`
  export { default as CourseMethodCard, MethodForm, shownMethod } from './ui/CourseMethodCard.jsx';
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);
const h = React.createElement;
const text = markup => markup.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();
const draw = (course, language = 'zh') => {
  m.setUiLanguage(language);
  try { return renderToStaticMarkup(inApp(m, h(m.CourseMethodCard, { course }), { call: async () => ({}) })); } finally { m.setUiLanguage('zh'); }
};

test('the card reads first: the default package is its name and three short stages, no form, and the change is behind 改学法', () => {
  const html = draw({ id: 'course-net', name: 'Net' }), plain = text(html);
  assert.match(plain, /学法 课堂跟学 默认/);
  for (const stage of CLASSROOM_METHOD.stages) assert.ok(plain.includes(stage.name), `${stage.name} is a stage of the card`);
  assert.doesNotMatch(html, /<input/, 'a course nobody customised is a few lines to read, not a form to fill in');
  assert.match(plain, /改学法/);
  assert.doesNotMatch(plain, /保存学法|恢复默认学法/, 'saving and going back are in the form');
  assert.doesNotMatch(plain, /想改就说一声/, 'the card says how to change it: the button, or the main chat');
  assert.match(html, /aria-label="学法是什么"/, 'what a method is: a 「?」, not a paragraph');
  const ownHtml = draw({ id: 'course-net', name: 'Net', method: { ...CLASSROOM_METHOD, name: '我的学法', targetDate: '2027-01-20', stages: [{ ...CLASSROOM_METHOD.stages[0], name: '只练错题' }] } }), own = text(ownHtml);
  assert.match(own, /学法 我的学法/);
  assert.doesNotMatch(own, /默认 /, 'a course\'s own method is not called the default');
  assert.match(own, /只练错题/);
  assert.match(own, /目标日期：2027-01-20/);
  const english = text(draw({ id: 'course-net', name: 'Net' }, 'en'));
  assert.match(english, /Learning method/);
  assert.doesNotMatch(english, /[㐀-鿿]/, 'the card is translated too');
});

test('a draft started from the default package is in the learner\'s language, and the form offers the way back only for a course\'s own method', () => {
  m.setUiLanguage('en');
  let english;
  try { english = m.shownMethod({ id: 'course-net', name: 'Net' }); } finally { m.setUiLanguage('zh'); }
  assert.doesNotMatch(JSON.stringify(english.stages.map(stage => stage.name)), /[㐀-鿿]/, 'editing one stage in English keeps the others English');
  const own = { id: 'course-net', name: 'Net', method: { ...CLASSROOM_METHOD, name: 'Mine', stages: [{ ...CLASSROOM_METHOD.stages[0], name: '只练错题' }] } };
  assert.equal(m.shownMethod(own).stages[0].name, '只练错题', 'a learner\'s own words are kept as typed');
  const form = (draft, isOwn, language = 'zh') => {
    m.setUiLanguage(language);
    try { return renderToStaticMarkup(inApp(m, h(m.MethodForm, { draft, own: isOwn, disabled: false, working: false, onChange() {}, onStage() {}, onSave() {}, onCancel() {}, onReset() {} }), { call: async () => ({}) })); }
    finally { m.setUiLanguage('zh'); }
  };
  const fresh = text(form(m.shownMethod({ name: 'Net' }), false));
  assert.match(fresh, /学法名称/);
  assert.match(fresh, /第 3 个阶段/);
  assert.match(fresh, /保存学法 取消/);
  assert.doesNotMatch(fresh, /恢复默认学法/, 'nothing to go back to: the default package');
  assert.match(text(form(m.shownMethod(own), true)), /恢复默认学法/);
  assert.equal((form(m.shownMethod({ name: 'Net' }), false).match(/aria-label="过关宽严是什么"/g) || []).length, 1, 'what the gates mean is said once');
  assert.doesNotMatch(text(form(m.shownMethod({ name: 'Net' }), false, 'en')), /[㐀-鿿]/, 'the form is translated too');
});
