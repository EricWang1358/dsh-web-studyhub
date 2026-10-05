/* The reader's outline from the shared sections (lib/sections.js): a transcript's recordings are the first level with their file name, its parts the second;
   the labels 英文原句 / 中文对照 are text of their part, not entries; the furniture a transcript writes at a recording's start is kept in the text but not drawn
   (a quiet recording header instead). Stored text, offsets and the text a selection or a citation sees do not change. */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseFragment } from 'parse5';
import { loadUi } from './helpers/ui-module.mjs';
import { mergedTranscript } from './helpers/merged-transcript.mjs';
import { bilingualMarkdown, headingNodes } from './helpers/bilingual-transcript.mjs';
import { sectionsOf } from '../lib/sections.js';

const ui = await loadUi(`
  export { default as ReadingSections } from './ui/document-preview/reader/ReadingSections.jsx';
  export { readingSections, splitParagraphs } from './ui/document-preview/reader/text-sections.js';
  export { outlineFromSections, structureOutline, collectHeadings, withoutLabels, outlinePath, defaultExpanded, outlineRows, sectionNeighbours, chapterNeighbours } from './ui/document-preview/reader/outline.js';
  export { entrySummaries, assignCards, chapterEntryIds, rangeOptions, subtreeIds } from './ui/document-preview/practice/practice-range.js';
  export { restoreTop } from './ui/document-preview/practice/reading-position.js';`);

const world = mergedTranscript();
const [first, second] = world.sources;
const headed = text => (text.match(/^【第.+部分：.*】$/gm) || []).length;
const reading = (source, group) => ui.readingSections({ paged: false, sources: [source], text: source.text, sourceId: source.id, group });
const entriesOf = (source, group) => ui.outlineFromSections(reading(source, group));

test('the outline of a merged transcript volume: recordings with their file names, the parts under them, and no label', () => {
  const entries = entriesOf(first, world.sources);
  const recordings = entries.filter(entry => entry.kind === 'recording'), parts = entries.filter(entry => entry.kind === 'part');
  assert.equal(entries.length, recordings.length + parts.length, 'nothing else is an entry');
  assert.deepEqual(recordings.map(entry => [entry.level, entry.recording, entry.title]), [[1, 1, 'API应用与产品策略培训.mp3'], [1, 2, '平台框架培训-第二天.mp3'], [1, 3, '平台框架培训-第一天.mp3'], [1, 4, '产品策略答疑录音.wav']]);
  assert.equal(parts.length, headed(first.text), 'the audit counted 181 entries for 60 real parts; now one entry per part');
  assert.ok(parts.every(entry => entry.level === 2 && /^第.+部分：/.test(entry.title)));
  assert.ok(entries.every(entry => !/英文原句|中文对照/.test(entry.title)));
  assert.ok(entries.length < 70, `${entries.length} entries`);
  const tree = ui.structureOutline(entries);
  assert.equal(tree.filter(node => node.minor).length, 0, 'there is nothing left to fold');
  assert.deepEqual(tree.filter(node => node.kind === 'recording').map(node => node.children), [16, 16, 16, headed(first.text) - 48]);
  assert.ok(tree.filter(node => node.kind === 'part').every(node => node.parent && node.depth === 1));
});

test('the second volume continues recording 4: its first entry is that recording and its tail, then recording 5; the other volume\'s numbering is not repeated as new parts', () => {
  const entries = entriesOf(second, world.sources);
  assert.deepEqual(entries.slice(0, 2).map(entry => [entry.kind, entry.recording, entry.continued || false]), [['recording', 4, false], ['part', 4, true]]);
  assert.equal(entries[1].title, entriesOf(first, world.sources).filter(entry => entry.kind === 'part').at(-1).title, 'the tail carries the title of the part it continues');
  assert.deepEqual(entries.filter(entry => entry.kind === 'recording').map(entry => entry.recording), [4, 5]);
  const alone = entriesOf(second, undefined);
  assert.equal(alone[1].continued, true);
  assert.equal(alone[1].title, '', 'without its other volume the tail has no title (the label says it continues)');
  assert.equal(alone.length, entries.length);
});

