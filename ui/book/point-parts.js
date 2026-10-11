/* 复习全书, how a point reads (docs/review-book.md "Reading a point"): its generated file cut into the labelled parts the program writes (考情, 知识梳理,
   讲解, 例子, 补充, 出处; lib/course-book-files.js genText) so the page can put them in reading order: the one-sentence takeaway first (its own part when
   the notes have one, else the first sentence of 讲解), the story (讲解, 例子), then 要点清单 and 补充 folded, 出处 behind a chip. The 练 5 道 · 本节问答
   line is taken off (the point's toolbar offers both). A file the learner rewrote without the labels is one untitled part, shown as it is. Also the cheap
   checks of the AI blocks of the learner's own file: which part holds a block's words, whether a whole-point block mostly restates the notes, and when
   the learner's layer starts folded. Pure, no React, no DOM; nothing here changes a file. */
import { aiBlocks, anchorIn, withoutAiBlocks } from '../../lib/course-book-ai-text.js';

const LABELS = {
  takeaway: ['一句话', 'In one sentence'],
  exam: ['考情', 'In the sample papers'],
  points: ['知识梳理', 'Key points'],
  explain: ['讲解', 'Explanation'],
  example: ['例子', 'Example'],
  extra: ['补充（资料以外）', 'Extra (beyond the materials)'],
  cites: ['出处', 'Sources'],
};
const KIND = new Map(Object.entries(LABELS).flatMap(([kind, names]) => names.map(name => [name, kind])));
const LABEL_LINE = /^\*\*([^*\n]+)\*\*(?:[ \t]+(\S.*))?$/;
const LINK = String.raw`\[[^\]\n]*\]\(studyhub:\/\/(?:practice|qa)[^)\s]*\)`;
const FOOTER = new RegExp(String.raw`^\s*${LINK}(?:\s*·\s*${LINK})*\s*$`);

/** A point's generated file -> { lead, parts: { [kind]: text }, labels: { [kind]: the label as written }, other: [{ label, text }], tail, footer }. `lead`
    is the text before any label; `other` a part whose label the program does not write (kept in its place); `tail` what follows the 出处 footnotes (a
    learner's addition at the end); `footer`: the 练 5 道 · 本节问答 line was there. */
export function splitPoint(text) {
  const out = { lead: '', parts: {}, labels: {}, other: [], footer: false };
  let current = null;
  const lines = [], tail = [];
  const flush = () => {
    const body = lines.splice(0).join('\n').trim();
    if (!current) { out.lead = body; return; }
    if (!body) return;
    if (!current.kind) { out.other.push({ label: current.label, text: body }); return; }
    out.parts[current.kind] = out.parts[current.kind] ? `${out.parts[current.kind]}\n\n${body}` : body;
    out.labels[current.kind] ??= current.label;
  };
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (FOOTER.test(line)) { out.footer = true; continue; }
    const label = LABEL_LINE.exec(line.trim()), kind = label ? KIND.get(label[1].trim()) : undefined;
    // A known label starts its part (考情 carries its words on the same line); a bold line alone is a part of its own; bold words in a sentence are text.
    if (label && (kind || !label[2])) {
      flush();
      current = { kind, label: label[1].trim() };
      if (label[2]) lines.push(label[2]);
      continue;
    }
    // 出处 holds its footnotes only: what the learner wrote after them (at the end of the file) is text of its own, shown, never hidden behind the chip.
    if (current?.kind === 'cites' && line.trim() && !/^\[\^\d+\]:/.test(line)) { tail.push(line); continue; }
    if (current?.kind === 'cites' && !line.trim() && tail.length) { tail.push(line); continue; }
    lines.push(line);
  }
  flush();
  out.tail = tail.join('\n').trim();
  return out;
}

/** How many 出处 a cites part lists. */
export const citeCount = text => (String(text ?? '').match(/^\[\^\d+\]:/gm) || []).length;

