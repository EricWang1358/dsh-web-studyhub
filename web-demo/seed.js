import { initialReview, schedule } from '../lib/domain.js';
import { courseIdFor, courseKey } from '../lib/courses.js';
import { saveSkeleton } from '../lib/skeleton.js';
import { startQuickSession } from '../lib/workflows.js';
import { followupDigest } from '../lib/followup.js';
import { lessons, sampleCards, stripDemoCardFields } from './content.js';
import { SAMPLE_COMPANION_DEFS, getSampleCompanionBundle } from './sample-companions.js';

export const DEMO_SEED_VERSION = 4;

const DEMO_CARD_COMPANION_SLIDES = Object.freeze({
  'memento-owner': 2,
  'snapshot-restore': 2,
  'memento-interface': 3,
  'snapshot-opaque': 3,
  'bridge-render': 3,
  'bridge-dimensions': 3,
  'bridge-cross-product': 3,
});

function seedDemoCompanions(state, at) {
  state.courses = Array.isArray(state.courses) ? state.courses : [];
  state.sources = Array.isArray(state.sources) ? state.sources : [];
  const courseName = 'Design patterns';
  let courseRec = state.courses.find(c => c && courseKey(c.name) === courseKey(courseName));
  if (!courseRec) {
    courseRec = {
      id: courseIdFor(courseName),
      name: courseName,
      aliases: [],
      createdAt: at(5),
      updatedAt: at(1),
      guidanceSourceIds: [],
      focusTopics: [],
      companions: [],
    };
    state.courses.push(courseRec);
  }
  courseRec.companions = Array.isArray(courseRec.companions) ? courseRec.companions : [];

  SAMPLE_COMPANION_DEFS.forEach((def, idx) => {
    const bundle = getSampleCompanionBundle(def.id, 'en');
    if (!bundle) return;
    const projectedId = bundle.projectedSource.id;
    const existingSource = state.sources.find(s => s.id === projectedId);
    if (!existingSource) {
      state.sources.push({
        ...structuredClone(bundle.projectedSource),
        createdAt: at(2, -idx * 15),
        sample: true,
      });
    } else if (existingSource.sample && existingSource.text !== bundle.projectedSource.text) {
      existingSource.title = bundle.projectedSource.title;
      existingSource.text = bundle.projectedSource.text;
    }
    const existingCompanion = courseRec.companions.find(item => item.id === bundle.id);
    if (!existingCompanion) {
      courseRec.companions.push({
        id: bundle.id,
        title: bundle.title,
        mode: 'managed',
        bytes: bundle.bytes,
        sha256: bundle.sha256,
        lessonId: bundle.lessonId,
        slideCount: bundle.lesson.slides.length,
        sourceId: projectedId,
        grounded: true,
        sample: true,
        createdAt: at(2, -idx * 15),
        updatedAt: at(1, -idx * 15),
      });
    } else if (existingCompanion.sample) {
      existingCompanion.bytes = bundle.bytes;
      existingCompanion.sha256 = bundle.sha256;
      existingCompanion.slideCount = bundle.lesson.slides.length;
    }
  });

  if (courseRec.companions.some(item => item.id === 'comp-demo-patterns')) {
    for (const collection of [state.decks, state.drafts]) {
      for (const d of collection || []) {
        if (!Array.isArray(d?.cards)) continue;
        for (const card of d.cards) {
          if (card.companionRef) continue;
          const baseId = String(card.id || '').replace(/^(?:demo-\d+-|draft-)/, '');
          const slide = DEMO_CARD_COMPANION_SLIDES[baseId];
          if (slide) {
            card.companionRef = {
              companionId: 'comp-demo-patterns',
              lessonId: 'demo-patterns-backpressure',
              slide,
            };
          }
        }
      }
    }
  }
}

