import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StudyService } from "../lib/service.js";
import { assistDigest, commitAssist } from "../lib/assist-content.js";
import { createAssistService } from "../lib/assist.js";
import { JSON_CARD_SOURCE, AI_DRAFTED_SOURCE } from "../lib/source-provenance.js";
import { openInboxResult } from "../ui/app/inbox-open.js";
import { reviewParts } from "./helpers/review-render.mjs";
import { nativeSelects } from "./helpers/native-selects.mjs";

const realRequire = createRequire(import.meta.url);
const realJsxRuntime = realRequire("react/jsx-runtime");
let recorded = [];
const watchedReact = {
  ...React,
  __esModule: true,
  createElement: (type, props, ...children) => {
    if (typeof type === "string" || typeof type === "function") recorded.push({ type, props, children });
    return React.createElement(type, props, ...children);
  },
};
watchedReact.default = watchedReact;
const watchedJsxRuntime = {
  ...realJsxRuntime,
  jsx: (type, props, key) => {
    if (typeof type === "string" || typeof type === "function") recorded.push({ type, props, key });
    return realJsxRuntime.jsx(type, props, key);
  },
  jsxs: (type, props, key) => {
    if (typeof type === "string" || typeof type === "function") recorded.push({ type, props, key });
    return realJsxRuntime.jsxs(type, props, key);
  },
};

const compiled = await build({
  stdin: {
    contents: `
      export { default as QuestionRun } from './ui/review/QuestionRun.jsx';
      export { default as ExplanationFollowup } from './ui/ExplanationFollowup.jsx';
      export { default as CitationDisclosure } from './ui/CitationDisclosure.jsx';
      export { default as FigurePageLink } from './ui/document-preview/practice/FigurePageLink.jsx';
      export { default as DocumentViewer } from './ui/document-preview/DocumentViewer.jsx';
      export { default as PracticeTip } from './ui/review/PracticeTip.jsx';
      export * from './ui/review/PracticeTip.jsx';
      export { usePracticeTip } from './ui/review/use-practice-tip.js';
      export * from './ui/guidance/practice-tips.js';
      export { default as ThumbFeedback } from './ui/ThumbFeedback.jsx';
      export { useReviewSession, mergeReviewPollWithFollowups } from './ui/review/useReviewSession.js';
      export * from './ui/app/use-inbox.js';
      export { StudyServicesContext } from './ui/study-context.jsx';
      export { ModelSettingsContext } from './ui/ModelErrorNote.jsx';
      export { setUiLanguage } from './ui/i18n.js';
    `,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  jsx: "automatic",
  platform: "node",
  format: "cjs",
  external: ["react", "react/jsx-runtime", "react-dom"],
  plugins: [nativeSelects],
  loader: { ".css": "text" },
  logLevel: "silent",
});
const mod = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(
  (id) => (id === "react" ? watchedReact : id === "react/jsx-runtime" ? watchedJsxRuntime : realRequire(id)),
  mod,
  mod.exports,
);
const m = mod.exports;
const h = React.createElement;
const han = /[\u3400-\u9fff]/;

const sampleCard = {
  id: "c1",
  kind: "quiz",
  topic: "Indexes",
  objective: "Explain B-tree index lookups",
  prompt: "Which statement about a B-tree index is accurate?",
  answer: "It keeps keys sorted for logarithmic lookup.",
  hint: "Consider tree height.",
  explanation: "Sorted keys let lookups descend the tree.",
  misconception: "An index does not replace the table.",
  citations: [{ sourceId: "s1", quote: "B-tree indexes keep keys in sorted order for fast lookup." }],
  options: [
    { id: "a", text: "It keeps keys sorted for logarithmic lookup.", correct: true, explanation: "Right." },
    { id: "b", text: "It speeds up every single write.", correct: false, explanation: "Writes update the index too." },
  ],
};

function mountRun(overrides = {}) {
  const { services, props } = reviewParts({
    data: { sources: [{ id: "s1", title: "DB Notes", text: "B-tree indexes keep keys in sorted order for fast lookup." }], model: { ready: true, reason: "ok", label: "DeepSeek" } },
    shellTitle: "Practice",
    ...overrides,
  });
  recorded = [];
  const html = renderToStaticMarkup(
    h(m.ModelSettingsContext.Provider, { value: overrides.onModelSettings || (() => {}) },
      h(m.StudyServicesContext.Provider, { value: services },
        h(m.QuestionRun, {
          session: props.session,
          data: props.data,
          coachProps: props.coachProps,
          links: props.links,
          context: props.context,
          feedback: props.feedback,
        }))),
  );
  return { html, elements: [...recorded] };
}

/* ── #958: Unanswered 帮我弄懂 Q&A visibility & Inbox read sync ── */

test("#958 backend & poll merge: unanswered non-exam run exposes followups without leaking solution; exam omits followups", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-958-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  t.after(() => service.dispose?.());
  await service.call("snapshot");
  await service.store.update((s) => {
    s.sources.push({ id: "s1", title: "DB Notes", text: "B-tree indexes keep keys in sorted order for fast lookup." });
    s.decks.push({ id: "d1", title: "DB", course: "DB", publishedAt: "2026-10-01T00:00:00.000Z", cards: [structuredClone(sampleCard)] });
  });

  const started = await service.call("review.start", { deckId: "d1", mode: "quiz" });
  assert.equal(started.revealed, false);
  assert.equal(started.solution, undefined, "unanswered card never leaks solution");
  assert.deepEqual(started.followups, []);

  await service.call("card.followup.add", {
    deckId: "d1",
    cardId: "c1",
    question: "为什么树高是对数级？",
    answer: "每个节点有多个分支，层数随记录数对数增长。",
    source: "assistant",
  });

  const polled = await service.call("review.get", { runId: started.id });
  assert.equal(polled.solution, undefined, "review.get still hides solution before answering");
  assert.equal(polled.followups?.length, 1, "review.get exposes saved followup immediately on unanswered card");
  assert.equal(polled.followups[0].question, "为什么树高是对数级？");

  const merged = m.mergeReviewPollWithFollowups(started, polled);
  assert.equal(merged.solution, undefined, "poll merge still hides solution");
  assert.equal(merged.followups?.length, 1, "poll merge brings followups onto the open unanswered run");
  assert.equal(m.mergeReviewPollWithFollowups(merged, polled), merged, "unchanged followups keep object identity");

  const exam = await service.call("review.start", { deckId: "d1", mode: "exam" });
  assert.equal(exam.followups, undefined, "exam mode never exposes followups");
});

