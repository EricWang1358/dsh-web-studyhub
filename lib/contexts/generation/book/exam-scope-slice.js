import { cleanFocusTopics, courseFocusTopics, parseFocusText } from '../../../focus-points.js';
import { currentInventory, nameForms } from '../../../course-book-inventory.js';
import { currentCourseOutline } from '../../../course-outline-book.js';
import { chapterKey, courseDocuments, parseSpan } from '../../../course-outline-index.js';
import { documentIndex, outlineLeaves } from '../../../course-book-inputs.js';
import { courseSkeleton } from '../../../custom-skeleton.js';

/* 真·考试范围切片 (StudyHub 5.0.0 · Evolution 2 Item #4): 0-token deterministic matching of exam scope inputs
   (`course.focusTopics`, `scope.note`, `course.guidanceSourceIds`) against the course's material TOC,
   `courseInventory`, and/or `courseOutline` chapters.
   Pure, zero I/O, zero model calls. Exported to `library` through `lib/contexts/generation/contracts.js`.
   Never silently drops exam topics: every extracted topic is either attributed to >= 1 matched chapter or
   explicitly surfaced in `unmatchedTopics` for the learner to review before confirming `scope.resolvedChapters`. */

const CJK = /[\u3400-\u9fff]/u;
const ASCII_WORD = /^[a-z0-9][a-z0-9_+-]*$/i;
const CHAPTER_TEXT_CAP = 16_000;
const GUIDANCE_TEXT_CAP = 8_000;
const MAX_GUIDANCE_SOURCES = 10;
const MAX_CHAPTER_NUM = 200;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'about', 'that', 'this', 'these', 'those', 'their', 'what', 'when',
  'where', 'which', 'how', 'why', 'are', 'was', 'were', 'been', 'being', 'have', 'has', 'had', 'not', 'but', 'can',
  'will', 'may', 'might', 'should', 'could', 'chapter', 'chapters', 'section', 'sections', 'part', 'parts', 'unit',
  'lecture', 'week', 'topic', 'topics', 'exam', 'final', 'midterm', 'review', 'scope', 'focus', 'syllabus', 'note',
  'notes', 'overview', 'introduction', 'summary', 'basics', 'concepts', 'theory', 'methods', 'study',
  '考试', '期末', '期中', '范围', '重点', '考点', '复习', '大纲', '提纲', '说明', '章节', '内容', '概述', '导论', '简介', '总结', '基础',
]);

const ZH_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const normSpace = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const normLower = value => normSpace(value).toLowerCase();
const compactKey = value => normLower(value).replace(/[\s\-_·•‧/]+/g, '').replace(/[.:：;；,，。、]+$/u, '');

/** Parse an Arabic or simple Chinese numeral (1..200), or null. */
function parseChapterNum(raw) {
  const text = normSpace(raw);
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    return n >= 1 && n <= MAX_CHAPTER_NUM ? n : null;
  }
  if (/^[零〇一二两三四五六七八九十百]+$/.test(text)) {
    let total = 0, current = 0;
    for (const ch of text) {
      if (ch === '百') { total += (current || 1) * 100; current = 0; }
      else if (ch === '十') { total += (current || 1) * 10; current = 0; }
      else if (Object.hasOwn(ZH_DIGITS, ch)) current = ZH_DIGITS[ch];
      else return null;
    }
    const n = total + current;
    return n >= 1 && n <= MAX_CHAPTER_NUM ? n : null;
  }
  return null;
}

/** Expand a numeric list/range string like "3, 5-7, 9" or "3、5–7、九" into unique chapter numbers. */
function expandChapterList(raw) {
  const nums = [];
  const pieces = String(raw ?? '').split(/(?:,|，|、|\band\b|&|和|及|与)+/i).map(part => part.trim()).filter(Boolean);
  for (const piece of pieces) {
    const range = /^([0-9零〇一二两三四五六七八九十百]+)\s*[-–—~到至]\s*([0-9零〇一二两三四五六七八九十百]+)$/.exec(piece);
    if (range) {
      const from = parseChapterNum(range[1]), to = parseChapterNum(range[2]);
      if (from && to && to >= from && to - from <= 40) {
        for (let n = from; n <= to; n++) nums.push(n);
      }
      continue;
    }
    const single = parseChapterNum(piece);
    if (single) nums.push(single);
  }
  return [...new Set(nums)];
}

