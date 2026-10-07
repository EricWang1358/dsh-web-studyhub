import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';

/* 3.0.2 要求并行, the console half: the header button, the badge and the strip under the facts follow the contract (lib/job-parallel.js offerParallel), say what they mean on hover and on keyboard
   focus (a Tooltip with the anchor focusable), in both languages, and a refusal or a job sent back stays on the screen as a line too. */

const m = await loadUi(`
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { default as TaskConsole } from './ui/tasks/TaskConsole.jsx';
  export { eventText } from './ui/tasks/call-model.js';
  export { taskLine } from './ui/tasks/task-summary.js';
  export { cardLine } from './ui/tasks/CompactJobCard.jsx';
  export { setUiLanguage } from './ui/i18n.js';
  export { jobContract } from './lib/job-contract.js';
  export { offerParallel, queuedRun } from './lib/job-parallel.js';
`);
const han = /[㐀-鿿]/;
const text = html => html.replace(/<[^>]*>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

/** A card of the library. A queued one is in the library's queue (it has its place in the chain, which is what lets it be started beside it). */
const card = (id, extra = {}) => {
  const job = { id, root: 'lib', kind: 'quiz', status: 'running', deckTitle: id, requestedTotal: 5, savedCount: 0, startedAt: '2026-10-08T10:00:00.000Z', steps: [], ...extra };
  if (job.status === 'queued') m.queuedRun(job, async () => {});
  return job;
};
/** The job as the snapshot shows it: its contract, with what only the library can say. */
const view = (job, all) => m.offerParallel({ ...job, contract: m.jobContract(job) }, job, all);

const render = (jobs, shown, language = 'zh', focus = null) => {
  m.setUiLanguage(language);
  const list = jobs.filter(job => shown.includes(job.id)).map(job => view(job, jobs));
  const html = renderToStaticMarkup(inApp(m, React.createElement(m.TaskConsole, { data: { jobs: list, drafts: [], decks: [] }, openers: { resultOf: () => null } }),
    { data: { jobs: list }, app: { lib: { taskFocus: focus } } }));
  m.setUiLanguage('zh');
  return html;
};
const button = (html, form) => html.match(new RegExp(`<button[^>]*data-parallel="${form}"[^>]*>`))?.[0];
/** The tooltip an element is tied to: its aria-describedby points at a role=tooltip element, whose text is returned. */
const tipOf = (html, tag) => {
  const id = tag.match(/aria-describedby="([^"]+)"/)?.[1]?.split(' ').pop();
  assert.ok(id, `${tag.slice(0, 60)} is tied to a tooltip`);
  const at = html.indexOf(`id="${id}"`);
  assert.ok(at > 0 && /role="tooltip"/.test(html.slice(at, at + 160)), 'the tooltip is in the document');
  return text(html.slice(at, html.indexOf('</span></span>', at)));
};
const focus = id => ({ jobId: id, nonce: 1 });

const ahead = card('ahead', { deckTitle: '期中复习', startedAt: '2026-10-08T09:59:00.000Z' });
const waiting = card('waiting', { status: 'queued', deckTitle: '第二组', startedAt: '2026-10-08T10:00:00.000Z' });

test('a queued task offers 要求并行 in the header; it explains itself on hover and keyboard focus, and the strip names the task it waits behind', () => {
  const html = render([ahead, waiting], ['waiting'], 'zh', focus('waiting'));
  const tag = button(html, 'ask');
  assert.ok(tag, 'the button is there');
  assert.doesNotMatch(tag, /tabindex="-1"|disabled/, 'a real button: focusable');
  assert.match(html, /<button[^>]*data-parallel="ask"[^>]*>要求并行<\/button>/);
  const tip = tipOf(html, tag);
  assert.match(tip, /现在就开始，不再等前面的任务；多个任务同时调用模型，更快，但更容易触发限流。/);
  assert.match(tip, /出错时会先退回排队、不丢进度；写同一份草稿或题组的任务不能并行。/);
  const strip = html.match(/<div class="tc-queue"[^>]*>[\s\S]*?<\/div>/)[0];
  assert.match(text(strip), /排队中 · 等「期中复习」完成后自动开始/, 'the line that stays says which job is ahead');
  const anchor = strip.match(/<span[^>]*data-queue-explain[^>]*>/)[0];
  assert.match(anchor, /tabindex="0"/, 'the explanation is reachable by keyboard');
  assert.match(tipOf(strip, anchor), /同一个资料库里的任务默认一个接一个，免得同时占满模型额度；排在前面的是「期中复习」。 ?想让它现在就开始，可以点「要求并行」。/);
});

