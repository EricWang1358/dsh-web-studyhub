import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadUi } from "./helpers/ui-module.mjs";
import { loadInteractiveUi, withBrowserGlobals } from "./helpers/react-harness.mjs";

const {
  getUiLanguage,
  loadEnglishCatalogue,
  setUiLanguage,
  clearCompletedTermEntries,
  collectInFlightTerms,
  fillQuestion,
  filterCandidateTerms,
  mergeAdjacent,
  normalizeTerm,
  partitionMarkedTerms,
  toggleTerm,
  wordAt,
  collectAllHighlightEntries,
  collectBlockSegments,
  isAllowedTextNode,
  isExcludedElement,
  TermChips,
  ExplanationFollowup,
  formatAssistTaskSummary,
} = await loadUi(`
  export * from "./ui/i18n.js";
  export * from "./ui/review/term-marks.js";
  export * from "./ui/review/term-marking-dom.js";
  export { default as TermChips } from "./ui/review/TermChips.jsx";
  export { default as ExplanationFollowup } from "./ui/ExplanationFollowup.jsx";
  export { formatAssistTaskSummary } from "./ui/review/assist-summary.js";
`);

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
  assert.deepEqual(atLimit.terms, ["词1", "词2", "词3", "词4", "词5", "词6"]);

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

