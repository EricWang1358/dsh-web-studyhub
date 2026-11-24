import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { filterOutline as filterCourseOutline } from '../ui/outline/model.js';
import { filterOutlineWithLens } from '../ui/outline/gap-lens.js';
import { chapterMatchesFilter, filterMasteryChapters } from '../ui/mastery-map/model.js';
import { filterOutline as filterReaderOutline } from '../ui/document-preview/reader/outline.js';
import { buildMindMap } from '../ui/document-preview/reader/mind-map.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('W3-14: CoachDebrief pauses autopilot on focus, cancels on non-modifier keys, and skips while askConsent is active', () => {
  const src = read('ui/CoachDebrief.jsx');
  assert.match(src, /\[focused, setFocused\] = useState\(false\)/);
  assert.match(src, /if \(!autopilot \|\| !debrief \|\| !action \|\| cancelled\.current \|\| busy \|\| askConsent\)/);
  assert.match(src, /enabled: left !== null && left > 0 && !hovered && !focused/);
  assert.match(src, /if \(\["Shift", "Control", "Alt", "Meta", "CapsLock"\]\.includes\(event\.key\)\) return;\s*stop\(\);/);
  assert.match(src, /onFocusCapture=\{\(\) => setFocused\(true\)\}/);
});

test('W3-15: CardEditor syncs board revision on reload after conflict and Board awaits archive before closing editor', () => {
  const edSrc = read('ui/board/CardEditor.jsx');
  assert.match(edSrc, /setDraft\(fromCard\(latest\)\); setBase\(board\.revision\); onReloadRevision\?\.\(board\.revision\);/);

  const boardSrc = read('ui/Board.jsx');
  assert.match(boardSrc, /onReloadRevision=\{\(rev\) => \{ setEditing\(\(cur\) => \(cur \? \{ \.\.\.cur, revision: rev \} : cur\)\); clearError\?\.\(\); \}\}/);
  assert.match(boardSrc, /onArchive=\{async \(card\) => \{ setSaving\(true\); try \{ const ok = await archiveCard\(card\); if \(ok\) setEditing\(null\); return ok; \} finally \{ setSaving\(false\); \} \}\}/);
});