test("#958 UI: ExplanationFollowup and QuestionRun render Q&A under an unanswered card without leaking the answer", () => {
  m.setUiLanguage("zh");
  const unansweredWithQa = {
    id: "r1",
    deckId: "d1",
    index: 0,
    total: 1,
    mode: "quiz",
    revealed: false,
    feedback: null,
    solution: undefined,
    followups: [{ id: "f1", question: "先给个提示思路？", answer: "想一想有序结构怎样减少比较次数。" }],
    card: { id: "c1", kind: "quiz", topic: "Indexes", prompt: sampleCard.prompt, options: sampleCard.options.map(({ id, text }) => ({ id, text })) },
  };
  const { html: hiddenOldQa } = mountRun({ run: unansweredWithQa, choice: true, explain: false });
  assert.doesNotMatch(hiddenOldQa, /explanation-followup/, "historical Q&A from an earlier round stays folded while the learner thinks");

  const { html } = mountRun({ run: unansweredWithQa, choice: true, explain: true });
  assert.match(html, /explanation-followup/, "Q&A section renders under the unanswered card once asked or opened");
  assert.match(html, /想一想有序结构怎样减少比较次数/, "assistant answer is visible right away");
  assert.doesNotMatch(html, /理解这道题/, "standard explanation heading stays hidden until answered");
  assert.doesNotMatch(html, /Sorted keys let lookups descend/, "solution explanation is not leaked");
});

