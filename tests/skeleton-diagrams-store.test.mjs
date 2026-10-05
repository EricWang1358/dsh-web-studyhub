import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { localizeAppMessage } from '../lib/application-messages.js';
import { libraryContracts, studyToolDescription, studyUsagePrompt } from '../lib/study-contracts.js';
import { MAX_DIAGRAMS, MAX_DIAGRAM_BYTES, scopeDiagramArgs } from '../lib/skeleton-diagrams.js';

/* An interactive diagram the learner's agent drew (for example with the open-source Archify skill) is attached to a skeleton as a
   file in the library. These tests pin the path rules (the workspace or the library only), the content rules (one UTF-8 HTML
   document, at most 5 MB), the bounded list, and that the file is only ever stored, never run. */

const quote = 'Retries amplify load and replicas absorb failures when properly isolated.';
const card = (id, topic) => ({
  id, kind: 'quiz', topic, objective: `why ${id}`, prompt: `为什么 ${id} 需要隔离？`, answer: 'A', hint: 'h', misconception: 'm',
  explanation: '隔离可以把故障限制在局部，避免连锁放大成全面故障，这是它存在的原因。',
  citations: [{ sourceId: 's1', quote }],
  options: [{ id: 'a', text: 'A', correct: true, explanation: '对' }, { id: 'b', text: 'B', correct: false, explanation: '错' }, { id: 'c', text: 'C', correct: false, explanation: '错' }],
});
const html = (title = 'Availability map', extra = '') => `<!doctype html>\n<html><head><meta charset="utf-8"><title>${title}</title></head><body><script>document.body.dataset.ran = '1'</script>${extra}</body></html>`;

async function setup(t) {
  const base = await mkdtemp(join(tmpdir(), 'study-diagrams-'));
  const root = join(base, 'library'), workspace = join(base, 'workspace'), elsewhere = join(base, 'elsewhere');
  await mkdir(root); await mkdir(join(workspace, 'diagrams'), { recursive: true }); await mkdir(elsewhere);
  const service = new StudyService(root);
  t.after(async () => { service.dispose(); await rm(base, { recursive: true, force: true, maxRetries: 3 }); });
  await service.call('source.add', { id: 's1', title: 'HA', text: quote });
  await service.call('draft.save', { deck: { id: 'arch', title: 'Arch', cards: [card('a1', 'Availability'), card('a2', 'Redundancy')] } });
  await service.call('draft.publish', { id: 'arch' });
  const saved = await service.call('skeleton.save', { skeleton: { title: '可用性', scope: [{ deckId: 'arch', topic: 'Availability' }], overview: 'o',
    nodes: [{ id: 'n1', term: 'Availability', meaning: 'Uptime', cards: [{ deckId: 'arch', cardId: 'a1' }] }, { id: 'n2', term: 'Redundancy', meaning: 'Copies', cards: [] }], relations: [] } });
  const skeletonId = saved.id ?? saved.skeleton?.id;
  const put = async (name, body, where = workspace) => { const path = join(where, 'diagrams', name); await mkdir(join(where, 'diagrams'), { recursive: true }); await writeFile(path, body); return path; };
  const attach = (path, extra = {}) => service.call('skeleton.diagram.attach', { id: skeletonId, path, workspace, ...extra });
  return { service, root, workspace, elsewhere, skeletonId, put, attach };
}
const exists = path => access(path).then(() => true, () => false);

