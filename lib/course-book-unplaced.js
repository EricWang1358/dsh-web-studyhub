/* The sections of 未归位 (#489, lib/course-book-structure.js placeUnplacedSection): what can be put back into a point one at a time. Pure, only a hash imported. */
import { createHash } from 'node:crypto';
import { headingsOf } from './book-section-ops.js';

// What a rebuild adds to a parked title (lib/course-book-files.js WORDS): why it is here, not its name.
const WHY = /\s*（(已无对应知识点|no longer a point of the outline|总纲重新整理后[^）]*|after the outline was organised again[^）]*)）\s*$/;
/** A parked title without the reason it carries. */
export const parkedTitle = title => String(title ?? '').replace(WHY, '').trim();

/** `text` cut at its headings of level 3 or above (a parked point's own level; what is deeper belongs to it): [{ id, title, level, from, to, chars }] in order, an unheaded start being one more,
    with `title` '' and `level` 0, as is a text with no such heading. `id` is of the section's text: changed, it is another section, so a stale page cannot move what it did not see. */
export function unplacedSections(text) {
  const whole = String(text ?? ''), lines = whole.split('\n'), starts = [];
  let at = 0;
  for (const line of lines) { starts.push(at); at += line.length + 1; }
  const tops = headingsOf(lines.map(line => line.replace(/\r$/, ''))).filter(heading => heading.level <= 3);
  const cuts = [...(tops[0]?.at === 0 ? [] : [{ from: 0, title: '', level: 0 }]), ...tops.map(heading => ({ from: starts[heading.at], title: parkedTitle(heading.title), level: heading.level }))];
  const seen = new Map();
  return cuts.map((cut, index) => {
    const to = cuts[index + 1]?.from ?? whole.length, body = whole.slice(cut.from, to).trim(), norm = body.replace(/\r\n/g, '\n');
    const nth = (seen.get(norm) ?? 0) + 1;
    seen.set(norm, nth);
    return { id: createHash('sha256').update(nth === 1 ? norm : `${norm}\u0000${nth}`).digest('hex').slice(0, 12), title: cut.title, level: cut.level, from: cut.from, to, chars: norm.length };
  }).filter(section => section.chars > 0);
}
