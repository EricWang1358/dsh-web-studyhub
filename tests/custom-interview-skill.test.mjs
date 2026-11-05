/* 深度定制 S1 (the 定制 interview, skills/study-custom/SKILL.md): the skill ships and parses, asks in the order the owner set, saves only after the confirm,
   and names only actions that exist in the study workspace or in the S0 contract (the 定制方案 record and its read-only preview). The hand-off that opens it
   (custom.start) is registered with the skill and a one-line 我想： tail. No model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSkill, registerStudySkills, SHIPPED_SKILLS } from '../lib/study-skills.js';
import { StudyService } from '../lib/service.js';
import { LEVELS } from '../lib/coverage-strength.js';
import { CARD_KINDS } from '../lib/domain.js';
import { loadUi } from './helpers/ui-module.mjs';

const text = await readFile(new URL('../skills/study-custom/SKILL.md', import.meta.url), 'utf8');
const skill = parseSkill(text);

/* The contract with S0 (the 定制方案): the one read-only op and the record's field values the skill writes. Until S0 lands the registry cannot answer for
   them; when it does, this list shrinks to nothing and the registry answers for every name. */
const PURPOSES = ['preview', 'follow', 'review', 'openbook'];
const BOOK_PARTS = ['explain', 'terms', 'formulas', 'index', 'confusables', 'answerKit', 'cheatSheet'];

test('the skill ships: a name, a description and a whenToUse that names the hand-off, registered with the others', () => {
  assert.equal(skill.name, 'study-custom');
  assert.ok(SHIPPED_SKILLS.includes('study-custom'));
  assert.match(skill.description, /定制|customi/i);
  assert.match(skill.whenToUse, /custom\.start/);
  const registered = [];
  registerStudySkills({ skills: { register: each => { registered.push(each.name); return () => {}; } } });
  assert.ok(registered.includes('study-custom'));
});

test('every action the skill names is an action of the study workspace, or one of the S0 contract', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-custom-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const study = new StudyService(root);
  t.after(() => study.dispose?.());
  const named = [...new Set([...text.matchAll(/`((?:library|course|generation|generate|job|source|coverage|supplement|settings)(?:\.[A-Za-z]+)*)(?=[ {`])/g)].map(match => match[1]))];
  for (const action of ['library.context', 'course.get', 'course.save', 'course.custom.preview', 'course.custom.apply', 'generation.courseOutline.build', 'generation.courseBook.build', 'generate', 'job.status', 'course.plan'])
    assert.ok(named.includes(action), `the skill names ${action}`);
  for (const action of named) assert.ok(study.runtime.hasAction(action), `${action} is not registered`);
  // `custom` is saved the way `plan` is: with the existing course.save
  assert.match(text, /course\.save \{[^}]*"custom"/);
});

test('the interview: six questions in the owner\'s order, one at a time, ask_user_question with options, defaults first, nothing made before the confirm', () => {
  const body = skill.content;
  const at = word => { const index = body.indexOf(word); assert.ok(index >= 0, `the skill has ${word}`); return index; };
  const order = ['## 问题 1', '## 问题 2', '## 问题 3', '## 问题 4', '## 问题 5', '## 问题 6'].map(at);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'the questions come in order');
  for (const word of ['预习', '跟课学', '期末复习', '开卷考试']) assert.ok(body.slice(at('## 问题 1'), at('## 问题 2')).includes(word), `question 1 offers ${word}`);
  const two = body.slice(at('## 问题 2'), at('## 问题 3'));
  for (const word of ['全书', '考试范围', '挑几章', '3–7']) assert.ok(two.includes(word), `question 2 offers ${word}`);
  const six = body.slice(at('## 问题 6'));
  for (const word of ['先做一个样例看看', '直接全部做', '再精简一些']) assert.ok(six.includes(word), `question 6 offers ${word}`);
  assert.match(body, /ask_user_question/);
  assert.match(body, /multiSelect/);
  assert.match(body, /一次只问一个问题/);
  assert.match(body, /(?:第一个选项|默认.{0,12}第一)/);
  assert.match(body, /2–4 个选项/);
  // the one rule: nothing is generated and nothing saved before the learner confirms
  assert.match(body, /确认之前不生成任何东西/);
  assert.ok(body.indexOf('course.save') > at('## 问题 6'), 'the save comes after question 6');
  // no prices, only calls and tokens
  assert.match(body, /不说价格|never prices/i);
});

