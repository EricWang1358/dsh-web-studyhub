import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { stageMaterials, measureStageCounts } from '../lib/course-method-progress.js';
import { createStudySession, assertScopeAllowed } from '../lib/study-session.js';
import { checkQuestionRequest } from '../lib/guided-question-prep.js';
import { addBookQa, removeBookQa, bookQaList } from '../lib/course-book-qa.js';
import { openCourseBook } from '../lib/course-book-files.js';
import { cardPlace } from '../lib/contexts/library/card-place.js';
import { COURSE_OUTLINE_PROVENANCE, COURSE_NOTES_PROVENANCE } from '../lib/exam-point-list.js';
import { courseDocuments } from '../lib/course-outline-index.js';

function withTempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'studyhub-1306-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('#1306-1: stageMaterials includes child-course materials when querying parent course', () => {
  const state = {
    courses: [
      { id: 'c-cloud', name: 'Cloud' },
      { id: 'c-k8s', name: 'Cloud / 05 K8s' },
      { id: 'c-other', name: 'Cloud Native' },
    ],
    sources: [
      { id: 's-child', title: 'K8s Pods', text: 'Pod scheduling details', courses: ['Cloud / 05 K8s'] },
      { id: 's-legacy-child', title: 'K8s Services', text: 'ClusterIP vs NodePort', course: 'Cloud / 05 K8s' },
      { id: 's-sibling', title: 'Other', text: 'Unrelated sibling prefix', courses: ['Cloud Native'] },
      { id: 's-archived', title: 'Old', text: 'Archived', archived: true, courses: ['Cloud / 05 K8s'] },
    ],
    decks: [
      {
        id: 'd-k8s',
        title: 'K8s Deck',
        course: 'Cloud / 05 K8s',
        cards: [{ id: 'q1', kind: 'quiz', prompt: 'What is a Pod?', answer: 'Smallest deployable unit' }],
      },
    ],
    attempts: [],
  };

  const materials = stageMaterials(state, 'Cloud');
  assert.deepEqual(materials.map(s => s.id), ['s-child', 's-legacy-child']);

  const counts = measureStageCounts(state, 'Cloud', null);
  assert.equal(counts.materials, 2);
  assert.equal(counts.cards, 1);
});

test('#1306-2: companion.list and companion.get include child-course companions and cards while keeping exact course', async t => {
  const root = withTempRoot(t);
  const service = new StudyService(root);
  await service.store.update(state => {
    state.courses = [
      {
        id: 'c-cloud',
        name: 'Cloud',
        companions: [
          {
            id: 'comp-parent',
            title: 'Cloud Overview',
            lessonId: 'cloud-overview',
            relPath: 'companions/cloud-overview.html',
            storage: 'workspace',
            slideCount: 3,
          },
        ],
      },
      {
        id: 'c-k8s',
        name: 'Cloud / 05 K8s',
        companions: [
          {
            id: 'comp-child',
            title: 'K8s Scheduler Lab',
            lessonId: 'k8s-lab',
            relPath: 'companions/k8s-lab.html',
            storage: 'workspace',
            slideCount: 4,
          },
        ],
      },
      {
        id: 'c-other',
        name: 'Cloud Native',
        companions: [
          {
            id: 'comp-sibling',
            title: 'Sibling Companion',
            lessonId: 'sibling',
            relPath: 'companions/sibling.html',
            storage: 'workspace',
            slideCount: 2,
          },
        ],
      },
    ];
    state.decks = [
      {
        id: 'd-k8s',
        title: 'K8s Deck',
        course: 'Cloud / 05 K8s',
        cards: [{ id: 'c1', kind: 'quiz', topic: 'Scheduler', prompt: 'How does kube-scheduler bind?', answer: 'Filter and score' }],
      },
      {
        id: 'd-other',
        title: 'Other Deck',
        course: 'Cloud Native',
        cards: [{ id: 'c2', kind: 'quiz', topic: 'Other', prompt: 'Other Q?', answer: 'Other A' }],
      },
    ];
  });

  const listed = await service.call('companion.list', { course: 'Cloud' });
  const ids = listed.companions.map(c => c.id).sort();
  assert.deepEqual(ids, ['comp-child', 'comp-parent']);
  const childComp = listed.companions.find(c => c.id === 'comp-child');
  assert.equal(childComp.course, 'Cloud / 05 K8s', 'child companion preserves its exact course name');

  // Verify companion.get on parent companion includes child-course cards
  const { writeManagedCompanionFile } = await import('../lib/companion/companions.js');
  await writeManagedCompanionFile(root, 'comp-parent', '<!doctype html><html><body>Cloud</body></html>');
  const got = await service.call('companion.get', { id: 'comp-parent', course: 'Cloud' });
  assert.ok(got.relatedCards.some(c => c.cardId === 'c1'), 'parent companion sees child-course cards');
  assert.ok(!got.relatedCards.some(c => c.cardId === 'c2'), 'parent companion does not leak sibling-course cards');
});

