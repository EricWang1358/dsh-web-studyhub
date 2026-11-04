/* The exam answer kit of a review book (复习全书, #710 S4), as stored on the notes (`courseNotes.examKit`, lib/course-book.js): built by the book build from the
   course's sample papers (lib/contexts/generation/book/kit). A book written before it, or without sample papers, has none.

     examKit: { fingerprint (the paper places it was built from), language (the papers'), missing? (types not written yet),
       questions: [{ id, paper (document key), title (the paper's name), label (Q1, Question 2 (a)), quote (verbatim), sourceId, start?, end? }],
       types: [{ print, name, family, signals: [trigger words of the questions], asks (what is really tested), template (with [slots]),
                 questions: [question id], fills: [{ question, fill }], leaves: [the points whose paper places hold its questions] }] }

   Checked where it enters (normalizeExamKit, lenient: a part that does not hold is left out, never the book refused): a fill of a question the kit does not
   hold and a point the notes do not hold are dropped. The codes T01, T02 ... are the types' places, given by the view. Pure. */

export const KIT_LIMITS = Object.freeze({ questions: 200, types: 40, labelChars: 24, titleChars: 120, quoteChars: 400, nameChars: 80, signals: 8, signalChars: 60,
  asksChars: 300, templateChars: 1600, fillChars: 800, leaves: 40 });
const FINGERPRINT = /^[0-9a-f]{16}$/;
const QUESTION = /^[0-9a-f]{12}$/;

const line = (value, max) => { const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''; return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text; };
const block = (value, max) => { const text = typeof value === 'string' ? value.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() : '';
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text; };
const list = value => (Array.isArray(value) ? value : []);

function questionOf(raw) {
  const id = QUESTION.test(String(raw?.id)) ? raw.id : null, quote = line(raw?.quote, KIT_LIMITS.quoteChars), sourceId = line(raw?.sourceId, 200);
  if (!id || !quote || !sourceId) return null;
  const span = Number.isInteger(raw.start) && Number.isInteger(raw.end) && raw.end > raw.start && raw.start >= 0 ? { start: raw.start, end: raw.end } : {};
  return { id, paper: line(raw.paper, 300), title: line(raw.title, KIT_LIMITS.titleChars), label: line(raw.label, KIT_LIMITS.labelChars), quote, sourceId, ...span };
}

function typeOf(raw, known, leafIds) {
  const template = block(raw?.template, KIT_LIMITS.templateChars), name = line(raw?.name, KIT_LIMITS.nameChars);
  if (!template || !name) return null;
  const own = [...new Set(list(raw.questions).filter(id => known.has(id)))], mine = new Set(own), seen = new Set();
  const fills = list(raw.fills).filter(fill => mine.has(fill?.question) && !seen.has(fill.question) && seen.add(fill.question))
    .map(fill => ({ question: fill.question, fill: block(fill.fill, KIT_LIMITS.fillChars) })).filter(fill => fill.fill);
  return { print: FINGERPRINT.test(String(raw.print)) ? raw.print : '', name, family: line(raw.family, 20) || 'other',
    signals: [...new Set(list(raw.signals).map(signal => line(signal, KIT_LIMITS.signalChars)).filter(Boolean))].slice(0, KIT_LIMITS.signals),
    asks: line(raw.asks, KIT_LIMITS.asksChars), template, questions: own, fills,
    leaves: [...new Set(list(raw.leaves).filter(id => leafIds.has(id)))].slice(0, KIT_LIMITS.leaves) };
}

/** The kit as stored, or null when it is not one (no fingerprint, no type with a template). `leafIds`: the ids of the notes' points. */
export function normalizeExamKit(raw, leafIds) {
  if (!raw || typeof raw !== 'object' || !FINGERPRINT.test(String(raw.fingerprint))) return null;
  const questions = [], known = new Set();
  for (const question of list(raw.questions).slice(0, KIT_LIMITS.questions).map(questionOf)) if (question && !known.has(question.id)) { known.add(question.id); questions.push(question); }
  const types = list(raw.types).slice(0, KIT_LIMITS.types).map(type => typeOf(type, known, leafIds)).filter(Boolean);
  if (!types.length) return null;
  const missing = Number.isInteger(raw.missing) && raw.missing > 0 ? { missing: raw.missing } : {};
  return { fingerprint: raw.fingerprint, language: raw.language === 'zh' ? 'zh' : 'en', ...missing, questions, types };
}

/** The code of the type at `at` (0-based): T01, T02, ... */
export const kitCode = at => `T${String(at + 1).padStart(2, '0')}`;

/**
 * The kit as the book page reads it (course.book.open): each type with its code, its fills named by paper and label (the question's words for a tip), the
 * questions it was built from (the matrix's anchors), and its points as headings of the open book (`hidOf`: point id -> hid; a point not in it is left out).
 * -> null | { language, types: [{ code, name, family, signals, asks, template, fills: [{ ref, quote, fill }], anchors: [ref], hids }] }
 */
export function examKitView(kit, hidOf) {
  if (!kit?.types?.length) return null;
  const byId = new Map(kit.questions.map(question => [question.id, question])), ref = question => [question.title, question.label].filter(Boolean).join(' ');
  return { language: kit.language, types: kit.types.map((type, at) => ({ code: kitCode(at), name: type.name, family: type.family, signals: type.signals, asks: type.asks,
    template: type.template, fills: type.fills.filter(fill => byId.has(fill.question)).map(fill => ({ ref: ref(byId.get(fill.question)), quote: byId.get(fill.question).quote,
      fill: fill.fill })), anchors: type.questions.filter(id => byId.has(id)).map(id => ref(byId.get(id))), hids: type.leaves.filter(id => hidOf.has(id)).map(id => hidOf.get(id)) })) };
}
