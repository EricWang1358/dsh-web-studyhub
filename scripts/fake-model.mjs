/* Deterministic stand-in for the study model: preview (STUDY_FAKE_MODEL=1),
   QA journeys and tests. It answers each prompt family of the plugin with
   output that passes the same validation as a real model's, built from the
   request so the real pipelines (generation, review, assist, oral mock,
   translation, workflow teaching, coach) run end to end. No network.

   Add a prompt family by adding one entry to HANDLERS: { name, match, reply }. */
import { norm } from "../lib/domain.js";
import { parseJson } from "../lib/generation.js";

/** The route a preview reports for this model. */
export const FAKE_MODEL_ROUTE = Object.freeze({ provider: "preview", model: "fake-model" });

const wait = (ms, signal) => new Promise((resolve, reject) => {
  if (!ms) return resolve();
  signal?.throwIfAborted();
  const timer = setTimeout(() => { signal?.removeEventListener("abort", stop); resolve(); }, ms);
  const stop = () => { clearTimeout(timer); reject(signal.reason); };
  signal?.addEventListener("abort", stop, { once: true });
});
/** JSON of the whole prompt, or the first JSON value inside it (prompts with appended notes). */
function data(text) {
  try { return JSON.parse(text); } catch { /* fall through */ }
  try { const value = parseJson(text); return value && typeof value === "object" ? value : {}; } catch { return {}; }
}
const after = (text, marker) => {
  const at = text.indexOf(marker);
  return at < 0 ? {} : data(text.slice(at + marker.length));
};
const clip = (value, n) => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > n ? text.slice(0, n) + "…" : text;
};
const CJK = /[㐀-鿿]/;
const englishSession = (system) => /Application language preference: English/.test(system);
const englishContent = (language, sample) => /english|^en\b/i.test(String(language || "")) ||
  (!language && !CJK.test(String(sample || "")));

/* ---------- source evidence ---------- */

function sentences(text) {
  return String(text ?? "").split(/(?<=[。！？.!?\n])/).map((s) => s.trim()).filter((s) => s.length >= 16 && s.length <= 160);
}
/** A verbatim passage of at least 12 characters; `index` rotates through the sentences. */
function quoteFor(source, index) {
  const list = sentences(source?.text);
  if (list.length) return list[index % list.length].slice(0, 90);
  const text = String(source?.text ?? "").trim();
  const start = Math.max(0, Math.min((index * 97) % Math.max(1, text.length - 60), text.length - 60));
  return text.slice(start, start + 60);
}
const topicOf = (source, english) => clip(String(source?.title || "").replace(/\.(md|pdf|txt)$/i, ""), 40) || (english ? "Key idea" : "要点");

/* ---------- generation: plan, author, review, repair ---------- */

function planTargets(request, nextNumber) {
  const sources = Array.isArray(request.sources) && request.sources.length ? request.sources : [];
  const covered = new Set((request.existing || []).map(norm));
  return {
    targets: Array.from({ length: Number(request.count) || 0 }, (_, index) => {
      const source = sources[index % sources.length];
      let n, quote, objective;
      // Skip any target an earlier generation (or an earlier preview run) already used.
      do {
        n = nextNumber();
        quote = quoteFor(source, n - 1);
        objective = englishContent(request.language, quote)
          ? `Target #${n}: explain what “${clip(quote, 40)}” establishes and tell it apart from a near miss`
          : `目标 #${n}：说清「${clip(quote, 24)}」成立的机制，并与相近说法区分`;
      } while (covered.has(norm(objective)));
      covered.add(norm(objective));
      return {
        objective, answerBoundary: "Only the selected evidence", comparisonAxis: "Role and conditions of the idea",
        misconception: "Confusing the idea with a neighbouring one", contextNeeded: "The named idea and its conditions",
        answerability: { mode: "recall", requiredContextAvailable: true, answerOnlyInSourceList: false, criteriaWouldRevealAnswer: false },
        citations: [{ sourceId: source.id, quote }],
      };
    }),
  };
}

