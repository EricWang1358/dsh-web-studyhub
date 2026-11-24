// Second-Round Review Track 1 (P0 #1, P0 #2, P1 #4, P1 #5):
// - P0 #1: Export default filenames with context slug + timestamp + never-overwrite (-2/-3)
// - P0 #2: --export & WorkspaceTab backup path sandbox strictly under <libraryRoot>/backups/
// - P1 #4: BookEditModal Esc dirty confirmation (PTY E2E + marked-free chunk check)
// - P1 #5: Batch operations exceeding backend 100/200 caps (DeckManageModal, SourcesView, OrganizeSourcesModal)
// `node --test tests/r2-p0-export-batch.test.mjs`
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { render } from 'ink';
import React from 'react';
import { register, tsImport } from 'tsx/esm/api';
import { StudyService } from '../../../lib/service.js';
import { courseOutlineMaterial, materialsFingerprint } from '../../../lib/course-outline-book.js';
import { courseNotesMaterial } from '../../../lib/course-book.js';
import { buildOutlineIndex } from '../../../lib/course-outline-index.js';
import { groupSourcesByDocument } from '../../../lib/source-groups.js';
import { openCourseBook } from '../../../lib/course-book-files.js';
import {
  createTempTracker,
  createVirtualTty,
  disposeTerminalPool,
  distDir,
  loadDistRuntime,
  pkgRoot,
} from './helpers/virtual-tty.mjs';

const execFileAsync = promisify(execFile);
const unregisterTsx = register();

const runtime = await loadDistRuntime();
const { StudyHubTuiApp, createTuiHost, saveTuiPreferences } = runtime;

const distFiles = (await readdir(distDir)).filter((f) => f.endsWith('.mjs') && f !== 'cli.mjs');
const storeFile = distFiles.find((f) => f.startsWith('store-') && f.endsWith('.mjs'));
assert.ok(storeFile, 'dist/ must include store-*.mjs');
const { useTuiStore, DEFAULT_PREFERENCES } = await import(pathToFileURL(join(distDir, storeFile)).href);

const [
  atomicWriteMod,
  deckExportMod,
  workspaceTabMod,
  deckManageMod,
  sourcesViewMod,
  organizeMod,
] = await Promise.all([
  tsImport('../src/host/atomic-write.ts', import.meta.url),
  tsImport('../src/views/library/deck-export.ts', import.meta.url),
  tsImport('../src/views/settings/WorkspaceTab.tsx', import.meta.url),
  tsImport('../src/views/library/DeckManageModal.tsx', import.meta.url),
  tsImport('../src/views/sources/SourcesView.tsx', import.meta.url),
  tsImport('../src/views/sources/OrganizeSourcesModal.tsx', import.meta.url),
]);

const {
  atomicWriteExportJson,
  atomicWriteExportText,
  defaultBackupFilePath,
  resolveSafeBackupExportPath,
} = atomicWriteMod;
const { exportDeckToMarkdown } = deckExportMod;
const { defaultBackupPath, resolveBackupPath } = workspaceTabMod;
const {
  CARD_BATCH_MAX,
  chunkItems,
  executeBatchLink,
  executeBatchSlay,
  executeBatchTopicUpdate,
} = deckManageMod;
const {
  SOURCE_BATCH_MAX,
  executeBatchSourceArchive,
  executeBatchSourceFolderSet,
  executeBatchSourceRemove,
} = sourcesViewMod;
const {
  MAX_ORGANIZE_SUGGEST_SOURCES,
  collectOrganizeSourceIds,
  validateOrganizeBatchSize,
} = organizeMod;

const PREV_DSH_HOME = process.env.DSH_HOME;
const temps = createTempTracker('studyhub-r2-p0-');

after(async () => {
  disposeTerminalPool();
  unregisterTsx?.();
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await temps.cleanup();
});

function cleanTestEnv(overrides = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/(?:_API_KEY|_TOKEN|_SECRET|_ACCESS_KEY)$/i.test(k)) delete env[k];
  }
  return { ...env, ...overrides };
}