const EN_CH_REF = /\b(?:chapters?|ch\.?)\s+([0-9]+(?:\s*[-–—~]\s*[0-9]+)?(?:\s*(?:,|and|&)\s*[0-9]+(?:\s*[-–—~]\s*[0-9]+)?)*)/gi;
const ZH_CH_REF = /第\s*([0-9零〇一二两三四五六七八九十百]+(?:\s*[-–—~到至]\s*[0-9零〇一二两三四五六七八九十百]+)?(?:\s*[、,，和及与]\s*[0-9零〇一二两三四五六七八九十百]+(?:\s*[-–—~到至]\s*[0-9零〇一二两三四五六七八九十百]+)?)*)\s*章/g;

/** Extract explicit chapter number references from free text: [{ num, label }]. */
function extractChapterRefs(text, language = 'zh') {
  const source = normSpace(text);
  if (!source) return [];
  const byNum = new Map();
  const add = (nums, zh) => {
    for (const num of nums) {
      if (!byNum.has(num)) byNum.set(num, zh ? `第 ${num} 章` : `Chapter ${num}`);
    }
  };
  for (const match of source.matchAll(EN_CH_REF)) add(expandChapterList(match[1]), false);
  for (const match of source.matchAll(ZH_CH_REF)) add(expandChapterList(match[1]), true);
  return [...byNum.entries()].map(([num, label]) => ({ num, label: language === 'en' ? `Chapter ${num}` : label }));
}

/** Strip leading conversational scope cues and chapter-number prefixes ("重点考 Page Replacement" -> "Page Replacement"). */
function stripChapterRefPrefix(raw) {
  let text = normSpace(raw);
  for (let pass = 0; pass < 4; pass++) {
    const before = text;
    text = text
      .replace(/^[,，、;；:：\-—]+\s*/u, '')
      .replace(/^(?:(?:chapters?|ch\.?)\s+[0-9]+(?:\s*[-–—~]\s*[0-9]+)?(?:\s*(?:,|and|&)\s*[0-9]+(?:\s*[-–—~]\s*[0-9]+)?)*|第\s*[0-9零〇一二两三四五六七八九十百]+(?:\s*[-–—~到至]\s*[0-9零〇一二两三四五六七八九十百]+)?(?:\s*[、,，和及与]\s*[0-9零〇一二两三四五六七八九十百]+(?:\s*[-–—~到至]\s*[0-9零〇一二两三四五六七八九十百]+)?)*\s*章)\s*[:：\-—,，、]?\s*/i, '')
      .replace(/^(?:期末|期中|考试|复习)?(?:范围|重点|内容)\s*[:：\-—]\s*/iu, '')
      .replace(/^(?:重点(?:考|考查|考察)?|主要(?:考|考查|考察)?|必考|考查|考察|focus(?:es)?\s+on|covering|covers|emphasis\s+on|including)\s*[:：\-—]?\s*/iu, '')
      .trim();
    if (text === before) break;
  }
  return text;
}

/** True when a phrase is ONLY chapter numbers / scope boilerplate and carries no separate topic name. */
function isChapterRefOnly(raw) {
  const rest = normSpace(raw)
    .replace(EN_CH_REF, ' ')
    .replace(ZH_CH_REF, ' ')
    .replace(/^(?:期末|期中|考试|复习)?(?:范围|重点|内容|考|covers?|covering|exam\s*scope|midterm|final|only)\s*[:：\-—]?\s*/gi, ' ')
    .replace(/[\s,，、;；:：.。()（）[\]【】\-—]+/g, '')
    .trim();
  return !rest;
}

/** Split free-form scope note into concise topic candidates (preserving parenthetical aliases). */
function parseNoteTopics(note) {
  const source = typeof note === 'string' ? note.replace(/\uFEFF/g, '').replace(/\r\n?/g, '\n').trim() : '';
  if (!source) return [];
  const rawPieces = [];
  for (const rawLine of source.split('\n')) {
    const line = rawLine.trim();
    if (!line || isChapterRefOnly(line)) continue;
    const stripped = stripChapterRefPrefix(line);
    if (!stripped || isChapterRefOnly(stripped)) continue;
    // Also split comma-separated English/Chinese topic lists on a single line (outside brackets).
    const parts = splitOutside(stripped, /[;；｜|、,，]/);
    if (parts.length >= 2 && parts.every(part => part.length >= 2 && part.length <= 64)) {
      for (const part of parts) {
        const cleaned = stripChapterRefPrefix(part);
        if (cleaned && !isChapterRefOnly(cleaned)) rawPieces.push(cleaned);
      }
    } else {
      rawPieces.push(stripped);
    }
  }
  return cleanFocusTopics(rawPieces, { limit: 100 });
}

