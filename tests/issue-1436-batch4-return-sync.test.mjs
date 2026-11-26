// #1436 Batch 4 Items 2 & 5:
// - Item 2: Top-bar Return / Resume from Guided Study switches back to Review, clears ended chip reactively, and respects nav.leaving() guard.
// - Item 5: Syncing a referenced original never blanks/overwrites converted books, refuses empty projection overwrite, fixes stale revision on refresh, and localizes sync errors coherently.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { Store } from '../lib/store.js';
import { createMaterialsOperations } from '../lib/contexts/materials/operations.js';
import { makeTextPdf } from './helpers/text-pdf.mjs';
import { loadUi } from './helpers/ui-module.mjs';
import { loadInteractiveUi, withBrowserGlobals } from './helpers/react-harness.mjs';

const origUi = await loadUi(`
  export { ORIGINAL_MAX_BYTES, issueOf, explainFailure, canSyncReferencedText } from './ui/document-preview/original-file.js';
`);

test('#1436 Item 2: enterRun stayOnGuided option, lastPracticeVersion reactivity, and nav.leaving guard', async () => {
  const interactive = await loadInteractiveUi(`
    export { useReviewSession } from './ui/review/useReviewSession.js';
    export { useLearningNavigation } from './ui/app/use-learning-navigation.js';
    export { PAGE_VIEWS } from './ui/app/page-views.jsx';
    export { GuidedStudy } from './ui/workspace-views.jsx';
    export { AppContext } from './ui/app/app-context.js';
    export { StudyServicesContext } from './ui/study-context.jsx';
  `);
  const { useReviewSession, useLearningNavigation, PAGE_VIEWS, GuidedStudy, AppContext, StudyServicesContext } = interactive.exports;
  const h = interactive.React.createElement;
  const noop = () => {};

  const memoryStore = new Map();
  const stubStorage = {
    getItem: (key) => (memoryStore.has(key) ? memoryStore.get(key) : null),
    setItem: (key, value) => { memoryStore.set(key, String(value)); },
    removeItem: (key) => { memoryStore.delete(key); },
  };
  const prevStorage = globalThis.localStorage;
  const prevRaf = globalThis.requestAnimationFrame;
  const prevCancelRaf = globalThis.cancelAnimationFrame;
  globalThis.localStorage = stubStorage;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = noop;

  try {
    await withBrowserGlobals(async () => {
      // 1) useReviewSession: enterRun / enterMovedRun default to switching back from 'guided' to 'review' unless stayOnGuided: true
      const pages = [];
      const dataRef = { current: { root: '/lib-1436', settings: {}, focus: { course: null }, sources: [] } };
      const sessionCore = {
        call: async () => ({}),
        act: async () => ({}),
        notify: noop,
        setError: noop,
        refresh: async () => dataRef.current,
        refs: { dataRef, bindingRoot: { current: null } },
      };
      const sessionNav = { page: 'guided', setPage: (p) => pages.push(p), show: { exam: noop } };
      const sessionHook = interactive.mountHook(() => useReviewSession({
        core: sessionCore,
        nav: sessionNav,
        modalOpen: false,
        host: {},
        rootRef: { current: null },
        late: {},
      }));
      try {
        const makeRun = (id) => ({ id, mode: 'path', deckId: 'd1', index: 0, total: 2, card: { id: `c-${id}`, kind: 'open', prompt: `Q ${id}` } });
        await sessionHook.act(() => sessionHook.current.enterRun(makeRun('r1')));
        assert.deepEqual(pages, ['review'], 'enterRun defaults stayOnGuided=false and switches back from guided to review');
        assert.equal(sessionHook.current.run.id, 'r1');

        await sessionHook.act(() => sessionHook.current.enterMovedRun(makeRun('r2')));
        assert.deepEqual(pages, ['review', 'review'], 'enterMovedRun defaults stayOnGuided=false and switches back to review');
        assert.equal(sessionHook.current.run.id, 'r2');

        await sessionHook.act(() => sessionHook.current.enterRun(makeRun('r3'), undefined, false, { stayOnGuided: true }));
        assert.deepEqual(pages, ['review', 'review'], 'enterRun with stayOnGuided: true stays on guided');
        assert.equal(sessionHook.current.run.id, 'r3');

        await sessionHook.act(() => sessionHook.current.enterMovedRun(makeRun('r4'), undefined, { stayOnGuided: true }));
        assert.deepEqual(pages, ['review', 'review'], 'enterMovedRun with stayOnGuided: true stays on guided');
        assert.equal(sessionHook.current.run.id, 'r4');
      } finally {
        sessionHook.unmount();
      }

      // 2) PAGE_VIEWS.guided passes stayOnGuided: true for internal question readiness, reveal, answer, and next updates
      const guidedEnters = [];
      const guidedRun = { id: 'g-run-1', mode: 'path', deckId: 'd1', index: 0, total: 1, card: { id: 'gc-1', kind: 'open', prompt: 'Guided Q' } };
      let sessionPollCount = 0;
      const guidedApp = {
        data: { root: '/lib-1436', modelReady: true, courses: [], activeStudySession: { id: 'gs-1', status: 'active', focus: { kind: 'preparing-card' } } },
        core: {
          call: async (action) => {
            if (action === 'study.session.get') {
              sessionPollCount += 1;
              return sessionPollCount === 1
                ? { id: 'gs-1', status: 'active', focus: { kind: 'preparing-card' } }
                : { id: 'gs-1', status: 'active', focus: { kind: 'card' } };
            }
            if (action === 'study.question.result') return { status: 'ready', run: guidedRun };
            return {};
          },
          act: async (action, args, then) => {
            const nextRun = { ...guidedRun, id: `${guidedRun.id}:${action}` };
            then?.(nextRun);
            return nextRun;
          },
          refresh: async () => {},
          notify: noop,
        },
        session: {
          run: guidedRun,
          actions: {},
          enterRun: (next, input, moved, opts) => { guidedEnters.push({ id: next?.id, moved, opts }); },
        },
        lib: { guidedSession: { id: 'gs-1', status: 'active', focus: { kind: 'preparing-card' } } },
        set: { setGuidedSession: noop },
        nav: { navigate: noop },
        host: {},
      };
      const guidedMount = interactive.mount(() => h(
        StudyServicesContext.Provider,
        { value: { busy: false, call: guidedApp.core.call, act: guidedApp.core.act, host: {} } },
        h(AppContext.Provider, { value: guidedApp }, h(PAGE_VIEWS.guided)),
      ));
      try {
        await guidedMount.flush(6);
        assert.ok(guidedEnters.some((e) => e.id === 'g-run-1' && e.opts?.stayOnGuided === true), 'GuidedStudyView onReady passes stayOnGuided: true');
        const guidedNode = guidedMount.find((n) => n.type === GuidedStudy);
        assert.ok(guidedNode, 'PAGE_VIEWS.guided renders GuidedStudy');
        await guidedMount.act(() => guidedNode.props.onReveal('g-run-1'));
        await guidedMount.act(() => guidedNode.props.onAnswer({ grade: 4 }));
        await guidedMount.act(() => guidedNode.props.onNext('g-run-1'));
        for (const action of ['review.reveal', 'review.answer', 'review.move']) {
          assert.ok(
            guidedEnters.some((e) => e.id === `g-run-1:${action}` && e.opts?.stayOnGuided === true),
            `GuidedStudyView ${action} passes stayOnGuided: true`,
          );
        }
      } finally {
        guidedMount.unmount();
      }

      // 3) useLearningNavigation: lastPractice reacts to save/clear (lastPracticeVersion) and all 4 return/resume entry points guard via nav.leaving
      const navCalls = [];
      let allowLeaving = false;
      const leavingCalls = [];
      const enteredRuns = [];
      const enteredMoved = [];
      const navDataRef = { current: { root: '/lib-nav', focus: { course: null }, sources: [] } };
      const navCore = {
        call: async (action, args) => {
          navCalls.push({ action, args });
          if (action === 'review.get') {
            if (args.runId === 'run-ended') return { id: 'run-ended', complete: true };
            return { id: args.runId, deckId: 'd1', index: 0, total: 2, card: { id: 'c1', prompt: 'Q1' } };
          }
          if (action === 'review.start') return { id: 'run-again', deckId: 'd1', index: 0, total: 1, card: { id: 'c1', prompt: 'Q1' } };
          return {};
        },
        setError: noop,
        notify: noop,
        refresh: async () => navDataRef.current,
        refs: { dataRef: navDataRef, epoch: { current: 1 }, navigation: { current: 0 }, examLocation: { current: null } },
      };

      const activeRun = { id: 'run-1', deckId: 'd1', index: 0, total: 2, card: { id: 'c1', prompt: 'Q1' } };
      let currentRun = activeRun;
      const navHook = interactive.mountHook(({ run }) => {
        const [modal, setModal] = interactive.React.useState(null);
        const [contextTrail, setContextTrail] = interactive.React.useState([]);
        const [practiceStack, setPracticeStack] = interactive.React.useState([]);
        const [practiceEnded, setPracticeEnded] = interactive.React.useState(null);
        const [focusRequest, setFocusRequest] = interactive.React.useState(null);
        const [detour, setDetour] = interactive.React.useState(null);
        const nav = {
          page: 'guided',
          navigate: noop,
          referenceRef: { current: null },
          leaving: (proceed) => {
            leavingCalls.push(allowLeaving);
            if (allowLeaving) proceed();
          },
          show: { note: noop, skeleton: noop, deck: noop, managedDeck: noop, workflow: noop, exam: noop, library: noop, page: noop },
        };
        const lib = {
          state: { modal, contextTrail, practiceStack, practiceEnded, focusRequest, detour },
          set: { setModal, setContextTrail, setPracticeStack, setPracticeEnded, setFocusRequest, setDetour },
        };
        const session = {
          run,
          entry: {},
          flushDraft: async () => true,
          enterRun: (next) => { enteredRuns.push(next); },
          enterMovedRun: (next) => { enteredMoved.push(next); },
        };
        return useLearningNavigation({ core: navCore, lib, nav, session, rootRef: { current: null } });
      }, { run: currentRun });

      try {
        assert.equal(navHook.current.lastPractice?.runId, 'run-1', 'active run persists lastPractice reactively');

        // Completing the run clears lastPracticePosition and bumps lastPracticeVersion so lastPractice updates to null reactively
        currentRun = { ...activeRun, complete: true };
        navHook.rerender({ run: currentRun });
        assert.equal(navHook.current.lastPractice, null, 'completing run clears lastPractice reactively');

        // Push a practice frame for an ended run, then clear stack so resumeLastPractice can be tested
        currentRun = { id: 'run-ended', deckId: 'd1', index: 0, total: 2, card: { id: 'c1', prompt: 'Q1' } };
        navHook.rerender({ run: currentRun });
        assert.equal(navHook.current.lastPractice?.runId, 'run-ended');

        allowLeaving = true;
        await navHook.act(() => navHook.current.resumeLastPractice());
        assert.equal(navHook.current.lastPractice, null, 'ended run restore clears lastPractice reactively');
        assert.equal(navHook.current.practiceEnded?.status, 'ended');

        // Now set up an active stack + stored lastPractice and verify all 4 return/resume callbacks obey nav.leaving(...)
        navCalls.length = 0;
        leavingCalls.length = 0;
        enteredRuns.length = 0;
        enteredMoved.length = 0;
        currentRun = activeRun;
        navHook.rerender({ run: currentRun });
        await navHook.act(() => navHook.current.pushPracticeContext({ originKind: 'other' }));
        assert.equal(navHook.current.practiceStack.length, 1);

        // When nav.leaving blocks, none of the 4 callbacks may fire backend calls
        allowLeaving = false;
        await navHook.act(() => navHook.current.returnFromPracticeStack());
        await navHook.act(() => navHook.current.returnToOriginalPractice());
        await navHook.act(() => navHook.current.resumeLastPractice());
        await navHook.act(() => navHook.current.practiceEndedAgain([{ deckId: 'd1', cardId: 'c1' }]));
        assert.equal(leavingCalls.length, 4, 'all 4 return/resume entry points invoke nav.leaving');
        assert.equal(navCalls.length, 0, 'blocking nav.leaving prevents all 4 entry points from navigating');

        // When nav.leaving allows, each of the 4 callbacks executes its backend restore/start
        allowLeaving = true;
        await navHook.act(() => navHook.current.returnFromPracticeStack());
        assert.equal(enteredMoved.length, 1, 'returnFromPracticeStack restores frame when nav.leaving allows');

        await navHook.act(() => navHook.current.pushPracticeContext({ originKind: 'other' }));
        await navHook.act(() => navHook.current.returnToOriginalPractice());
        assert.equal(enteredMoved.length, 2, 'returnToOriginalPractice restores original frame when nav.leaving allows');

        await navHook.act(() => navHook.current.resumeLastPractice());
        assert.equal(enteredMoved.length, 3, 'resumeLastPractice restores saved position when nav.leaving allows');

        await navHook.act(() => navHook.current.practiceEndedAgain([{ deckId: 'd1', cardId: 'c1' }]));
        assert.equal(enteredRuns.length, 1, 'practiceEndedAgain starts a fresh practice run when nav.leaving allows');
        assert.equal(enteredRuns[0].id, 'run-again');
      } finally {
        navHook.unmount();
      }
    });
  } finally {
    if (prevStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = prevStorage;
    if (prevRaf === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = prevRaf;
    if (prevCancelRaf === undefined) delete globalThis.cancelAnimationFrame;
    else globalThis.cancelAnimationFrame = prevCancelRaf;
  }
});

test('#1436 Item 5a: refreshing a referenced converted PDF refuses silent pdf-parse overwrite and preserves converted pages', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'studyhub-1436-item5-conv-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const pdfPath = join(dir, 'scanned-book.pdf');
  const fakePdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'utf8');
  writeFileSync(pdfPath, fakePdf);
  const st = statSync(pdfPath);
  const real = realpathSync(pdfPath);
  const hash = createHash('sha256').update(fakePdf).digest('hex');

  const service = new StudyService(dir);
  t.after(() => service.dispose());

  await service.store.update((s) => {
    s.sources ||= [];
    s.documents ||= [];
    s.sources.push({
      id: 'conv-doc-rev1-p1',
      title: '高数扫描教材 · 第 1 页',
      text: '# 第 1 章 极限\n\n$$\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1$$',
      createdAt: '2026-11-24T00:00:00.000Z',
      importedAt: '2026-11-24T00:00:00.000Z',
      courses: ['高等数学'],
      document: {
        materialId: 'conv-doc',
        materialRevision: 'abc123-pdf-conv3',
        format: 'pdf',
        filename: 'scanned-book.pdf',
        page: 1,
        bookTitle: '高数扫描教材',
      },
    });
    s.documents.push({
      id: 'conv-doc',
      format: 'pdf',
      filename: 'scanned-book.pdf',
      title: '高数扫描教材',
      currentRevision: 'abc123-pdf-conv3',
      externalPath: pdfPath,
      versions: [
        {
          revision: 'abc123-pdf-conv3',
          attachment: null,
          external: {
            path: pdfPath,
            realPath: real,
            bytes: fakePdf.length,
            mtimeMs: st.mtimeMs,
            hash,
            format: 'pdf',
            verifiedAt: '2026-11-24T00:00:00.000Z',
          },
          sourceIds: ['conv-doc-rev1-p1'],
          importedAt: '2026-11-24T00:00:00.000Z',
          totalPages: 1,
        },
      ],
    });
  });

  // Attempt refresh=true on a converted book -> MUST refuse instead of blanking/overwriting with pdf-parse!
  await assert.rejects(
    service.call('materials.document.get', { id: 'conv-doc', refresh: true }),
    /转换|不能.*覆盖|重新绑定|重新转换/,
    'refreshing a converted book must refuse silent built-in extractor overwrite',
  );

  // Verify original converted content & revision are completely untouched
  const after = await service.call('materials.document.get', { id: 'conv-doc' });
  assert.equal(after.revision, 'abc123-pdf-conv3');
  assert.equal(after.sources.length, 1);
  assert.match(after.sources[0].text, /\\lim_\{x \\to 0\}/);
});