test("#958 inbox: followup letter stays unread until its Q&A is actually visible on screen, and opening it triggers explain", () => {
  const items = [
    { id: "l-follow", read: false, kind: "followup", cardId: "c1" },
    { id: "l-improve", read: false, kind: "improve", cardId: "c1" },
    { id: "l-var", read: false, kind: "variant", cardId: "c1" },
  ];
  assert.deepEqual(
    m.seenInboxLetterIds({
      page: "review",
      run: { mode: "quiz", card: { id: "c1" }, revealed: false, solution: null, followups: [] },
      entry: { explain: false },
      items,
    }),
    ["l-improve"],
    "unanswered card before followups arrive in run does NOT mark followup letter read",
  );
  assert.deepEqual(
    m.seenInboxLetterIds({
      page: "review",
      run: { mode: "flashcard", card: { id: "c1" }, revealed: true, feedback: null, solution: { followups: [{ id: "f1" }] } },
      entry: { explain: false },
      items,
    }),
    ["l-improve"],
    "flipped flashcard with folded explanation does NOT mark followup letter read",
  );
  assert.deepEqual(
    m.seenInboxLetterIds({
      page: "review",
      run: { mode: "quiz", card: { id: "c1" }, revealed: false, solution: null, followups: [{ id: "f1" }] },
      entry: { explain: false, assistance: null },
      items,
    }),
    ["l-improve"],
    "unanswered card with hidden historical followups does NOT mark followup letter read",
  );
  assert.deepEqual(
    m.seenInboxLetterIds({
      page: "review",
      run: { mode: "quiz", card: { id: "c1" }, revealed: false, solution: null, followups: [{ id: "f1" }] },
      entry: { explain: false, assistance: { askedTutorBeforeAnswer: true } },
      items,
    }),
    ["l-follow", "l-improve"],
    "unanswered card with visible asked followups marks followup letter read",
  );

  const log = [];
  openInboxResult(
    {
      item: { kind: "followup" },
      result: { id: "r1", index: 0, revealed: false, followups: [{ id: "f1", question: "Q", answer: "A" }] },
      from: {},
      fromReview: false,
    },
    {
      remember: () => log.push("remember"),
      showPage: () => {},
      openAudioSources: () => {},
      showNote: () => {},
      enterRun: () => log.push("enterRun"),
      explain: () => log.push("explain"),
      detour: () => {},
    },
  );
  assert.ok(log.includes("explain"), "jumping from inbox to unanswered card with followups calls explain()");
});

/* ── #959: noChange & unlinked prerequisite feedback (card + inbox) ── */

test("#959 backend: improve/derive noChange and unlinked prerequisites notify inbox and expose outcome on task", async () => {
  const makeState = () => ({
    settings: {},
    sources: [{ id: "s1", title: "DB Notes", text: "B-tree indexes keep keys in sorted order for fast lookup and balanced depth." }],
    drafts: [],
    inbox: [],
    decks: [{ id: "d1", title: "DB", course: "DB", cards: [structuredClone(sampleCard)] }],
  });
  const ref = { deckId: "d1", cardId: "c1" };

  // 1) improve noChange
  const s1 = makeState();
  const r1 = commitAssist(
    s1,
    { ref, mode: "improve", request: { question: "改成填空题", choices: [], requests: [] }, expectedDigest: assistDigest(s1.decks[0].cards[0]), result: { noChange: "修题不能改变题型，请使用出新题功能。" } },
    {},
  );
  assert.equal(r1.outcome, "no-change");
  assert.equal(r1.message, "修题不能改变题型，请使用出新题功能。");
  assert.equal(s1.inbox.length, 1);
  assert.equal(s1.inbox[0].kind, "coach");
  assert.equal(s1.inbox[0].cardId, "c1");

  // 2) derive noChange
  const s2 = makeState();
  const r2 = commitAssist(
    s2,
    { ref, mode: "derive", request: { question: "量子纠缠", choices: [], requests: [], relation: "prerequisite" }, expectedDigest: assistDigest(s2.decks[0].cards[0]), result: { noChange: "当前资料没有涉及量子纠缠，无法据此出题。" } },
    {},
  );
  assert.equal(r2.outcome, "no-change");
  assert.equal(s2.inbox.length, 1);
  assert.equal(s2.inbox[0].kind, "coach");
  assert.equal(s2.inbox[0].detail, "当前资料没有涉及量子纠缠，无法据此出题。");

  // 3) derive unlinked (new card vs reused card)
  const newPrereqCard = {
    kind: "flashcard",
    topic: "Sorted keys",
    objective: "Define sorted key order",
    prompt: "What property of B-tree keys enables binary search within a node?",
    answer: "Keys are kept in sorted order.",
    hint: "Order of keys.",
    explanation: "Sorted order allows binary search.",
    misconception: "Keys are not hashed.",
    citations: [{ sourceId: "s1", quote: "B-tree indexes keep keys in sorted order for fast lookup." }],
  };
  const s3 = makeState();
  const r3 = commitAssist(
    s3,
    { ref, mode: "derive", request: { question: "有序键", choices: [], requests: [], relation: "prerequisite" }, expectedDigest: assistDigest(s3.decks[0].cards[0]), result: { card: newPrereqCard } },
    { "card.link": () => { throw new Error("前置题已达上限"); } },
  );
  assert.equal(r3.outcome, "unlinked");
  assert.ok(r3.cardId);
  assert.equal(s3.inbox.length, 1);
  assert.equal(s3.inbox[0].kind, "variant", "new unlinked card notifies variant on the new cardId");
  assert.equal(s3.inbox[0].cardId, r3.cardId);

  // Reused card when card.link throws
  const r4 = commitAssist(
    s3,
    { ref, mode: "derive", request: { question: "有序键", choices: [], requests: [], relation: "prerequisite" }, expectedDigest: assistDigest(s3.decks[0].cards[0]), result: { card: newPrereqCard } },
    { "card.link": () => { throw new Error("会形成循环"); } },
  );
  assert.equal(r4.outcome, "unlinked");
  assert.equal(s3.inbox.length, 2);
  assert.equal(s3.inbox[1].kind, "coach", "reused unlinked card notifies coach on current cardId");
  assert.equal(s3.inbox[1].cardId, "c1");

  // 4) assist service preserves outcome on publicTask
  const s5 = makeState();
  const assistSvc = createAssistService();
  await assistSvc.startAssist({ get: () => null }, {
    root: "r-959",
    sessionId: "",
    mode: "improve",
    ref,
    text: "检查一下",
    helpChoices: [],
    card: s5.decks[0].cards[0],
    deckTitle: "DB",
    language: "zh",
    service: {
      store: { read: async () => s5 },
      complete: async () => JSON.stringify({ noChange: "核对原文后原答案无误。" }),
      saveAssistResult: (payload) => commitAssist(s5, payload, {}),
    },
  });
  await new Promise((r) => setTimeout(r, 30));
  const finished = assistSvc.assistView("r-959").tasks.at(-1);
  assert.equal(finished.status, "done");
  assert.equal(finished.outcome, "no-change");
  assert.equal(finished.message, "核对原文后原答案无误。");
});