function splitOutside(text, sepPattern) {
  const out = [];
  let depth = 0, start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if ('(（[【{'.includes(ch)) depth++;
    else if (')）]】}'.includes(ch)) depth = Math.max(0, depth - 1);
    else if (depth === 0 && sepPattern.test(ch)) {
      const piece = text.slice(start, i).trim();
      if (piece) out.push(piece);
      start = i + 1;
    }
  }
  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

/** Extract concise topic items from guidance sources without turning long prose transcripts into noisy topics. */
function parseGuidanceTopics(guidanceSources, { allowShortLines = false } = {}) {
  const candidates = [];
  const bulletLine = /^(?:[-*•·▪▸▶►✓✔☆★]+|\(?\d{1,3}[.)、．]|\([一二三四五六七八九十]+\)|[一二三四五六七八九十]+[、．.]|[①-⑳])\s+/u;
  for (const source of guidanceSources) {
    const text = typeof source?.text === 'string' ? source.text.slice(0, GUIDANCE_TEXT_CAP) : '';
    if (!text) continue;
    for (const rawLine of text.replace(/\r\n?/g, '\n').split('\n')) {
      const line = rawLine.trim();
      if (!line || line.length > 80 || /^```|^---+$/.test(line)) continue;
      if (bulletLine.test(line)) {
        for (const item of parseFocusText(line, { limit: 20 }).topics) {
          if (item.length <= 60 && !isChapterRefOnly(item)) candidates.push(item);
        }
      } else if (allowShortLines && !line.startsWith('#') && line.length >= 2 && line.length <= 60 && !/[。！？!?]$/.test(line)) {
        for (const item of parseFocusText(line, { limit: 20 }).topics) {
          if (item.length <= 60 && !isChapterRefOnly(item)) candidates.push(item);
        }
      }
    }
  }
  return cleanFocusTopics(candidates, { limit: 60 });
}

/** Expand a topic or term into its normalized alias forms (bilingual glosses + slash aliases). */
function aliasForms(raw) {
  const forms = new Set();
  const push = value => {
    const cleaned = normSpace(value);
    if (!cleaned) return;
    if (cleaned.length < 2 && !CJK.test(cleaned)) return;
    forms.add(cleaned);
  };
  for (const form of nameForms(raw)) {
    push(form);
    if (form.includes('/')) {
      for (const piece of splitOutside(form, /\//)) {
        if (piece.length >= 2) push(piece);
      }
    }
  }
  return [...forms];
}

/** Meaningful tokens for multi-term fallback matching (English words >= 3 chars, CJK sequences >= 2 chars). */
function meaningfulTokens(raw) {
  const text = normLower(raw);
  if (!text) return [];
  const out = new Set();
  for (const match of text.matchAll(/[a-z][a-z0-9_+-]{2,}/g)) {
    const word = match[0];
    if (!STOPWORDS.has(word)) out.add(word);
  }
  for (const match of text.matchAll(/[\u3400-\u9fff]{2,}/gu)) {
    const seq = match[0];
    if (!STOPWORDS.has(seq)) out.add(seq);
    if (seq.length >= 4 && seq.length <= 12) {
      // Include 2-char CJK bigrams for compound terms when exact phrase doesn't hit.
      for (let i = 0; i <= seq.length - 2; i++) {
        const bg = seq.slice(i, i + 2);
        if (!STOPWORDS.has(bg)) out.add(bg);
      }
    }
  }
  return [...out];
}

/** Test whether a single alias form appears in a normalized haystack string (respecting ASCII word boundaries). */
function formMatchesText(form, haystackLower, haystackCompact) {
  const needle = normLower(form);
  if (!needle) return false;
  if (ASCII_WORD.test(needle)) {
    const re = new RegExp(`(?<![a-z0-9])${escapeRegex(needle)}(?![a-z0-9])`, 'i');
    return re.test(haystackLower);
  }
  if (haystackLower.includes(needle)) {
    // Guard ASCII edges of multi-word ASCII phrases ("page table" shouldn't match "webpage tables").
    if (/^[a-z0-9]/i.test(needle) && /[a-z0-9]$/i.test(needle)) {
      const re = new RegExp(`(?<![a-z0-9])${escapeRegex(needle)}(?![a-z0-9])`, 'i');
      if (re.test(haystackLower)) return true;
    } else {
      return true;
    }
  }
  const compact = compactKey(needle);
  if (compact.length >= 4 && !ASCII_WORD.test(needle) && haystackCompact && haystackCompact.includes(compact)) {
    return true;
  }
  return false;
}

/** Parse an explicit chapter number from a chapter title ("Chapter 3: ..." / "第3章 ..." / "3. ..."), or null. */
function titleChapterNum(title) {
  const text = normSpace(title);
  if (!text) return null;
  const en = /^(?:chapter|ch\.?)\s+(\d+)\b/i.exec(text);
  if (en) return parseChapterNum(en[1]);
  const zh = /^第\s*([0-9零〇一二两三四五六七八九十百]+)\s*章/.exec(text);
  if (zh) return parseChapterNum(zh[1]);
  const leading = /^(\d{1,3})\s*[.:：、\s\-—]/.exec(text);
  if (leading) return parseChapterNum(leading[1]);
  return null;
}

/** Collect markdown headings and a bounded excerpt from a list of sourceIds. */
function readSourcesSurface(bySourceId, sourceIds) {
  const ids = [...new Set((sourceIds || []).filter(id => bySourceId.has(id)))];
  if (!ids.length) return { headings: [], text: '' };
  const headings = [];
  const chunks = [];
  const perSource = Math.max(400, Math.floor(CHAPTER_TEXT_CAP / Math.max(1, ids.length)));
  let total = 0;
  for (const id of ids) {
    const raw = bySourceId.get(id)?.text;
    if (typeof raw !== 'string' || !raw) continue;
    for (const match of raw.matchAll(/^#{1,6}\s+(.+)$/gm)) {
      const heading = normSpace(match[1]);
      if (heading) headings.push(heading);
    }
    if (total < CHAPTER_TEXT_CAP) {
      const take = raw.slice(0, Math.min(perSource, CHAPTER_TEXT_CAP - total));
      chunks.push(take);
      total += take.length;
    }
  }
  return { headings, text: chunks.join('\n') };
}

/** Build searchable chapter surfaces in skeleton reading order (0-token). */
function buildChapterSurfaces(state, course, skeleton, guidanceIdSet = new Set()) {
  const bySourceId = new Map((Array.isArray(state.sources) ? state.sources : []).map(source => [source.id, source]));
  const inventory = currentInventory(state.sources, course)?.courseInventory ?? null;
  const invById = new Map((inventory?.items || []).map(item => [item.id, item]));
  const { candidates } = courseDocuments(state, course);
  const docsByKey = new Map(candidates.map(doc => [doc.key, doc]));

  if (skeleton.basis === 'outline') {
    const outline = currentCourseOutline(state.sources, course)?.courseOutline ?? null;
    const topById = new Map((outline?.nodes || []).map(node => [node.id, node]));
    const docIdx = documentIndex(candidates);
    return (skeleton.outline?.chapters || []).map((chapter, at) => {
      const top = topById.get(chapter.id);
      const leaves = top ? outlineLeaves([top]) : [];
      const headingTexts = [chapter.title, ...leaves.map(({ node, path }) => [node.title, ...path].join(' ')).filter(Boolean)];
      const invTerms = [];
      const invGists = [];
      const sourceIds = new Set();
      for (const { node } of leaves) {
        for (const itemId of node.items || []) {
          const item = invById.get(itemId);
          if (!item) continue;
          invTerms.push(item.name, ...nameForms(item.name));
          if (item.gist) invGists.push(item.gist);
          for (const place of item.places || []) if (place.sourceId) sourceIds.add(place.sourceId);
        }
        for (const anchor of node.anchors || []) {
          const found = docIdx.get(anchor);
          if (found) {
            const ids = found.chapter?.sourceIds?.length ? found.chapter.sourceIds : found.item.sourceIds;
            for (const id of ids || []) sourceIds.add(id);
          } else {
            const span = parseSpan(anchor);
            const doc = span ? docsByKey.get(span.doc) : null;
            if (doc) {
              const ids = span.unit === 's' ? doc.sourceIds.slice(span.from, span.to + 1) : doc.sourceIds;
              for (const id of ids || []) sourceIds.add(id);
            }
          }
        }
      }
      const surface = readSourcesSurface(bySourceId, [...sourceIds]);
      const allHeadings = [...headingTexts, ...surface.headings];
      return {
        id: chapter.id,
        title: chapter.title,
        points: chapter.points,
        order: at,
        chapterNum: titleChapterNum(chapter.title),
        fallbackNum: at + 1,
        headingLower: normLower(allHeadings.join(' \n ')),
        headingCompact: compactKey(allHeadings.join(' ')),
        invLower: normLower([...invTerms, ...invGists].join(' \n ')),
        invCompact: compactKey(invTerms.join(' ')),
        contentLower: normLower(surface.text),
        tokenBag: new Set(meaningfulTokens([...allHeadings, ...invTerms].join(' '))),
      };
    });
  }

  // Basis: 'documents' (taught materials only: exclude sample papers, copies, and pure exam-guidance docs so syllabus notes never self-match).
  const taughtDocs = skeleton.documents.filter(doc => {
    if (doc.paper || doc.copyOf) return false;
    const fullDoc = docsByKey.get(doc.key);
    if (guidanceIdSet.size && fullDoc?.sourceIds?.length && fullDoc.sourceIds.every(id => guidanceIdSet.has(id))) return false;
    return true;
  });
  const singleMainDoc = taughtDocs.filter(doc => doc.chapters.length > 1).length === 1;
  const surfaces = [];
  for (const skDoc of taughtDocs) {
    const fullDoc = docsByKey.get(skDoc.key);
    const fullChapters = (fullDoc?.chapters || []).filter(ch => !ch.front);
    const byChapterId = new Map(fullChapters.map(ch => [chapterKey(skDoc.key, ch.index), ch]));
    const docInvItems = (inventory?.items || []).filter(item => (item.places || []).some(place => place.doc === skDoc.key));
    const docOutlineEntries = Array.isArray(fullDoc?.outline?.entries) ? fullDoc.outline.entries : [];

    for (let at = 0; at < skDoc.chapters.length; at++) {
      const ch = skDoc.chapters[at];
      const fullCh = byChapterId.get(ch.id) ?? null;
      const sourceIds = fullCh?.sourceIds?.length ? fullCh.sourceIds : (fullDoc?.sourceIds || []);
      const sourceIdSet = new Set(sourceIds);
      const [fromPage, toPage] = Array.isArray(ch.pages) ? ch.pages : [1, skDoc.pages || 1];

      const subheadings = docOutlineEntries
        .filter(entry => entry?.title && (!sourceIdSet.size || !entry.anchor?.sourceId || sourceIdSet.has(entry.anchor.sourceId)))
        .map(entry => entry.title);
      const invTerms = [];
      const invGists = [];
      for (const item of docInvItems) {
        const hits = (item.places || []).some(place => place.doc === skDoc.key && (
          (place.sourceId && sourceIdSet.has(place.sourceId))
          || (Number.isInteger(place.page) && place.page >= fromPage && place.page <= toPage)
        ));
        if (!hits) continue;
        invTerms.push(item.name, ...nameForms(item.name));
        if (item.gist) invGists.push(item.gist);
      }

      const surface = readSourcesSurface(bySourceId, sourceIds);
      const titleParts = fullCh ? [ch.title] : [ch.title, skDoc.title];
      const allHeadings = [...titleParts, ...subheadings, ...surface.headings];
      surfaces.push({
        id: ch.id,
        title: ch.title,
        doc: skDoc.key,
        pages: ch.pages,
        chars: ch.chars,
        order: surfaces.length,
        chapterNum: titleChapterNum(ch.title),
        fallbackNum: singleMainDoc && skDoc.chapters.length > 1 ? at + 1 : null,
        headingLower: normLower(allHeadings.join(' \n ')),
        headingCompact: compactKey(allHeadings.join(' ')),
        invLower: normLower([...invTerms, ...invGists].join(' \n ')),
        invCompact: compactKey(invTerms.join(' ')),
        contentLower: normLower(surface.text),
        tokenBag: new Set(meaningfulTokens([...allHeadings, ...invTerms].join(' '))),
      });
    }
  }
  return surfaces;
}

/** Deterministic match of a single topic against one chapter surface: { confidence, reason } | null. */
export function matchChapterToTopics(surface, topic) {
  const forms = aliasForms(topic);
  if (!forms.length) return null;
  for (const form of forms) {
    if (formMatchesText(form, surface.headingLower, surface.headingCompact)) {
      return { confidence: 'high', reason: 'heading' };
    }
  }
  if (surface.invLower) {
    for (const form of forms) {
      if (formMatchesText(form, surface.invLower, surface.invCompact)) {
        return { confidence: 'high', reason: 'inventory' };
      }
    }
  }
  if (surface.contentLower) {
    for (const form of forms) {
      if (formMatchesText(form, surface.contentLower, '')) {
        return { confidence: 'medium', reason: 'content' };
      }
    }
  }
  const tokens = meaningfulTokens(forms.join(' '));
  if (tokens.length >= 2 && surface.tokenBag?.size) {
    const overlap = tokens.filter(token => surface.tokenBag.has(token)).length;
    const needed = Math.max(2, Math.ceil(tokens.length * 0.6));
    if (overlap >= needed) return { confidence: 'medium', reason: 'tokens' };
  }
  return null;
}

/** Extract exam scope topics and explicit chapter refs from course focusTopics, scope.note, and guidanceSourceIds. */
export function examScopeTopics(state, course, { scope = null, focusTopics = null, guidanceSourceIds = null, note = null, language = 'zh' } = {}) {
  const record = (state?.courses || []).find(item => item && item.name === course) ?? null;
  const rawFocus = Array.isArray(focusTopics) ? focusTopics : courseFocusTopics(state, course, { includeDescendants: true });
  const rawNote = typeof note === 'string' ? note : (typeof scope?.note === 'string' ? scope.note : '');
  const rawGuidanceIds = Array.isArray(guidanceSourceIds) ? guidanceSourceIds : (Array.isArray(record?.guidanceSourceIds) ? record.guidanceSourceIds : []);
  const byId = new Map((Array.isArray(state?.sources) ? state.sources : []).map(source => [source.id, source]));
  const guidanceSources = rawGuidanceIds.map(id => byId.get(id)).filter(src => src && !src.archived).slice(0, MAX_GUIDANCE_SOURCES);

  const chapterRefsByNum = new Map();
  const addRefs = text => {
    for (const ref of extractChapterRefs(text, language)) {
      if (!chapterRefsByNum.has(ref.num)) chapterRefsByNum.set(ref.num, ref);
    }
  };
  addRefs(rawNote);
  for (const topic of rawFocus) addRefs(topic);
  for (const src of guidanceSources) addRefs(typeof src.text === 'string' ? src.text.slice(0, GUIDANCE_TEXT_CAP) : '');

  const focusCleaned = cleanFocusTopics(rawFocus, { limit: 100 }).filter(topic => !isChapterRefOnly(topic));
  const noteTopics = parseNoteTopics(rawNote);
  const guidanceTopics = parseGuidanceTopics(guidanceSources, { allowShortLines: !focusCleaned.length && !noteTopics.length });
  const topics = cleanFocusTopics([...focusCleaned, ...noteTopics, ...guidanceTopics], { limit: 100 });
  return { topics, chapterRefs: [...chapterRefsByNum.values()] };
}

function formatCoverageNote({ matchedCount, totalChapters, unmatchedCount, topicCount, refCount, language }) {
  const en = language === 'en';
  if (!topicCount && !refCount) {
    return en
      ? 'No exam scope topics or notes are set yet; add focus topics or select chapters manually.'
      : '还没有设置考试范围主题或说明，请先录入重点知识点或手动勾选章节。';
  }
  if (!matchedCount) {
    return en
      ? `No chapters matched automatically (0 of ${totalChapters}); ${unmatchedCount} topic(s) need manual chapter selection.`
      : `未自动匹配到章节（0 / ${totalChapters} 章）；有 ${unmatchedCount} 个主题未匹配，请手动勾选对应章节。`;
  }
  if (unmatchedCount > 0) {
    return en
      ? `Matched ${matchedCount} of ${totalChapters} chapters; ${unmatchedCount} topic(s) did not match any chapter—review and select manually if needed.`
      : `匹配到 ${matchedCount} / ${totalChapters} 章；有 ${unmatchedCount} 个主题未匹配到章节，请核对并手动勾选。`;
  }
  return en
    ? `Matched ${matchedCount} of ${totalChapters} chapters; all exam scope topics were covered.`
    : `匹配到 ${matchedCount} / ${totalChapters} 章，所有考试范围主题均已匹配。`;
}

/**
 * Pure 0-token exam-scope slicer.
 * Matches `course.focusTopics` + exam scope note + `guidanceSourceIds` against material TOC / `courseInventory` / `courseOutline`.
 * Returns `{ basis, matchedChapters, unmatchedTopics, topics, totalChapters, coverageNote }`.
 */
export function sliceExamScope(state, course, options = {}) {
  const language = options.language === 'en' ? 'en' : 'zh';
  const skeleton = options.skeleton ?? courseSkeleton(state, course);
  const record = (state?.courses || []).find(item => item && item.name === course) ?? null;
  const rawGuidanceIds = Array.isArray(options.guidanceSourceIds)
    ? options.guidanceSourceIds
    : (Array.isArray(record?.guidanceSourceIds) ? record.guidanceSourceIds : []);
  const surfaces = buildChapterSurfaces(state, course, skeleton, new Set(rawGuidanceIds));
  const { topics, chapterRefs } = examScopeTopics(state, course, { ...options, language });

  const hitsByChapter = new Map();
  const recordHit = (surface, topicLabel, confidence, reason) => {
    let entry = hitsByChapter.get(surface.id);
    if (!entry) {
      entry = { surface, confidence, matchedTopics: [], reasons: new Set() };
      hitsByChapter.set(surface.id, entry);
    }
    if (confidence === 'high') entry.confidence = 'high';
    if (!entry.matchedTopics.includes(topicLabel)) entry.matchedTopics.push(topicLabel);
    entry.reasons.add(reason);
  };

  const unmatchedTopics = [];
  const addUnmatched = label => {
    if (!unmatchedTopics.includes(label)) unmatchedTopics.push(label);
  };

  // 1. Explicit chapter number references ("Chapter 3", "第 3、5 章").
  for (const ref of chapterRefs) {
    let matched = surfaces.filter(surface => surface.chapterNum === ref.num);
    if (!matched.length) matched = surfaces.filter(surface => surface.fallbackNum === ref.num);
    if (matched.length) {
      for (const surface of matched) recordHit(surface, ref.label, 'high', 'chapter_ref');
    } else {
      addUnmatched(ref.label);
    }
  }

  // 2. Topic / term / heading / alias / inventory matching.
  for (const topic of topics) {
    let anyHit = false;
    for (const surface of surfaces) {
      const hit = matchChapterToTopics(surface, topic);
      if (hit) {
        anyHit = true;
        recordHit(surface, topic, hit.confidence, hit.reason);
      }
    }
    if (!anyHit) addUnmatched(topic);
  }

  const matchedChapters = [...hitsByChapter.values()]
    .sort((a, b) => a.surface.order - b.surface.order)
    .map(({ surface, confidence, matchedTopics, reasons }) => ({
      id: surface.id,
      title: surface.title,
      ...(surface.doc !== undefined ? { doc: surface.doc } : {}),
      ...(surface.pages !== undefined ? { pages: surface.pages } : {}),
      ...(surface.chars !== undefined ? { chars: surface.chars } : {}),
      ...(surface.points !== undefined ? { points: surface.points } : {}),
      confidence,
      matchedTopics,
      reasons: [...reasons],
    }));

  const coverageNote = formatCoverageNote({
    matchedCount: matchedChapters.length,
    totalChapters: surfaces.length,
    unmatchedCount: unmatchedTopics.length,
    topicCount: topics.length,
    refCount: chapterRefs.length,
    language,
  });

  return {
    basis: skeleton.basis,
    matchedChapters,
    unmatchedTopics,
    topics,
    totalChapters: surfaces.length,
    coverageNote,
  };
}
