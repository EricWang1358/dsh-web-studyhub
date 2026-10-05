/* The names of a document, as the 资料 page shows them (materials.document.rename). Pure, no I/O: the operation and the UI share it.

   A rename changes ONLY title fields. A card cites a source by sourceId + quote and looks the title up when it is shown, so
   ids, text, revisions, selections, citations and card links are never touched. Which titles follow the document title:
   - a single text takes the whole title;
   - a page, slide or part whose title was DERIVED from the document title ("<title> · p.3", "<title> (2/3)") follows it;
   - a title that came from the content (a chapter heading, a slide title) never changes.
   The file name (document.filename, a recording's member file names) is the original and is never changed. Every old title
   stays resolvable: titleAliases (per source, short) and renamedFrom (the title before the first rename, which 恢复原名 uses). */

/* The name a document is shown by where a file name would be noise (the coverage list of a draft): the file's own name without its extension and
   without what the site it came from added. A trailing group in () or [] counts as noise only when it names a source site or a release tag
   ("(z-library.sk, 1lib.sk)", "[Z-Library]", "(TruePDF)"); a group that names the work or its authors stays. */
const DOCUMENT_EXTENSION = /\.(?:pdf|docx?|pptx?|md|markdown|txt|html?|epub|mobi|djvu)$/i;
const SITE = /\b[\w-]+\.(?:com|org|net|io|cn|ru|sk|me|to|is|li|cc|xyz|info|edu)\b|z-?lib(?:rary)?|1lib|libgen|anna'?s[- ]?archive|pdfdrive|truepdf|\bretail\b|\bocr\b|scanned|\bebook\b/i;
const GROUP = /\s*[(\[（【]([^()\[\]（）【】]*)[)\]）】]/g;
/** A document's file name or title as one readable name; an empty result falls back to the input. */
export function cleanDocumentName(value) {
  const original = String(value ?? "");
  const stem = original.trim().replace(/^.*[\\/]/, "").replace(DOCUMENT_EXTENSION, "").trim();
  let name = stem;
  // A group that names a source site or a release tag goes wherever it stands; one that names the work or its authors stays.
  name = name.replace(GROUP, (whole, inside) => (SITE.test(inside) ? "" : whole)).trim();
  name = name.replace(/^(?:https?:\/\/)?(?:www\.)?[\w-]+(?:\.[\w-]+)*\.(?:com|org|net|io|cn|ru|sk|me|to|is|li|cc|xyz|info|edu)\s*[-–—:]\s*/i, "").trim();
  return name || stem || original.trim();
}

export const MAX_TITLE_CHARS = 200;
export const MAX_TITLE_HISTORY = 10;
const CONTROL = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/;
const ONLY_DOTS = /^[.…·。\s]+$/;

/** { ok: true, title } with the title trimmed and its whitespace collapsed, or { ok: false, code: 'empty' | 'too-long' | 'control' | 'dots' }. */
export function checkTitle(value) {
  if (typeof value !== 'string') return { ok: false, code: 'empty' };
  const title = value.replace(/\s+/g, ' ').trim();
  if (!title) return { ok: false, code: 'empty' };
  if (CONTROL.test(title)) return { ok: false, code: 'control' };
  if ([...title].length > MAX_TITLE_CHARS) return { ok: false, code: 'too-long' };
  if (ONLY_DOTS.test(title)) return { ok: false, code: 'dots' };
  return { ok: true, title };
}

const MESSAGES = {
  empty: 'Document title is required',
  'too-long': `Document title must be at most ${MAX_TITLE_CHARS} characters`,
  control: 'Document title must not contain control characters',
  dots: 'Document title must contain more than dots',
};
/** The English sentence for a checkTitle code (an operation's error). */
export const titleMessage = code => MESSAGES[code] || MESSAGES.empty;

/** A short, ordered, distinct list: the oldest entry (the original) is kept, then the newest ones. */
export function pushLimited(list, value, limit = MAX_TITLE_HISTORY) {
  const next = [...(Array.isArray(list) ? list : []).filter(item => item !== value), value];
  return next.length > limit ? [next[0], ...next.slice(next.length - limit + 1)] : next;
}

/**
 * Give the member sources of ONE document (every page, part or version) the new title, in place.
 * from: what the 资料 page showed so far; to: the new title (already checked); filename: the original file name.
 * Returns { changed: ids of the sources whose title changed, original: the title before the first rename }.
 */
export function retitleSources(members, { from, to, filename = '' }) {
  const single = members.length === 1;
  const original = members.find(source => typeof source.renamedFrom === 'string')?.renamedFrom ?? from;
  const bases = [...new Set([from, filename, ...members.map(source => source.document?.bookTitle), ...members.map(source => source.audio?.batch?.title)]
    .filter(base => typeof base === 'string' && base))].sort((a, b) => b.length - a.length);
  const derive = title => {
    if (single) return to;
    for (const base of bases) {
      if (title === base) return to;
      if (title.startsWith(`${base} · `) || title.startsWith(`${base} (`)) return to + title.slice(base.length);
    }
    return title;
  };
  const changed = [];
  for (const source of members) {
    const before = String(source.title ?? ''), after = derive(before);
    if (after !== before) {
      source.title = after; changed.push(source.id);
      source.titleAliases = pushLimited(source.titleAliases, before).filter(alias => alias !== after);
      if (!source.titleAliases.length) delete source.titleAliases;
    }
    if (source.document && Number.isInteger(source.document.page)) source.document.bookTitle = to;
    if (source.audio?.batch && source.audio.batch.title === from) source.audio.batch.title = to;
    if (to === original) delete source.renamedFrom; else source.renamedFrom = original;
  }
  return { changed, original };
}

/** True when `name` is, or used to be, the title of this source (its current title or an alias). */
export const hasTitle = (source, name) => !!name && (source.title === name || (Array.isArray(source.titleAliases) && source.titleAliases.includes(name)));
