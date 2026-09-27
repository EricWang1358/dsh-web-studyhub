import { findCard } from "./prereq.js";

const sensitive = /\b(?:PPT|slide|NUS|ISS)\b|课件|讲义|本课程|课堂录音|(?:[A-Za-z]:\\|\/Users\/|\/home\/)[^\s)]+|\.pdf\b/i;

export function blogGenerationInput(state, note) {
  return note.cards.map((ref) => {
    const { card } = findCard(state, ref);
    const latest = [...state.attempts].reverse().find((item) =>
      item.quiz_id === card.id && !item.retry);
    return { topic: card.topic, objective: card.objective, question: card.prompt,
      answer: card.answer, explanation: card.explanation, misconception: card.misconception,
      latestResult: latest?.grade < 3 ? "需要巩固" : latest ? "已练习" : "未练习" };
  });
}

export const blogGenerationSystem = `Write a Chinese public learning note in Markdown from the supplied study cards. Turn every question into a generic, original scenario and explain the shared knowledge point, the common misconception and a worked example. Group related cards into one coherent article; if there is one card, write one focused article. Preserve mathematical notation in LaTeX. Do not copy question wording. Do not mention slides, PPT, lectures, source filenames, page numbers, schools, courses, teachers, people, private paths, or any personal information. Do not include invented citations or private source links. Do not claim a learner mastered a topic just because a note was written. Return Markdown only. The user will review before public posting.`;

export function checkedBlogMarkdown(value) {
  const markdown = String(value || "").trim().replace(/^```(?:markdown|md)?\s*\n/i, "")
    .replace(/\n```\s*$/, "");
  if (markdown.length < 100 || markdown.length > 100000) throw new Error("笔记内容长度不合适，请重试或手动编辑");
  if (sensitive.test(markdown)) throw new Error("草稿含资料或身份线索，请手动编写公开版后再发布");
  return markdown;
}
