// #1436 Batch 4 Item 6:
// Restoring repeated header/footer lines (`materials.document.restoreRepeated`) must preserve the
// original external PDF reference (`external` + `originalCheck`), and PdfConvertJob / ImportHub
// must pass `onRestored` / surface errors truthfully instead of swallowing them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';

test('#1436 Item 6: materials.document.restoreRepeated preserves external original PDF reference and originalCheck', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'studyhub-1436-item6-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Create a real local PDF file on disk to act as the referenced original
  const pdfPath = join(dir, 'textbook.pdf');
  const fakePdfBytes = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'utf8');
  writeFileSync(pdfPath, fakePdfBytes);
  const pdfStat = statSync(pdfPath);
  // The native form, as the service records it (fs/promises realpath): on Windows the plain form keeps an 8.3 short name in the temp folder and the two would differ.
  const pdfRealPath = realpathSync.native(pdfPath);
  const pdfHash = createHash('sha256').update(fakePdfBytes).digest('hex');

  const service = new StudyService(dir);
  t.after(() => service.dispose());

  // Seed a converted PDF document whose current version has an external PDF reference + repeated header lines
  await service.store.update((s) => {
    s.sources ||= [];
    s.documents ||= [];
    s.sources.push({
      id: 'doc-1-rev1-p1',
      title: '操作系统教材 · 第 1 页',
      text: '虚拟内存分页原理正文内容',
      createdAt: '2026-11-24T00:00:00.000Z',
      importedAt: '2026-11-24T00:00:00.000Z',
      courses: ['操作系统'],
      document: {
        materialId: 'doc-1',
        materialRevision: 'rev1',
        format: 'pdf',
        filename: 'textbook.pdf',
        page: 1,
        bookTitle: '操作系统教材',
        repeated: [[0, '第 3 章 虚拟内存'], [2, '- 1 -']],
      },
    });
    s.documents.push({
      id: 'doc-1',
      format: 'pdf',
      filename: 'textbook.pdf',
      title: '操作系统教材',
      currentRevision: 'rev1',
      externalPath: pdfPath,
      versions: [
        {
          revision: 'rev1',
          attachment: null,
          external: {
            path: pdfPath,
            realPath: pdfRealPath,
            bytes: fakePdfBytes.length,
            mtimeMs: pdfStat.mtimeMs,
            hash: pdfHash,
            format: 'pdf',
            verifiedAt: '2026-11-24T00:00:00.000Z',
          },
          originalCheck: { pages: 1, verified: true },
          sourceIds: ['doc-1-rev1-p1'],
          importedAt: '2026-11-24T00:00:00.000Z',
          totalPages: 1,
          repeated: { count: 2, lines: [{ text: '第 3 章 虚拟内存', pages: 1 }] },
        },
      ],
    });
  });

  // Before restore: originalAvailable is true via external reference
  const before = await service.call('materials.document.get', { id: 'doc-1' });
  assert.equal(before.originalAvailable, true, 'referenced PDF must be available before restoreRepeated');

  // Call restoreRepeated
  const restored = await service.call('materials.document.restoreRepeated', { documentId: 'doc-1' });
  assert.equal(restored.status, 'restored');
  assert.equal(restored.restored, 2);

  // After restore: new version MUST retain external reference & originalCheck, and originalAvailable stays true!
  const after = await service.call('materials.document.get', { id: 'doc-1' });
  assert.equal(after.originalAvailable, true, 'originalAvailable must stay true after restoreRepeated');
  assert.equal(after.original?.status, 'ok');
  assert.equal(after.original?.mode, 'reference');

  const rawState = await service.store.read();
  const doc = rawState.documents.find((d) => d.id === 'doc-1');
  const latestVersion = doc.versions.find((v) => v.revision === doc.currentRevision);
  assert.ok(latestVersion.external?.path === pdfPath, 'new version must preserve external reference');
  assert.deepEqual(latestVersion.originalCheck, { pages: 1, verified: true }, 'new version must preserve originalCheck');
});

test('#1436 Item 6 UI wiring: PdfConvertJob passes onRestored and ImportHub surfaces restore errors', () => {
  const pdfJobSrc = readFileSync(new URL('../ui/PdfConvertJob.jsx', import.meta.url), 'utf8');
  const importHubSrc = readFileSync(new URL('../ui/ImportHub.jsx', import.meta.url), 'utf8');

  const repeatedMatches = [...pdfJobSrc.matchAll(/<RepeatedNote\b[^>]*>/g)].map((m) => m[0]);
  assert.ok(repeatedMatches.length >= 2, 'PdfConvertJob renders RepeatedNote in detail & history');
  for (const tag of repeatedMatches) {
    assert.match(tag, /\bonRestored\s*=/, `Every <RepeatedNote> in PdfConvertJob must pass onRestored: ${tag}`);
  }
  assert.doesNotMatch(
    importHubSrc,
    /catch\s*\{\s*\/\*\s*the row keeps its 恢复/,
    'ImportHub putBack must surface restore errors instead of silently swallowing them',
  );
});
