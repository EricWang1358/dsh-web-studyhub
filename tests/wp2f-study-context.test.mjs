import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

// UI wave 2 · WP-F (#113): the services every page needs, offered by one context.
const m = await loadUi("export { StudyServicesContext, useStudy, STUDY_SERVICE_NAMES } from './ui/study-context.jsx';");
const probe = (value) => {
  let seen;
  const Probe = () => { seen = m.useStudy(); return null; };
  renderToStaticMarkup(value ? React.createElement(m.StudyServicesContext.Provider, { value }, React.createElement(Probe)) : React.createElement(Probe));
  return seen;
};

test('the service list is the contract the pages rely on', () => {
  assert.deepEqual([...m.STUDY_SERVICE_NAMES].sort(), ['act', 'askInChat', 'busy', 'call', 'host', 'navigate', 'notify', 'openModal', 'openSettings']);
});

test('without a provider a page still renders: every service exists and the verbs are harmless', async () => {
  const study = probe();
  for (const name of m.STUDY_SERVICE_NAMES) assert.ok(name in study, name);
  assert.equal(study.busy, false);
  assert.deepEqual(study.host, {});
  assert.doesNotThrow(() => { study.navigate('library'); study.openSettings('settings-model'); study.openModal({ type: 'add' }); study.notify('x'); study.askInChat('x'); });
  assert.equal(await study.act('x'), undefined);
  await assert.rejects(study.call('x'), /StudyServicesContext/, 'a missing provider is a loud error where a host call was expected');
});

test('a provider replaces them, and the same object reaches every consumer', () => {
  const services = { call() {}, act() {}, busy: true, notify() {}, askInChat() {}, host: { x: 1 }, openSettings() {}, navigate() {}, openModal() {} };
  assert.equal(probe(services), services);
});