test('#1436 Item 5b: refreshing a referenced markdown file with an explicit old revision returns the NEW revision and refuses empty overwrite', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'studyhub-1436-item5-md-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const mdPath = join(dir, 'notes.md');
  const v1 = Buffer.from('# Chapter 1\n\nInitial version of study notes with enough content.\n', 'utf8');
  writeFileSync(mdPath, v1);
  const st1 = statSync(mdPath);
  const hash1 = createHash('sha256').update(v1).digest('hex');

  const service = new StudyService(dir);
  t.after(() => service.dispose());

  await service.store.update((s) => {
    s.sources ||= [];
    s.documents ||= [];
    s.sources.push({
      id: 'md-doc-rev1-s1',
      title: 'notes.md',
      text: v1.toString('utf8'),
      createdAt: '2026-11-24T00:00:00.000Z',
      importedAt: '2026-11-24T00:00:00.000Z',
      courses: ['CS'],
      document: { materialId: 'md-doc', materialRevision: 'rev1', format: 'md', filename: 'notes.md' },
    });
    s.documents.push({
      id: 'md-doc',
      format: 'md',
      filename: 'notes.md',
      title: 'notes.md',
      currentRevision: 'rev1',
      externalPath: mdPath,
      versions: [
        {
          revision: 'rev1',
          attachment: null,
          external: {
            path: mdPath,
            realPath: realpathSync(mdPath),
            bytes: v1.length,
            mtimeMs: st1.mtimeMs,
            hash: hash1,
            format: 'md',
            verifiedAt: '2026-11-24T00:00:00.000Z',
          },
          sourceIds: ['md-doc-rev1-s1'],
          importedAt: '2026-11-24T00:00:00.000Z',
        },
      ],
    });
  });

  // Update file on disk to v2 and call materials.document.get with stale args.revision='rev1' + refresh:true
  const v2 = Buffer.from('# Chapter 1\n\nUpdated version 2 of study notes with new paragraph.\n', 'utf8');
  writeFileSync(mdPath, v2);
  const refreshed = await service.call('materials.document.get', { id: 'md-doc', revision: 'rev1', refresh: true });
  assert.notEqual(refreshed.revision, 'rev1', 'refresh must return the NEW currentRevision, not stale args.revision');
  assert.match(refreshed.sources[0].text, /Updated version 2/);
});

