import test from 'node:test';
import assert from 'node:assert/strict';
import { dropRepeatedLines, restoreRepeatedLines } from '../lib/repeated-lines.js';
import { parseConvertedDocument } from '../lib/converted-document.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import { createMaterialsOperations } from '../lib/contexts/materials/operations.js';

/* The same block on every page (owner report 2026-11-05: a training class's contact lines on each page of the material). Lines that repeat on a large share of
   the pages of one converted document are left out of its stored text; the learner can put them back. */

const AD = ['考研培训班 咨询电话 400-123-4567', '微信：study2026 · 地址：北京市海淀区'];
const page = (n, lines) => ({ page: n, text: lines.join('\n') });
const TOPICS = ['集合', '映射', '函数', '极限', '连续', '导数', '微分', '积分', '级数', '方程'];
const said = at => `这一页讲${TOPICS[at % TOPICS.length]}，它和前面的内容有关。`;
const book = Array.from({ length: 10 }, (_, at) => page(at + 1, [`# 第${at + 1}节 ${TOPICS[at]}`, '', said(at), '', AD[0], '', AD[1], '', `- ${at + 1} -`]));

test('a block on most pages and the page numbers are left out; everything else stays, word for word', () => {
  const { pages, lines, count } = dropRepeatedLines(book);
  for (const one of pages) {
    assert.doesNotMatch(one.text, /培训班|微信/);
    assert.doesNotMatch(one.text, /^- \d+ -$/m);
    assert.match(one.text, new RegExp(`^# 第${one.page}节 ${TOPICS[one.page - 1]}$`, 'm'));
    assert.ok(one.text.includes(said(one.page - 1)));
    assert.doesNotMatch(one.text, /\n{3,}/, 'no gap is left where the lines were');
  }
  assert.equal(count, 30);
  assert.deepEqual(lines.map(line => [line.text, line.pages]), [[AD[0], 10], [AD[1], 10], ['- 1 -', 10]]);
});

test('restoring puts every line back exactly where it was', () => {
  const { pages } = dropRepeatedLines(book);
  pages.forEach((one, at) => assert.equal(restoreRepeatedLines(one.text, one.repeated), book[at].text));
  assert.equal(restoreRepeatedLines('text', undefined), 'text');
});

test('the thresholds: at least 3 pages AND at least 40 % of the pages', () => {
  const marked = (count, total) => Array.from({ length: total }, (_, at) => page(at + 1, [said(at), ...(at < count ? [AD[0]] : [])]));
  assert.equal(dropRepeatedLines(marked(2, 4)).count, 0, 'two pages are too few, even at half of them');
  assert.equal(dropRepeatedLines(marked(3, 10)).count, 0, '30 % of the pages is too small a share');
  assert.equal(dropRepeatedLines(marked(4, 10)).count, 4);
});

test('never removed: headings, formulas, code, tables, short labels, numbers that do not follow the page, and a page that would be left empty', () => {
  const keep = ['# 本章小结', '$$', 'E = mc^2', '$$', '```', 'print("hello world")', '```', '| 列一 | 列二 |', '解：', 'Solution:', '其中 $a_n$ 为通项公式'];
  const pages = Array.from({ length: 6 }, (_, at) => page(at + 1, [said(at), ...keep, `例 ${[3, 1, 4, 1, 5, 9][at]}`]));
  const result = dropRepeatedLines(pages);
  assert.equal(result.count, 0);
  assert.deepEqual(result.pages.map(one => one.text), pages.map(one => one.text));
  // A sentence that names its own page is no page number, though its number follows the page.
  const naming = Array.from({ length: 6 }, (_, at) => page(at + 1, [`这是第 ${at + 1} 页的正文。`, said(at)]));
  assert.equal(dropRepeatedLines(naming).count, 0);
  // A page that holds nothing but the repeated lines keeps them (it is not emptied away).
  const only = [...book.slice(0, 5), page(6, [AD[0], '', AD[1]])];
  const kept = dropRepeatedLines(only).pages.at(-1);
  assert.equal(kept.text, only.at(-1).text);
  assert.equal(kept.repeated, undefined);
});

