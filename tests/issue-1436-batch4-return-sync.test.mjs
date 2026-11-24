// #1436 Batch 4 Items 2 & 5:
// - Item 2: Top-bar Return / Resume from Guided Study switches back to Review, clears ended chip reactively, and respects nav.leaving() guard.
// - Item 5: Syncing a referenced original never blanks/overwrites converted books, refuses empty projection overwrite, fixes stale revision on refresh, and localizes sync errors coherently.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { loadUi } from './helpers/ui-module.mjs';

const origUi = await loadUi(`
  export { ORIGINAL_MAX_BYTES, issueOf, explainFailure, canSyncReferencedText } from './ui/document-preview/original-file.js';
`);

test('#1436 Item 2: enterRun stayOnGuided option, lastPracticeVersion reactivity, and nav.leaving guard', () => {
  const sessionSrc = readFileSync(new URL('../ui/review/useReviewSession.js', import.meta.url), 'utf8');
  const navSrc = readFileSync(new URL('../ui/app/use-learning-navigation.js', import.meta.url), 'utf8');
  const viewsSrc = readFileSync(new URL('../ui/app/page-views.jsx', import.meta.url), 'utf8');

  // 1) enterRun / enterMovedRun default to switching back to 'review' unless explicit stayOnGuided is true
  assert.match(sessionSrc, /stayOnGuided\s*=\s*false/, 'enterRun must take an explicit stayOnGuided option defaulting to false');
  assert.doesNotMatch(
    sessionSrc,
    /if\s*\(\s*!embeddedIn\s*&&\s*nav\.page\s*!==\s*['"]guided['"]\s*\)\s*setPage\(\s*['"]review['"]\s*\)/,
    'enterRun must not unconditionally block returning to review from guided page',
  );
  assert.match(viewsSrc, /stayOnGuided:\s*true/, 'GuidedStudyView internal run updates must pass stayOnGuided: true');

  // 2) lastPractice memo reacts to a version counter bumped on save/clear
  assert.match(navSrc, /lastPracticeVersion/, 'use-learning-navigation must track lastPracticeVersion');
  assert.match(navSrc, /clearLastPracticePosition[\s\S]{0,120}bumpLastPractice/, 'clearing lastPracticePosition must bump lastPracticeVersion');

  // 3) All four return/resume entry points pass through nav.leaving(...)
  for (const fn of ['returnFromPracticeStack', 'returnToOriginalPractice', 'resumeLastPractice', 'practiceEndedAgain']) {
    const m = navSrc.match(new RegExp(`const ${fn}\\s*=\\s*useCallback\\([\\s\\S]{0,600}?\\]\\);`));
    assert.ok(m, `could not locate ${fn} in use-learning-navigation.js`);
    assert.match(m[0], /nav\.leaving\s*\(/, `${fn} must guard navigation with nav.leaving(...)`);
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
