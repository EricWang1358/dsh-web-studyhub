import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { render } from 'ink';
import React from 'react';
import { register } from 'tsx/esm/api';
import { setupCalculation } from '../../../tests/helpers/calculation-session.mjs';
import { createVirtualTty } from './helpers/virtual-tty.mjs';

test('the documented review shortcut resumes a saved calculation at its current step without starting a concept lesson', async t => {
  const unregister = register();
  const [{ AppShell }, { ReviewView }, { useTuiStore, DEFAULT_PREFERENCES }] = await Promise.all([
    import('../src/shell/AppShell.tsx'), import('../src/views/review/ReviewView.tsx'), import('../src/state/store.ts'),
  ]);
  const { service, run, root } = await setupCalculation(t);
  const saved = await service.call('teach.start', { runId: run.id, cardId: run.card.id, mode: 'calculation', language: 'zh' });
  await service.call('teach.skip', { id: saved.id, stepIndex: 0 });
  const guide = await readFile(new URL('../docs/GUIDE.md', import.meta.url), 'utf8');
  const shortcut = guide.match(/^\|\s*`([a-z])`[^|]*\|\s*(?:\*\*)?苏格拉底带学/im)?.[1];
  assert.ok(shortcut, 'the review guide must publish a keyboard entry for a saved Socratic lesson');
  const snapshot = await service.call('snapshot');
  const model = t.mock.fn(async () => JSON.stringify({
    diagnosis: 'Reason about the units', transfer: 'Use consistent units', rungs: [
      { lesson: 'Speed measures distance per time', check: 'What does speed measure?', answer: 'Distance per time' },
      { lesson: 'Multiply by elapsed time', check: 'How do you recover distance?', answer: 'Multiply by time' },
    ],
  }));
  service.complete = model;
  const teachingCalls = [];
  const teachingRequests = [];
  const host = {
    getLibraryRoot: () => root,
    call: async (name, args) => {
      const request = service.call(name, args);
      if (name === 'teach.get' || name === 'teach.start') {
        teachingCalls.push({ name, args });
        teachingRequests.push(request);
      }
      try { return { ok: true, value: await request }; }
      catch (error) { return { ok: false, error: { message: error.message } }; }
    },
  };
  const previous = useTuiStore.getState();
  useTuiStore.setState({
    page: 'review', activeRunId: run.id, navContext: { runId: run.id }, snapshot,
    preferences: { ...DEFAULT_PREFERENCES, language: 'zh' }, loading: false, showLaunchpad: false,
  });
  const tty = createVirtualTty(130, 40);
  const view = render(React.createElement(AppShell, {
    host, autoLaunchpad: false, renderPage: (_page, props) => React.createElement(ReviewView, props),
  }), { stdin: tty.stdin, stdout: tty.stdout, stderr: tty.stderr, exitOnCtrlC: false, patchConsole: false });
  try {
    await tty.waitFor(screen => screen.includes(run.card.prompt), { label: 'resumed review card' });
    tty.send(shortcut);
    await tty.waitFor(screen => /第\s*2\/5\s*步/.test(screen) || teachingCalls.some(call => call.name === 'teach.start'), {
      label: 'resume saved lesson or observe an unwanted new lesson',
    });
    await Promise.allSettled(teachingRequests);
    await tty.flush();
    assert.deepEqual(teachingCalls.filter(call => call.name === 'teach.start'), [], 'the review shortcut must never start a second lesson while resuming');
    assert.ok(teachingCalls.some(call => call.name === 'teach.get' && call.args.id === saved.id), 'loaded the saved calculation by ID');
    assert.equal(model.mock.callCount(), 0);
    const screen = await tty.waitFor(/第\s*2\/5\s*步/, { label: 'second step of the original calculation' });
    assert.match(screen, /Current check 1\?|Stage 1 relationship/);
    assert.equal((await service.call('review.get', { runId: run.id })).teaching.id, saved.id);
    const persisted = (await service.store.read()).teaching.filter(lesson => lesson.runId === run.id);
    assert.deepEqual(persisted.map(lesson => [lesson.id, lesson.mode]), [[saved.id, 'calculation']]);
  } finally {
    view.unmount();
    tty.dispose();
    useTuiStore.setState(previous);
    unregister();
  }
});
