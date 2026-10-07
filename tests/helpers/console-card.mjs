import assert from 'node:assert/strict';
import { loadUi } from './ui-module.mjs';

/* How the 任务 console reads a job, for tests: the pure code of ui/tasks/* (no DOM) and the checks every card has to pass, shared by the audio and PDF regressions (S6-5). */

export const ui = await loadUi(`export * as model from './ui/tasks/task-model.js'; export * as facts from './ui/tasks/task-facts.js'; export * as summary from './ui/tasks/task-summary.js';
  export * as control from './ui/tasks/task-control.js'; export * as calls from './ui/tasks/call-model.js'; export * as actions from './ui/tasks/task-actions.js';`);

/** Words a learner can read: Chinese, not a bare code, not an internal error. */
export const plain = text => typeof text === 'string' && /[一-鿿]/.test(text) && !/^[\w-]+$/.test(text) && !/Cannot read|undefined|TypeError|\[object/.test(text);
export const ENDED = ['complete', 'failed', 'cancelled', 'interrupted'];
const CARD_KEYS = ['jobId', 'kind', 'title', 'status', 'stage', 'progress', 'actions', 'result', 'usage', 'execution', 'detail', 'startedAt', 'calls', 'events'];

/** An operation answered as { reply } or { error } (a refusal is data here). */
export const refuse = (service, args, action = 'job.control') => service.call(action, args).then(reply => ({ reply }), error => ({ error }));

/** The card as the console reads it: every field present, every helper of the console able to draw it. Returns the contract. */
export function readCard(row, { side, name }, { uiKind = 'audio', find } = {}) {
  const c = ui.model.contractOf(row), where = `${name}/${side} ${row.id}`;
  for (const key of CARD_KEYS) assert.ok(key in c, `${where}: the contract has ${key}`);
  const drawn = ui.model.taskKindOf(row);
  if (drawn !== uiKind && find) find(`${name}-not-${uiKind}-family`, `${name} (kind ${c.kind}) is drawn as "${drawn}", not as ${uiKind}`);
  else assert.equal(drawn, uiKind, where);
  assert.ok(ui.summary.taskTitle(row), `${where}: a title`);
  assert.ok(ui.summary.stateLabel(ui.summary.taskState(row)), `${where}: a state the console has a word for (${ui.summary.taskState(row)})`);
  assert.ok(ui.summary.taskLine(row), `${where}: a line`);
  const facts = ui.facts.taskFacts(row);
  assert.deepEqual(facts.map(fact => fact.key), ['primary', 'elapsed', 'calls', 'warnings'], where);
  for (const fact of facts) assert.ok(plain(fact.label) && typeof fact.value === 'string' && fact.value, `${where}: fact ${fact.key}`);
  assert.ok(Array.isArray(ui.facts.taskSegments(row)) && typeof ui.facts.usageLine(row) === 'string', where);
  assert.ok(Object.values(ui.control.headerActions(row)).every(value => typeof value === 'boolean'), where);
  for (const item of ui.control.controlItems(row)) assert.ok(item.key && plain(item.label) && ['int', 'enum', 'bool'].includes(item.type) && item.value !== undefined, `${where}: setting ${item.key}`);
  assert.ok(ui.calls.timelineModel(c.calls, { now: Date.now(), running: ui.model.isRunningTask(row) }), `${where}: a timeline`);
  assert.ok(Array.isArray(ui.calls.logLines(c)), `${where}: log lines`);
  return c;
}

/** The actions of a card equal what its kind declares (runtime cards), and every one that is not offered says why in words. */
export function readActions(c, { side, name }, { running }) {
  const where = `${name}/${side}`, { actions, capabilities } = c;
  if (capabilities) {
    assert.equal(actions.cancel.available, running && capabilities.cancel, `${where}: cancel is offered exactly while it runs and when declared`);
    if (capabilities.pauseMode === 'unsupported') assert.equal(actions.pause.available, false, `${where}: no pause button without pause`);
    if (!capabilities.set) assert.equal(actions.set.available, false, `${where}: no settings without settings`);
    if (!capabilities.retry) assert.equal(actions.retry.available, false, `${where}: no retry without retry`);
  }
  for (const action of ['pause', 'resume', 'retry', 'set']) if (!actions[action].available) assert.ok(plain(ui.control.reasonText(actions[action], action)), `${where}: ${action} says why not, in words`);
  assert.ok(!(running && actions.retry.available), `${where}: nothing to retry while it runs`);
}