test("term-marking-dom allows inline <code> and fenced <pre><code> while keeping .md-code-head and .katex excluded", () => {
  const mkText = (data) => ({ nodeType: 3, data, parentElement: null });
  const mkEl = (tagName, { classes = [], attrs = {}, open = false, children = [] } = {}) => {
    const el = {
      nodeType: 1,
      tagName: tagName.toUpperCase(),
      open,
      parentElement: null,
      childNodes: children,
      matches(selector) {
        return selector.split(",").map((s) => s.trim()).some((part) => {
          if (part.startsWith(".")) return classes.includes(part.slice(1));
          if (part === '[aria-hidden="true"]') return attrs["aria-hidden"] === "true";
          if (part === "button:not(.option)") return el.tagName === "BUTTON" && !classes.includes("option");
          if (part === "button.option") return el.tagName === "BUTTON" && classes.includes("option");
          return el.tagName === part.toUpperCase();
        });
      },
      contains(target) {
        if (target === el) return true;
        for (const child of el.childNodes) {
          if (child === target) return true;
          if (child.nodeType === 1 && child.contains(target)) return true;
        }
        return false;
      },
    };
    for (const child of children) child.parentElement = el;
    return el;
  };
  const doc = {
    createRange() {
      const r = { startContainer: null, startOffset: 0, endContainer: null, endOffset: 0 };
      r.setStart = (n, o) => { r.startContainer = n; r.startOffset = o; };
      r.setEnd = (n, o) => { r.endContainer = n; r.endOffset = o; };
      return r;
    },
  };

  const inlineCodeText = mkText("s3.intern()");
  const inlineCode = mkEl("code", { children: [inlineCodeText] });
  const builderCodeText = mkText("StringBuilder");
  const builderCode = mkEl("code", { children: [builderCodeText] });
  const langText = mkText("java");
  const langSpan = mkEl("span", { classes: ["md-code-lang"], children: [langText] });
  const copyBtn = mkEl("button", { classes: ["md-code-copy"], children: [mkText("复制")] });
  const codeHead = mkEl("div", { classes: ["md-code-head"], children: [langSpan, copyBtn] });
  const fencedText = mkText('String s3 = new String("hello");\ns3.intern();\njava.lang.String');
  const fencedCode = mkEl("code", { children: [fencedText] });
  const fencedPre = mkEl("pre", { classes: ["md-code"], children: [fencedCode] });
  const secondPreText = mkText("pool.intern()");
  const secondPre = mkEl("pre", { classes: ["md-code"], children: [mkEl("code", { children: [secondPreText] })] });
  const katexText = mkText("intern");
  const katexSpan = mkEl("span", { classes: ["katex"], children: [katexText] });

  const body = mkEl("div", {
    children: [
      mkEl("p", {
        children: [mkText("JDK7"), inlineCode, mkText("now and "), builderCode, katexSpan],
      }),
      mkEl("div", {
        classes: ["md-code-block"],
        children: [codeHead, fencedPre],
      }),
      secondPre,
    ],
  });

  // Inline code and fenced code are allowed; header chrome and KaTeX stay excluded.
  assert.equal(isExcludedElement(inlineCode, body), false);
  assert.equal(isAllowedTextNode(inlineCodeText, body), true);
  assert.equal(isExcludedElement(fencedPre, body), false);
  assert.equal(isExcludedElement(fencedCode, body), false);
  assert.equal(isAllowedTextNode(fencedText, body), true);
  assert.equal(isExcludedElement(codeHead, body), true);
  assert.equal(isExcludedElement(langSpan, body), true);
  assert.equal(isAllowedTextNode(langText, body), false);
  assert.equal(isExcludedElement(copyBtn, body), true);
  assert.equal(isExcludedElement(katexSpan, body), true);
  assert.equal(isAllowedTextNode(katexText, body), false);

  // Separate <pre> blocks produce distinct block segments.
  const segments = collectBlockSegments(body, doc);
  assert.equal(segments.length, 3);
  assert.equal(segments[1].text, fencedText.data);
  assert.equal(segments[2].text, secondPreText.data);

  // Full inline code adjacent to ASCII letters ("JDK7" + <code>s3.intern()</code> + "now") matches strictly inside <code>.
  const fullCodeRes = collectAllHighlightEntries(doc, body, { activeTerms: ["s3.intern()"] });
  assert.equal(fullCodeRes.active.ranges.length, 2);
  assert.equal(fullCodeRes.active.ranges[0].startContainer, inlineCodeText);
  assert.equal(fullCodeRes.active.ranges[0].startOffset, 0);
  assert.equal(fullCodeRes.active.ranges[0].endContainer, inlineCodeText);
  assert.equal(fullCodeRes.active.ranges[0].endOffset, "s3.intern()".length);
  assert.equal(fullCodeRes.active.ranges[1].startContainer, fencedText);

  // Substring "intern" matches in inline <code> and both <pre><code> blocks, skips .katex.
  // "java" matches inside <pre><code> but skips .md-code-head (.md-code-lang).
  const subRes = collectAllHighlightEntries(doc, body, {
    activeTerms: ["intern", "java"],
    seenTerms: ["intern"],
  });
  assert.equal(subRes.active.ranges.length, 4); // 3x intern + 1x java in <pre><code>
  assert.equal(subRes.seen.ranges.length, 3);
  assert.equal(subRes.active.spans.some((s) => s.node === langText), false);
  assert.equal(subRes.active.spans.some((s) => s.node === katexText), false);

  // Explicit single-node drag hit highlights an intra-identifier substring ("Builder" in "StringBuilder")
  // without breaking ASCII boundary protection for unrelated words ("in" inside "intern").
  const hitRes = collectAllHighlightEntries(doc, body, {
    activeTerms: ["Builder", "in"],
    activeHits: [{ node: builderCodeText, start: 6, end: 13, term: "Builder" }],
  });
  assert.equal(hitRes.active.ranges.length, 1);
  assert.equal(hitRes.active.ranges[0].startContainer, builderCodeText);
  assert.equal(hitRes.active.ranges[0].startOffset, 6);
  assert.equal(hitRes.active.ranges[0].endOffset, 13);
});

test("collectInFlightTerms and partitionMarkedTerms separate in-flight terms from newly marked pending terms across concurrent jobs", () => {
  const assistTasks = [
    { id: "t1", mode: "terms", status: "running", cardId: "c1", terms: ["常量折叠"] },
    { id: "t2", mode: "terms", status: "running", cardId: "c1", terms: ["内联", "常量折叠"] },
    { id: "t3", mode: "terms", status: "done", cardId: "c1", terms: ["逃逸分析"] },
    { id: "t4", mode: "terms", status: "running", cardId: "c2", terms: ["其他卡词"] },
    { id: "t5", mode: "ask", status: "running", cardId: "c1", terms: ["非补词"] },
  ];

  assert.deepEqual(collectInFlightTerms(assistTasks, "c1"), ["常量折叠", "内联"]);
  assert.deepEqual(collectInFlightTerms(assistTasks, "c1", ["内联", "栈上分配"]), ["常量折叠", "内联", "栈上分配"]);
  assert.deepEqual(collectInFlightTerms(assistTasks, "c2"), ["其他卡词"]);

  const part = partitionMarkedTerms(["常量折叠", "内联", "JIT"], ["常量折叠", "jit"]);
  assert.deepEqual(part.inFlightTerms, ["常量折叠", "JIT"]);
  assert.deepEqual(part.pendingTerms, ["内联"]);
});

