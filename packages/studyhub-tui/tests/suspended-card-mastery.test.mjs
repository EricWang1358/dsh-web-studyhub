import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { render } from 'ink';
import React from 'react';
import { register } from 'tsx/esm/api';
import { StudyService } from '../../../lib/service.js';
import { createVirtualTty } from './helpers/virtual-tty.mjs';

test('dashboard and library weight mastery by active cards in a real library snapshot', async t => {
  const unregister = register();
  const [{ DashboardView }, { LibraryView }, { useTuiStore, DEFAULT_PREFERENCES }] = await Promise.all([
    import('../src/views/dashboard/DashboardView.tsx'),
    import('../src/views/library/LibraryView.tsx'),
    import('../src/state/store.ts'),
  ]);
  const root = await mkdtemp(join(tmpdir(), 'studyhub-mastery-'));
  const service = new StudyService(root);
  const course = 'Biology';
  const card = (id, suspended = false) => ({ id, kind: 'flashcard', topic: 'Cells', prompt: id, answer: id, suspended });
  const previous = useTuiStore.getState();
  try {
    await service.store.update(state => {
      state.decks.push(
        { id: 'large', title: 'Cells', course, cards: [card('known'), ...Array.from({ length: 9 }, (_, i) => card('paused-' + i, true))] },
        { id: 'small', title: 'Genetics', course, cards: [card('fresh')] },
      );
      state.attempts.push({ id: 'easy', deckId: 'large', quiz_id: 'known', grade: 5, correct: true, timestamp: '2026-01-01T12:00:00Z' });
    });
    await service.call('focus.set', { course });
    const snapshot = await service.call('snapshot');
    const map = await service.call('map');
    assert.deepEqual(snapshot.decks.map(deck => [deck.count, snapshot.progress[deck.id].total]), [[10, 1], [1, 1]]);
    assert.deepEqual(map.mastery.library, { cards: 2, value: 50 });
    const host = { call: async () => ({ ok: true, value: {} }) };
    for (const [page, View] of [['dashboard', DashboardView], ['library', LibraryView]]) {
      await t.test(page, async () => {
        useTuiStore.setState({ snapshot, page, preferences: { ...DEFAULT_PREFERENCES, language: 'en', asciiMode: true } });
        const tty = createVirtualTty(84, 32);
        const view = render(React.createElement(View, { host, width: 84, height: 32, isActive: false }), {
          stdin: tty.stdin, stdout: tty.stdout, stderr: tty.stderr, interactive: true, exitOnCtrlC: false, patchConsole: false,
        });
        try {
          const mastery = /Mastery:?\s+(\d+)%/;
          const screen = await tty.waitFor(mastery, { label: page + ' mastery' });
          const displayed = Number(screen.match(mastery)[1]);
          assert.equal(displayed, map.mastery.library.value, 'suspended cards must not give their deck extra weight');
          if (page === 'library') assert.match(screen, /Total:\s*10\b/, 'the deck inventory still includes its suspended cards');
        } finally { view.unmount(); tty.dispose(); }
      });
    }
  } finally {
    useTuiStore.setState(previous);
    unregister();
    await service.dispose?.();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 });
  }
});