test('W3-16: CompanionBuildDialog restricts sources to active course, uses useStudyBusy, guards undefined act reply, and locks Dialog', () => {
  const src = read('ui/companions/CompanionBuildDialog.jsx');
  assert.match(src, /const studyBusy = useStudyBusy\(\);/);
  assert.match(src, /const effectiveSourceIds = useMemo\(/);
  assert.match(src, /if \(res === undefined\) \{\s*setError\(ui\('上一个操作还没结束，请稍后再试。'\)\);\s*return;\s*\}/);
  assert.match(src, /busy=\{submitting\}/);
});

test('W3-17: CourseOutline search matching chapter title keeps descendant points even under gap lens', () => {
  const outline = {
    book: {
      nodes: [
        {
          key: 'ch1',
          kind: 'part',
          title: '第一章 动态规划',
          total: 2,
          summary: { weak: 1, due: 0, draftCards: 0 },
          children: [
            { key: 'pt1', kind: 'point', title: '背包问题', total: 2, summary: { weak: 1, due: 0, draftCards: 0 } },
            { key: 'pt2', kind: 'point', title: '区间转移', total: 0, summary: { weak: 0, due: 0, draftCards: 0 } },
          ],
        },
      ],
    },
  };

  const textRes = filterCourseOutline(outline, {}, new Set(), '动态规划');
  assert.deepEqual(textRes.rows.map((r) => r.key), ['ch1', 'pt1', 'pt2'], 'matching chapter keeps all its child points');

  const gapRes = filterOutlineWithLens(outline, {}, new Set(), '动态规划', 'weak-due');
  assert.deepEqual(gapRes.rows.map((r) => r.key), ['ch1', 'pt1'], 'gap lens + chapter search retains weak descendant instead of returning 0 rows');

  const untestedRes = filterOutlineWithLens(outline, {}, new Set(), '动态规划', 'untested');
  assert.deepEqual(untestedRes.rows.map((r) => r.key), ['ch1', 'pt2'], 'untested lens + chapter search retains untested descendant');
});

test('W3-18: MasteryMap chapterMatchesFilter matches at point level so partial chapters appear and never open empty', () => {
  const mixedChapter = {
    id: 'ch1',
    title: 'Chapter 1',
    total: 10,
    learned: 5,
    mastery: 50,
    weak: 0,
    due: 0,
    uncoveredPoints: 0,
    points: [
      { id: 'p1', title: 'Mastered topic', total: 5, learned: 5, mastery: 90, weak: 0, due: 0 },
      { id: 'p2', title: 'Unstarted topic', total: 5, learned: 0, mastery: 0, weak: 0, due: 0 },
    ],
  };

  assert.equal(chapterMatchesFilter(mixedChapter, 'mastered'), true, 'chapter with a mastered point matches mastered filter');
  assert.equal(chapterMatchesFilter(mixedChapter, 'new'), true, 'chapter with an unstarted point matches new filter');
  assert.equal(chapterMatchesFilter(mixedChapter, 'learning'), false, 'chapter with no learning points does not open empty under learning filter');

  const masteredList = filterMasteryChapters([mixedChapter], { filter: 'mastered' });
  assert.equal(masteredList.length, 1);
  assert.deepEqual(masteredList[0].matchedPoints.map((p) => p.id), ['p1']);

  const newList = filterMasteryChapters([mixedChapter], { filter: 'new' });
  assert.equal(newList.length, 1);
  assert.deepEqual(newList[0].matchedPoints.map((p) => p.id), ['p2']);
});

test('W3-19: reader filterOutline searches visible page/slide/chunk labels with dash/space tolerance and skips empty trails', () => {
  const tree = [
    { id: 'chunk-1', parent: null, title: '', kind: 'chapter', chapter: { startPage: 21, endPage: 40 } },
    { id: 'p25', parent: 'chunk-1', title: 'B-Tree Split', page: 25 },
    { id: 'p26', parent: 'chunk-1', title: '', page: 26 },
    { id: 'rec-2', parent: null, title: '第二讲', kind: 'recording', recording: 2 },
  ];
  const labelOf = (node) => (node.kind === 'chapter'
    ? `第 ${node.chapter.startPage}–${node.chapter.endPage} 页`
    : node.page ? `第 ${node.page} 页`
      : node.kind === 'recording' ? `录音 ${node.recording}` : '');

  assert.deepEqual(filterReaderOutline(tree, '第26页', labelOf).map((r) => r.id), ['p26'], 'matches compact page label');
  assert.deepEqual(filterReaderOutline(tree, '21-40', labelOf).map((r) => r.id), ['chunk-1'], 'matches en-dash range with ASCII hyphen');
  assert.deepEqual(filterReaderOutline(tree, '录音2', labelOf).map((r) => r.id), ['rec-2'], 'matches compact recording label');

  const hit = filterReaderOutline(tree, 'B-Tree', labelOf);
  assert.equal(hit.length, 1);
  assert.deepEqual(hit[0].trail, ['第 21–40 页'], 'untitled chunk parent falls back to its label in trail instead of empty string');
});

test('W3-20: reader buildMindMap falls back to chapter page headings on AI chapters and to top-level tree on flat transcripts/notes', () => {
  // 1. Paged document with level-1 AI chapters: slices sections to current chapter range
  const aiOutline = [
    { id: 'ai-0', level: 1, title: 'Ch 1 Intro', sourceId: 's1', parent: null },
    { id: 'ai-1', level: 1, title: 'Ch 2 Indexing', sourceId: 's3', parent: null },
  ];
  const sections = [
    { id: 'sec1', kind: 'page', sourceId: 's1', page: 1, paragraphs: [{ kind: 'heading', text: '1.1 Overview' }] },
    { id: 'sec2', kind: 'page', sourceId: 's2', page: 2, paragraphs: [{ kind: 'heading', text: '1.2 Goals' }] },
    { id: 'sec3', kind: 'page', sourceId: 's3', page: 3, paragraphs: [{ kind: 'heading', text: '2.1 B+ Tree' }] },
  ];
  const ch1Map = buildMindMap({ title: 'Book', sections, outline: aiOutline, activeId: 'ai-0', branch: true });
  assert.equal(ch1Map.title, 'Ch 1 Intro');
  assert.deepEqual(ch1Map.children.map((c) => c.title), ['1.1 Overview', '1.2 Goals'], 'AI chapter slices only its own pages');

  // 2. Flat transcript / markdown outline with >= 2 level-1 entries
  const flatOutline = [
    { id: 'p1', level: 1, title: '第一部分', kind: 'chapter', parent: null },
    { id: 'p2', level: 1, title: '第二部分', kind: 'chapter', parent: null },
  ];
  const flatMap = buildMindMap({ title: 'Lecture 1', sections: [], outline: flatOutline, activeId: 'p1', branch: true });
  assert.equal(flatMap.title, 'Lecture 1');
  assert.deepEqual(flatMap.children.map((c) => c.title), ['第一部分', '第二部分']);

  // 3. Multi-level document where an empty leaf chapter must NOT dump the whole book
  const multiOutline = [
    { id: 'c1', level: 1, title: 'Ch 1', parent: null },
    { id: 'c1-1', level: 2, title: '1.1 Sub', parent: 'c1' },
    { id: 'c2', level: 1, title: 'Ch 2 Empty', parent: null },
  ];
  const emptyLeafMap = buildMindMap({ title: 'Notes', sections: [], outline: multiOutline, activeId: 'c2', branch: true });
  assert.equal(emptyLeafMap.count, 0, 'empty chapter in multi-level document stays empty instead of dumping whole outline');
});
