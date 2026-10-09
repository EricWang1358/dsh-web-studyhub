/* A synthetic library shaped like the owner's real one (134 materials, about 900 questions, six half-day lectures of content), and a fake model that
   organises it the way a plausible model would. Used by the course outline build tests. No real model, no network. */
import { reportUsage } from '../../lib/usage-scope.js';

export const COURSE = 'SA';
const stamp = index => new Date(Date.UTC(2026, 8, 1) + index * 3600e3).toISOString();
export const LECTURES = [
  { n: 1, title: 'Introduction to Solution Architecture', chapters: ['What architects do', 'Stakeholders and concerns', 'Views and viewpoints'] },
  { n: 2, title: 'Requirements and Quality Attributes', chapters: ['Functional requirements', 'Quality attribute scenarios', 'Trade-offs'] },
  { n: 3, title: 'Architecture Patterns', chapters: ['Layers', 'Microservices', 'Event-driven design'] },
  { n: 4, title: 'Integration and APIs', chapters: ['API styles', 'Messaging', 'API gateways'] },
  { n: 5, title: 'Cloud Deployment', chapters: ['Deployment models', 'Containers', 'Scaling'] },
  { n: 6, title: 'Security Architecture', chapters: ['Threat modelling', 'Identity and access', 'Zero trust'] },
];
/** Imported out of order, as a learner does: the syllabus and the numbers say 1..6. */
export const IMPORT_ORDER = [3, 1, 5, 2, 6, 4];
export const ALL_CHAPTERS = LECTURES.flatMap(lecture => lecture.chapters);
export const lectureOf = title => LECTURES.find(lecture => lecture.chapters.includes(title) || lecture.title === title);
export const lectureFile = lecture => `0${lecture.n}. ${lecture.title} v2.1`;
const fact = (topic, i) => `${topic} fact ${i}: the architect records this decision and its reasons in the decision log.`;
const text = (topic, count = 4) => Array.from({ length: count }, (_, i) => fact(topic, i)).join(' ');

/**
 * The library: lectures as converted PDFs with chapters (two pages a chapter), a second import of lecture 1 (same name, same chapters), a diagram copy of
 * lecture 1 (same name, no chapters), 40 one-question notes (four called 补充笔记 · Reintroduction), 10 JSON-imported decks, 12 dated recordings,
 * a 讲义大纲, handouts, and (with `paper`) a sample paper in place of the last handout. 134 materials either way.
 */
