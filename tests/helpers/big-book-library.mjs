/* A library of one big converted textbook (深度定制 S2): BOOK_PAGES pages in BOOK_CHAPTERS chapters of equal length, each chapter five topics of ten pages, every page three
   "<Topic> fact <n>: <what>." sentences (what the inventory fake of tests/helpers/course-outline-library.mjs lists, one item each) and some plain text. With the fake
   model of tests/helpers/course-book-model.mjs a topic is one knowledge point. No real model, no network. */

export const BIG_COURSE = 'BIG';
export const BOOK_PAGES = 500;
export const BOOK_CHAPTERS = 10;
export const PAGES_PER_CHAPTER = BOOK_PAGES / BOOK_CHAPTERS;
const SUBJECTS = ['Optics', 'Waves', 'Heat', 'Motion', 'Forces', 'Energy', 'Fields', 'Atoms', 'Light', 'Sound'];
const TOPICS = ['Basics', 'Laws', 'Models', 'Methods', 'Limits'];
const FILLER = 'this page goes on about the topic in more detail with worked notes and a small diagram. ';

/** The chapter (1-based) a page (1-based) is in, its title, and the topic of a page. */
export const chapterOfPage = page => Math.ceil(page / PAGES_PER_CHAPTER);
export const chapterTitle = chapter => `Chapter ${chapter}: ${SUBJECTS[chapter - 1]}`;
export const topicOf = page => `${SUBJECTS[chapterOfPage(page) - 1]} ${TOPICS[Math.floor(((page - 1) % PAGES_PER_CHAPTER) / 10)]}`;

function pageText(page) {
  const topic = topicOf(page), facts = [0, 1, 2].map(k => `${topic} fact ${page * 3 + k}: the rule number ${k} holds on this page and is applied with care.`);
  return `${facts.join(' ')}\n${FILLER.repeat(12)}`;
}

/** -> { sources }: the book's pages, filed under BIG_COURSE. */
export function bigBookLibrary() {
  const sources = [];
  for (let page = 1; page <= BOOK_PAGES; page++) {
    const chapter = chapterOfPage(page);
    sources.push({ id: `big-p${page}`, title: `Big Book · p. ${page}`, text: pageText(page), createdAt: new Date(Date.UTC(2026, 9, 1)).toISOString(), courses: [BIG_COURSE],
      document: { materialId: 'document-big', page, totalPages: BOOK_PAGES, format: 'pdf', origin: 'converted', converter: 'marker', filename: 'Big Book.pdf',
        chapter: { index: chapter - 1, title: chapterTitle(chapter), level: 1 }, extractionVersion: 2 } });
  }
  return { sources };
}

/** The pages (1-based) the ranges of one inventory call hold, from its request data. */
export const callPages = call => call.data.ranges.flatMap(range => {
  const [from, to] = String(range.pages ?? '').split('-').map(Number);
  return Number.isInteger(from) ? Array.from({ length: (to || from) - from + 1 }, (_, at) => from + at) : [];
});
