import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUi } from './helpers/ui-module.mjs';
import { library, pointList, snapshot, STAMP } from './helpers/exam-prep-fixtures.mjs';
import { planBuild } from '../lib/contexts/generation/blueprint/plan.js';
import { BLUEPRINT_LIMITS } from '../lib/exam-blueprint-material.js';

/* 备考补习, a long library (owner report 2026-10-09: 198 materials, 175 of them plain notes). Nothing is picked for a material nothing marks,
   and a choice of more materials than one list can take is told in its own words (it used to be the "wrong role" refusal). Fakes only. */

const ui = await loadUi(`
  export * from './ui/exam-prep/model.js';
  export * from './ui/exam-prep/form.js';
  export * from './ui/exam-prep/words.js';
  export { setUiLanguage } from './ui/i18n.js';`);
const KNOWN = ['网络', '数据库'];
const NOTES = 175;

/** 175 plain 补充笔记 text sources, two outline-like ones, one document of several parts, a sample paper, another course's material and one existing 考点清单. */
function longLibrary() {
  const notes = Array.from({ length: NOTES }, (_, index) => ({ id: `note-${index + 1}`, title: `补充笔记 · 第 ${index + 1} 周`, text: `第 ${index + 1} 周的笔记：内容`, createdAt: STAMP,
    courses: ['网络'], chars: 14, excerpt: '笔记' }));
  const outlines = [{ id: 'outline-1', title: '课程大纲 2025', text: '传输层、网络层', createdAt: STAMP, courses: ['网络'], chars: 8, excerpt: '大纲' },
    { id: 'outline-2', title: '考试大纲（补充）', text: '应用层', createdAt: STAMP, courses: ['网络'], chars: 4, excerpt: '大纲' }];
  return [...library(), ...notes, ...outlines, pointList()];
}
const openWith = (sources, extra = {}) => {
  const data = snapshot({ lists: [pointList()], sources, ...extra });
  return { data, form: ui.openingForm(data, { scope: '网络', known: KNOWN }) };
};
const countOf = form => ui.ROLES.reduce((sum, role) => sum + form.picks[role].length, 0);

test('a material nothing marks is not used until the learner picks it: the long library opens with the deck, the paper and the outlines only', () => {
  const { form } = openWith(longLibrary());
  assert.deepEqual(form.picks.lecture, ['传输层-1', '传输层-2', '传输层-3', '传输层-4', '传输层-6'], 'only the slides (a PowerPoint says what it is)');
  assert.deepEqual(form.picks['past-paper'], ['paper-1']);
  assert.deepEqual(form.picks.syllabus.sort(), ['outline-1', 'outline-2', 'syllabus-1']);
  assert.ok(![...form.picks.lecture, ...form.picks['past-paper'], ...form.picks.syllabus].some(id => id.startsWith('note-')), 'no note is picked');
});

test('the request of the opening form is accepted by the plan, and every pick but the outlines are one input each', () => {
  const { data, form } = openWith(longLibrary());
  const request = ui.buildRequest(form, data.sources, { defaultTitle: '网络 考点清单' });
  assert.ok(request.inputs.length <= BLUEPRINT_LIMITS.inputs);
  const plan = planBuild({ sources: data.sources, documents: [] }, request);
  assert.ok(plan.inputs.length > 0);
});

test('every note used as a lecture is more materials than one list takes: the form says so, and the plan refuses in words of its own (not the "role" refusal)', () => {
  const { data, form } = openWith(longLibrary());
  const all = ui.documentsOf(data.sources).filter(item => item.sourceIds.some(id => id.startsWith('note-')));
  assert.equal(all.length, NOTES, 'a note is a document');
  const picks = all.reduce((picks, item) => ui.assignRole(picks, item, 'lecture'), form.picks);
  const request = ui.buildRequest({ ...form, picks }, data.sources, { defaultTitle: '网络 考点清单' });
  assert.ok(request.inputs.length > BLUEPRINT_LIMITS.inputs, `${request.inputs.length} inputs`);
  // the form asks the operation (which names the limit) and shows its answer; it needs no limit of its own
  assert.deepEqual(ui.formProblems({ ...form, picks }, request), [], 'the form itself only asks for a lecture');
  assert.throws(() => planBuild({ sources: data.sources, documents: [] }, request), error => {
    assert.equal(error.code, 'blueprint-too-many-inputs');
    assert.match(error.message, new RegExp(String(BLUEPRINT_LIMITS.inputs)));
    assert.doesNotMatch(error.message, /每份资料都要有用途/);
    return true;
  });
  assert.throws(() => planBuild({ sources: data.sources, documents: [] }, { ...request, language: 'en' }), error => error.code === 'blueprint-too-many-inputs' && /at most 60/.test(error.message));
  // the words when no message came with the refusal
  assert.match(ui.refusalWords({ code: 'blueprint-too-many-inputs' }), /不用/);
});

test('suspects that are not the cause: a 考点清单 in the library, a document of several parts, and a role for every source id', () => {
  const { data, form } = openWith(longLibrary());
  const request = ui.buildRequest(form, data.sources, { defaultTitle: '网络 考点清单' });
  const listId = data.sources.find(source => source.provenance === 'exam-blueprint').id;
  assert.ok(!request.inputs.some(input => input.sourceIds.includes(listId)), 'a 考点清单 is never an input');
  const deck = request.inputs.find(input => input.role === 'lecture');
  assert.deepEqual(deck.sourceIds, ['传输层-1', '传输层-2', '传输层-3', '传输层-4', '传输层-6'], 'the parts of one document are one input');
  assert.equal(deck.documentId, '传输层');
  assert.equal(countOf(form) > 0, true);
});

test('nothing picked: no request is ready, the start waits with a plain hint, and the plan asks for a lecture', () => {
  const { data, form } = openWith(longLibrary());
  const none = ui.documentsOf(data.sources).reduce((picks, item) => ui.assignRole(picks, item, 'none'), form.picks);
  const request = ui.buildRequest({ ...form, picks: none }, data.sources, { defaultTitle: '网络 考点清单' });
  assert.deepEqual(request.inputs, []);
  assert.deepEqual(ui.formProblems({ ...form, picks: none }, request), ['lecture']);
  assert.throws(() => planBuild({ sources: data.sources, documents: [] }, request), error => error.code === 'blueprint-needs-primary-input');
  // one lecture picked: ready
  const note = ui.documentsOf(data.sources).find(item => item.sourceIds.includes('note-7'));
  const one = ui.assignRole(none, note, 'lecture');
  const picked = ui.buildRequest({ ...form, picks: one }, data.sources, { defaultTitle: '网络 考点清单' });
  assert.deepEqual(ui.formProblems({ ...form, picks: one }, picked), []);
  assert.ok(planBuild({ sources: data.sources, documents: [] }, picked).inputs.length === 1);
});