test("TermChips stays enabled for newly marked pending terms while earlier terms fill in background and submits only pendingTerms", async () => {
  await loadEnglishCatalogue();
  const prev = getUiLanguage();
  try {
    setUiLanguage("zh");

    // 1. Only 常量折叠 is marked and already filling -> button is disabled/spinning with count 1; chip has no remove button.
    const allInFlightHtml = renderToStaticMarkup(
      React.createElement(TermChips, {
        terms: ["常量折叠"],
        inFlightTerms: ["常量折叠"],
        running: true,
      }),
    );
    assert.match(allInFlightHtml, /data-filling="true"/);
    assert.doesNotMatch(allInFlightHtml, /移除生词「常量折叠」/);
    assert.match(allInFlightHtml, /<button[^>]*term-strip__fill[^>]*disabled=""[^>]*aria-busy="true"/);
    assert.match(allInFlightHtml, />补齐这 1 个词</);

    // 2. While 常量折叠 is filling, user marks 内联 -> button stays ENABLED (not spinning), shows count 1, and submits ONLY ["内联"].
    const mixedEl = React.createElement(TermChips, {
      terms: ["常量折叠", "内联"],
      inFlightTerms: ["常量折叠"],
      candidates: ["逃逸分析"],
      running: true,
    });
    const mixedHtml = renderToStaticMarkup(mixedEl);
    assert.match(mixedHtml, /data-filling="true"[^>]*>.*常量折叠/);
    assert.doesNotMatch(mixedHtml, /移除生词「常量折叠」/);
    assert.match(mixedHtml, /移除生词「内联」/);
    assert.match(mixedHtml, /term-strip__candidate/);
    assert.doesNotMatch(mixedHtml, /term-strip__fill[^>]*disabled=""/);
    assert.doesNotMatch(mixedHtml, /term-strip__fill[^>]*aria-busy="true"/);
    assert.match(mixedHtml, />补齐这 1 个词</);

    // Verify clicking the fill button targets ONLY pendingTerms (["内联"]), not ["常量折叠", "内联"].
    const submitted = [];
    const capturedButtons = [];
    const cjsReact = (await import("node:module")).createRequire(import.meta.url)("react");
    const origCreateElement = cjsReact.createElement;
    cjsReact.createElement = (type, props, ...children) => {
      if (props?.className === "term-strip__fill") capturedButtons.push(props);
      return origCreateElement(type, props, ...children);
    };
    try {
      renderToStaticMarkup(
        origCreateElement(TermChips, {
          terms: ["常量折叠", "内联"],
          inFlightTerms: ["常量折叠"],
          running: true,
          onFill: (list) => submitted.push(list),
        }),
      );
    } finally {
      cjsReact.createElement = origCreateElement;
    }
    const fillBtnProps = capturedButtons[0];
    assert.ok(fillBtnProps, "fill button props captured during React render");
    assert.equal(fillBtnProps.busy, false);
    assert.equal(fillBtnProps.disabled, false);
    fillBtnProps.onClick();
    assert.deepEqual(submitted, [["内联"]]);

    // 3. Once 内联 is also submitted (both inFlight) -> button becomes disabled/spinning again with count 2.
    const bothInFlightHtml = renderToStaticMarkup(
      React.createElement(TermChips, {
        terms: ["常量折叠", "内联"],
        inFlightTerms: ["常量折叠", "内联"],
        running: true,
      }),
    );
    assert.match(bothInFlightHtml, /<button[^>]*term-strip__fill[^>]*disabled=""[^>]*aria-busy="true"/);
    assert.match(bothInFlightHtml, />补齐这 2 个词</);
    assert.equal(formatAssistTaskSummary({ mode: "terms", terms: ["常量折叠", "内联"] }), "常量折叠、内联");

    // 4. English locale singular/plural counts stay accurate.
    setUiLanguage("en");
    const enMixedHtml = renderToStaticMarkup(
      React.createElement(TermChips, {
        terms: ["constant folding", "inlining"],
        inFlightTerms: ["constant folding"],
        running: true,
      }),
    );
    assert.doesNotMatch(enMixedHtml, /term-strip__fill[^>]*disabled=""/);
    assert.match(enMixedHtml, />Fill in this 1 word</);
    assert.equal(formatAssistTaskSummary({ mode: "terms", terms: ["constant folding", "inlining"] }), "constant folding, inlining");
  } finally {
    setUiLanguage(prev);
  }
});

