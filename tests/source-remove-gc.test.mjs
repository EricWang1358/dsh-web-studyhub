import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStudyRuntime } from '../lib/runtime/builtins.js';
import { Store } from '../lib/store.js';

async function attachmentFiles(root) {
  try { return (await readdir(join(root, 'attachments', 'materials'))).sort(); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

function pdfBytes(text) {
  const stream = `BT /F1 12 Tf 40 700 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  const offsets = []; let body = '%PDF-1.7\n';
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(body);
}

test('permanently deleting a material prunes its orphan document shard, disk attachment, and backup payload', async t => {
  const root = await mkdtemp(join(tmpdir(), 'source-remove-gc-'));
  const runtime = createStudyRuntime(root);
  t.after(async () => { await runtime.dispose(); await rm(root, { recursive: true, force: true }); });

  const bytes = Buffer.from('# Lecture 1\n\nThermodynamics first law and internal energy.\n');
  const imported = await runtime.call('materials.document.import', {
    filename: 'lecture-1.md',
    dataBase64: bytes.toString('base64'),
  });
  const selected = await runtime.call('materials.selection.resolve', {
    documentId: imported.documentId,
    revision: imported.revision,
    quote: 'Thermodynamics first law',
  });
  await runtime.call('materials.annotation.save', {
    documentId: imported.documentId,
    revision: imported.revision,
    selection: selected.selection,
    nodes: [{ id: 'note-1', question: 'What is covered?', answer: 'Important exam concept' }],
  });
  assert.equal((await attachmentFiles(root)).length, 1);
  assert.equal((await runtime.call('export')).portableMaterials.attachments.length, 1);

  await runtime.call('source.archive', { sourceIds: imported.sourceIds, archived: true });
  await runtime.call('source.remove', { sourceIds: imported.sourceIds, confirm: true });

  const state = await new Store(root).read();
  assert.deepEqual(state.sources, []);
  assert.deepEqual(state.documents || [], []);
  assert.deepEqual(await attachmentFiles(root), []);
  const backup = await runtime.call('export');
  assert.equal(backup.portableMaterials, undefined, 'deleted material attachments must not leak into portable backups');
});

test('deleting one document preserves a content-addressed original still shared by another document', async t => {
  const root = await mkdtemp(join(tmpdir(), 'source-remove-shared-'));
  const runtime = createStudyRuntime(root);
  t.after(async () => { await runtime.dispose(); await rm(root, { recursive: true, force: true }); });

  const sharedBytes = Buffer.from('# Shared\n\nIdentical content across two logical documents.\n');
  const first = await runtime.call('materials.document.import', {
    filename: 'copy-a.md',
    dataBase64: sharedBytes.toString('base64'),
  });
  const secondSeed = await runtime.call('materials.document.import', {
    filename: 'copy-b.md',
    dataBase64: Buffer.from('# Initial B\n\nDifferent seed bytes.\n').toString('base64'),
  });
  const second = await runtime.call('materials.document.attach', {
    documentId: secondSeed.documentId,
    filename: 'copy-b.md',
    dataBase64: sharedBytes.toString('base64'),
  });
  assert.equal((await attachmentFiles(root)).length, 2);

  await runtime.call('source.archive', { sourceIds: first.sourceIds, archived: true });
  await runtime.call('source.remove', { sourceIds: first.sourceIds, confirm: true });

  assert.equal((await attachmentFiles(root)).length, 2, 'shared file and B seed revision remain');
  await runtime.call('source.archive', { sourceIds: secondSeed.sourceIds, archived: true });
  await runtime.call('source.remove', { sourceIds: secondSeed.sourceIds, confirm: true });
  assert.equal((await attachmentFiles(root)).length, 1, 'unreferenced seed revision is reclaimed while shared current file remains');

  const backup = await runtime.call('export');
  assert.equal(backup.portableMaterials.attachments.length, 1);
  const kept = await runtime.call('materials.document.get', { documentId: second.documentId });
  assert.equal(kept.originalAvailable, true);
});

test('selection-only card references block deletion and unrelated empty-projection documents stay untouched', async t => {
  const root = await mkdtemp(join(tmpdir(), 'source-remove-edges-'));
  const store = new Store(root);
  store.registerCollection('documents');
  const runtime = createStudyRuntime(root);
  t.after(async () => { await runtime.dispose(); await rm(root, { recursive: true, force: true }); });

  const cited = await runtime.call('materials.document.import', {
    filename: 'cited.md',
    dataBase64: Buffer.from('# Cited\n\nSelection linked passage.\n').toString('base64'),
  });
  const resolved = await runtime.call('materials.selection.resolve', {
    documentId: cited.documentId,
    revision: cited.revision,
    quote: 'Selection linked passage.',
  });
  const disposable = await runtime.call('materials.document.import', {
    filename: 'disposable.md',
    dataBase64: Buffer.from('# Disposable\n\nTemporary reading note.\n').toString('base64'),
  });
  const citedByCitationSel = await runtime.call('materials.document.import', {
    filename: 'cited-citation-sel.md',
    dataBase64: Buffer.from('# Cited 2\n\nCitation selection passage.\n').toString('base64'),
  });
  const resolvedCit = await runtime.call('materials.selection.resolve', {
    documentId: citedByCitationSel.documentId,
    revision: citedByCitationSel.revision,
    quote: 'Citation selection passage.',
  });
  await store.update(state => {
    state.decks.push({
      id: 'deck-sel',
      title: 'Selection deck',
      cards: [
        { id: 'c1', kind: 'flashcard', prompt: 'Q1', answer: 'A1', selections: [resolved.selection] },
        { id: 'c2', kind: 'flashcard', prompt: 'Q2', answer: 'A2', citations: [{ quote: resolvedCit.selection.quote, selection: resolvedCit.selection }] },
      ],
    });
    state.documents.push({ id: 'document-scanned-stub', format: 'pdf', filename: 'scan.pdf', title: 'Scan', currentRevision: 'rev-scan', versions: [{ revision: 'rev-scan', sourceIds: [], importedAt: new Date().toISOString() }] });
  });

  await runtime.call('source.archive', { sourceIds: cited.sourceIds, archived: true });
  await assert.rejects(runtime.call('source.remove', { sourceIds: cited.sourceIds, confirm: true }), /referenced/);
  await runtime.call('source.archive', { sourceIds: citedByCitationSel.sourceIds, archived: true });
  await assert.rejects(runtime.call('source.remove', { sourceIds: citedByCitationSel.sourceIds, confirm: true }), /referenced/);

  await runtime.call('source.archive', { sourceIds: disposable.sourceIds, archived: true });
  await runtime.call('source.remove', { sourceIds: disposable.sourceIds, confirm: true });

  const after = await store.read();
  assert.ok(after.documents.some(doc => doc.id === 'document-scanned-stub'), 'untouched empty-source stub document is preserved');
  assert.ok(!after.documents.some(doc => doc.id === disposable.documentId), 'deleted document is removed');
});

test('concurrent in-flight retainOriginal files are not deleted by source.remove, and multi-source partial removal waits for last chapter', async t => {
  const { retainOriginal } = await import('../lib/contexts/materials/files.js');
  const root = await mkdtemp(join(tmpdir(), 'source-remove-race-'));
  const runtime = createStudyRuntime(root);
  t.after(async () => { await runtime.dispose(); await rm(root, { recursive: true, force: true }); });

  const converted = JSON.stringify([
    { type: 'text', text: '# Chapter 1\n\nFirst chapter body.', page_idx: 0 },
    { type: 'text', text: '# Chapter 2\n\nSecond chapter body.', page_idx: 1 },
  ]);
  const book = await runtime.call('materials.document.import', {
    filename: 'book.json',
    dataBase64: Buffer.from(converted).toString('base64'),
  });
  assert.equal(book.sourceIds.length, 2);
  const copyBytes = pdfBytes('First chapter body. Second chapter body.');
  await runtime.call('materials.original.attach', {
    documentId: book.documentId,
    mode: 'copy',
    filename: 'book.pdf',
    dataBase64: copyBytes.toString('base64'),
    confirm: true,
  });
  assert.equal((await attachmentFiles(root)).length, 1);

  const disposable = await runtime.call('materials.document.import', {
    filename: 'temp.md',
    dataBase64: Buffer.from('# Temp\n\nTo be deleted while another import writes disk.\n').toString('base64'),
  });
  assert.equal((await attachmentFiles(root)).length, 2);

  // Simulate a concurrent import writing its original bytes to disk before its state transaction commits.
  const inflight = await retainOriginal(root, Buffer.from('# Concurrent\n\nIn-flight upload bytes.\n'), 'md');
  const inflightName = inflight.path.split('/').pop();
  assert.equal((await attachmentFiles(root)).length, 3);

  await runtime.call('source.archive', { sourceIds: disposable.sourceIds, archived: true });
  await runtime.call('source.remove', { sourceIds: disposable.sourceIds, confirm: true });

  const afterConcurrentRemove = await attachmentFiles(root);
  assert.ok(afterConcurrentRemove.includes(inflightName), 'in-flight concurrent attachment must not be unlinked');
  assert.equal(afterConcurrentRemove.length, 2, 'only the deleted material attachment is unlinked');

  // Partial chapter deletion keeps the document and attached PDF until the last page/chapter is removed.
  await runtime.call('source.archive', { id: book.sourceIds[0], archived: true });
  await runtime.call('source.remove', { id: book.sourceIds[0], confirm: true });
  assert.equal((await runtime.call('materials.document.get', { documentId: book.documentId })).originalAvailable, true);

  // Detaching a copied original reclaims its unreferenced attachment file without touching in-flight files.
  await runtime.call('materials.original.detach', { documentId: book.documentId });
  assert.deepEqual(await attachmentFiles(root), [inflightName]);

  await runtime.call('source.archive', { id: book.sourceIds[1], archived: true });
  await runtime.call('source.remove', { id: book.sourceIds[1], confirm: true });
  assert.deepEqual((await new Store(root).read()).documents || [], []);
});

test('locked attachments do not fail committed removals or block sibling cleanup, and are reclaimed once unlocked', async t => {
  const { spawn } = await import('node:child_process');
  const { unlink } = await import('node:fs/promises');
  const { pruneAttachments, retainOriginal } = await import('../lib/contexts/materials/files.js');
  const root = await mkdtemp(join(tmpdir(), 'source-remove-locked-'));
  const runtime = createStudyRuntime(root);
  t.after(async () => { await runtime.dispose(); await rm(root, { recursive: true, force: true }).catch(() => {}); });

  // Cross-platform unit check: EBUSY / EPERM / ENOENT during targeted and directory-sweep pruning.
  const lockedFile = await retainOriginal(root, Buffer.from('# Locked A\n\nHeld by external viewer.\n'), 'md');
  const freeFile = await retainOriginal(root, Buffer.from('# Free B\n\nUnlocked sibling.\n'), 'md');
  const lockedName = lockedFile.path.split('/').pop();
  const simulatedUnlink = async filePath => {
    if (filePath.endsWith(lockedName)) throw Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' });
    return unlink(filePath);
  };
  const partialTargeted = await pruneAttachments(root, [], { paths: [lockedFile.path, freeFile.path], unlinkFile: simulatedUnlink });
  assert.deepEqual(partialTargeted, { pruned: 1, skipped: 1 }, 'unlocked sibling is unlinked even when first file is EBUSY');
  assert.deepEqual(await attachmentFiles(root), [lockedName]);

  const partialSweep = await pruneAttachments(root, [], { unlinkFile: simulatedUnlink });
  assert.deepEqual(partialSweep, { pruned: 0, skipped: 1 });
  const enoentSweep = await pruneAttachments(root, [], { unlinkFile: async () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); } });
  assert.deepEqual(enoentSweep, { pruned: 0 }, 'concurrent ENOENT in directory sweep is not miscounted as pruned');
  assert.deepEqual(await pruneAttachments(root, []), { pruned: 1 });
  assert.deepEqual(await attachmentFiles(root), []);

  // Windows end-to-end check with a real OS-level FileShare.None lock held across batch source.remove.
  if (process.platform === 'win32') {
    const first = await runtime.call('materials.document.import', {
      filename: 'open-in-viewer.pdf',
      dataBase64: pdfBytes('Locked PDF in external viewer.').toString('base64'),
    });
    const second = await runtime.call('materials.document.import', {
      filename: 'closed-sibling.pdf',
      dataBase64: pdfBytes('Unlocked PDF in same batch delete.').toString('base64'),
    });
    const docsBefore = (await new Store(root).read()).documents;
    const firstRelPath = docsBefore.find(d => d.id === first.documentId).versions[0].attachment.path;
    const firstFullPath = join(root, firstRelPath);

    const holder = spawn('powershell', ['-NoProfile', '-Command',
      "$fs = [System.IO.File]::Open($env:LOCK_PATH, 'Open', 'Read', 'None'); [Console]::Out.WriteLine('LOCKED'); [Console]::Out.Flush(); Start-Sleep -Seconds 30",
    ], { env: { ...process.env, LOCK_PATH: firstFullPath }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { holder.kill(); });
    await new Promise(resolve => holder.stdout.on('data', chunk => { if (String(chunk).includes('LOCKED')) resolve(); }));

    const allSourceIds = [...first.sourceIds, ...second.sourceIds];
    await runtime.call('source.archive', { sourceIds: allSourceIds, archived: true });
    const removed = await runtime.call('source.remove', { sourceIds: allSourceIds, confirm: true });
    assert.deepEqual(removed, { ok: true }, 'source.remove succeeds cleanly even when Windows locks an attachment');

    const afterRemove = await new Store(root).read();
    assert.deepEqual(afterRemove.sources, []);
    assert.deepEqual(afterRemove.documents || [], []);
    assert.equal((await runtime.call('export')).portableMaterials, undefined, 'locked orphan file is excluded from backups');
    assert.deepEqual(await attachmentFiles(root), [firstRelPath.split('/').pop()], 'unlocked sibling PDF was unlinked despite locked first PDF');

    holder.kill();
    await new Promise(resolve => holder.once('exit', resolve));
    const swept = await runtime.invoke('materials.v1', 'attachments.prune', {});
    assert.deepEqual(swept, { pruned: 1 });
    assert.deepEqual(await attachmentFiles(root), []);
  }
});


