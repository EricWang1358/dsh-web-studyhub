import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { clampInt, foldText, searchTerms } from '../../query-input.js';
import { sourcesWithCourses, knownCourseNames } from '../../source-courses.js';
import { stampSourceVersions } from '../../material-source-versions.js';
import { courseScope } from '../../course-tree.js';
import { groupSourcesByDocument, sourceItemKey } from '../../source-groups.js';
import { isJsonCardSource } from '../../source-provenance.js';
import { courseOf } from '../../focus.js';
import { cleanDeckTitle } from '../../deck-title.js';
import { bookCoursesOf } from '../../course-book.js';
import { openCourseBook } from '../../course-book-files.js';
import { dailyNoteView } from '../notes/contracts.js';

const BOOK_LINK_LINE = /studyhub:\/\/(?:practice|qa)\b/;
const INLINE_CODE_SPLIT = /(`+[^`\n]*`+)/;

const stripPairedMarks = (piece) => piece
  .replace(/(\*\*|__|~~)(?=\S)(.+?)(?<=\S)\1/g, '$2')
  .replace(/\*(?=[^\s*])([^*\n]*?[^\s*])\*/g, '$1');

/** Convert Markdown text into clean, readable plain text with syntax markers stripped. */
export function markdownToPlainText(markdown) {
  if (!markdown) return '';
  return String(markdown)
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .split('\n')
    .filter((line) => !BOOK_LINK_LINE.test(line) && !/^\s*```/.test(line))
    .join('\n')
    .replace(/^\[\^[^\]]+\]:[^\n]*/gm, ' ')
    .replace(/\[\^[^\]]+\]/g, '')
    .replace(/!?\[([^\]]*)\]\([^)\s]*\)/g, '$1')
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*(?:>[ \t]*)+/gm, '')
    .replace(/^[ \t]*(?:[-*+]|\d+\.)[ \t]+/gm, '')
    .split(INLINE_CODE_SPLIT)
    .map((piece, idx) => (idx % 2 ? piece.replace(/`/g, '') : stripPairedMarks(piece)))
    .join('')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Short single-line plain-text preview stripped of Markdown syntax (used by snapshot.notes excerpt). */
export function plainExcerpt(markdown, max = 160) {
  const clean = markdownToPlainText(markdown).replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > max ? `${clean.slice(0, max).trimEnd()}…` : clean;
}

const oneLine = (value, max = 160) => {
  const clean = String(value ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max).trimEnd()}…` : clean;
};

/** Parse search query using `lib/query-input.js` folding & CJK rules without throwing length errors on short/blank inputs. */
export function parseContentQuery(args = {}) {
  const input = args?.query ?? args?.terms ?? args?.q ?? args?.keywords ?? '';
  if (input === '' || input === null || input === undefined) return { raw: '', phrase: '', terms: [] };
  if (typeof input !== 'string' && !(Array.isArray(input) && input.every((item) => typeof item === 'string'))) {
    throw new Error('search.content query must be a string or array of strings');
  }
  const raw = Array.isArray(input) ? input.join(' ').trim() : input.trim();
  if (!raw) return { raw: '', phrase: '', terms: [] };
  let terms = [];
  try {
    terms = searchTerms({ query: input });
  } catch {
    return { raw, phrase: '', terms: [] };
  }
  const hasBoolean = typeof input === 'string' && /[|,，、"]|\sOR\s/i.test(input);
  const phrase = !Array.isArray(input) && !hasBoolean
    ? foldText(raw.replace(/\s+/g, ' '))
    : (terms.length === 1 ? terms[0] : '');
  return { raw, phrase, terms };
}

function countOccurrences(haystack, needle) {
  if (!haystack || !needle) return { count: 0, first: -1 };
  let count = 0;
  let first = -1;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
    if (first < 0) first = at;
    count += 1;
  }
  return { count, first };
}

/**
 * Score a candidate's title/topic fields and body fields:
 *   tier 0: exact title/topic === phrase
 *   tier 1: title/topic starts with phrase, or multi-word exact phrase in title/topic
 *   tier 2: title/topic contains phrase or all query terms
 *   tier 3: multi-word exact phrase in body
 *   tier 4: all query terms matched across title/topic + body (with at least one in title/topic)
 *   tier 5: all query terms matched in body
 *   tier 6: partial query terms matched in title/topic
 *   tier 7: partial query terms matched in body
 */
function scoreCandidate({ titleTexts = [], bodyTexts = [], phrase, terms }) {
  if (!terms.length) return null;
  const titleFolds = titleTexts.map((t) => foldText(t || ''));
  const bodyFolds = bodyTexts.map((t) => foldText(t || ''));
  const multiPhrase = Boolean(phrase && (terms.length > 1 || phrase.includes(' ')));

  let exactTitle = false;
  let prefixTitle = false;
  let phraseInTitle = false;
  if (phrase) {
    for (const tf of titleFolds) {
      if (!tf) continue;
      if (tf === phrase) exactTitle = true;
      else if (tf.startsWith(phrase)) prefixTitle = true;
      if (tf.includes(phrase)) phraseInTitle = true;
    }
  }

  let phraseInBody = false;
  let bestBodyIndex = -1;
  let bestBodyOffset = -1;
  let bestBodyLen = 0;
  if (phrase) {
    for (let i = 0; i < bodyFolds.length; i += 1) {
      const at = bodyFolds[i].indexOf(phrase);
      if (at >= 0) {
        phraseInBody = true;
        bestBodyIndex = i;
        bestBodyOffset = at;
        bestBodyLen = phrase.length;
        break;
      }
    }
  }

  const matchedTitleTerms = new Set();
  const matchedAllTerms = new Set();
  let totalHits = 0;
  let earliestBodyOffset = Infinity;
  let earliestBodyIdx = -1;
  let earliestBodyTermLen = 0;

  for (const term of terms) {
    for (const tf of titleFolds) {
      const { count } = countOccurrences(tf, term);
      if (count > 0) {
        matchedTitleTerms.add(term);
        matchedAllTerms.add(term);
        totalHits += count;
      }
    }
    for (let i = 0; i < bodyFolds.length; i += 1) {
      const { count, first } = countOccurrences(bodyFolds[i], term);
      if (count > 0) {
        matchedAllTerms.add(term);
        totalHits += count;
        if (first < earliestBodyOffset) {
          earliestBodyOffset = first;
          earliestBodyIdx = i;
          earliestBodyTermLen = term.length;
        }
      }
    }
  }

  if (!matchedAllTerms.size && !phraseInTitle && !phraseInBody) return null;

  if (bestBodyIndex < 0 && earliestBodyIdx >= 0) {
    bestBodyIndex = earliestBodyIdx;
    bestBodyOffset = earliestBodyOffset;
    bestBodyLen = earliestBodyTermLen;
  }

  const allTermsMatched = matchedAllTerms.size === terms.length;
  const allInTitle = matchedTitleTerms.size === terms.length;

  let tier = 7;
  if (exactTitle) tier = 0;
  else if (prefixTitle || (multiPhrase && phraseInTitle)) tier = 1;
  else if (phraseInTitle || allInTitle) tier = 2;
  else if (multiPhrase && phraseInBody) tier = 3;
  else if (allTermsMatched && matchedTitleTerms.size > 0) tier = 4;
  else if (allTermsMatched) tier = 5;
  else if (matchedTitleTerms.size > 0) tier = 6;

  return {
    tier,
    matchedCount: matchedAllTerms.size,
    totalHits,
    bodyIndex: bestBodyIndex,
    matchOffset: bestBodyOffset >= 0 ? bestBodyOffset : 0,
    matchLen: bestBodyLen || terms[0].length,
  };
}

export function buildSnippet(rawText, matchOffset = 0, matchLen = 1, radius = 56) {
  const source = String(rawText ?? '');
  if (!source.trim()) return '';
  if (matchOffset < 0 || matchOffset >= source.length) return oneLine(source, radius * 2 + 20);
  const start = Math.max(0, matchOffset - radius);
  const end = Math.min(source.length, matchOffset + Math.max(1, matchLen) + radius);
  const slice = source.slice(start, end).replace(/\s+/g, ' ').trim();
  if (!slice) return oneLine(source, radius * 2 + 20);
  return `${start > 0 ? '…' : ''}${slice}${end < source.length ? '…' : ''}`;
}

function extractVerbatimQuote(rawText, matchOffset = 0, matchLen = 1) {
  const text = String(rawText ?? '');
  if (!text) return '';
  const safeOffset = Math.max(0, Math.min(matchOffset, Math.max(0, text.length - 1)));
  const lineStart = text.lastIndexOf('\n', safeOffset) + 1;
  const nextBreak = text.indexOf('\n', safeOffset + Math.max(1, matchLen));
  const lineEnd = nextBreak < 0 ? text.length : nextBreak;
  const from = Math.max(lineStart, safeOffset - 36);
  const to = Math.min(lineEnd, safeOffset + Math.max(1, matchLen) + 48);
  return text.slice(from, to).trim();
}

function cardAnswerText(card) {
  const parts = [];
  if (card.answer) parts.push(String(card.answer));
  else if (card.back) parts.push(String(card.back));
  if (Array.isArray(card.options)) {
    for (const opt of card.options) {
      if (typeof opt === 'string') parts.push(opt);
      else if (opt && typeof opt === 'object') parts.push(opt.text || opt.label || '');
    }
  }
  if (Array.isArray(card.blanks)) {
    for (const blank of card.blanks) {
      if (typeof blank === 'string') parts.push(blank);
      else if (blank?.answer) parts.push(String(blank.answer));
    }
  }
  return parts.filter(Boolean).join(' · ');
}

function cardExplanationText(card) {
  const parts = [card.explanation, card.rationale, card.misconception];
  if (Array.isArray(card.options)) {
    for (const opt of card.options) if (opt && typeof opt === 'object' && opt.note) parts.push(opt.note);
  }
  if (card.optionNotes && typeof card.optionNotes === 'object') {
    for (const note of Object.values(card.optionNotes)) if (typeof note === 'string') parts.push(note);
  }
  return parts.filter(Boolean).join(' ');
}

function paragraphsOfMarkdown(markdown) {
  if (!markdown) return [];
  return String(markdown)
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n+/)
    .map((block) => markdownToPlainText(block).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function walkBookNodes(nodes, out = []) {
  for (const node of nodes || []) {
    out.push(node);
    if (Array.isArray(node.children) && node.children.length) walkBookNodes(node.children, out);
  }
  return out;
}

async function readDiskCourseBooks(root) {
  if (!root || typeof root !== 'string') return [];
  const booksDir = join(root, 'course-books');
  const entries = await readdir(booksDir, { withFileTypes: true }).catch(() => []);
  if (!entries.length) return [];
  const chapters = [];
  const readChapterFile = async (filePath, course, fallbackId) => {
    const raw = await readFile(filePath, 'utf8').catch(() => '');
    if (!raw.trim()) return;
    const normalized = raw.replace(/\r\n?/g, '\n');
    const headingMatch = normalized.match(/^[ \t]*#{1,3}[ \t]+(.+?)[ \t]*$/m);
    const chapterTitle = headingMatch ? markdownToPlainText(headingMatch[1]) : fallbackId;
    const bodyMarkdown = normalized.replace(/^\s*#{1,2}[ \t]+[^\n]+\n*/, '');
    chapters.push({ course, chapterId: fallbackId, chapterTitle: chapterTitle || fallbackId, markdown: bodyMarkdown });
  };
  for (const entry of entries) {
    const fullPath = join(booksDir, entry.name);
    if (entry.isFile() && entry.name.endsWith('.md')) {
      await readChapterFile(fullPath, '', basename(entry.name, '.md'));
    } else if (entry.isDirectory()) {
      const course = entry.name;
      const subEntries = await readdir(fullPath, { withFileTypes: true }).catch(() => []);
      for (const sub of subEntries) {
        const subPath = join(fullPath, sub.name);
        if (sub.isFile() && sub.name.endsWith('.md')) {
          await readChapterFile(subPath, course, basename(sub.name, '.md'));
        } else if (sub.isDirectory() && sub.name === 'chapters') {
          const nested = await readdir(subPath, { withFileTypes: true }).catch(() => []);
          for (const leaf of nested) {
            if (leaf.isFile() && leaf.name.endsWith('.md')) {
              await readChapterFile(join(subPath, leaf.name), course, basename(leaf.name, '.md'));
            }
          }
        }
      }
    }
  }
  return chapters;
}

function compareScored(a, b) {
  return a.score.tier - b.score.tier
    || b.score.matchedCount - a.score.matchedCount
    || b.score.totalHits - a.score.totalHits
    || a.score.matchOffset - b.score.matchOffset
    || a.order - b.order;
}

/**
 * Federated full-text content search across all 4 library domains:
 *   1) Materials (`sources`)
 *   2) Question Bank (`decks[].cards`)
 *   3) Notes (`notes`)
 *   4) Review Books (`course-book` records + `course-books/` markdown files on disk)
 */
export async function searchLibraryContent(state, args = {}, { root = '' } = {}) {
  const { raw, phrase, terms } = parseContentQuery(args);
  const limit = clampInt(args?.limit, 24, 1, 100);
  const budgetMs = clampInt(args?.budgetMs, 400, 20, 5000);
  const emptyGroups = () => ({ sources: [], cards: [], notes: [], books: [] });
  if (!terms.length) {
    return { query: raw, terms: [], course: args?.course ?? null, total: 0, truncated: false, results: [], groups: emptyGroups() };
  }

  const startedAt = performance.now();
  let timedOut = false;
  const overBudget = () => {
    if (timedOut) return true;
    if (performance.now() - startedAt > budgetMs) { timedOut = true; return true; }
    return false;
  };

  const sampleIds = new Set([
    state?.sample?.deckId,
    state?.sample?.caseDeckId,
    state?.sample?.draftId,
    state?.sample?.sourceId,
  ].filter(Boolean));
  const sampleCourses = new Set([
    ...(state?.courses || []).filter((c) => c?.sample && c?.name).map((c) => c.name),
    ...(state?.decks || []).filter((d) => (d?.sample || sampleIds.has(d?.id)) && d?.course).map((d) => d.course),
  ]);

  const courseArg = args?.course;
  const hasCourseFilter = typeof courseArg === 'string' && courseArg !== '*';
  const withinCourse = hasCourseFilter && courseArg !== '' ? courseScope(courseArg, knownCourseNames(state)) : null;
  const inCourseScope = (courses) => {
    if (!hasCourseFilter) return true;
    const clean = (courses || []).filter((c) => typeof c === 'string' && c.length > 0);
    if (courseArg === '') return clean.length === 0;
    return clean.some((c) => withinCourse(c));
  };
  const allowArchived = args?.includeArchived === true;
  const allowSample = args?.includeSample === true
    || (hasCourseFilter && courseArg !== '' && [...sampleCourses].some((name) => withinCourse?.(name)));

  let order = 0;

  // 1) Materials (`sources`)
  const allMaterialSources = stampSourceVersions(sourcesWithCourses(state || {}), state?.documents);
  const groupedDocs = groupSourcesByDocument(allMaterialSources, { documents: state?.documents });
  const docTitleBySourceId = new Map();
  for (const doc of groupedDocs) {
    for (const sid of doc.sourceIds || []) {
      if (doc.title) docTitleBySourceId.set(sid, doc.title);
    }
  }
  const sourceCandidates = [];
  for (const source of allMaterialSources) {
    if (overBudget()) break;
    if (!source || source.historical || isJsonCardSource(source)) continue;
    if (!allowArchived && source.archived) continue;
    if (!allowSample && (source.sample || sampleIds.has(source.id))) continue;
    const courses = Array.isArray(source.courses) ? source.courses : (source.course ? [source.course] : []);
    if (!inCourseScope(courses)) continue;
    const text = String(source.text ?? '');
    const docTitle = docTitleBySourceId.get(source.id) || source.title || source.id;
    const score = scoreCandidate({
      titleTexts: [docTitle, source.title || ''],
      bodyTexts: [text],
      phrase,
      terms,
    });
    if (!score) continue;
    const hasBodyHit = score.bodyIndex >= 0;
    const matchOffset = hasBodyHit ? score.matchOffset : 0;
    const snippet = hasBodyHit
      ? buildSnippet(text, matchOffset, score.matchLen)
      : plainExcerpt(text, 140);
    const quote = hasBodyHit ? extractVerbatimQuote(text, matchOffset, score.matchLen) : '';
    const pageNum = Number.isInteger(source.document?.page)
      ? source.document.page
      : (Number.isInteger(source.page) ? source.page : null);
    sourceCandidates.push({
      score,
      order: order++,
      documentKey: sourceItemKey(source),
      hit: {
        kind: 'source',
        sourceId: source.id,
        documentKey: sourceItemKey(source),
        title: docTitle,
        course: courses[0] || '',
        page: pageNum,
        snippet,
        matchOffset,
        ...(quote ? { quote } : {}),
      },
    });
  }
  sourceCandidates.sort(compareScored);
  // Keep up to 3 best page hits per multi-page document first so one book never hides other materials.
  const perDocCounts = new Map();
  const primarySourceHits = [];
  const overflowSourceHits = [];
  for (const item of sourceCandidates) {
    const used = perDocCounts.get(item.documentKey) || 0;
    if (used < 3) {
      perDocCounts.set(item.documentKey, used + 1);
      primarySourceHits.push(item);
    } else {
      overflowSourceHits.push(item);
    }
  }
  const rankedSources = [...primarySourceHits, ...overflowSourceHits];

  // 2) Question Bank (`decks[].cards`)
  const rankedCards = [];
  for (const deck of state?.decks || []) {
    if (overBudget()) break;
    if (!deck || deck.systemKind === 'slain') continue;
    if (!allowArchived && deck.archived) continue;
    if (!allowSample && (deck.sample || sampleIds.has(deck.id))) continue;
    const deckCourse = courseOf(deck, state) || deck.course || deck.folder || '';
    if (!inCourseScope(deckCourse ? [deckCourse] : [])) continue;
    const deckTitle = cleanDeckTitle(deck.title || deck.id);
    for (const card of deck.cards || []) {
      if (overBudget()) break;
      if (!card || (!allowArchived && card.suspended)) continue;
      const prompt = String(card.prompt ?? card.front ?? '');
      const answer = cardAnswerText(card);
      const explanation = cardExplanationText(card);
      const bodyTexts = [prompt, answer, explanation];
      const score = scoreCandidate({
        titleTexts: [card.topic || '', card.objective || '', deckTitle],
        bodyTexts,
        phrase,
        terms,
      });
      if (!score) continue;
      const matchedBody = score.bodyIndex >= 0 ? bodyTexts[score.bodyIndex] : '';
      const snippet = matchedBody
        ? buildSnippet(matchedBody, score.matchOffset, score.matchLen)
        : oneLine(prompt || answer || explanation, 140);
      rankedCards.push({
        score,
        order: order++,
        hit: {
          kind: 'card',
          deckId: deck.id,
          deckTitle,
          cardId: card.id,
          course: deckCourse,
          topic: card.topic || '',
          prompt: oneLine(prompt, 120),
          snippet,
        },
      });
    }
  }
  rankedCards.sort(compareScored);

  // 3) Notes (`notes`)
  const rankedNotes = [];
  for (const rawNote of state?.notes || []) {
    if (overBudget()) break;
    if (!rawNote || rawNote.kind === 'daily-recap-history') continue;
    if (!allowArchived && rawNote.archived) continue;
    if (!allowSample && rawNote.sample) continue;
    const view = dailyNoteView(state, rawNote);
    const noteCourses = [view.daily?.course, view.course, ...(view.courses || [])].filter(Boolean);
    if (!inCourseScope(noteCourses)) continue;
    const title = view.title || rawNote.heading || view.daily?.title || '';
    const plainBody = markdownToPlainText(rawNote.markdown ?? rawNote.body ?? rawNote.text ?? '');
    const score = scoreCandidate({
      titleTexts: [title],
      bodyTexts: [plainBody],
      phrase,
      terms,
    });
    if (!score) continue;
    const snippet = score.bodyIndex >= 0 && plainBody
      ? buildSnippet(plainBody, score.matchOffset, score.matchLen)
      : oneLine(plainBody || title, 140);
    rankedNotes.push({
      score,
      order: order++,
      hit: {
        kind: 'note',
        noteId: rawNote.id,
        title,
        course: noteCourses[0] || '',
        snippet,
      },
    });
  }
  rankedNotes.sort(compareScored);

  // 4) Review Books (both StudyHub `openCourseBook` records and `course-books/` markdown files on disk)
  const rankedBooks = [];
  const seenBookChapters = new Set();
  const pushBookChapter = (course, chapterId, chapterTitle, markdown) => {
    if (!chapterId) return;
    const dedupeKey = `${course}\u0000${chapterId}`;
    if (seenBookChapters.has(dedupeKey)) return;
    const paragraphs = paragraphsOfMarkdown(markdown);
    const score = scoreCandidate({
      titleTexts: [chapterTitle],
      bodyTexts: paragraphs,
      phrase,
      terms,
    });
    if (!score) return;
    seenBookChapters.add(dedupeKey);
    const paragraphIndex = score.bodyIndex >= 0 ? score.bodyIndex : 0;
    const matchedParagraph = paragraphs[paragraphIndex] || '';
    const snippet = score.bodyIndex >= 0 && matchedParagraph
      ? buildSnippet(matchedParagraph, score.matchOffset, score.matchLen)
      : oneLine(matchedParagraph || chapterTitle, 140);
    rankedBooks.push({
      score,
      order: order++,
      hit: {
        kind: 'book',
        course,
        chapterId,
        chapterTitle: chapterTitle || chapterId,
        paragraphIndex,
        snippet,
      },
    });
  };

  for (const bookCourse of bookCoursesOf(state?.sources || [])) {
    if (overBudget()) break;
    if (!allowSample && sampleCourses.has(bookCourse)) continue;
    if (!inCourseScope(bookCourse ? [bookCourse] : [])) continue;
    const book = openCourseBook(state, { course: bookCourse }, { write: false, applyRebuild: true });
    if (book?.status !== 'ok') continue;
    for (const node of walkBookNodes(book.nodes)) {
      if (overBudget()) break;
      const md = node.leaf ? [node.gen, node.mine, node.qa].filter(Boolean).join('\n\n') : '';
      pushBookChapter(bookCourse, node.hid || node.key, node.title || node.hid, md);
    }
    if (String(book.unplaced?.text ?? '').trim()) {
      pushBookChapter(bookCourse, 'unplaced', book.unplaced.title || 'unplaced', book.unplaced.text);
    }
  }

  if (!overBudget() && root) {
    const diskChapters = await readDiskCourseBooks(root);
    for (const ch of diskChapters) {
      if (overBudget()) break;
      if (!allowSample && sampleCourses.has(ch.course)) continue;
      if (!inCourseScope(ch.course ? [ch.course] : [])) continue;
      pushBookChapter(ch.course, ch.chapterId, ch.chapterTitle, ch.markdown);
    }
  }
  rankedBooks.sort(compareScored);

  const totalMatched = rankedSources.length + rankedCards.length + rankedNotes.length + rankedBooks.length;

  // Merge across all 4 domains preserving relevance ranking while guaranteeing active domains aren't starved by one huge domain.
  const perDomainQuota = Math.max(4, Math.ceil(limit / 2));
  const primaryPool = [
    ...rankedSources.slice(0, perDomainQuota),
    ...rankedCards.slice(0, perDomainQuota),
    ...rankedNotes.slice(0, perDomainQuota),
    ...rankedBooks.slice(0, perDomainQuota),
  ].sort(compareScored);
  const secondaryPool = [
    ...rankedSources.slice(perDomainQuota),
    ...rankedCards.slice(perDomainQuota),
    ...rankedNotes.slice(perDomainQuota),
    ...rankedBooks.slice(perDomainQuota),
  ].sort(compareScored);

  const selected = [...primaryPool, ...secondaryPool].slice(0, limit).map((entry) => entry.hit);
  return {
    query: raw,
    terms,
    course: hasCourseFilter ? courseArg : null,
    total: totalMatched,
    truncated: timedOut || totalMatched > selected.length,
    results: selected,
    groups: {
      sources: selected.filter((item) => item.kind === 'source'),
      cards: selected.filter((item) => item.kind === 'card'),
      notes: selected.filter((item) => item.kind === 'note'),
      books: selected.filter((item) => item.kind === 'book'),
    },
  };
}