test('an HTML file inside the workspace is copied into the library with a bounded record', async t => {
  const { service, root, skeletonId, put, attach } = await setup(t);
  const body = html('可用性 · 架构图');
  const result = await attach(await put('avail.html', body));
  assert.equal(result.unchanged, false);
  const record = result.diagram;
  assert.equal(record.title, '可用性 · 架构图', 'the title comes from the document when none is given');
  assert.equal(record.bytes, Buffer.byteLength(body));
  assert.equal(record.sha256, createHash('sha256').update(body).digest('hex'));
  assert.ok(Date.parse(record.createdAt) > 0);
  assert.equal(record.skeletonRevision, (await service.call('skeleton.get', { id: skeletonId })).updatedAt);
  const stored = join(root, 'skeleton-diagrams', skeletonId, `${record.id}.html`);
  assert.equal(await readFile(stored, 'utf8'), body, 'the library holds a byte-for-byte copy');
  assert.deepEqual((await readdir(join(root, 'skeleton-diagrams', skeletonId))).filter(name => name.includes('tmp')), [], 'no temporary file is left');
  const listed = await service.call('skeleton.diagram.list', { id: skeletonId });
  assert.deepEqual(listed.diagrams.map(item => [item.id, item.stale]), [[record.id, false]]);
  assert.equal(listed.diagrams[0].html, undefined, 'the list never carries the document');
  const read = await service.call('skeleton.diagram.get', { id: skeletonId, diagramId: record.id });
  assert.equal(read.html, body);
  assert.equal(read.stale, false);
  assert.equal(read.file, stored);
});

test('an explicit title wins, and a document without a title falls back to the file name', async t => {
  const { put, attach } = await setup(t);
  assert.equal((await attach(await put('one.html', html('Doc title')), { title: '  我的图  ' })).diagram.title, '我的图');
  assert.equal((await attach(await put('two-nodes.html', '<!DOCTYPE html><html><body>x</body></html>'))).diagram.title, 'two-nodes');
});

test('a path may be relative to the workspace, quoted or @-mentioned, and a file under the library is allowed', async t => {
  const { root, put, attach, skeletonId } = await setup(t);
  await put('rel.html', html('rel'));
  assert.equal((await attach('diagrams/rel.html')).diagram.title, 'rel');
  assert.equal((await attach('@"diagrams/rel.html"', { title: 'again' })).unchanged, true);
  await mkdir(join(root, 'notes'), { recursive: true });
  const inside = join(root, 'notes', 'made.html');
  await writeFile(inside, html('in library'));
  assert.equal((await attach(inside)).diagram.title, 'in library');
  assert.ok(skeletonId);
});

test('anything outside the workspace and the library is rejected, including .. and absolute paths', async t => {
  const { elsewhere, put, attach, workspace } = await setup(t);
  const outside = await put('out.html', html('out'), elsewhere);
  await assert.rejects(attach(outside), /工作目录或学习库/);
  await assert.rejects(attach(join(workspace, '..', 'elsewhere', 'diagrams', 'out.html')), /工作目录或学习库/);
  await assert.rejects(attach('../elsewhere/diagrams/out.html'), /工作目录或学习库/);
  assert.match(localizeAppMessage('这个文件不在当前工作目录或学习库里，不能挂到骨架上。', 'en'), /workspace or the library/);
});

test('without a known workspace only the library is readable', async t => {
  const { service, put, skeletonId, workspace } = await setup(t);
  const file = await put('free.html', html('free'));
  await assert.rejects(service.call('skeleton.diagram.attach', { id: skeletonId, path: file }), /工作目录或学习库/);
  assert.ok(workspace);
});

test('a symbolic link that leads outside is refused, one that stays inside is read through', async t => {
  const { elsewhere, put, attach, workspace } = await setup(t);
  const outside = await put('target.html', html('secret'), elsewhere);
  const link = join(workspace, 'diagrams', 'link.html');
  try { await symlink(outside, link, 'file'); } catch (error) { if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('symbolic links need a privilege here'); throw error; }
  await assert.rejects(attach(link), /工作目录或学习库/);
  const real = await put('real.html', html('real'));
  const inner = join(workspace, 'diagrams', 'inner.html');
  await symlink(real, inner, 'file');
  assert.equal((await attach(inner)).diagram.title, 'real');
});

test('a folder link (a junction on Windows) inside the workspace that leads outside is refused too', async t => {
  const { elsewhere, put, attach, workspace } = await setup(t);
  await put('out.html', html('secret'), elsewhere);
  await symlink(elsewhere, join(workspace, 'linked'), 'junction');
  await assert.rejects(attach(join(workspace, 'linked', 'diagrams', 'out.html')), /工作目录或学习库/);
  await assert.rejects(attach('linked/diagrams/out.html'), /工作目录或学习库/);
});