test('#1436 Item 5c: UI helpers disable sync for converted/oversized docs and localize sync limit error coherently', () => {
  assert.equal(typeof origUi.canSyncReferencedText, 'function', 'canSyncReferencedText must be exported');
  assert.equal(
    origUi.canSyncReferencedText({ revision: 'abc-pdf-conv3', original: { mode: 'reference', bytes: 1024 } }),
    false,
    'converted document must not allow built-in text sync',
  );
  assert.equal(
    origUi.canSyncReferencedText({
      revision: 'abc-pdf-text2',
      original: { mode: 'reference', bytes: origUi.ORIGINAL_MAX_BYTES + 1024 },
    }),
    false,
    'oversized referenced document must not render doomed sync button',
  );
  assert.equal(
    origUi.canSyncReferencedText({
      revision: 'abc-md-md2',
      original: { mode: 'reference', bytes: 4096 },
    }),
    true,
    'normal small referenced document allows sync',
  );

  const issue = origUi.issueOf({ mode: 'reference', status: 'changed', path: '/tmp/a.pdf' }, { canSyncText: false });
  assert.equal(issue.canSync, false, 'issueOf must suppress canSync when canSyncText is false');

  const syncErr = origUi.explainFailure('Document must be a file of at most 40 MB', { context: 'sync' });
  assert.doesNotMatch(syncErr, /复制进资料库/, 'sync context must not emit contradictory copy-limit message');
  assert.match(syncErr, /40 MB/);
});

