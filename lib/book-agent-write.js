/* book.write (docs/review-book-agent.md): the main chat writes ONE knowledge point's file of the 复习全书, on the learner's request in chat. Small
   arguments on purpose (the host's permission review carries every earlier tool argument): the whole file of one point (`markdown`), one heading's section
   (`section: { heading, markdown }`), or a few exact replacements (`edits: [{ find, replace }]`). A mutation of the state, run by the op in the book's
   writer queue inside one store transaction, through course.book.save's own rule (lib/course-book-edit.js saveBookFile: compare-and-set, heading ids,
   a generated file forked so the generator never writes over the chat's text, the version replaced kept in the history, course.book.revert undoes it).

   book.write { course?, hid, file?: gen|mine|qa (default gen), markdown | section | edits, version? }
     - the learner's own files (mine, qa) only when named; a point without a Q&A file gets one;
     - footnotes `[^n]: 「exact words」 (sourceId)` are checked word for word (lib/book-footnotes.js); what is not found is taken out and listed (a
       footnote left exactly as the file has it is kept as written; one the write adds or changes is always checked); the file keeps ONE list [^1]…[^n] (checked before saving); edits that take out a footnote
       still marked in the text are refused (book-footnote-in-use);
     - headings are put below the point's own heading (the 目录 stays a tree); the 练 5 道 / 本节问答 line of a generated file stays at its end;
     - `version` older than the file: a whole-file write is saved and the other text waits as a suggestion (书已更新), as course.book.save does; a section
       or edits are applied to the file as it is now;
   -> { status: saved|merged|unchanged, hid, file, name, version, dropped: [{ n, quote, reason }], outsideCount, warnings, before } (the op drops `before`). */
import { saveBookFile } from './course-book-edit.js';
import { genFile, mineFile, qaFile } from './course-book-files.js';
import { bookOfCourse, coverageOf, materialIndex, placesOf, pointList, pointOf } from './book-agent-view.js';
import { DEFINITION, footnoteProblems, isLabelLine, knownFootnotes, settleFootnotes, takeFootnotes } from './book-footnotes.js';
import { cjkShare } from './transcript.js';
import { quoteHash } from './book-reading.js';

/** The most characters one write carries (all of markdown, a section or the edits together), and the most edits. */
export const WRITE_CHARS = 20_000, EDITS_MAX = 20;
const NAMES = { gen: genFile, mine: mineFile, qa: qaFile };
const fail = (message, code) => { throw Object.assign(new Error(message), { code }); };
const HEADING = /^(#{1,6})\s+(.*?)\s*$/, FENCE = /^\s*(```|~~~)/, ID = /\s*<!-- sh:id (\S+) -->\s*$/;
const LINKS_LINE = /^\[[^\]\n]+\]\(studyhub:\/\/(?:practice|qa)\?[^)\s]*\)(?:\s*·\s*\[[^\]\n]+\]\(studyhub:\/\/(?:practice|qa)\?[^)\s]*\))*\s*$/;
const BLOCK = /<!-- sh:(qa|card|ai)\b[^>]*-->\n[\s\S]*?\n<!-- \/sh:\1 -->/g;
export const OUTSIDE = /（资料以外）|\(资料以外\)|\((?:beyond|outside) the materials\)/gi;
const linesOf = text => String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
const norm = title => String(title ?? '').replace(ID, '').replace(/\s+/g, ' ').trim().toLowerCase();

