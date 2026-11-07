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
  assert.equal(mine.stages[0].name, CLASSROOM_METHOD.stages[0].name === mine.stages[0].name ? '课前：发资料，理出要学的点' : mine.stages[0].name, 'the copy is not the record');
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
  export { default as CourseMethodCard } from './ui/CourseMethodCard.jsx';
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

test('the card draws the default package, its stages and the gate switch; a course with its own method offers the way back', () => {
  const html = draw({ id: 'course-net', name: 'Net' }), plain = text(html);
  assert.match(plain, /学法/);
  assert.match(html, /课堂跟学/, 'the method name is in the field');
  for (const stage of CLASSROOM_METHOD.stages) assert.ok(html.includes(stage.name), `${stage.name} is a stage of the card`);
  assert.match(plain, /过关宽严/);
  assert.doesNotMatch(plain, /恢复默认学法/, 'nothing to go back to: the default package');
  const ownHtml = draw({ id: 'course-net', name: 'Net', method: { ...CLASSROOM_METHOD, name: '我的学法', stages: [{ ...CLASSROOM_METHOD.stages[0], name: '只练错题' }] } }), own = text(ownHtml);
  assert.match(ownHtml, /我的学法/);
  assert.match(ownHtml, /只练错题/);
  assert.match(own, /恢复默认学法/);
  const english = text(draw({ id: 'course-net', name: 'Net' }, 'en'));
  assert.match(english, /Learning method/);
  assert.doesNotMatch(english, /[\u3400-\u9fff]/, 'the card is translated too');
});
