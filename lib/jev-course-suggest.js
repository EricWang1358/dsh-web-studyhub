import { choice } from './jev.js';
import { createBreaker, mapLimit } from './jev-runtime.js';
import { jevMessage } from './jev-messages.js';
import { courseParent, courseSegments, courseWithin } from './course-tree.js';
import { libraryCourses, sourcesWithCourses } from './source-courses.js';

/* EXPERIMENTAL. 课程归属建议: which course does a source belong to?

   One `choice` question per source over the learner's course names, plus "none of these". The model sees the course names (with
   a few titles already filed under each, and which courses are chapters of which), the source's TITLE and a short EXCERPT: never
   the whole text. The answer is a probability per course. It is a SIGNAL for the existing organizer (ui/Sources.jsx): a course
   is filled in only when its probability reaches the learner's threshold (default 0.8); otherwise the source is left as it is
   for the learner. Nothing here saves anything: the learner still presses the existing apply button, which keeps its
   `expectedCourses` check.

   Containment-aware (lib/course-tree.js): courses nest by name ("Design / 05 Kubernetes" is a chapter of "Design"). The
   probability of a course is the probability of the course plus its chapters, so a source that Jev cannot place between two
   chapters but is sure belongs to "Design" is suggested for "Design", and a different course that merely starts with the same
   letters ("Designing for people") is not part of it. */

export const NONE_KEY = '__none__';
/** Titles of already-filed sources shown to the model as examples of each course. */
export const SAMPLE_TITLES = 3;
/** The service takes 255 options; one is "none of these". */
export const MAX_COURSE_OPTIONS = 254;
export const EXCERPT_CHARS = 1000;
const TITLE_CHARS = 200, SAMPLE_CHARS = 60;

const clip = (text, max) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const round = value => Math.round(value * 1e4) / 1e4;

