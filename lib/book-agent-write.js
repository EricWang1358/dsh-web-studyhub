/* book.write (docs/review-book-agent.md): the main chat writes ONE knowledge point's file of the 复习全书, on the learner's request in chat. Small
   arguments on purpose (the host's permission review carries every earlier tool argument): the whole file of one point (`markdown`), one heading's section
   (`section: { heading, markdown }`), or a few exact replacements (`edits: [{ find, replace }]`). A mutation of the state, run by the op in the book's
   writer queue inside one store transaction, through course.book.save's own rule (lib/course-book-edit.js saveBookFile: compare-and-set, heading ids,
   a generated file forked so the generator never writes over the chat's text, the version replaced kept in the history, course.book.revert undoes it).

   book.write { course?, hid, file?: gen|mine|qa (default gen), markdown | section | edits, version? }
   book.write { course?, hid, file?, op: insert|delete|rename|move, ..., version? }: the file's sections as a tree, by heading id (lib/book-section-ops.js:
     insert at a place, delete without a shell, rename, move with what is below); a delete with children 'toUnplaced' also writes 未归位 (its own version);
     - the learner's own files (mine, qa) only when named; a point without a Q&A file gets one;
     - footnotes `[^n]: 「exact words」 (sourceId)` are checked word for word (lib/book-footnotes.js); what is not found is taken out and listed;
     - headings are put below the point's own heading (the 目录 stays a tree); the 练 5 道 / 本节问答 line of a generated file stays at its end;
     - `version` older than the file: a whole-file write is saved and the other text waits as a suggestion (书已更新), as course.book.save does; a section
       or edits are applied to the file as it is now;
   -> { status: saved|merged|unchanged, hid, file, name, version, dropped: [{ n, quote, reason }], outsideCount, warnings, section?: { id, title }, before,
     also? } (the op drops `before` and `also`, the other files' replaced versions, after keeping them in the history). */
import { FILE_TEXT_MAX, saveBookFile } from './course-book-edit.js';
import { genFile, mineFile, qaFile, UNPLACED } from './course-book-files.js';
import { applySectionOp, checkSectionOp, headingsOf, sameTitle, shiftLevels } from './book-section-ops.js';
import { bookIndex } from './course-book-links.js';
import { bookOfCourse, coverageOf, materialIndex, placesOf, pointList, pointOf } from './book-agent-view.js';
import { DEFINITION, isLabelLine, settleFootnotes } from './book-footnotes.js';
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
  const body = [], links = [], own = new Set();
  for (const line of linesOf(text)) {
    const definition = DEFINITION.exec(line.trim());
    if (definition) { pool.set(`${prefix}-${definition[1]}`, definition[2]); own.add(definition[1]); continue; }
    if (isLabelLine(line)) continue;
    if (LINKS_LINE.test(line.trim())) { links.push(line.trim()); continue; }
    body.push(line);
  }
  // A mark with no footnote of its own text takes the file's earlier footnote of that key, if there is one (a section citing the file's [^3]).
  const marked = body.join('\n').replace(/\[\^([\w-]{1,40})\](?!:)/g, (mark, key) => `[^${own.has(key) || !fallback?.has(`${fallback.prefix}-${key}`) ? prefix : fallback.prefix}-${key}]`);
  return { body: marked.replace(/\n{3,}/g, '\n\n').trim(), links };
}

