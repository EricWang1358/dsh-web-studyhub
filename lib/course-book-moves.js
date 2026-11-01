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

/** The fingerprint of a book's files, name, version and text: what an undo compares, so a write that did not move the revision still refuses it. */
export function filesPrint(files) {
  const hash = createHash('sha256');
  for (const name of Object.keys(files || {}).sort()) hash.update(JSON.stringify([name, files[name]?.version ?? null, String(files[name]?.text ?? '')]));
  return hash.digest('hex').slice(0, 32);
}
