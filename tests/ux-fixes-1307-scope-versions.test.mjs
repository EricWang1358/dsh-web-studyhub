import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import {
  analyzeAssessmentModes,
  compileCoachGenerationRequest,
  computeCoachEvidence,
  normalizeCoachSpec,
} from '../lib/exam-coach.js';
import {
  COURSE_BOOK_DOC_PROVENANCE,
  COURSE_INVENTORY_PROVENANCE,
  COURSE_OUTLINE_PROVENANCE,
  assertMaterials,
} from '../lib/exam-point-list.js';
import { searchLibraryContent } from '../lib/contexts/library/content-search.js';
import { createIndexPlanner } from '../lib/contexts/generation/retrieval/index-plan.js';
import { buildIndex, contentHash, INDEX_KEY_VERSION, INDEX_TOOLS, writeManifest } from '../lib/retrieval-index.js';
import { retrievalRootId } from '../lib/retrieval-settings.js';

function withTempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'studyhub-1307-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('#1307-1: ExamCoach isolates course scope, includes child courses, and excludes outline/book/inventory/historical sources', async () => {
  const state = {
    courses: [
      { id: 'c-algo', name: 'Algorithms' },
      { id: 'c-dp', name: 'Algorithms / 02 DP' },
      { id: 'c-bio', name: 'Biology' },
    ],
    documents: [
      {
        id: 'doc-algo',
        title: 'Graph Algorithms',
        currentRevision: 2,
        versions: [
          { revision: 1, sourceIds: ['s-algo-old'] },
          { revision: 2, sourceIds: ['s-algo-cur'] },
        ],
      },
    ],
    sources: [
      { id: 's-algo-old', title: 'Old Graph Notes', text: '# Old Obsolete Heading\nLegacy revision text', courses: ['Algorithms'] },
      { id: 's-algo-cur', title: 'Graph Algorithms', text: '# Shortest Paths\nDijkstra computes shortest paths.', courses: ['Algorithms'] },
      { id: 's-dp', title: 'Dynamic Programming', text: '# Optimal Substructure\nBellman equation and memoization.', courses: ['Algorithms / 02 DP'] },
      { id: 's-bio', title: 'Cell Biology', text: '# Mitochondria\nATP synthesis in eukaryotes.', courses: ['Biology'] },
      { id: 's-uncat', title: 'Loose Note', text: '# Random Scratch\nUncategorized text.' },
      { id: 's-outline', title: 'Algorithms Outline', text: '# Outline', provenance: COURSE_OUTLINE_PROVENANCE, courses: ['Algorithms'], courseOutline: { nodes: [] } },
      { id: 's-book', title: 'Algorithms Book', text: '# Book', provenance: COURSE_BOOK_DOC_PROVENANCE, courses: ['Algorithms'], bookDoc: { course: 'Algorithms', files: {} } },
      { id: 's-inv', title: 'Algorithms Inventory', text: '# Inv', provenance: COURSE_INVENTORY_PROVENANCE, courses: ['Algorithms'], courseInventory: { items: [] } },
    ],
    decks: [
      {
        id: 'd-dp',
        title: 'DP Practice',
        course: 'Algorithms / 02 DP',
        cards: [{ id: 'c-dp-1', kind: 'quiz', topic: 'Optimal Substructure', prompt: 'DP?', answer: 'Yes', citations: [{ sourceId: 's-dp' }] }],
      },
      {
        id: 'd-bio',
        title: 'Bio Practice',
        course: 'Biology',
        cards: [{ id: 'c-bio-1', kind: 'quiz', topic: 'Mitochondria', prompt: 'ATP?', answer: 'Yes', citations: [{ sourceId: 's-bio' }] }],
      },
      {
        id: 'd-uncat',
        title: 'Uncat Deck',
        cards: [{ id: 'c-uncat-1', kind: 'quiz', topic: 'Loose', prompt: 'Loose?', answer: 'Yes' }],
      },
    ],
    drafts: [],
    attempts: [],
  };

  // 1) analyzeAssessmentModes only reads Algorithms + Algorithms / 02 DP active materials
  const analyzed = await analyzeAssessmentModes(state, { course: 'Algorithms' });
  const analyzedSources = analyzed.scopeBoundary?.materialSourceIds || [];
  assert.deepEqual([...analyzedSources].sort(), ['s-algo-cur', 's-dp']);

  // 2) compileCoachGenerationRequest selects only valid course materials (never outline/book/inventory/Biology/historical)
  const spec = normalizeCoachSpec({
    course: 'Algorithms',
    taskFamilies: analyzed.taskFamilies,
  }, 'Algorithms');
  const compiled = compileCoachGenerationRequest(spec, state);
  assert.deepEqual([...compiled.request.sourceIds].sort(), ['s-algo-cur', 's-dp']);
  assert.doesNotThrow(() => assertMaterials(state.sources.filter(s => compiled.request.sourceIds.includes(s.id))));

  // 3) computeCoachEvidence scopes sources and decks strictly to Algorithms + descendants
  const evidence = computeCoachEvidence(state, { course: 'Algorithms', spec });
  assert.equal(evidence.materialCoverage.totalSources, 2);
  assert.equal(evidence.materialCoverage.totalPublishedCards, 1);
});