test('a directory, a missing file, a non-HTML file, bad UTF-8 and a file over 5 MB are each refused with a plain reason', async t => {
  const { put, attach, workspace } = await setup(t);
  await assert.rejects(attach(join(workspace, 'diagrams')), /不是普通文件/);
  await assert.rejects(attach(join(workspace, 'diagrams', 'gone.html')), /找不到这个文件/);
  await assert.rejects(attach(await put('notes.html', '{"nodes": []}')), /不是 HTML/);
  await assert.rejects(attach(await put('plain.txt', 'hello <b>world</b>')), /不是 HTML/);
  await assert.rejects(attach(await put('bytes.html', Buffer.concat([Buffer.from('<!doctype html><html><body>'), Buffer.from([0xff, 0xfe, 0xfd]), Buffer.from('</body></html>')]))), /UTF-8/);
  const big = '<!doctype html><html><body>' + 'x'.repeat(MAX_DIAGRAM_BYTES) + '</body></html>';
  await assert.rejects(attach(await put('big.html', big)), /5 MB/);
  const edge = '<!doctype html><html><body>' + 'x'.repeat(MAX_DIAGRAM_BYTES - 60) + '</body></html>';
  assert.ok(Buffer.byteLength(edge) <= MAX_DIAGRAM_BYTES);
  assert.equal((await attach(await put('edge.html', edge))).unchanged, false, 'a file just under the limit is accepted');
});

test('the HTML check looks only at the start of the file and accepts a byte-order mark and a leading comment', async t => {
  const { put, attach } = await setup(t);
  assert.ok((await attach(await put('bom.html', '﻿<!-- made by an agent -->\n<!DOCTYPE HTML><html><body>ok</body></html>'))).diagram.id);
  await assert.rejects(attach(await put('late.html', 'x'.repeat(5000) + '<html><body>late</body></html>')), /不是 HTML/);
});

test('attaching the same file again changes nothing, a changed file is a new diagram', async t => {
  const { service, put, attach, skeletonId, root } = await setup(t);
  const path = await put('same.html', html('same'));
  const first = await attach(path);
  const again = await attach(path);
  assert.equal(again.unchanged, true);
  assert.equal(again.diagram.id, first.diagram.id);
  assert.equal((await service.call('skeleton.diagram.list', { id: skeletonId })).diagrams.length, 1);
  await writeFile(path, html('same', '<p>changed</p>'));
  const second = await attach(path);
  assert.equal(second.unchanged, false);
  assert.notEqual(second.diagram.id, first.diagram.id);
  assert.equal((await readdir(join(root, 'skeleton-diagrams', skeletonId))).length, 2);
});

test('a skeleton keeps at most eight diagrams, the oldest rotate out with a notice and their files go', async t => {
  const { service, put, attach, skeletonId, root } = await setup(t);
  assert.equal(MAX_DIAGRAMS, 8);
  const made = [];
  for (let i = 0; i < 8; i += 1) made.push((await attach(await put(`d${i}.html`, html(`d${i}`)))).diagram);
  const ninth = await attach(await put('d8.html', html('d8')));
  assert.deepEqual(ninth.rotated.map(item => item.title), ['d0']);
  assert.match(ninth.notice, /d0/);
  const listed = (await service.call('skeleton.diagram.list', { id: skeletonId })).diagrams;
  assert.equal(listed.length, 8);
  assert.deepEqual(listed.map(item => item.title), ['d8', 'd7', 'd6', 'd5', 'd4', 'd3', 'd2', 'd1'], 'newest first');
  assert.equal(await exists(join(root, 'skeleton-diagrams', skeletonId, `${made[0].id}.html`)), false);
  assert.equal(await exists(join(root, 'skeleton-diagrams', skeletonId, `${ninth.diagram.id}.html`)), true);
});

