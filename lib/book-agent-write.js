/* book.write (docs/review-book-agent.md): the main chat writes ONE knowledge point's file of the 复习全书, on the learner's request in chat. Small
   arguments on purpose (the host's permission review carries every earlier tool argument): the whole file of one point (`markdown`), one heading's section
   (`section: { heading, markdown }`), or a few exact replacements (`edits: [{ find, replace }]`). A mutation of the state, run by the op in the book's
   writer queue inside one store transaction, through course.book.save's own rule (lib/course-book-edit.js saveBookFile: compare-and-set, heading ids,
   a generated file forked so the generator never writes over the chat's text, the version replaced kept in the history, course.book.revert undoes it).

   book.write { course?, hid, file?: gen|mine|qa (default gen), markdown | section | edits, version? }
   book.write { course?, hid, file?, op: insert|delete|rename|move, ..., version? }: the file's sections as a tree, by heading id (lib/book-section-ops.js:
     insert at a place, delete without a shell, rename, move with what is below); a delete with children 'toUnplaced' also writes 未归位 (its own version);
     - the learner's own files (mine, qa) only when named; a point without a Q&A file gets one;
     - footnotes `[^n]: 「exact words」 (sourceId)` are checked word for word (lib/book-footnotes.js); what is not found is taken out and listed (a
       footnote left exactly as the file has it is kept as written; one the write adds or changes is always checked); the file keeps ONE list [^1]…[^n] (checked before saving); edits that take out a footnote
       still marked in the text are refused (book-footnote-in-use);
     - headings are put below the point's own heading (the 目录 stays a tree); the 练 5 道 / 本节问答 line of a generated file stays at its end;
     - `version` older than the file: a whole-file write is saved and the other text waits as a suggestion (书已更新), as course.book.save does; a section
       or edits are applied to the file as it is now;
   -> { status: saved|merged|unchanged, hid, file, name, version, dropped: [{ n, quote, reason }], outsideCount, warnings, section?: { id, title }, before,
     also? } (the op drops `before` and `also`, the other files' replaced versions, after keeping them in the history). */
import { FILE_TEXT_MAX, saveBookFile } from './course-book-edit.js';
import { genFile, mineFile, qaFile, UNPLACED } from './course-book-files.js';
import { applySectionOp, checkSectionOp, headingsOf, sameTitle, shiftLevels } from './book-section-ops.js';
import { beforeLists, citedFrom, markCitations, orphanedBy, stayingLines, tagMarks, untag } from './book-footnote-binding.js';
import { relabelFootnotes } from './book-parked-text.js';
import { bookIndex } from './course-book-links.js';
import { bookOfCourse, coverageOf, materialIndex, placesOf, pointList, pointOf } from './book-agent-view.js';
import { DEFINITION, footnoteProblems, isLabelLine, knownFootnotes, settleFootnotes, takeFootnotes } from './book-footnotes.js';
import { cjkShare } from './transcript.js';
import { quoteHash } from './book-reading.js';

/** The most characters one write carries (all of markdown, a section or the edits together), and the most edits. */
export const WRITE_CHARS = 20_000, EDITS_MAX = 20;
const NAMES = { gen: genFile, mine: mineFile, qa: qaFile };
const fail = (message, code) => { throw Object.assign(new Error(message), { code }); };
const HEADING = /^(#{1,6})\s+(.*?)\s*$/, ID = /\s*<!-- sh:id (\S+) -->\s*$/;
const LINKS_LINE = /^\[[^\]\n]+\]\(studyhub:\/\/(?:practice|qa)\?[^)\s]*\)(?:\s*·\s*\[[^\]\n]+\]\(studyhub:\/\/(?:practice|qa)\?[^)\s]*\))*\s*$/;
const BLOCK = /<!-- sh:(qa|card|ai)\b[^>]*-->\n[\s\S]*?\n<!-- \/sh:\1 -->/g;
export const OUTSIDE = /（资料以外）|\(资料以外\)|\((?:beyond|outside) the materials\)/gi;
const linesOf = text => String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
const norm = sameTitle;

