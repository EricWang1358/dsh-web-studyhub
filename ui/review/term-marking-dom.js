import { normalizeTerm } from "./term-marks.js";

const EXCLUDED_SELECTOR = [
  ".katex",
  ".md-code-head",
  "a",
  "input",
  "textarea",
  "select",
  "img",
  "svg",
  "summary",
  "button:not(.option)",
  ".term-strip",
  "dialog",
  ".sh-dialog",
  ".question-toolbar",
  ".review-sticky-bar",
  ".assist-area",
  ".grading",
  ".question-header",
  ".flip-control",
  ".option-letter",
  ".answer-state",
  ".practice-tip",
  ".chapter-hint",
  ".choice-feedback-wrap",
  ".sh-comp-card-jump",
  ".question-live-mastery",
  ".question-card__autopilot-bar",
  ".citation-disclosure",
  ".followup-head",
  ".followup-book",
  ".followup-actions",
  ".followup-derive",
  ".followup-picker",
  ".note-qa-button",
  ".question-book-link",
  ".socratic-inline-drawer",
  ".socratic-nudge",
  '[aria-hidden="true"]',
].join(", ");

const BLOCK_SELECTOR = "p, li, h1, h2, h3, h4, h5, h6, div, blockquote, pre, dd, dt, td, th, button.option, article, section";
const ASCII_WORD_CHAR = /[A-Za-z0-9_]/;
const ELEMENT_NODE_TYPE = typeof Node !== "undefined" ? Node.ELEMENT_NODE : 1;
const TEXT_NODE_TYPE = typeof Node !== "undefined" ? Node.TEXT_NODE : 3;
const SHOW_ELEMENT_MASK = typeof NodeFilter !== "undefined" ? NodeFilter.SHOW_ELEMENT : 1;
const SHOW_TEXT_MASK = typeof NodeFilter !== "undefined" ? NodeFilter.SHOW_TEXT : 4;
const FILTER_ACCEPT = typeof NodeFilter !== "undefined" ? NodeFilter.FILTER_ACCEPT : 1;
const FILTER_REJECT = typeof NodeFilter !== "undefined" ? NodeFilter.FILTER_REJECT : 2;
const FILTER_SKIP = typeof NodeFilter !== "undefined" ? NodeFilter.FILTER_SKIP : 3;

function closestExcluded(element, body) {
  if (typeof element?.closest === "function") {
    const match = element.closest(EXCLUDED_SELECTOR);
    return match && body.contains(match) && match !== body ? match : null;
  }
  for (let el = element; el && el !== body; el = el.parentElement) {
    if (el.matches?.(EXCLUDED_SELECTOR)) return el;
  }
  return null;
}

function isClosedDetailsContent(element, body) {
  if (typeof element?.closest === "function") {
    const closed = element.closest("details:not([open])");
    if (!closed) return false;
    const summary = element.closest("summary");
    return !summary || !closed.contains(summary);
  }
  let inSummary = false;
  for (let el = element; el && el !== body; el = el.parentElement) {
    const tag = String(el.tagName || "").toUpperCase();
    if (tag === "SUMMARY") inSummary = true;
    else if (tag === "DETAILS" && !el.open) return !inSummary;
  }
  return false;
}

function enclosingCodeElement(node, body) {
  for (let el = node?.parentElement; el && el !== body; el = el.parentElement) {
    if (String(el.tagName || "").toUpperCase() === "CODE") return el;
  }
  return null;
}

export function isExcludedElement(element, body) {
  if (!element || !body?.contains(element)) return true;
  if (element === body) return false;
  if (closestExcluded(element, body)) return true;
  return isClosedDetailsContent(element, body);
}

export function isAllowedTextNode(node, body) {
  if (!node || node.nodeType !== TEXT_NODE_TYPE || !node.data) return false;
  const parent = node.parentElement;
  return !!parent && !isExcludedElement(parent, body);
}