test("#959 UI: QuestionRun renders done task with no-change or unlinked outcome, localized in zh and en", () => {
  m.setUiLanguage("zh");
  const { html: zhHtml } = mountRun({
    run: { id: "r1", deckId: "d1", index: 0, total: 1, mode: "quiz", card: sampleCard },
    choice: true,
    assistTasks: [{ id: "t1", cardId: "c1", mode: "improve", status: "done", outcome: "no-change", question: "改一下", message: "原题答案与原文一致，无需修改。" }],
  });
  assert.match(zhHtml, /原题答案与原文一致，无需修改/);
  assert.match(zhHtml, />改一改再提交<\/button>/);
  assert.match(zhHtml, />知道了<\/button>/);

  m.setUiLanguage("en");
  try {
    const { html: enHtml } = mountRun({
      run: { id: "r1", deckId: "d1", index: 0, total: 1, mode: "quiz", card: sampleCard },
      choice: true,
      assistTasks: [{ id: "t2", cardId: "c1", mode: "derive", status: "done", outcome: "unlinked", question: "B-tree", message: "已出成一道新题，但没能关联为前置题（会形成循环或超过上限）。" }],
    });
    assert.match(enHtml, /Saved as a new question in the deck/);
    assert.doesNotMatch(enHtml.replace(/B-tree/g, ""), han, "no Chinese leak on English unlinked outcome box");
  } finally {
    m.setUiLanguage("zh");
  }
});

/* ── #960: Practice first-use tips dwell, Escape scoping, G/B cancelAutoAdvance, difficulty tags ── */

test("#960 rules: dwell constant is 1500ms, shortcut-sheet yields, and difficulty-only tags never trigger 修题 tip", () => {
  assert.equal(m.PRACTICE_TIP_DWELL_MS, 1500);
  assert.match(m.PRACTICE_TIP_YIELD_TO, /\.shortcut-sheet/);

  assert.deepEqual(m.voteTipMoments("down", [], true), { votedDown: true, tooHard: false }, "bare 👎 still triggers fix-first");
  assert.deepEqual(m.voteTipMoments("down", ["too-easy"], true), { votedDown: false, tooHard: false }, "too-easy alone does not trigger fix-first");
  assert.deepEqual(m.voteTipMoments("down", ["too-hard"], true), { votedDown: false, tooHard: true }, "too-hard on answered card guides to help-first, never fix-first");
  assert.deepEqual(m.voteTipMoments("down", ["too-hard"], false), { votedDown: false, tooHard: false }, "unanswered card waits until answered");
  assert.deepEqual(m.voteTipMoments("down", ["too-hard", "wrong-answer"], true), { votedDown: true, tooHard: true }, "mixed quality + difficulty tag still allows fix-first");

  assert.equal(
    m.practiceTipFor({ feedbackWrong: false, tooHard: true, votedDown: false, answerShown: false, allowed: [...m.PRACTICE_TIP_ORDER], seen: [] }),
    "practice.help-first",
    "tooHard on a right answer triggers help-first",
  );
});

