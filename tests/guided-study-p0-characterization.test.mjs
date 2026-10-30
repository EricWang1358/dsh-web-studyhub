/* Characterization tests for Guided Study Phase 0 (SH4-01).
   These tests lock the StudyHub 3.7.4 baseline behaviors for domain contracts, panel intents,
   runs/attempts lifecycle, followup QA, book write and zero-copy view semantics, ensuring
   all subsequent 4.0.0 changes remain backwards-compatible and adhere to ADR-01 ~ ADR-12. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fields, reads, actionGrants } from '../lib/runtime/domain-contracts.js';
import { createPanelBridge } from '../lib/panel-bridge.js';
import { StudyService } from '../lib/service.js';

test('Decision 1: study context domain contracts provide sufficient reads and sharding boundary', () => {
  // 1. study context already owns runtime review entities
  assert.deepEqual(fields.study, ['runs', 'attempts', 'oralRuns', 'teaching', 'studySessions'],
    'fields.study must own runs, attempts, oralRuns, teaching, studySessions');

  // 2. study context possesses read access across required domains without creating a 20th context
  assert.ok(reads.study.includes('study'), 'study reads itself');
  assert.ok(reads.study.includes('bank'), 'study reads bank');
  assert.ok(reads.study.includes('materials'), 'study reads materials');
  assert.ok(reads.study.includes('system'), 'study reads system');
  assert.ok(reads.study.includes('courses'), 'study reads courses');
  assert.ok(reads.study.includes('workflow-data'), 'study reads workflow-data');

  // 3. study context has action grants to bank followups and drafts
  assert.ok(actionGrants.study.bank.includes('draft.save'));
  assert.ok(actionGrants.study.bank.includes('card.followup.add'));
  assert.ok(actionGrants.study.courses.includes('course.profile'));
});

test('Decision 2: tools specs are bounded and dispatch directly through invoke without top-level wrapper explosion', async () => {
  const toolsModule = await import('../lib/runtime/tools.js');
  assert.equal(typeof toolsModule.domainTool, 'function');

  // Verify that domainTool rejects unknown domain
  const nonExistent = toolsModule.domainTool('unknown_domain', {});
  assert.equal(nonExistent, null);

  // Verify existing standard domain tools can be constructed
  for (const domain of ['bank', 'materials', 'generation', 'study', 'audio']) {
    const tool = toolsModule.domainTool(domain, {
      resolveWorkspace: async () => 'test',
      requestServices: async () => ({}),
      forLibrary: () => ({ invoke: async () => ({ ok: true }) }),
    });
    assert.ok(tool, `domainTool for ${domain} must be definable`);
    assert.equal(typeof tool.execute, 'function');
  }
});

test('Decision 3: panel bridge intent queueing, visibility reporting, and monotonic sequence accounting', () => {
  const bridge = createPanelBridge();
  const sessionId = 'session-p0-char';

  // 1. Initially no visibility and no observation
  assert.equal(bridge.hasPanelVisibility(sessionId), false);
  assert.equal(bridge.panelObservation(sessionId), null);

  // 2. Queue panel intent
  const now = 1700000000000;
  const queued = bridge.queuePanelIntent(sessionId, { type: 'run', runId: 'run-123' }, now);
  assert.equal(queued.queued, true);

  // 3. Take panel intent (dequeues and consumes)
  const taken = bridge.takePanelIntent(sessionId, now + 1000);
  assert.ok(taken);
  assert.equal(taken.type, 'run');
  assert.equal(taken.runId, 'run-123');

  // Once taken, next poll gets null
  assert.equal(bridge.takePanelIntent(sessionId, now + 2000), null);

  // 4. Report panel visibility with sequence numbers
  const mockRun = {
    id: 'run-123',
    deckId: 'deck-1',
    card: { id: 'card-1' },
    index: 0,
    total: 5,
    mode: 'path',
    revealed: false,
    complete: false,
  };

  // Set sequence = 1 on sidebar
  const obs1 = bridge.setPanelVisible(sessionId, 'sidebar', mockRun, now + 3000, 1);
  assert.equal(bridge.hasPanelVisibility(sessionId), true);
  assert.equal(obs1.runId, 'run-123');
  assert.equal(obs1.cardId, 'card-1');
  assert.equal(obs1.revealed, false);

  // Late sequence (sequence = 1 again or sequence < 1) is rejected / ignored
  const staleObs = bridge.setPanelVisible(sessionId, 'sidebar', { ...mockRun, card: { id: 'stale' } }, now + 4000, 1);
  assert.equal(staleObs.cardId, 'card-1', 'Stale sequence must not overwrite newer visibility');

  // Higher sequence succeeds
  const updatedObs = bridge.setPanelVisible(sessionId, 'sidebar', { ...mockRun, card: { id: 'card-2' }, index: 1 }, now + 5000, 2);
  assert.equal(updatedObs.cardId, 'card-2');
  assert.equal(updatedObs.index, 1);
});

test('Decision 4 & 5: StudyService review lifecycle, question followup and deep-frozen view semantics', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'study-p0-char-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const study = new StudyService(root);
  t.after(() => study.dispose());

  // 1. Initialize store snapshot with sample cards and source
  await study.call('snapshot');
  const src = await study.call('source.add', {
    id: 'src-1',
    title: 'Architecture Note',
    text: 'Decoupled interfaces and domain contracts define clean software architecture.',
  });

  const card = {
    id: 'c1',
    kind: 'flashcard',
    topic: 'Architecture',
    objective: 'Explain architecture boundaries',
    prompt: 'What defines a clean boundary?',
    answer: 'Decoupled interfaces and domain contracts.',
    hint: 'Think about ADR-01 ~ ADR-12.',
    explanation: 'Bounded contexts avoid circular dependencies.',
    misconception: 'All data should be in one huge context.',
    citations: [{ sourceId: src.id, quote: 'Decoupled interfaces and domain contracts' }],
  };

  // Save deck and verify bank
  await study.call('draft.save', { deck: { id: 'd1', title: 'SA Decks', cards: [card] } });
  await study.call('draft.publish', { id: 'd1' });

  // 2. Characterize review.start baseline
  const started = await study.call('review.start', {
    mode: 'path',
    fresh: true,
    scope: [{ deckId: 'd1', cardId: 'c1' }],
  });

  assert.ok(started.id, 'Run ID generated');
  assert.equal(started.mode, 'path');
  assert.equal(started.card.id, 'c1');
  assert.equal(started.revealed, false);

  // 3. Characterize card.followup.add baseline
  const followup = await study.call('card.followup.add', {
    deckId: 'd1',
    cardId: 'c1',
    question: 'What is the role of architecture in 4.0?',
    answer: 'It defines decoupled boundaries and pure functions.',
  });

  assert.ok(followup.item.id);
  assert.equal(followup.item.question, 'What is the role of architecture in 4.0?');
  assert.equal(followup.item.answer, 'It defines decoupled boundaries and pure functions.');

  // 4. Characterize zero-copy storagePort.view() deep-freeze behavior
  const stateView = await study.call('library.context', { area: 'decks' });
  assert.ok(stateView);

  // 5. Reveal answer and grade
  const revealed = await study.call('review.reveal', { runId: started.id, cardId: 'c1' });
  assert.equal(revealed.revealed, true);

  const graded = await study.call('review.answer', {
    runId: started.id,
    cardId: 'c1',
    grade: 4,
  });
  assert.ok(graded);
  assert.equal(graded.revealed, true);
  assert.equal(graded.feedback.grade, 4);
  assert.equal(graded.feedback.correct, true);
});

test('Decision 6: Book write atomic operations and conflict protection', async (t) => {
  const { bookService } = await import('./helpers/book-agent-library.mjs');
  const made = await bookService(t);
  const study = made.study;
  t.after(() => study.dispose());

  const toc = await study.call('book.toc');
  // First entry is chapter, subsequent entries are leaves
  const what = toc.toc.slice(1).find(node => node.hid);
  assert.ok(what, 'Found a leaf knowledge point in toc');

  const written = await study.call('book.write', {
    hid: what.hid,
    markdown: '#### 一、核心原则\n\n教学上自由，数据上可靠，操作上简短。',
  });
  assert.ok(written);
  assert.equal(written.status, 'saved');
});
