/* What the writers of a learning note and the note page (ui/BlogNotes.jsx) share, browser-safe and pure: the citation links a note holds (#1017),
   written by lib/contexts/notes/question-note.js, and the titles a note is given by itself (#1711). A citation is a fragment link, so the reader's
   sanitizer keeps it and a public copy of the note shows a plain link that goes nowhere. */

/** The link of a card's citation in a note: the note page reads it (card.get) and opens the reader at that quote. */
export const citeHref = (deckId, cardId, index) => `#studyhub-cite/${encodeURIComponent(deckId)}/${encodeURIComponent(cardId)}/${index}`;
/** { deckId, cardId, index } of a citeHref, else null. */
export function parseCiteHref(href) {
  const match = /^#studyhub-cite\/([^/]+)\/([^/]+)\/(\d+)$/.exec(String(href ?? ''));
  if (!match) return null;
  try { return { deckId: decodeURIComponent(match[1]), cardId: decodeURIComponent(match[2]), index: Number(match[3]) }; } catch { return null; }
}

/** The title a daily recap is written with. */
export const recapTitle = (daily, language) => `${daily.day} · ${daily.course} · ${language === 'en' ? 'Daily study recap' : '每日学习总结'}`.slice(0, 200);

const text = value => (typeof value === 'string' ? value.trim() : '');
const pad2 = n => String(n).padStart(2, '0');
function normalizeDateToken(raw) {
  const token = String(raw ?? '').trim();
  let match = /^(\d{4})([/-])(\d{1,2})\2(\d{1,2})$/.exec(token);
  if (match) {
    const y = Number(match[1]), m = Number(match[3]), d = Number(match[4]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return { day: `${y}-${pad2(m)}-${pad2(d)}`, slash: match[2] === '/' };
  }
  match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(token);
  if (match) {
    const m = Number(match[1]), d = Number(match[2]), y = Number(match[3]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return { day: `${y}-${pad2(m)}-${pad2(d)}`, slash: true };
  }
  return null;
}

/** Parse auto-generated study-note titles (`学习笔记 · 2026/11/17`, `Study notes · 11/17/2026`, `2026-11-17 · Java 八股 · 学习笔记`, etc.); null for custom titles. */
export function parseAutoQuestionNoteTitle(title) {
  const raw = text(title);
  if (!raw) return null;
  let match = /^(学习笔记|Study notes)\s*·\s*(.+)$/i.exec(raw);
  if (match) {
    const parsed = normalizeDateToken(match[2]);
    if (!parsed) return null;
    const lang = /^study notes$/i.test(match[1]) ? 'en' : 'zh';
    return { day: parsed.day, course: '', language: lang, legacy: parsed.slash, prefixDate: false };
  }
  match = /^(\d{4}[/-]\d{1,2}[/-]\d{1,2})\s*·\s*(?:(.+?)\s*·\s*)?(学习笔记|Study notes)$/i.exec(raw);
  if (match) {
    const parsed = normalizeDateToken(match[1]);
    if (!parsed) return null;
    const lang = /^study notes$/i.test(match[3]) ? 'en' : 'zh';
    return { day: parsed.day, course: text(match[2]), language: lang, legacy: parsed.slash, prefixDate: true };
  }
  return null;
}

/** `{ day, course }` of a note whose title was given by itself (a daily recap's, a daily study note's), in either language; null when the words are
    the learner's own: an edited title, or one that names a course the note does not belong to. The list shows such a title by its parts. */
export function noteAutoTitle(note) {
  const daily = note?.daily;
  if (daily && ['zh', 'en'].some(language => recapTitle(daily, language) === note.title)) return { day: daily.day, course: daily.course };
  const parsed = parseAutoQuestionNoteTitle(note?.title);
  return parsed && (!parsed.course || (note.courses || []).includes(parsed.course)) ? { day: parsed.day, course: parsed.course } : null;
}
