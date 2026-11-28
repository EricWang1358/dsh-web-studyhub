import React from "react";
import { ui, uiFormat } from "../i18n.js";
import { plainAssistFailure } from "../generation-status.js";
import { nextDueGap, nextDueWhen, nextDueWord } from "../NextDue.jsx";
import { focusQuietly } from "../components/index.js";
import { keysElsewhere } from "./session-logic.js";
import { drawnScale } from "../drawn-scale.js";

const QUESTION_HEADING_SELECTOR = '[data-question-heading], .question[role="heading"], .question, .flash-prompt, .cloze-text, .question-card';

export function isFocusInDialog() {
  if (typeof document === "undefined") return false;
  const active = document.activeElement;
  return Boolean(active && active !== document.body && active.closest?.('dialog[open], [role="dialog"]'));
}

/** Programmatically focus the current question's prompt heading without scrolling or opening tooltips. */
export function focusQuestionHeading(root) {
  if (!root || isFocusInDialog()) return null;
  const target = root.querySelector?.(QUESTION_HEADING_SELECTOR) || null;
  if (!target || typeof target.focus !== "function") return null;
  if (typeof document !== "undefined" && document.activeElement === target) return target;
  if (target.getAttribute?.("tabindex") == null) target.tabIndex = -1;
  focusQuietly(target, { preventScroll: true });
  return target;
}

/** Build a concise polite screen-reader announcement when answer feedback or async grading updates. */
export function buildFeedbackAnnouncement({ run, choice = false, isCloze = false, gradeTask = null } = {}) {
  if (gradeTask?.status === "failed" && !run?.feedback) {
    const detail = plainAssistFailure(gradeTask.message) || gradeTask.message;
    return detail ? uiFormat("批改失败：{0}", [detail]) : ui("批改未完成，可重新提交批改");
  }
  const fb = run?.feedback;
  if (!fb) return "";
  const parts = [];
  if (fb.rubric) {
    const fmt = (value) => (Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10));
    parts.push(uiFormat("批改完成，得分 {0}/{1} 分", [fmt(fb.rubric.total), fmt(fb.rubric.max)]));
    if (fb.nextDue) parts.push(nextDueWhen(fb));
  } else if (choice && run.solution?.options) {
    const picked = new Set(fb.selected || []);
    const correct = new Set(run.solution.options.filter((o) => o.correct).map((o) => o.id));
    const isPassed = typeof fb.correct === "boolean"
      ? fb.correct
      : correct.size > 0 && picked.size === correct.size && [...correct].every((id) => picked.has(id));
    parts.push(ui(isPassed ? "答对了" : "答错了"));
    if (fb.nextDue) parts.push(nextDueWhen(fb));
  } else if (isCloze && Array.isArray(fb.details) && fb.details.length > 0) {
    const graded = fb.details.filter((d) => d && typeof d.correct === "boolean");
    const right = graded.filter((d) => d.correct).length;
    parts.push(graded.length > 1 ? uiFormat("答对 {0}/{1} 空", [right, graded.length]) : ui(fb.correct ? "答对了" : "答错了"));
    if (fb.nextDue) parts.push(nextDueWhen(fb));
  } else if (Number.isInteger(fb.grade) && !fb.selfReported) {
    const gap = nextDueGap(fb);
    parts.push(gap ? uiFormat("已记 {0} 分 · {1}后再见", [fb.grade, gap]) : uiFormat("已记 {0} 分 · 今天内再见", [fb.grade]));
  } else {
    parts.push(nextDueWord(fb));
    if (fb.nextDue) parts.push(nextDueWhen(fb));
  }
  if (fb.retryQueued) parts.push(ui("这道题放到了本轮最后，会再出现一次"));
  return parts.filter(Boolean).join(" · ");
}

