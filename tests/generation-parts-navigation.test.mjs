import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';

// 任务 → 资料部分: a part can be followed to the material it was made from. The handler is the app's own (learn.openAudioSources, the one 打开结果 uses);
// the pure part (which sources, which one first, what is said when they are gone) is tested directly, the button states as static markup, zh and en.
const m = await loadUi(`
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { default as GenerationParts } from './ui/tasks/GenerationParts.jsx';
  export { partOpener, resultOpener } from './ui/tasks/task-actions.js';
  export { jobContract } from './lib/job-contract.js';
  export { setUiLanguage } from './ui/i18n.js';
`);
const at = (seconds) => new Date(Date.UTC(2026, 9, 5, 10, 0, seconds)).toISOString();
const sources = (...ids) => ids.map((id) => ({ id, title: id }));
const opened = [];
const appOf = (ids, extra = {}) => ({ lib: { taskFocus: null }, host: {}, data: { sources: sources(...ids) }, learn: { openAudioSources: (list) => opened.push(list) }, ...extra });
const html = (element, { language = 'zh', app } = {}) => {
  m.setUiLanguage(language);
  try { return renderToStaticMarkup(inApp(m, element, { data: app?.data || {}, app })); } finally { m.setUiLanguage('zh'); }
};
const contractOf = (extra = {}) => m.jobContract({ id: 'g', status: 'complete', deckTitle: 'Deck', requestedTotal: 10, savedCount: 3, parts: 2, startedAt: at(0), steps: [],
  partPlan: [{ part: 1, sourceIds: ['p1', 'p2', 'p3'], sourceCount: 3, label: 'Networks · 第 12–14 页' }, { part: 2, sourceIds: ['p4'], sourceCount: 1, label: 'Networks · 第 40 页' }],
  partReport: { summary: 's', parts: [{ part: 1, asked: 5, kept: 3, status: 'partial', reasons: ['quote', 'quality'] }, { part: 2, asked: 1, kept: 0, status: 'failed', reasons: ['other'] }] }, ...extra });

test('partOpener: the first source that still exists, through the app\'s own handler, with how many there are', () => {
  opened.length = 0;
  const opener = m.partOpener({ part: 1, sourceIds: ['gone', 'p2', 'p3'], sourceCount: 3 }, appOf(['p2', 'p3']));
  assert.equal(opener.available, true);
  assert.equal(opener.count, 3);
  assert.equal(opener.firstId, 'p2');
  opener.run();
  assert.deepEqual(opened, [['p2']], 'the handler is called once, with the first existing source');
});

test('partOpener: all the sources deleted is disabled with the reason, and running it does nothing', () => {
  opened.length = 0;
  const opener = m.partOpener({ part: 3, sourceIds: ['x', 'y'], sourceCount: 2 }, appOf(['p1']));
  assert.equal(opener.available, false);
  assert.match(opener.reason, /已被删除/);
  opener.run();
  assert.deepEqual(opened, []);
});

test('partOpener: no sources recorded is "nothing to follow" (an older run), and an app without navigation offers nothing', () => {
  assert.equal(m.partOpener({ part: 1 }, appOf(['p1'])).available, false);
  assert.match(m.partOpener({ part: 1 }, appOf(['p1'])).reason, /没有记录/);
  assert.equal(m.partOpener({ part: 1, sourceIds: ['p1'] }, { data: { sources: sources('p1') } }), null);
  assert.equal(m.partOpener({ part: 1, sourceIds: ['p1'] }, null), null);
});

