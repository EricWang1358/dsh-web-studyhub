/* Two seeded libraries for looking at the review book (复习全书) in the real page; the browser tests and scripts/qa/book-shots.mjs use them.
   - 'archss': one course (ArchSS), sixteen knowledge points over four chapters; every point has generated notes in the real shape (考情 on some, the takeaway
     as the first sentence of 讲解, 2-4 paragraphs with 角标, 例子, 要点清单, 补充（资料以外）, 出处) and in the learner's file ONE whole-point AI block (mode 'here',
     state 'new') of 3,000-6,000 characters in the template 「这段在讲什么 / 1. 小标题 / 原文说 / 意思就是 / 资料原文 / 补充（资料以外）」; a few points also carry one short
     explain block on words of their 讲解, two a note of the learner's own. No questions. The exam is five days after today.
   - 'questions': the same book, and most points have 10-25 questions (two have a Q&A put into the book); the plan has 翻看 days.
   Seeded into a temporary library through the service (no model, no network). `today` is the day the page itself reads (localDate). */
import { mkdir } from 'node:fs/promises';
import { StudyService } from '../../lib/service.js';
import { courseOutlineMaterial, materialsFingerprint } from '../../lib/course-outline-book.js';
import { courseNotesMaterial } from '../../lib/course-book.js';
import { buildOutlineIndex } from '../../lib/course-outline-index.js';
import { groupSourcesByDocument } from '../../lib/source-groups.js';
import { openCourseBook } from '../../lib/course-book-files.js';
import { aiBlock, anchorIn } from '../../lib/course-book-ai-text.js';
import { localDate } from '../../lib/board-model.js';
import { addDays } from '../../lib/crunch-plan.js';
import { CHAPTERS, POINTS, bodyOf, examOf } from './book-topics.mjs';

export const BOOK_COURSE = 'ArchSS';
export const BOOK_FIXTURES = ['archss', 'questions'];
/** Days from today to the exam in both fixtures. */
export const EXAM_IN_DAYS = 5;

const stamp = index => new Date(Date.UTC(2026, 8, 1) + index * 3600e3).toISOString();
const lectureId = chapter => `document-l${chapter + 1}`;
const pageId = (chapter, page) => `${lectureId(chapter)}-p${page}`;
/** The chapter of the lecture a point stands on (its two pages). */
const chapterOf = point => point.section * 2 + point.index;

/** The pages of the four lectures: converted PDFs with four chapters of two pages, one lecture a chapter of the book. */
function lecturePages() {
  const pages = [];
  CHAPTERS.forEach(([title], chapter) => {
    POINTS.filter(point => point.chapter === chapter).forEach(point => {
      const first = chapterOf(point) * 2 + 1;
      for (const half of [0, 1]) {
        const page = first + half;
        pages.push({ id: pageId(chapter, page), title: `第 ${chapter + 1} 讲 ${title} · p. ${page}`, createdAt: stamp(chapter * 8 + page), courses: [BOOK_COURSE],
          text: `${point.quote}。${point.term}是${point.defines}。${point.why}。${half ? point.how : point.check}。`,
          document: { materialId: lectureId(chapter), page, totalPages: 8, format: 'pdf', origin: 'converted', converter: 'marker', filename: `第 ${chapter + 1} 讲 ${title}.pdf`,
            chapter: { index: chapterOf(point), title: point.title, level: 1 }, extractionVersion: 2 } });
      }
    });
  });
  return pages;
}

/** Questions of a point: none in 'archss'; in 'questions' 10-25 on most points (three have none), citing the first page of the point's chapter. */
export const questionCount = (point, at) => ([4, 9, 14].includes(at) ? 0 : 10 + ((at * 7) % 16));
function decksOf(pages) {
  const decks = new Map();
  POINTS.forEach((point, at) => {
    const first = pages.find(page => page.id === pageId(point.chapter, chapterOf(point) * 2 + 1));
    for (let n = 0; n < questionCount(point, at); n += 1) {
      const id = `q-${point.id}-${n + 1}`;
      if (!decks.has(point.chapter)) decks.set(point.chapter, { id: `deck-l${point.chapter + 1}`, title: `${CHAPTERS[point.chapter][0]} 练习`, course: BOOK_COURSE, cards: [] });
      decks.get(point.chapter).cards.push({ id, kind: 'flashcard', topic: point.title, prompt: `关于${point.term}（第 ${n + 1} 问）：${n % 2 ? point.check : `${point.term}是什么？`}`,
        answer: `${point.defines}。`, citations: [{ sourceId: first.id, quote: first.text.slice(0, 40) }] });
    }
  });
  return [...decks.values()];
}

/** The 3,000-6,000 characters of a whole-point block, the way a bulk 「这段在讲什么」 request writes it. */
export function wholeBody(point, at) {
  const target = 3200 + (at % 5) * 400, facts = [point.defines, point.why, point.how, point.mistake, point.check, point.example, point.link, point.extra];
  const lines = ['这段在讲什么', '', `本节讲${point.term}：${point.defines}。下面按资料的顺序，把每一条「原文说」翻成「意思就是」，再补上资料以外的做法。`, ''];
  // Sections are added until the block is as long as this point's target (3,200-4,800 characters), never past 6,000.
  for (let n = 1; lines.join('\n').length < target; n += 1) {
    const a = facts[n % facts.length], b = facts[(n + 3) % facts.length], c = facts[(n + 5) % facts.length], d = facts[(n + 1) % facts.length], e = facts[(n + 6) % facts.length];
    lines.push(`### ${n}. ${['先要弄清的概念', '为什么要这样做', '具体怎么落地', '最容易错的地方', '怎么自查', '一个例子', '和前后知识点的关系', '资料没说的补充'][n % 8]}`, '',
      `原文说：${a}。${b}。`, '', `意思就是：${a}，换成平常的话，就是${b}。落到你自己的项目里，先看${c}，再回头核对上面的${n % 2 ? '定义' : '做法'}有没有漏掉。如果只记一句，就记「${point.term}要能被检验」。`, '', `换个角度看：${d}。再看一遍：${e}。`, '',
      `资料原文：「${point.quote}」`, '');
  }
  lines.push('补充（资料以外）：', '', `- ${point.extra}`, `- 复习时先回到${point.term}的定义，再自己举一个例子，比反复读这一段更有效。`);
  return lines.join('\n');
}