test('in English the same anchors and explainers read as plain English', () => {
  const html = render([ahead, waiting], ['waiting'], 'en', focus('waiting'));
  const tag = button(html, 'ask');
  assert.ok(tag);
  assert.match(html, /<button[^>]*data-parallel="ask"[^>]*>Run in parallel<\/button>/);
  const tip = tipOf(html, tag);
  assert.match(tip, /Starts now instead of waiting for the jobs ahead\. Several jobs calling the model at once is faster, but more likely to hit a rate limit\./);
  assert.match(tip, /On a model error it goes back to the queue first and loses no progress\. Jobs that write the same draft or deck cannot run in parallel\./);
  assert.doesNotMatch(tip, han);
  const strip = html.match(/<div class="tc-queue"[^>]*>[\s\S]*?<\/div>/)[0];
  assert.match(text(strip), /Queued · starts by itself when “期中复习” finishes/);
  const explained = tipOf(strip, strip.match(/<span[^>]*data-queue-explain[^>]*>/)[0]);
  assert.match(explained, /Jobs in one library run one after another by default.*Ahead of this one: “期中复习”\. To start it now, choose “Run in parallel”\./);
  assert.doesNotMatch(explained.replace(/期中复习/g, ''), han);
});

test('a task that cannot run beside a task writing the same draft or deck shows why, in a tooltip on a focusable control and as a line', () => {
  const first = card('first', { type: 'supplement', mergeTargetId: 'deck-1', deckTitle: '体系结构', targetTitle: '体系结构', startedAt: '2026-10-08T09:59:00.000Z' });
  const second = card('second', { type: 'supplement', mergeTargetId: 'deck-1', deckTitle: '体系结构', targetTitle: '体系结构', status: 'queued' });
  const zh = render([first, second], ['second'], 'zh', focus('second'));
  const tag = button(zh, 'blocked');
  assert.ok(tag, 'the control is there but cannot be pressed');
  assert.match(tag, /aria-disabled="true"/);
  assert.doesNotMatch(tag, /\sdisabled(=|\s|>)/, 'aria-disabled, not disabled: it stays focusable so the reason can be read');
  assert.match(tipOf(zh, tag), /不能并行：「体系结构」正在处理同一份草稿、题组或资料，两个任务同时写会互相覆盖。 ?等它结束，或先停止它，再要求并行。/);
  assert.match(text(zh.match(/data-parallel-blocked[^>]*>[^<]*/)[0]), /不能并行：「体系结构」正在处理同一份草稿、题组或资料/, 'and the reason stays on the screen');
  assert.equal(button(zh, 'ask'), undefined);
  const en = render([first, second], ['second'], 'en', focus('second'));
  assert.match(tipOf(en, button(en, 'blocked')), /Cannot run in parallel: “体系结构” is working on the same draft, deck or material, and two jobs writing it at once would overwrite each other\. Wait for it to finish, or stop it first, then ask again\./);
  assert.match(en, /data-parallel-blocked[^>]*>Cannot run in parallel: “体系结构” is working on the same draft/);
});

test('a task running beside the queue wears the badge 「并行中（手动）」, which explains itself and is focusable', () => {
  const running = card('beside', { parallel: true, parallelAt: '2026-10-08T10:01:00.000Z' });
  for (const [language, label, why] of [['zh', '并行中（手动）', /这个任务按你的要求，和排在前面的任务同时进行。 ?模型报错时它会先退回排队，不会丢进度。/],
    ['en', 'Parallel \\(manual\\)', /This job runs alongside the jobs ahead of it because you asked for that\. If the model returns an error it goes back to the queue first; no progress is lost\./]]) {
    const html = render([ahead, running], ['beside'], language, focus('beside'));
    const tag = html.match(/<span[^>]*data-parallel-badge[^>]*>/)?.[0];
    assert.ok(tag, `${language}: the badge`);
    assert.match(tag, /tabindex="0"/);
    assert.match(html, new RegExp(`data-parallel-badge[^>]*>[\\s\\S]*?${label}`));
    assert.match(tipOf(html, tag), why);
    assert.equal(button(html, 'ask'), undefined, 'a task that already runs in parallel offers no button');
  }
});