export function outlineLibrary({ paper = false, extraHandouts = 0, longNames = false } = {}) {
  const sources = [], decks = [];
  let at = 0, card = 0;
  const cardOf = (topic, sourceId, i) => ({ id: `q${++card}`, kind: 'flashcard', topic, prompt: `What does ${topic} ask of the architect (${card})?`, answer: 'A decision.',
    citations: [{ sourceId, quote: fact(topic, i) }] });
  const deckOf = (id, title, cards) => decks.push({ id, title, course: COURSE, cards });
  const pdf = (lecture, materialId) => lecture.chapters.flatMap((chapter, index) => [1, 2].map(half => {
    const page = index * 2 + half;
    return { id: `${materialId}-p${page}`, title: `${lectureFile(lecture)} · p. ${page}`, text: text(chapter), createdAt: stamp(at), courses: [COURSE],
      document: { materialId, page, totalPages: lecture.chapters.length * 2, format: 'pdf', origin: 'converted', converter: 'marker', filename: `${lectureFile(lecture)}.pdf`,
        chapter: { index, title: chapter, level: 1 }, extractionVersion: 2 } };
  }));
  const md = (id, title, body, extra = {}) => ({ id, title, text: body, createdAt: stamp(at++), courses: [COURSE], document: { materialId: `document-${id}`, format: 'md', filename: `${title}.md` }, ...extra });
  for (const n of IMPORT_ORDER) {
    const lecture = LECTURES[n - 1], pages = pdf(lecture, `document-l${n}`);
    at++; sources.push(...pages);
    // 25 questions a chapter, on its first page.
    deckOf(`deck-l${n}`, `${lecture.title} deck`, lecture.chapters.flatMap((chapter, index) => Array.from({ length: 25 }, (_, i) => cardOf(chapter, `document-l${n}-p${index * 2 + 1}`, i % 4))));
    if (n === 1) {
      at++; sources.push(...pdf(lecture, 'document-l1-again'));
      sources.push(md('l1-diagrams', lectureFile(lecture), text('Diagram view')));
      deckOf('deck-l1-diagrams', 'Diagram deck', [cardOf('Diagram view', 'l1-diagrams', 0)]);
    }
  }
  const notes = [...Array.from({ length: 4 }, () => 'Reintroduction'), ...Array.from({ length: 36 }, (_, i) => ALL_CHAPTERS[i % ALL_CHAPTERS.length])];
  notes.forEach((topic, i) => { sources.push(md(`note-${i + 1}`, `补充笔记 · ${topic}`, text(topic, 1))); deckOf(`deck-note-${i + 1}`, `补充笔记 · ${topic}`, [cardOf(topic, `note-${i + 1}`, 0)]); });
  for (let k = 1; k <= 10; k++) {
    const topic = LECTURES[(k - 1) % 6].chapters[0], id = `json-${k}`;
    sources.push({ id, title: `JSON 导入：SA quiz ${k}`, text: text(topic, 2), createdAt: stamp(at++), courses: [COURSE], document: { materialId: `document-${id}`, format: 'json', filename: `quiz-${k}.json` } });
    deckOf(`deck-json-${k}`, `JSON 导入：SA quiz ${k}`, Array.from({ length: 10 }, (_, i) => cardOf(topic, id, i % 2)));
  }
  for (let k = 1; k <= 12; k++) {
    const day = String(k + 1).padStart(2, '0'), topic = LECTURES[Math.floor((k - 1) / 2)].chapters[1], id = `audio-${String(k).padStart(16, 'a')}-0`;
    sources.push({ id, title: `SA lecture 2026-09-${day}.mp3`, text: text(topic), createdAt: stamp(at++), courses: [COURSE], audio: { hash: String(k).padStart(64, 'a'), filename: `SA lecture 2026-09-${day}.mp3` } });
    deckOf(`deck-audio-${k}`, `Recording ${k}`, Array.from({ length: 10 }, (_, i) => cardOf(topic, id, i % 4)));
  }
  sources.push(md('syllabus', 'SA 讲义大纲', LECTURES.map(lecture => `第 ${lecture.n} 讲 ${lecture.title}：${lecture.chapters.join('、')}`).join('\n')));
  const handouts = (paper ? 62 : 63) + extraHandouts;
  for (let k = 1; k <= handouts; k++) {
    const topic = ALL_CHAPTERS[k % ALL_CHAPTERS.length], id = `handout-${k}`;
    sources.push(md(id, `Handout ${k}: ${topic}${longNames ? ` — ${'a longer note on the reading list and what the tutor said about it in class '.repeat(2)}` : ''}`, text(topic)));
    deckOf(`deck-handout-${k}`, `Handout ${k}`, Array.from({ length: 3 }, (_, i) => cardOf(topic, id, i)));
  }
  if (paper) sources.push(md('paper-2025', 'SA 2025 样卷', PAPER_TEXT));
  return { sources, decks };
}

export const PAPER_TEXT = ['Q1 Explain the difference between a view and a viewpoint, with an example. (10 marks)',
  'Q2 Write a quality attribute scenario for availability. (10 marks)', 'Q3 Compare an API gateway with a message broker. (10 marks)',
  'Q4 Describe a question that no lecture covers at all. (5 marks)'].join('\n');
const PAPER_POINTS = { Q1: 'Views and viewpoints', Q2: 'Quality attribute scenarios', Q3: 'API gateways' };

const requestData = prompt => JSON.parse(prompt.slice(prompt.indexOf('REQUEST DATA:\n') + 'REQUEST DATA:\n'.length).split('\n\nYour previous reply')[0]);
/** What a material is about, as a model would read it from its name. */
function topicOf(material) {
  const name = material.title;
  const note = /^补充笔记 · (.+)$/.exec(name)?.[1];
  if (note) return note === 'Reintroduction' ? 'What architects do' : note;
  const quiz = /^JSON 导入：SA quiz (\d+)$/.exec(name)?.[1];
  if (quiz) return LECTURES[(Number(quiz) - 1) % 6].chapters[0];
  const day = /2026-09-(\d\d)/.exec(name)?.[1];
  if (day) return LECTURES[Math.floor((Number(day) - 2) / 2)].chapters[1];
  const handout = /^Handout \d+: (.+?)(?: — .*)?$/.exec(name)?.[1];
  if (handout) return handout;
  if (/大纲/.test(name)) return 'Course overview';
  if (/样卷/.test(name)) return 'Exam review';
  return LECTURES.find(lecture => name.includes(lecture.title))?.chapters[0] ?? name;
}