const SHORT = ['这句话的意思是：先按这条做法走，遇到例外再回头改。', '换句话说，这里的重点不在名词，而在后面的判断标准。', '可以这样记：先问目的，再选手段，最后看代价。', '这条在样卷里问过，答题时要写出理由，不能只写结论。'];

/** The learner's file of a point: a note on some, a short explain block on words of the 讲解 on a few, and the whole-point block (state new). */
export function mineOf(point, at, body) {
  const parts = [];
  if (at === 2 || at === 6) parts.push(`我的笔记：${point.term}考试里常和「${point.check.replace(/？.*$/, '')}」连着问。`);
  if ([1, 4, 8, 12].includes(at)) {
    const words = point.how.slice(0, 12), anchor = anchorIn(body.explain, words);
    parts.push(aiBlock({ id: `w${at}`, at: anchor?.hash ?? 'none', about: words, body: SHORT[at % SHORT.length], mode: 'explain', state: at === 1 ? 'kept' : 'new' }, 'zh'));
  }
  parts.push(aiBlock({ id: `h${at}`, at: 'h:any', about: point.title, body: wholeBody(point, at), mode: 'here', state: 'new' }, 'zh'));
  return parts.join('\n\n');
}

/** Seed `root` (a new library folder) with a fixture of BOOK_FIXTURES; -> { course, points: [{ id, title }], exam }. */
export async function seedBookFixture(root, kind = 'archss') {
  if (!BOOK_FIXTURES.includes(kind)) throw new Error(`Unknown book fixture: ${kind}`);
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  const pages = lecturePages(), decks = kind === 'questions' ? decksOf(pages) : [], today = localDate(), exam = addDays(today, EXAM_IN_DAYS);
  await service.store.update(state => {
    state.sources.push(...pages);
    state.decks.push(...decks);
    state.focus = { mode: 'class', course: BOOK_COURSE, role: '', jd: '', targetTopics: [] };
    const lecture = chapter => groupSourcesByDocument(state.sources).find(item => item.sourceIds.includes(pageId(chapter, 1))).key;
    const leaf = point => ({ id: point.id, title: point.title, anchors: [`${lecture(point.chapter)}#${chapterOf(point)}`] });
    const nodes = CHAPTERS.map(([title, sections], chapter) => ({ id: `ch${chapter + 1}`, title, children: sections.map(([name, points], section) => ({ id: `ch${chapter + 1}-s${section + 1}`, title: name,
      children: points.map(point => leaf(POINTS.find(item => item.id === point.id))) })) }));
    const outline = { ...courseOutlineMaterial({ title: '总纲 · ArchSS', course: BOOK_COURSE, orderBasis: { codes: ['numbering'] },
      fingerprint: materialsFingerprint(buildOutlineIndex(state, { course: BOOK_COURSE }).allDocuments), nodes, other: { anchors: [] },
      counts: { units: POINTS.length, leftover: 0, invalid: 0, repeated: 0 } }), createdAt: '2026-10-09T00:00:00.000Z' };
    state.sources.push(outline);
    const bodies = POINTS.map((point, at) => bodyOf(point, at, pages.filter(page => page.id === pageId(point.chapter, chapterOf(point) * 2 + 1) || page.id === pageId(point.chapter, chapterOf(point) * 2 + 2))));
    state.sources.push({ ...courseNotesMaterial({ title: '复习全书 · ArchSS', course: BOOK_COURSE, outlineId: outline.id, language: 'zh', papers: [], counts: {},
      leaves: POINTS.map((point, at) => ({ ...leaf(point), body: bodies[at], ...(examOf(point, at) ? { exam: examOf(point, at) } : {}) })) }), createdAt: '2026-10-09T01:00:00.000Z' });
    openCourseBook(state, {});
    const record = state.sources.find(source => source.provenance === 'course-book-doc');
    POINTS.forEach((point, at) => { record.bookDoc.files[`${point.id}.mine.md`].text = mineOf(point, at, bodies[at]); });
    if (kind === 'questions') {
      // Two points have a Q&A put into the book.
      POINTS.slice(0, 2).forEach(point => {
        const card = decks.flatMap(deck => deck.cards).find(item => item.id === `q-${point.id}-1`), deck = decks.find(item => item.cards.includes(card));
        record.bookDoc.files[`${point.id}.qa.md`] = { version: 1, text: `- [练习：${card.prompt}](studyhub://card/${deck.id}/${card.id})\n\n<!-- sh:qa card=${card.id} fid=f-${point.id} -->\n> **追问：** ${point.term}和相邻的知识点怎么区分？\n>\n> **答：** ${point.link}\n<!-- /sh:qa -->` };
      });
    }
  });
  await service.call('course.save', { name: BOOK_COURSE, exam: { date: exam } });
  await service.dispose();
  return { course: BOOK_COURSE, points: POINTS.map(point => ({ id: point.id, title: point.title })), exam };
}
