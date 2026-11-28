import React from "react";
import { reviewEntryKey } from "../async.js";
import { isPassed } from "./session-logic.js";
import { errorMessage, ui, uiLocale } from "../i18n.js";
import { studyHighlights } from "../highlight-gate.js";
import { MAX_MARKED_TERMS, clearCompletedTermEntries, collectInFlightTerms, filterCandidateTerms, mergeAdjacent, normalizeTerm, toggleTerm, wordAt } from "./term-marks.js";
import { collectAllHighlightEntries, collectBlockSegments, isAllowedTextNode, isExcludedElement } from "./term-marking-dom.js";

export { collectAllHighlightEntries, collectBlockSegments };
export const TERM_HIGHLIGHT_NAME = "study-term-mark";
export const SEEN_TERM_HIGHLIGHT_NAME = "study-term-seen";
export const CANDIDATE_TERM_HIGHLIGHT_NAME = "study-term-candidate";

const EMPTY_ENTRY = Object.freeze({ terms: [], hits: [] });
const PROMPT_EXCERPT_MAX = 60;

function promptExcerpt(raw) {
  if (typeof raw !== "string") return "";
  const clean = raw.replace(/\s+/g, " ").trim();
  if (!clean) return "";
  return clean.length > PROMPT_EXCERPT_MAX ? `${clean.slice(0, PROMPT_EXCERPT_MAX - 1).trimEnd()}…` : clean;
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
export function useTermMarking({ session, reviewBodyRef, notify, call, courseName = "", assistTasks, candidates } = {}) {
  const run = session?.run;
  const entryKey = reviewEntryKey(run);
  const runId = run?.id || "";
  const disabledForState = !entryKey || run?.mode === "exam" || !!run?.complete;
  const sessionCandidates = React.useMemo(() => (
    Array.isArray(candidates) ? candidates :
    session?.autoTerms &&
    run?.mode !== "exam" &&
    !run?.complete &&
    run?.revealed &&
    run?.feedback &&
    !run.feedback.selfReported &&
    !isPassed(run) &&
    Array.isArray(run.solution?.terms)
      ? run.solution.terms
      : []
  ), [candidates, session?.autoTerms, run]);
  const courseText = courseName || run?.course;
  const resolvedCourse = typeof courseText === "string" ? courseText.replace(/\s+/g, " ").trim() : "";

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
  const visitAddedRef = React.useRef(new Map());
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
      visitAddedRef.current.clear();
      setCourseTerms([]);
      setCourseTermsError("");
    }
    if (runId) lastRunIdRef.current = runId;
  }, [runId]);

  const currentEntry = entryKey ? entriesByKey[entryKey] || EMPTY_ENTRY : EMPTY_ENTRY;
  const terms = currentEntry.terms;

  const activeSpansRef = React.useRef([]);
  const seenSpansRef = React.useRef([]);
  const candidateSpansRef = React.useRef([]);
  const pointerDownRef = React.useRef(null);
  const suppressNextClickRef = React.useRef(false);
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
  const inFlightKeysRef = React.useRef(new Set());
  inFlightKeysRef.current = new Set(
    collectInFlightTerms(assistTasks, run?.card?.id).map((item) => item.toLowerCase()),
  );

  const updateCourseCache = React.useCallback((targetCourse, updater) => {
    if (!targetCourse) return;
    if (cacheRef.current.runId !== cacheRunKeyRef.current) {
      cacheRef.current = { runId: cacheRunKeyRef.current, byCourse: new Map() };
      visitAddedRef.current.clear();
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
      visitAddedRef.current.clear();
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
        if (cacheRef.current.runId !== cacheRunKey || inflightRef.current.get(flightKey) !== request) {
          return cacheRef.current.byCourse.get(resolvedCourse) || fetched;
        }
        const current = cacheRef.current.byCourse.get(resolvedCourse) || [];
        let merged = fetched;
        if (touched.size) {
          const attachedKeys = new Set(
            fetched.filter((item) => item?.card && item?.term).map((item) => item.term.toLowerCase()),
          );
          const removed = new Set();
          const added = [];
          for (const [k, op] of touched.entries()) {
            if (op === "remove") {
              if (!attachedKeys.has(k)) removed.add(k);
            } else if (op === "add") {
              const found = current.find((item) => item.term.toLowerCase() === k);
              if (found && !fetched.some((item) => item.term.toLowerCase() === k)) added.push(found);
            }
          }
          merged = [...fetched.filter((item) => !removed.has(item.term.toLowerCase())), ...added];
        }
        const visitSet = visitAddedRef.current.get(resolvedCourse);
        if (visitSet?.size) {
          for (const item of fetched) {
            if (item?.card && item?.term) visitSet.delete(item.term.toLowerCase());
          }
        }
        cacheRef.current.byCourse.set(resolvedCourse, merged);
        if (resolvedCourseRef.current === resolvedCourse && cacheRunKeyRef.current === cacheRunKey) {
          setCourseTerms(merged);
        }
        return merged;
      })
      .catch((error) => {
        if (
          inflightRef.current.get(flightKey) === request &&
          resolvedCourseRef.current === resolvedCourse &&
          cacheRunKeyRef.current === cacheRunKey
        ) {
          setCourseTermsError(error?.message || "");
        }
        return cacheRef.current.byCourse.get(resolvedCourse) || [];
      })
      .finally(() => {
        if (inflightRef.current.get(flightKey) === request) {
          inflightRef.current.delete(flightKey);
          touchedDuringFetchRef.current.delete(flightKey);
          if (resolvedCourseRef.current === resolvedCourse && cacheRunKeyRef.current === cacheRunKey) {
            setLoadingCourseTerms(false);
          }
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
    // Clear completed terms in memory only: never call course.terms.unmark, since their check cards & course records are now saved.
    const nextEntries = clearCompletedTermEntries(entriesByKeyRef.current, newlyDone);
    if (nextEntries !== entriesByKeyRef.current) {
      entriesByKeyRef.current = nextEntries;
      setEntriesByKey(nextEntries);
    }
    loadCourseTerms({ force: true });
  }, [assistTasks, loadCourseTerms]);

  const persistMark = React.useCallback((rawTerms) => {
    const clean = (Array.isArray(rawTerms) ? rawTerms : []).map(normalizeTerm).filter(Boolean);
    const targetCourse = resolvedCourseRef.current;
    if (!clean.length || !targetCourse) return;
    if (cacheRef.current.runId !== cacheRunKeyRef.current) {
      cacheRef.current = { runId: cacheRunKeyRef.current, byCourse: new Map() };
      visitAddedRef.current.clear();
    }
    const beforeCache = cacheRef.current.byCourse.get(targetCourse) || [];
    const beforeKeys = new Set(beforeCache.map((item) => item.term.toLowerCase()));
    let visitSet = visitAddedRef.current.get(targetCourse);
    for (const term of clean) {
      const key = term.toLowerCase();
      if (beforeKeys.has(key)) continue;
      beforeKeys.add(key);
      if (!visitSet) {
        visitSet = new Set();
        visitAddedRef.current.set(targetCourse, visitSet);
      }
      visitSet.add(key);
    }
    const fromCard = fromCardRef.current;
    const runKeyAtCall = cacheRunKeyRef.current;
    const flightKey = `${runKeyAtCall}\0${targetCourse}`;
    const touched = touchedDuringFetchRef.current.get(flightKey);
    const now = new Date().toISOString();
    const addedKeys = [];
    updateCourseCache(targetCourse, (prev) => {
      const seen = new Set(prev.map((item) => item.term.toLowerCase()));
      const additions = [];
      for (const term of clean) {
        const key = term.toLowerCase();
        if (touched) touched.set(key, "add");
        if (seen.has(key)) continue;
        seen.add(key);
        addedKeys.push(key);
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
      )
        .then((res) => {
          if (cacheRunKeyRef.current !== runKeyAtCall) return;
          const items = Array.isArray(res?.items) ? res.items : [];
          const visit = visitAddedRef.current.get(targetCourse);
          if (!visit?.size) return;
          for (const item of items) {
            if (item?.card && item?.term) visit.delete(item.term.toLowerCase());
          }
        })
        .catch((failure) => {
          if (cacheRunKeyRef.current !== runKeyAtCall) return;
          const rollbackSet = new Set(addedKeys);
          const visit = visitAddedRef.current.get(targetCourse);
          if (visit) for (const key of rollbackSet) visit.delete(key);
          if (rollbackSet.size) {
            updateCourseCache(targetCourse, (prev) => {
              const next = prev.filter((item) => !rollbackSet.has(item.term.toLowerCase()));
              return next.length === prev.length ? prev : next;
            });
          }
          notify?.({ text: errorMessage(failure) || ui("生词保存失败，请稍后重试。"), tone: "warning" });
        });
    }
  }, [notify, updateCourseCache]);

  const persistUnmark = React.useCallback((rawTerms) => {
    const clean = (Array.isArray(rawTerms) ? rawTerms : []).map(normalizeTerm).filter(Boolean);
    const targetCourse = resolvedCourseRef.current;
    if (!clean.length || !targetCourse) return;
    const visitSet = visitAddedRef.current.get(targetCourse);
    const removable = clean.filter((term) => visitSet?.has(term.toLowerCase()));
    if (!removable.length) return;
    const removeKeys = new Set(removable.map((term) => term.toLowerCase()));
    for (const key of removeKeys) visitSet.delete(key);
    const runKeyAtCall = cacheRunKeyRef.current;
    const flightKey = `${runKeyAtCall}\0${targetCourse}`;
    const touched = touchedDuringFetchRef.current.get(flightKey);
    if (touched) {
      for (const key of removeKeys) touched.set(key, "remove");
    }
    let removedSnapshots = [];
    updateCourseCache(targetCourse, (prev) => {
      removedSnapshots = prev.filter((item) => removeKeys.has(item.term.toLowerCase()));
      const next = prev.filter((item) => !removeKeys.has(item.term.toLowerCase()));
      return next.length === prev.length ? prev : next;
    });
    if (typeof callRef.current === "function") {
      Promise.resolve(
        callRef.current("course.terms.unmark", {
          course: targetCourse,
          terms: removable,
          onlyUnattached: true,
        }),
      )
        .then((res) => {
          if (cacheRunKeyRef.current !== runKeyAtCall) return;
          const items = Array.isArray(res?.items) ? res.items : [];
          const keptAttached = items.filter((item) => item?.card && removeKeys.has(item.term?.toLowerCase()));
          if (keptAttached.length) {
            for (const item of keptAttached) {
              visitAddedRef.current.get(targetCourse)?.delete(item.term.toLowerCase());
            }
            if (targetCourse === resolvedCourseRef.current) {
              loadCourseTerms({ force: true });
            }
          }
        })
        .catch((failure) => {
          if (cacheRunKeyRef.current !== runKeyAtCall) return;
          let visit = visitAddedRef.current.get(targetCourse);
          if (!visit) { visit = new Set(); visitAddedRef.current.set(targetCourse, visit); }
          for (const key of removeKeys) visit.add(key);
          if (removedSnapshots.length) {
            updateCourseCache(targetCourse, (prev) => {
              const seen = new Set(prev.map((item) => item.term.toLowerCase()));
              const restore = removedSnapshots.filter((item) => !seen.has(item.term.toLowerCase()));
              return restore.length ? [...prev, ...restore] : prev;
            });
          }
          notify?.({ text: errorMessage(failure) || ui("取消标生词失败，请稍后重试。"), tone: "warning" });
        });
    }
  }, [loadCourseTerms, notify, updateCourseCache]);

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
    if (!clean || inFlightKeysRef.current.has(clean.toLowerCase())) return;
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
    visitAddedRef.current.get(targetCourse)?.delete(dropKey);
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
    visitAddedRef.current.delete(targetCourse);
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
      if (inFlightKeysRef.current.has(clean.toLowerCase())) return;
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

  const addPhraseTerm = React.useCallback((raw, hit = null) => {
    const clean = normalizeTerm(raw);
    if (!clean || !entryKey) return;
    const current = entriesByKeyRef.current[entryKey] || EMPTY_ENTRY;
    if (current.terms.some((item) => item.toLowerCase() === clean.toLowerCase())) return;
    const result = toggleTerm(current.terms, clean, MAX_MARKED_TERMS);
    if (result.limitReached) {
      notifyLimit();
      return;
    }
    if (!result.added) return;
    commitEntry({
      terms: result.terms,
      hits: hit ? [...current.hits, hit] : current.hits,
    });
    persistMark([clean]);
  }, [commitEntry, entryKey, notifyLimit, persistMark]);

  const markCandidate = React.useCallback((raw) => addPhraseTerm(raw), [addPhraseTerm]);

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
    const phraseHit =
      seenSpansRef.current.find((span) => span.node === node && offset >= span.start && offset < span.end) ||
      candidateSpansRef.current.find((span) => span.node === node && offset >= span.start && offset < span.end);
    if (phraseHit) {
      addPhraseTerm(phraseHit.term, { node, start: phraseHit.start, end: phraseHit.end, term: phraseHit.term });
      return;
    }

    const hit = wordAt(node.data, offset, uiLocale());
    if (!hit) return;

    if (current.terms.includes(hit.term)) {
      if (inFlightKeysRef.current.has(hit.term.toLowerCase())) return;
      commitEntry({
        terms: current.terms.filter((item) => item !== hit.term),
        hits: current.hits.filter((item) => item.term !== hit.term),
      });
      persistUnmark([hit.term]);
      return;
    }

    const nextHit = { node, start: hit.start, end: hit.end, term: hit.term };
    const mergeableHits = current.hits.filter((item) => !inFlightKeysRef.current.has(normalizeTerm(item?.term).toLowerCase()));
    const lockedHits = current.hits.filter((item) => inFlightKeysRef.current.has(normalizeTerm(item?.term).toLowerCase()));
    const merged = mergeAdjacent(mergeableHits, nextHit);
    if (merged.merged) {
      commitEntry({
        terms: replaceMergedTerms(current.terms, merged.replaced, merged.entry.term),
        hits: [...lockedHits, ...merged.entries],
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
    commitEntry({ terms: result.terms, hits: [...lockedHits, ...merged.entries] });
    persistMark([hit.term]);
  }, [addPhraseTerm, commitEntry, entryKey, notifyLimit, persistMark, persistUnmark, removeTerm]);

  handlersRef.current = { applySelectedText, applyPointHit };

  const seenUnknownTerms = React.useMemo(() => {
    const activeKeys = new Set(terms.map((item) => item.toLowerCase()));
    return courseTerms
      .filter((item) => item?.state === "unknown" && item?.term && !activeKeys.has(item.term.toLowerCase()))
      .map((item) => item.term);
  }, [courseTerms, terms]);

  const candidateTerms = React.useMemo(
    () => filterCandidateTerms(sessionCandidates, terms, courseTerms),
    [sessionCandidates, courseTerms, terms],
  );

  // Paint all occurrences via CSS Custom Highlight API and keep ranges fresh on DOM changes.
  React.useEffect(() => {
    const body = reviewBodyRef?.current;
    const clearHighlight = () => {
      activeSpansRef.current = [];
      seenSpansRef.current = [];
      candidateSpansRef.current = [];
      const registry = studyHighlights(); // gated: a write also tells the question which highlights exist (ui/highlight-gate.js)
      if (registry) {
        registry.delete(TERM_HIGHLIGHT_NAME);
        registry.delete(SEEN_TERM_HIGHLIGHT_NAME);
        registry.delete(CANDIDATE_TERM_HIGHLIGHT_NAME);
      }
    };
    if (!body || disabledForState || (!terms.length && !seenUnknownTerms.length && !candidateTerms.length)) {
      clearHighlight();
      return clearHighlight;
    }

    const sync = () => {
      const { active, seen, cand } = collectAllHighlightEntries(body.ownerDocument, body, {
        activeTerms: terms,
        activeHits: currentEntry.hits,
        seenTerms: seenUnknownTerms,
        candidateTerms,
      });
      activeSpansRef.current = active.spans;
      seenSpansRef.current = seen.spans;
      candidateSpansRef.current = cand.spans;
      const registry = studyHighlights();
      if (registry) {
        if (seen.ranges.length) registry.set(SEEN_TERM_HIGHLIGHT_NAME, new Highlight(...seen.ranges));
        else registry.delete(SEEN_TERM_HIGHLIGHT_NAME);
        if (cand.ranges.length) registry.set(CANDIDATE_TERM_HIGHLIGHT_NAME, new Highlight(...cand.ranges));
        else registry.delete(CANDIDATE_TERM_HIGHLIGHT_NAME);
        if (active.ranges.length) {
          const highlight = new Highlight(...active.ranges);
          try { highlight.priority = 1; } catch { /* a browser without highlight priority draws in registration order */ }
          registry.set(TERM_HIGHLIGHT_NAME, highlight);
        } else {
          registry.delete(TERM_HIGHLIGHT_NAME);
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
  }, [disabledForState, reviewBodyRef, terms, currentEntry.hits, seenUnknownTerms, candidateTerms, entryKey, run?.revealed, run?.feedback, session?.showBack]);

  React.useEffect(() => {
    if (!marking) pointerDownRef.current = null;
  }, [marking]);

  // Attach capture pointer & click listeners on .review-body once; guard every event with `markingRef.current`
  // so toggling marking mode has zero listener-registration delay.
  React.useEffect(() => {
    const body = reviewBodyRef?.current;
    if (!body) return undefined;

    const doc = body.ownerDocument;
    let clearSuppressTimer = 0;
    const armClickSuppression = () => {
      suppressNextClickRef.current = true;
      if (clearSuppressTimer) clearTimeout(clearSuppressTimer);
      clearSuppressTimer = setTimeout(() => {
        clearSuppressTimer = 0;
        suppressNextClickRef.current = false;
      }, 0);
    };
    const clearClickSuppression = () => {
      suppressNextClickRef.current = false;
      if (clearSuppressTimer) {
        clearTimeout(clearSuppressTimer);
        clearSuppressTimer = 0;
      }
    };

    const onPointerDown = (event) => {
      clearClickSuppression();
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
      const excludedTarget = body.contains(event.target) && isExcludedElement(event.target, body);
      if (!down && (!body.contains(event.target) || excludedTarget)) return;

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
          let singleNodeRange = null;
          if (range.startContainer === range.endContainer && range.startContainer.nodeType === Node.TEXT_NODE) {
            let start = range.startOffset;
            let end = range.endOffset;
            const text = range.startContainer.data || "";
            while (start < end && /\s/.test(text[start])) start += 1;
            while (end > start && /\s/.test(text[end - 1])) end -= 1;
            if (end > start) singleNodeRange = { node: range.startContainer, start, end };
          }
          armClickSuppression();
          handlersRef.current.applySelectedText(raw, singleNodeRange);
          return;
        }
      }

      if (excludedTarget || moved > 6) return;
      const pointHit = charOffsetAtPoint(doc, event.clientX, event.clientY, body);
      if (!pointHit) return;
      armClickSuppression();
      handlersRef.current.applyPointHit(pointHit);
    };

    const onClickCapture = (event) => {
      if (!markingRef.current || isExcludedElement(event.target, body)) return;
      if (event.target?.closest?.(".options button.option")) {
        event.preventDefault();
        event.stopPropagation();
      }
      if (suppressNextClickRef.current) {
        clearClickSuppression();
        return;
      }
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
      clearClickSuppression();
    };
  }, [reviewBodyRef]);

  return {
    marking,
    terms,
    candidates: candidateTerms,
    toggleMarking,
    exitMarking,
    markCandidate,
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