/** The new text of the file from the request (the footnotes not yet settled): { body, pool, links, warnings }. */
function compose(current, args, level) {
  const warnings = [], pool = new Map(), old = new Map();
  if (args.edits !== undefined) {
    let text = current;
    args.edits.forEach((edit, at) => {
      const count = text.split(edit.find).length - 1;
      if (count !== 1) fail(`edits[${at}]: find must occur exactly once in the file (found ${count} times); read the point again with book.read`, 'book-edit-find');
      text = text.replace(edit.find, () => edit.replace);
    });
    const done = split(text, 'o', pool);
    return { body: done.body, pool, links: done.links, warnings };
  }
  const before = split(current, 'o', old);
  old.prefix = 'o';
  if (typeof args.markdown === 'string') {
    const shifted = shiftHeadings(args.markdown, level + 1), done = split(shifted.text, 'n', pool, old);
    for (const [key, value] of old) if (done.body.includes(`[^${key}]`)) pool.set(key, value);
    if (shifted.shifted) warnings.push(`headings moved below the point's own heading (level ${level + 1} or deeper)`);
    return { body: done.body, pool, links: done.links.length ? done.links : before.links, warnings };
  }
  // A section op (lib/book-section-ops.js): the file's sections as a tree, by heading id; an insert's text is made like a section's.
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
    return { body: body.replace(/\n{3,}/g, '\n\n').trim(), pool, links, warnings, section: done.section, cut: done.cut, old, prior: before.body };
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
  return { body: body.replace(/\n{3,}/g, '\n\n').trim(), pool, links: made.links.length ? made.links : before.links, warnings };
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
    warnings: shifted.shifted ? [`headings inside the section moved below it (level ${headLevel + 1} or deeper)`] : [] };
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
  const composed = compose(current.text, request, level), warnings = [...composed.warnings];
  const index = materialIndex(state, course), byId = index.byId;
  // An op that only moves, renames or deletes a heading writes no footnote: the file's own are kept as they are (never checked or renumbered again).
  const places = placesOf(index, row.node), settled = args.op !== undefined && args.op !== 'insert' ? keepFootnotes(composed, current.text, language)
    : settleFootnotes(composed.body, composed.pool, { segments: places, byId, language });
  const read = coverageOf(places, reading, new Set()).totals;
  if (read.pages && !read.opened && !read.partial) warnings.push(`none of this point's ${read.pages} page(s) were opened with source.pages yet: open them before writing what the materials say`);
  let text = settled.text;
  // The 练 5 道 / 本节问答 line stays the file's last line.
  if (composed.links.length) text = `${text.replace(/\s+$/, '')}\n\n${[...new Set(composed.links)].join('\n')}`;
  text = restore(text, blocks).trim();
  // A section sent to 未归位 (op delete, children toUnplaced) takes its footnotes and blocks along.
  const aside = composed.cut ? unplacedPiece(restore(composed.cut.join('\n'), blocks), composed.old, row.hid, doc.files[UNPLACED]?.text) : '';
  const asideText = aside ? [String(doc.files[UNPLACED]?.text ?? '').trim(), aside].filter(Boolean).join('\n\n') : '';
  // Checked before anything is written: the section is never cut out of the point when 未归位 cannot take it.
  if (asideText.length > FILE_TEXT_MAX)
    fail(`未归位放不下这一节（${asideText.length} / ${FILE_TEXT_MAX} 字符）；先整理一下未归位 / 未归位 cannot hold this section (${asideText.length} of at most ${FILE_TEXT_MAX} characters); tidy 未归位 first`, 'course-book-unplaced-full');
  const lost = current.blocks.filter(block => !text.includes(block) && !aside.includes(block)).length;
  if (lost) warnings.push(`${lost} Q&A / AI block(s) of the file are no longer in it (course.book.revert {file: "${name}"} brings the previous version back)`);
  if (settled.unused.length) warnings.push(`footnote(s) ${settled.unused.join(', ')} found but marked nowhere: left out`);
  // A whole-file, section or edits write may leave one title twice (op insert and rename refuse it): said, never silent (#459).
  const twice = new Set(), seen = new Map(), before = new Set();
  for (const heading of headingsOf(linesOf(current.text))) { const key = sameTitle(heading.title); if (seen.has(key)) before.add(key); seen.set(key, true); }
  seen.clear();
  for (const heading of headingsOf(linesOf(text))) { const key = sameTitle(heading.title); if (seen.has(key) && !before.has(key)) twice.add(heading.title.trim()); seen.set(key, true); }
  for (const title of twice) warnings.push(`the file now has the heading "${title}" twice: write that section by its id (section) or delete one (op delete)`);
  const prose = text.replace(BLOCK, ' ').split('\n').filter(line => !DEFINITION.test(line.trim()) && !LINKS_LINE.test(line.trim())).join('\n')
    .replace(/```[\s\S]*?```/g, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/\]\([^)]*\)/g, ']');
  const share = cjkShare(prose), letters = prose.replace(/[\s\d\p{P}\p{S}]/gu, '').length;
  if (letters >= 40 && (language === 'zh' ? share < 0.2 : share > 0.3)) warnings.push(language === 'zh' ? 'the book is written in Chinese; this text reads as another language' : 'the book is written in English; this text reads as Chinese');
  const stale = Number.isInteger(args.version) && args.version !== file.version;
  if (stale && args.markdown === undefined) warnings.push(`the file changed since version ${args.version}; the change was applied to the file as it is now (version ${file.version})`);
  const base = stale && args.markdown !== undefined ? history.find(entry => entry.file === name && entry.version === args.version) : null;
  const saved = saveBookFile(state, { course, file: name, text, version: stale && args.markdown !== undefined ? args.version : file.version, ...(base ? { baseText: base.text } : {}) });
  if (saved.status === 'unchanged' && created) delete doc.files[name];
  // After the point's file (its headings no longer hold the ids that move to 未归位), 未归位 at its own version.
  const also = [];
  if (aside) {
    const unplaced = doc.files[UNPLACED] ?? (doc.files[UNPLACED] = { text: '', version: 1 });
    also.push(saveBookFile(state, { course, file: UNPLACED, text: asideText, version: unplaced.version }).before);
  }
  const section = composed.section ? { id: composed.section.id ?? bookIndex(doc.files[name]?.text).flat.find(heading => sameTitle(heading.title) === sameTitle(composed.section.title))?.id ?? null, title: composed.section.title } : null;
  return { status: saved.status, hid: row.hid, file: kind, name, version: doc.files[name]?.version ?? null, dropped: settled.dropped,
    outsideCount: (text.match(OUTSIDE) || []).length, warnings, ...(section ? { section } : {}), before: saved.before, ...(also.length ? { also } : {}), course };
}