/** Headings put at `min` or deeper (all moved by the same steps, at most level 6). -> { text, shifted }. */
export function shiftHeadings(text, min) {
  const lines = linesOf(text), headings = headingsOf(lines);
  const top = Math.min(...headings.map(heading => heading.level));
  if (!headings.length || top >= min) return { text: lines.join('\n'), shifted: false };
  for (const heading of headings) lines[heading.at] = lines[heading.at].replace(/^#{1,6}/, '#'.repeat(Math.min(6, heading.level + min - top)));
  return { text: lines.join('\n'), shifted: true };
}

/** A text's footnote definitions (to `pool`, keys prefixed) and the 出处 label taken out, its marks prefixed the same way; the 练 5 道 line apart. */
function split(text, prefix, pool, fallback = null) {
  const body = [], links = [];
  for (const line of linesOf(text)) {
    if (isLabelLine(line)) continue;
    if (LINKS_LINE.test(line.trim())) { links.push(line.trim()); continue; }
    body.push(line);
  }
  // Marks bound to their definitions (lib/book-footnotes.js takeFootnotes): a mark with no footnote of its own text takes the file's earlier footnote of
  // that key (a section citing the file's [^3]); several 出处 lists of one key stay apart.
  const taken = takeFootnotes(body, prefix, fallback);
  for (const [key, value] of taken.pool) pool.set(key, value);
  return { body: taken.lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(), links, defined: taken.defined, missing: taken.missing, borrowed: taken.borrowed };
}

/** The warning for marks of the new text that cite the file's footnote of their key (they have none of their own). */
const borrowedWarning = done => (done.borrowed.size ? [`mark(s) ${[...done.borrowed.keys()].map(key => `[^${key}]`).join(', ')} have no footnote in the new text: they cite the file's footnote of that number`] : []);

/** The refusal of edits that take out a footnote whose marks are still in the text (the marks would go with it, #460). */
function keepMarkedFootnotes(before, after) {
  const orphaned = [...after.missing].filter(([key]) => before.defined.has(key));
  if (!orphaned.length) return;
  const named = orphaned.map(([key, count]) => `[^${key}] (${count})`).join(', ');
  fail(`这次替换删掉了脚注，但正文里还有它的角标：${named}；同一次替换里把角标也删掉，或者留下脚注 / The edits take out footnote(s) still marked in the text: ${named} mark(s); take the marks out in the same edits or keep the footnote`, 'book-footnote-in-use');
}

/** The new text of the file from the request (the footnotes not yet settled): { body, pool, links, warnings }. */
function compose(current, args, level) {
  // The footnote texts the file holds now: only these may be kept as written when they are not found again.
  const warnings = [], pool = new Map(), old = new Map(), known = knownFootnotes(current);
  if (args.edits !== undefined) {
    let text = current;
    args.edits.forEach((edit, at) => {
      const count = text.split(edit.find).length - 1;
      if (count !== 1) fail(`edits[${at}]: find must occur exactly once in the file (found ${count} times); read the point again with book.read`, 'book-edit-find');
      text = text.replace(edit.find, () => edit.replace);
    });
    const done = split(text, 'o', pool);
    keepMarkedFootnotes(split(current, 'o', new Map()), done);
    return { body: done.body, pool, links: done.links, warnings, known };
  }
  const before = split(current, 'o', old);
  old.prefix = 'o';
  if (typeof args.markdown === 'string') {
    const shifted = shiftHeadings(args.markdown, level + 1), done = split(shifted.text, 'n', pool, old);
    for (const [key, value] of old) if (done.body.includes(`[^${key}]`)) pool.set(key, value);
    if (shifted.shifted) warnings.push(`headings moved below the point's own heading (level ${level + 1} or deeper)`);
    warnings.push(...borrowedWarning(done));
    return { body: done.body, pool, links: done.links.length ? done.links : before.links, warnings, known };
  }
  // op insert (lib/book-section-ops.js): a new section at a place, its text made like a section's (the other ops: writeStructure, never composed).
  if (args.op !== undefined) {
    let links = before.links;
    const done = applySectionOp(linesOf(before.body), args, { level, piece: headLevel => {
      const made = sectionPiece(args.section, headLevel, { pool, old, title: args.section.heading.replace(/\s+/g, ' ').trim() });
      if (made.links.length) links = made.links;
      warnings.push(...made.warnings);
      return made;
    } });
    const body = done.lines.join('\n');
    for (const [key, value] of old) if (body.includes(`[^${key}]`)) pool.set(key, value);
    return { body: body.replace(/\n{3,}/g, '\n\n').trim(), pool, links, warnings, section: done.section, known };
  }
  // A section: the heading named (its id, else its title) and what is below it, up to the next heading of its level or higher.
  const lines = linesOf(before.body), headings = headingsOf(lines), wanted = String(args.section.heading ?? '').trim();
  const target = headings.find(heading => heading.id === wanted) ?? headings.find(heading => norm(heading.title) === norm(wanted));
  if (!target && /^h\d+$/.test(wanted)) fail('这一节里没有这个标题 id；用 book.read 看标题和 id / No heading of this id in the file; read the point with book.read', 'book-section-missing');
  const made = sectionPiece(args.section, target ? target.level : level + 1, { pool, old, title: target ? target.title : wanted, id: target?.id });
  warnings.push(...made.warnings);
  const piece = made.lines;
  let body;
  if (target) {
    const end = headings.find(item => item.at > target.at && item.level <= target.level)?.at ?? lines.length;
    body = [...lines.slice(0, target.at), ...piece, ...lines.slice(end)].join('\n');
  } else {
    body = [before.body, '', ...piece].join('\n');
    warnings.push(`no heading "${wanted}" in the file: added as a new section at its end (op insert with after, before or within puts it in its place)`);
  }
  for (const [key, value] of old) if (body.includes(`[^${key}]`)) pool.set(key, value);
  return { body: body.replace(/\n{3,}/g, '\n\n').trim(), pool, links: made.links.length ? made.links : before.links, warnings, known };
}

/** The lines of one section the request writes at `headLevel`: its heading (the request's own first heading line, else `title`; with `id`), then its
    text with deeper headings put below it and its footnotes into `pool`. -> { title, lines, links, warnings }. */
function sectionPiece(section, headLevel, { pool, old, title: fallback, id = null }) {
  let incoming = linesOf(section.markdown);
  while (incoming.length && !incoming[0].trim()) incoming.shift();
  const own = HEADING.exec(incoming[0] ?? ''), title = own ? own[2].replace(ID, '') : fallback;
  if (own) incoming = incoming.slice(1);
  const shifted = shiftHeadings(incoming.join('\n'), headLevel + 1), done = split(shifted.text, 'n', pool, old);
  return { title, lines: [`${'#'.repeat(headLevel)} ${title}${id ? ` <!-- sh:id ${id} -->` : ''}`, '', done.body, ''], links: done.links,
    warnings: [...(shifted.shifted ? [`headings inside the section moved below it (level ${headLevel + 1} or deeper)`] : []), ...borrowedWarning(done)] };
}

/** Q&A, answer-card and AI blocks set aside while the footnotes are settled (their text is the learner's, never renumbered). */
function protect(text) {
  const blocks = [];
  return { text: String(text ?? '').replace(/\r\n?/g, '\n').replace(BLOCK, block => { blocks.push(block); return `\u0000B${blocks.length - 1}\u0000`; }), blocks };
}
const restore = (text, blocks) => text.replace(/\u0000B(\d+)\u0000/g, (mark, at) => blocks[Number(at)] ?? '');

function checkArgs(args) {
  if (args.op !== undefined) {
    checkSectionOp(args);
    if ((args.section?.markdown ?? '').length + String(args.section?.heading ?? '').length > WRITE_CHARS) fail(`one write carries at most ${WRITE_CHARS} characters; insert the section in parts (op insert, then section writes)`, 'book-write-too-long');
    return;
  }
  const modes = ['markdown', 'section', 'edits'].filter(key => args[key] !== undefined);
  if (modes.length !== 1) fail('book.write needs exactly one of markdown, section {heading, markdown} or edits [{find, replace}]', 'book-write-mode');
  if (args.markdown !== undefined && typeof args.markdown !== 'string') fail('markdown must be a string', 'book-write-mode');
  if (args.section !== undefined && (typeof args.section?.heading !== 'string' || !args.section.heading.trim() || typeof args.section.markdown !== 'string')) fail('section must be { heading, markdown }', 'book-write-mode');
  if (args.edits !== undefined && (!Array.isArray(args.edits) || !args.edits.length || args.edits.length > EDITS_MAX
    || args.edits.some(edit => typeof edit?.find !== 'string' || !edit.find || typeof edit.replace !== 'string'))) fail(`edits must be 1-${EDITS_MAX} items { find (non-empty, exact), replace }`, 'book-write-mode');
  const size = (args.markdown ?? '').length + (args.section?.markdown ?? '').length + (args.edits || []).reduce((sum, edit) => sum + edit.find.length + edit.replace.length, 0);
  if (size > WRITE_CHARS) fail(`one write carries at most ${WRITE_CHARS} characters; write the point heading by heading (section)`, 'book-write-too-long');
}

/** book.write (see the top of this file). `history`: the course's version history (the base of a stale whole-file write). */
export function writeBookPoint(state, args = {}, { history = [], reading = null } = {}) {
  checkArgs(args);
  const book = bookOfCourse(state, args);
  if (!book) fail('这门课还没有复习全书，先用 book.toc / This course has no review book yet; call book.toc first', 'course-book-missing');
  const { course, doc } = book, row = pointOf(pointList(doc), args.hid), kind = args.file ?? 'gen';
  if (!Object.hasOwn(NAMES, kind)) fail('file must be gen, mine or qa', 'book-file-invalid');
  const name = NAMES[kind](row.node.id), created = !doc.files[name];
  if (created && kind !== 'qa') fail('书里没有这份文件 / The book has no such file', 'course-book-file-missing');
  if (created) doc.files[name] = { text: '', version: 1 };
  const file = doc.files[name], level = row.depth + 1, language = doc.language === 'en' ? 'en' : 'zh';
  // The blocks of the file and of the request set aside as one list: a block the request copies from the file is the same block.
  const current = protect(file.text), blocks = [...current.blocks];
  const mark = text => {
    const own = protect(text);
    return own.text.replace(/\u0000B(\d+)\u0000/g, (whole, at) => {
      const raw = own.blocks[Number(at)], known = blocks.indexOf(raw);
      if (known >= 0) return `\u0000B${known}\u0000`;
      blocks.push(raw);
      return `\u0000B${blocks.length - 1}\u0000`;
    });
  };
  const request = { ...args, ...(args.markdown !== undefined ? { markdown: mark(args.markdown) } : {}), ...(args.section ? { section: { ...args.section, markdown: mark(args.section.markdown) } } : {}),
    ...(args.edits ? { edits: args.edits.map(edit => ({ find: mark(edit.find), replace: mark(edit.replace) })) } : {}) };
  // Rename, move and delete of a heading work on the file's raw text (writeStructure): nothing of it goes through the footnote pipeline.
  if (args.op !== undefined && args.op !== 'insert') return writeStructure(state, { args, course, doc, row, kind, name, file, level, current, blocks });
  const composed = compose(current.text, request, level), warnings = [...composed.warnings];
  const index = materialIndex(state, course), byId = index.byId;
  const places = placesOf(index, row.node), settled = settleFootnotes(composed.body, composed.pool, { segments: places, byId, language, known: composed.known });
  const unsound = footnoteProblems(settled.text);
  if (unsound.length) fail(`the footnotes would not be one list (${unsound.slice(0, 3).join('; ')}); nothing was written`, 'book-footnote-check');
  const read = coverageOf(places, reading, new Set()).totals;
  if (read.pages && !read.opened && !read.partial) warnings.push(`none of this point's ${read.pages} page(s) were opened with source.pages yet: open them before writing what the materials say`);
  let text = settled.text;
  // The 练 5 道 / 本节问答 line stays the file's last line.
  if (composed.links.length) text = `${text.replace(/\s+$/, '')}\n\n${[...new Set(composed.links)].join('\n')}`;
  text = restore(text, blocks).trim();
  const lost = current.blocks.filter(block => !text.includes(block)).length;
  if (lost) warnings.push(`${lost} Q&A / AI block(s) of the file are no longer in it (course.book.revert {file: "${name}"} brings the previous version back)`);
  if (settled.unused.length) warnings.push(`footnote(s) ${settled.unused.join(', ')} found but marked nowhere: left out`);
  // A whole-file, section or edits write may leave one title twice (op insert and rename refuse it): said, never silent (#459).
  const twice = new Set(), seen = new Map(), before = new Set();
  for (const heading of headingsOf(linesOf(current.text))) { const key = sameTitle(heading.title); if (seen.has(key)) before.add(key); seen.set(key, true); }
  seen.clear();
  for (const heading of headingsOf(linesOf(text))) { const key = sameTitle(heading.title); if (seen.has(key) && !before.has(key)) twice.add(heading.title.trim()); seen.set(key, true); }
  for (const title of twice) warnings.push(`the file now has the heading "${title}" twice: write that section by its id (section) or delete one (op delete)`);
  if (settled.unchecked.length) warnings.push(`footnote(s) ${settled.unchecked.map(item => `[^${item.n}]${item.n === item.was ? '' : ` (written [^${item.was}])`}`).join(', ')} of the saved file not found again in the materials: kept as they were written`);
  const prose = text.replace(BLOCK, ' ').split('\n').filter(line => !DEFINITION.test(line.trim()) && !LINKS_LINE.test(line.trim())).join('\n')
    .replace(/```[\s\S]*?```/g, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/\]\([^)]*\)/g, ']');
  const share = cjkShare(prose), letters = prose.replace(/[\s\d\p{P}\p{S}]/gu, '').length;
  if (letters >= 40 && (language === 'zh' ? share < 0.2 : share > 0.3)) warnings.push(language === 'zh' ? 'the book is written in Chinese; this text reads as another language' : 'the book is written in English; this text reads as Chinese');
  const stale = Number.isInteger(args.version) && args.version !== file.version;
  if (stale && args.markdown === undefined) warnings.push(`the file changed since version ${args.version}; the change was applied to the file as it is now (version ${file.version})`);
  const base = stale && args.markdown !== undefined ? history.find(entry => entry.file === name && entry.version === args.version) : null;
  const saved = saveBookFile(state, { course, file: name, text, version: stale && args.markdown !== undefined ? args.version : file.version, ...(base ? { baseText: base.text } : {}) });
  if (saved.status === 'unchanged' && created) delete doc.files[name];
  const section = composed.section ? { id: bookIndex(doc.files[name]?.text).flat.find(heading => sameTitle(heading.title) === sameTitle(composed.section.title))?.id ?? null, title: composed.section.title } : null;
  return { status: saved.status, hid: row.hid, file: kind, name, version: doc.files[name]?.version ?? null, dropped: settled.dropped,
    outsideCount: (text.match(OUTSIDE) || []).length, warnings, ...(section ? { section } : {}), before: saved.before, course };
}