test('removing a diagram deletes the stored copy and the record, and leaves the source file alone', async t => {
  const { service, put, attach, skeletonId, root } = await setup(t);
  const source = await put('rm.html', html('rm'));
  const { diagram } = await attach(source);
  const removed = await service.call('skeleton.diagram.remove', { id: skeletonId, diagramId: diagram.id });
  assert.equal(removed.removed, diagram.id);
  assert.equal(await exists(join(root, 'skeleton-diagrams', skeletonId, `${diagram.id}.html`)), false);
  assert.equal(await exists(source), true);
  assert.deepEqual((await service.call('skeleton.diagram.list', { id: skeletonId })).diagrams, []);
  await assert.rejects(service.call('skeleton.diagram.remove', { id: skeletonId, diagramId: diagram.id }), error => error.code === 'not-found');
  await assert.rejects(service.call('skeleton.diagram.get', { id: skeletonId, diagramId: diagram.id }), error => error.code === 'not-found');
});

test('an unknown skeleton is not-found and ids can never be used to leave the diagram folder', async t => {
  const { service, put, attach } = await setup(t);
  const path = await put('x.html', html('x'));
  await assert.rejects(service.call('skeleton.diagram.attach', { id: 'gone', path, workspace: join(path, '..', '..') }), error => error.code === 'not-found');
  await assert.rejects(service.call('skeleton.diagram.list', { id: 'gone' }), error => error.code === 'not-found');
  await assert.rejects(service.call('skeleton.diagram.get', { id: '../../x', diagramId: '..' }), /not-found|找不到|Skeleton/);
  assert.ok(await attach(path));
});

test('the stored copy is checked against its record: a changed or missing file is reported, not shown', async t => {
  const { service, put, attach, skeletonId, root } = await setup(t);
  const { diagram } = await attach(await put('t.html', html('t')));
  const stored = join(root, 'skeleton-diagrams', skeletonId, `${diagram.id}.html`);
  await writeFile(stored, html('t', '<p>tampered</p>'));
  await assert.rejects(service.call('skeleton.diagram.get', { id: skeletonId, diagramId: diagram.id }), /已被改动/);
  await rm(stored);
  await assert.rejects(service.call('skeleton.diagram.get', { id: skeletonId, diagramId: diagram.id }), /不在学习库里/);
  // the record can still be removed
  assert.equal((await service.call('skeleton.diagram.remove', { id: skeletonId, diagramId: diagram.id })).removed, diagram.id);
});

test('changing the skeleton marks its diagrams as possibly out of date, and the records survive the change', async t => {
  const { service, put, attach, skeletonId } = await setup(t);
  const { diagram } = await attach(await put('s.html', html('s')));
  await new Promise(resolve => setTimeout(resolve, 5));
  await service.call('skeleton.patch', { id: skeletonId, ops: [{ op: 'node.add', node: { id: 'n3', term: 'Isolation', meaning: 'Limit blast radius', cards: [] } }] });
  const listed = (await service.call('skeleton.diagram.list', { id: skeletonId })).diagrams;
  assert.deepEqual(listed.map(item => [item.id, item.stale]), [[diagram.id, true]]);
  const skeleton = await service.call('skeleton.get', { id: skeletonId });
  assert.equal(skeleton.diagrams.length, 1);
  const summary = (await service.call('skeleton.list', {})).skeletons.find(item => item.id === skeletonId);
  assert.equal(summary.diagrams, 1, 'the page learns of a new diagram from the list');
  const saved = await service.call('skeleton.save', { skeleton: { id: skeletonId, title: '可用性 2', scope: skeleton.scope, overview: 'o', nodes: skeleton.nodes, relations: [] } });
  assert.equal((saved.diagrams ?? saved.skeleton?.diagrams).length, 1, 'a full re-save keeps them too');
});

test('deleting a skeleton deletes its diagram folder', async t => {
  const { service, put, attach, skeletonId, root } = await setup(t);
  await attach(await put('y.html', html('y')));
  assert.equal(await exists(join(root, 'skeleton-diagrams', skeletonId)), true);
  await service.call('skeleton.delete', { id: skeletonId });
  assert.equal(await exists(join(root, 'skeleton-diagrams', skeletonId)), false);
});