/** Map: a point per chapter title (the lecture's chapters, and every small item about that chapter); a chapterless copy of a lecture joins its first chapter. */
function mapAnswer(data) {
  const points = new Map(), add = (title, id) => { if (!points.has(title)) points.set(title, { title, intro: `About ${title}.`, ids: [] }); points.get(title).ids.push(id); };
  for (const material of data.materials) {
    if (material.chapters) for (const chapter of material.chapters) add(chapter.title, chapter.id);
    else add(topicOf(material), material.id);
  }
  return { points: [...points.values()] };
}

/** Reduce: a chapter per lecture in the syllabus's order, in two sections; the overview first, the exam review last; points of the same title merged. */
function reduceAnswer(data, { drop = [] } = {}) {
  const byTitle = new Map();
  for (const point of data.points) { if (drop.includes(point.title)) continue; if (!byTitle.has(point.title)) byTitle.set(point.title, []); byTitle.get(point.title).push(point.id); }
  const leaf = title => byTitle.get(title)?.length > 1 ? byTitle.get(title) : byTitle.get(title)?.[0];
  const order = (data.syllabus ? [...data.syllabus.matchAll(/第 (\d) 讲/g)].map(match => Number(match[1])) : IMPORT_ORDER);
  const chapters = [{ title: 'Course overview', intro: 'What the course covers and how it is assessed.', points: [leaf('Course overview')].filter(Boolean) }];
  for (const n of order) {
    const lecture = LECTURES[n - 1];
    chapters.push({ title: lecture.title, intro: `Lecture ${n}: ${lecture.chapters.join(', ')}.`, sections: [
      { title: 'Foundations', intro: 'The ideas first.', points: lecture.chapters.slice(0, 2).map(leaf).filter(Boolean) },
      { title: 'In practice', intro: 'Then how they are used.', points: lecture.chapters.slice(2).map(leaf).filter(Boolean) }] });
  }
  chapters.push({ title: 'Exam review', intro: 'Past papers.', points: [leaf('Exam review'), 'p999'].filter(Boolean) });
  return { basis: ['syllabus', 'numbering', 'dates', 'magic'], chapters };
}

function paperAnswer(data) {
  const id = title => data.points.find(point => point.title === title)?.id;
  const questions = data.paper[0].text.split('\n').map(line => /^(Q\d) (.+?) \(/.exec(line)).filter(Boolean)
    .map(([, label, body]) => ({ label, quote: body.slice(0, 60), points: PAPER_POINTS[label] ? [id(PAPER_POINTS[label])] : [] }));
  questions.push({ label: 'Q9', quote: 'A question that is not in this paper at all, invented.', points: [id('Layers')] });
  return { questions };
}

/** The fake model. `junk(call, calls)`: answer with text that is not JSON; `fail(call, calls)`: throw; `held`: { at, gate } holds that call; `drop`: point titles the reduce leaves out. */
export function outlineModel({ junk, fail, held, drop } = {}) {
  const calls = [];
  const complete = async (system, prompt, request) => {
    const data = requestData(prompt), call = { stage: data.stage, data, request, system, prompt };
    calls.push(call);
    reportUsage({ uncachedInputTokens: 100, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0 });
    if (held && calls.length === held.at) await held.gate.promise;
    if (fail?.(call, calls)) throw new Error('provider down');
    if (junk?.(call, calls)) return 'Sure! Here is the outline you asked for (not JSON).';
    if (data.stage === 'map') return JSON.stringify(mapAnswer(data));
    if (data.stage === 'reduce') return `\`\`\`json\n${JSON.stringify(reduceAnswer(data, { drop }))}\n\`\`\``;
    if (data.stage === 'paper') return JSON.stringify(paperAnswer(data));
    return '{}';
  };
  return { calls, complete, of: stage => calls.filter(call => call.stage === stage) };
}