/** Manage QuestionRun's pre-mounted aria-live feedback announcer and post-answer / question-switch focus placement. */
export function useQuestionRunA11y({ entryKey, run, hasFeedback, choice, isCloze, gradeTask, autoAdvanceActive, reviewBodyRef, choiceFeedbackRef, verdictFocusRef }) {
  const [liveAnnouncement, setLiveAnnouncement] = React.useState("");
  const feedbackSig = [
    entryKey,
    hasFeedback ? 1 : 0,
    run.feedback?.correct,
    run.feedback?.grade,
    run.feedback?.nextDue,
    run.feedback?.retryQueued ? 1 : 0,
    run.feedback?.rubric?.total,
    gradeTask?.id || "",
    gradeTask?.status || "",
  ].join("|");
  const nextLiveAnnouncement = buildFeedbackAnnouncement({ run, choice, isCloze, gradeTask });
  const prevAnnounceRef = React.useRef({ key: entryKey, sig: feedbackSig });
  React.useEffect(() => {
    if (prevAnnounceRef.current.sig === feedbackSig) return;
    const sameCard = prevAnnounceRef.current.key === entryKey;
    prevAnnounceRef.current = { key: entryKey, sig: feedbackSig };
    if (!sameCard) {
      setLiveAnnouncement("");
      return;
    }
    setLiveAnnouncement(nextLiveAnnouncement);
  }, [entryKey, feedbackSig, nextLiveAnnouncement]);
  const prevFocusStateRef = React.useRef({ key: entryKey, hasFeedback });
  React.useEffect(() => {
    const prev = prevFocusStateRef.current;
    if (prev.key !== entryKey) {
      prevFocusStateRef.current = { key: entryKey, hasFeedback };
      focusQuestionHeading(reviewBodyRef.current);
      return;
    }
    if (!prev.hasFeedback && hasFeedback) {
      prevFocusStateRef.current = { key: entryKey, hasFeedback: true };
      if (autoAdvanceActive || isFocusInDialog()) return;
      const active = typeof document !== "undefined" ? document.activeElement : null;
      if (keysElsewhere(active, reviewBodyRef.current)) return;
      const cardEl = reviewBodyRef.current?.querySelector?.(".question-card");
      const inOtherInput = active && active !== document.body
        && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName)
        && !active.disabled
        && (!cardEl || !cardEl.contains(active));
      if (inOtherInput) return;
      const target = (choice && choiceFeedbackRef.current)
        || verdictFocusRef.current
        || reviewBodyRef.current?.querySelector?.('[data-usage="review.next"]:not(:disabled)');
      if (target) focusQuietly(target, { preventScroll: true });
      return;
    }
    if (prev.hasFeedback && !hasFeedback) {
      prevFocusStateRef.current = { key: entryKey, hasFeedback: false };
    }
  }, [entryKey, hasFeedback, autoAdvanceActive, choice, reviewBodyRef, choiceFeedbackRef, verdictFocusRef]);
  return liveAnnouncement;
}

const useIsoLayoutEffect = typeof window === "undefined" ? React.useEffect : React.useLayoutEffect;

function findScroller(element, given) {
  let scroller = typeof given === "function" ? given() : given || element?.parentElement;
  if (!given) {
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) {
      scroller = scroller.parentElement;
    }
  }
  return scroller || null;
}

/** When a flashcard flips to its answer and the 0–5 grading scale extends below the scroll viewport
 *  (e.g. long answers, short laptop screens, or larger UI scale), nudge the scroll container down by
 *  the minimal amount needed to keep the full rating row in view. Stops immediately on user scroll. */
export function useRevealGradingInView({ reviewBodyRef, showBack, hasFeedback, entryKey }) {
  useIsoLayoutEffect(() => {
    if (!showBack || hasFeedback) return undefined;
    const body = reviewBodyRef.current;
    const scroller = findScroller(body);
    if (!body || !scroller || typeof scroller.scrollTo !== "function") return undefined;
    let cancelled = false;
    const stop = () => { cancelled = true; };
    const pad = 16;
    const bringInView = () => {
      if (cancelled) return;
      const grading = body.querySelector(".grading");
      if (!grading) return;
      const scrollerBox = scroller.getBoundingClientRect();
      const scale = drawnScale(scroller, scrollerBox);
      const gradingBox = grading.getBoundingClientRect();
      if (gradingBox.height <= 0) return;
      const overflow = (gradingBox.bottom - scrollerBox.bottom) / scale + pad;
      if (overflow <= 1) return;
      const bar = body.closest("main")?.querySelector(":scope > .topbar")?.offsetHeight || 0;
      const maxDelta = Math.max(0, (gradingBox.top - scrollerBox.top) / scale - bar - pad);
      const delta = Math.min(overflow, maxDelta);
      if (delta > 1) {
        scroller.scrollTo({ top: Math.max(0, scroller.scrollTop + delta), behavior: "instant" });
      }
    };
    bringInView();
    const card = body.querySelector(".question-card");
    const observer = typeof ResizeObserver !== "undefined" && card ? new ResizeObserver(bringInView) : null;
    if (observer && card) observer.observe(card);
    scroller.addEventListener?.("wheel", stop, { passive: true });
    scroller.addEventListener?.("touchstart", stop, { passive: true });
    return () => {
      cancelled = true;
      observer?.disconnect();
      scroller.removeEventListener?.("wheel", stop);
      scroller.removeEventListener?.("touchstart", stop);
    };
  }, [entryKey, showBack, hasFeedback, reviewBodyRef]);
}

