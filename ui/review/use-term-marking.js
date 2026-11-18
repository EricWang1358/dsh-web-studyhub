import React from "react";
import { reviewEntryKey } from "../async.js";
import { ui, uiLocale } from "../i18n.js";
import { MAX_MARKED_TERMS, mergeAdjacent, normalizeTerm, toggleTerm, wordAt } from "./term-marks.js";

export const TERM_HIGHLIGHT_NAME = "study-term-mark";
export const SEEN_TERM_HIGHLIGHT_NAME = "study-term-seen";

const EMPTY_ENTRY = Object.freeze({ terms: [], hits: [] });
const PROMPT_EXCERPT_MAX = 60;

function promptExcerpt(raw) {
  if (typeof raw !== "string") return "";
  const clean = raw.replace(/\s+/g, " ").trim();
  if (!clean) return "";
  return clean.length > PROMPT_EXCERPT_MAX ? `${clean.slice(0, PROMPT_EXCERPT_MAX - 1).trimEnd()}…` : clean;
}

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

function collectHighlightEntries(doc, body, terms, { caseInsensitive = false } = {}) {
  if (!doc || !body || !terms.length) return { ranges: [], spans: [] };
  const segments = collectBlockSegments(body);
  const ranges = [];
  const spans = [];
  for (const term of terms) {
    if (!term) continue;
    const needle = caseInsensitive ? term.toLowerCase() : term;
    for (const seg of segments) {
      const haystack = caseInsensitive ? seg.text.toLowerCase() : seg.text;
      let from = 0;
      while (from <= haystack.length - needle.length) {
        const at = haystack.indexOf(needle, from);
        if (at < 0) break;
        const end = at + needle.length;
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
export function useTermMarking({ session, reviewBodyRef, notify, call, courseName = "", assistTasks } = {}) {
  const run = session?.run;
  const entryKey = reviewEntryKey(run);
  const runId = run?.id || "";
  const disabledForState = !entryKey || run?.mode === "exam" || !!run?.complete;
  const resolvedCourse = typeof (courseName || run?.course) === "string"
    ? (courseName || run?.course).replace(/\s+/g, " ").trim()
    : "";

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
  const entriesByKeyRef = React.useRef(entriesByKey);
  entriesByKeyRef.current = entriesByKey;

  const cacheRunKey = runId || "__default__";
  const cacheRef = React.useRef({ runId: null, byCourse: new Map() });
  const inflightRef = React.useRef(new Map());
  const touchedDuringFetchRef = React.useRef(new Map());
  const seenDoneTasksRef = React.useRef(new Set());
  const [courseTerms, setCourseTerms] = React.useState([]);
  const [loadingCourseTerms, setLoadingCourseTerms] = React.useState(false);
  const [courseTermsError, setCourseTermsError] = React.useState("");

  const lastRunIdRef = React.useRef(runId);
  React.useEffect(() => {
    if (runId && lastRunIdRef.current && runId !== lastRunIdRef.current) {
      entriesByKeyRef.current = {};
      setEntriesByKey({});
      cacheRef.current = { runId: null, byCourse: new Map() };
      inflightRef.current.clear();
      touchedDuringFetchRef.current.clear();
      setCourseTerms([]);
      setCourseTermsError("");
    }
    if (runId) lastRunIdRef.current = runId;
  }, [runId]);

  const currentEntry = entryKey ? entriesByKey[entryKey] || EMPTY_ENTRY : EMPTY_ENTRY;
  const terms = currentEntry.terms;

  const activeSpansRef = React.useRef([]);
  const seenSpansRef = React.useRef([]);
  const pointerDownRef = React.useRef(null);
  const suppressClickUntilRef = React.useRef(0);
  const markingRef = React.useRef(marking);
  markingRef.current = marking;
  const handlersRef = React.useRef({});
  const callRef = React.useRef(call);
  callRef.current = call;
  const resolvedCourseRef = React.useRef(resolvedCourse);
  resolvedCourseRef.current = resolvedCourse;
  const cacheRunKeyRef = React.useRef(cacheRunKey);
  cacheRunKeyRef.current = cacheRunKey;
  const fromCardRef = React.useRef(null);
  fromCardRef.current = run?.deckId && run?.card?.id
    ? { deckId: run.deckId, cardId: run.card.id, prompt: promptExcerpt(run.card?.prompt) }
    : null;

  const updateCourseCache = React.useCallback((targetCourse, updater) => {
    if (!targetCourse) return;
    if (cacheRef.current.runId !== cacheRunKeyRef.current) {
      cacheRef.current = { runId: cacheRunKeyRef.current, byCourse: new Map() };
    }
    const prev = cacheRef.current.byCourse.get(targetCourse) || [];
    const next = updater(prev);
    cacheRef.current.byCourse.set(targetCourse, next);
    if (targetCourse === resolvedCourseRef.current) {
      setCourseTerms(next);
    }
  }, []);

  const loadCourseTerms = React.useCallback(async ({ force = false } = {}) => {
    if (!resolvedCourse || disabledForState || typeof callRef.current !== "function") {
      setCourseTerms([]);
      setLoadingCourseTerms(false);
      setCourseTermsError("");
      return [];
    }
    if (cacheRef.current.runId !== cacheRunKey) {
      cacheRef.current = { runId: cacheRunKey, byCourse: new Map() };
    }
    if (!force && cacheRef.current.byCourse.has(resolvedCourse)) {
      const cached = cacheRef.current.byCourse.get(resolvedCourse) || [];
      setCourseTerms(cached);
      setCourseTermsError("");
      return cached;
    }
    const flightKey = `${cacheRunKey}\0${resolvedCourse}`;
    if (!force && inflightRef.current.has(flightKey)) {
      return inflightRef.current.get(flightKey);
    }
    const hadCached = cacheRef.current.byCourse.has(resolvedCourse);
    if (!hadCached) setLoadingCourseTerms(true);
    setCourseTermsError("");
    const touched = new Map();
    touchedDuringFetchRef.current.set(flightKey, touched);

    const request = Promise.resolve(callRef.current("course.terms.get", { course: resolvedCourse }))
      .then((res) => {
        const fetched = Array.isArray(res?.items) ? res.items : [];
        if (cacheRef.current.runId !== cacheRunKey) return fetched;
        const current = cacheRef.current.byCourse.get(resolvedCourse) || [];
        let merged = fetched;
        if (touched.size) {
          const removed = new Set();
          const added = [];
          for (const [k, op] of touched.entries()) {
            if (op === "remove") removed.add(k);
            else if (op === "add") {
              const found = current.find((item) => item.term.toLowerCase() === k);
              if (found && !fetched.some((item) => item.term.toLowerCase() === k)) added.push(found);
            }
          }
          merged = [...fetched.filter((item) => !removed.has(item.term.toLowerCase())), ...added];
        }
        cacheRef.current.byCourse.set(resolvedCourse, merged);
        if (resolvedCourseRef.current === resolvedCourse && cacheRunKeyRef.current === cacheRunKey) {
          setCourseTerms(merged);
        }
        return merged;
      })
      .catch((error) => {
        if (resolvedCourseRef.current === resolvedCourse && cacheRunKeyRef.current === cacheRunKey) {
          setCourseTermsError(error?.message || "");
        }
        return cacheRef.current.byCourse.get(resolvedCourse) || [];
      })
      .finally(() => {
        inflightRef.current.delete(flightKey);
        touchedDuringFetchRef.current.delete(flightKey);
        if (resolvedCourseRef.current === resolvedCourse && cacheRunKeyRef.current === cacheRunKey) {
          setLoadingCourseTerms(false);
        }
      });

    inflightRef.current.set(flightKey, request);
    return request;
  }, [cacheRunKey, disabledForState, resolvedCourse]);

  React.useEffect(() => {
    loadCourseTerms();
  }, [loadCourseTerms]);

  React.useEffect(() => {
    if (!Array.isArray(assistTasks) || !assistTasks.length) return;
    const newlyDone = assistTasks.filter(
      (task) => task?.mode === "terms" && task?.status === "done" && task?.id && !seenDoneTasksRef.current.has(task.id),
    );
    if (!newlyDone.length) return;
    for (const task of newlyDone) seenDoneTasksRef.current.add(task.id);
    loadCourseTerms({ force: true });
  }, [assistTasks, loadCourseTerms]);

  const persistMark = React.useCallback((rawTerms) => {
    const clean = (Array.isArray(rawTerms) ? rawTerms : []).map(normalizeTerm).filter(Boolean);
    const targetCourse = resolvedCourseRef.current;
    if (!clean.length || !targetCourse) return;
    const fromCard = fromCardRef.current;
    const flightKey = `${cacheRunKeyRef.current}\0${targetCourse}`;
    const touched = touchedDuringFetchRef.current.get(flightKey);
    const now = new Date().toISOString();
    updateCourseCache(targetCourse, (prev) => {
      const seen = new Set(prev.map((item) => item.term.toLowerCase()));
      const additions = [];
      for (const term of clean) {
        const key = term.toLowerCase();
        if (touched) touched.set(key, "add");
        if (seen.has(key)) continue;
        seen.add(key);
        additions.push({
          term,
          at: now,
          ...(fromCard ? { from: { deckId: fromCard.deckId, cardId: fromCard.cardId } } : {}),
          state: "unknown",
          ...(fromCard?.prompt ? { fromPrompt: fromCard.prompt } : {}),
        });
      }
      return additions.length ? [...prev, ...additions] : prev;
    });
    if (typeof callRef.current === "function") {
      Promise.resolve(
        callRef.current("course.terms.mark", {
          course: targetCourse,
          terms: clean,
          ...(fromCard ? { from: { deckId: fromCard.deckId, cardId: fromCard.cardId } } : {}),
        }),
      ).catch(() => {});
    }
  }, [updateCourseCache]);

  const persistUnmark = React.useCallback((rawTerms) => {
    const clean = (Array.isArray(rawTerms) ? rawTerms : []).map(normalizeTerm).filter(Boolean);
    const targetCourse = resolvedCourseRef.current;
    if (!clean.length || !targetCourse) return;
    const removeKeys = new Set(clean.map((term) => term.toLowerCase()));
    const flightKey = `${cacheRunKeyRef.current}\0${targetCourse}`;
    const touched = touchedDuringFetchRef.current.get(flightKey);
    if (touched) {
      for (const key of removeKeys) touched.set(key, "remove");
    }
    updateCourseCache(targetCourse, (prev) => {
      const next = prev.filter((item) => !removeKeys.has(item.term.toLowerCase()));
      return next.length === prev.length ? prev : next;
    });
    if (typeof callRef.current === "function") {
      Promise.resolve(
        callRef.current("course.terms.unmark", {
          course: targetCourse,
          terms: clean,
        }),
      ).catch(() => {});
    }
  }, [updateCourseCache]);

  const notifyLimit = React.useCallback(() => {
    notify?.({ text: ui("一次最多补 6 个词，先补这几个"), tone: "warning" });
  }, [notify]);

  const commitEntry = React.useCallback((next) => {
    if (!entryKey) return;
    const nextMap = { ...entriesByKeyRef.current, [entryKey]: next };
    entriesByKeyRef.current = nextMap;
    setEntriesByKey(nextMap);
  }, [entryKey]);

  const removeTerm = React.useCallback((term) => {
    const clean = normalizeTerm(term);
    if (!clean) return;
    const current = entryKey ? entriesByKeyRef.current[entryKey] || EMPTY_ENTRY : EMPTY_ENTRY;
    if (!current.terms.includes(clean)) return;
    commitEntry({
      terms: current.terms.filter((item) => item !== clean),
      hits: current.hits.filter((hit) => hit.term !== clean),
    });
    persistUnmark([clean]);
  }, [commitEntry, entryKey, persistUnmark]);

  const removeCourseTerm = React.useCallback(async (term) => {
    const clean = normalizeTerm(term);
    const targetCourse = resolvedCourseRef.current;
    if (!clean || !targetCourse) return;
    if (typeof callRef.current === "function") {
      await callRef.current("course.terms.unmark", { course: targetCourse, terms: [clean] });
    }
    const dropKey = clean.toLowerCase();
    updateCourseCache(targetCourse, (prev) => prev.filter((item) => item.term.toLowerCase() !== dropKey));
    const currentEntries = entriesByKeyRef.current;
    let changed = false;
    const nextEntries = {};
    for (const [k, entry] of Object.entries(currentEntries)) {
      const filteredTerms = entry.terms.filter((item) => item.toLowerCase() !== dropKey);
      if (filteredTerms.length !== entry.terms.length) {
        changed = true;
        nextEntries[k] = {
          terms: filteredTerms,
          hits: entry.hits.filter((hit) => hit.term.toLowerCase() !== dropKey),
        };
      } else {
        nextEntries[k] = entry;
      }
    }
    if (changed) {
      entriesByKeyRef.current = nextEntries;
      setEntriesByKey(nextEntries);
    }
  }, [updateCourseCache]);

  const clearCourseTerms = React.useCallback(async () => {
    const targetCourse = resolvedCourseRef.current;
    if (!targetCourse) return;
    const previous = cacheRef.current.byCourse.get(targetCourse) || [];
    if (typeof callRef.current === "function") {
      await callRef.current("course.terms.clear", { course: targetCourse });
    }
    const clearedKeys = new Set(previous.map((item) => item.term.toLowerCase()));
    updateCourseCache(targetCourse, () => []);
    if (clearedKeys.size) {
      const currentEntries = entriesByKeyRef.current;
      let changed = false;
      const nextEntries = {};
      for (const [k, entry] of Object.entries(currentEntries)) {
        const filteredTerms = entry.terms.filter((item) => !clearedKeys.has(item.toLowerCase()));
        if (filteredTerms.length !== entry.terms.length) {
          changed = true;
          nextEntries[k] = {
            terms: filteredTerms,
            hits: entry.hits.filter((hit) => !clearedKeys.has(hit.term.toLowerCase())),
          };
        } else {
          nextEntries[k] = entry;
        }
      }
      if (changed) {
        entriesByKeyRef.current = nextEntries;
        setEntriesByKey(nextEntries);
      }
    }
  }, [updateCourseCache]);

  const applySelectedText = React.useCallback((raw, singleNodeRange = null) => {
    const clean = normalizeTerm(raw);
    if (!clean || !entryKey) return;
    const current = entriesByKeyRef.current[entryKey] || EMPTY_ENTRY;
    const result = toggleTerm(current.terms, clean, MAX_MARKED_TERMS);
    if (result.limitReached) {
      notifyLimit();
      return;
    }
    if (result.removed) {
      commitEntry({
        terms: result.terms,
        hits: current.hits.filter((hit) => hit.term !== clean),
      });
      persistUnmark([clean]);
      return;
    }
    if (!result.added) return;
    const nextHits = singleNodeRange
      ? [...current.hits, { node: singleNodeRange.node, start: singleNodeRange.start, end: singleNodeRange.end, term: clean }]
      : current.hits;
    commitEntry({ terms: result.terms, hits: nextHits });
    persistMark([clean]);
  }, [commitEntry, entryKey, notifyLimit, persistMark, persistUnmark]);

  const applyPointHit = React.useCallback((pointHit) => {
    if (!pointHit || !entryKey) return;
    const { node, offset } = pointHit;
    const painted = activeSpansRef.current.find(
      (span) => span.node === node && offset >= span.start && offset < span.end,
    );
    if (painted) {
      removeTerm(painted.term);
      return;
    }

    const current = entriesByKeyRef.current[entryKey] || EMPTY_ENTRY;
    const seenHit = seenSpansRef.current.find(
      (span) => span.node === node && offset >= span.start && offset < span.end,
    );
    if (seenHit) {
      if (current.terms.some((item) => item.toLowerCase() === seenHit.term.toLowerCase())) return;
      const result = toggleTerm(current.terms, seenHit.term, MAX_MARKED_TERMS);
      if (result.limitReached) {
        notifyLimit();
        return;
      }
      if (!result.added) return;
      commitEntry({
        terms: result.terms,
        hits: [...current.hits, { node, start: seenHit.start, end: seenHit.end, term: seenHit.term }],
      });
      persistMark([seenHit.term]);
      return;
    }

    const hit = wordAt(node.data, offset, uiLocale());
    if (!hit) return;

    if (current.terms.includes(hit.term)) {
      commitEntry({
        terms: current.terms.filter((item) => item !== hit.term),
        hits: current.hits.filter((item) => item.term !== hit.term),
      });
      persistUnmark([hit.term]);
      return;
    }

    const nextHit = { node, start: hit.start, end: hit.end, term: hit.term };
    const merged = mergeAdjacent(current.hits, nextHit);
    if (merged.merged) {
      commitEntry({
        terms: replaceMergedTerms(current.terms, merged.replaced, merged.entry.term),
        hits: merged.entries,
      });
      persistUnmark(merged.replaced);
      persistMark([merged.entry.term]);
      return;
    }

    const result = toggleTerm(current.terms, hit.term, MAX_MARKED_TERMS);
    if (result.limitReached) {
      notifyLimit();
      return;
    }
    if (!result.added) return;
    commitEntry({ terms: result.terms, hits: merged.entries });
    persistMark([hit.term]);
  }, [commitEntry, entryKey, notifyLimit, persistMark, persistUnmark, removeTerm]);

  handlersRef.current = { applySelectedText, applyPointHit };

  const seenUnknownTerms = React.useMemo(() => {
    const activeKeys = new Set(terms.map((item) => item.toLowerCase()));
    return courseTerms
      .filter((item) => item?.state === "unknown" && item?.term && !activeKeys.has(item.term.toLowerCase()))
      .map((item) => item.term);
  }, [courseTerms, terms]);

  // Paint all occurrences via CSS Custom Highlight API and keep ranges fresh on DOM changes.
  React.useEffect(() => {
    const body = reviewBodyRef?.current;
    const clearHighlight = () => {
      activeSpansRef.current = [];
      seenSpansRef.current = [];
      if (supportsHighlights()) {
        CSS.highlights.delete(TERM_HIGHLIGHT_NAME);
        CSS.highlights.delete(SEEN_TERM_HIGHLIGHT_NAME);
      }
    };
    if (!body || disabledForState || (!terms.length && !seenUnknownTerms.length)) {
      clearHighlight();
      return clearHighlight;
    }

    const sync = () => {
      const active = terms.length ? collectHighlightEntries(body.ownerDocument, body, terms) : { ranges: [], spans: [] };
      const seen = seenUnknownTerms.length
        ? collectHighlightEntries(body.ownerDocument, body, seenUnknownTerms, { caseInsensitive: true })
        : { ranges: [], spans: [] };
      activeSpansRef.current = active.spans;
      seenSpansRef.current = seen.spans;
      if (supportsHighlights()) {
        if (seen.ranges.length) CSS.highlights.set(SEEN_TERM_HIGHLIGHT_NAME, new Highlight(...seen.ranges));
        else CSS.highlights.delete(SEEN_TERM_HIGHLIGHT_NAME);
        if (active.ranges.length) {
          const highlight = new Highlight(...active.ranges);
          try { highlight.priority = 1; } catch {}
          CSS.highlights.set(TERM_HIGHLIGHT_NAME, highlight);
        } else {
          CSS.highlights.delete(TERM_HIGHLIGHT_NAME);
        }
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
  }, [disabledForState, reviewBodyRef, terms, seenUnknownTerms, entryKey, run?.revealed, run?.feedback, session?.showBack]);

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
    courseName: resolvedCourse,
    courseTerms,
    loadingCourseTerms,
    courseTermsError,
    refreshCourseTerms: () => loadCourseTerms({ force: true }),
    removeCourseTerm,
    clearCourseTerms,
  };
}