/** op rename / move / delete (lib/book-section-ops.js) on the file's RAW lines, the 练 5 道 line set aside (it stays last): every mark, definition and
    出处 list stays byte for byte; a section that moves or goes takes along only the lists nothing outside it cites (lib/book-footnote-binding.js), and a
    list a mark outside it cites stays where it is. What each mark cites is checked after the op (it never changes: book-footnote-binding if it would).
    With children 'toUnplaced' the section goes to 未归位 with its own lists and a copy of every other footnote its marks cite, labels renamed there. */
function writeStructure(state, { args, course, doc, row, kind, name, file, level, current, blocks }) {
  // Every mark carries its own tag through the op, so what EACH one cites is compared (a swap of two marks' footnotes is caught, not only a count).
  const all = linesOf(current.text), lines = tagMarks(all.filter(line => !LINKS_LINE.test(line.trim()))), links = all.filter(line => LINKS_LINE.test(line.trim())).map(line => line.trim());
  const was = markCitations(lines), same = result => { const now = markCitations(result.lines);
    // A delete takes marks away, a rename may replace a mark of the heading line itself: there only the marks left are compared.
    return [...now].every(([tag, cited]) => was.get(tag) === cited) && (args.op === 'delete' || args.op === 'rename' || [...was].every(([tag, cited]) => now.get(tag) === cited)); };
  const run = back => applySectionOp(lines, args, { level, stay: (from, to) => stayingLines(lines, from, to), cited: inside => citedFrom(lines, inside), back });
  // A section put at the end of another goes before the 出处 list that ends it, unless a mark would then cite another footnote: then after the list.
  let done = run(beforeLists);
  if (!same(done)) done = run(undefined);
  if (!same(done)) fail('这样改会让某个角标指向别的脚注，没有写入 / After this a footnote mark would cite another footnote; nothing was written', 'book-footnote-binding');
  // A delete takes along the footnotes only its own marks cited (wherever their list is), and a 出处 label left with no footnote.
  if (done.removed) {
    const orphans = orphanedBy(lines, done.removed), keptAt = lines.map((_, at) => at).filter(at => !done.removed.has(at));
    done = { ...done, lines: done.lines.filter((_, at) => !orphans.has(keptAt[at])) };
  }
  let text = untag(done.lines.join('\n')).replace(/\n{3,}/g, '\n\n').trim();
  if (links.length) text = `${text}\n\n${[...new Set(links)].join('\n')}`;
  text = restore(text, blocks).trim();
  const warnings = [], aside = done.cut ? parkSection(restore(untag(done.cut.join('\n')), blocks), row.hid, doc.files[UNPLACED]?.text) : '';
  const asideText = aside ? [String(doc.files[UNPLACED]?.text ?? '').trim(), aside].filter(Boolean).join('\n\n') : '';
  // Checked before anything is written: the section is never cut out of the point when 未归位 cannot take it.
  if (asideText.length > FILE_TEXT_MAX)
    fail(`未归位放不下这一节（${asideText.length} / ${FILE_TEXT_MAX} 字符）；先整理一下未归位 / 未归位 cannot hold this section (${asideText.length} of at most ${FILE_TEXT_MAX} characters); tidy 未归位 first`, 'course-book-unplaced-full');
  const lost = current.blocks.filter(block => !text.includes(block) && !aside.includes(block)).length;
  if (lost) warnings.push(`${lost} Q&A / AI block(s) of the file are no longer in it (course.book.revert {file: "${name}"} brings the previous version back)`);
  if (Number.isInteger(args.version) && args.version !== file.version) warnings.push(`the file changed since version ${args.version}; the change was applied to the file as it is now (version ${file.version})`);
  const saved = saveBookFile(state, { course, file: name, text, version: file.version });
  // After the point's file (its headings no longer hold the ids that move to 未归位), 未归位 at its own version.
  const also = [];
  if (aside) {
    const unplaced = doc.files[UNPLACED] ?? (doc.files[UNPLACED] = { text: '', version: 1 });
    also.push(saveBookFile(state, { course, file: UNPLACED, text: asideText, version: unplaced.version }).before);
  }
  return { status: saved.status, hid: row.hid, file: kind, name, version: doc.files[name]?.version ?? null, dropped: [], outsideCount: (text.match(OUTSIDE) || []).length, warnings,
    ...(done.section ? { section: { id: done.section.id ?? null, title: done.section.title } } : {}), before: saved.before, ...(also.length ? { also } : {}), course };
}

