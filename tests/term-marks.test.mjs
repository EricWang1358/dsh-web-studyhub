import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadUi } from "./helpers/ui-module.mjs";

const {
  getUiLanguage,
  loadEnglishCatalogue,
  setUiLanguage,
  MAX_MARKED_TERMS,
  MAX_TERM_LENGTH,
  clearCompletedTermEntries,
  fillQuestion,
  filterCandidateTerms,
  mergeAdjacent,
  normalizeTerm,
  toggleTerm,
  wordAt,
  TermChips,
  ExplanationFollowup,
  formatAssistTaskSummary,
} = await loadUi(`
  export * from "./ui/i18n.js";
  export * from "./ui/review/term-marks.js";
  export { default as TermChips } from "./ui/review/TermChips.jsx";
  export { default as ExplanationFollowup } from "./ui/ExplanationFollowup.jsx";
  export { formatAssistTaskSummary } from "./ui/review/assist-summary.js";
`);

test("term mark constants match spec", () => {
  assert.equal(MAX_MARKED_TERMS, 6);
  assert.equal(MAX_TERM_LENGTH, 60);
});

test("normalizeTerm trims, collapses spaces, rejects newlines and >60 chars", () => {
  assert.equal(normalizeTerm("  逆否命题  "), "逆否命题");
  assert.equal(normalizeTerm("  gradient\t\t  descent  "), "gradient descent");
  assert.equal(normalizeTerm("   "), "");
  assert.equal(normalizeTerm(""), "");
  assert.equal(normalizeTerm(null), "");
  assert.equal(normalizeTerm("第一行\n第二行"), "");
  assert.equal(normalizeTerm("hello\rworld"), "");
  assert.equal(normalizeTerm("hello\n"), "");

  const sixty = "a".repeat(60);
  const sixtyOne = "a".repeat(61);
  assert.equal(normalizeTerm(` ${sixty} `), sixty);
  assert.equal(normalizeTerm(sixtyOne), "");
});

test("wordAt extracts Chinese, English, and mixed words and returns null on whitespace or punctuation", () => {
  const mixed = "用 Attention 机制做梯度下降，效果很好。";
  const attStart = mixed.indexOf("Attention");
  const attHit = wordAt(mixed, attStart + 3, "zh-CN");
  assert.deepEqual(attHit, { term: "Attention", start: attStart, end: attStart + "Attention".length });

  const gradIdx = mixed.indexOf("梯度");
  const zhHit = wordAt(mixed, gradIdx, "zh-CN");
  assert.ok(zhHit && zhHit.term.includes("梯"));
  assert.equal(mixed.slice(zhHit.start, zhHit.end), zhHit.term);

  // Space and punctuation return null.
  assert.equal(wordAt(mixed, attStart - 1, "zh-CN"), null);
  assert.equal(wordAt(mixed, mixed.indexOf("，"), "zh-CN"), null);
  assert.equal(wordAt(mixed, mixed.indexOf("。"), "zh-CN"), null);
  assert.equal(wordAt(mixed, -1, "zh-CN"), null);
  assert.equal(wordAt(mixed, mixed.length, "zh-CN"), null);

  // English locale extracts whole English words cleanly.
  const en = "Contrapositive equivalence, please.";
  const eqIdx = en.indexOf("equivalence");
  assert.deepEqual(wordAt(en, eqIdx + 4, "en-US"), {
    term: "equivalence",
    start: eqIdx,
    end: eqIdx + "equivalence".length,
  });
  assert.equal(wordAt(en, eqIdx - 1, "en-US"), null);
  assert.equal(wordAt(en, en.indexOf(","), "en-US"), null);
});

