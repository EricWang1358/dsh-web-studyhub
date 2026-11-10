import test from "node:test";
import assert from "node:assert/strict";
import * as shared from "../lib/stem-similarity.js";
import * as coach from "../lib/exam-coach.js";

/* #890 S1: the near-duplicate measure of question stems lives in ONE pure module (lib/stem-similarity.js). The exam coach and the draft's
   similar-question check both use it, and the indexed search (only stems that share a rare bigram are compared) finds exactly the pairs that
   comparing every pair with stemSimilarity would find. */

test("the exam coach uses the shared function and threshold, not a copy", () => {
  assert.equal(coach.stemSimilarity, shared.stemSimilarity);
  assert.equal(coach.normalizeStemForComparison, shared.normalizeStemForComparison);
  assert.equal(coach.NEAR_DUPLICATE_SIMILARITY, shared.NEAR_DUPLICATE_SIMILARITY);
  assert.equal(shared.NEAR_DUPLICATE_SIMILARITY, 0.72);
});

test("stemSimilarity keeps its meaning: punctuation, spacing and case do not count, repeated bigrams count as often as they occur", () => {
  assert.equal(shared.stemSimilarity("什么是熵？", "什么是 熵"), 1);
  assert.equal(shared.stemSimilarity("", "什么是熵"), 0);
  assert.equal(shared.stemSimilarity("a", "a"), 1);
  assert.equal(shared.stemSimilarity("a", "b"), 0);
  assert.equal(shared.stemSimilarity("a", "ab"), 0);
  // "aaaa" has the bigram "aa" three times, "aa" once: Dice over the multiset is 2*1/(3+1).
  assert.equal(shared.stemSimilarity("aaaa", "aa"), 0.5);
  assert.ok(shared.stemSimilarity("请简要解释熵在信息论中的含义", "请简要说明熵在信息论中的含义") >= 0.72);
  assert.ok(shared.stemSimilarity("什么是进程调度", "TCP 三次握手的作用") < 0.1);
});

/* A small deterministic generator: stems built from a few shared phrases, so that some pairs are near-duplicates and most are not. */
function corpus(count, seed = 7) {
  let x = seed;
  const next = () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x >>> 16; };
  const parts = ["进程调度", "页面置换", "死锁的必要条件", "信号量", "下列哪一项", "关于", "正确的是", "请解释", "的含义", "TCP 握手", "虚拟内存", "缓存一致性", "为什么", "举例说明"];
  return Array.from({ length: count }, () => Array.from({ length: 2 + (next() % 4) }, () => parts[next() % parts.length]).join(next() % 2 ? "，" : ""));
}

const brute = (texts, probes, threshold) => {
  const out = [];
  for (const i of probes) for (let j = 0; j < texts.length; j += 1) {
    if (i === j) continue;
    const similarity = shared.stemSimilarity(texts[i], texts[j]);
    if (similarity >= threshold) out.push([i, j, similarity]);
  }
  return out;
};
const sorted = (pairs) => pairs.map(([i, j, s]) => `${i}:${j}:${s}`).sort();

test("the indexed search finds exactly the pairs that comparing every pair finds, never a stem with itself", () => {
  const texts = [...corpus(400), "", "a", "a", "b", "aaaa", "aa", "什么是熵？", "什么是 熵"];
  const probes = texts.map((_, index) => index).filter((index) => index % 3 === 0 || index >= 400);
  for (const threshold of [shared.NEAR_DUPLICATE_SIMILARITY, 0.5, 0.9, 1]) {
    const found = shared.similarStemPairs(texts, { probes, threshold });
    assert.deepEqual(sorted(found), sorted(brute(texts, probes, threshold)), `threshold ${threshold}`);
    assert.ok(found.every(([i, j]) => i !== j));
  }
  assert.ok(shared.similarStemPairs(texts, { probes }).length > 0, "the corpus has near-duplicates to find");
});

test("without probes every stem is searched; identical stems are found both ways", () => {
  const pairs = shared.similarStemPairs(["什么是熵？", "什么是熵", "完全无关的题目"]);
  assert.deepEqual(sorted(pairs), sorted([[0, 1, 1], [1, 0, 1]]));
});

/* Stems of a small English vocabulary share many bigrams: the case where the position filter, not the prefix alone, keeps the exact checks few. */
function englishCorpus(count, seed = 11) {
  let x = seed;
  const next = () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x >>> 16; };
  const words = ["process", "thread", "scheduler", "deadlock", "semaphore", "page", "memory", "cache", "kernel", "mode", "aaaa", "ssss", "is"];
  const frames = [["Which statement about ", " is correct?"], ["Explain ", "."], ["What is the purpose of ", "?"]];
  return Array.from({ length: count }, () => { const [head, tail] = frames[next() % frames.length]; return `${head}${Array.from({ length: 1 + (next() % 5) }, () => words[next() % words.length]).join(" ")}${tail}`; });
}

test("on a small English vocabulary the search still equals comparing every pair, and compares far fewer pairs", () => {
  const texts = englishCorpus(300);
  const probes = texts.map((_, index) => index).filter((index) => index % 5 === 0);
  for (const threshold of [shared.NEAR_DUPLICATE_SIMILARITY, 0.4, 0.95]) {
    const stats = {};
    const found = shared.similarStemPairs(texts, { probes, threshold, stats });
    assert.deepEqual(sorted(found), sorted(brute(texts, probes, threshold)), `threshold ${threshold}`);
    assert.ok(stats.compared <= stats.candidates && stats.candidates <= probes.length * texts.length, JSON.stringify(stats));
  }
  const stats = {};
  shared.similarStemPairs(texts, { probes, stats });
  assert.ok(stats.compared < (probes.length * texts.length) / 4, `exact checks ${stats.compared} of ${probes.length * texts.length} pairs`);
});

test("a threshold outside (0, 1] is refused: at 0 every pair would match", () => {
  for (const threshold of [0, -0.1, 1.5, Number.NaN]) assert.throws(() => shared.similarStemPairs(["a", "b"], { threshold }), RangeError);
});