// All records are fictional examples. Use the product's real data contracts so
// opening, editing, reviewing and marking messages read use the normal engine.
export function seedDemo(state, now = new Date()) {
  const prevVersion = Number(state.demoSeedVersion || 0);
  if (prevVersion >= DEMO_SEED_VERSION) return state;
  const deck = state.decks.find(d => d.id === 'patterns-demo');
  state.demoSeedVersion = DEMO_SEED_VERSION;
  const at = (days, minutes = 0) => new Date(+now - days * 86400000 + minutes * 60000).toISOString();

  for (const collection of [state.decks, state.drafts]) {
    for (const d of collection || []) {
      if (Array.isArray(d?.cards)) d.cards = d.cards.map(stripDemoCardFields);
    }
  }

  if (prevVersion < 2 && deck && sampleCards.every(sample => deck.cards.some(c => c.id === sample.id))) {
    const ref = card => ({ deckId: deck.id, cardId: card.id });
    const untouched = new Set(deck.cards.filter(c => !state.attempts.some(a => a.quiz_id === c.id)).map(c => c.id));
    for (let day = 21; day >= 1; day--) {
      for (let j = 0; j < 2; j++) {
        const card = deck.cards[(day + j) % deck.cards.length];
        if (!untouched.has(card.id)) continue;
        const grade = day > 14 ? (j ? 3 : 1) : day > 6 ? (j ? 4 : 3) : (j ? 5 : 4);
        const before = card.review || initialReview(), timestamp = at(day, j * 4);
        const after = schedule(before, grade, timestamp);
        state.attempts.push({ id: `demo-history-${day}-${j}`, runId: `demo-session-${day}`,
          quiz_id: card.id, deckId: deck.id, topic: card.topic, timestamp, grade,
          assessment: card.kind === 'quiz' ? 'graded' : 'self', elapsed_ms: 28000 + day * 900,
          retry: false, before: structuredClone(before), after, demo: true });
        if (untouched.has(card.id)) card.review = after;
      }
    }
    for (const card of deck.cards.filter(c => ['memento-owner', 'bridge-render'].includes(c.id))) {
      if (!untouched.has(card.id)) continue;
      const before = card.review, timestamp = at(0, -45), after = schedule(before, 1, timestamp);
      state.attempts.push({ id: `demo-mistake-${card.id}`, runId: 'demo-mistakes', quiz_id: card.id,
        deckId: deck.id, topic: card.topic, timestamp, grade: 1, assessment: card.kind === 'quiz' ? 'graded' : 'self',
        elapsed_ms: 42000, before, after, retry: false, demo: true });
      if (untouched.has(card.id)) card.review = after;
    }
    const cards = new Map(deck.cards.map(c => [c.id, c]));
    for (const [dependent, prerequisite] of [['memento-interface', 'snapshot-opaque'], ['memento-owner', 'snapshot-restore'], ['bridge-cross-product', 'bridge-dimensions'], ['bridge-render', 'bridge-dimensions']]) {
      const card = cards.get(dependent), base = cards.get(prerequisite);
      if (card && base && !card.requires?.some(r => r.cardId === base.id)) card.requires = [...(card.requires || []), ref(base)];
    }
    if (!state.skeletons.some(s => s.id === 'demo-pattern-skeleton')) {
      const skeleton = saveSkeleton(state, {
        title: 'Sample · Design patterns: roles and boundaries', scope: [{ deckId: deck.id }],
        overview: 'A worked example connecting state restoration to independent variation. Select a concept to see its linked questions.',
        classNote: 'Memento separates history management from state access. Bridge separates two independently changing dimensions.',
        nodes: [
          { id: 'originator', term: 'Originator', meaning: 'Owns state; creates and restores snapshots.', attributes: ['Owns internal state', 'Creates and restores'], cards: ['snapshot-restore', 'memento-interface'] },
          { id: 'memento', term: 'Memento', meaning: 'An opaque snapshot of one previous state.', attributes: ['Opaque contents', 'One saved state'], cards: ['snapshot-opaque'] },
          { id: 'caretaker', term: 'Caretaker', meaning: 'Keeps snapshot history without reading its contents.', attributes: ['Manages history', 'No state inspection'], cards: ['memento-owner'] },
          { id: 'abstraction', term: 'Report abstraction', meaning: 'Describes a report independently of its rendering backend.', attributes: ['Report types', 'Delegates rendering'], cards: ['bridge-render', 'bridge-cross-product'] },
          { id: 'implementation', term: 'Rendering implementation', meaning: 'Provides a backend that varies independently of report types.', attributes: ['Rendering backends', 'Independent variation'], cards: ['bridge-dimensions'] },
        ],
        relations: [
          { from: 'originator', to: 'memento', type: 'related', note: 'Creates and restores' },
          { from: 'caretaker', to: 'memento', type: 'related', note: 'Stores without inspection' },
          { from: 'abstraction', to: 'implementation', type: 'related', note: 'Delegates through composition' },
          { from: 'memento', to: 'abstraction', type: 'contrasts', note: 'State restoration versus independent variation' },
        ],
        sequences: [{ title: 'Undo in a text editor', explanation: 'Illustrative application of the sample source. The editor restores its own state.',
          participants: [{ id: 'history', label: 'History', node: 'caretaker' }, { id: 'editor', label: 'Editor', node: 'originator' }],
          steps: [{ from: 'history', to: 'editor', message: 'Request a snapshot before editing' },
            { from: 'editor', to: 'history', message: 'Return an opaque snapshot', kind: 'return' },
            { from: 'history', to: 'editor', message: 'Undo: restore the saved snapshot' }] }],
      });
      skeleton.id = 'demo-pattern-skeleton';
      skeleton.lastChange.summary = 'Prepared sample concept map';
    }
    for (const [topic, title, markdown] of [
      ['Memento', 'Sample notes · Why the Caretaker cannot read a snapshot', '# Memento: managing history without exposing state\n\n> Fictional sample learning notes.\n\n## Three responsibilities\n\n- **Originator:** creates and restores its own state.\n- **Memento:** one opaque snapshot.\n- **Caretaker:** stores and retrieves snapshots.\n\n## The envelope analogy\n\nA caretaker can store sealed envelopes without reading their letters. The originator knows how to interpret the contents. This is an analogy, not a literal implementation.\n\n## Common mistake\n\nA Memento is a snapshot, not the history manager. The Caretaker manages the history.\n\n## Next recall question\n\nWhy does keeping a snapshot require less access than restoring it?'],
      ['Bridge', 'Sample notes · Avoiding twenty report subclasses', '# Bridge: two dimensions of change\n\n> Fictional sample learning notes.\n\n## Worked example\n\nFive report types and four rendering backends create **20 combinations** if each pair needs a subclass. This is a constructed application of the source.\n\n## Design decision\n\nKeep report types and rendering backends separate. A report holds a rendering implementation and delegates the backend work.\n\n## Compare the patterns\n\nMemento addresses snapshots and restoration. Bridge addresses independent variation. Identify the problem before choosing the pattern.\n\n## Try it\n\nEdit these notes, then practise the linked questions.'],
    ]) {
      const noteId = `demo-note-${topic.toLowerCase()}`;
      if (!state.notes.some(n => n.id === noteId)) {
        state.notes.push({ id: noteId, title, markdown, cards: deck.cards.filter(c => c.topic === topic).map(ref), status: 'draft', createdAt: at(3), updatedAt: at(1) });
      }
    }
    if (!state.workflowSessions.some(s => s.id === 'demo-guided-session')) {
      const session = startQuickSession(state, { requestId: 'demo-guided-lesson', goal: 'Explain Memento roles and recognise when Bridge helps.', title: 'Sample · From explanation to practice', scope: [{ deckId: deck.id }], skeletonId: 'demo-pattern-skeleton', language: 'en' });
      session.id = 'demo-guided-session';
      const lesson = session.template.steps.find(s => s.kind === 'lesson');
      session.currentStepId = lesson.id;
      session.records[lesson.id] = { content: '> Prepared sample lesson. No model request is made.\n\n' + lessons.en.map(([title, text]) => `## ${title}\n\n${text}`).join('\n\n'), citations: deck.cards[0].citations, updatedAt: at(0, -30) };
    }
    const first = deck.cards[0];
    if (!first.followups?.some(f => f.id === 'demo-followup')) {
      first.followups = [...(first.followups || []), { id: 'demo-followup', at: at(0, -20), digest: followupDigest(first), originalQuestion: 'Why is the snapshot not the history manager?', question: 'Why is the snapshot not the history manager?', answer: 'The Memento represents one saved state. The Caretaker manages the collection of snapshots. The Originator creates and restores them.\n\n*Prepared sample explanation.*', source: 'assistant' }];
    }
    for (const mail of [
      { id: 'demo-mail-help', kind: 'followup', ...ref(first), detail: 'Sample explanation: snapshot versus history manager', at: at(0, -20), read: false },
      { id: 'demo-mail-note', kind: 'note', ...ref(first), noteId: 'demo-note-memento', detail: 'Sample learning notes are ready to edit', at: at(0, -35), read: false },
      { id: 'demo-mail-link', kind: 'link', ...ref(cards.get('bridge-render')), detail: 'Linked independent dimensions as a prerequisite', at: at(1), read: true },
    ]) {
      if (!state.inbox.some(m => m.id === mail.id)) state.inbox.push(mail);
    }
    if (!state.drafts.some(d => d.id === 'demo-draft')) {
      state.drafts.push({
        id: 'demo-draft',
        title: 'Sample draft · Patterns recap',
        folder: 'Design patterns',
        createdAt: at(0, -60),
        updatedAt: at(0, -60),
        cards: deck.cards.slice(0, 3).map(c => ({
          ...stripDemoCardFields(c),
          id: `draft-${c.id}`,
          review: initialReview(),
          requires: [],
          followups: [],
        })),
      });
    }
  }

  seedDemoCompanions(state, at);
  state.revision++;
  return state;
}