test('#1306-3: StudySession started by course id or parent name permits child-course resources and blocks siblings', () => {
  const state = {
    courses: [
      { id: 'c-cloud-id', name: 'Cloud' },
      { id: 'c-k8s-id', name: 'Cloud / 05 K8s' },
      { id: 'c-other-id', name: 'Cloud Native' },
    ],
    sources: [
      { id: 's-k8s', title: 'K8s Doc', text: 'K8s text', courses: ['Cloud / 05 K8s'] },
      { id: 's-other', title: 'Other Doc', text: 'Other text', courses: ['Cloud Native'] },
    ],
    decks: [
      {
        id: 'd-k8s',
        title: 'K8s Deck',
        course: 'Cloud / 05 K8s',
        cards: [{ id: 'q-k8s', kind: 'quiz', prompt: 'Q?', answer: 'A' }],
      },
      {
        id: 'd-other',
        title: 'Other Deck',
        course: 'Cloud Native',
        cards: [{ id: 'q-other', kind: 'quiz', prompt: 'Q2?', answer: 'A2' }],
      },
    ],
    studySessions: [],
  };

  // Start session with course RECORD ID (`c-cloud-id`)
  const sessionById = createStudySession(state, {
    courseId: 'c-cloud-id',
    settings: { allowNewQuestions: true },
  });
  state.studySessions.push(sessionById);

  assert.equal(assertScopeAllowed(sessionById, { kind: 'source', id: 's-k8s' }, state), true);
  assert.equal(assertScopeAllowed(sessionById, { kind: 'deck', id: 'd-k8s' }, state), true);
  assert.equal(assertScopeAllowed(sessionById, { kind: 'card', deckId: 'd-k8s', cardId: 'q-k8s' }, state), true);
  assert.equal(assertScopeAllowed(sessionById, { kind: 'topic', course: 'Cloud / 05 K8s' }, state), true);

  assert.throws(() => assertScopeAllowed(sessionById, { kind: 'source', id: 's-other' }, state), { code: 'study-scope-denied' });
  assert.throws(() => assertScopeAllowed(sessionById, { kind: 'deck', id: 'd-other' }, state), { code: 'study-scope-denied' });
  assert.throws(() => assertScopeAllowed(sessionById, { kind: 'card', deckId: 'd-other', cardId: 'q-other' }, state), { code: 'study-scope-denied' });
  assert.throws(() => assertScopeAllowed(sessionById, { kind: 'topic', course: 'Cloud Native' }, state), { code: 'study-scope-denied' });

  // checkQuestionRequest also works with course id + child deck/source
  const prep = checkQuestionRequest(state, {
    sessionId: sessionById.id,
    deckId: 'd-k8s',
    sourceIds: ['s-k8s'],
    kind: 'quiz',
  });
  assert.equal(prep.deck.id, 'd-k8s');
  assert.deepEqual(prep.sourceIds, ['s-k8s']);
});