function resetTuiStore(language = 'zh', asciiMode = false) {
  useTuiStore.setState({
    page: 'library',
    navContext: {},
    history: [],
    snapshot: null,
    binding: null,
    config: null,
    desktopConfig: null,
    loading: false,
    refreshing: false,
    lastError: null,
    toasts: [],
    footerHints: [],
    commandPaletteOpen: false,
    helpOpen: false,
    coursePickerOpen: false,
    inboxOpen: false,
    voicePackOpen: false,
    showLaunchpad: false,
    inputCaptured: false,
    activeRunId: null,
    preferences: {
      ...DEFAULT_PREFERENCES,
      recentCommands: [...DEFAULT_PREFERENCES.recentCommands],
      language,
      asciiMode,
    },
  });
}

describe('P0 #1: Export filenames include context slug + timestamp and never overwrite', () => {
  test('1) exportDeckToMarkdown produces distinct slugged files for different decks and -2 suffix on same-second collision', async () => {
    const libRoot = await temps.make('deck-export');

    const r1 = await exportDeckToMarkdown({
      libraryRoot: libRoot,
      deck: { id: 'd1', title: 'Operating Systems', course: 'CS162', cards: [{ prompt: 'Q1', answer: 'A1' }] },
      lang: 'en',
    });
    const r2 = await exportDeckToMarkdown({
      libraryRoot: libRoot,
      deck: { id: 'd2', title: '操作系统 · 第一章', course: 'CS162', cards: [{ prompt: 'Q2', answer: 'A2' }] },
      lang: 'zh',
    });
    // Export the exact same deck again immediately (same second / collision path) -> must get -2 suffix
    const r1Again = await exportDeckToMarkdown({
      libraryRoot: libRoot,
      deck: { id: 'd1', title: 'Operating Systems', course: 'CS162', cards: [{ prompt: 'Q1-v2', answer: 'A1-v2' }] },
      lang: 'en',
    });

    assert.notEqual(r1.targetPath, r2.targetPath);
    assert.notEqual(r1.targetPath, r1Again.targetPath);
    assert.match(r1.targetPath, /studyhub-deck-Operating-Systems-\d{4}-\d{2}-\d{2}-\d{6}\.md$/);
    assert.match(r2.targetPath, /studyhub-deck-操作系统-·-第一章-\d{4}-\d{2}-\d{2}-\d{6}\.md$/);
    assert.match(r1Again.targetPath, /studyhub-deck-Operating-Systems-\d{4}-\d{2}-\d{2}-\d{6}(?:-2)?\.md$/);

    const c1 = await readFile(r1.targetPath, 'utf8');
    const c2 = await readFile(r2.targetPath, 'utf8');
    const c1Again = await readFile(r1Again.targetPath, 'utf8');
    assert.ok(c1.includes('Q1'), 'first export must remain intact and never overwritten');
    assert.ok(c2.includes('Q2'));
    assert.ok(c1Again.includes('Q1-v2'));
  });

  test('2) defaultBackupFilePath + atomicWriteExportText/Json never overwrite across rapid consecutive calls', async () => {
    const libRoot = await temps.make('rapid-export');
    const fixed = new Date(2026, 10, 23, 9, 30, 15);
    const targetMd = defaultBackupFilePath(libRoot, 'studyhub-report', 'md', 'CS 101', fixed);
    assert.equal(targetMd, join(libRoot, 'backups', 'studyhub-report-CS-101-2026-11-23-093015.md'));

    const w1 = await atomicWriteExportText(targetMd, 'first report\n');
    const w2 = await atomicWriteExportText(targetMd, 'second report\n');
    const w3 = await atomicWriteExportText(targetMd, 'third report\n');

    assert.equal(w1.path, targetMd);
    assert.equal(w2.path, join(libRoot, 'backups', 'studyhub-report-CS-101-2026-11-23-093015-2.md'));
    assert.equal(w3.path, join(libRoot, 'backups', 'studyhub-report-CS-101-2026-11-23-093015-3.md'));
    assert.equal(await readFile(w1.path, 'utf8'), 'first report\n');
    assert.equal(await readFile(w2.path, 'utf8'), 'second report\n');
    assert.equal(await readFile(w3.path, 'utf8'), 'third report\n');

    const targetJson = defaultBackupFilePath(libRoot, 'studyhub-inbox', 'json', 'unread', fixed);
    const j1 = await atomicWriteExportJson(targetJson, [{ id: '1' }]);
    const j2 = await atomicWriteExportJson(targetJson, [{ id: '2' }]);
    assert.equal(j1.path, join(libRoot, 'backups', 'studyhub-inbox-unread-2026-11-23-093015.json'));
    assert.equal(j2.path, join(libRoot, 'backups', 'studyhub-inbox-unread-2026-11-23-093015-2.json'));
  });

  test('3) Static check: all owned export callers use atomicWriteExportText/Json and pass context slug', async () => {
    const ownedTextExportCallers = [
      'src/views/library/deck-export.ts',
      'src/views/dashboard/DashboardView.tsx',
      'src/views/exam/ExamSetup.tsx',
      'src/views/examcoach/ExamCoachView.tsx',
      'src/views/examprep/ExamPrepView.tsx',
      'src/views/generate/DraftEditor.tsx',
      'src/views/notes/NotesView.tsx',
      'src/views/skeleton/SkeletonView.tsx',
      'src/views/sources/SourcesView.tsx',
      'src/views/tasks/TasksView.tsx',
      'src/views/wrongbook/WrongBookView.tsx',
      'src/views/book/BookExportModal.tsx',
    ];
    for (const rel of ownedTextExportCallers) {
      const code = fs.readFileSync(join(pkgRoot, rel), 'utf8');
      assert.ok(
        code.includes('atomicWriteExportText'),
        `${rel} must write exports via atomicWriteExportText (never overwrite)`,
      );
      assert.ok(
        code.includes('defaultBackupFilePath'),
        `${rel} must construct default export paths via defaultBackupFilePath`,
      );
    }
    for (const rel of ['src/shell/InboxModal.tsx', 'src/views/settings/WorkspaceTab.tsx', 'src/cli-commands.ts']) {
      const code = fs.readFileSync(join(pkgRoot, rel), 'utf8');
      assert.ok(
        code.includes('atomicWriteExportJson'),
        `${rel} must write JSON exports via atomicWriteExportJson`,
      );
    }
  });
});