/** A section cut out of a point as it waits in 未归位: its top heading at level 3, every footnote label of it renamed for 未归位 (never colliding with
    what is there; lib/book-parked-text.js). */
function parkSection(cut, hid, there = '') {
  let n = 1;
  while (String(there ?? '').includes(`[^${hid}x${n}-`)) n += 1;
  const lines = linesOf(relabelFootnotes(cut, label => `${hid}x${n}-${label}`)), top = Math.min(...headingsOf(lines).map(heading => heading.level));
  return (Number.isFinite(top) ? shiftLevels(lines, 3 - top) : lines).join('\n').trim();
}

/** What the chat is told of a write: small (no text of the book). gain: the hashes of quotes this point had dropped before (lib/book-reading.js). */
export function writeResult(done, again = new Set()) {
  const dropped = done.dropped.map(item => (item.quote && again.has(quoteHash(item.quote)) ? { ...item, again: true } : item));
  return { status: done.status, hid: done.hid, file: done.file, name: done.name, version: done.version, dropped, outsideCount: done.outsideCount, warnings: done.warnings,
    ...(done.section ? { section: done.section } : {}), ...(done.also?.length ? { unplaced: `the section waits in 未归位 (unplaced.md) under its heading. To put it back: course.book.revert {file: "${done.name}"} (the point's file as before the delete; 未归位 keeps its copy until the learner removes it). Never revert unplaced.md for this: that copy may be the only one` } : {}),
    ...(dropped.some(item => item.again) ? { advice: 'A quote was dropped twice: the materials do not hold these words. Delete the sentence that rests on it, or open the page with source.pages and quote it exactly, or mark the sentence as beyond the materials.' } : {}),
    ...(done.status === 'merged' ? { note: 'The file had changed since your version: your text is saved and the other text waits as a suggestion on the book page.' } : {}),
    ...(done.status === 'unchanged' ? { note: 'Nothing changed: the file already holds this text.' } : {}) };
}
