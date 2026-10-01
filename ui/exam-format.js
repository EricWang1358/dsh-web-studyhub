/* 模拟考试 (WP25): pure helpers for the one-page, three-format exam — which
   format a course opens on, how deck titles are shortened, and the shared
   "recent exams" list of all formats. */

export const EXAM_FORMAT_IDS = Object.freeze(["written", "case", "oral"]);
export const isExamFormat = (value) => EXAM_FORMAT_IDS.includes(value);

/** The format a course's exam profile points at: open-book case courses sit a case paper, everything else a written one. */
export function defaultExamFormat(data, course) {
  if (!course || course === "*") return "written";
  const record = (data?.courses || []).find((item) => item && (item.name === course || item.id === course || item.courseId === course));
  return record?.exam?.format === "open-book-case" ? "case" : "written";
}

const SEPARATORS = /([\s·\-–—:：_/|]+)/;
const STRONG = /[·\-–—:：|/]/;
const trimEdges = (text) => text.replace(/^[\s·\-–—:：_/|]+|[\s·\-–—:：_/|]+$/g, "");

/**
 * Visible deck names: the words every deck starts with, and the course's own
 * name, carry no information inside a course page. Returns { [id]: name };
 * a title is never emptied.
 */
export function shortDeckTitles(decks = [], course = "") {
  const parts = decks.map((deck) => String(deck.title ?? "").split(SEPARATORS));
  let shared = 0;
  if (parts.length > 1) {
    while (parts.every((tokens) => tokens.length > shared + 1 && tokens[shared] === parts[0][shared])) shared += 1;
    // Cut only after a real divider (· - : |), never in the middle of a name like "Final paper 05".
    let cut = 0;
    for (let at = 1; at < shared; at += 2) if (STRONG.test(parts[0][at])) cut = at + 1;
    shared = trimEdges(parts[0].slice(0, cut).join("")).length >= 3 ? cut : 0;
  }
  const result = {};
  decks.forEach((deck, index) => {
    const title = String(deck.title ?? "");
    let rest = trimEdges(shared ? parts[index].slice(shared).join("") : title);
    if (!rest) rest = title;
    if (course && course !== "*" && rest.startsWith(course)) {
      const stripped = trimEdges(rest.slice(course.length));
      if (stripped && /^[\s·\-–—:：_/|]/.test(rest.slice(course.length))) rest = stripped;
    }
    result[deck.id] = rest;
  });
  return result;
}

const stamp = (value) => Date.parse(value) || 0;

/**
 * Written, case and oral exams as one list, newest first:
 * { kind, runId, submittedAt, scorePct?, correct?, total, assessed?, strong?, course, decks }.
 * The course is read from the decks a paper was drawn from (oral runs do not record one).
 */
export function recentExams(data) {
  const courseOf = (titles = []) => {
    for (const title of titles) {
      const deck = (data?.decks || []).find((item) => item.title === title);
      const course = deck?.course ?? deck?.folder;
      if (course) return course;
    }
    return "";
  };
  const done = (data?.exams || []).map((item) => ({
    kind: item.examKinds === "case" ? "case" : "written", runId: item.runId, submittedAt: item.submittedAt, scorePct: item.scorePct,
    correct: item.correct, total: item.total, course: courseOf(item.decks), decks: item.decks || [],
  }));
  const spoken = (data?.oralExams || []).map((item) => ({
    kind: "oral", runId: item.runId, submittedAt: item.submittedAt, total: item.total, assessed: item.assessed, strong: item.strong,
    course: "", decks: [], role: item.role || "",
  }));
  return [...done, ...spoken].sort((a, b) => stamp(b.submittedAt) - stamp(a.submittedAt));
}

export const filterRecent = (items, format) => (format === "all" ? items : items.filter((item) => item.kind === format));