export function collectBlockSegments(body, doc = body?.ownerDocument) {
  if (!body) return [];
  const segments = [];
  let current = null;
  const flush = () => {
    if (current && current.text) segments.push(current);
    current = null;
  };
  const appendText = (node) => {
    if (!node.data) return;
    if (!current) current = { text: "", runs: [] };
    const textStart = current.text.length;
    current.text += node.data;
    current.runs.push({
      node,
      textStart,
      textEnd: current.text.length,
      codeEl: enclosingCodeElement(node, body),
    });
  };

  if (typeof doc?.createTreeWalker === "function") {
    const openBlocks = [];
    const walker = doc.createTreeWalker(body, SHOW_ELEMENT_MASK | SHOW_TEXT_MASK, {
      acceptNode(node) {
        if (node.nodeType === TEXT_NODE_TYPE) {
          return node.data ? FILTER_ACCEPT : FILTER_SKIP;
        }
        if (node.nodeType !== ELEMENT_NODE_TYPE) return FILTER_SKIP;
        const tag = String(node.tagName || "").toUpperCase();
        if (node !== body && (node.matches?.(EXCLUDED_SELECTOR) || (tag === "DETAILS" && !node.open))) {
          flush();
          return FILTER_REJECT;
        }
        if (tag === "BR") return FILTER_ACCEPT;
        if (node !== body && node.matches?.(BLOCK_SELECTOR)) return FILTER_ACCEPT;
        return FILTER_SKIP;
      },
    });
    for (let node; (node = walker.nextNode()); ) {
      while (openBlocks.length && !openBlocks[openBlocks.length - 1].contains(node)) {
        openBlocks.pop();
        flush();
      }
      if (node.nodeType === ELEMENT_NODE_TYPE) {
        flush();
        if (String(node.tagName || "").toUpperCase() !== "BR") {
          openBlocks.push(node);
        }
        continue;
      }
      appendText(node);
    }
    flush();
    return segments;
  }

  const walk = (node) => {
    if (node.nodeType === TEXT_NODE_TYPE) {
      appendText(node);
      return;
    }
    if (node.nodeType !== ELEMENT_NODE_TYPE) return;
    const tag = String(node.tagName || "").toUpperCase();
    if (node !== body && node.matches?.(EXCLUDED_SELECTOR)) {
      flush();
      return;
    }
    if (tag === "DETAILS" && !node.open) {
      flush();
      return;
    }
    if (tag === "BR") {
      flush();
      return;
    }
    const isBlock = node !== body && node.matches?.(BLOCK_SELECTOR);
    if (isBlock) flush();
    for (const child of node.childNodes) walk(child);
    if (isBlock) flush();
  };
  walk(body);
  flush();
  return segments;
}

function charRunAt(runs, pos) {
  for (const run of runs) {
    if (pos >= run.textStart && pos < run.textEnd) return run;
  }
  return null;
}

function hasAsciiBoundaries(seg, start, end, term) {
  const { text, runs } = seg;
  if (ASCII_WORD_CHAR.test(term[0]) && start > 0 && ASCII_WORD_CHAR.test(text[start - 1])) {
    const prevRun = charRunAt(runs, start - 1);
    const currRun = charRunAt(runs, start);
    if (!prevRun || !currRun || prevRun.codeEl === currRun.codeEl) return false;
  }
  if (ASCII_WORD_CHAR.test(term[term.length - 1]) && end < text.length && ASCII_WORD_CHAR.test(text[end])) {
    const currRun = charRunAt(runs, end - 1);
    const nextRun = charRunAt(runs, end);
    if (!currRun || !nextRun || currRun.codeEl === nextRun.codeEl) return false;
  }
  return true;
}

function locateInRuns(runs, pos, isEnd = false) {
  for (const run of runs) {
    if (isEnd ? pos > run.textStart && pos <= run.textEnd : pos >= run.textStart && pos < run.textEnd) {
      return { node: run.node, offset: pos - run.textStart };
    }
  }
  return null;
}