test('#1436 Item 5d: renaming an ordinary referenced PDF does not turn it into a "deeply converted" book: syncing stays offered and accepted; a converted version is still refused', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studyhub-1436-item5-rename-'));
  const outside = await mkdtemp(join(tmpdir(), 'studyhub-1436-item5-rename-files-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });
  const store = new Store(root);
  const ops = createMaterialsOperations({
    root,
    read: async () => { const state = await store.read(); return structuredClone({ sources: state.sources, documents: state.documents || [] }); },
    update: (fn) => store.update(async (state) => {
      const own = { sources: state.sources, documents: state.documents || [] };
      const result = await fn(own); state.sources = own.sources; state.documents = own.documents; return result;
    }),
  });
  const call = (action, args = {}) => ops.handlers[action](args, {});

  // An ordinary text PDF whose original is attached ONLY by reference (the by-path import).
  const pdfPath = join(outside, 'Lecture.pdf');
  const v1 = await makeTextPdf([['Virtual memory isolates address spaces across processes in modern kernels.'], ['Paging splits memory into fixed size frames for every process.']]);
  await writeFile(pdfPath, v1);
  const imported = await call('materials.document.import', { filename: 'Lecture.pdf', dataBase64: v1.toString('base64') });
  await store.update((state) => { for (const doc of state.documents) { delete doc.externalPath; for (const ver of doc.versions) ver.attachment = null; } });
  await rm(join(root, 'attachments'), { recursive: true, force: true });
  assert.equal((await call('materials.original.attach', { documentId: imported.documentId, path: pdfPath, mode: 'reference' })).status, 'attached');

  // Renaming writes `bookTitle` onto every paged source (lib/document-title.js) - ordinary PDFs included.
  const renamed = await call('materials.document.rename', { documentId: imported.documentId, title: 'Lecture notes, week 1' });
  assert.equal(renamed.status, 'renamed');
  const state = await store.read();
  assert.ok(state.sources.every((source) => source.document.bookTitle === 'Lecture notes, week 1'), 'the rename wrote bookTitle on the ordinary pages');

  // The reader still offers the sync button for what it is shown...
  const shown = await call('materials.document.get', { documentId: imported.documentId });
  assert.equal(origUi.canSyncReferencedText({ ...shown, original: { mode: 'reference', bytes: 4096 } }), true, 'a renamed ordinary PDF is not a converted book to the reader');

  // ...and the backend accepts it: a changed file on disk is synced.
  const v2 = await makeTextPdf([['Virtual memory isolates address spaces across processes in modern kernels.'], ['Segmentation was replaced by paging in this second edition of the notes.']]);
  await writeFile(pdfPath, v2);
  const synced = await call('materials.document.get', { documentId: imported.documentId, refresh: true });
  assert.notEqual(synced.revision, shown.revision, 'the sync stored a new revision');
  assert.ok(synced.sources.some((source) => /second edition/.test(source.text)), 'the new file content is what the reader shows');

  // A converted version (its pages are marked as converter output) is still refused, with its pages untouched.
  await store.update((s) => { for (const source of s.sources) source.document.origin = 'converted'; });
  const beforeRefusal = await call('materials.document.get', { documentId: imported.documentId });
  assert.equal(origUi.canSyncReferencedText({ ...beforeRefusal, original: { mode: 'reference', bytes: 4096 } }), false, 'the reader hides sync for pages marked converted');
  await assert.rejects(call('materials.document.get', { documentId: imported.documentId, refresh: true }), /转换|不能.*覆盖|重新绑定|重新转换/);
});

test('#1436 Item 5e: the empty-projection guard belongs to a text sync; an ordinary re-import of the learner\'s own file is still theirs to make', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'studyhub-1436-item5-reimport-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  t.after(() => service.dispose());
  const call = (name, args) => service.call(name, args);

  const first = Buffer.from('# 笔记\n\n第一版正文，读了能用的那一段。\n', 'utf8');
  const imported = await call('materials.document.import', { filename: 'notes.md', dataBase64: first.toString('base64') });
  const before = await call('materials.document.get', { documentId: imported.documentId });
  assert.ok(before.sources.length > 0, 'the first import holds readable pages');

  // Replacing the file with a version that extracts no text (a scan of the same chapter, say) is an ordinary re-import of the learner's file,
  // not a silent text sync: it is accepted, and the sync path keeps its guard (see 5b).
  const scanned = Buffer.from('   \n\n', 'utf8');
  const replaced = await call('materials.document.import', { documentId: imported.documentId, filename: 'notes.md', dataBase64: scanned.toString('base64') });
  assert.notEqual(replaced.revision, imported.revision, 'the re-import makes its own revision');
  const after = await call('materials.document.get', { documentId: imported.documentId });
  assert.equal(after.revision, replaced.revision, 'the re-imported version is current');
  assert.equal(after.sources.length, 0, 'the scanned version holds no extracted text, as the learner chose');
});