describe('P0 #2: --export & WorkspaceTab backup path sandbox under <libraryRoot>/backups/', () => {
  test('1) resolveSafeBackupExportPath & WorkspaceTab resolveBackupPath reject traversal/absolute paths and contain inside backups/', () => {
    const libRoot = resolve('/tmp/studyhub-sandbox-lib');
    const def = defaultBackupPath(libRoot);
    assert.ok(def.startsWith(join(libRoot, 'backups', 'studyhub-backup-')));
    assert.match(def, /studyhub-backup-\d{4}-\d{2}-\d{2}-\d{6}\.json$/);

    assert.equal(resolveBackupPath('   ', libRoot), '');
    assert.equal(resolveBackupPath('snap-one', libRoot), join(libRoot, 'backups', 'snap-one.json'));
    assert.equal(resolveBackupPath('backups/nested/snap.json', libRoot), join(libRoot, 'backups', 'nested', 'snap.json'));
    assert.equal(resolveBackupPath(def, libRoot), def);

    const evilInputs = [
      '/tmp/evil.json',
      '/etc/passwd',
      '../escape.json',
      'sub/../../escape.json',
      'C:\\evil.json',
      'D:/evil.json',
      '\\\\server\\share\\evil.json',
      '~/outside.json',
    ];
    for (const evil of evilInputs) {
      assert.throws(
        () => resolveSafeBackupExportPath(libRoot, evil, 'studyhub-backup', '.json'),
        /Unsafe export path/,
        `resolveSafeBackupExportPath must reject ${evil}`,
      );
      assert.throws(
        () => resolveBackupPath(evil, libRoot),
        /Unsafe export path/,
        `WorkspaceTab resolveBackupPath must reject ${evil}`,
      );
    }
  });

  test('2) CLI dist/cli.mjs --export rejects unsafe paths (exit non-zero, 0 writes) and allows relative paths in backups/', async () => {
    const base = await temps.make('cli-export-sandbox');
    const libDir = join(base, 'lib');
    const dshDir = join(base, 'dsh');
    const outsideTarget = join(base, 'evil-outside.json');
    await Promise.all([mkdir(libDir, { recursive: true }), mkdir(dshDir, { recursive: true })]);

    const cliPath = join(distDir, 'cli.mjs');
    const env = cleanTestEnv({ DSH_HOME: dshDir });

    for (const badArg of [outsideTarget, '../evil-outside.json', 'C:\\evil.json']) {
      await assert.rejects(
        () => execFileAsync(process.execPath, [cliPath, '--library', libDir, '--export', badArg], { env, timeout: 15_000 }),
        (err) => err && typeof err.code === 'number' && err.code !== 0,
        `CLI --export must exit non-zero for unsafe path ${badArg}`,
      );
      assert.equal(existsSync(outsideTarget), false, `must not create ${outsideTarget}`);
      assert.equal(existsSync(resolve(libDir, '..', 'evil-outside.json')), false);
    }

    const res1 = await execFileAsync(
      process.execPath,
      [cliPath, '--library', libDir, '--export', 'my-backup.json', '--json'],
      { env, timeout: 15_000 },
    );
    const parsed1 = JSON.parse(res1.stdout);
    assert.equal(parsed1.ok, true);
    assert.equal(parsed1.path, join(libDir, 'backups', 'my-backup.json'));
    assert.equal(existsSync(parsed1.path), true);

    const res2 = await execFileAsync(
      process.execPath,
      [cliPath, '--library', libDir, '--export', 'my-backup.json', '--json'],
      { env, timeout: 15_000 },
    );
    const parsed2 = JSON.parse(res2.stdout);
    assert.equal(parsed2.ok, true);
    assert.equal(parsed2.path, join(libDir, 'backups', 'my-backup-2.json'));
    assert.equal(existsSync(parsed2.path), true);
    assert.equal(existsSync(parsed1.path), true);
  });
});