test('the choices the skill records are the S0 field values, and the ones it starts name existing ops', () => {
  for (const purpose of PURPOSES) assert.ok(skill.content.includes(`"${purpose}"`) || skill.content.includes(`\`${purpose}\``), `purpose ${purpose}`);
  for (const part of BOOK_PARTS) assert.ok(skill.content.includes(part), `book part ${part}`);
  for (const level of LEVELS) assert.ok(skill.content.includes(level), `strength ${level}`);
  for (const kind of CARD_KINDS) assert.ok(skill.content.includes(kind), `question kind ${kind}`);
  assert.match(skill.content, /"by": ?"(?:exam|weekly)"|by 为 `?(?:exam|weekly)/);
});

test('honest about what is applied: a choice no op can honour yet is recorded and said so; limits and the language rule as in study-guide', () => {
  const body = skill.content;
  assert.match(body, /只记在定制方案里/);
  assert.match(body, /不要说已经做了/);
  assert.match(body, /可能有错/);
  assert.match(body, /页码/);
  assert.match(body, /English|英文/);
  assert.match(body, /结束时用一句中文说明/);
  assert.match(body, /已有定制|已经有定制/);
  assert.match(body, /不要把整套访谈再问一遍|不要重新问整套/);
});

test('the hand-off custom.start is registered with the skill and the 我想： tail', async () => {
  const ui = await loadUi(`export { HAND_OFFS, handOffText } from './ui/agent-prompts/index.js'; export { setUiLanguage } from './ui/i18n.js';`);
  const entry = ui.HAND_OFFS['custom.start'];
  assert.ok(entry, 'registered');
  assert.equal(entry.skill, 'study-custom');
  assert.equal(entry.tail, 'ask');
  const zh = ui.handOffText('custom.start', { course: 'SA', document: 'doc-1', pages: 512 }, 'zh');
  assert.match(zh, /先读：skill study-custom/);
  assert.match(zh, /512/);
  assert.match(zh, /"doc-1"/);
  assert.match(zh, /确认之前不生成/);
  const again = ui.handOffText('custom.start', { course: 'SA', hasCustom: true }, 'zh');
  assert.match(again, /已有定制/);
  assert.doesNotMatch(zh, /已有定制/);
  const none = ui.handOffText('custom.start', {}, 'zh');
  assert.doesNotMatch(none, /"undefined"|null/);
  const en = ui.handOffText('custom.start', { course: 'SA', document: 'doc-1', pages: 512 }, 'en');
  assert.match(en, /study-custom/);
  assert.match(en, /512 pages/);
});

test('after the confirm the skill calls course.custom.apply once and reads out started / waiting / recorded; what apply now does is no longer said to be only recorded', () => {
  const body = skill.content, after = body.slice(body.indexOf('## 确认之后'));
  assert.ok(body.indexOf('course.custom.apply') > body.indexOf('## 问题 6'), 'apply comes after the confirm');
  for (const word of ['started', 'waiting', 'recorded', 'confirm', '只调用一次']) assert.ok(after.includes(word), `the skill says ${word}`);
  const only = body.slice(body.indexOf('## 只记录'), body.indexOf('## 已有定制'));
  for (const applied of ['只对选定章节出题', '按每周几章排的计划（备考计划需要考试日期）', '变式题（做错题时由应用自己准备）', '单独去掉某一部分'])
    assert.ok(!only.includes(applied) && !body.includes(applied), `「${applied}」 is applied now, not only recorded`);
  for (const stillRecorded of ['考试范围']) assert.ok(only.includes(stillRecorded), `「${stillRecorded}」 is still only recorded`);
  assert.doesNotMatch(body, /`generate \{"sourceIds"/, 'the skill no longer starts the question runs by hand');
});