test('the reading sections keep the text between the headings: the opening above the first heading is its own un-numbered section, and every part keeps its labels as paragraphs', () => {
  const sections = reading(first, world.sources);
  assert.equal(sections[0].kind, 'lead');
  assert.equal(sections[0].id, 'lead');
  assert.match(sections[0].paragraphs[0].text, /^# API应用与产品策略培训\.mp3 \+ 4/);
  const part = sections.find(section => section.kind === 'part');
  const labels = part.paragraphs.filter(paragraph => paragraph.kind === 'label');
  assert.deepEqual(labels.map(paragraph => paragraph.text), ['【英文原句】', '【中文对照】']);
  const recording = sections.find(section => section.kind === 'recording');
  assert.deepEqual(recording.paragraphs.map(paragraph => paragraph.kind), ['furniture']);
  assert.match(recording.paragraphs[0].text, /^={80}\n《API应用与产品策略培训\.mp3》全量中英对照逐字稿\nFull Bilingual Transcript: Preview Lecture Recording 1\n={80}$/);
  // The ids are the sections' own.
  assert.deepEqual(sections.filter(section => section.kind !== 'lead').map(section => section.id), sectionsOf(world.sources).filter(section => section.sourceId === first.id).map(section => section.id));
});

test('[English original] and [Chinese translation] are labels too; ordinary text and a lone 【…】 line are not touched', () => {
  const kinds = text => ui.splitParagraphs(text).map(paragraph => paragraph.kind);
  assert.deepEqual(kinds('[English original]\nThe first sentence of the passage, in full.'), ['label', 'prose']);
  assert.deepEqual(kinds('【中文对照】\n第一句话，写完整。'), ['label', 'prose']);
  assert.deepEqual(kinds('正文里提到【某个词】并不是标记。'), ['prose']);
  assert.deepEqual(kinds('【注意】'), ['label'], 'a lone 【…】 line is a label, not a heading of the document');
  assert.deepEqual(kinds('====\n标题\nFull Bilingual Transcript: x\n====\n\n正文第一段，写完整。'), ['prose', 'prose'], 'four = is too short to be the furniture');
  assert.deepEqual(kinds(`${'='.repeat(80)}\n《a.mp3》全量中英对照逐字稿\nFull Bilingual Transcript: T\n${'='.repeat(80)}`), ['furniture']);
});

/* ---------- drawn ---------- */

const small = mergedTranscript({ recordings: 2, parts: 3, paragraphs: 2 });
const labelOf = section => section.kind === 'recording' ? `录音 ${section.recording}` : '';
const html = (source, group, labels = labelOf) => renderToStaticMarkup(React.createElement(ui.ReadingSections, { sections: reading(source, group), labelOf: labels }));
/** The text a selection, find or a citation counts: outside every data-study-marker. `visible` also leaves out what the reader draws hidden. */
const textOf = (markup, { visible = false } = {}) => {
  let text = '';
  const walk = node => {
    if (node.attrs?.some(attribute => attribute.name === 'data-study-marker')) return;
    if (visible && node.attrs?.some(attribute => attribute.name === 'class' && /\breader-bracket\b/.test(attribute.value))) return;
    if (node.nodeName === '#text') text += node.value;
    node.childNodes?.forEach(walk);
  };
  walk(parseFragment(markup));
  return text;
};

test('drawing a volume keeps every stored character in the text, and hides the furniture', () => {
  const [volume] = small.sources, markup = html(volume, small.sources, () => '');
  assert.equal(textOf(markup).replace(/\s+/g, ''), volume.text.replace(/\s+/g, ''), 'the text a selection or a citation sees is the stored text');
  const shown = textOf(markup, { visible: true });
  assert.doesNotMatch(shown, /={20}/, 'the 80 = are not drawn');
  assert.doesNotMatch(shown, /全量中英对照逐字稿/, 'nor the 《…》 line');
  assert.match(shown, /Preview Lecture Recording 1/, 'the English title stays, as a quiet header');
  assert.match(shown, /API应用与产品策略培训\.mp3/);
});

test('every outline entry has its element, a part names its recording, and labels are small captions, not headings', () => {
  const [volume] = small.sources, markup = html(volume, small.sources), entries = entriesOf(volume, small.sources);
  const ids = [...markup.matchAll(/data-outline-id="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(ids, entries.map(entry => entry.id));
  assert.equal(new Set(ids).size, ids.length);
  assert.equal((markup.match(/class="reader-p reader-p--label"/g) || []).length, 12, 'two labels in each of the six parts');
  assert.equal((markup.match(/<h3 /g) || []).length, entries.length, 'a heading for each entry and no other: the labels are not headings');
  assert.match(markup, /reader-section--recording/);
  assert.match(markup, /class="reader-section__label">录音 2</);
});

test('a text with no transcript structure is drawn as before: one section, no outline', () => {
  const plain = { id: 'p', text: '一整段正文。\n\n又一段。' };
  const sections = reading(plain);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].paragraphs.length, 2);
  assert.deepEqual(ui.outlineFromSections(sections), []);
  const notes = { id: 'n', text: '【注意】\n不是章节。\n\n【提示】\n也不是。\n\n再来一段正文，写完整。' };
  assert.equal(reading(notes).length, 1, 'ordinary 【…】 lines are not sections');
});

test('without recordings the parts are the first level, as before', () => {
  const text = '开场白一句。\n\n【第一部分：容器基础】\n[Part 1: Containers]\n\n【英文原句】\ne\n\n【中文对照】\nc\n\n---\n\n【第二部分：编排】\n\n【英文原句】\ne2\n\n【第三部分：故障诊断】\n看日志。';
  const entries = ui.outlineFromSections(reading({ id: 't', text }));
  assert.deepEqual(entries.map(entry => [entry.level, entry.title]), [[1, '第一部分：容器基础'], [1, '第二部分：编排'], [1, '第三部分：故障诊断']]);
});

/* ---------- the Markdown reader ---------- */

test('Markdown headings: the labels 英文原句 / 中文对照 are not entries, the parts are', () => {
  const nodes = headingNodes(bilingualMarkdown()), all = ui.collectHeadings({ querySelectorAll: () => nodes });
  assert.equal(all.length, 28, 'the DOM has the 18 label headings (collectHeadings is unchanged)');
  const entries = ui.withoutLabels(all);
  assert.equal(entries.length, 10);
  assert.ok(entries.every(entry => !/英文原句|中文对照/.test(entry.title)));
  assert.deepEqual(entries.slice(0, 2).map(entry => entry.title), ['平台经济课堂实录', '第一部分：平台的含义与作用']);
  assert.equal(ui.structureOutline(entries).filter(node => node.minor).length, 0);
});

/* ---------- what uses the entries ---------- */

test('mastery and practice ranges follow the recording → part tree: a recording holds the questions of its parts, "this chapter" is the recording', () => {
  const entries = entriesOf(first, world.sources), tree = ui.structureOutline(entries);
  const part = (recording, number) => tree.find(node => node.kind === 'part' && node.recording === recording && node.title.startsWith(`第${'一二三四五六七八九十'[number - 1]}部分`));
  const card = (cardId, level, at) => ({ deckId: 'd', cardId, level, links: [{ at }] });
  const cards = [card('a', 'mastered', part(1, 1).id), card('b', 'weak', part(1, 3).id), card('c', 'new', part(2, 1).id)];
  // The practice code places a link by the entry its passage is in (practice/place-dom.js, in the browser); here the placer is the part itself.
  const byCard = ui.assignCards(cards, link => link.at).assigned;
  const meters = ui.entrySummaries(tree, byCard);
  const recording = id => tree.find(node => node.kind === 'recording' && node.recording === id).id;
  assert.equal(meters.get(recording(1)).total, 2, 'a recording\'s meter is its parts\'');
  assert.equal(meters.get(recording(2)).total, 1);
  assert.equal(meters.get(recording(3)), undefined);
  assert.equal(meters.get(part(1, 1).id).total, 1);
  assert.equal(meters.get(part(1, 1).id).state, 'mastered');
  // The chapter around a part is its recording, and the range of the recording holds the parts below it.
  const chapter = ui.chapterEntryIds(tree, part(1, 3).id, {});
  assert.equal(chapter[0], recording(1));
  assert.equal(chapter.length, 17);
  const options = ui.rangeOptions({ outline: tree, activeId: part(1, 3).id, assigned: byCard, chapter, all: cards });
  assert.deepEqual(options.map(option => [option.kind, option.summary.total]), [['here', 1], ['chapter', 2], ['document', 3]]);
});

test('previous / next walk the parts across recordings, a recording\'s own entry is a stop, and the path says which recording a part is in', () => {
  const tree = ui.structureOutline(entriesOf(first, world.sources));
  const part = tree.find(node => node.kind === 'part' && node.recording === 2);
  assert.deepEqual(ui.outlinePath(tree, part.id), ['平台框架培训-第二天.mp3', part.title]);
  const around = ui.sectionNeighbours(tree, part.id);
  assert.equal(around.previous.kind, 'recording');
  assert.equal(around.previous.recording, 2);
  assert.equal(around.next.kind, 'part');
  const lastOfFirst = tree.filter(node => node.kind === 'part' && node.recording === 1).at(-1);
  assert.equal(ui.sectionNeighbours(tree, lastOfFirst.id).next.kind, 'recording');
  assert.deepEqual(ui.outlinePath(ui.structureOutline(ui.outlineFromSections(reading({ id: 't', text: '【第一部分：甲】\nx\n\n【第二部分：乙】\ny' }))), 'p1'), ['第一部分：甲'], 'no recording: just the part');
});

test('the open entries of a long outline: the recordings are open and show their parts only for the recording being read', () => {
  const tree = ui.structureOutline(entriesOf(first, world.sources));
  const active = tree.find(node => node.kind === 'part' && node.recording === 3).id;
  const open = ui.defaultExpanded(tree, active);
  assert.ok(open.has(tree.find(node => node.kind === 'recording' && node.recording === 3).id));
  const rows = ui.outlineRows(tree, open);
  assert.ok(rows.length >= 4 && rows.length <= tree.length);
});

test('a position stored before this change (section "part-3") finds no section now and falls back to its scroll offset instead of breaking', () => {
  const ids = new Set([...entriesOf(first, world.sources), ...entriesOf(second, world.sources)].map(entry => entry.id));
  assert.ok(![...ids].some(id => /^part-\d+$/.test(id)), 'the new ids are the sections\' own, so an old id never points at the wrong section');
  assert.ok(!ids.has('part-3'));
  // useReadingLoop: no node for the stored section id -> restoreTop without a sectionTop uses the stored scrollTop, then the progress.
  assert.equal(ui.restoreTop({ saved: { sectionOffset: 40, scrollTop: 900, progress: 0.2 }, sectionTop: undefined, clientHeight: 800, scrollHeight: 10000 }), 900);
  assert.equal(ui.restoreTop({ saved: { sectionOffset: 0, scrollTop: 0, progress: 0.5 }, sectionTop: undefined, clientHeight: 800, scrollHeight: 10000 }), 4600);
  // The text reader of a text with no recordings still has the single section 'part-0' it always had.
  assert.equal(reading({ id: 'p', text: 'x' })[0].id, 'part-0');
});