describe('P1 #4: BookEditModal Esc dirty confirmation (PTY E2E + bundle isolation)', () => {
  async function seedEditableBookLibrary(root, course) {
    await mkdir(root, { recursive: true });
    const service = new StudyService(root);
    await service.call('snapshot');
    await service.store.update((state) => {
      state.sources.push({
        id: 'doc1-p1',
        title: 'Lecture 1 · p. 1',
        createdAt: '2026-10-01T00:00:00.000Z',
        courses: [course],
        text: 'Circuit breakers trip open when downstream failure rate crosses threshold.',
        document: {
          materialId: 'doc-l1',
          page: 1,
          totalPages: 1,
          format: 'pdf',
          origin: 'converted',
          converter: 'marker',
          filename: 'lecture-1.pdf',
          chapter: { index: 0, title: 'Circuit Breaker', level: 1 },
          extractionVersion: 2,
        },
      });
      state.focus = { mode: 'class', course, role: '', jd: '', targetTopics: [] };
      const lecture = groupSourcesByDocument(state.sources).find((item) => item.sourceIds.includes('doc1-p1')).key;
      const outlineNodes = [
        {
          id: 'ch1',
          title: 'Resilience Patterns',
          children: [{ id: 'breaker', title: 'Circuit Breaker', anchors: [`${lecture}#0`] }],
        },
      ];
      const allLeaves = outlineNodes.flatMap((ch) => ch.children);
      const outline = {
        ...courseOutlineMaterial({
          title: `Outline · ${course}`,
          course,
          orderBasis: { codes: ['numbering'] },
          fingerprint: materialsFingerprint(buildOutlineIndex(state, { course }).allDocuments),
          nodes: outlineNodes,
          other: { anchors: [] },
          counts: { units: allLeaves.length, leftover: 0, invalid: 0, repeated: 0 },
        }),
        createdAt: '2026-10-09T00:00:00.000Z',
      };
      state.sources.push(outline);
      state.sources.push({
        ...courseNotesMaterial({
          title: `Review Book · ${course}`,
          course,
          outlineId: outline.id,
          language: 'zh',
          papers: [],
          counts: {},
          leaves: allLeaves.map((leaf) => ({
            ...leaf,
            body: {
              fingerprint: 'b'.repeat(16),
              points: [`${leaf.title} core mechanism [^1].`],
              explain: 'Initial book body text.',
              cites: [{ n: 1, sourceId: 'doc1-p1', quote: 'Circuit', start: 0, end: 7 }],
            },
          })),
        }),
        createdAt: '2026-10-09T01:00:00.000Z',
      });
      openCourseBook(state, { course });
    });
    await service.dispose();
  }

  test('1) BookEditModal chunk in dist/ stays marked-free and uses ConfirmDialog directly', () => {
    const editChunk = distFiles.find((f) => f.startsWith('BookEditModal-') && f.endsWith('.mjs'));
    assert.ok(editChunk, 'dist/ must emit lazy BookEditModal-*.mjs chunk');
    const chunkCode = fs.readFileSync(join(distDir, editChunk), 'utf8');
    assert.equal(/\bmarked\b/.test(chunkCode), false, `${editChunk} must remain marked-free`);
    assert.equal(/\bcli-highlight\b/.test(chunkCode), false, `${editChunk} must not bundle cli-highlight`);
  });

  test('2) PTY E2E: !dirty Esc closes immediately; dirty Esc -> ConfirmDialog -> n preserves edits -> Esc + y discards & closes', async () => {
    const course = 'EditGuardCourse';
    const base = await temps.make('book-edit-pty');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');
    await seedEditableBookLibrary(libraryRoot, course);
    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });
    resetTuiStore('zh', false);

    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'zh',
    });
    const tty = createVirtualTty(120, 36);
    let inkInstance = null;

    try {
      inkInstance = render(React.createElement(StudyHubTuiApp, { host, asciiMode: false }), {
        stdin: tty.stdin,
        stdout: tty.stdout,
        stderr: tty.stderr,
        interactive: true,
        exitOnCtrlC: false,
        patchConsole: false,
      });
      await tty.firstFramePromise;
      await tty.waitFor(
        (s) => Boolean(useTuiStore.getState().snapshot) && s.includes(course),
        { timeoutMs: 10_000, label: 'snapshot loaded' },
      );

      // Navigate to BookView (7) and wait for TOC leaf
      tty.send('7');
      await tty.waitFor(
        (s) => useTuiStore.getState().page === 'book' && s.includes('Circuit Breaker') && !s.includes('正在打开复习全书'),
        { timeoutMs: 10_000, label: 'BookView rendered' },
      );

      // Move to leaf node Circuit Breaker and open BookEditModal
      tty.send('j');
      await tty.flush(50);
      tty.send('e');
      await tty.waitFor(
        (s) => s.includes('编辑复习全书') && s.includes('breaker.gen.md') && !s.includes('正在读取本节文件'),
        { timeoutMs: 10_000, label: 'BookEditModal opened for leaf' },
      );

      // Clean (!dirty) Esc closes immediately without ConfirmDialog
      tty.send('\x1b');
      await tty.waitFor(
        (s) => !s.includes('编辑复习全书') && s.includes('Circuit Breaker'),
        { timeoutMs: 8_000, label: '!dirty Esc closes BookEditModal immediately' },
      );

      // Re-open BookEditModal and type unsaved text
      tty.send('e');
      await tty.waitFor(
        (s) => s.includes('编辑复习全书') && s.includes('breaker.gen.md') && !s.includes('正在读取本节文件'),
        { timeoutMs: 10_000, label: 'BookEditModal re-opened' },
      );
      tty.send('UNSAVED_R2_EDIT');
      await tty.waitFor(
        (s) => s.includes('UNSAVED_R2_EDIT') && s.includes('未保存'),
        { timeoutMs: 8_000, label: 'dirty badge & unsaved text visible' },
      );

      // Dirty Esc -> opens ConfirmDialog instead of closing
      tty.send('\x1b');
      const confirmScreen = await tty.waitFor(
        (s) => s.includes('有未保存的修改，确定放弃并关闭吗？') || s.includes('Discard Unsaved Changes'),
        { timeoutMs: 8_000, label: 'discard ConfirmDialog opened on dirty Esc' },
      );
      tty.assertHealthyScreen(confirmScreen, 120, 36, 'BookEditModal discard ConfirmDialog');

      // Press 'n' -> cancels ConfirmDialog, returns to editing with unsaved text preserved
      tty.send('n');
      const preservedScreen = await tty.waitFor(
        (s) =>
          !s.includes('有未保存的修改，确定放弃并关闭吗？') &&
          s.includes('编辑复习全书') &&
          s.includes('UNSAVED_R2_EDIT'),
        { timeoutMs: 8_000, label: 'n cancels ConfirmDialog and preserves edits' },
      );
      assert.ok(preservedScreen.includes('UNSAVED_R2_EDIT'));

      // Tab to actions bar -> press [r] while dirty -> opens reload ConfirmDialog, 'n' preserves edits
      tty.send('\t');
      await tty.waitFor((s) => s.includes('[操作栏'), { timeoutMs: 6_000, label: 'switched to BookEditModal actions bar' });
      tty.send('r');
      await tty.waitFor(
        (s) => s.includes('放弃修改并重载') || s.includes('Discard Changes & Reload'),
        { timeoutMs: 6_000, label: 'dirty [r] reload opens ConfirmDialog' },
      );
      tty.send('n');
      const preservedAfterReloadCancel = await tty.waitFor(
        (s) => !s.includes('放弃修改并重载') && s.includes('UNSAVED_R2_EDIT'),
        { timeoutMs: 6_000, label: 'n cancels reload ConfirmDialog and keeps edits' },
      );
      assert.ok(preservedAfterReloadCancel.includes('UNSAVED_R2_EDIT'));

      // Dirty Esc -> ConfirmDialog -> 'y' discards and closes cleanly
      tty.send('\x1b');
      await tty.waitFor(
        (s) => s.includes('有未保存的修改，确定放弃并关闭吗？'),
        { timeoutMs: 8_000, label: 'discard ConfirmDialog re-opened' },
      );
      tty.send('y');
      const afterDiscard = await tty.waitFor(
        (s) => !s.includes('编辑复习全书') && !s.includes('有未保存的修改') && s.includes('Circuit Breaker'),
        { timeoutMs: 8_000, label: 'y confirms discard and closes BookEditModal' },
      );
      tty.assertHealthyScreen(afterDiscard, 120, 36, 'BookView after discard');
    } finally {
      inkInstance?.unmount();
      tty.dispose();
      await host.dispose();
    }
  });
});