function spanSlicesForMatch(runs, matchStart, matchEnd, term) {
  const slices = [];
  for (const run of runs) {
    if (run.textEnd <= matchStart || run.textStart >= matchEnd) continue;
    slices.push({
      node: run.node,
      start: Math.max(0, matchStart - run.textStart),
      end: Math.min(run.node.data.length, matchEnd - run.textStart),
      term,
    });
  }
  return slices;
}

function matchTermsInSegments(doc, segments, terms, { caseInsensitive = false } = {}) {
  if (!doc || !segments.length || !terms.length) return { ranges: [], spans: [] };
  const ranges = [];
  const spans = [];
  for (const term of terms) {
    if (!term) continue;
    const needle = caseInsensitive ? term.toLowerCase() : term;
    for (const seg of segments) {
      const haystack = caseInsensitive ? (seg.lowerText ??= seg.text.toLowerCase()) : seg.text;
      let from = 0;
      while (from <= haystack.length - needle.length) {
        const at = haystack.indexOf(needle, from);
        if (at < 0) break;
        const end = at + needle.length;
        from = at + 1;
        if (!hasAsciiBoundaries(seg, at, end, term)) continue;
        const startPos = locateInRuns(seg.runs, at, false);
        const endPos = locateInRuns(seg.runs, end, true);
        if (!startPos || !endPos) continue;
        const range = doc.createRange();
        range.setStart(startPos.node, startPos.offset);
        range.setEnd(endPos.node, endPos.offset);
        ranges.push(range);
        spans.push(...spanSlicesForMatch(seg.runs, at, end, term));
      }
    }
  }
  return { ranges, spans };
}

function appendExplicitHits(doc, body, active, activeTerms, activeHits) {
  if (!doc || !body || !activeTerms.length || !activeHits.length) return;
  const activeSet = new Set(activeTerms);
  for (const hit of activeHits) {
    if (!hit || !activeSet.has(hit.term)) continue;
    const { node, start, end, term } = hit;
    if (!node || node.nodeType !== TEXT_NODE_TYPE || typeof node.data !== "string") continue;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > node.data.length) continue;
    if (!body.contains(node) || !isAllowedTextNode(node, body)) continue;
    let hitStart = start;
    let hitEnd = end;
    while (hitStart < hitEnd && /\s/.test(node.data[hitStart])) hitStart += 1;
    while (hitEnd > hitStart && /\s/.test(node.data[hitEnd - 1])) hitEnd -= 1;
    if (hitEnd <= hitStart) continue;
    if (normalizeTerm(node.data.slice(hitStart, hitEnd)) !== term) continue;
    const alreadyCovered = active.spans.some(
      (span) => span.node === node && span.start <= hitStart && span.end >= hitEnd && span.term === term,
    );
    if (alreadyCovered) continue;
    const range = doc.createRange();
    range.setStart(node, hitStart);
    range.setEnd(node, hitEnd);
    active.ranges.push(range);
    active.spans.push({ node, start: hitStart, end: hitEnd, term });
  }
}

/** Collect active, seen-unknown, and candidate term highlights from a single DOM TreeWalker scan. */
export function collectAllHighlightEntries(
  doc,
  body,
  { activeTerms = [], activeHits = [], seenTerms = [], candidateTerms = [] } = {},
) {
  const empty = () => ({ ranges: [], spans: [] });
  if (!doc || !body || (!activeTerms.length && !seenTerms.length && !candidateTerms.length)) {
    return { active: empty(), seen: empty(), cand: empty() };
  }
  const segments = collectBlockSegments(body, doc);
  const active = activeTerms.length ? matchTermsInSegments(doc, segments, activeTerms) : empty();
  if (activeHits.length) appendExplicitHits(doc, body, active, activeTerms, activeHits);
  return {
    active,
    seen: seenTerms.length ? matchTermsInSegments(doc, segments, seenTerms, { caseInsensitive: true }) : empty(),
    cand: candidateTerms.length ? matchTermsInSegments(doc, segments, candidateTerms, { caseInsensitive: true }) : empty(),
  };
}