// Minimal fake DOM for useTermMarking: one paragraph in a .review-body-like container, caret hit-test returns
// "linearizability". The returned helpers run the listeners the hook registered on the body and the document.
async function mountTermMarkingFixture() {
  const interactive = await loadInteractiveUi(`
    export { useTermMarking } from "./ui/review/use-term-marking.js";
  `);
  const bodyListeners = new Map();
  const docListeners = new Map();
  const listen = (store) => ({
    addEventListener: (type, fn) => {
      if (!store.has(type)) store.set(type, new Set());
      store.get(type).add(fn);
    },
    removeEventListener: (type, fn) => {
      store.get(type)?.delete(fn);
    },
  });
  const textNode = { nodeType: 3, data: "Systems balance linearizability carefully." };
  const pEl = {
    nodeType: 1,
    tagName: "P",
    parentElement: null,
    childNodes: [textNode],
    closest: () => null,
    matches: () => false,
  };
  textNode.parentElement = pEl;
  const doc = {
    ...listen(docListeners),
    defaultView: { getSelection: () => ({ isCollapsed: true, rangeCount: 0 }) },
    caretPositionFromPoint: () => ({ offsetNode: textNode, offset: 18 }),
    createRange: () => ({
      setStart() {},
      setEnd() {},
      getClientRects: () => [{ left: 10, right: 120, top: 10, bottom: 30, width: 110, height: 20 }],
    }),
  };
  const body = {
    ...listen(bodyListeners),
    nodeType: 1,
    tagName: "DIV",
    ownerDocument: doc,
    childNodes: [pEl],
    contains: (node) => node === body || node === pEl || node === textNode,
    closest: () => null,
    matches: () => false,
  };
  pEl.parentElement = body;
  const session = {
    run: { id: "r1", index: 0, mode: "path", card: { id: "c1", prompt: "Q" } },
    markingTerms: true,
    actions: { toggleMarkTerms() {}, exitMarkTerms() {} },
  };
  const hook = interactive.mountHook(
    (props) => interactive.exports.useTermMarking(props),
    { session, reviewBodyRef: { current: body } },
  );
  const fire = (store, type, event) => {
    for (const fn of [...(store.get(type) || [])]) fn(event);
  };
  return {
    hook,
    ev: { button: 0, clientX: 50, clientY: 20, target: pEl, preventDefault() {}, stopPropagation() {} },
    down: (event) => fire(bodyListeners, "pointerdown", event),
    up: (event) => fire(docListeners, "pointerup", event),
    click: (event) => fire(bodyListeners, "click", event),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("useTermMarking suppresses the paired click after pointerup even when >250ms elapses (#1759)", async () => {
  await withBrowserGlobals(async () => {
    const { hook, ev, down, up, click } = await mountTermMarkingFixture();
    const prevNow = Date.now;
    let fakeNow = 1000;
    Date.now = () => fakeNow;
    try {
      // 1. Real pointer click whose paired click fires 400ms after pointerup (exceeding the old 250ms wall-clock window).
      await hook.act(() => {
        down(ev);
        up(ev);
        fakeNow += 400;
        click(ev);
      });
      assert.deepEqual(hook.current.terms, ["linearizability"], "paired click does not double-toggle off a word marked on pointerup");

      // 2. After the paired click cleared suppression, a standalone synthetic click (no pointerup) still toggles the word off.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await hook.act(() => {
        click(ev);
      });
      assert.deepEqual(hook.current.terms, [], "standalone synthetic click still toggles cleanly");
    } finally {
      hook.unmount();
      Date.now = prevNow;
    }
  });
});

