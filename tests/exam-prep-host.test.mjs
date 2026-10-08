import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHostHandler, servicesForHost } from '../lib/host.js';
import { PAGES } from '../ui/pages.js';
import { loadUi } from './helpers/ui-module.mjs';

const { PAGE_VIEWS } = await loadUi("export { PAGE_VIEWS } from './ui/app/page-views.jsx';");

/* 备考补习 is on unless the learner turned it off in Settings, and the host's switch (runtime.pilot.examBlueprint) forces it on. The host puts the answer on the snapshot as `features`,
   and the page registry, the sidebar and the page renderer read it from there: one source for "is the page there". */

async function snapshot(t, pilot, learner) {
  const cwd = await mkdtemp(join(tmpdir(), 'study-exam-prep-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const session = { header: { cwd }, requestHeader: () => ({ config: undefined }) };
  const ctx = { sessions: { get: () => session }, get: () => undefined };
  if (pilot) servicesForHost(ctx, undefined, pilot);
  const handler = createHostHandler(ctx, {}, () => async () => '{}');
  if (learner) assert.equal((await handler('call', { sessionId: 's', action: 'settings.examPrep.set', args: { patch: learner } })).ok, true);
  const response = await handler('call', { sessionId: 's', action: 'snapshot', args: {} });
  assert.equal(response.ok, true, response.error?.message);
  return response.value;
}

test('the snapshot says the page is on by default, off when the learner turned it off, and on again when the host forces it', async t => {
  const off = { enabled: false };
  assert.deepEqual((await snapshot(t)).features, { examBlueprint: true, examBlueprintByHost: false });
  assert.deepEqual((await snapshot(t, undefined, off)).features, { examBlueprint: false, examBlueprintByHost: false });
  assert.deepEqual((await snapshot(t, { examBlueprint: false }, off)).features, { examBlueprint: false, examBlueprintByHost: false });
  assert.deepEqual((await snapshot(t, { examBlueprint: true }, off)).features, { examBlueprint: true, examBlueprintByHost: true }, 'the host switch forces it on');
  assert.deepEqual((await snapshot(t, { examBlueprint: 'true' }, off)).features, { examBlueprint: false, examBlueprintByHost: false }, 'only a literal true');
  assert.deepEqual((await snapshot(t, { audioSingle: true }, off)).features, { examBlueprint: false, examBlueprintByHost: false }, 'another switch does not turn it on');
});

test('the snapshot carries the lists as summaries, never as sources, and the page has its renderer', async t => {
  const value = await snapshot(t);
  assert.ok(Array.isArray(value.examPointLists));
  assert.equal(PAGES.examprep.flag, 'examBlueprint');
  assert.equal(typeof PAGE_VIEWS.examprep, 'function');
});