/** The headings of lines outside code fences: [{ at, level, title, id }]. */
function headingsOf(lines) {
  const out = [];
  let fenced = false;
  lines.forEach((line, at) => {
    if (FENCE.test(line)) { fenced = !fenced; return; }
    const match = fenced ? null : HEADING.exec(line);
    if (match) out.push({ at, level: match[1].length, title: match[2].replace(ID, ''), id: ID.exec(match[2])?.[1] ?? null });
  });
  return out;
}

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
  // A section: the heading named (its id, else its title) and what is below it, up to the next heading of its level or higher.
  const lines = linesOf(before.body), headings = headingsOf(lines), wanted = String(args.section.heading ?? '').trim();
  const target = headings.find(heading => heading.id === wanted) ?? headings.find(heading => norm(heading.title) === norm(wanted));
  let incoming = linesOf(args.section.markdown);
  while (incoming.length && !incoming[0].trim()) incoming.shift();
  const own = HEADING.exec(incoming[0] ?? '');
  const headLevel = target ? target.level : level + 1, title = own ? own[2].replace(ID, '') : target ? target.title : wanted;
  if (own) incoming = incoming.slice(1);
  if (!target && /^h\d+$/.test(wanted)) fail('这一节里没有这个标题 id；用 book.read 看标题和 id / No heading of this id in the file; read the point with book.read', 'book-section-missing');
  const shifted = shiftHeadings(incoming.join('\n'), headLevel + 1), done = split(shifted.text, 'n', pool, old);
  if (shifted.shifted) warnings.push(`headings inside the section moved below it (level ${headLevel + 1} or deeper)`);
  warnings.push(...borrowedWarning(done));
  const heading = `${'#'.repeat(headLevel)} ${title}${target?.id ? ` <!-- sh:id ${target.id} -->` : ''}`;
  const piece = [heading, '', done.body, ''];
  let body;
  if (target) {
    const end = headings.find(item => item.at > target.at && item.level <= target.level)?.at ?? lines.length;
    body = [...lines.slice(0, target.at), ...piece, ...lines.slice(end)].join('\n');
  } else {
    body = [before.body, '', ...piece].join('\n');
    warnings.push(`no heading "${wanted}" in the file: added as a new section at its end`);
  }
  for (const [key, value] of old) if (body.includes(`[^${key}]`)) pool.set(key, value);
  return { body: body.replace(/\n{3,}/g, '\n\n').trim(), pool, links: done.links.length ? done.links : before.links, warnings, known };
}

/** Q&A, answer-card and AI blocks set aside while the footnotes are settled (their text is the learner's, never renumbered). */
function protect(text) {
  const blocks = [];
  return { text: String(text ?? '').replace(/\r\n?/g, '\n').replace(BLOCK, block => { blocks.push(block); return `\u0000B${blocks.length - 1}\u0000`; }), blocks };
}
const restore = (text, blocks) => text.replace(/\u0000B(\d+)\u0000/g, (mark, at) => blocks[Number(at)] ?? '');

function checkArgs(args) {
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
  if (settled.unchecked.length) warnings.push(`footnote(s) ${settled.unchecked.join(', ')} of the file not found again in the materials: kept as they were written`);
  const prose = text.replace(BLOCK, ' ').split('\n').filter(line => !DEFINITION.test(line.trim()) && !LINKS_LINE.test(line.trim())).join('\n')
    .replace(/```[\s\S]*?```/g, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/\]\([^)]*\)/g, ']');
  const share = cjkShare(prose), letters = prose.replace(/[\s\d\p{P}\p{S}]/gu, '').length;
  if (letters >= 40 && (language === 'zh' ? share < 0.2 : share > 0.3)) warnings.push(language === 'zh' ? 'the book is written in Chinese; this text reads as another language' : 'the book is written in English; this text reads as Chinese');
  const stale = Number.isInteger(args.version) && args.version !== file.version;
  if (stale && args.markdown === undefined) warnings.push(`the file changed since version ${args.version}; the change was applied to the file as it is now (version ${file.version})`);
  const base = stale && args.markdown !== undefined ? history.find(entry => entry.file === name && entry.version === args.version) : null;
  const saved = saveBookFile(state, { course, file: name, text, version: stale && args.markdown !== undefined ? args.version : file.version, ...(base ? { baseText: base.text } : {}) });
  if (saved.status === 'unchanged' && created) delete doc.files[name];
  return { status: saved.status, hid: row.hid, file: kind, name, version: doc.files[name]?.version ?? null, dropped: settled.dropped,
    outsideCount: (text.match(OUTSIDE) || []).length, warnings, before: saved.before, course };
}

/** What the chat is told of a write: small (no text of the book). gain: the hashes of quotes this point had dropped before (lib/book-reading.js). */
export function writeResult(done, again = new Set()) {
  const dropped = done.dropped.map(item => (item.quote && again.has(quoteHash(item.quote)) ? { ...item, again: true } : item));
  return { status: done.status, hid: done.hid, file: done.file, name: done.name, version: done.version, dropped, outsideCount: done.outsideCount, warnings: done.warnings,
    ...(dropped.some(item => item.again) ? { advice: 'A quote was dropped twice: the materials do not hold these words. Delete the sentence that rests on it, or open the page with source.pages and quote it exactly, or mark the sentence as beyond the materials.' } : {}),
    ...(done.status === 'merged' ? { note: 'The file had changed since your version: your text is saved and the other text waits as a suggestion on the book page.' } : {}),
    ...(done.status === 'unchanged' ? { note: 'Nothing changed: the file already holds this text.' } : {}) };
}