/** The file's own footnotes put back unchanged after a structural op: the marks under their own keys, every definition still marked (or marked
    nowhere before either) in the file's order under the file's own 出处 label. -> settleFootnotes' shape, nothing dropped. */
function keepFootnotes(composed, currentText, language) {
  const text = composed.body.replace(/\[\^o-([\w-]{1,40})\](?!:)/g, (mark, key) => `[^${key}]`), marked = key => composed.body.includes(`[^${key}]`);
  const definitions = [...composed.old].filter(([key]) => marked(key) || !String(composed.prior ?? '').includes(`[^${key}]`)).map(([key, value]) => `[^${key.slice(2)}]: ${value}`);
  const label = linesOf(currentText).map(line => line.trim()).find(isLabelLine) ?? (language === 'en' ? '**Sources**' : '**出处**');
  return { text: definitions.length ? `${text.replace(/\s+$/, '')}\n\n${label}\n\n${definitions.join('\n')}` : text, dropped: [], unused: [] };
}

/** A section cut out of a point (its marks `[^o-<key>]`) as it waits in 未归位: its top heading at level 3, its footnotes renamed for 未归位 (never
    colliding with what is there) with their definitions after it. */
function unplacedPiece(cut, old, hid, there = '') {
  let n = 1;
  while (String(there ?? '').includes(`[^${hid}x${n}-`)) n += 1;
  const used = new Map(), lines = linesOf(cut.replace(/\[\^o-([\w-]{1,40})\](?!:)/g, (mark, key) => {
    if (!old?.has(`o-${key}`)) return '';
    const label = `${hid}x${n}-${key}`;
    used.set(label, old.get(`o-${key}`));
    return `[^${label}]`;
  }));
  const top = Math.min(...headingsOf(lines).map(heading => heading.level));
  const text = (Number.isFinite(top) ? shiftLevels(lines, 3 - top) : lines).join('\n').trim();
  return [text, [...used].map(([label, value]) => `[^${label}]: ${value}`).join('\n')].filter(Boolean).join('\n\n');
}

/** What the chat is told of a write: small (no text of the book). gain: the hashes of quotes this point had dropped before (lib/book-reading.js). */
export function writeResult(done, again = new Set()) {
  const dropped = done.dropped.map(item => (item.quote && again.has(quoteHash(item.quote)) ? { ...item, again: true } : item));
  return { status: done.status, hid: done.hid, file: done.file, name: done.name, version: done.version, dropped, outsideCount: done.outsideCount, warnings: done.warnings,
    ...(done.section ? { section: done.section } : {}), ...(done.also?.length ? { unplaced: 'the section waits in 未归位 (unplaced.md); course.book.revert {file: "unplaced.md"} takes it out again' } : {}),
    ...(dropped.some(item => item.again) ? { advice: 'A quote was dropped twice: the materials do not hold these words. Delete the sentence that rests on it, or open the page with source.pages and quote it exactly, or mark the sentence as beyond the materials.' } : {}),
    ...(done.status === 'merged' ? { note: 'The file had changed since your version: your text is saved and the other text waits as a suggestion on the book page.' } : {}),
    ...(done.status === 'unchanged' ? { note: 'Nothing changed: the file already holds this text.' } : {}) };
}