test("useTermMarking keeps suppressing a touch tap's paired click that arrives in a later task (#1759 follow-up)", async () => {
  await withBrowserGlobals(async () => {
    const { hook, ev, down, up, click } = await mountTermMarkingFixture();
    try {
      // Chromium synthesizes the click of a touch or pen tap in a later task, so it can land after a macrotask
      // (a slow machine, a heavy render). The word must stay marked, not be toggled off by the same tap.
      for (const delay of [50, 300]) {
        await hook.act(() => {
          down(ev);
          up(ev);
        });
        assert.deepEqual(hook.current.terms, ["linearizability"], `marked on pointerup (${delay}ms case)`);
        await sleep(delay);
        await hook.act(() => {
          click(ev);
        });
        assert.deepEqual(hook.current.terms, ["linearizability"], `late paired click (${delay}ms) is swallowed`);
        // The paired click consumed the flag, so the next full tap (pointerdown, pointerup, click) unmarks cleanly.
        await hook.act(() => {
          down(ev);
          up(ev);
          click(ev);
        });
        assert.deepEqual(hook.current.terms, [], `next tap unmarks (${delay}ms case)`);
      }
    } finally {
      hook.unmount();
    }
  });
});

test("useTermMarking: a click with no coordinates between a tap and its late paired click does not use up the suppression (#1759 follow-up)", async () => {
  await withBrowserGlobals(async () => {
    const { hook, ev, down, up, click } = await mountTermMarkingFixture();
    try {
      await hook.act(() => {
        down(ev);
        up(ev);
      });
      assert.deepEqual(hook.current.terms, ["linearizability"], "marked on pointerup");
      // Keyboard Enter or el.click() lands in between: it reports 0,0 and is never used for marking.
      await hook.act(() => {
        click({ ...ev, clientX: 0, clientY: 0 });
      });
      assert.deepEqual(hook.current.terms, ["linearizability"], "a coordinate-less click changes nothing");
      await sleep(50);
      await hook.act(() => {
        click(ev);
      });
      assert.deepEqual(hook.current.terms, ["linearizability"], "the tap's own late paired click is still swallowed");
    } finally {
      hook.unmount();
    }
  });
});

test("useTermMarking clears click suppression on the next pointerdown (#1759 follow-up)", async () => {
  await withBrowserGlobals(async () => {
    const { hook, ev, down, up, click } = await mountTermMarkingFixture();
    try {
      await hook.act(() => {
        down(ev);
        up(ev);
      });
      assert.deepEqual(hook.current.terms, ["linearizability"]);
      // A new gesture starts but its pointerup never marks anything (excluded target, moved too far) and the
      // earlier tap's click never came. The stale flag must not eat this gesture's click, so it toggles the word off.
      await hook.act(() => {
        down(ev);
        click(ev);
      });
      assert.deepEqual(hook.current.terms, [], "click after a new pointerdown is not swallowed by the previous tap's flag");
    } finally {
      hook.unmount();
    }
  });
});

test("useTermMarking backstop timer releases suppression when no paired click arrives (#1759 follow-up)", async () => {
  await withBrowserGlobals(async () => {
    const { hook, ev, down, up, click } = await mountTermMarkingFixture();
    const realSetTimeout = globalThis.setTimeout;
    const recorded = [];
    try {
      // Record the timers armed by the pointerup so the test fires them by hand instead of racing the clock.
      globalThis.setTimeout = (fn, ms, ...rest) => {
        const handle = realSetTimeout(fn, ms, ...rest);
        recorded.push({ fn, ms: ms ?? 0, handle });
        return handle;
      };
      await hook.act(() => {
        down(ev);
        up(ev);
      });
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    try {
      assert.deepEqual(hook.current.terms, ["linearizability"]);
      const backstop = recorded.find((t) => t.ms >= 500);
      assert.ok(backstop, `a long backstop timer (>=500ms) is armed instead of a short wall-clock race; saw ${JSON.stringify(recorded.map((t) => t.ms))}`);
      assert.ok(!recorded.some((t) => t.ms < 500), "no short timer that could fire before a late touch click");
      // A drag ended outside .review-body, so no click ever arrives. The backstop fires, then an unrelated click works.
      await hook.act(() => {
        backstop.fn();
      });
      await hook.act(() => {
        click(ev);
      });
      assert.deepEqual(hook.current.terms, [], "after the backstop an independent click toggles normally");
    } finally {
      for (const t of recorded) clearTimeout(t.handle);
      hook.unmount();
    }
  });
});
