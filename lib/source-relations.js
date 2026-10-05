/* Materials that come from one original file (#207): the PDF, a text version of it, a "(diagram-normalized text)" version of it. They are separate
   materials (each has its own text and pages), so a list of materials would show three strangers; this says how they belong together.
   Pure, no I/O: the picker of 创建题组 and the 资料 page can share it.

   Family = the same name once the folder, a trailing "(…)" note, the page suffix and the file extension are taken away. Within a family of two or
   more: a PDF / Word / PowerPoint is the ORIGINAL, every other kind is DERIVED from it; a family with no original file only says its members
   belong together ('same'). */
import { displayTitle } from './document-title.js';

const ORIGINAL_FORMATS = new Set(['pdf', 'docx', 'pptx']);
const NOTE = /\s*[（(][^()（）]*[)）]\s*$/;
const EXTENSION = /\.(?:pdf|docx?|pptx?|md|markdown|txt|html?)$/i;
const PAGE_SUFFIX = /\s·\s(?:p\.\s?\d+|第\s?\d+\s?页)$/;

/** The name materials of one file share. */
export function familyKey(title) {
  let name = displayTitle(String(title ?? '')).replace(PAGE_SUFFIX, '').normalize('NFKC').trim();
  for (let guard = 0; guard < 3 && NOTE.test(name); guard++) name = name.replace(NOTE, '');
  return name.replace(EXTENSION, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Items from groupSourcesByDocument → Map(item.key → relation), only for items that have relatives:
 *   { role: 'original', derived: n }                   a file with n materials made from it;
 *   { role: 'derived', of: <the original's title> }    made from an original file that is in the list;
 *   { role: 'same', count: n }                         n materials of one name and no original file among them.
 */
export function materialRelations(items = []) {
  const families = new Map();
  for (const item of items) {
    const key = familyKey(item.title);
    if (!key) continue;
    if (!families.has(key)) families.set(key, []);
    families.get(key).push(item);
  }
  const relations = new Map();
  for (const members of families.values()) {
    if (members.length < 2) continue;
    const originals = members.filter(item => ORIGINAL_FORMATS.has(item.format));
    if (!originals.length) { for (const item of members) relations.set(item.key, { role: 'same', count: members.length }); continue; }
    const derived = members.filter(item => !originals.includes(item));
    for (const item of originals) relations.set(item.key, { role: 'original', derived: derived.length });
    for (const item of derived) relations.set(item.key, { role: 'derived', of: originals[0].title });
  }
  return relations;
}