test('a line repeated inside one page counts that page once', () => {
  const pages = [page(1, [AD[0], AD[0], AD[0], '甲']), page(2, ['乙']), page(3, ['丙']), page(4, [AD[0], '丁'])];
  assert.equal(dropRepeatedLines(pages).count, 0);
});

/* ---------- at conversion ---------- */

const content = Array.from({ length: 6 }, (_, at) => [
  { type: 'text', text: `第${at + 1}讲 主题`, text_level: 1, page_idx: at },
  { type: 'text', text: said(at), page_idx: at },
  { type: 'text', text: AD[0], page_idx: at },
]).flat();

test('a converted document leaves the repeated lines out of its pages and says what it removed; keepRepeated keeps them', () => {
  const converted = parseConvertedDocument(JSON.stringify(content), { filename: 'x.pdf' });
  assert.ok(converted.pages.every(one => !one.text.includes('培训班')));
  assert.deepEqual(converted.repeated, { count: 6, lines: [{ text: AD[0], pages: 6 }] });
  assert.ok(converted.pages.every(one => restoreRepeatedLines(one.text, one.repeated).includes(AD[0])));
  const kept = parseConvertedDocument(JSON.stringify(content), { filename: 'x.pdf', keepRepeated: true });
  assert.ok(kept.pages.every(one => one.text.includes('培训班')));
  assert.equal(kept.repeated, undefined);
});

/* ---------- in the library: what was removed, and putting it back ---------- */

async function materials(t) {
  const root = await mkdtemp(join(tmpdir(), 'repeated-lines-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  const ops = createMaterialsOperations({ root,
    read: async () => { const state = await store.read(); return structuredClone({ sources: state.sources, documents: state.documents || [] }); },
    update: fn => store.update(async state => {
      const own = { sources: state.sources, documents: state.documents || [] };
      const result = await fn(own); state.sources = own.sources; state.documents = own.documents; return result;
    }) });
  return { store, call: (action, args = {}) => ops.handlers[action](args) };
}

test('the import says what it removed and keeps it on the version; 恢复 puts the lines back as a new revision of the same document', async t => {
  const { store, call } = await materials(t);
  const bytes = Buffer.from(JSON.stringify(content), 'utf8').toString('base64');
  const imported = await call('materials.document.import', { dataBase64: bytes, filename: '讲义.json', format: 'json', courses: ['SE'] });
  assert.deepEqual(imported.repeated, { count: 6, lines: [{ text: AD[0], pages: 6 }] });
  let state = await store.read();
  assert.deepEqual(state.documents[0].versions[0].repeated, { count: 6, lines: [{ text: AD[0], pages: 6 }] });
  assert.ok(state.sources.every(source => !source.text.includes('培训班')));

  const restored = await call('materials.document.restoreRepeated', { documentId: imported.documentId });
  assert.equal(restored.status, 'restored');
  assert.equal(restored.restored, 6);
  assert.notEqual(restored.revision, imported.revision);
  state = await store.read();
  const now = state.documents[0], version = now.versions.find(item => item.revision === now.currentRevision);
  assert.equal(now.id, imported.documentId, 'the same document');
  assert.equal(version.repeated, undefined);
  assert.equal(now.versions.length, 2, 'the trimmed revision stays in the history');
  const texts = version.sourceIds.map(id => state.sources.find(source => source.id === id).text);
  const whole = parseConvertedDocument(JSON.stringify(content), { filename: '讲义.json', keepRepeated: true }).pages.map(one => one.text);
  assert.deepEqual(texts, whole, 'word for word what the converter gave');
  assert.ok(version.sourceIds.every(id => state.sources.find(source => source.id === id).courses.includes('SE')));
  assert.deepEqual(await call('materials.document.restoreRepeated', { documentId: imported.documentId }),
    { status: 'unchanged', restored: 0, documentId: imported.documentId, revision: now.currentRevision });
});