test('#1307-2: search.content stamps source versions and excludes superseded historical revisions', async t => {
  const root = withTempRoot(t);
  const service = new StudyService(root);
  await service.store.update(state => {
    state.documents = [
      {
        id: 'doc-net',
        title: 'Networking Notes',
        currentRevision: 2,
        versions: [
          { revision: 1, sourceIds: ['src-v1'] },
          { revision: 2, sourceIds: ['src-v2'] },
        ],
      },
    ];
    state.sources = [
      // Note: no persisted `historical` property on either source!
      { id: 'src-v1', title: 'Networking v1', text: 'Contains obsolete_legacy_token_xyz from version one.', courses: ['Networks'] },
      { id: 'src-v2', title: 'Networking v2', text: 'Contains fresh_current_token_abc from version two.', courses: ['Networks'] },
    ];
  });

  // Service-level search.content must NOT return historical revision
  const oldHits = await service.call('search.content', { query: 'obsolete_legacy_token_xyz' });
  assert.equal(oldHits.groups.sources.length, 0, 'historical revision must be excluded from search.content');

  // Current revision IS returned
  const curHits = await service.call('search.content', { query: 'fresh_current_token_abc' });
  assert.equal(curHits.groups.sources.length, 1);
  assert.equal(curHits.groups.sources[0].sourceId, 'src-v2');

  // Direct pure searchLibraryContent also stamps versions
  const rawView = await service.store.read();
  const directOld = await searchLibraryContent(rawView, { query: 'obsolete_legacy_token_xyz' });
  assert.equal(directOld.groups.sources.length, 0);
});

test('#1307-3: retrieval index-plan excludes historical revisions and schedules stale vectors for deletion', async t => {
  const root = withTempRoot(t);
  const libraryId = retrievalRootId(root);
  const state = {
    courses: [{ id: 'c-net', name: 'Networks' }],
    documents: [
      {
        id: 'doc-net',
        title: 'Networking Notes',
        currentRevision: 2,
        versions: [
          { revision: 1, sourceIds: ['src-v1'] },
          { revision: 2, sourceIds: ['src-v2'] },
        ],
      },
    ],
    sources: [
      { id: 'src-v1', title: 'Networking v1', text: 'Old version page body text.', courses: ['Networks'] },
      { id: 'src-v2', title: 'Networking v2', text: 'Current version page body text.', courses: ['Networks'] },
    ],
    decks: [],
    drafts: [],
  };

  // Seed manifest as if src-v1 had been indexed before the document was replaced by v2
  const initialManifest = {
    libraryId,
    keyVersion: INDEX_KEY_VERSION,
    sources: {
      'src-v1': { hash: contentHash('Old version page body text.'), at: new Date().toISOString(), v: INDEX_KEY_VERSION },
    },
  };
  await writeManifest(root, initialManifest);

  const ports = {
    state: {
      root,
      read: async () => state,
    },
  };

  const prepared = await createIndexPlanner(ports).prepare('Networks');
  assert.deepEqual(prepared.picked.map(s => s.id), ['src-v2'], 'only current revision is picked for indexing');
  assert.deepEqual(prepared.plan.add.map(s => s.id), ['src-v2'], 'historical revision is not added');
  assert.deepEqual(prepared.plan.remove, ['src-v1'], 'already-indexed historical revision is scheduled for vector removal');

  // Execute buildIndex with mock port and confirm stale vector deletion is invoked
  const deletedKeys = [];
  const ingestedKeys = [];
  const mockPort = {
    tools: () => [{ name: INDEX_TOOLS.ingest }, { name: INDEX_TOOLS.delete }],
    call: async (tool, payload) => {
      if (tool === INDEX_TOOLS.ingest) ingestedKeys.push(payload.source);
      if (tool === INDEX_TOOLS.delete) deletedKeys.push(payload.source);
      return { ok: true };
    },
  };
  const summary = await buildIndex({
    port: mockPort,
    sources: prepared.picked,
    library: prepared.library,
    manifest: prepared.manifest,
    libraryId: prepared.libraryId,
    save: async m => writeManifest(root, m),
  });
  assert.equal(summary.added, 1);
  assert.equal(summary.removed, 1);
  assert.equal(deletedKeys.length, 1);
  assert.ok(deletedKeys[0].endsWith('/source/src-v1'), `expected delete of src-v1, got ${deletedKeys[0]}`);
  assert.equal(prepared.manifest.sources['src-v1'], undefined, 'manifest removes stale historical source');
  assert.ok(prepared.manifest.sources['src-v2'], 'manifest records current source');
});