test('#1306-4: child-course Q&A add/remove/list and cardPlace resolve to parent course review book', async t => {
  const root = withTempRoot(t);
  const service = new StudyService(root);

  await service.store.update(state => {
    state.focus = { course: 'Cloud / 05 K8s' };
    state.courses = [
      { id: 'c-cloud', name: 'Cloud' },
      { id: 'c-k8s', name: 'Cloud / 05 K8s' },
    ];
    state.sources = [
      {
        id: 'src-k8s',
        title: 'K8s Networking',
        text: 'Services expose Pods via ClusterIP and kube-proxy rules.',
        courses: ['Cloud / 05 K8s'],
      },
    ];
    state.decks = [
      {
        id: 'deck-k8s',
        title: 'K8s Quiz',
        course: 'Cloud / 05 K8s',
        cards: [
          {
            id: 'card-svc',
            kind: 'quiz',
            topic: 'Services',
            prompt: 'How does ClusterIP route traffic?',
            answer: 'Through kube-proxy rules',
            citations: [{ sourceId: 'src-k8s', quote: 'Services expose Pods via ClusterIP' }],
            followups: [
              { id: 'fu-1', question: 'What about headless services?', answer: 'Headless services set clusterIP: None.' },
            ],
          },
        ],
      },
    ];
    const index = courseDocuments(state, 'Cloud');
    const docKey = index.candidates[0].key;
    state.sources.push({
      id: 'outline-cloud',
      title: 'Cloud 总纲',
      text: '# Cloud',
      provenance: COURSE_OUTLINE_PROVENANCE,
      courses: ['Cloud'],
      courseOutline: {
        version: 1,
        course: 'Cloud',
        createdAt: new Date().toISOString(),
        nodes: [
          {
            id: 'leaf-k8s',
            title: 'Kubernetes Networking',
            anchors: [docKey],
            children: [],
          },
        ],
      },
    });
    state.sources.push({
      id: 'notes-cloud',
      title: 'Cloud 笔记',
      text: '',
      provenance: COURSE_NOTES_PROVENANCE,
      courses: ['Cloud'],
      courseNotes: {
        version: 1,
        course: 'Cloud',
        outlineId: 'outline-cloud',
        language: 'zh',
        leaves: [
          {
            id: 'leaf-k8s',
            title: 'Kubernetes Networking',
            body: { points: ['ClusterIP routes traffic via kube-proxy.'], explain: 'Pod networking basics.' },
          },
        ],
      },
    });
    openCourseBook(state, { course: 'Cloud' });
  });

  // 1) cardPlace resolves leaf in parent book
  const place = await service.call('card.place', { deckId: 'deck-k8s', cardId: 'card-svc' });
  assert.equal(place.course, 'Cloud / 05 K8s');
  assert.ok(place.leaf, 'child card finds its leaf in parent review book');
  assert.equal(place.leaf.title, 'Kubernetes Networking');
  assert.equal(place.leaf.built, true);
  assert.equal(place.leaf.course, 'Cloud');

  // 2) book.qa.add writes follow-up to parent course book
  const added = await service.call('book.qa.add', { deckId: 'deck-k8s', cardId: 'card-svc', followupId: 'fu-1' });
  assert.equal(added.write, 'added');
  assert.equal(added.course, 'Cloud');

  // 3) book.qa.list with child course sees the added follow-up
  const listedChild = await service.call('book.qa.list', { course: 'Cloud / 05 K8s' });
  assert.ok(listedChild.followupIds.includes('fu-1'));
  assert.ok(listedChild.courses.includes('Cloud'));

  // 4) book.qa.remove without course (while focus is child course) removes cleanly
  const removed = await service.call('book.qa.remove', { followupId: 'fu-1' });
  assert.equal(removed.write, 'removed');

  const listedAfter = await service.call('book.qa.list', {});
  assert.ok(!listedAfter.followupIds.includes('fu-1'));

  // 5) Pure functions addBookQa / removeBookQa / bookQaList also resolve parent book
  const st = structuredClone(await service.store.read());
  const pureAdd = addBookQa(st, { deckId: 'deck-k8s', cardId: 'card-svc', followupId: 'fu-1' });
  assert.equal(pureAdd.status, 'added');
  assert.equal(pureAdd.course, 'Cloud');
  assert.ok(bookQaList(st, { course: 'Cloud / 05 K8s' }).followupIds.includes('fu-1'));
  const pureRem = removeBookQa(st, { course: 'Cloud / 05 K8s', followupId: 'fu-1' });
  assert.equal(pureRem.status, 'removed');
  assert.equal(cardPlace(st, { deckId: 'deck-k8s', cardId: 'card-svc' }).leaf.built, true);
});