/* ── #961: Unconfigured / broken AI model UX in Practice ── */

test("#961 tips & gate: unready model suppresses proactive tips, keeps typed text on 403, and avoids calling teach.start", () => {
  assert.equal(
    m.practiceTipFor({ feedbackWrong: true, votedDown: true, answerShown: true, modelReady: false, allowed: [...m.PRACTICE_TIP_ORDER], seen: [] }),
    null,
    "no proactive AI tool tips when model is not ready",
  );

  // AssistFailure keeps 改一改再提交 on 403 when model is unready, and adds 重新提交 once model is ready
  const raw403 = '403: {"message":"Authentication failed.","type":"permission_error"}';
  let teachCalls = 0;
  const unreadyRender = mountRun({
    data: { sources: [], model: { ready: false, reason: "no-credential", label: "DeepSeek" } },
    run: { id: "r1", deckId: "d1", index: 0, total: 1, mode: "quiz", revealed: true, feedback: { correct: false, selected: ["b"] }, card: sampleCard, solution: sampleCard },
    choice: true,
    teachingAct: () => { teachCalls++; },
    assistTasks: [{ id: "t403", cardId: "c1", mode: "ask", status: "failed", question: "我的长问题", choices: [], message: raw403 }],
  });
  assert.doesNotMatch(unreadyRender.html, />重新提交<\/button>/);
  assert.match(unreadyRender.html, />改一改再提交<\/button>/, "typed question can be recovered on 403");
  const teachChips = unreadyRender.elements.filter((el) => typeof el.props?.onClick === "function" && (el.props?.children === "逐步理解" || el.props?.children === "计算题引导练习"));
  assert.equal(teachChips.length, 2);
  for (const chip of teachChips) chip.props.onClick();
  assert.equal(teachCalls, 0, "clicking 逐步理解 / 计算题引导练习 when !model.ready opens inline gate instead of calling teach.start");

  const readyFail = mountRun({
    data: { sources: [], model: { ready: true, reason: "ok", label: "DeepSeek" } },
    run: { id: "r1", deckId: "d1", index: 0, total: 1, mode: "quiz", card: sampleCard },
    choice: true,
    assistTasks: [{ id: "t403", cardId: "c1", mode: "ask", status: "failed", question: "我的长问题", choices: [], message: raw403 }],
  }).html;
  assert.match(readyFail, />重新提交<\/button>/, "once model is ready again, 重新提交 appears right on the card");
  assert.match(readyFail, />改一改再提交<\/button>/);
});

/* ── #965: Reader back: true, PDF 看原页, provenance summary badges, and bottom 继续追问 ── */