/* Switching questions pins the question header ("21 / 54 · topic") just under the sticky top bar, so every question opens at the same
   spot instead of wherever the previous one's length left the scroll offset. The first question keeps the natural layout; the summary
   only scrolls back if its top is out of view. Runs before paint, so there is no visible jump.
   On subsequent question transitions, also moves focus quietly to the new question prompt heading (`preventScroll: true`) so keyboard
   and screen-reader users land right on the new question without losing focus to `document.body`.
   pageRef: the element that holds the question (the practice page's <section>). It is also where the top bar is looked up (the
   `main` around it) and where the nearest scrolling ancestor is found, unless `scroller` names one: an element or a function returning it.
   The practice page calls this; a page that embeds <QuestionRun> only calls it when it wants the same pinning. */
export default function usePinQuestion(pageRef, run, { scroller: given } = {}) {
  const openedRef = React.useRef(false);
  React.useLayoutEffect(() => {
    const page = pageRef.current;
    const scroller = findScroller(page, given);
    if (!page || !scroller) return;
    const bar = page.closest("main")?.querySelector(":scope > .topbar")?.offsetHeight || 0;
    // Block body on purpose: newer Chromium's scrollTo returns a Promise, and an
    // effect must never return one (React calls it as the cleanup and throws).
    const scrollBy = (delta) => {
      scroller.scrollTo({ top: Math.max(0, scroller.scrollTop + delta), behavior: "instant" });
    };
    const meta = !run.complete && page.querySelector(".question-meta");
    const first = !openedRef.current;
    openedRef.current = true;
    if (meta) {
      const gap = 16;
      // The pin is the question card's top edge, so its header rule is never
      // tucked under the bar. Leave a viewport of room below it so even a
      // short last card can scroll up to the pinned position; the room goes
      // on the body, not the card, so the card itself hugs its content.
      const card = meta.closest(".question-card") || meta.closest(".question-area"),
        area = card.closest(".review-body") || card;
      // Batch all DOM layout reads before mutating style/scroll to prevent forced synchronous reflow (layout thrashing).
      const cardTop = card.getBoundingClientRect().top;
      const areaTop = area.getBoundingClientRect().top;
      const scrollerBox = scroller.getBoundingClientRect(), scale = drawnScale(scroller, scrollerBox);
      const scrollerTop = scrollerBox.top;
      const scrollerHeight = scroller.clientHeight;
      const lead = (cardTop - areaTop) / scale;
      const minHeight = `${Math.max(0, scrollerHeight - bar - gap + lead)}px`;
      if (area.style.minHeight !== minHeight) area.style.minHeight = minHeight;
      if (!first) {
        scrollBy((cardTop - scrollerTop) / scale - bar - gap);
        focusQuestionHeading(card);
        return;
      }
    }
    const box = scroller.getBoundingClientRect();
    const offset = (page.getBoundingClientRect().top - box.top) / drawnScale(scroller, box) - bar;
    if (offset < 0) scrollBy(offset);
    if (!first && run.complete && !isFocusInDialog()) {
      const heading = page.querySelector("h1, h2");
      if (heading && typeof heading.focus === "function") {
        if (heading.getAttribute?.("tabindex") == null) heading.tabIndex = -1;
        focusQuietly(heading, { preventScroll: true });
      }
    }
  }, [run.id, run.index, run.card?.id, run.complete]); // eslint-disable-line react-hooks/exhaustive-deps
}