/** The courses to choose from: the library's course names, the busiest first, at most 254, each with a few titles filed under it. */
export function courseCandidates(state, { max = MAX_COURSE_OPTIONS } = {}) {
  const sources = sourcesWithCourses(state), counts = new Map(), samples = new Map();
  for (const item of sources) for (const course of item.courses) {
    counts.set(course, (counts.get(course) || 0) + 1);
    const list = samples.get(course) || [];
    if (list.length < SAMPLE_TITLES && clip(item.title, 1)) list.push({ id: item.id, title: clip(item.title, SAMPLE_CHARS) });
    samples.set(course, list);
  }
  const names = libraryCourses(state, sources).filter(name => typeof name === 'string' && name.trim());
  return names.map(name => ({ name, count: counts.get(name) || 0, titles: samples.get(name) || [] }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, max);
}

/** The request for one source: { state: { title, excerpt }, questions: { course } }. */
export function buildCourseRequest(source, candidates) {
  const names = candidates.map(item => item.name);
  const criteria = {};
  for (const item of candidates) {
    const parent = courseParent(item.name, names), hasChapters = names.some(other => other !== item.name && courseWithin(item.name, other, names));
    const examples = item.titles.filter(entry => entry.id !== source.id).map(entry => `"${entry.title}"`);
    criteria[item.name] = [`Material of the course "${item.name}"`,
      parent && names.includes(parent) ? ` (a chapter of "${parent}")` : '',
      hasChapters ? ' (a parent course that also has chapters; choose it only when no chapter fits)' : '',
      examples.length ? `, for example: ${examples.join(', ')}` : ''].join('') + '.';
  }
  criteria[NONE_KEY] = 'None of the listed courses clearly fits this material.';
  return { state: { title: clip(source.title, TITLE_CHARS), excerpt: clip(source.text, EXCERPT_CHARS) },
    questions: { course: choice('Which course does this study material (a title and an excerpt) belong to? Pick the most specific course that clearly fits, or the "none" option when no listed course clearly fits.', criteria) } };
}

/**
 * Read an answer. `probabilities`: option -> probability (the service's own). Returns the most specific course whose own probability
 * plus its chapters' reaches `threshold`, as { course, probability, own, viaParent }, or null when none does.
 */
export function pickCourse(probabilities, courses, { threshold = 0.8, known = courses } = {}) {
  const own = name => (typeof probabilities?.[name] === 'number' ? probabilities[name] : 0);
  let best = null;
  for (const course of courses) {
    const mass = round(courses.reduce((sum, other) => sum + (courseWithin(course, other, known) ? own(other) : 0), 0));
    if (mass < threshold) continue;
    const depth = courseSegments(course, known).length;
    if (!best || depth > best.depth || (depth === best.depth && mass > best.probability)) best = { course, depth, probability: mass };
  }
  if (!best) return null;
  const alone = round(own(best.course));
  return { course: best.course, probability: best.probability, own: alone, viaParent: alone < best.probability };
}

const percent = value => Math.round(value * 100);
const REASON = {
  zh: {
    filled: (course, p) => `Jev 判断属于「${course}」（把握 ${percent(p)}%）`,
    parent: (course, p) => `Jev 判断属于「${course}」这门课（把握 ${percent(p)}%，具体章节没有把握）`,
    unsure: (course, p, line) => `Jev 不确定：最可能是「${course}」（${percent(p)}%），低于 ${percent(line)}% 的采用线，留给你决定`,
    none: line => `Jev 认为没有合适的课程（采用线 ${percent(line)}%），留给你决定`,
  },
  en: {
    filled: (course, p) => `Jev suggests “${course}” (${percent(p)}% sure)`,
    parent: (course, p) => `Jev is sure it belongs to the course “${course}” (${percent(p)}%), but not which chapter`,
    unsure: (course, p, line) => `Jev is not sure: the most likely course is “${course}” (${percent(p)}%), below the ${percent(line)}% line, so it is left to you`,
    none: line => `Jev sees no fitting course (line ${percent(line)}%), so it is left to you`,
  },
};

/** One source's proposal, from its answer. Same shape as the existing AI suggestion plus a `jev` block. */
export function proposalFrom(source, probabilities, courses, { threshold, language, known = courses }) {
  const say = REASON[language === 'en' ? 'en' : 'zh'];
  const picked = pickCourse(probabilities, courses, { threshold, known });
  const ranked = courses.map(course => ({ course, p: round(typeof probabilities?.[course] === 'number' ? probabilities[course] : 0) })).filter(item => item.p > 0)
    .sort((a, b) => b.p - a.p || a.course.localeCompare(b.course)).slice(0, 3);
  const none = round(typeof probabilities?.[NONE_KEY] === 'number' ? probabilities[NONE_KEY] : 0);
  const top = ranked[0];
  const filled = !!picked;
  const reason = picked ? (picked.viaParent ? say.parent(picked.course, picked.probability) : say.filled(picked.course, picked.probability))
    : top && top.p > none ? say.unsure(top.course, top.p, threshold) : say.none(threshold);
  return { id: source.id, title: source.title, courses: picked ? [picked.course] : [...source.courses], expectedCourses: [...source.courses], reason,
    jev: { choice: picked?.course ?? null, probability: picked ? picked.probability : top?.p ?? 0, threshold, filled, viaParent: !!picked?.viaParent,
      changed: filled && JSON.stringify([picked.course]) !== JSON.stringify(source.courses), top: ranked, none } };
}

/**
 * Ask Jev about each of `sources` (objects of lib/source-courses.js `sourcesWithCourses`), at most `concurrency` at a time.
 * Resolves { proposals, failed, usage, unavailable? }: `unavailable: { reason, message }` only when nothing could be answered
 * (the gate is closed, a bad key, no courses, ...); a few failures among many answers just count in `failed`. Never throws
 * (except an aborted signal), saves nothing.
 */
export async function suggestCourses({ runtime, state, sources, threshold = 0.8, language = 'zh', signal, concurrency = 4 }) {
  const candidates = courseCandidates(state), courses = candidates.map(item => item.name);
  const usage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  if (!courses.length) return { proposals: [], failed: 0, usage, unavailable: { reason: 'no-courses', message: jevMessage('no-courses', language) } };
  const breaker = createBreaker(), failures = [];
  const results = await mapLimit(sources, concurrency, async source => {
    const request = buildCourseRequest(source, candidates);
    const result = await runtime.run('courseSuggest', request.state, request.questions, { signal, language });
    breaker.note(result);
    if (!result.ok) { failures.push(result); return null; }
    usage.calls++; usage.inputTokens += result.usage.inputTokens; usage.outputTokens += result.usage.outputTokens;
    return proposalFrom(source, result.answers.course.probabilities, courses, { threshold, language });
  }, { stop: () => breaker.open });
  const proposals = results.filter(Boolean);
  const out = { proposals, failed: failures.length, usage };
  if (!proposals.length && failures.length) out.unavailable = { reason: failures[0].reason, message: failures[0].message };
  return out;
}
