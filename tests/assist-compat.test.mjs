import test from "node:test";
import assert from "node:assert/strict";
import { submitAssist } from "../ui/assist-request.js";
import { normalizeAssistRequest } from "../lib/assist.js";

test("plain explanation submits to a loaded backend predating the plain option", async () => {
  const attempts = [];
  const call = async (action, args) => {
    assert.equal(action, "assist.start");
    attempts.push(args);
    // The pre-plain backend rejects this option before starting a task.
    if (args.helpChoices.includes("plain")) throw new Error("帮助方式不正确");
    return normalizeAssistRequest(args.mode, args.text, args.helpChoices);
  };
  const result = await submitAssist(call, { mode: "ask", text: "为什么？", helpChoices: ["plain", "prerequisite"], cardId: "c" });
  assert.equal(attempts.length, 2);
  assert.deepEqual(result.choices, ["prerequisite"]);
  assert.match(result.question, /比喻/);
  assert.match(result.question, /对应回题目/);
  assert.match(result.question, /不成立/);
  assert.match(result.question, /为什么？/);
  assert.equal(attempts[1].cardId, "c");
});

test("current backend receives the original choices exactly once", async () => {
  let count = 0;
  const result = await submitAssist(async (_action, args) => {
    count++;
    return normalizeAssistRequest(args.mode, args.text, args.helpChoices);
  }, { mode: "ask", text: "", helpChoices: ["plain", "angle", "example", "steps", "prerequisite", "mistake"] });
  assert.equal(count, 1);
  assert.equal(result.choices.length, 6);
});

test("unrelated failures never retry or create duplicate assistant jobs", async () => {
  for (const message of ["network unavailable", "当前宿主暂不支持后台助教"]) {
    let count = 0;
    await assert.rejects(submitAssist(async () => { count++; throw new Error(message); },
      { mode: "ask", text: "", helpChoices: ["plain"] }), { message });
    assert.equal(count, 1);
  }
});

test("legacy fallback accepts plain alone and all six options without losing the other choices", async () => {
  for (const helpChoices of [["plain"], ["plain", "angle", "example", "steps", "prerequisite", "mistake"]]) {
    let started = 0;
    const result = await submitAssist(async (_action, args) => {
      if (args.helpChoices.length > 5 || args.helpChoices.includes("plain")) throw new Error("帮助方式不正确");
      const normalized = normalizeAssistRequest(args.mode, args.text, args.helpChoices);
      started++;
      return normalized;
    }, { mode: "ask", text: "", helpChoices });
    assert.equal(started, 1);
    assert.deepEqual(result.choices, helpChoices.filter((choice) => choice !== "plain"));
    assert.match(result.question, /比喻/);
  }
});

test("legacy compatibility never bypasses invalid choices or truncates a learner's question", async () => {
  await assert.rejects(submitAssist(async (_action, args) => {
    if (args.helpChoices.includes("plain")) throw new Error("帮助方式不正确");
    return normalizeAssistRequest(args.mode, args.text, args.helpChoices);
  }, { mode: "ask", text: "", helpChoices: ["plain", "unknown"] }), /帮助方式不正确/);
  let attempts = 0;
  const request = { mode: "ask", text: "疑".repeat(1000), helpChoices: ["plain"] };
  await assert.rejects(submitAssist(async () => { attempts++; throw new Error("帮助方式不正确"); }, request),
    { message: "请把疑问控制在 1000 字以内" });
  assert.equal(attempts, 1);
  assert.equal(request.text.length, 1000);
  assert.deepEqual(request.helpChoices, ["plain"]);
});

test("English legacy fallback reports an oversized question in English without retrying", async () => {
  let attempts = 0;
  const request = { mode: "ask", text: "x".repeat(1000), helpChoices: ["plain"], uiLanguage: "en" };
  await assert.rejects(submitAssist(async () => {
    attempts++;
    throw new Error("Invalid help mode");
  }, request), { message: "Keep your question within 1,000 characters" });
  assert.equal(attempts, 1);
  assert.equal(request.text, "x".repeat(1000));
  assert.deepEqual(request.helpChoices, ["plain"]);
});