const OPEN = '[(（「“『【', CLOSE = '])）」”』】', TRAIL = /^(?:[”」』）)\]]|\[\^\d+\])+/;
const ABBREVIATION = /(?:^|[\s(（])(?:e\.g|i\.e|etc|vs|cf|fig|eq|no|dr|mr|mrs|st)$/i;
const NOT_A_SENTENCE = /^\s*(?:[-*+]\s|\d+[.)]\s|#|>|\||\$\$|```|~~~|<)/;
/** The first sentence of a text's first paragraph -> { text, rest } (rest: the text after it), or null when that paragraph is a list, a table, a display
    formula or code, or the sentence is too short or too long to be a takeaway. A formula, a bracket or a quote is never cut, nor `3.5` or `e.g.`. */
export function firstSentence(text) {
  const source = String(text ?? '').replace(/^\s+/, ''), paragraph = source.split(/\n[ \t]*\n/)[0];
  if (!paragraph || NOT_A_SENTENCE.test(paragraph)) return null;
  let math = false, depth = 0, end = paragraph.length;
  for (let at = 0; at < paragraph.length; at += 1) {
    const char = paragraph[at], next = paragraph[at + 1];
    if (char === '$') { math = !math; continue; }
    if (math) continue;
    if (OPEN.includes(char)) depth += 1;
    else if (CLOSE.includes(char)) depth = Math.max(0, depth - 1);
    else if (depth === 0 && ('。！？'.includes(char) || ('.!?'.includes(char) && (next === undefined || /\s/.test(next)) && !(char === '.' && ABBREVIATION.test(paragraph.slice(0, at)))))) {
      end = at + 1 + (TRAIL.exec(paragraph.slice(at + 1))?.[0].length ?? 0);
      break;
    }
  }
  const sentence = paragraph.slice(0, end).replace(/\s+/g, ' ').trim();
  if (sentence.length < 4 || sentence.length > 200) return null;
  return { text: sentence, rest: source.slice(end).replace(/^\s+/, '') };
}

/** The point's takeaway: { text, rest, own } (`own`: the notes' own 一句话; else the first sentence of 讲解, and `rest` is 讲解 without it), or null. */
export function takeawayOf(split) {
  if (split.parts.takeaway) return { text: split.parts.takeaway.replace(/\s+/g, ' ').trim(), rest: split.parts.explain ?? '', own: true };
  const first = split.parts.explain ? firstSentence(split.parts.explain) : null;
  return first ? { text: first.text, rest: first.rest, own: false } : null;
}

/** A line of Markdown as plain words (marks, footnote marks and link targets off). */
export const plainLine = text => String(text ?? '').replace(/<!--.*?-->/g, '').replace(/\[\^\d+\]/g, '').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/\[\[([^\]]+)\]\]/g, '$1').replace(/[*_`~#>]+/g, '').replace(/\s+/g, ' ').trim();

/** One line for a folded point: its takeaway, else the first sentence of what it says first. */
export function pointSummary(gen) {
  const split = splitPoint(gen), take = takeawayOf(split);
  return plainLine(take?.text ?? firstSentence(split.lead || split.parts.explain || split.parts.points || '')?.text ?? '');
}

// The repeat check: words as tokens (a Han character is one, a run of letters or digits another), compared as pairs of neighbours.
const tokensOf = text => (plainLine(text).toLowerCase().match(/\p{Script=Han}|[\p{L}\p{N}]+/gu) || []);
const pairsOf = text => { const tokens = tokensOf(text), out = new Set(); for (let at = 1; at < tokens.length; at += 1) out.add(`${tokens[at - 1]} ${tokens[at]}`); return out; };
const unitsOf = text => [...String(text ?? '').split(/[。！？!?\n]|\.(?=\s|$)/), ...[...String(text ?? '').matchAll(/[「“]([^」”]{4,})[」”]/g)].map(match => match[1])];
/** How much of `body` the notes already say: the share of its sentences and quotes (of four word pairs or more) whose word pairs are at least 60 %
    in the notes. 0 when it has no such sentence. */
export function repeatShare(body, notes) {
  const units = unitsOf(body).map(pairsOf).filter(pairs => pairs.size >= 4);
  if (!units.length) return 0;
  const pool = pairsOf(notes);
  const shared = units.filter(pairs => { let hit = 0; for (const pair of pairs) if (pool.has(pair)) hit += 1; return hit / pairs.size >= 0.6; });
  return shared.length / units.length;
}

/** The learner's layer starts folded (each block as its header and summary line) from this many items, or with one block longer than LONG_BLOCK. */
export const LAYER_FOLD_ITEMS = 3, LONG_BLOCK = 1500, REPEAT_SHARE = 0.6;

/**
 * What the page shows of a point: { story: [{ name, text, label }] (lead, takeaway, exam, explain, example, other parts), takeaway, points, extra
 * ({ text, label } | null), cites, citeCount, mine (the own file without its blocks), blocks: [{ block, status: 'same' | 'gone', part }] in the order of
 * the own file (`part`: the part that holds its words, null for a block under the heading or one whose words are gone), anchors: Map<part, [{ id, quote }]>,
 * repeats: Set<block id> (a whole-point block longer than 讲解 that mostly restates the notes), layerFolded }.
 */
export function pointView(node) {
  const split = splitPoint(node.gen), take = takeawayOf(split), story = [];
  const add = (name, text, label) => { if (String(text ?? '').trim()) story.push({ name, text: String(text).trim(), label }); };
  add('lead', split.lead);
  add('takeaway', take?.text);
  add('exam', split.parts.exam, split.labels.exam);
  add('explain', take ? take.rest : split.parts.explain, split.labels.explain);
  add('example', split.parts.example, split.labels.example);
  split.other.forEach((part, at) => add(`other-${at}`, part.text, part.label));
  add('tail', split.tail);
  const part = kind => (split.parts[kind] ? { name: kind, text: split.parts[kind], label: split.labels[kind] } : null);
  const points = part('points'), extra = part('extra'), mine = withoutAiBlocks(node.mine);
  const texts = [...story, points, extra, { name: 'mine', text: mine }].filter(item => item?.text);
  const anchors = new Map(), notes = [take?.text, split.parts.explain, split.parts.example, split.parts.points, split.lead].filter(Boolean).join('\n');
  const blocks = aiBlocks(node.mine).map(block => {
    if (block.at.startsWith('h:')) return { block, status: 'same', part: null };
    const home = block.about ? texts.find(item => anchorIn(item.text, block.about)) : null;
    if (!home) return { block, status: 'gone', part: null };
    anchors.set(home.name, [...(anchors.get(home.name) || []), { id: block.id, quote: block.about }]);
    return { block, status: 'same', part: home.name };
  });
  const explainLength = (split.parts.explain || split.lead || '').length;
  const repeats = new Set(blocks.filter(({ block }) => block.mode === 'here' && block.body.length > explainLength && repeatShare(block.body, notes) >= REPEAT_SHARE)
    .map(({ block }) => block.id));
  const items = blocks.length + (mine ? 1 : 0) + (String(node.qa ?? '').trim() ? 1 : 0);
  return { story, takeaway: take, points, extra, cites: split.parts.cites || '', citeCount: citeCount(split.parts.cites), mine, blocks, anchors, repeats,
    layerFolded: items >= LAYER_FOLD_ITEMS || blocks.some(({ block }) => block.body.length > LONG_BLOCK) };
}