test('the host replaces any workspace the caller supplied with the session workspace', () => {
  assert.deepEqual(scopeDiagramArgs('skeleton.diagram.attach', { id: 'k', path: 'a.html', workspace: '/' }, '/work/space'), { id: 'k', path: 'a.html', workspace: '/work/space' });
  assert.deepEqual(scopeDiagramArgs('skeleton.diagram.attach', { id: 'k', path: 'a.html' }, '/work/space'), { id: 'k', path: 'a.html', workspace: '/work/space' });
  const other = { id: 'k', workspace: '/' };
  assert.equal(scopeDiagramArgs('skeleton.get', other, '/work/space'), other, 'other actions are untouched');
  assert.deepEqual(scopeDiagramArgs('skeleton.diagram.list', { id: 'k' }, '/work/space'), { id: 'k' });
});

test('the agent-facing contract names the four operations in a line or two and stays within the area limit', () => {
  const text = libraryContracts.skeletons;
  for (const name of ['skeleton.diagram.attach', 'skeleton.diagram.list', 'skeleton.diagram.get/remove']) assert.ok(text.includes(name), name);
  const diagram = text.slice(text.indexOf('skeleton.diagram.attach'));
  assert.ok(diagram.length < 700, `the diagram text stays short (${diagram.length})`);
  assert.ok(text.length < 6000);
  assert.ok(studyToolDescription.length + studyUsagePrompt.length < 6000);
  assert.match(studyToolDescription, /skeleton\.diagram/);
});

test('the full backup carries the attached diagrams and a restore into a fresh library brings them back', async t => {
  const { service, put, attach, skeletonId } = await setup(t);
  const body = html('backed up');
  const { diagram } = await attach(await put('b.html', body));
  const backup = await service.call('export');
  assert.equal(backup.portableDiagrams.format, 'study-skeleton-diagrams/v1');
  assert.deepEqual(backup.portableDiagrams.files.map(file => [file.skeletonId, file.id, file.sha256]), [[skeletonId, diagram.id, diagram.sha256]]);
  const target = await mkdtemp(join(tmpdir(), 'study-diagrams-restored-'));
  t.after(() => rm(target, { recursive: true, force: true, maxRetries: 3 }));
  const restored = new StudyService(target);
  t.after(() => restored.dispose());
  await restored.call('restore', { state: JSON.parse(JSON.stringify(backup)) });
  const read = await restored.call('skeleton.diagram.get', { id: skeletonId, diagramId: diagram.id });
  assert.equal(read.html, body);
  assert.equal((await restored.store.read()).portableDiagrams, undefined, 'the encoded files are not kept as library state');
});

test('a backup whose diagram file does not match its record is refused and the library is left as it was', async t => {
  const { service, put, attach } = await setup(t);
  await attach(await put('c.html', html('c')));
  const backup = JSON.parse(JSON.stringify(await service.call('export')));
  backup.portableDiagrams.files[0].dataBase64 = Buffer.from(html('swapped')).toString('base64');
  const target = await mkdtemp(join(tmpdir(), 'study-diagrams-refused-'));
  t.after(() => rm(target, { recursive: true, force: true, maxRetries: 3 }));
  const other = new StudyService(target);
  t.after(() => other.dispose());
  await other.call('source.add', { id: 'keep', title: 'Keep', text: 'Existing content stays.' });
  await assert.rejects(other.call('restore', { state: backup }), /diagram/i);
  assert.deepEqual((await other.store.read()).sources.map(source => source.id), ['keep']);
});

test('a diagram whose file is gone does not stop the backup, and a library without diagrams exports as before', async t => {
  const { service, put, attach, skeletonId, root } = await setup(t);
  assert.equal((await service.call('export')).portableDiagrams, undefined);
  const { diagram } = await attach(await put('d.html', html('d')));
  await rm(join(root, 'skeleton-diagrams', skeletonId, `${diagram.id}.html`));
  const backup = await service.call('export');
  assert.equal(backup.portableDiagrams, undefined, 'nothing to carry, nothing added');
  assert.equal(backup.skeletons[0].diagrams.length, 1, 'the record is still in the library state');
});
