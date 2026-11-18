import React from "react";
import { reviewEntryKey } from "../async.js";
import { ui, uiLocale } from "../i18n.js";
import { MAX_MARKED_TERMS, mergeAdjacent, normalizeTerm, toggleTerm, wordAt } from "./term-marks.js";

export const TERM_HIGHLIGHT_NAME = "study-term-mark";

const EMPTY_ENTRY = Object.freeze({ terms: [], hits: [] });

const EXCLUDED_SELECTOR = [
  ".katex",
  "code",
  "pre",
  "a",
  "input",
  "textarea",
  "select",
  "img",
  "svg",
  "summary",
  "button:not(.option)",
  ".term-strip",
  ".question-toolbar",
  ".review-sticky-bar",
  ".assist-area",
  ".grading",
  ".question-header",
  ".flip-control",
  ".option-letter",
  ".answer-state",
  ".practice-tip",
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
  '[aria-hidden="true"]',
].join(", ");

const BLOCK_SELECTOR = "p, li, h1, h2, h3, h4, h5, h6, div, blockquote, dd, dt, td, th, button.option, article, section";
const ASCII_WORD_CHAR = /[A-Za-z0-9_]/;

function supportsHighlights() {
  return typeof CSS !== "undefined" && !!CSS.highlights && typeof Highlight === "function";
}

function isClosedDetailsContent(element) {
  const closed = element?.closest?.("details:not([open])");
  if (!closed) return false;
  const summary = element.closest("summary");
  return !summary || !closed.contains(summary);
}

function isExcludedElement(element, body) {
  if (!element || !body?.contains(element)) return true;
  if (element === body) return false;
  const match = element.closest(EXCLUDED_SELECTOR);
  if (match && body.contains(match) && match !== body) return true;
  return isClosedDetailsContent(element);
}

function isAllowedTextNode(node, body) {
  if (!node || node.nodeType !== Node.TEXT_NODE || !node.data) return false;
  const parent = node.parentElement;
  return !!parent && !isExcludedElement(parent, body);
}