test("mergeAdjacent merges contiguous hits inside the same text node up to 60 chars", () => {
  const nodeA = { id: "a" };
  const nodeB = { id: "b" };

  const entries = [{ node: nodeA, start: 0, end: 2, term: "逆否" }];
  const res1 = mergeAdjacent(entries, { node: nodeA, start: 2, end: 4, term: "命题" });
  assert.equal(res1.merged, true);
  assert.deepEqual(res1.replaced, ["逆否"]);
  assert.deepEqual(res1.entry, { node: nodeA, start: 0, end: 4, term: "逆否命题" });
  assert.deepEqual(res1.entries, [{ node: nodeA, start: 0, end: 4, term: "逆否命题" }]);

  // Reverse click order (right then left) also merges.
  const resReverse = mergeAdjacent([{ node: nodeA, start: 2, end: 4, term: "命题" }], { node: nodeA, start: 0, end: 2, term: "逆否" });
  assert.equal(resReverse.merged, true);
  assert.deepEqual(resReverse.entry, { node: nodeA, start: 0, end: 4, term: "逆否命题" });

  // Bridging two separate hits in the same text node merges all three.
  const bridging = mergeAdjacent(
    [
      { node: nodeA, start: 0, end: 2, term: "分布" },
      { node: nodeA, start: 3, end: 5, term: "一致" },
    ],
    { node: nodeA, start: 2, end: 3, term: "式" },
  );
  assert.equal(bridging.merged, true);
  assert.deepEqual(bridging.entry, { node: nodeA, start: 0, end: 5, term: "分布式一致" });

  // Different node does not merge.
  const diffNode = mergeAdjacent(res1.entries, { node: nodeB, start: 4, end: 6, term: "逻辑" });
  assert.equal(diffNode.merged, false);
  assert.equal(diffNode.entries.length, 2);

  // Gap between offsets does not merge.
  const gapped = mergeAdjacent(res1.entries, { node: nodeA, start: 5, end: 7, term: "逻辑" });
  assert.equal(gapped.merged, false);
  assert.equal(gapped.entries.length, 2);

  // Exceeding 60 chars prevents merge.
  const longLeft = [{ node: nodeA, start: 0, end: 40, term: "x".repeat(40) }];
  const tooLong = mergeAdjacent(longLeft, { node: nodeA, start: 40, end: 61, term: "y".repeat(21) });
  assert.equal(tooLong.merged, false);
  assert.equal(tooLong.entries.length, 2);
});

test("toggleTerm adds, removes, and enforces MAX_MARKED_TERMS = 6", () => {
  let list = [];
  for (let i = 1; i <= 6; i++) {
    const res = toggleTerm(list, `词${i}`);
    assert.equal(res.added, true);
    assert.equal(res.removed, false);
    assert.equal(res.limitReached, false);
    list = res.terms;
  }
  assert.equal(list.length, 6);

  // 7th distinct term hits limit.
  const atLimit = toggleTerm(list, "词7");
  assert.equal(atLimit.added, false);
  assert.equal(atLimit.removed, false);
  assert.equal(atLimit.limitReached, true);
  assert.equal(atLimit.terms.length, 6);

  // Existing term can still be toggled off when full.
  const toggledOff = toggleTerm(list, "词3");
  assert.equal(toggledOff.added, false);
  assert.equal(toggledOff.removed, true);
  assert.equal(toggledOff.limitReached, false);
  assert.deepEqual(toggledOff.terms, ["词1", "词2", "词4", "词5", "词6"]);
});

test("fillQuestion formats zh and en prompts cleanly", async () => {
  await loadEnglishCatalogue();
  const prev = getUiLanguage();
  try {
    setUiLanguage("zh");
    assert.equal(
      fillQuestion(["逆否命题", "充分条件"], "zh"),
      "这几个词我不认识：逆否命题、充分条件。请一个一个讲：它是为了解决什么问题才出现的，大白话怎么说，正式说法是什么。",
    );
    assert.equal(fillQuestion([], "zh"), "");
    assert.equal(fillQuestion(["\n", "  "], "zh"), "");

    assert.equal(
      fillQuestion(["contrapositive", "lemma"], "en"),
      "I don't know these terms: contrapositive, lemma. Please explain each one: what problem it exists to solve, how to put it in plain words, and what the formal wording is.",
    );

    setUiLanguage("en");
    assert.equal(
      fillQuestion(["CAP", "ACID"]),
      "I don't know these terms: CAP, ACID. Please explain each one: what problem it exists to solve, how to put it in plain words, and what the formal wording is.",
    );
  } finally {
    setUiLanguage(prev);
  }
});