test('the parts list shows where each part came from and a small button per part that has sources', () => {
  const out = html(React.createElement(m.GenerationParts, { contract: contractOf() }), { app: appOf(['p1', 'p2', 'p3', 'p4']) });
  assert.equal((out.match(/data-part="/g) || []).length, 2, 'the rows are unchanged');
  assert.match(out, /Networks · 第 12–14 页/, 'the range is on the row');
  assert.equal((out.match(/data-part-open="/g) || []).length, 2);
  assert.match(out, /aria-label="在资料中查看第 1 批"/);
});

test('the picked part\'s strip: the range, the "several sources" note, why it kept fewer, and the button', () => {
  const out = html(React.createElement(m.GenerationParts, { contract: contractOf({ parts: 1, partPlan: [{ part: 1, sourceIds: ['p1', 'p2', 'p3'], sourceCount: 3, label: 'Networks · 第 12–14 页' }],
    partReport: { summary: 's', parts: [{ part: 1, asked: 5, kept: 3, status: 'partial', reasons: ['quote', 'quality'] }] } }) }), { app: appOf(['p1', 'p2', 'p3']) });
  const strip = out.slice(out.indexOf('class="tc-strip'));
  assert.match(strip, /要 5 题，保留 3 题/);
  assert.match(strip, /Networks · 第 12–14 页/);
  assert.match(strip, /共 3 份资料，先打开第一份/);
  assert.match(strip, /原因：引用在资料里找不到；题没有通过质量审阅/);
  assert.match(strip, /data-part-view="1"/);
  assert.doesNotMatch(strip.match(/<button[^>]*data-part-view[^>]*>/)[0], /disabled/);
  assert.match(strip, />在资料中查看</);
});

test('a part with one source says nothing about "several", and a part that kept all it was asked for gives no reason', () => {
  const out = html(React.createElement(m.GenerationParts, { contract: contractOf({ parts: 1, partPlan: [{ part: 1, sourceIds: ['p1'], sourceCount: 1, label: 'Networks · 第 3 页' }],
    partReport: { summary: 's', parts: [{ part: 1, asked: 2, kept: 2, status: 'passed' }] } }) }), { app: appOf(['p1']) });
  const strip = out.slice(out.indexOf('class="tc-strip'));
  assert.doesNotMatch(strip, /先打开第一份/);
  assert.doesNotMatch(strip, /原因/);
  assert.match(strip, /data-part-view="1"/);
});

test('sources deleted: the button is disabled and the reason is on the strip, never a dead click', () => {
  const out = html(React.createElement(m.GenerationParts, { contract: contractOf({ parts: 1, partPlan: [{ part: 1, sourceIds: ['p1'], sourceCount: 1, label: 'Networks · 第 3 页' }],
    partReport: { summary: 's', parts: [{ part: 1, asked: 2, kept: 0, status: 'failed', reasons: ['plan'] }] } }) }), { app: appOf([]) });
  const strip = out.slice(out.indexOf('class="tc-strip'));
  assert.match(strip.match(/<button[^>]*data-part-view[^>]*>/)[0], /disabled/);
  assert.match(strip, /这些资料已被删除/);
  assert.match(strip, /考点规划未通过检查/);
});

test('a run with no recorded sources shows the strip without a way in, and says so', () => {
  const out = html(React.createElement(m.GenerationParts, { contract: contractOf({ parts: 1, partPlan: undefined, partReport: { summary: 's', parts: [{ part: 1, asked: 2, kept: 2, status: 'passed' }] } }) }), { app: appOf(['p1']) });
  assert.doesNotMatch(out, /data-part-open=/);
  assert.match(out, /这次运行没有记录用到的资料/);
});

test('in English every new string is English, and the strip keeps its class so the layout stays one fixed height', () => {
  const contract = contractOf({ parts: 1, partPlan: [{ part: 1, sourceIds: ['p1', 'p2'], sourceCount: 2, label: 'Networks · pp. 12–13' }],
    partReport: { summary: 's', parts: [{ part: 1, asked: 5, kept: 3, status: 'partial', reasons: ['quote'] }] } });
  const out = html(React.createElement(m.GenerationParts, { contract }), { language: 'en', app: appOf(['p1', 'p2']) });
  const strip = out.slice(out.indexOf('class="tc-strip'));
  assert.match(strip, />View in materials</);
  assert.match(strip, /2 sources, the first one opens/);
  assert.match(strip, /Reason: quoted text that could not be found in the sources/);
  assert.match(out, /aria-label="View batch 1 in materials"/);
  assert.doesNotMatch(strip, /[一-鿿]/, 'no Chinese left in the strip');
  assert.match(strip, /tc-strip--parts/);
});

test('every new literal has an English entry', () => {
  const english = JSON.parse(fs.readFileSync(new URL('../ui/locales/en.task-console.json', import.meta.url), 'utf8'));
  for (const key of ['在资料中查看', '在资料中查看第 {0} 批', '共 {0} 份资料，先打开第一份', '这些资料已被删除，无法查看。', '这次运行没有记录用到的资料。', '引用在资料里找不到', '考点规划未通过检查', '题没有通过质量审阅', '其他原因']) assert.ok(english[key], key);
});