function collectBlockSegments(body) {
  const segments = [];
  let current = null;
  const flush = () => {
    if (current && current.text) segments.push(current);
    current = null;
  };
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      if (!node.data) return;
      if (!current) current = { text: "", runs: [] };
      const textStart = current.text.length;
      current.text += node.data;
      current.runs.push({ node, textStart, textEnd: current.text.length });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node !== body && node.matches?.(EXCLUDED_SELECTOR)) {
      flush();
      return;
    }
    if (node.tagName === "DETAILS" && !node.open) {
      flush();
      return;
    }
    if (node.tagName === "BR") {
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

function hasAsciiBoundaries(text, start, end, term) {
  if (ASCII_WORD_CHAR.test(term[0]) && start > 0 && ASCII_WORD_CHAR.test(text[start - 1])) return false;
  if (ASCII_WORD_CHAR.test(term[term.length - 1]) && end < text.length && ASCII_WORD_CHAR.test(text[end])) return false;
  return true;
}

function locateInRuns(runs, pos) {
  for (const run of runs) {
    if (pos >= run.textStart && pos <= run.textEnd) {
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

function collectHighlightEntries(doc, body, terms) {
  if (!doc || !body || !terms.length) return { ranges: [], spans: [] };
  const segments = collectBlockSegments(body);
  const ranges = [];
  const spans = [];
  for (const term of terms) {
    if (!term) continue;
    for (const seg of segments) {
      let from = 0;
      while (from <= seg.text.length - term.length) {
        const at = seg.text.indexOf(term, from);
        if (at < 0) break;
        const end = at + term.length;
        from = at + 1;
        if (!hasAsciiBoundaries(seg.text, at, end, term)) continue;
        const startPos = locateInRuns(seg.runs, at);
        const endPos = locateInRuns(seg.runs, end);
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

function caretAt(doc, x, y) {
  if (typeof doc.caretPositionFromPoint === "function") {
    const pos = doc.caretPositionFromPoint(x, y);
    if (pos?.offsetNode) return { node: pos.offsetNode, offset: pos.offset };
  }
  if (typeof doc.caretRangeFromPoint === "function") {
    const range = doc.caretRangeFromPoint(x, y);
    if (range?.startContainer) return { node: range.startContainer, offset: range.startOffset };
  }
  return null;
}

function charBoundsMatch(doc, node, rawIndex, x, y, slop) {
  const text = node.data;
  if (rawIndex < 0 || rawIndex >= text.length) return -1;
  let start = rawIndex;
  const code = text.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff && start > 0) start -= 1;
  let end = start + 1;
  const lead = text.charCodeAt(start);
  if (lead >= 0xd800 && lead <= 0xdbff && end < text.length) end += 1;

  const range = doc.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  for (const rect of range.getClientRects()) {
    if (
      rect.width > 0 &&
      rect.height > 0 &&
      x >= rect.left - slop &&
      x <= rect.right + slop &&
      y >= rect.top - slop &&
      y <= rect.bottom + slop
    ) {
      return start;
    }
  }
  return -1;
}

function charOffsetAtPoint(doc, x, y, body) {
  const caret = caretAt(doc, x, y);
  if (!caret || !isAllowedTextNode(caret.node, body)) return null;
  const { node, offset } = caret;
  for (const slop of [0, 2]) {
    for (const candidate of [offset, offset - 1]) {
      const matched = charBoundsMatch(doc, node, candidate, x, y, slop);
      if (matched >= 0) return { node, offset: matched };
    }
  }
  return null;
}

function replaceMergedTerms(terms, replaced, nextTerm) {
  const drop = new Set(replaced);
  const out = [];
  let inserted = false;
  for (const item of terms) {
    if (drop.has(item)) {
      if (!inserted) {
        if (!out.includes(nextTerm)) out.push(nextTerm);
        inserted = true;
      }
      continue;
    }
    if (!out.includes(item)) out.push(item);
  }
  if (!inserted && !out.includes(nextTerm)) out.push(nextTerm);
  return out;
}

/**
 * In-page unknown-word marking for a review question (`#1192`):
 * per-question memory keyed by `reviewEntryKey(run)`, click/drag extraction, adjacent word merge,
 * option interception during marking mode, and CSS Custom Highlight synchronization.
 */
export function useTermMarking({ session, reviewBodyRef, notify }) {
  const run = session?.run;
  const entryKey = reviewEntryKey(run);
  const runId = run?.id || "";
  const disabledForState = !entryKey || run?.mode === "exam" || !!run?.complete;

  const hasSessionMarking = typeof session?.markingTerms === "boolean";
  const [localMarking, setLocalMarking] = React.useState(false);
  const marking = disabledForState ? false : hasSessionMarking ? session.markingTerms : localMarking;

  const toggleMarking = React.useCallback(() => {
    if (disabledForState) return;
    if (hasSessionMarking) session.actions?.toggleMarkTerms?.();
    else setLocalMarking((value) => !value);
  }, [disabledForState, hasSessionMarking, session]);

  const exitMarking = React.useCallback(() => {
    if (hasSessionMarking) session.actions?.exitMarkTerms?.();
    else setLocalMarking(false);
  }, [hasSessionMarking, session]);

  React.useEffect(() => {
    if (disabledForState && !hasSessionMarking) setLocalMarking(false);
  }, [disabledForState, hasSessionMarking]);

  React.useEffect(() => {
    if (!hasSessionMarking) setLocalMarking(false);
  }, [entryKey, hasSessionMarking]);

  const [entriesByKey, setEntriesByKey] = React.useState({});
  const lastRunIdRef = React.useRef(runId);
  React.useEffect(() => {
    if (runId && lastRunIdRef.current && runId !== lastRunIdRef.current) {
      setEntriesByKey({});
    }
    if (runId) lastRunIdRef.current = runId;
  }, [runId]);

  const currentEntry = entryKey ? entriesByKey[entryKey] || EMPTY_ENTRY : EMPTY_ENTRY;
  const terms = currentEntry.terms;

  const activeSpansRef = React.useRef([]);
  const pointerDownRef = React.useRef(null);
  const suppressClickUntilRef = React.useRef(0);
  const markingRef = React.useRef(marking);
  markingRef.current = marking;
  const handlersRef = React.useRef({});

  const notifyLimit = React.useCallback(() => {
    notify?.({ text: ui("一次最多补 6 个词，先补这几个"), tone: "warning" });
  }, [notify]);

  const updateCurrentEntry = React.useCallback((updater) => {
    if (!entryKey) return;
    setEntriesByKey((prev) => {
      const current = prev[entryKey] || EMPTY_ENTRY;
      const next = updater(current);
      if (!next || next === current) return prev;
      return { ...prev, [entryKey]: next };
    });
  }, [entryKey]);

  const removeTerm = React.useCallback((term) => {
    const clean = normalizeTerm(term);
    if (!clean) return;
    updateCurrentEntry((current) => {
      if (!current.terms.includes(clean)) return current;
      return {
        terms: current.terms.filter((item) => item !== clean),
        hits: current.hits.filter((hit) => hit.term !== clean),
      };
    });
  }, [updateCurrentEntry]);

  const applySelectedText = React.useCallback((raw, singleNodeRange = null) => {
    const clean = normalizeTerm(raw);
    if (!clean) return;
    let reached = false;
    updateCurrentEntry((current) => {
      const result = toggleTerm(current.terms, clean, MAX_MARKED_TERMS);
      if (result.limitReached) {
        reached = true;
        return current;
      }
      if (result.removed) {
        return {
          terms: result.terms,
          hits: current.hits.filter((hit) => hit.term !== clean),
        };
      }
      if (!result.added) return current;
      const nextHits = singleNodeRange
        ? [...current.hits, { node: singleNodeRange.node, start: singleNodeRange.start, end: singleNodeRange.end, term: clean }]
        : current.hits;
      return { terms: result.terms, hits: nextHits };
    });
    if (reached) notifyLimit();
  }, [notifyLimit, updateCurrentEntry]);

  const applyPointHit = React.useCallback((pointHit) => {
    if (!pointHit) return;
    const { node, offset } = pointHit;
    const painted = activeSpansRef.current.find(
      (span) => span.node === node && offset >= span.start && offset < span.end,
    );
    if (painted) {
      removeTerm(painted.term);
      return;
    }

    const hit = wordAt(node.data, offset, uiLocale());
    if (!hit) return;

    let reached = false;
    updateCurrentEntry((current) => {
      if (current.terms.includes(hit.term)) {
        return {
          terms: current.terms.filter((item) => item !== hit.term),
          hits: current.hits.filter((item) => item.term !== hit.term),
        };
      }

      const nextHit = { node, start: hit.start, end: hit.end, term: hit.term };
      const merged = mergeAdjacent(current.hits, nextHit);
      if (merged.merged) {
        return {
          terms: replaceMergedTerms(current.terms, merged.replaced, merged.entry.term),
          hits: merged.entries,
        };
      }

      const result = toggleTerm(current.terms, hit.term, MAX_MARKED_TERMS);
      if (result.limitReached) {
        reached = true;
        return current;
      }
      if (!result.added) return current;
      return { terms: result.terms, hits: merged.entries };
    });
    if (reached) notifyLimit();
  }, [notifyLimit, removeTerm, updateCurrentEntry]);

  handlersRef.current = { applySelectedText, applyPointHit };

  // Paint all occurrences via CSS Custom Highlight API and keep ranges fresh on DOM changes.
  React.useEffect(() => {
    const body = reviewBodyRef?.current;
    const clearHighlight = () => {
      activeSpansRef.current = [];
      if (supportsHighlights()) CSS.highlights.delete(TERM_HIGHLIGHT_NAME);
    };
    if (!body || disabledForState || !terms.length) {
      clearHighlight();
      return clearHighlight;
    }

    const sync = () => {
      const { ranges, spans } = collectHighlightEntries(body.ownerDocument, body, terms);
      activeSpansRef.current = spans;
      if (supportsHighlights()) {
        if (ranges.length) CSS.highlights.set(TERM_HIGHLIGHT_NAME, new Highlight(...ranges));
        else CSS.highlights.delete(TERM_HIGHLIGHT_NAME);
      }
    };

    sync();
    if (typeof MutationObserver !== "function") return clearHighlight;
    let rafId = 0;
    const observer = new MutationObserver(() => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        sync();
      });
    });
    observer.observe(body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["aria-hidden", "open"],
    });
    return () => {
      observer.disconnect();
      if (rafId) cancelAnimationFrame(rafId);
      clearHighlight();
    };
  }, [disabledForState, reviewBodyRef, terms, entryKey, run?.revealed, run?.feedback, session?.showBack]);

  React.useEffect(() => {
    if (!marking) pointerDownRef.current = null;
  }, [marking]);

  // Attach capture pointer & click listeners on .review-body once; guard every event with `markingRef.current`
  // so toggling marking mode has zero listener-registration delay.
  React.useEffect(() => {
    const body = reviewBodyRef?.current;
    if (!body) return undefined;

    const doc = body.ownerDocument;
    const onPointerDown = (event) => {
      if (!markingRef.current || event.button !== 0 || isExcludedElement(event.target, body)) {
        pointerDownRef.current = null;
        return;
      }
      pointerDownRef.current = { x: event.clientX, y: event.clientY };
    };

    const onPointerUp = (event) => {
      if (event.button !== 0 || !markingRef.current) return;
      const down = pointerDownRef.current;
      pointerDownRef.current = null;
      if (!down && !body.contains(event.target)) return;
      if (body.contains(event.target) && isExcludedElement(event.target, body)) return;

      const win = doc?.defaultView || window;
      const sel = win?.getSelection?.();
      const moved = down ? Math.hypot(event.clientX - down.x, event.clientY - down.y) : 0;

      if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        const raw = sel.toString();
        const allowedEnds =
          body.contains(range.commonAncestorContainer) &&
          !isExcludedElement(
            range.startContainer.nodeType === Node.TEXT_NODE ? range.startContainer.parentElement : range.startContainer,
            body,
          ) &&
          !isExcludedElement(
            range.endContainer.nodeType === Node.TEXT_NODE ? range.endContainer.parentElement : range.endContainer,
            body,
          );
        if (allowedEnds && raw) {
          sel.removeAllRanges();
          const singleNodeRange =
            range.startContainer === range.endContainer && range.startContainer.nodeType === Node.TEXT_NODE
              ? { node: range.startContainer, start: range.startOffset, end: range.endOffset }
              : null;
          handlersRef.current.applySelectedText(raw, singleNodeRange);
          suppressClickUntilRef.current = Date.now() + 250;
          return;
        }
      }

      if (moved > 6) return;
      const pointHit = charOffsetAtPoint(doc, event.clientX, event.clientY, body);
      if (!pointHit) return;
      suppressClickUntilRef.current = Date.now() + 250;
      handlersRef.current.applyPointHit(pointHit);
    };

    const onClickCapture = (event) => {
      if (!markingRef.current || isExcludedElement(event.target, body)) return;
      if (event.target?.closest?.(".options button.option")) {
        event.preventDefault();
        event.stopPropagation();
      }
      if (Date.now() <= suppressClickUntilRef.current) return;
      if (event.clientX === 0 && event.clientY === 0) return;
      const pointHit = charOffsetAtPoint(body.ownerDocument, event.clientX, event.clientY, body);
      if (pointHit) handlersRef.current.applyPointHit(pointHit);
    };

    body.addEventListener("pointerdown", onPointerDown, true);
    doc.addEventListener("pointerup", onPointerUp, true);
    body.addEventListener("click", onClickCapture, true);
    return () => {
      body.removeEventListener("pointerdown", onPointerDown, true);
      doc.removeEventListener("pointerup", onPointerUp, true);
      body.removeEventListener("click", onClickCapture, true);
      pointerDownRef.current = null;
    };
  }, [reviewBodyRef]);

  return {
    marking,
    terms,
    toggleMarking,
    exitMarking,
    removeTerm,
  };
}