test("TermChips renders labelled chips, SVG close buttons without text glyphs, and #one singular button", async () => {
  await loadEnglishCatalogue();
  const prev = getUiLanguage();
  try {
    setUiLanguage("zh");
    assert.equal(renderToStaticMarkup(React.createElement(TermChips, { terms: [] })), "");

    const zhHtml = renderToStaticMarkup(React.createElement(TermChips, { terms: ["线性一致性", "充分条件", "幂等性"] }));
    assert.match(zhHtml, /class="term-strip"/);
    assert.match(zhHtml, />生词</);
    assert.match(zhHtml, />补齐这 3 个词</);
    assert.match(zhHtml, /class="[^"]*sh-btn--secondary[^"]*term-strip__fill/);
    assert.match(zhHtml, /class="[^"]*sh-chip\b/);
    assert.match(zhHtml, /aria-label="移除生词「线性一致性」"/);
    assert.match(zhHtml, /class="[^"]*sh-icon\b/);
    assert.doesNotMatch(zhHtml, /[×✕]/);
    assert.doesNotMatch(zhHtml, /arrow-right/);

    const zhBusyHtml = renderToStaticMarkup(
      React.createElement(TermChips, { terms: ["线性一致性", "幂等性"], busy: true, running: true }),
    );
    assert.match(zhBusyHtml, /disabled=""/);
    assert.match(zhBusyHtml, /aria-busy="true"/);

    setUiLanguage("en");
    const enOneHtml = renderToStaticMarkup(React.createElement(TermChips, { terms: ["linearizability"] }));
    assert.match(enOneHtml, />Words</);
    assert.match(enOneHtml, />Fill in this 1 word</);
    assert.match(enOneHtml, /aria-label="Remove word “linearizability”"/);

    const enManyHtml = renderToStaticMarkup(React.createElement(TermChips, { terms: ["linearizability", "idempotency"] }));
    assert.match(enManyHtml, />Fill in these 2 words</);

    assert.equal(formatAssistTaskSummary({ mode: "terms", terms: ["CAP", "MVCC"] }), "CAP, MVCC");
    const followupEn = renderToStaticMarkup(
      React.createElement(ExplanationFollowup, {
        run: {
          deckId: "d",
          card: { id: "c" },
          followups: [{ id: "f1", kind: "terms", terms: ["CAP", "MVCC"], question: "raw", answer: "### CAP\n- Problem: x" }],
        },
        readOnly: true,
      }),
    );
    assert.match(followupEn, />Fill terms: CAP, MVCC</);

    setUiLanguage("zh");
    assert.equal(formatAssistTaskSummary({ mode: "terms", terms: ["CAP", "MVCC"] }), "CAP、MVCC");
    const followupZh = renderToStaticMarkup(
      React.createElement(ExplanationFollowup, {
        run: {
          deckId: "d",
          card: { id: "c" },
          followups: [{ id: "f1", kind: "terms", terms: ["线性一致性", "充分条件"], question: "raw", answer: "### 线性一致性\n- 问题：x" }],
        },
        readOnly: true,
      }),
    );
    assert.match(followupZh, />补词：线性一致性、充分条件</);
  } finally {
    setUiLanguage(prev);
  }
});