describe('P1 #5: Batch operations exceeding backend 100/200 caps', () => {
  test('1) chunkItems splits arrays cleanly without exceeding maxSize', () => {
    assert.deepEqual(chunkItems([], 100), []);
    assert.equal(chunkItems(Array.from({ length: 100 }, (_, i) => i), 100).length, 1);
    const chunks250 = chunkItems(Array.from({ length: 250 }, (_, i) => i), 100);
    assert.deepEqual(
      chunks250.map((c) => c.length),
      [100, 100, 50],
    );
    assert.equal(CARD_BATCH_MAX, 100);
    assert.equal(SOURCE_BATCH_MAX, 100);
  });

  test('2) DeckManageModal batch slay, topic update, and link chunk >200 cards into <=100 backend calls & stop on partial failure', async () => {
    const cardIds250 = Array.from({ length: 250 }, (_, i) => `card-${i + 1}`);
    const calls = [];
    const mockHost = {
      async call(action, args) {
        calls.push({ action, args });
        if (action === 'card.review.batch') {
          assert.ok(args.items.length <= 100, `card.review.batch exceeded 100: ${args.items.length}`);
          return { ok: true, value: { slain: args.items.length } };
        }
        if (action === 'card.update.batch') {
          assert.ok(args.updates.length <= 100, `card.update.batch exceeded 100: ${args.updates.length}`);
          return { ok: true, value: { updated: args.updates.length, failed: 0 } };
        }
        if (action === 'card.link.batch') {
          assert.ok(args.links.length <= 100, `card.link.batch exceeded 100: ${args.links.length}`);
          return { ok: true, value: { linked: args.links.length, failed: 0 } };
        }
        return { ok: false, error: { message: `unexpected ${action}` } };
      },
    };

    const slayRes = await executeBatchSlay(mockHost, 'deck-1', cardIds250, 'en');
    assert.deepEqual(slayRes, { ok: true, slain: 250, partial: false });
    assert.deepEqual(
      calls.filter((c) => c.action === 'card.review.batch').map((c) => c.args.items.length),
      [100, 100, 50],
    );

    const topicRes = await executeBatchTopicUpdate(mockHost, 'deck-1', cardIds250, 'Paging', 'en');
    assert.deepEqual(topicRes, { ok: true, updated: 250, failed: 0, partial: false });
    assert.deepEqual(
      calls.filter((c) => c.action === 'card.update.batch').map((c) => c.args.updates.length),
      [100, 100, 50],
    );

    const linkRes = await executeBatchLink(mockHost, 'deck-1', cardIds250, 'prereq-0', 'en');
    assert.deepEqual(linkRes, { ok: true, linked: 250, failed: 0, partial: false });
    assert.deepEqual(
      calls.filter((c) => c.action === 'card.link.batch').map((c) => c.args.links.length),
      [100, 100, 50],
    );

    // Partial failure on chunk 2 stops before chunk 3 and reports partial progress
    let failAttempt = 0;
    const partialFailHost = {
      async call() {
        failAttempt += 1;
        if (failAttempt === 2) return { ok: false, error: { message: 'disk locked' } };
        return { ok: true, value: { slain: 100 } };
      },
    };
    const partialRes = await executeBatchSlay(partialFailHost, 'deck-1', cardIds250, 'en');
    assert.equal(failAttempt, 2, 'must stop immediately on chunk 2 error without sending chunk 3');
    assert.equal(partialRes.ok, false);
    assert.equal(partialRes.partial, true);
    assert.equal(partialRes.slain, 100);
    assert.match(partialRes.error, /100\/250.*batch 2\/3/i);
  });

  test('3) SourcesView archive & folder.set chunk <=100, while source.remove submits atomically in 1 batch (zero half-delete)', async () => {
    const sourceIds230 = Array.from({ length: 230 }, (_, i) => `src-p${i + 1}`);
    const calls = [];
    const mockHost = {
      async call(action, args) {
        calls.push({ action, args });
        if (action === 'source.archive') {
          assert.ok(args.sourceIds.length <= 100);
          return { ok: true, value: { sourceIds: args.sourceIds, archived: args.archived } };
        }
        if (action === 'source.remove') {
          return { ok: true, value: { removed: args.sourceIds.length } };
        }
        if (action === 'source.folder.set') {
          assert.ok(args.keys.length <= 100);
          return { ok: true, value: { updated: args.keys.length } };
        }
        return { ok: false, error: { message: `unexpected ${action}` } };
      },
    };

    const archRes = await executeBatchSourceArchive(mockHost, sourceIds230, true, 'zh');
    assert.equal(archRes.ok, true);
    assert.equal(archRes.processedIds.length, 230);
    assert.deepEqual(
      calls.filter((c) => c.action === 'source.archive').map((c) => c.args.sourceIds.length),
      [100, 100, 30],
    );

    const remRes = await executeBatchSourceRemove(mockHost, sourceIds230, 'zh');
    assert.equal(remRes.ok, true);
    assert.equal(remRes.removedCount, 230);
    assert.equal(remRes.partial, false);
    assert.deepEqual(
      calls.filter((c) => c.action === 'source.remove').map((c) => c.args.sourceIds.length),
      [230],
      'source.remove must be sent as one atomic batch so a late citation error never causes half-delete',
    );

    // Referenced source #225 fails the entire single atomic remove -> 0 removed, partial=false
    const failRefHost = {
      async call(action, args) {
        if (action === 'source.remove' && args.sourceIds.includes('src-p225')) {
          return { ok: false, error: { message: 'Source src-p225 is referenced by cards' } };
        }
        return { ok: true, value: { removed: args.sourceIds.length } };
      },
    };
    const failRemRes = await executeBatchSourceRemove(failRefHost, sourceIds230, 'zh');
    assert.equal(failRemRes.ok, false);
    assert.equal(failRemRes.removedCount, 0);
    assert.equal(failRemRes.partial, false);
    assert.match(failRemRes.error, /src-p225/);

    const folderRes = await executeBatchSourceFolderSet(mockHost, sourceIds230, 'Lectures', 'zh');
    assert.equal(folderRes.ok, true);
    assert.equal(folderRes.updated, 230);
    assert.deepEqual(
      calls.filter((c) => c.action === 'source.folder.set').map((c) => c.args.keys.length),
      [100, 100, 30],
    );
  });

  test('4) OrganizeSourcesModal pre-validates 100-source cap and prioritizes unassigned sources', () => {
    const groups = [
      { key: 'g-assigned', title: 'Assigned', courses: ['CS101'], archived: false, sourceIds: Array.from({ length: 60 }, (_, i) => `a-${i}`), pages: [] },
      { key: 'g-unassigned', title: 'Unassigned', courses: [], archived: false, sourceIds: Array.from({ length: 60 }, (_, i) => `u-${i}`), pages: [] },
    ];
    const all120 = collectOrganizeSourceIds(groups, [], Number.MAX_SAFE_INTEGER);
    assert.equal(all120.length, 120);

    const invalidZh = validateOrganizeBatchSize(all120, 'zh');
    assert.equal(invalidZh.ok, false);
    assert.match(invalidZh.message, /100/);
    assert.match(invalidZh.message, /120/);

    const invalidEn = validateOrganizeBatchSize(all120, 'en');
    assert.equal(invalidEn.ok, false);
    assert.match(invalidEn.message, /100/);

    const capped100 = collectOrganizeSourceIds(groups, []);
    assert.equal(capped100.length, MAX_ORGANIZE_SUGGEST_SOURCES);
    assert.equal(capped100[0], 'u-0', 'must prioritize unassigned sources first');
    assert.equal(validateOrganizeBatchSize(capped100, 'zh').ok, true);
  });
});
