import React from "react";

const useIsoLayoutEffect = typeof window === "undefined" ? React.useEffect : React.useLayoutEffect;

/** A flashcard's head (counts, 本组 mastery, topic and the head rule) floats over both faces, so the faces must start below it. Its height
 *  depends on the pane width, the language, the topic's length and what the header holds right now (「待看订正」, a note badge), so a fixed
 *  padding either leaves a hole or puts the prompt on the rule. This keeps `--flash-head` on the card at the head's real height (question.css
 *  pads the faces from it); `active` is false for every card that is not a flashcard. Returns the ref for the head. */
export function useFlashHead(active) {
  const head = React.useRef(null);
  useIsoLayoutEffect(() => {
    const element = head.current, card = element?.parentElement;
    if (!active || !card) return undefined;
    const measure = () => card.style.setProperty("--flash-head", `${Math.ceil(element.offsetHeight)}px`);
    measure();
    if (typeof ResizeObserver === "undefined") return () => card.style.removeProperty("--flash-head");
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => { observer.disconnect(); card.style.removeProperty("--flash-head"); };
  }, [active]);
  return head;
}