test("clearCompletedTermEntries clears completed terms & hits case-insensitively per cardId while keeping mid-task and other-card marks (#1214)", () => {
  const keyC1 = JSON.stringify(["run-1", 0, "c1", 0, 0]);
  const keyC1Rev = JSON.stringify(["run-1", 0, "c1", 0, 2]);
  const keyC2 = JSON.stringify(["run-1", 1, "c2", 0, 0]);
  const keyCustom = "custom-entry-key";
  const node1 = { id: "n1" };
  const node2 = { id: "n2" };

  const initial = {
    [keyC1]: {
      terms: ["Linearizability", "Quorum", "Consensus"],
      hits: [
        { node: node1, start: 0, end: 15, term: "Linearizability" },
        { node: node1, start: 17, end: 23, term: "Quorum" },
        { node: node1, start: 28, end: 37, term: "Consensus" },
      ],
    },
    [keyC1Rev]: {
      terms: ["linearizability"],
      hits: [{ node: node1, start: 0, end: 15, term: "linearizability" }],
    },
    [keyC2]: {
      terms: ["Linearizability", "Mutex"],
      hits: [
        { node: node2, start: 0, end: 15, term: "Linearizability" },
        { node: node2, start: 20, end: 25, term: "Mutex" },
      ],
    },
    [keyCustom]: {
      cardId: "c1",
      terms: ["Quorum", "Idempotency"],
      hits: [
        { node: node1, start: 17, end: 23, term: "Quorum" },
        { node: node1, start: 40, end: 51, term: "Idempotency" },
      ],
    },
  };

  // Non-done and non-terms tasks do not modify anything (returns original reference).
  const unchanged = clearCompletedTermEntries(initial, [
    { id: "t-run", mode: "terms", status: "running", cardId: "c1", terms: ["Linearizability"] },
    { id: "t-fail", mode: "terms", status: "failed", cardId: "c1", terms: ["Linearizability"] },
    { id: "t-err", mode: "terms", status: "error", cardId: "c1", terms: ["Linearizability"] },
    { id: "t-ask", mode: "ask", status: "done", cardId: "c1", terms: ["Linearizability"] },
  ]);
  assert.equal(unchanged, initial);

  // Completing task on c1 for ["linearizability", "quorum"] preserves "Consensus" and "Idempotency" on c1, and leaves c2 untouched.
  const next = clearCompletedTermEntries(initial, [
    { id: "t-done", mode: "terms", status: "done", cardId: "c1", terms: ["linearizability", "quorum"] },
  ]);
  assert.notEqual(next, initial);
  assert.deepEqual(next[keyC1].terms, ["Consensus"]);
  assert.deepEqual(next[keyC1].hits, [{ node: node1, start: 28, end: 37, term: "Consensus" }]);
  assert.deepEqual(next[keyC1Rev], { terms: [], hits: [] });
  assert.equal(next[keyC2], initial[keyC2]);
  assert.deepEqual(next[keyCustom], {
    cardId: "c1",
    terms: ["Idempotency"],
    hits: [{ node: node1, start: 40, end: 51, term: "Idempotency" }],
  });

  // Orphan hit range without matching entry in `terms` is also cleaned up.
  const orphanState = {
    [keyC1]: { terms: [], hits: [{ node: node1, start: 0, end: 6, term: "Quorum" }] },
  };
  const cleanedOrphan = clearCompletedTermEntries(orphanState, [
    { id: "t-orphan", mode: "terms", status: "done", cardId: "c1", terms: ["quorum"] },
  ]);
  assert.deepEqual(cleanedOrphan[keyC1], { terms: [], hits: [] });
});

test("filterCandidateTerms excludes all courseTerms states and activeTerms case-insensitively (#1242)", () => {
  const courseTerms = [
    { term: "Linearizability", state: "unknown" },
    { term: "Quorum", state: "learned" },
    { term: "Idempotency", state: "known" },
    { term: "乐观锁", state: "unknown" },
  ];
  const activeTerms = ["  Mutex  ", "互斥量"];
  const candidates = [
    "linearizability", // unknown in courseTerms -> excluded
    "QUORUM",          // learned in courseTerms -> excluded
    "idempotency",     // known in courseTerms -> excluded
    "  乐观锁 ",        // unknown in courseTerms (with spaces) -> excluded
    "mutex",           // in activeTerms (case-insensitive) -> excluded
    "互斥量",           // in activeTerms -> excluded
    "  Serializability  ", // not in courseTerms or activeTerms -> kept & normalized
    "serializability", // duplicate (case-insensitive) -> excluded
    "Consensus",       // kept
    "最终一致性",       // kept
    "   ",             // blank -> dropped
    "line1\nline2",    // multiline -> dropped
    "x".repeat(61),    // > MAX_TERM_LENGTH -> dropped
  ];

  assert.deepEqual(
    filterCandidateTerms(candidates, activeTerms, courseTerms),
    ["Serializability", "Consensus", "最终一致性"],
  );

  // Handles missing/empty inputs and courseTerms entries without an explicit state cleanly.
  assert.deepEqual(filterCandidateTerms(null, activeTerms, courseTerms), []);
  assert.deepEqual(filterCandidateTerms([], activeTerms, courseTerms), []);
  assert.deepEqual(
    filterCandidateTerms(["Raft", "Paxos"], undefined, [{ term: "raft" }]),
    ["Paxos"],
  );
});
