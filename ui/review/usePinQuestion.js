import React from "react";

/* Switching questions pins the question header ("21 / 54 · topic") just under the sticky top bar, so every question opens at the same
   spot instead of wherever the previous one's length left the scroll offset. The first question keeps the natural layout; the summary
   only scrolls back if its top is out of view. Runs before paint, so there is no visible jump.
   pageRef: the element that holds the question (the practice page's <section>). It is also where the top bar is looked up (the
   `main` around it) and where the nearest scrolling ancestor is found, unless `scroller` names one: an element or a function returning it.
   The practice page calls this; a page that embeds <QuestionRun> only calls it when it wants the same pinning. */
export default function usePinQuestion(pageRef, run, { scroller: given } = {}) {
  const openedRef = React.useRef(false);
  React.useLayoutEffect(() => {
    const page = pageRef.current;
    let scroller = typeof given === "function" ? given() : given || page?.parentElement;
    if (!given) while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY))
      scroller = scroller.parentElement;
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
      const lead = card.getBoundingClientRect().top - area.getBoundingClientRect().top;
      const minHeight = `${Math.max(0, scroller.clientHeight - bar - gap + lead)}px`;
      if (area.style.minHeight !== minHeight) area.style.minHeight = minHeight;
      if (!first) {
        scrollBy(card.getBoundingClientRect().top - scroller.getBoundingClientRect().top - bar - gap);
        return;
      }
    }
    const offset = page.getBoundingClientRect().top - scroller.getBoundingClientRect().top - bar;
    if (offset < 0) scrollBy(offset);
  }, [run.id, run.index, run.complete]); // eslint-disable-line react-hooks/exhaustive-deps
}
