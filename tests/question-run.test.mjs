import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { reviewParts } from "./helpers/review-render.mjs";

/* QuestionRun (ui/review/QuestionRun.jsx) is the question body of the practice page, mountable on another page (the 复习全书 node page).
   These tests mount it with a fake session and without the page shell, answer a question through it, and check that a session made for an
   embedding page does not navigate to the practice page. The markup is rendered on the server; the click handlers are caught as the
   elements are created (React.createElement of the bundle is wrapped), so they can be called the way a click would. */
const compiled = await build({ stdin: { contents: `export { default as QuestionRun } from './ui/review/QuestionRun.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { useReviewSession } from './ui/review/useReviewSession.js';`, resolveDir: process.cwd() }, bundle: true,
write: false, platform: "node", format: "cjs", external: ["react"], loader: { ".css": "text" }, logLevel: "silent" });
const realRequire = createRequire(import.meta.url);
let seen = [];
const watchedReact = { ...React, createElement: (type, props, ...children) => {
  if (props?.["data-usage"]) seen.push({ type, props });
  return React.createElement(type, props, ...children);
} };
const module = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)((id) => (id === "react" ? watchedReact : realRequire(id)), module, module.exports);
const { QuestionRun, StudyServicesContext, useReviewSession } = module.exports;

const choiceCard = { id: "q", kind: "quiz", topic: "Context", prompt: "Who processes payments?",
  options: [{ id: "a", text: "Payment System" }, { id: "b", text: "Billing Clerk" }] };
function mount(old) {
  const { services, props } = reviewParts({ data: { sources: [] }, shellTitle: "Book node", ...old });
  seen = [];
  const { session, data, coachProps, links, context, feedback } = props;
  const html = renderToStaticMarkup(React.createElement(StudyServicesContext.Provider, { value: services },
    React.createElement(QuestionRun, { session, data, coachProps, links, context, feedback })));
  return { html, clicks: seen.filter((item) => item.type === "button") };
}

test("QuestionRun draws the question body and none of the practice page around it", () => {
  const { html } = mount({ run: { id: "r", index: 1, total: 4, mode: "path", card: choiceCard } });
  assert.match(html, /^<div class="review-body">/, "the body is the root");
  assert.match(html, /data-tour="review-question"/);
  assert.match(html, /class="question-meta"/);
  assert.match(html, /Who processes payments\?/);
  assert.equal((html.match(/data-usage="review\.option"/g) || []).length, 2);
  assert.match(html, /class="question-toolbar"/, "the toolbar is part of the run");
  for (const shell of ["review-page", "review-heading", "has-rail", "review-return", "session-summary"]) assert.doesNotMatch(html, new RegExp(shell), shell);
});

test("answering through QuestionRun reaches the session's own actions", () => {
  const press = (old, mutate) => {
    const { services, props } = reviewParts({ data: { sources: [] }, ...old });
    mutate?.(props.session.actions);
    seen = [];
    renderToStaticMarkup(React.createElement(StudyServicesContext.Provider, { value: services },
      React.createElement(QuestionRun, { session: props.session, data: props.data, links: props.links, context: props.context })));
    return seen.filter((item) => item.type === "button");
  };
  const picks = [];
  const options = press({ run: { id: "r", index: 0, total: 1, card: choiceCard } }, (actions) => { actions.choose = (id) => picks.push(id); });
  const optionButtons = options.filter((item) => item.props["data-usage"] === "review.option");
  assert.equal(optionButtons.length, 2);
  optionButtons[1].props.onClick();
  assert.deepEqual(picks, ["b"], "a click on the second option chooses it");

  const answers = [];
  const grades = press({ run: { id: "r", index: 0, total: 1, mode: "path", revealed: true, card: { id: "f", kind: "flashcard", topic: "Context", prompt: "Term?", answer: "Definition" } },
    reviewAct: (action, args) => answers.push([action, args]) }).filter((item) => item.props["data-usage"] === "review.grade");
  assert.equal(grades.length, 6, "the 0-5 scale");
  grades[4].props.onClick();
  assert.deepEqual(answers, [["review.answer", { grade: 4 }]], "grading is the session's review.answer, not a copy");
});

test("an answered question shows its marks and the explanation inside QuestionRun", () => {
  const { html, clicks } = mount({ run: { id: "r", index: 0, total: 1, mode: "path", card: choiceCard, revealed: true,
    feedback: { correct: true, selected: ["a"], level: "learning" },
    solution: { answer: "Payment System", explanation: "Payment System handles payments.", misconception: "Billing only invoices.",
      options: [{ id: "a", correct: true, explanation: "It settles payments." }, { id: "b", correct: false, explanation: "It only invoices." }] } } });
  assert.match(html, /class="option correct"/);
  assert.match(html, /class="option dim"/);
  assert.match(html, /Payment System handles payments\./);
  assert.match(html, /<h3>[^<]*<\/h3>/, "the explanation panel is drawn");
  assert.ok(clicks.every((item) => item.props.disabled || item.props["data-usage"] !== "review.option"), "an answered question is not answered twice");
});

/* The session hook for an embedding page. Rendered on the server the hook returns its API; calling it afterwards drives the real enterRun. */
function sessionOn(nav, extra = {}) {
  let api;
  const refs = { dataRef: { current: { root: "root", settings: {}, decks: [] } }, bindingRoot: { current: "root" } };
  const core = { call: async () => ({}), act: async () => undefined, notify() {}, setError() {}, busy: false, refs, askInChat() {}, refresh: async () => {} };
  function Probe() {
    api = useReviewSession({ core, nav, modalOpen: false, host: {}, rootRef: { current: null }, late: { current: {} }, ...extra });
    return null;
  }
  renderToStaticMarkup(React.createElement(Probe));
  return api;
}
const run = { id: "r", index: 0, total: 1, mode: "path", card: choiceCard };

test("entering a run takes the learner to the practice page, unless the session is embedded in another page", () => {
  const visited = [];
  const nav = (page) => ({ page, setPage: (name) => visited.push(name), show: { exam() {} } });
  sessionOn(nav("library")).enterRun(run);
  assert.deepEqual(visited, ["review"], "the practice page goes to 'review', as ever");
  visited.length = 0;
  sessionOn(nav("book-node"), { embeddedIn: "book-node" }).enterRun(run);
  assert.deepEqual(visited, [], "an embedded session leaves the page where it is");
});