test("#965 QuestionRun passes back: true on CitationDisclosure and FigurePageLink reader modals, and wires 继续追问", () => {
  const pdfSource = {
    id: "s-pdf",
    title: "Slides.pdf",
    format: "pdf",
    text: "[Figure 1]\nB-tree indexes keep keys in sorted order.",
    document: { id: "doc1", format: "pdf", page: 3, totalPages: 10 },
  };
  const modals = [];
  const { services, props } = reviewParts({
    data: { sources: [pdfSource], model: { ready: true, reason: "ok" } },
    setModal: (arg) => modals.push(arg),
    run: {
      id: "r1",
      deckId: "d1",
      index: 0,
      total: 1,
      mode: "quiz",
      revealed: true,
      feedback: { correct: false, selected: ["b"] },
      card: { ...sampleCard, prompt: "See Figure 1: which statement holds?" },
      solution: {
        answer: sampleCard.answer,
        explanation: "See Figure 1 in the slides.",
        misconception: sampleCard.misconception,
        citations: [{ sourceId: "s-pdf", quote: "B-tree indexes keep keys in sorted order." }],
        followups: [{ id: "f1", question: "Q1", answer: "A1" }],
        options: sampleCard.options,
      },
      teaching: {
        id: "teach1",
        mode: "calculation",
        stage: "formula",
        index: 0,
        total: 2,
        lesson: "Step 1",
        assumptions: "None",
        units: "N/A",
        rounding: "Exact",
        check: "Check?",
        citations: [{ sourceId: "s-pdf", quote: "B-tree indexes keep keys in sorted order." }],
      },
    },
    teaching: {
      id: "teach1",
      mode: "calculation",
      stage: "formula",
      index: 0,
      total: 2,
      lesson: "Step 1",
      assumptions: "None",
      units: "N/A",
      rounding: "Exact",
      check: "Check?",
      citations: [{ sourceId: "s-pdf", quote: "B-tree indexes keep keys in sorted order." }],
    },
    choice: true,
  });

  recorded = [];
  const html = renderToStaticMarkup(
    h(m.StudyServicesContext.Provider, { value: services },
      h(m.QuestionRun, { session: props.session, data: props.data, coachProps: props.coachProps, links: props.links, context: props.context })),
  );
  assert.match(html, />继续追问<\/button>/, "ExplanationFollowup shows bottom 继续追问 button in QuestionRun");

  const disclosures = recorded.filter((el) => el.type === m.CitationDisclosure);
  assert.equal(disclosures.length, 2, "solution and teaching CitationDisclosures");
  for (const d of disclosures) d.props.onOpenSource(pdfSource, "quote", 3);
  assert.equal(modals.length, 2);
  assert.equal(modals[0].back, true, "solution CitationDisclosure passes back: true");
  assert.equal(modals[0].peekPage, 3, "solution CitationDisclosure forwards peekPage");
  assert.equal(modals[1].back, true, "teaching CitationDisclosure passes back: true");

  const figureLink = recorded.find((el) => el.type === m.FigurePageLink);
  assert.ok(figureLink, "FigurePageLink rendered on solution");
  figureLink.props.onOpen(pdfSource, "quote", 3);
  assert.equal(modals[2].back, true, "FigurePageLink passes back: true");
  assert.equal(modals[2].peekPage, 3, "FigurePageLink forwards peekPage");
});

test("#965 CitationDisclosure shows provenance badges on collapsed summary and 看原页 on expanded PDF citations (zh & en)", () => {
  const jsonSelfSource = { id: "s-self", title: "Imported JSON", provenance: JSON_CARD_SOURCE, text: "Self quote." };
  const aiSource = { id: "s-ai", title: "AI Handout", provenance: AI_DRAFTED_SOURCE, text: "AI quote." };
  const pdfSource = { id: "s-pdf", title: "Lecture.pdf", format: "pdf", text: "PDF quote.", document: { id: "doc1", format: "pdf", page: 5, totalPages: 12 } };

  for (const [lang, selfWord, aiWord, peekWord] of [
    ["zh", "题目自引", "AI 撰写 · 未核对", "看原页"],
    ["en", "Self-cited", "AI-drafted · unverified", "Original page"],
  ]) {
    m.setUiLanguage(lang);
    const closedSelf = renderToStaticMarkup(h(m.CitationDisclosure, {
      card: { citations: [{ sourceId: "s-self", quote: "Self quote." }] },
      sources: [jsonSelfSource],
      onOpenSource: () => {},
    }));
    assert.ok(closedSelf.includes(selfWord), `${lang}: collapsed summary shows ${selfWord}`);
    assert.doesNotMatch(closedSelf, /citations__provenance/, `${lang}: collapsed summary has no citations__provenance class`);

    const closedAi = renderToStaticMarkup(h(m.CitationDisclosure, {
      card: { citations: [{ sourceId: "s-ai", quote: "AI quote." }] },
      sources: [aiSource],
      onOpenSource: () => {},
    }));
    assert.ok(closedAi.includes(aiWord), `${lang}: collapsed summary shows ${aiWord}`);

    const openedCalls = [];
    recorded = [];
    const openPdf = renderToStaticMarkup(h(m.CitationDisclosure, {
      card: { citations: [{ sourceId: "s-pdf", quote: "PDF quote." }] },
      sources: [pdfSource],
      defaultOpen: true,
      onOpenSource: (...args) => openedCalls.push(args),
    }));
    assert.ok(openPdf.includes(peekWord), `${lang}: expanded PDF citation renders ${peekWord}`);
    if (lang === "en") assert.doesNotMatch(openPdf, han, "no CJK in English CitationDisclosure");
    const peekBtn = recorded.find((el) => el.type === "button" && String(el.props?.className || "").includes("citations__peek"));
    assert.ok(peekBtn, "peek button rendered");
    peekBtn.props.onClick({ currentTarget: {} });
    assert.deepEqual(openedCalls, [[pdfSource, "PDF quote.", 5]]);
  }
  m.setUiLanguage("zh");
});
