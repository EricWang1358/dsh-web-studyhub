/* 深度定制 4.4 follow-ups (#739): S2 review book by chapters (#1, #2, #3, #5, #6, #7) + gate review regressions. Fake 500-page book and fake model; no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { settleJob } from './helpers/wait.mjs';
import { BIG_COURSE, bookPaper, chapterTitle } from './helpers/big-book-library.mjs';
import { bigBookWorld as world, leavesOf, written } from './helpers/big-book-world.mjs';
import { courseOutlineMaterial, legacyMaterialsFingerprint, legacyPartPrint, materialsFingerprint, outlineStale, partPrint, partsNow } from '../lib/course-outline-book.js';
import { currentInventory, normalizeInventory } from '../lib/course-book-inventory.js';
import { readPaper } from '../lib/contexts/generation/outline/read.js';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { stampSegmentations } from '../lib/document-outline.js';

const run = async (w, args = {}) => {
  const job = await w.ask({ sample: 'skip', ...args });
  if (job.jobId) await settleJob(w.service, job.jobId);
};

test('#739 item 1: a changed chapter whose items all sit in other chapters settles its print and keeps its explanations, alone or beside another chapter', async t => {
  const w = await world(t);
  const ids = await w.chapterIds();
  await w.build({ chapters: [ids[2], ids[3]], sample: 'skip' });
  const countBefore = written(await w.notes()).length;
  const page3Text = (await w.service.store.read()).sources.find(source => source.id === 'big-p101').text;

  // Every page of chapter 4 now repeats chapter 3's facts, so chapter 4 has 0 unheld items outside chapter 3.
  await w.service.store.update(state => {
    for (const source of state.sources) if (source.document?.chapter?.index === 3) source.text = `${page3Text} extra note.`;
  });
  assert.equal((await w.shown()).stale, true, 'chapter 4 changed');
  await run(w);
  assert.equal((await w.shown()).stale, false, '更新 settles chapter 4 instead of leaving the book stale forever');
  assert.equal(written(await w.notes()).length, countBefore, 'existing explanations are kept');

  // Multi-chapter adds: chapter 4 shrinks to 10 pages (still 0 unheld items, shifting chapter 5 into @s160..199) while chapter 5 is added in the same build.
  await w.service.store.update(state => {
    state.sources = state.sources.filter(source => !(source.document?.chapter?.index === 3 && source.document.page > 160));
    for (const source of state.sources) if (source.document?.chapter?.index === 3) source.text = `${page3Text} second edit.`;
  });
  assert.equal((await w.shown()).stale, true);
  await w.build({ chapters: [ids[4]], sample: 'skip' });
  assert.equal((await w.shown()).stale, false, 'multi-chapter build settles chapter 4 while adding chapter 5');
  assert.deepEqual((await w.outline()).courseOutline.nodes.map(node => node.title), [3, 4, 5].map(chapterTitle));

  // Multi-chapter redo where both chapters are redone and one chapter's items all sit in the other redo chapter.
  const w2 = await world(t);
  const ids2 = await w2.chapterIds();
  await w2.build({ chapters: [ids2[2], ids2[3]], sample: 'skip' });
  await w2.service.store.update(state => {
    state.sources.find(source => source.id === 'big-p105').text += ' Heat Basics fact 88888: a fresh note.';
    for (const source of state.sources) if (source.document?.chapter?.index === 3) source.text = `${page3Text} shared only with chapter 3.`;
  });
  assert.equal((await w2.shown()).stale, true);
  await run(w2);
  assert.equal((await w2.shown()).stale, false, 'both redo chapters settled even when one got 0 leaves of its own');
  assert.deepEqual((await w2.shown()).parts.filter(part => part.pending).length, 8, 'neither built chapter reverted to pending');
});

test('#739 item 2: a changed chapter of a material no longer taught (paper or copyOf) settles in 0 model calls and keeps its explanations', async t => {
  const w = await world(t);
  await w.service.store.update(state => {
    state.sources.push({ id: 'extra-doc', title: 'Supplement Notes', text: 'Supplement Basics fact 1: keep every assumption written down.',
      createdAt: new Date(Date.UTC(2026, 9, 2)).toISOString(), courses: [BIG_COURSE], document: { materialId: 'doc-supplement', format: 'md', filename: 'Supplement Notes.md' } });
  });
  const docs = (await w.service.call('course.custom.preview', { course: BIG_COURSE })).skeleton.documents;
  const chap3 = docs[0].chapters[2].id, extraId = docs[1].chapters[0].id;
  await w.build({ chapters: [chap3, extraId], sample: 'skip' });
  const savedBodies = new Map(written(await w.notes()).map(leaf => [leaf.id, leaf.body]));
  assert.equal(savedBodies.size, 6);

  // Material becomes a copyOf an earlier material while changing since it was built.
  await w.service.store.update(state => {
    const updated = 'Supplement Basics fact 1: keep every assumption written down and checked.';
    state.sources.unshift({ id: 'extra-copy-leader', title: 'Supplement Notes', text: updated,
      createdAt: new Date(Date.UTC(2026, 9, 1)).toISOString(), courses: [BIG_COURSE], document: { materialId: 'doc-supplement-0', format: 'md', filename: 'Supplement Notes.md' } });
    state.sources.find(source => source.id === 'extra-doc').text = updated;
  });
  const copyDoc = (await w.service.call('course.custom.preview', { course: BIG_COURSE })).skeleton.documents.find(doc => doc.key === extraId);
  assert.ok(copyDoc?.copyOf, 'the built material is now copyOf, no longer taught');
  assert.equal((await w.shown()).stale, true, 'its chapter print changed');
  assert.equal((await w.ask({ estimate: true })).scale.calls.low, 0, 'settle-only update estimates 0 calls');
  const markCopy = w.fake.calls.length;
  await run(w);
  assert.equal(w.since(markCopy).length, 0, 'settled in 0 model calls');
  assert.equal((await w.shown()).stale, false, 'no longer stale');
  for (const [id, body] of savedBodies) assert.deepEqual((await w.notes()).courseNotes.leaves.find(leaf => leaf.id === id)?.body, body);

  // Material renamed to a sample paper (`paper: true`) and edited: also settles in 0 model calls.
  await w.service.store.update(state => {
    state.sources = state.sources.filter(source => source.id !== 'extra-copy-leader');
    const src = state.sources.find(source => source.id === 'extra-doc');
    src.title = 'Supplement 2025 样卷';
    src.document.filename = 'Supplement 2025 样卷.md';
    src.text += ' Q8 Extra line.';
  });
  const paperDoc = (await w.service.call('course.custom.preview', { course: BIG_COURSE })).skeleton.documents.find(doc => doc.key === extraId);
  assert.equal(paperDoc?.paper, true);
  assert.equal((await w.shown()).stale, true);
  const markPaper = w.fake.calls.length;
  await run(w);
  assert.equal(w.since(markPaper).length, 0, 'settled in 0 model calls');
  assert.equal((await w.shown()).stale, false);
});

test('#739 item 3 & gate 1: same-length edits go stale while v4.4.0–v4.4.4 2-field/5-field outlines and summary documents without textPrint stay fresh', async t => {
  // Pure check on segmented single-text document and materialsFingerprint.
  const makeMd = word => stampSegmentations([{ id: 'md-1', title: 'Notes', text: `# Intro\nAlpha ${word} rules.\n# Next\nBeta gamma rules.`, format: 'md' }],
    [{ documentId: 'd', revision: 'r', sourceIds: ['md-1'], level: 1,
      chapters: [{ index: 0, title: 'Intro', level: 1, sourceId: 'md-1', offset: 0 }, { index: 1, title: 'Next', level: 1, sourceId: 'md-1', offset: 26 }], savedAt: '' }]);
  const fullSources = makeMd('1111'), editedSources = makeMd('2222');
  const [docA] = groupSourcesByDocument(fullSources), [docB] = groupSourcesByDocument(editedSources);
  assert.equal(docA.chars, docB.chars, 'exact same character length');
  assert.notEqual(materialsFingerprint([docA]), materialsFingerprint([docB]), 'materialsFingerprint sees a same-length edit');
  assert.notEqual(docA.chapters[0].textPrint, docB.chapters[0].textPrint, 'edited chapter textPrint changes');
  assert.equal(docA.chapters[1].textPrint, docB.chapters[1].textPrint, 'untouched chapter textPrint stays the same');

  // (a) Existing v4.4.0–v4.4.4 S2 outline (2-field part.print, no textPrint) and whole-course outline (5-field fingerprint) stay stale: false on upgrade.
  const v44Part = courseOutlineMaterial({ title: 'T', course: 'C', orderBasis: { codes: [] }, fingerprint: '01234567', other: { anchors: [] },
    nodes: [{ id: 'n1', title: 'Intro', anchors: [`${docA.key}#0`] }],
    parts: [{ key: `${docA.key}#0`, doc: docA.key, node: 'n1', title: 'Intro', pages: [1, 1], print: legacyPartPrint(docA.chapters[0]) }] });
  assert.equal(v44Part.courseOutline.parts[0].textPrint, undefined);
  assert.equal(outlineStale(v44Part.courseOutline, [docA]), false, 'v4.4.0–v4.4.4 2-field part.print stays fresh on upgrade');

  // sameText on a v4.4.0–v4.4.4 part (2-field print, no textPrint) when renamed and shifted in index.
  const [docARenamed] = groupSourcesByDocument(stampSegmentations(
    [{ id: 'md-1', title: 'Notes', text: `# Preamble\nShort.\n# Ch000\nAlpha 1111 rules.\n`, format: 'md' }],
    [{ documentId: 'd', revision: 'r', sourceIds: ['md-1'], level: 1,
      chapters: [{ index: 0, title: 'Preamble', level: 1, sourceId: 'md-1', offset: 0 },
        { index: 1, title: 'Ch000', level: 1, sourceId: 'md-1', offset: 18 }], savedAt: '' }]));
  assert.equal(docARenamed.chapters[1].chars, docA.chapters[0].chars, 'same chapter size and sourceIds');
  assert.equal(partsNow(v44Part.courseOutline.parts, [docARenamed])[0].lost, false, 'v4.4.0–v4.4.4 2-field part matches via legacyPartPrint on rename+move');

  const v44Whole = courseOutlineMaterial({ title: 'T', course: 'C', orderBasis: { codes: [] }, fingerprint: legacyMaterialsFingerprint([docA]),
    other: { anchors: [] }, nodes: [{ id: 'n1', title: 'Notes', anchors: [docA.key] }] });
  assert.equal(outlineStale(v44Whole.courseOutline, [docA]), false, 'v4.4.0–v4.4.4 5-field whole-course fingerprint stays fresh on upgrade');

  // (b) Newly built v4.4.5+ S2 and whole-course outlines stay stale: false when given summary documents without textPrint (e.g. summarizeSource).
  const ch0 = docA.chapters[0];
  const newPart = courseOutlineMaterial({ title: 'T', course: 'C', orderBasis: { codes: [] }, fingerprint: '01234567', other: { anchors: [] },
    nodes: [{ id: 'n1', title: 'Intro', anchors: [`${docA.key}#0`] }],
    parts: [{ key: `${docA.key}#0`, doc: docA.key, node: 'n1', title: 'Intro', pages: [1, 1], textPrint: ch0.textPrint, print: partPrint(ch0) }] });
  const newWhole = courseOutlineMaterial({ title: 'T', course: 'C', orderBasis: { codes: [] }, fingerprint: materialsFingerprint([docA]),
    other: { anchors: [] }, nodes: [{ id: 'n1', title: 'Notes', anchors: [docA.key] }] });
  const summarySources = fullSources.map(({ text, ...rest }) => ({ ...rest, chars: text.length }));
  const summaryDocs = groupSourcesByDocument(summarySources);
  assert.equal(summaryDocs[0].textPrint, undefined);
  assert.equal(summaryDocs[0].chapters[0].textPrint, undefined);
  assert.equal(outlineStale(newPart.courseOutline, summaryDocs), false, 'summary documents without textPrint do not flip S2 outline stale');
  assert.equal(outlineStale(newWhole.courseOutline, summaryDocs), false, 'summary documents without textPrint do not flip whole-course outline stale');

  // (c) Same-length edit on newly built outlines immediately flips stale: true.
  assert.equal(outlineStale(newPart.courseOutline, [docB]), true, 'same-length edit flips S2 outline stale');
  assert.equal(outlineStale(newWhole.courseOutline, [docB]), true, 'same-length edit flips whole-course outline stale');

  // End-to-end check on an outline built by chapters.
  const w = await world(t);
  const ids = await w.chapterIds();
  await w.build({ chapters: [ids[2]], sample: 'skip' });
  assert.equal((await w.shown()).stale, false);
  await w.service.store.update(state => {
    const src = state.sources.find(source => source.id === 'big-p120');
    const replaced = src.text.replace('rule number 0', 'rule number 9');
    assert.equal(replaced.length, src.text.length);
    src.text = replaced;
  });
  assert.equal((await w.shown()).stale, true, 'a same-length edit in a built chapter marks the book stale');
});

test('#739 gate 3: editing one chapter of a single-text segmented material updates their shared node without dropping sibling built chapters', async t => {
  const w = await world(t);
  const ch0Text = '# Seg Alpha\nAlpha Rule fact 1: keep every boundary explicit.\n';
  const ch1Text = '# Seg Beta\nBeta Rule fact 1: keep every invariant tested.\n';
  await w.service.store.update(state => {
    state.sources.push({ id: 'md-seg', title: 'Segmented Guide', text: ch0Text + ch1Text, format: 'md',
      createdAt: new Date(Date.UTC(2026, 9, 3)).toISOString(), courses: [BIG_COURSE], document: { materialId: 'doc-md-seg', format: 'md', filename: 'Segmented Guide.md' } });
    state.documents.push({ id: 'doc-md-seg', currentRevision: 'r1', versions: [{ revision: 'r1', sourceIds: ['md-seg'],
      outline: { revision: 'r1', segmentation: { level: 1 }, savedAt: '2026-10-03T00:00:00.000Z',
        entries: [{ title: 'Seg Alpha', level: 1, anchor: { sourceId: 'md-seg', offset: 0 } },
          { title: 'Seg Beta', level: 1, anchor: { sourceId: 'md-seg', offset: ch0Text.length } }] } }] });
  });
  const segDoc = (await w.service.call('course.custom.preview', { course: BIG_COURSE })).skeleton.documents.find(doc => doc.key === 'doc:doc-md-seg');
  assert.equal(segDoc.chapters.length, 2);
  const [seg0, seg1] = segDoc.chapters.map(ch => ch.id);
  await w.build({ chapters: [seg0, seg1], sample: 'skip' });
  assert.equal((await w.outline()).courseOutline.parts.length, 2, 'both segmented chapters recorded in parts');

  // Edit only Seg Alpha (same length so Seg Beta's offset and textPrint are completely unchanged).
  const editedCh0 = ch0Text.replace('fact 1', 'fact 2');
  assert.equal(editedCh0.length, ch0Text.length);
  await w.service.store.update(state => {
    state.sources.find(source => source.id === 'md-seg').text = editedCh0 + ch1Text;
  });
  assert.equal((await w.shown()).stale, true, 'editing Seg Alpha marks the outline stale');
  await run(w);
  const afterShown = await w.shown();
  assert.equal(afterShown.stale, false, '更新 settles the segmented material');
  const segParts = (await w.outline()).courseOutline.parts.filter(part => part.doc === 'doc:doc-md-seg');
  assert.deepEqual(segParts.map(part => part.key), [seg0, seg1], 'sibling chapter Seg Beta stays built and is not dropped');
  assert.equal(afterShown.parts.some(part => (part.id === seg0 || part.id === seg1) && part.pending), false, 'neither segmented chapter reverted to pending');
});

test('#739 item 5: parts saved without a print count as unchanged while found, changed when lost, and receive their print on settle', () => {
  const pages = [1, 2].map(n => ({ id: `p${n}`, title: `Book · p. ${n}`, text: `Page ${n} text.`,
    document: { materialId: 'doc-b', page: n, totalPages: 2, format: 'pdf', origin: 'converted', converter: 'marker', filename: 'b.pdf',
      chapter: { index: n - 1, title: `Ch ${n}`, level: 1 }, extractionVersion: 2 } }));
  const docs = groupSourcesByDocument(pages), key = docs[0].key;
  const legacy = courseOutlineMaterial({ title: 'T', course: 'C', orderBasis: { codes: [] }, fingerprint: '01234567', other: { anchors: [] },
    nodes: [{ id: 'n1', title: 'Ch 1', anchors: [`${key}#0`] }, { id: 'n2', title: 'Ch 2', anchors: [`${key}#1`] }],
    parts: [{ key: `${key}#0`, doc: key, node: 'n1', title: 'Ch 1', pages: [1, 1] }, { key: `${key}#1`, doc: key, node: 'n2', title: 'Ch 2', pages: [2, 2] }] });
  assert.equal(legacy.courseOutline.parts[0].print, undefined);
  assert.equal(outlineStale(legacy.courseOutline, docs), false, 'legacy parts without print are not stale while their chapters exist');

  const withoutCh2 = groupSourcesByDocument(pages.slice(0, 1));
  const now = partsNow(legacy.courseOutline.parts, withoutCh2);
  assert.deepEqual(now.map(entry => [entry.changed, entry.lost]), [[false, false], [true, true]], 'a missing legacy chapter is marked changed and lost');
  assert.equal(outlineStale(legacy.courseOutline, withoutCh2), true);
});

test('#739 item 6 & gate 2: cross-chapter rename+move (0 text edits) and lost-chapter deletion sync leaf anchors in 0 calls and never collide on later builds', async t => {
  const w = await world(t);
  const ids = await w.chapterIds();
  await w.build({ chapters: [ids[2], ids[3]], sample: 'skip' });
  const beforeCount = written(await w.notes()).length;

  // Case A: Chapter 3 renamed + shifted 20 pages with a text edit; Chapter 4 renamed + moved 200 pages with unchanged text.
  await w.service.store.update(state => {
    for (const source of state.sources) {
      const idx = source.document?.chapter?.index;
      if (idx === 2) {
        source.document.page += 20;
        source.document.chapter = { index: 12, title: 'Unit III — Thermal Physics', level: 1 };
        if (source.id === 'big-p101') source.text = source.text.replace('rule number 0', 'rule number 8');
      } else if (idx === 3) {
        source.document.page += 200;
        source.document.chapter = { index: 13, title: 'Unit IV — Kinematics', level: 1 };
      } else if (idx >= 4) {
        source.document.page += 250;
        source.document.chapter = { ...source.document.chapter, index: idx + 15 };
      }
    }
  });
  const shown = await w.shown();
  assert.equal(shown.parts.some(part => part.lost), false, 'neither renamed+moved chapter is marked lost');
  assert.equal(shown.parts.filter(part => part.pending).length, 8, 'neither renamed+moved chapter is duplicated as pending');
  await run(w);
  const settled = (await w.outline()).courseOutline.parts;
  assert.deepEqual(settled.map(part => [part.title, part.pages]), [['Unit III — Thermal Physics', [121, 170]], ['Unit IV — Kinematics', [351, 400]]]);
  assert.equal((await w.shown()).stale, false);
  assert.equal(written(await w.notes()).length, beforeCount);

  // Case B (gate v2): Built Chapter 4 (idx=3, pages 151..200) genuinely moves PAST Chapter 10 to pages 501..550 (index: 10, 0 text edits),
  // while unbuilt Chapter 5 (idx=4, pages 201..250) stays put and shifts into doc.sourceIds[150..199]!
  const w2 = await world(t);
  const ids2 = await w2.chapterIds();
  await w2.build({ chapters: [ids2[2], ids2[3]], sample: 'skip' });
  const outlineBeforeMove = await w2.outline(), notesBeforeMove = await w2.notes();
  const savedCh4Bodies = new Map(leavesOf([outlineBeforeMove.courseOutline.nodes[1]]).map(leaf => [
    leaf.id, notesBeforeMove.courseNotes.leaves.find(entry => entry.id === leaf.id)?.body,
  ]));
  await w2.service.store.update(state => {
    for (const source of state.sources) {
      const idx = source.document?.chapter?.index;
      if (idx === 2) source.document.chapter = { index: 2, title: 'Part A — Heat', level: 1 };
      else if (idx === 3) {
        source.document.page += 350;
        source.document.chapter = { index: 10, title: 'Part B — Motion', level: 1 };
      }
    }
  });
  assert.equal((await w2.shown()).stale, true, 'cross-chapter rename + move marks the outline stale');
  assert.equal((await w2.ask({ estimate: true })).scale.calls.low, 0, '0-edit cross-chapter move estimates 0 calls');
  const markZero = w2.fake.calls.length;
  await run(w2);
  assert.equal(w2.since(markZero).length, 0, 'cross-chapter move settled in 0 model calls');
  assert.equal((await w2.shown()).stale, false, 'outline is fresh after settling metadata and anchors');
  const movedOutline = await w2.outline(), movedNotes = await w2.notes();
  assert.deepEqual(movedOutline.courseOutline.nodes.map(node => node.title), ['Part A — Heat', 'Part B — Motion']);
  const movedCh4Leaves = leavesOf([movedOutline.courseOutline.nodes[1]]);
  assert.ok(movedCh4Leaves.every(leaf => leaf.anchors.length > 0 && leaf.anchors.every(anchor => /@s4[5-9]\d-4[5-9]\d$/.test(anchor))),
    `moved Chapter 4 anchors shifted to @s450..499 (${movedCh4Leaves.flatMap(leaf => leaf.anchors).join(', ')})`);
  for (const [id, body] of savedCh4Bodies) assert.deepEqual(movedNotes.courseNotes.leaves.find(entry => entry.id === id)?.body, body);

  // Now build Chapter 5 (which shifted into doc.sourceIds[150..199]): must NOT throw `Anchor in two places`!
  const chap5 = (await w2.shown()).parts.find(part => part.pending && part.title === chapterTitle(5)).id;
  await w2.build({ chapters: [chap5], sample: 'skip' });
  assert.deepEqual((await w2.outline()).courseOutline.nodes.map(node => node.title), ['Part A — Heat', chapterTitle(5), 'Part B — Motion']);

  // Case C (gate v2): Deleting built Chapter 4 (`lost: true`) shifts Chapter 5 into doc.sourceIds[150..199]; settling keeps all 10 bodies in 0 calls,
  // and later building Chapter 5 succeeds without `Anchor in two places`!
  const w3 = await world(t);
  const ids3 = await w3.chapterIds();
  await w3.build({ chapters: [ids3[2], ids3[3]], sample: 'skip' });
  assert.equal(written(await w3.notes()).length, 10);
  await w3.service.store.update(state => { state.sources = state.sources.filter(source => source.document?.chapter?.index !== 3); });
  const markLost = w3.fake.calls.length;
  await run(w3);
  assert.equal(w3.since(markLost).length, 0, 'lost chapter settles in 0 model calls');
  assert.equal(written(await w3.notes()).length, 10, 'lost chapter explanations are kept, not overwritten with empty');
  const chap5AfterLoss = (await w3.shown()).parts.find(part => part.pending && part.title === chapterTitle(5)).id;
  await w3.build({ chapters: [chap5AfterLoss], sample: 'skip' });
  assert.equal(written(await w3.notes()).length, 15, 'shifted Chapter 5 builds cleanly alongside kept lost Chapter 4');
});

test('#739 item 7 & gate 4: incremental paper matching bounds same-line questions, dedupes before bounds, and warms cache.papers in part and papersOnly modes', async t => {
  // Pure check: repeated `{ quote }` in model output is deduped before computing `nextBound` so Q5's extracted slice is not clamped to Q5's quote end.
  const dupParsed = readPaper(JSON.stringify({
    questions: [
      { label: 'Q5', quote: 'Explain Heat Basics', points: ['p1'] },
      { label: 'Q5', quote: 'Explain Heat Basics', points: ['p2'] },
      { label: 'Q6', quote: 'State Forces Laws', points: ['p2'] },
    ],
  }), { paper: 'doc:p', sources: [{ id: 's1', text: 'Q5 Explain Heat Basics with a full worked example. (10 marks)\nQ6 State Forces Laws clearly. (10 marks)' }] });
  assert.equal(dupParsed.extracted.length, 2);
  assert.ok(dupParsed.extracted[0].text.includes('(10 marks)'), `duplicate quote did not clamp Q5 slice (${dupParsed.extracted[0].text})`);

  // Standalone `generation.courseOutline.build { papersOnly: true }` warms courseInventory.cache.papers via planPapersOnly.previousInventory,
  // and bounds same-line questions (no \n between Q5 and Q6).
  const w = await world(t);
  const ids = await w.chapterIds();
  await w.build({ chapters: [ids[2], ids[3]], sample: 'skip' });
  assert.equal(w.fake.of('paper').length, 0);

  const sameLinePaper = {
    ...bookPaper(['Explain Heat Basics with an example.', 'State Forces Laws and use them.']),
    text: '2025 Past Paper\nQ5 Explain Heat Basics with an example. (10 marks) Q6 State Forces Laws and use them. (10 marks)',
  };
  await w.service.store.update(state => { state.sources.push(sameLinePaper); });
  const papersJob = await w.service.call('generation.courseOutline.build', {
    course: BIG_COURSE, language: 'en', papers: [ `doc:${sameLinePaper.document.materialId}` ], papersOnly: true,
  });
  await settleJob(w.service, papersJob.jobId);
  assert.equal(w.fake.of('paper').length, 1, 'standalone papersOnly runs paperStage once');
  const cachedInv = currentInventory((await w.service.store.read()).sources, BIG_COURSE);
  assert.equal(cachedInv?.courseInventory.cache?.papers?.length, 1, 'standalone papersOnly warmed courseInventory.cache.papers');

  // Verify normalizeInventory sanitizes cached paper question entries.
  const sanitized = normalizeInventory({ course: 'C', ranges: [], items: [], documents: [],
    cache: { clusters: [], order: null, papers: [{ key: 'k1', questions: [
      { label: ' Q5 ', sourceId: 's1', quote: 'Heat Basics', start: 0, end: 11, text: 'Q5 Heat Basics', extra: 'dropped' },
      { sourceId: '', quote: 'bad', start: 0, end: 3, text: 'bad' },
    ] }] } });
  assert.deepEqual(sanitized.cache.papers, [{ key: 'k1', questions: [{ label: 'Q5', sourceId: 's1', quote: 'Heat Basics', start: 0, end: 11, text: 'Q5 Heat Basics' }] }]);

  // Add chapter 5 (Forces): Q5 stays on Heat Basics without leaking into narrowChunk even though Q5 and Q6 shared a line!
  const mark5 = w.fake.calls.length;
  await w.build({ chapters: [ids[4]], sample: 'skip' });
  const paperCalls5 = w.since(mark5).filter(call => call.stage === 'paper');
  assert.equal(paperCalls5.length, 1, 'one narrowed call for the unplaced question Q6');
  assert.ok(!paperCalls5[0].data.paper[0].text.includes('Heat Basics'), 'same-line sibling Q5 did not leak into narrowChunk');
  assert.ok(paperCalls5[0].data.paper[0].text.includes('State Forces Laws'), 'unplaced Q6 is sent to the model');
  assert.ok(paperCalls5[0].data.points.every(point => point.title.startsWith('Forces')), 'only the added chapter\'s points are in the call');
  const tested = leavesOf((await w.outline()).courseOutline.nodes).filter(leaf => leaf.exam?.evidence?.length).map(leaf => leaf.title).sort();
  assert.deepEqual(tested, ['Forces Laws', 'Heat Basics'], 'kept chapter 3 keeps Q5 and added chapter 5 gets Q6');

  // Add chapter 6 (Energy): every question of the paper is now placed on kept chapters -> 0 paper calls!
  const mark6 = w.fake.calls.length;
  await w.build({ chapters: [ids[5]], sample: 'skip' });
  assert.equal(w.since(mark6).filter(call => call.stage === 'paper').length, 0, '0 paper calls when all paper questions are already placed');
  const testedAfter6 = leavesOf((await w.outline()).courseOutline.nodes).filter(leaf => leaf.exam?.evidence?.length).map(leaf => leaf.title).sort();
  assert.deepEqual(testedAfter6, ['Forces Laws', 'Heat Basics'], 'all paper marks remain intact');
});