const COPY = {
  zh: {
    hint: "先想清楚这句话要解决什么问题，再排除只描述表面现象的说法。",
    misconception: "把相邻概念的职责混为一谈，只记名称不记成立条件。",
    explanation: (topic, quote) => `结论先行：这句话说明了「${topic}」中的一个机制——「${clip(quote, 48)}」。判断时先问“它解决什么问题”，再问“在什么条件下成立”；只记住名称而不理解条件是常见误区。可复用的规则：先找条件，再推结论。（预览用的模拟模型输出）`,
    quiz: (n, topic, quote) => `（第 ${n} 题）关于「${topic}」，哪一项最准确地概括了这句话：「${clip(quote, 36)}」？`,
    multi: (n, topic, quote) => `（第 ${n} 题，多选）关于「${topic}」，哪些说法符合这句话：「${clip(quote, 36)}」？`,
    options: ["它概括了这条要点的作用和成立条件", "它点出了这条要点要解决的问题", "它描述的是另一个相邻概念的职责", "它与这门课讨论的内容没有关系"],
    wrongSecond: "它只是给这条要点换了一个名字",
    right: "正确：这句话直接说明了这一点。", wrong: "错误：这是常见的混淆，与原句的意思不符。",
    flashcard: (n, topic, quote) => `（第 ${n} 题）用自己的话解释：「${clip(quote, 30)}」说明了「${topic}」的什么机制？`,
    open: (n, topic, quote) => `（第 ${n} 题）结合一个例子，说明「${clip(quote, 30)}」在「${topic}」中为什么重要。`,
    openAnswer: (quote) => `参考答案：${quote}`,
    rubric: "说出作用 1 分；说出成立条件 1 分；举出恰当例子 1 分。",
    title: (topic) => `${topic} · 预览题组`,
  },
  en: {
    hint: "First ask what problem the statement solves, then rule out answers that only describe the surface.",
    misconception: "Mixing the idea up with a neighbouring one, remembering the name but not its conditions.",
    explanation: (topic, quote) => `Conclusion first: the statement explains a mechanism of ${topic} — “${clip(quote, 60)}”. Ask what problem it solves, then under which conditions it holds; remembering only the name is the usual mistake. Reusable rule: find the conditions, then derive the result. (Preview fake model output.)`,
    quiz: (n, topic, quote) => `(Q${n}) About ${topic}, which option best summarizes this statement: “${clip(quote, 60)}”?`,
    multi: (n, topic, quote) => `(Q${n}, select all) About ${topic}, which options agree with this statement: “${clip(quote, 60)}”?`,
    options: ["It states the role of the idea and when it holds", "It names the problem the idea is meant to solve", "It describes the job of a neighbouring concept", "It is unrelated to what this course discusses"],
    wrongSecond: "It merely gives the idea another name",
    right: "Correct: the statement says exactly this.", wrong: "Incorrect: a common confusion that does not match the statement.",
    flashcard: (n, topic, quote) => `(Q${n}) In your own words, which mechanism of ${topic} does “${clip(quote, 50)}” describe?`,
    open: (n, topic, quote) => `(Q${n}) Using an example, explain why “${clip(quote, 50)}” matters for ${topic}.`,
    openAnswer: (quote) => `Reference answer: ${quote}`,
    rubric: "1 point for the role; 1 point for the condition; 1 point for a fitting example.",
    title: (topic) => `${topic} · preview deck`,
  },
};

