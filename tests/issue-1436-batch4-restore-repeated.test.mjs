// #1436 Batch 4 Item 6:
// Restoring repeated header/footer lines (`materials.document.restoreRepeated`) must preserve the
// original external PDF reference (`external` + `originalCheck`), and PdfConvertJob / ImportHub
// must pass `onRestored` / surface errors truthfully instead of swallowing them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { click, loadInteractiveUi, syntheticEvent, withBrowserGlobals } from './helpers/react-harness.mjs';

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

test('#1436 Item 6 UI behavior: PdfDetail and PdfConvertHistory trigger refresh on restore, and ImportHub surfaces restore errors', async () => {
  const ui = await loadInteractiveUi(`
    export { PdfDetail, PdfConvertHistory } from './ui/PdfConvertJob.jsx';
    export { default as ImportHub } from './ui/ImportHub.jsx';
    export { StudyServicesContext } from './ui/study-context.jsx';
    export { setUiLanguage } from './ui/i18n.js';
  `);
  const h = ui.React.createElement;
  const noop = () => {};
  const makeServices = (overrides) => ({
    call: async () => ({}),
    act: async () => undefined,
    busy: false,
    notify: noop,
    askInChat: noop,
    host: {},
    openSettings: noop,
    navigate: noop,
    openModal: noop,
    ...overrides,
  });
  const findRestoreButton = (mounted) => mounted.find(
    (node) => node.type === 'button' && ui.textOf(node).trim() === '恢复',
  );

  await withBrowserGlobals(async () => {
    ui.exports.setUiLanguage('zh');
    try {
      // (a) PdfDetail: clicking 恢复 calls materials.document.restoreRepeated and fires both onChanged and study.refresh
      {
        const calls = [];
        let changed = 0;
        let refreshed = 0;
        const services = makeServices({
          call: async (action, args) => {
            calls.push([action, args]);
            return { status: 'restored', restored: 2 };
          },
          refresh: () => { refreshed += 1; },
        });
        const job = {
          id: 'job-1',
          status: 'complete',
          documentId: 'doc-detail-1',
          repeated: { count: 2, lines: [{ text: 'Chapter 1 Header' }] },
        };
        let mounted;
        try {
          mounted = ui.mount(() => h(
            ui.exports.StudyServicesContext.Provider,
            { value: services },
            h(ui.exports.PdfDetail, { job, onChanged: () => { changed += 1; } }),
          ));
          const btn = findRestoreButton(mounted);
          assert.ok(btn, 'PdfDetail must render a 恢复 button for completed jobs with repeated lines');
          await mounted.act(() => click(btn));
          await mounted.flush();
          assert.deepEqual(calls, [['materials.document.restoreRepeated', { documentId: 'doc-detail-1' }]]);
          assert.equal(changed, 1, 'PdfDetail must invoke onChanged after restoreRepeated');
          assert.equal(refreshed, 1, 'PdfDetail must invoke study.refresh after restoreRepeated');
          assert.match(mounted.text(), /已放回这些重复的行。/);
        } finally {
          mounted?.unmount();
        }
      }

      // (b) PdfConvertHistory: clicking 恢复 calls materials.document.restoreRepeated and triggers onChanged + mineru.history.list reload
      {
        const calls = [];
        let changed = 0;
        const services = makeServices({
          call: async (action, args) => {
            calls.push([action, args]);
            if (action === 'materials.document.restoreRepeated') return { status: 'restored', restored: 3 };
            if (action === 'mineru.history.list') return { records: [] };
            return {};
          },
        });
        const initialRecords = [{
          id: 'rec-1',
          filename: 'textbook.pdf',
          status: 'complete',
          route: 'local',
          documentId: 'doc-hist-1',
          startedAt: '2026-11-24T00:00:00.000Z',
          finishedAt: '2026-11-24T00:01:00.000Z',
          document: {
            exists: true,
            title: '操作系统教材',
            pages: 10,
            sourceIds: ['s1'],
            repeated: { count: 3, lines: [{ text: 'Page Footer' }] },
          },
        }];
        let mounted;
        try {
          mounted = ui.mount(() => h(
            ui.exports.StudyServicesContext.Provider,
            { value: services },
            h(ui.exports.PdfConvertHistory, {
              initialRecords,
              now: Date.parse('2026-11-24T00:02:00.000Z'),
              onChanged: () => { changed += 1; },
            }),
          ));
          const btn = findRestoreButton(mounted);
          assert.ok(btn, 'PdfConvertHistory must render a 恢复 button for completed records with repeated lines');
          await mounted.act(() => click(btn));
          await mounted.flush();
          assert.deepEqual(calls[0], ['materials.document.restoreRepeated', { documentId: 'doc-hist-1' }]);
          assert.ok(
            calls.some(([action]) => action === 'mineru.history.list'),
            `PdfConvertHistory must reload mineru.history.list after restore, saw ${JSON.stringify(calls)}`,
          );
          assert.equal(changed, 1, 'PdfConvertHistory must invoke onChanged after restoreRepeated');
        } finally {
          mounted?.unmount();
        }
      }

      // (c) ImportHub: restoreRepeated rejection renders the real error visibly and keeps the 恢复 button for retry
      {
        const calls = [];
        const services = makeServices({
          call: async (action, args) => {
            calls.push([action, args]);
            if (action === 'materials.document.import') {
              return {
                documentId: 'doc-imp-1',
                sourceIds: ['s1'],
                document: { title: 'lecture.pdf', format: 'pdf', sourceIds: ['s1'] },
                repeated: { count: 2, lines: [{ text: 'Header' }] },
              };
            }
            if (action === 'materials.document.restoreRepeated') {
              throw new Error('disk locked');
            }
            return {};
          },
        });
        let mounted;
        try {
          mounted = ui.mount(() => h(
            ui.exports.StudyServicesContext.Provider,
            { value: services },
            h(ui.exports.ImportHub, { data: { focus: { courses: [] }, courses: [], jobs: [] } }),
          ));
          const input = mounted.find((node) => node.type === 'input' && node.props?.type === 'file');
          assert.ok(input, 'ImportHub must render a file input');
          const fakeFile = {
            name: 'lecture.pdf',
            size: 16,
            type: 'application/pdf',
            lastModified: 1,
            arrayBuffer: async () => new TextEncoder().encode('%PDF-1.4\nhello\n').buffer,
          };
          await mounted.act(() => input.props.onChange(syntheticEvent({ target: { files: [fakeFile], value: '' } })));
          await mounted.flush(8);

          const restoreBtn = findRestoreButton(mounted);
          assert.ok(restoreBtn, 'ImportHub must show a 恢复 button on a row with repeated lines');
          await mounted.act(() => click(restoreBtn));
          await mounted.flush(5);

          assert.ok(
            calls.some(([action, args]) => action === 'materials.document.restoreRepeated' && args?.documentId === 'doc-imp-1'),
            `expected materials.document.restoreRepeated call, saw ${JSON.stringify(calls)}`,
          );
          assert.match(mounted.text(), /disk locked/, 'ImportHub must visibly render the restore error instead of swallowing it');
          assert.ok(findRestoreButton(mounted), 'ImportHub must keep the 恢复 button available for retry after a failed restore');
        } finally {
          mounted?.unmount();
        }
      }
    } finally {
      ui.exports.setUiLanguage('zh');
    }
  });
});
