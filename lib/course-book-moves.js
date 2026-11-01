/* What a rebuilt outline does to the 复习全书's text, said so a learner can judge it (#461, lib/course-book-files.js `lastMoves`): the first line of the body
   under a title, and the fingerprint that tells a book is still exactly as the rebuild left it. Pure, only a hash imported. */
import { createHash } from 'node:crypto';

/** The name the state before a rebuild is kept under (lib/course-book-history.js: its own file beside the history, never a version of a file; no `.md`). */
export const REBUILD_FILE = 'book.rebuild';
/** The most characters of a first line kept with a move. */
const FIRST_LINE_CHARS = 120;

// A line that says nothing about the content: a label alone, the 考情 sentence, the practice links of a point, a footnote's definition, an id or block marker.
const EMPTY_LINE = /^(\*\*[^*]+\*\*:?|\[\^[^\]]+\]:.*|\*\*(考情|In the sample papers)\*\*.*)$/;
const LINK_LINE = /studyhub:\/\/(practice|qa)\b/;

/** The first line of the first text that has one, as plain words: `texts` are a point's files in reading order. '' when none says anything. */
export function firstBodyLine(texts) {
  for (const text of texts) {
    for (const raw of String(text ?? '').split(/\r?\n/)) {
      const line = raw.replace(/<!--[\s\S]*?-->/g, '').trim();
      if (!line || EMPTY_LINE.test(line) || LINK_LINE.test(line)) continue;
      const words = line.replace(/^#{1,6}\s+/, '').replace(/^[-*+]\s+/, '').replace(/\[\^[^\]]+\]/g, '').replace(/\*\*?|__|`/g, '').replace(/\s+/g, ' ').trim();
      if (words) return words.length > FIRST_LINE_CHARS ? `${words.slice(0, FIRST_LINE_CHARS)}…` : words;
    }
  }
  return '';
}

const placesOf = (nodes, parent = null, out = new Map()) => {
  (nodes || []).forEach((node, at) => { out.set(node.id, { node, parent, at }); placesOf(node.children, node.id, out); });
  return out;
};
/** The positions in `order` that stay when as few as possible are taken out to make it ascending (its longest ascending run). */
function inOrder(order) {
  const best = order.map(() => 1), from = order.map(() => -1);
  order.forEach((value, i) => { for (let j = 0; j < i; j += 1) if (order[j] < value && best[j] + 1 > best[i]) { best[i] = best[j] + 1; from[i] = j; } });
  const kept = new Set();
  for (let at = best.indexOf(Math.max(0, ...best)); at >= 0; at = from[at]) kept.add(at);
  return kept;
}

/** What the learner did to the book's tree since the outline laid it out (#489): `outlineNodes` that outline's nodes, `manifestNodes` the book's, by node id. -> { moved, deleted }: the book's
    nodes put under another chapter or out of order among their siblings (as few as explain it; what a deleted chapter's points did is the delete), the outline's nodes the book no longer has. Pure. */
export function structureEdits(outlineNodes, manifestNodes) {
  const was = placesOf(outlineNodes), now = placesOf(manifestNodes);
  const deleted = [...was.values()].filter(place => !now.has(place.node.id)).map(place => place.node);
  const moved = new Set(), siblings = new Map();
  for (const [id, place] of now) {
    const old = was.get(id);
    if (!old) continue;
    if (old.parent !== place.parent) { if (old.parent === null || now.has(old.parent)) moved.add(id); continue; }
    siblings.set(place.parent, [...(siblings.get(place.parent) || []), { id, at: old.at }]);
  }
  for (const list of siblings.values()) { const kept = inOrder(list.map(item => item.at)); list.forEach((item, at) => { if (!kept.has(at)) moved.add(item.id); }); }
  return { moved: [...moved].map(id => now.get(id).node), deleted };
}

/** The fingerprint of a book's files, name, version and text: what an undo compares, so a write that did not move the revision still refuses it. */
export function filesPrint(files) {
  const hash = createHash('sha256');
  for (const name of Object.keys(files || {}).sort()) hash.update(JSON.stringify([name, files[name]?.version ?? null, String(files[name]?.text ?? '')]));
  return hash.digest('hex').slice(0, 32);
}