/** A blank inside the quote: three CJK characters, or a whole English word. */
function clozeBlank(quote, n, english, avoid) {
  const candidates = [];
  if (english) {
    const words = [...quote.matchAll(/\b[A-Za-z]{5,}\b/g)].slice(0, -1);
    for (const match of words)
      if (!avoid.some((text) => text.toLowerCase().includes(match[0].toLowerCase()))) candidates.push({ at: match.index, value: match[0] });
  } else {
    for (let at = 2; at + 3 <= quote.length - 2; at++) {
      const value = quote.slice(at, at + 3);
      if (/^[㐀-鿿]{3}$/.test(value)) candidates.push({ at, value });
    }
  }
  if (!candidates.length) return null;
  return candidates[n % candidates.length];
}

function authorDeck(request) {
  const targets = request.assessmentPlan?.targets || [];
  const kind = request.kind || "quiz";
  const sources = request.sources || [];
  const cards = Array.from({ length: Number(request.count) || 0 }, (_, index) => {
    const target = targets[index] || targets[index % Math.max(1, targets.length)];
    const citation = target?.citations?.[0] || { sourceId: sources[0]?.id, quote: quoteFor(sources[0], index) };
    const quote = citation.quote;
    const n = Number((String(target?.objective || "").match(/#(\d+)/) || [])[1]) || index + 1;
    const english = englishContent(request.language, quote);
    const copy = COPY[english ? "en" : "zh"];
    const topic = topicOf(sources.find((source) => source.id === citation.sourceId), english);
    const common = { id: `q${index + 1}`, kind, topic, objective: target?.objective || `#${n}`, hint: copy.hint,
      explanation: copy.explanation(topic, quote), misconception: copy.misconception, citations: [{ sourceId: citation.sourceId, quote }] };
    if (kind === "flashcard") return { ...common, prompt: copy.flashcard(n, topic, quote), answer: quote };
    if (kind === "open") return { ...common, prompt: copy.open(n, topic, quote), answer: copy.openAnswer(quote), rubric: copy.rubric };
    if (kind === "cloze") {
      const blank = clozeBlank(quote, n, english, [copy.hint, topic]);
      if (blank) {
        const text = quote.slice(0, blank.at) + "{{b1}}" + quote.slice(blank.at + blank.value.length);
        return { ...common, prompt: text, answer: blank.value, cloze: { text, answers: [{ id: "b1", value: blank.value, accept: [] }] } };
      }
    }
    // quiz and multi: four options, the correct ones rotated so the answer is not always A.
    const multi = kind === "multi";
    const texts = [copy.options[0], multi ? copy.options[1] : copy.wrongSecond, copy.options[2], copy.options[3]];
    const shift = n % texts.length;
    const options = texts.map((text, at) => ({ text, correct: at === 0 || (multi && at === 1) }))
      .map((_, at, list) => list[(at + shift) % list.length])
      .map((option, at) => ({ id: "abcd"[at], ...option, explanation: option.correct ? copy.right : copy.wrong }));
    const correct = options.filter((option) => option.correct);
    return { ...common, kind: kind === "cloze" ? "quiz" : kind, prompt: (multi ? copy.multi : copy.quiz)(n, topic, quote),
      answer: correct.map((option) => option.text).join(english ? "; " : "；"), options };
  });
  const first = sources[0];
  const english = englishContent(request.language, first?.text);
  return { deck: { title: COPY[english ? "en" : "zh"].title(topicOf(first, english)), cards }, changes: [], checks: [] };
}

function editorReview(candidate) {
  return { issues: [], summary: "Preview fixture review", checks: (candidate?.cards || []).map((card) => ({
    cardId: card.id, selfContained: "pass", answerLeak: "pass",
    optionQuality: ["quiz", "multi"].includes(card.kind) ? "pass" : "na",
    learningValue: "pass", sourceSupport: "pass", explanationQuality: "pass",
    explanation: "Preview fixture accepted this card; no real model judgment was made.",
  })) };
}

/* ---------- handlers, first match wins ---------- */

const HANDLERS = [
  { name: "generation.plan", slow: true, match: (s) => s.startsWith("Plan a source-grounded assessment"),
    reply: ({ prompt, nextNumber }) => planTargets(after(prompt, "REQUEST DATA:\n"), nextNumber) },
  { name: "generation.author", slow: true, match: (s) => s.startsWith("You author rigorous study material"),
    reply: ({ prompt }) => authorDeck(after(prompt, "REQUEST DATA:\n")) },
  { name: "generation.review", slow: true, match: (s) => s.startsWith("Act as a strict assessment editor"),
    reply: ({ input }) => editorReview(input.candidate) },
  { name: "generation.repair", match: (s) => s.startsWith("Repair one draft card"),
    reply: ({ input }) => {
      const source = (input.sources || [])[0];
      const quote = source ? quoteFor(source, 0) : null;
      return { card: { ...input.card, explanation: `${input.card?.explanation || ""}（预览修复：补充了判断依据。）`,
        ...(quote ? { citations: [{ sourceId: source.id, quote }] } : {}) } };
    } },
  { name: "capture.card", match: (s) => s.startsWith("You write one rigorous study card"),
    reply: ({ prompt, nextNumber }) => {
      const kind = (prompt.match(/as an? (\w+) card/) || [])[1] || "flashcard";
      const input = after(prompt, "\nDATA:\n");
      const source = (input.sources || []).find((item) => sentences(item.text).length);
      const n = nextNumber(), question = clip(input.question, 80);
      const note = `预览补充笔记（模拟模型）：关于「${question}」，先说明它要解决的问题，再说明成立条件，最后用一个例子检验。`;
      const quote = source ? quoteFor(source, n) : note.slice(0, 40);
      const card = { kind, topic: "预览", objective: `录题 #${n}：${question}`, prompt: `（录题 ${n}）${question}`,
        answer: `参考答案：${clip(quote, 60)}`, hint: COPY.zh.hint, explanation: COPY.zh.explanation("预览", quote),
        misconception: COPY.zh.misconception, citations: [{ sourceId: source ? source.id : "NOTE", quote }],
        ...(kind === "quiz" || kind === "multi" ? { options: COPY.zh.options.map((text, at) => ({ id: "abcd"[at], text,
          correct: at === 0 || (kind === "multi" && at === 1), explanation: at === 0 || (kind === "multi" && at === 1) ? COPY.zh.right : COPY.zh.wrong })) } : {}),
        ...(kind === "open" ? { rubric: COPY.zh.rubric } : {}) };
      return source ? { grounded: true, card } : { grounded: false, note, card };
    } },
  { name: "ingest.parse", match: (s) => s.startsWith("You convert a learner's pasted study questions"),
    reply: ({ prompt }) => {
      const pasted = String(after(prompt, "\nDATA:\n").pasted || "");
      const lines = pasted.split(/\n+/).map((line) => line.trim()).filter((line) => line.length >= 12).slice(0, 10);
      return { items: lines.map((line, index) => ({ kind: "flashcard", topic: "预览录题", objective: `录入的第 ${index + 1} 题：${clip(line, 40)}`,
        prompt: line, answer: "（预览）参考答案需要你核对原题的答案。", answerFrom: "inferred", hint: COPY.zh.hint,
        explanation: "预览用的模拟模型没有真正解题，请核对原题给出的答案。", misconception: COPY.zh.misconception,
        quotes: [line], learner: { selected: [], wrong: null } })), ignored: [] };
    } },
  { name: "assist", match: (s) => s.startsWith("You are a background study assistant."),
    reply: ({ input, english }) => {
      const card = input.card || {}, question = input.request?.question || "";
      if (input.mode === "improve") return english
        ? { patch: { explanation: `${card.explanation}\n\n(Preview rewrite: added a reusable rule — ask what problem it solves, then when it holds.)` },
          reason: "Preview rewrite: added a decision rule at the end of the explanation." }
        : { patch: { explanation: `${card.explanation}\n\n（预览改写：补充了一条可复用的判断规则——先问它解决什么问题，再问成立条件。）` },
          reason: "预览改写：在解析末尾补充了一条判断规则。" };
      return { answer: english
        ? `**Preview answer (fake model, no real model was called)**\n\n${question ? `Your question: ${question}\n\n` : ""}This card is about ${card.topic || "the idea"}. The reference answer is: ${clip(card.answer, 200)}\n\n- Find the conditions the question gives.\n- Explain how those conditions lead to the result.\n- Check yourself on a new example.`
        : `**预览回答（模拟模型，未调用真实模型）**\n\n${question ? `你的问题：${question}\n\n` : ""}这道题考查的是「${card.topic || "这个概念"}」。参考答案：${clip(card.answer, 200)}\n\n- 先找出题目给出的条件；\n- 再说明这些条件如何推出结论；\n- 最后换一个新场景检验自己是否真的理解。` };
    } },
  { name: "oral.followup", text: true, match: (s) => s.startsWith("You are a technical interviewer"),
    reply: ({ input, english }) => english
      ? `If you applied ${input.topic || "this idea"} to a new situation, which condition would you check first, and why?`
      : `如果把「${input.topic || "这个概念"}」放到一个新场景里，你会先检查哪个条件？为什么？` },
  { name: "oral.assess", match: (s) => s.startsWith("Assess a completed technical oral mock interview"),
    reply: ({ input, english }) => ({ results: (input.questions || []).map((question, index) => ({ cardId: question.cardId,
      band: ["strong", "developing", "weak"][index % 3],
      reason: english ? "Preview fake model: the direction is right, but the conditions are missing." : "预览模拟模型：方向正确，但缺少成立条件。" })) }) },
  { name: "card.translate", match: (s) => s.startsWith("You translate flashcard content from Chinese"),
    reply: ({ input }) => ({ prompt: `[EN preview] ${input.prompt}`, answer: `[EN preview] ${input.answer}`, explanation: `[EN preview] ${input.explanation}`,
      ...(input.clozeText ? { clozeText: `[EN preview] ${input.clozeText}`, blanks: (input.blanks || []).map(({ id, value }) => ({ id, value })) } : {}),
      ...(input.options ? { options: input.options.map(({ id, text, explanation }) => ({ id, text: `[EN preview] ${text}`, explanation: `[EN preview] ${explanation}` })) } : {}) }) },
  { name: "transcript.title", match: (s) => s.startsWith("You write one English title for a lecture recording"),
    reply: ({ nextNumber }) => ({ titleEn: `Preview Lecture Recording ${nextNumber()}` }) },
  { name: "transcript.proofread", match: (s) => s.startsWith("You proofread speech-to-text transcripts"),
    reply: () => ({ corrections: [] }) },
  { name: "transcript.translate", match: (s) => /^You translate paragraphs of an? (English|Chinese) lecture transcript/.test(s),
    reply: ({ system, input, nextNumber }) => {
      const key = system.startsWith("You translate paragraphs of an English") ? "zh" : "en", n = nextNumber();
      return { titleZh: `预览段落 ${n}`, titleEn: `Preview Passage ${n}`,
        paragraphs: (input.paragraphs || []).map((p) => ({ n: p.n, [key]: `${key === "zh" ? "【预览译文】" : "[Preview translation] "}${p.text}` })) };
    } },
  { name: "selection.answer", text: true, match: (s) => s.startsWith("Answer the learner question using only the selected source evidence"),
    reply: ({ input, english }) => english
      ? `Preview answer (no real model was called): the selected passage “${input.selection?.quote || ""}” is the evidence. Read the neighbouring text to see how it constrains later changes.`
      : `预览示例回答（未调用真实模型）：选段「${input.selection?.quote || ""}」提供了依据。可结合相邻文字检查设计原则如何约束后续变化。` },
  { name: "sources.organize", match: (s) => s.startsWith("Organize study sources into courses"),
    reply: ({ input }) => ({ proposals: (input.sources || []).map((source) => ({ id: source.id, courses: (input.courses || []).slice(0, 1).map((course) => course.name || course),
      reason: input.language === "en" ? "Preview: kept the existing course." : "预览：沿用现有课程。" })) }) },
  { name: "teaching.plan", match: (s) => s.startsWith("You are a source-grounded tutor."),
    reply: () => ({ diagnosis: "预览：需要先分清作用和成立条件。", transfer: "先找条件，再推结论。",
      rungs: [{ lesson: "先说明这个概念要解决的问题。", check: "它要解决什么问题？", answer: "说出它解决的问题即可。" },
        { lesson: "再说明它在什么条件下成立。", check: "它在什么条件下成立？", answer: "说出至少一个条件。" }] }) },
  { name: "teaching.judge", match: (s) => s.startsWith("Judge only the current prerequisite check"),
    reply: ({ input }) => ({ passed: String(input.learnerAnswer || "").trim().length >= 4, feedback: "预览判定：回答长度足够即视为通过。" }) },
  // Guided workflow (AI 带学): choose material, write a lesson, review it, read a retelling.
  { name: "workflow.pick", match: (s) => s.startsWith("You choose study material"),
    reply: ({ input }) => ({ keys: (input.topics || []).slice(0, 6).map((t) => t.key), title: String(input.goal || "").slice(0, 20) }) },
  { name: "workflow.teach", match: (s) => /^You are a careful (Chinese )?tutor writing/.test(s),
    reply: ({ input, english }) => {
      const source = (input.evidence || [])[0];
      const quote = source ? String(source.text).slice(0, 36).trim() : "";
      const points = (input.cards || []).slice(0, 4).map((c) => `- **${c.topic || (english ? "Key point" : "要点")}**: ${String(c.answer || c.explanation || "").slice(0, 80)}`).join("\n");
      let markdown = english
        ? `## Start from a concrete situation\n\nA preview lesson (no real model was called). For “${input.topic}”, imagine a team that has to make a decision, then look at which problem each idea solves. ${"First name the tension it resolves, then see how it works, and finally check when it applies and what is easily confused. ".repeat(4)}\n\n## Key points\n\n${points}\n\n## Step by step\n\n${"A constructed example: confirm the premise holds, follow each intermediate step to the result, then compare the conclusion with the conditions to see that none is missing. ".repeat(4)}\n\n## Boundaries and pitfalls\n\n${"When the conditions do not hold the conclusion fails; a common mistake is to remember the conclusion without its premise. ".repeat(3)}`
        : `## 从一个具体场景开始\n\n预览用的演示讲解（未调用真实模型）。围绕「${input.topic}」，先想象一个团队要做决定的场景，再看每个概念解决什么问题。${"我们先说清它要解决的矛盾，再看它如何运作，最后检查适用条件和容易混淆的地方。".repeat(4)}\n\n## 关键要点\n\n${points}\n\n## 一步一步推演\n\n${"这是为说明机制构造的例子：先确认前提是否成立，再看中间每一步如何得到结果，最后对照结论检查是否遗漏条件。".repeat(4)}\n\n## 边界与易错点\n\n${"条件不满足时结论不成立；常见误区是只记结论不记前提。".repeat(3)}`;
      // Lessons must be substantial (at least 600 characters) even without cards.
      const filler = english ? " Check the premise before applying the rule." : "应用规则之前，先检查前提是否成立。";
      while (markdown.length < 720) markdown += filler;
      return { markdown, citations: quote.length >= 8 ? [{ sourceId: source.sourceId, quote }] : [] };
    } },
  { name: "workflow.teach.review", match: (s) => /^Independently review this (Chinese )?learning article/.test(s),
    reply: () => ({ grounded: true, coherent: true, explained: true, example: true, boundaries: true, issues: [] }) },
  { name: "workflow.retelling", match: (s) => s.includes("reading a learner's retelling"),
    reply: ({ input, english }) => {
      const short = String(input.retelling || "").length < 40;
      return english
        ? { covered: ["Stated the role of the core idea"], missing: short ? ["Did not say when it holds", "No concrete example"] : [],
          question: "If the premise did not hold, would the conclusion still be the same?", suggestion: short ? "revisit" : "continue",
          note: short ? "Right direction — add the conditions and an example to complete it." : "A complete retelling; you can continue." }
        : { covered: ["说出了核心概念的作用"], missing: short ? ["没有说明它在什么条件下成立", "缺少一个具体例子"] : [],
          question: "如果前提不成立，结论还会一样吗？", suggestion: short ? "revisit" : "continue",
          note: short ? "方向是对的，再把条件和例子补上会更完整。" : "讲得很完整，可以继续。" };
    } },
  { name: "skeleton", match: (s) => s.startsWith("You design a knowledge skeleton"),
    reply: ({ input, english }) => {
      // One station per topic, its cards hanging below: enough to draw a spine.
      const none = english ? "Uncategorized" : "未分类";
      const topics = [...new Set((input.cards || []).map((c) => c.topic || none))].slice(0, 6);
      const nodes = topics.flatMap((topic, i) => {
        const cards = input.cards.filter((c) => (c.topic || none) === topic).slice(0, 4);
        return [{ id: `t${i}`, term: topic, meaning: english ? `Preview skeleton (no real model): the “${topic}” station.` : `预览用的演示骨架（未调用真实模型）：「${topic}」这一站。`, cards: cards.map((c) => c.cardId) },
          ...cards.map((c, j) => ({ id: `t${i}c${j}`, parent: `t${i}`, term: String(c.answer || c.prompt).slice(0, 30) || `${english ? "Point" : "要点"} ${j + 1}`,
            meaning: String(c.explanation || c.answer || "").slice(0, 120) || (english ? "Demo point." : "演示要点。"), cards: [c.cardId] }))];
      });
      const relations = topics.slice(1).map((_, i) => ({ from: `t${i}`, to: `t${i + 1}`, type: "prerequisite" }));
      return english
        ? { title: `How ${topics[0] || "this scope"} fits together`, overview: "Preview skeleton: topics ordered from foundations to application.", nodes, relations }
        : { title: `${topics[0] || "本次范围"}的脉络`, overview: "预览用的演示骨架：按主题从基础到应用排成一条主线。", nodes, relations };
    } },
  // Card follow-up teacher (追问).
  { name: "card.followup", match: (s) => s.includes("学习卡片的追问老师"),
    reply: ({ input }) => input.question
      ? { question: `关于${input.card.topic}：${input.question}`, answer: `结合本题：${input.card.explanation}\n\n补充说明：可以用一个具体场景检查自己是否理解。` }
      : { questions: [`${input.card.topic}可以用一个例子说明吗？`, "这个概念最容易和什么混淆？", "换一个场景时，应该怎样运用这个规则？"] } },
  // Coach tasks are told apart by their task text.
  { name: "coach.nudge", match: (_s, input) => /刚答错|掌握程度自评/.test(String(input.task || "")),
    reply: ({ input }) => {
      const topic = input.card?.topic || "这个概念";
      return { point: `「${topic}」里谁负责什么${input.earlier?.length ? "（换个角度）" : ""}`,
        explain: `先分清职责再看选项：${String(input.card?.answer || "").slice(0, 40)}。比如保存历史的人不需要知道快照里装了什么。`,
        check: { q: "管理历史的对象需要读取快照内部吗？", options: ["需要", "不需要"], answer: 1, why: "它只保管不透明的快照。" } };
    } },
  { name: "coach.confused", match: (_s, input) => String(input.task || "").includes("仍然不懂"),
    reply: () => ({ explain: "把快照想成封好的信封：保管员只负责按顺序存放信封，只有写信的人能拆开。" }) },
  { name: "coach.rewrite", match: (_s, input) => String(input.task || "").includes("反馈标签"),
    reply: ({ input }) => {
      const card = input.card || {}, patch = {};
      if (Array.isArray(card.options) && input.tags?.some((t) => /选项|解析/.test(t)))
        patch.options = card.options.map((o) => ({ id: o.id, explanation: `${o.correct ? "正确" : "错误"}：${o.why || o.text}（已按反馈写得更具体）` }));
      if (input.tags?.includes("题干太空")) patch.prompt = `${card.prompt}（请结合题目给出的职责划分作答）`;
      return { patch, summary: Object.keys(patch).length ? "补足了题干条件并逐项重写解析" : "核对原文后答案无误" };
    } },
  { name: "coach.prepare", match: (_s, input) => String(input.task || "").includes("为每个 target"),
    reply: ({ input, nextNumber }) => {
      const text = input.evidence?.[0]?.text || "", sourceId = input.evidence?.[0]?.sourceId;
      const quote = text.slice(0, Math.min(text.length, 60));
      return { cards: (input.targets || []).map((t, i) => {
        const n = nextNumber();
        return { target: t.target, kind: t.kind, topic: t.card.topic, objective: `在具体场景中应用 ${t.card.topic}（变式 ${i + 1} · #${n}）`,
          prompt: `某团队在做编辑器撤销功能时（变式 ${i + 1} · #${n}），应当让哪个角色保存历史而不读取快照内容？`,
          answer: "负责保管历史的角色", hint: "想想谁需要知道快照里有什么。", explanation: "保管历史与读取内容是两种职责，分开可以保持封装。",
          misconception: "以为保存历史就必须理解快照结构。", citations: sourceId ? [{ sourceId, quote }] : [],
          ...(t.kind === "flashcard" ? {} : { options: [
            { id: "a", text: "历史保管者", correct: true, explanation: "它只存放快照，不读取内容。" },
            { id: "b", text: "快照对象本身", correct: false, explanation: "快照是被保存的数据，不管理历史。" },
            { id: "c", text: "界面渲染层", correct: false, explanation: "渲染层与状态保存无关。" }] }) };
      }) };
    } },
  { name: "coach.debrief", match: (_s, input) => String(input.task || "").includes("本轮指标"),
    reply: ({ input }) => {
      const m = input.metrics || {};
      return { headline: m.lowShare >= 70 ? "概念会了，别停在纸上谈兵" : "薄弱点就差临门一脚",
        why: `本轮 ${m.answered} 题里 ${m.lowShare}% 是概念题，正确率 ${m.accuracy}%。`, next: input.defaultNext,
        summary: `目标：${input.learner?.goal || "未设定"}；偏好快速刷题；概念辨析占比高，应用分析练得少。` };
    } },
];

/** Names of the prompt families the fake understands (for docs and tests). */
export const FAKE_MODEL_HANDLERS = Object.freeze(HANDLERS.map((handler) => handler.name));

/**
 * @param {{ latencyMs?: number, generationLatencyMs?: number, log?: object[] }} options
 *   latencyMs delays every call; generationLatencyMs (default latencyMs) delays the
 *   plan/author/review stages so job progress is visible. Delays honour the abort signal.
 */
export function createFakeModel({ latencyMs = 0, generationLatencyMs = latencyMs, log = [] } = {}) {
  let counter = 0;
  const nextNumber = () => ++counter;
  return async function fakeComplete(system, prompt, options = {}) {
    const input = data(prompt);
    const handler = HANDLERS.find((entry) => entry.match(system, input));
    log.push({ system, prompt, handler: handler?.name || null, stage: options?.stage });
    await wait(handler?.slow ? (handler.name === "generation.review" ? Math.round(generationLatencyMs / 2) : generationLatencyMs) : latencyMs,
      options?.signal);
    if (!handler) return "{}";
    const value = handler.reply({ system, prompt, input, english: englishSession(system), nextNumber });
    return handler.text ? value : JSON.stringify(value);
  };
}