test('a task sent back to the queue by a model error says what happened, that nothing was lost and when it goes on, and the button is back with a warning', () => {
  const sent = card('sent', { status: 'queued', requeued: { at: '2026-10-08T10:02:00.000Z', cause: 'rate-limit', by: 'ahead' } });
  const zh = render([ahead, sent], ['sent'], 'zh', focus('sent'));
  const strip = zh.match(/<div class="tc-queue"[^>]*>[\s\S]*?<\/div>/)[0];
  assert.match(strip, /data-queue-state="requeued"/);
  assert.match(text(strip), /模型报错，已退回排队：等前面的任务完成后自动继续（原因：模型请求太频繁，被限流了）/);
  const anchor = strip.match(/<span[^>]*data-queue-explain[^>]*>/)[0];
  assert.match(anchor, /tabindex="0"/);
  assert.match(tipOf(strip, anchor), /刚才模型报错（模型请求太频繁，被限流了），这个任务先停下新的调用，已完成的部分都在，没有丢。 ?前面的任务做完后它会自动继续；也可以再点「要求并行」试一次。/);
  assert.match(tipOf(zh, button(zh, 'ask')), /它刚因为模型报错退回了排队；再试一次可能还会被退回，进度不会丢。/, 'the button warns that it was just stepped back');
  const en = render([ahead, sent], ['sent'], 'en', focus('sent'));
  assert.match(text(en.match(/<div class="tc-queue"[^>]*>[\s\S]*?<\/div>/)[0]), /The model returned an error, so this job went back to the queue and continues by itself when the jobs ahead finish \(cause: the model was asked too often and rate-limited it\)\./);
  assert.match(tipOf(en, button(en, 'ask')), /A model error just sent it back to the queue; trying again may send it back again, but no progress is lost\./);
});

test('nothing is drawn for a task that cannot have it: running, another kind, or a job of the unified runtime', () => {
  const html = render([ahead], ['ahead'], 'zh', focus('ahead'));
  assert.equal(button(html, 'ask'), undefined);
  assert.equal(button(html, 'blocked'), undefined);
  assert.doesNotMatch(html, /tc-queue|data-parallel-badge/);
  const audio = { id: 'a1', root: 'lib', type: 'audio-import', filename: 'lecture.wav', status: 'queued', phase: 'queued', startedAt: '2026-10-08T10:00:00.000Z' };
  assert.doesNotMatch(render([audio], ['a1'], 'zh', focus('a1')), /data-parallel=|tc-queue/);
  // A contract of the unified runtime (v2) is left as it is: no parallel action, and the console draws nothing.
  const runtime = { ...waiting, contract: { ...m.jobContract(waiting), contractVersion: 2 } };
  assert.equal(m.offerParallel(runtime, waiting, [ahead, waiting]).contract.actions.parallel, undefined);
});

test('the list line and the card line mark the two states, and the log tells them in both languages', () => {
  const beside = view(card('beside', { parallel: true }), [ahead]), sent = view(card('sent', { status: 'queued', requeued: { at: '2026-10-08T10:02:00.000Z', cause: 'timeout', by: 'ahead' } }), [ahead]);
  assert.match(m.taskLine(beside), /并行中（手动）/);
  assert.match(m.cardLine(beside), /并行中（手动）/);
  assert.match(m.taskLine(sent), /已退回排队 · 等前面的任务完成后自动继续/);
  assert.match(m.cardLine(sent), /已退回排队，等前面的任务完成后自动继续/);
  const events = [{ code: 'parallel-started' }, { code: 'parallel-requeued', args: { cause: 'timeout', by: 'ahead' } }, { code: 'parallel-resumed' }];
  assert.deepEqual(events.map(event => m.eventText(event)), ['已要求并行：不再等前面的任务，现在就开始', '模型报错（模型长时间没有响应），已退回排队：不再开始新的调用，等前面的任务完成后自动继续', '前面的任务已完成，自动继续']);
  m.setUiLanguage('en');
  const english = events.map(event => m.eventText(event));
  m.setUiLanguage('zh');
  assert.deepEqual(english, ['Asked to run in parallel: starts now instead of waiting', 'Model error (the model took too long to respond); sent back to the queue: no new calls start, and it continues by itself when the jobs ahead finish', 'The jobs ahead are done; continuing by itself']);
});
